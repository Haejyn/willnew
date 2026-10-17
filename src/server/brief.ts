/**
 * Bridge planner: classify → clarify → spec, and the requester-facing explanation when a developer declines.
 * Runs on the small model (Haiku) through headless Claude Code with no tools. Every reply is strict JSON, validated
 * here; a reply that fails validation is retried once with the error, and on the second failure a minimal result is
 * used and marked as such (by: "fallback", with a note saying so).
 */
import { readdirSync } from "node:fs";
import { ADAPTERS, installed } from "./adapters.js";
import { briefPrompt, declinePrompt, retryPrompt, specPrompt } from "./prompts.js";
import { runClaude } from "./triage.js";
import type { Bodies, ClarifyQuestion, DeclineNote, Proposal, Request, RequestAttachment, RequestType, WorkSpec } from "./types.js";

/** One model call: prompt in, raw reply text out. Tests pass a fake. */
export type LlmCall = (prompt: string) => Promise<{ text: string; costUsd: number | null }>;

export interface Planned<T> {
  value: T;
  by: "llm" | "fallback";
  /** why the fallback was used */
  note?: string;
  costUsd: number | null;
  attempts: number;
}

export interface Brief {
  type: RequestType;
  title: string;
  understood: Bodies;
  questions: ClarifyQuestion[];
}

// ---------------------------------------------------------------------------------------------- validation

class Invalid extends Error {}
const fail = (msg: string): never => {
  throw new Invalid(msg);
};
const obj = (v: unknown, where: string): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${where} must be an object`);
const str = (v: unknown, where: string, max = 600): string => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fail(`${where} must be a non-empty string`));
const strList = (v: unknown, where: string, opts: { min?: number; max?: number } = {}): string[] => {
  if (v === undefined && !opts.min) return [];
  if (!Array.isArray(v)) return fail(`${where} must be an array of strings`);
  const out = v.map((x, i) => str(x, `${where}[${i}]`, 300));
  if (opts.min && out.length < opts.min) fail(`${where} needs at least ${opts.min} item(s)`);
  if (opts.max && out.length > opts.max) fail(`${where} allows at most ${opts.max} item(s)`);
  return out;
};
const bodies = (v: unknown, where: string): Bodies => {
  const o = obj(v, where);
  return { forRequester: str(o.forRequester, `${where}.forRequester`), forDeveloper: str(o.forDeveloper, `${where}.forDeveloper`) };
};

/** The JSON object inside a reply (the model sometimes wraps it in a fence or a sentence). */
export function extractJson(text: string): unknown {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) fail("no JSON object in the reply");
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch (e) {
    return fail(`invalid JSON: ${(e as Error).message}`);
  }
}

const TYPES: RequestType[] = ["bug", "ui", "copy", "data", "other"];
const OTHER = /^(기타|other)$/i;

export function checkBrief(v: unknown): Brief {
  const o = obj(v, "reply");
  const type = TYPES.includes(o.type as RequestType) ? (o.type as RequestType) : fail(`type must be one of ${TYPES.join(", ")}`);
  const qs = o.questions === undefined ? [] : Array.isArray(o.questions) ? o.questions : fail("questions must be an array");
  if (qs.length > 3) fail("at most 3 questions");
  const questions = qs.map((q, i): ClarifyQuestion => {
    const qo = obj(q, `questions[${i}]`);
    const choices = strList(qo.choices, `questions[${i}].choices`).filter((c) => !OTHER.test(c));
    if (choices.length < 2 || choices.length > 4) fail(`questions[${i}].choices needs 2 to 4 choices (without 기타)`);
    return { id: `q${i + 1}`, question: str(qo.question, `questions[${i}].question`, 200), choices, why: typeof qo.why === "string" ? qo.why.slice(0, 200) : undefined };
  });
  return { type, title: str(o.title, "title", 60), understood: bodies(o.understood, "understood"), questions };
}

export function checkSpec(v: unknown): Omit<WorkSpec, "constraints"> {
  const o = obj(v, "reply");
  return {
    title: str(o.title, "title", 60),
    problem: str(o.problem, "problem"),
    expected: str(o.expected, "expected"),
    acceptanceCriteria: strList(o.acceptanceCriteria, "acceptanceCriteria", { min: 1, max: 12 }),
    outOfScope: strList(o.outOfScope, "outOfScope", { max: 10 }),
    references: strList(o.references, "references", { max: 10 }),
    summary: bodies(o.summary, "summary"),
  };
}

export function checkProposal(v: unknown): Omit<Proposal, "by"> {
  const o = obj(v, "reply");
  const files = (Array.isArray(o.files) ? o.files : fail("files must be an array")).map((f, i) => {
    const fo = obj(f, `files[${i}]`);
    return { path: str(fo.path, `files[${i}].path`, 200), why: str(fo.why, `files[${i}].why`, 200) };
  });
  const est = obj(o.estimate, "estimate");
  const minutes = typeof est.minutes === "number" && est.minutes >= 0 ? est.minutes : fail("estimate.minutes must be a number >= 0");
  const costUsd = est.costUsd === null ? null : typeof est.costUsd === "number" && est.costUsd >= 0 ? est.costUsd : fail("estimate.costUsd must be a number or null");
  const confidence = o.confidence === "low" || o.confidence === "medium" || o.confidence === "high" ? o.confidence : fail('confidence must be "low", "medium" or "high"');
  return {
    summary: str(o.summary, "summary", 200),
    approach: strList(o.approach, "approach", { min: 1, max: 10 }),
    files,
    risks: strList(o.risks, "risks", { max: 10 }),
    testsToAdd: strList(o.testsToAdd, "testsToAdd", { max: 12 }),
    estimate: { minutes, costUsd },
    confidence,
  };
}

export function checkDecline(v: unknown): Omit<DeclineNote, "reason"> {
  const o = obj(v, "reply");
  const alts = o.alternatives === undefined ? [] : Array.isArray(o.alternatives) ? o.alternatives : fail("alternatives must be an array");
  if (alts.length > 2) fail("at most 2 alternatives");
  return {
    forRequester: str(o.forRequester, "forRequester", 800),
    alternatives: alts.map((a, i) => {
      const ao = obj(a, `alternatives[${i}]`);
      return { title: str(ao.title, `alternatives[${i}].title`, 200), effort: str(ao.effort, `alternatives[${i}].effort`, 60) };
    }),
  };
}

/**
 * Ask, validate, retry once with the validation error. Returns null after the second failure (caller falls back).
 * `error` is the last reason, for the fallback note.
 */
export async function askJson<T>(llm: LlmCall, prompt: string, check: (v: unknown) => T): Promise<{ value: T | null; error?: string; costUsd: number | null; attempts: number }> {
  let cost: number | null = null;
  let error = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await llm(attempt === 1 ? prompt : retryPrompt(prompt, error));
      if (r.costUsd != null) cost = (cost ?? 0) + r.costUsd;
      return { value: check(extractJson(r.text)), costUsd: cost, attempts: attempt };
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return { value: null, error, costUsd: cost, attempts: 2 };
}

// ---------------------------------------------------------------------------------------------- fallbacks

const clean = (text: string) => text.replace(/@willnew\b/gi, "").trim();
const firstLine = (text: string) => clean(text).split(/[\n.?!]/)[0].slice(0, 40) || "요청";

export function guessType(text: string): RequestType {
  const t = text.toLowerCase();
  if (/버그|에러|오류|깨져|깨짐|안 ?돼|안 ?됨|500|실패|이상해|잘못|bug|error|fail/.test(t)) return "bug";
  if (/문구|카피|텍스트|오타|copy/.test(t)) return "copy";
  if (/데이터|정산|집계|수치|지표|csv|data/.test(t)) return "data";
  if (/버튼|여백|간격|색|글꼴|폰트|화면|레이아웃|디자인|시안|피그마|figma|ui|px/.test(t)) return "ui";
  return "other";
}

export function fallbackBrief(text: string): Brief {
  return {
    type: guessType(text),
    title: firstLine(text),
    understood: { forRequester: `이렇게 이해했어요: ${clean(text).slice(0, 200)}`, forDeveloper: "AI 정리를 못 해서 원문 그대로예요" },
    questions: [],
  };
}

export function fallbackSpec(text: string, attachments: RequestAttachment[], questions: ClarifyQuestion[]): WorkSpec {
  const answered = questions.filter((q) => q.answer).map((q) => `${q.question}: ${q.answer}`);
  return {
    title: firstLine(text),
    problem: clean(text),
    expected: "요청 원문에 적힌 대로 동작한다",
    acceptanceCriteria: [...answered, "[확인 필요: AI가 수용 기준을 정하지 못했어요. 개발자가 정해 주세요]"],
    outOfScope: [],
    references: attachments.map((a) => a.url),
    constraints: [],
    summary: { forRequester: "자동 정리가 안 돼서 남겨 주신 글 그대로 개발자에게 넘겼어요", forDeveloper: "AI 명세 실패 → 최소 명세. 수용 기준을 직접 정해 주세요" },
  };
}

export function fallbackProposal(spec: WorkSpec | undefined, note: string): Proposal {
  return {
    summary: "AI 제안을 만들지 못했어요. 명세대로 진행할까요?",
    approach: ["수용 기준을 테스트로 먼저 쓴다", "관련 코드를 찾아 고친다", "검증 명령으로 확인한다"],
    files: [],
    risks: ["저장소를 읽지 못해서 바꿀 파일과 영향 범위를 몰라요"],
    testsToAdd: spec?.acceptanceCriteria ?? [],
    estimate: { minutes: 0, costUsd: null },
    confidence: "low",
    by: "fallback",
    note,
  };
}

export function fallbackDecline(reason: string): Omit<DeclineNote, "reason"> {
  return { forRequester: `이번엔 진행하지 않기로 했어요. 개발자가 남긴 이유: ${reason}`, alternatives: [] };
}

// ---------------------------------------------------------------------------------------------- planner

export interface Planner {
  brief(text: string, attachments: RequestAttachment[], repo: string): Promise<Planned<Brief>>;
  spec(text: string, attachments: RequestAttachment[], questions: ClarifyQuestion[], repo: string): Promise<Planned<WorkSpec>>;
  decline(req: Pick<Request, "text" | "spec" | "requester" | "repo">, reason: string, developer: string): Promise<Planned<DeclineNote>>;
}

function repoListing(repo: string): string {
  try {
    return readdirSync(repo).filter((f) => !f.startsWith(".") && f !== "node_modules").slice(0, 40).join(", ");
  } catch {
    return "";
  }
}

/** Haiku through headless Claude Code; null when it can't run here (then every step uses the fallback and says so). */
export function defaultLlm(repo: string): LlmCall | null {
  if (process.env.WILLNEW_TRIAGE === "rules" || !installed(ADAPTERS["claude-code"])) return null;
  return async (prompt) => {
    const env = JSON.parse(await runClaude(prompt, repo, { model: process.env.WILLNEW_PLANNER_MODEL ?? process.env.WILLNEW_TRIAGE_MODEL ?? "haiku" })) as { result?: string; total_cost_usd?: number };
    return { text: env.result ?? "", costUsd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : null };
  };
}

const NO_LLM = "AI 정리를 쓸 수 없는 환경이에요 (Claude Code 없음 또는 규칙 모드)";
const failed = (step: string, error?: string) => `AI ${step}이 두 번 다 형식에 맞지 않아 최소 내용으로 대신했어요${error ? ` (${error.slice(0, 120)})` : ""}`;

/** `llm` = how to reach the model for a repo; pass a fake in tests, or `() => null` to force the fallback. */
export function createPlanner(llm: (repo: string) => LlmCall | null = defaultLlm): Planner {
  return {
    async brief(text, attachments, repo) {
      const call = llm(repo);
      if (!call) return { value: fallbackBrief(text), by: "fallback", note: NO_LLM, costUsd: null, attempts: 0 };
      const r = await askJson(call, briefPrompt(text, attachments, repoListing(repo)), checkBrief);
      return r.value
        ? { value: r.value, by: "llm", costUsd: r.costUsd, attempts: r.attempts }
        : { value: fallbackBrief(text), by: "fallback", note: failed("정리", r.error), costUsd: r.costUsd, attempts: r.attempts };
    },
    async spec(text, attachments, questions, repo) {
      const call = llm(repo);
      if (!call) return { value: fallbackSpec(text, attachments, questions), by: "fallback", note: NO_LLM, costUsd: null, attempts: 0 };
      const r = await askJson(call, specPrompt(text, attachments, questions, repoListing(repo)), checkSpec);
      return r.value
        ? { value: { ...r.value, constraints: [] }, by: "llm", costUsd: r.costUsd, attempts: r.attempts }
        : { value: fallbackSpec(text, attachments, questions), by: "fallback", note: failed("명세", r.error), costUsd: r.costUsd, attempts: r.attempts };
    },
    async decline(req, reason, developer) {
      const call = llm(req.repo);
      if (!call) return { value: { reason, ...fallbackDecline(reason) }, by: "fallback", note: NO_LLM, costUsd: null, attempts: 0 };
      const r = await askJson(call, declinePrompt(req, reason, developer), checkDecline);
      return r.value
        ? { value: { reason, ...r.value }, by: "llm", costUsd: r.costUsd, attempts: r.attempts }
        : { value: { reason, ...fallbackDecline(reason) }, by: "fallback", note: failed("설명", r.error), costUsd: r.costUsd, attempts: r.attempts };
    },
  };
}
