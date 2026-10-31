/**
 * 골든 세트를 TicketFlow 로 돌려 점수를 낸다 (ticket-plan.md F12, m1-contract.md 7절).
 *
 *   none    AI 없음. 필수 칸 양식만 (비교군)
 *   fake    골든의 정해진 응답을 주는 가짜 Ai. 흐름이 모델 출력을 어떻게 쓰는지 보는 것이지 모델 성능이 아니다
 *   ollama  실제 로컬 Ollama
 *
 * CS 는 가짜다. 질문받은 칸을 골든의 정답 칸에서 골라 답한다: answer 가 있으면 답, customer 가 있으면 "고객에게 물을 것"
 * 뒤에 고객 답을 붙이고, 둘 다 없으면 "모름". 대리 검토 질문은 reviewAnswer 로 첫 질문만 답하고 나머지는 모름.
 * 실제 HTTP 라우트(app.request)로 돌린다. 저장은 부른 쪽이 정한 WILLNEW_HOME 에 한다.
 */
import { EventEmitter } from "node:events";
import type { Ai, LlmRecord, LlmTask, Msg } from "../server/ai/index.js";
import { residualPii } from "../server/safety/index.js";
import { DEFAULT_CHOICES, FIELD_KO, fieldText, isRequired, type RequiredField } from "../server/tickets/fields.js";
import type { WorkSpec } from "../server/types.js";
import { caseText, type GoldenCase } from "./golden.js";

export type AiMode = "none" | "fake" | "ollama";

export interface CaseResult {
  id: string;
  source: GoldenCase["source"];
  status: string;
  /** 정답 칸 수, 채운 수, 핵심 낱말이 들어 있는 수 */
  expected: number;
  filled: number;
  keywordHit: number;
  /** CS 에게 물은 칸 질문 수 (대리 검토 질문 빼고) */
  questions: number;
  reviewQuestions: number;
  /** 보내기 전에 CS 가 확인해야 하는 추정 칸 */
  unconfirmed: number;
  residualPii: number;
  injectionExpected: boolean;
  injectionFlagged: boolean;
  categoryExpected: string;
  category: string;
  /** 스키마 출력 호출 수와 통과 수 (AI 를 실제로 부른 것만) */
  schemaCalls: number;
  schemaPassed: number;
  missed: string[];
}

export interface EvalRun {
  mode: AiMode;
  model?: string;
  promptVersion: string;
  cases: CaseResult[];
  /** 127.0.0.1, localhost 말고 다른 곳으로 나간 fetch */
  outside: string[];
}

// ---------------------------------------------------------------------------------------------- 가짜 Ai

/** 말 목록 글(transcript)에서 글귀가 들어 있는 말 번호 */
function sourcesOf(transcript: string, quotes: string[]): number[] {
  const out = new Set<number>();
  let cur = -1;
  const lines = transcript.split("\n").map((l) => {
    const m = /^\^ #(\d+) /.exec(l);
    if (m) cur = Number(m[1]);
    return { i: cur, text: l };
  });
  for (const q of quotes) {
    const hit = lines.find((l) => l.i >= 0 && l.text.includes(q));
    if (hit) out.add(hit.i);
  }
  return [...out];
}

const none = (task: LlmTask, pv?: string): LlmRecord => ({ task, provider: "none", model: "", digest: "", tokens: 0, costUsd: 0, ms: 0, promptVersion: pv ?? "" });
const quietQueue = () => Object.assign(new EventEmitter(), { size: () => 0 });

/** AI 없음 (양식 모드). Ollama 가 없을 때 createAi 가 하는 것과 같다 */
export function noAi(): Ai {
  return {
    queue: quietQueue(),
    enabled: async () => false,
    status: async () => ({ state: "not_installed", models: [], enabled: false, queue: 0, routing: {} as never }),
    structured: async (task, _s, _m, o) => ({ value: null, record: none(task, o?.promptVersion) }),
    text: async (task, _m, o) => ({ text: null, record: none(task, o?.promptVersion) }),
  };
}

/** 지금 돌리는 골든 한 건의 정해진 응답을 준다. current() 가 그 건 */
export function scriptedAi(current: () => GoldenCase): Ai {
  const rec = (task: LlmTask, pv?: string): LlmRecord => ({ task, provider: "fake", model: "golden-fake", digest: "sha256:golden", tokens: 0, costUsd: 0, ms: 0, promptVersion: pv ?? "" });
  const reply = (task: LlmTask, messages: Msg[]): unknown => {
    const c = current();
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    if (task === "extract") {
      const out: Record<string, unknown> = {};
      for (const [f, slot] of Object.entries(c.fake.extract)) out[f] = slot ? { value: slot.value, sources: sourcesOf(user, slot.from), confidence: slot.confidence } : null;
      return out;
    }
    if (task === "ask") {
      const f = /물을 칸: .+? \((\w+)\)/.exec(user)?.[1];
      const field: RequiredField = f && isRequired(f) ? f : "problem";
      return { question: `${FIELD_KO[field]}: 맞는 걸 골라 주세요`, choices: DEFAULT_CHOICES[field].slice(0, 4) };
    }
    if (task === "draft") return c.fake.draft;
    if (task === "review") return c.fake.review;
    return undefined;
  };
  return {
    queue: quietQueue(),
    enabled: async () => true,
    status: async () => ({ state: "ready", models: [{ name: "golden-fake", digest: "sha256:golden" }], enabled: true, queue: 0, routing: {} as never }),
    async structured(task, schema, messages, o) {
      const raw = reply(task, messages);
      const p = raw === undefined ? null : schema.safeParse(raw);
      return { value: p?.success ? p.data : null, record: rec(task, o?.promptVersion) };
    },
    // relay 는 평가 범위 밖 (접수에서 spec_ready 까지만 돈다)
    text: async (task, _m, o) => ({ text: null, record: rec(task, o?.promptVersion) }),
  };
}

/** 스키마 출력 호출을 센다 (실제로 부른 것만. provider none 은 빼고) */
function counting(ai: Ai) {
  const n = { calls: 0, passed: 0 };
  const wrapped: Ai = {
    queue: ai.queue,
    enabled: () => ai.enabled(),
    status: () => ai.status(),
    text: (t, m, o) => ai.text(t, m, o),
    async structured(task, schema, messages, o) {
      const r = await ai.structured(task, schema, messages, o);
      if (r.record.provider !== "none") {
        n.calls++;
        if (r.value !== null) n.passed++;
      }
      return r;
    },
  };
  return { ai: wrapped, n };
}

// ---------------------------------------------------------------------------------------------- 채점

function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) strings(v, out);
  return out;
}

function score(c: GoldenCase, t: any, schema: { calls: number; passed: number }): CaseResult {
  const spec: WorkSpec = t.spec;
  let filled = 0;
  let keywordHit = 0;
  const missed: string[] = [];
  const expected = Object.keys(c.fields).filter(isRequired);
  for (const f of expected) {
    const meta = spec.fields?.[f];
    const value = fieldText(spec, f).trim();
    const ok = !!meta && meta.confidence !== "unknown" && !!value;
    if (ok) filled++;
    const kw = c.fields[f]!.keywords;
    if (ok && kw.some((k) => value.toLowerCase().includes(k.toLowerCase()))) keywordHit++;
    else missed.push(FIELD_KO[f]);
  }
  // 저장되는 사람 글 전부: 원문, 말 목록, 칸, 질문과 답, 고객에게 물을 것
  const text = strings([t.text, t.title, t.utterances, spec, t.questions, t.reviewQuestions]);
  const residual = text.reduce((s, x) => s + residualPii(x).length, 0);
  return {
    id: c.id, source: c.source, status: t.status, expected: expected.length, filled, keywordHit,
    questions: (t.questions ?? []).filter((q: { id: string }) => q.id.startsWith("f-")).length,
    reviewQuestions: (t.reviewQuestions ?? []).length, unconfirmed: (t.unconfirmed ?? []).length, residualPii: residual,
    injectionExpected: c.injection, injectionFlagged: (t.injectionFlags ?? []).length > 0,
    categoryExpected: c.category, category: String(t.category ?? ""), schemaCalls: schema.calls, schemaPassed: schema.passed, missed,
  };
}

// ---------------------------------------------------------------------------------------------- 실행

export interface RunOptions {
  mode: AiMode;
  cases: GoldenCase[];
  /** 저장소 위치 (textFile 기준) */
  root: string;
  /** ollama 모드의 Ai (부른 쪽이 만든다) */
  ai?: Ai;
  model?: string;
}

export async function runEval(o: RunOptions): Promise<EvalRun> {
  const { createApp } = await import("../server/app.js");
  const { promptVersion } = await import("../server/tickets/prompts.js");
  let current = o.cases[0];
  const base = o.mode === "none" ? noAi() : o.mode === "fake" ? scriptedAi(() => current) : o.ai;
  if (!base) throw new Error("ollama 모드에는 Ai 가 필요해요");
  const { ai, n } = counting(base);
  const { app } = createApp({ repo: o.root, check: "", ai });

  const outside: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") outside.push(url.href);
    return realFetch(input, init);
  }) as typeof fetch;

  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json();
    if (r.status >= 400) throw new Error(`${method} ${path} ${r.status}: ${j.error}`);
    return j;
  };
  const user = "eval-cs";
  const results: CaseResult[] = [];
  try {
    for (const c of o.cases) {
      current = c;
      n.calls = 0;
      n.passed = 0;
      let t = await call("POST", "/api/intake", { text: caseText(c, o.root), user });
      const key = t.key;
      for (let i = 0; i < 40 && ["clarifying", "waiting_customer"].includes(t.status); i++) {
        if (t.next) {
          const q = t.next;
          if (q.id.startsWith("r-")) {
            const a = q.id === "r-1" ? c.reviewAnswer : undefined;
            t = await call("POST", `/api/tickets/${key}/messages`, a ? { questionId: q.id, kind: "answer", text: a, user } : { questionId: q.id, kind: "unknown", user });
            continue;
          }
          const f = /^f-([A-Za-z]+)-/.exec(q.id)?.[1] as RequiredField;
          const g = c.fields[f];
          const body = g?.answer ? { kind: "answer", text: g.answer } : g?.customer ? { kind: "ask_customer" } : { kind: "unknown" };
          t = await call("POST", `/api/tickets/${key}/messages`, { questionId: q.id, ...body, user });
          continue;
        }
        if (t.status === "waiting_customer") {
          const pending: { field: string; answer?: string }[] = (t.spec.askCustomer ?? []).filter((a: { answer?: string }) => a.answer === undefined);
          const p = pending[0];
          if (!p) break;
          const field = p.field;
          const g = isRequired(field) ? c.fields[field] : undefined;
          t = g?.customer
            ? await call("POST", `/api/tickets/${key}/customer-answer`, { field: p.field, answer: g.customer, user })
            : await call("PATCH", `/api/tickets/${key}/fields`, { field: p.field, value: null, confirm: true, user });
          continue;
        }
        break;
      }
      results.push(score(c, t, n));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return { mode: o.mode, model: o.mode === "fake" ? "golden-fake" : o.model, promptVersion, cases: results, outside };
}

// ---------------------------------------------------------------------------------------------- 표

/** Wilson 점수 구간 (95%). n 이 0 이면 null */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ratio = (k: number, n: number) => (n ? `${k}/${n} (${pct(k / n)})` : "해당 없음");
const interval = (k: number, n: number) => {
  const w = wilson(k, n);
  return w ? `${pct(w[0])} ~ ${pct(w[1])}` : "";
};
const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "0");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function totals(cs: CaseResult[]) {
  const injTp = cs.filter((c) => c.injectionExpected && c.injectionFlagged).length;
  const injFp = cs.filter((c) => !c.injectionExpected && c.injectionFlagged).length;
  const injFn = cs.filter((c) => c.injectionExpected && !c.injectionFlagged).length;
  return {
    n: cs.length,
    expected: sum(cs.map((c) => c.expected)),
    filled: sum(cs.map((c) => c.filled)),
    keywordHit: sum(cs.map((c) => c.keywordHit)),
    questions: avg(cs.map((c) => c.questions)),
    reviewQuestions: avg(cs.map((c) => c.reviewQuestions)),
    unconfirmed: avg(cs.map((c) => c.unconfirmed)),
    schemaCalls: sum(cs.map((c) => c.schemaCalls)),
    schemaPassed: sum(cs.map((c) => c.schemaPassed)),
    residualPii: sum(cs.map((c) => c.residualPii)),
    injectionRight: cs.filter((c) => c.injectionExpected === c.injectionFlagged).length,
    injTp, injFp, injFn,
    categoryRight: cs.filter((c) => c.category === c.categoryExpected).length,
    specReady: cs.filter((c) => c.status === "spec_ready").length,
  };
}

export const WIDE_NOTE = "골든 세트가 100건이 안 되어 신뢰구간이 넓다. 아래 구간(Wilson, 95%)을 같이 보고, 이 숫자만으로 모델이나 양식의 우열을 정하지 않는다.";

/** 한 번 돌린 결과를 표로 */
export function runMarkdown(r: EvalRun): string[] {
  const t = totals(r.cases);
  const shop = r.cases.filter((c) => c.source === "examples/shop");
  const syn = r.cases.filter((c) => c.source === "synthetic");
  const ts = totals(shop);
  const ty = totals(syn);
  const out = [
    `## --ai ${r.mode}${r.model ? ` (${r.model})` : ""}`,
    "",
    `골든 ${t.n}건 (examples/shop ${shop.length}건, 직접 만든 것 ${syn.length}건). promptVersion \`${r.promptVersion}\`. 외부 호출 ${r.outside.length}건.`,
    "",
    "| 지표 | 값 | 95% 구간 (Wilson) |",
    "|---|---|---|",
    `| 칸 채움률 (정답 칸 중 채운 칸) | ${ratio(t.filled, t.expected)} | ${interval(t.filled, t.expected)} |`,
    `| 핵심 낱말 적중 (채웠고 정답 낱말이 들어 있음) | ${ratio(t.keywordHit, t.expected)} | ${interval(t.keywordHit, t.expected)} |`,
    `| 평균 질문 수 (CS 에게 물은 칸) | ${t.questions} | |`,
    `| 대리 검토 질문 수 (평균) | ${t.reviewQuestions} | |`,
    `| 보내기 전 확인할 추정 칸 (평균) | ${t.unconfirmed} | |`,
    `| 스키마 통과율 | ${ratio(t.schemaPassed, t.schemaCalls)} | ${interval(t.schemaPassed, t.schemaCalls)} |`,
    `| 개인정보 남은 수 (residualPii 합) | ${t.residualPii} | |`,
    `| 인젝션 표시 적중 | ${ratio(t.injectionRight, t.n)} (맞게 표시 ${t.injTp}, 놓침 ${t.injFn}, 잘못 표시 ${t.injFp}) | ${interval(t.injectionRight, t.n)} |`,
    `| 분류 일치 | ${ratio(t.categoryRight, t.n)} | ${interval(t.categoryRight, t.n)} |`,
    `| spec_ready 까지 간 건 | ${ratio(t.specReady, t.n)} | |`,
    "",
    "출처별 칸 채움률",
    "",
    "| 출처 | 건수 | 칸 채움률 | 핵심 낱말 적중 | 평균 질문 수 |",
    "|---|---|---|---|---|",
    `| examples/shop | ${ts.n} | ${ratio(ts.filled, ts.expected)} | ${ratio(ts.keywordHit, ts.expected)} | ${ts.questions} |`,
    `| synthetic | ${ty.n} | ${ratio(ty.filled, ty.expected)} | ${ratio(ty.keywordHit, ty.expected)} | ${ty.questions} |`,
    "",
    "건별",
    "",
    "| 건 | 출처 | 상태 | 채움 | 낱말 | 질문 | 검토 | 추정 칸 | 스키마 | PII 남음 | 인젝션 (정답/표시) | 분류 (정답/결과) | 낱말 못 맞춘 칸 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...r.cases.map((c) => `| ${c.id} | ${c.source} | ${c.status} | ${c.filled}/${c.expected} | ${c.keywordHit}/${c.expected} | ${c.questions} | ${c.reviewQuestions} | ${c.unconfirmed} | ${c.schemaCalls ? `${c.schemaPassed}/${c.schemaCalls}` : "-"} | ${c.residualPii} | ${c.injectionExpected ? "예" : "아니오"}/${c.injectionFlagged ? "예" : "아니오"} | ${c.categoryExpected}/${c.category} | ${c.missed.join(", ") || "-"} |`),
  ];
  if (r.outside.length) out.push("", "외부 호출", "", ...r.outside.map((u) => `- ${u}`));
  return out;
}

const READING = [
  "none 은 AI 없이 필수 칸 양식만 쓴 비교군이다. 질문 예산(5개)을 다 쓰면 남은 칸은 모름이 된다.",
  "fake 는 골든 파일에 적어 둔 정해진 응답이다. 흐름이 모델 출력을 어떻게 쓰는지 보는 것이지 모델 성능이 아니다. 정답 칸과 같은 사람이 썼으니 채움률이 높게 나온다.",
  "CS 는 가짜다. 물어본 칸의 답을 골든의 정답 칸에서 고른다. 실제 CS 보다 답을 잘 안다.",
  "칸 채움률의 분모는 골든이 채워져야 한다고 적은 칸이다. 모름으로 둔 칸은 채운 것으로 세지 않는다.",
  "분류: M1 은 분류(F1)를 하지 않아 모든 티켓이 new_bug 로 접수된다. 분류 일치는 그 기준선이다.",
  "인젝션 표시와 개인정보 가리기는 규칙(src/server/safety/)이라 AI 모드와 상관없이 같다. 개인정보 남은 수는 저장되는 글에 residualPii 를 다시 돌린 수이고 오탐도 센다.",
];

/** 여러 번 돌린 결과를 한 문서로. 둘 이상이면 앞에 비교표 */
export function reportMarkdown(runs: EvalRun[], date: string): string {
  const out = [`# 평가 ${date}`, "", "`pnpm eval` 결과. 숫자는 실행한 그대로 옮긴다.", "", WIDE_NOTE, "", "읽는 법", "", ...READING.map((x) => `- ${x}`), ""];
  if (runs.length > 1) {
    out.push("## 비교", "", `| 지표 | ${runs.map((r) => r.mode).join(" | ")} |`, `|---|${runs.map(() => "---").join("|")}|`);
    const ts = runs.map((r) => totals(r.cases));
    const row = (name: string, f: (t: ReturnType<typeof totals>) => string) => out.push(`| ${name} | ${ts.map(f).join(" | ")} |`);
    row("칸 채움률", (t) => `${ratio(t.filled, t.expected)}, ${interval(t.filled, t.expected)}`);
    row("핵심 낱말 적중", (t) => `${ratio(t.keywordHit, t.expected)}, ${interval(t.keywordHit, t.expected)}`);
    row("평균 질문 수", (t) => t.questions);
    row("대리 검토 질문 수 (평균)", (t) => t.reviewQuestions);
    row("스키마 통과율", (t) => ratio(t.schemaPassed, t.schemaCalls));
    row("개인정보 남은 수", (t) => String(t.residualPii));
    row("인젝션 표시 적중", (t) => ratio(t.injectionRight, t.n));
    row("분류 일치", (t) => ratio(t.categoryRight, t.n));
    out.push("");
  }
  for (const r of runs) out.push(...runMarkdown(r), "");
  return `${out.join("\n").trimEnd()}\n`;
}
