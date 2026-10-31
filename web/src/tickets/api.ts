/**
 * 티켓 API 클라이언트. 모양은 docs/design/m1-contract.md 4절 그대로다. 서버(갈래 C)를 기다리지 않고 이 모양만 믿는다.
 * 팀 모드는 Bearer 토큰(api.ts 의 get), 혼자 모드는 본문의 user 로 사람을 알린다. GET 에도 user 쿼리를 붙인다(assignee=me 를 풀 때 필요).
 */
import type { ClarifyQuestion, Request, RequestAttachment, RequestStatus, Source, WorkSpec } from "../../../src/server/types";
import { get, notifyUnauthorized, withToken } from "../api";

export type { ClarifyQuestion, Request, RequestStatus, Source, WorkSpec };

/** 응답의 티켓. next: 지금 CS 에게 물을 질문, unconfirmed: 보내기 전에 CS 가 확인해야 하는 칸 */
export type Ticket = Request & { next?: ClarifyQuestion | null; unconfirmed?: string[] };

export interface TicketSummary {
  id: string;
  key: string;
  title: string;
  status: RequestStatus;
  priority?: Request["priority"];
  assignee?: string;
  requester: string;
  affected: number;
  createdAt: number;
  updatedAt: number;
}

export interface Bundle {
  key: string;
  title: string;
  branch: string;
  repo: string;
  check: string;
  trusted: {
    problem: string;
    reproSteps: string[];
    expected: string;
    actual: string;
    environment: WorkSpec["environment"];
    impact: WorkSpec["impact"];
    alreadyRuledOut: string[];
    acceptanceCriteria: string[];
    outOfScope: string[];
    forDeveloper: string;
    fields: WorkSpec["fields"];
  };
  untrusted?: { customerText: string };
  injectionFlags: { pattern: string; excerpt: string }[];
  customerClaims: string[];
  asks: { question: string; answer?: string }[];
}

export interface Ask {
  askId: string;
  question: string;
  forRequester: string;
  answer?: string;
  answeredAt?: number;
}

/** src/server/ai 의 AiHealth 와 같은 모양 (웹은 서버 코드를 기다리지 않으려고 여기 다시 적는다) */
export interface AiHealth {
  state: "not_installed" | "stopped" | "no_model" | "ready";
  models: { name: string; digest: string }[];
  note?: string;
}
export type AiStatus = AiHealth & {
  enabled: boolean;
  queue: number;
  routing: Record<string, { provider: string; model: string }>;
  pace: "gentle" | "fast";
  /** 로컬 모델이 일한 만큼 쉬는 중이거나 GPU 가 식기를 기다리는 중 */
  resting: boolean;
  hot: boolean;
  gpuTempC?: number;
};

export type AnswerKind = "answer" | "unknown" | "ask_customer";
export type FieldName = "problem" | "reproSteps" | "expected" | "actual" | "environment" | "impact" | "alreadyRuledOut";

export interface StreamHandlers {
  /** 질문이 흘러나오는 글자 (조각) */
  delta?: (text: string) => void;
  ticket?: (t: Ticket) => void;
  queue?: (q: { position: number }) => void;
  state?: (live: boolean) => void;
}

export interface ListQuery {
  status?: RequestStatus[];
  /** "me" 가능 */
  assignee?: string;
  /** 내가 보낸 것 */
  mine?: boolean;
}

export interface TicketApi {
  intake(input: { text: string; channel?: string; attachments?: RequestAttachment[] }): Promise<Ticket>;
  message(key: string, input: { questionId: string; kind: AnswerKind; text?: string }): Promise<Ticket>;
  stream(key: string, on: StreamHandlers): () => void;
  customerAnswer(key: string, input: { field: string; answer: string }): Promise<Ticket>;
  /** value 를 주면 고치고, confirm 이면 CS 가 확인했다고 남긴다. value: null 은 "모름으로 두기" */
  editField(key: string, input: { field: string; value?: unknown; confirm?: true }): Promise<Ticket>;
  /** 409 면 TicketError (body 에 unconfirmed, reviewQuestions) */
  send(key: string): Promise<Ticket>;
  list(q?: ListQuery): Promise<TicketSummary[]>;
  get(key: string): Promise<Ticket>;
  assign(key: string, input: { assignee?: string; priority?: Request["priority"] }): Promise<Ticket>;
  work(key: string, input?: { agent?: "claude" | "codex" | "none" }): Promise<{ ticket: Ticket; branch: string; bundle: Bundle }>;
  bundle(key: string, raw?: boolean): Promise<Bundle>;
  ask(key: string, question: string): Promise<{ ticket: Ticket; askId: string; forRequester: string }>;
  asks(key: string): Promise<Ask[]>;
  answerAsk(key: string, askId: string, answer: string): Promise<Ticket>;
  note(key: string, text: string): Promise<Ticket>;
  decline(key: string, input: { reason: string; alt?: string }): Promise<Ticket>;
  done(key: string, input: { prUrl?: string; summary?: string }): Promise<Ticket>;
  aiStatus(): Promise<AiStatus>;
}

/** 서버가 준 오류. 409 보내기 거절이면 body 에 unconfirmed, reviewQuestions 가 있다 */
export class TicketError extends Error {
  constructor(message: string, readonly status: number, readonly body: { error?: string; unconfirmed?: string[]; reviewQuestions?: string[] } = {}) {
    super(message);
  }
}

async function read<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: { error?: string; team?: boolean } = {};
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && body.team) notifyUnauthorized();
    throw new TicketError(body.error ? String(body.error) : `${res.status} ${res.statusText}`, res.status, body);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

/** EventSource 의 이름 붙은 이벤트. delta 는 글자 조각이 그대로 오거나 {text} JSON 으로 온다 */
function deltaText(data: string): string {
  try {
    const v = JSON.parse(data);
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return String(v.text ?? v.delta ?? "");
  } catch {
    /* plain text */
  }
  return data;
}

export function httpTicketApi(who: () => string): TicketApi {
  const T = (key: string) => `/api/tickets/${enc(key)}`;
  const send = <R>(url: string, body: Record<string, unknown> = {}, method = "POST") =>
    get(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, user: who() }) }).then((r) => read<R>(r));
  const fetchJson = <R>(url: string) => get(`${url}${url.includes("?") ? "&" : "?"}user=${enc(who())}`).then((r) => read<R>(r));
  return {
    intake: (input) => send<Ticket>("/api/intake", input),
    message: (key, input) => send<Ticket>(`${T(key)}/messages`, input),
    stream(key, on) {
      const es = new EventSource(withToken(`${T(key)}/stream`));
      es.onopen = () => on.state?.(true);
      es.onerror = () => on.state?.(false);
      es.addEventListener("delta", (e) => on.delta?.(deltaText((e as MessageEvent).data)));
      es.addEventListener("ticket", (e) => {
        try {
          on.ticket?.(JSON.parse((e as MessageEvent).data) as Ticket);
        } catch {
          /* keep-alive */
        }
      });
      es.addEventListener("queue", (e) => {
        try {
          on.queue?.(JSON.parse((e as MessageEvent).data) as { position: number });
        } catch {
          /* keep-alive */
        }
      });
      return () => es.close();
    },
    customerAnswer: (key, input) => send<Ticket>(`${T(key)}/customer-answer`, input),
    editField: (key, input) => send<Ticket>(`${T(key)}/fields`, input, "PATCH"),
    send: (key) => send<Ticket>(`${T(key)}/send`),
    list(q = {}) {
      const p = new URLSearchParams();
      if (q.status?.length) p.set("status", q.status.join(","));
      if (q.assignee) p.set("assignee", q.assignee);
      if (q.mine) p.set("mine", "1");
      const qs = p.toString();
      return fetchJson<TicketSummary[]>(`/api/tickets${qs ? `?${qs}` : ""}`);
    },
    get: (key) => fetchJson<Ticket>(T(key)),
    assign: (key, input) => send<Ticket>(`${T(key)}/assign`, input),
    work: (key, input = {}) => send(`${T(key)}/work`, input),
    bundle: (key, raw) => fetchJson<Bundle>(`${T(key)}/bundle${raw ? "?raw=1" : ""}`),
    ask: (key, question) => send(`${T(key)}/ask`, { question }),
    asks: (key) => fetchJson<Ask[]>(`${T(key)}/asks`),
    answerAsk: (key, askId, answer) => send<Ticket>(`${T(key)}/asks/${enc(askId)}/answer`, { answer }),
    note: (key, text) => send<Ticket>(`${T(key)}/note`, { text }),
    decline: (key, input) => send<Ticket>(`${T(key)}/decline`, input),
    done: (key, input) => send<Ticket>(`${T(key)}/done`, input),
    aiStatus: () => fetchJson<AiStatus>("/api/ai/status"),
  };
}

// ---------------------------------------------------------------------------------------------- fields

/** 필수 칸, 계약 3절 표 순서 */
export const FIELDS: FieldName[] = ["problem", "reproSteps", "expected", "actual", "environment", "impact", "alreadyRuledOut"];
export const FIELD_KO: Record<FieldName, string> = {
  problem: "증상",
  reproSteps: "재현 단계",
  expected: "기대 결과",
  actual: "실제 결과",
  environment: "환경",
  impact: "영향 범위",
  alreadyRuledOut: "이미 해 본 것",
};
export const fieldLabel = (f: string) => FIELD_KO[f as FieldName] ?? f;

export type Confidence = "low" | "medium" | "high" | "unknown";
export const CONF_KO: Record<Confidence, string> = { high: "확실", medium: "보통", low: "낮음", unknown: "모름" };

export const fieldMeta = (spec: WorkSpec | undefined, f: string) => spec?.fields?.[f];

/** 칸 값을 한 줄 글로. 비었으면 "" */
export function fieldText(spec: WorkSpec | undefined, f: FieldName): string {
  if (!spec) return "";
  switch (f) {
    case "reproSteps":
      return (spec.reproSteps ?? []).join("\n");
    case "alreadyRuledOut":
      return (spec.alreadyRuledOut ?? []).join(", ");
    case "environment": {
      const e = spec.environment ?? {};
      return [e.browser, e.os, e.appVersion && `앱 ${e.appVersion}`, e.deployedSha && `배포 ${e.deployedSha.slice(0, 7)}`].filter(Boolean).join(", ");
    }
    case "impact": {
      const i = spec.impact;
      if (!i) return "";
      return [i.customers ? `${i.customers}명` : "", i.note ?? ""].filter(Boolean).join(", ");
    }
    default:
      return (spec[f] as string | undefined) ?? "";
  }
}

/** "추정": 출처가 없거나 확신도가 낮은 칸 (모름으로 확정한 칸은 빼고) */
export function isGuess(spec: WorkSpec | undefined, f: string): boolean {
  const m = fieldMeta(spec, f);
  if (!m) return false;
  if (m.confidence === "unknown") return false;
  return m.confidence === "low" || !m.sources.length;
}

/** 서버가 unconfirmed 를 주면 그것을, 아니면 화면에서 같은 규칙으로 계산 */
export function unconfirmedOf(t: Ticket): string[] {
  if (t.unconfirmed) return t.unconfirmed;
  return FIELDS.filter((f) => isGuess(t.spec, f) && !fieldMeta(t.spec, f)?.confirmedBy);
}

/** 고객에게 물으려고 보류한 칸 */
export const heldFields = (t: Ticket) => (t.spec?.askCustomer ?? []).filter((a) => !a.answer);

/** 대화 기록을 말 단위로 나눈다. `고객:`, `상담원:` 같은 줄 머리가 없으면 전부 고객의 말 하나 */
const SPEAKER = /^\s*(고객|손님|상담원|상담사|매니저|CS|cs)\s*[:：]\s*/;
export function utterances(text: string): { speaker: "customer" | "agent"; text: string }[] {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => SPEAKER.test(l))) return [{ speaker: "customer", text: text.trim() }];
  const out: { speaker: "customer" | "agent"; text: string }[] = [];
  for (const l of lines) {
    const m = SPEAKER.exec(l);
    if (m) out.push({ speaker: /고객|손님/.test(m[1]) ? "customer" : "agent", text: l.slice(m[0].length).trim() });
    else if (l.trim() && out.length) out[out.length - 1].text += ` ${l.trim()}`;
  }
  return out;
}

export function sourceLabel(s: Source): string {
  switch (s.kind) {
    case "utterance":
      return s.speaker === "cs" ? "CS 답" : `${s.speaker === "customer" ? "고객" : "상담원"}, ${s.index + 1}번째 줄`;
    case "ticket":
      return s.key;
    case "doc":
      return s.heading ? `${s.path} ${s.heading}` : s.path;
    case "evidence":
      return s.adapter;
    case "screen":
      return s.route;
  }
}

/** 고객에게 보낼 문구. 보류한 질문을 번호로 */
export function customerMessage(items: { question: string }[]): string {
  if (!items.length) return "";
  const lines = items.map((a, i) => `${i + 1}. ${a.question}`);
  return ["안녕하세요, 고객님. 확인하려고 몇 가지 여쭤볼게요.", ...lines, "답 주시면 개발팀에 그대로 전달할게요."].join("\n");
}

/** 티켓 경로의 단계 (CS 의 내 티켓, 상세) */
export const TICKET_STEPS: { name: string; at: RequestStatus[] }[] = [
  { name: "보냄", at: ["open"] },
  { name: "담당자", at: ["assigned"] },
  { name: "작업", at: ["in_progress", "waiting_requester", "preview"] },
  { name: "검토", at: ["code_review"] },
  { name: "반영", at: ["merged", "deployed", "closed"] },
];
export const INTAKE: RequestStatus[] = ["draft", "clarifying", "waiting_customer", "spec_ready"];
export const isIntake = (s: RequestStatus) => INTAKE.includes(s);

/** 나이: "3분", "5시간", "2일" */
export function age(ts: number, now = Date.now()): string {
  const m = Math.max(0, now - ts) / 60000;
  if (m < 1) return "방금";
  if (m < 60) return `${Math.round(m)}분`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간`;
  return `${Math.round(m / 60 / 24)}일`;
}

/** willnew work 명령 */
export const workCommand = (key: string) => `willnew work ${key}`;
