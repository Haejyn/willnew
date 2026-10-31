/**
 * 티켓 흐름 (m1-contract.md 3절). RequestManager 는 그대로 두고 그 위에서 티켓(Request + key)을 움직인다.
 *
 *   접수: 가리기 → 말한 사람 나누기 → extract 로 칸 먼저 채우기 (칸마다 sources, confidence)
 *   대화: 규칙이 다음 칸을 고르고 ask 는 질문 한 문장과 선택지만. 답은 answer, unknown, ask_customer. 질문 예산 5
 *   초안: draft (제목, 수용 기준, 범위 밖, 요약, 브랜치용 영문 세 단어) → 대리 개발자 검토 → spec_ready
 *   보내기: 추정 칸을 CS 가 하나씩 확인해야 open
 *   개발자: assign → work → ask ⇄ CS 답 → done (preview 또는 code_review) · note · decline
 *   git: PR 열림 → code_review, 병합 → merged
 *
 * AI 가 없으면(양식 모드) 같은 흐름을 기본 질문과 규칙으로 끝까지 간다. 상태는 request-state.ts 의 표로만 바꾼다.
 * 가린 글만 AI, 저장소, 로그에 쓰고 원래 값은 saveRedactions 로 따로 둔다.
 */
import { EventEmitter } from "node:events";
import type { Ai, LlmRecord } from "../ai/index.js";
import { isVisual, moveTo, parseAttachments, transition } from "../request-state.js";
import type { RequestManager } from "../requests.js";
import { checkPromises, customerClaims, datamark, detectInjection, loadRedactions, redact, saveRedactions } from "../safety/index.js";
import type { ClarifyQuestion, Request, RequestAttachment, RequestStatus, Source, TicketActionKind, TicketAsk, TicketNote, WorkSpec } from "../types.js";
import {
  applyAnswer, csSource, CUSTOMER_QUESTION, customerSource, DEFAULT_CHOICES, DEFAULT_QUESTION, emptySpec, FIELD_KO, fieldText, isEditable,
  isRequired, REQUIRED, slugOf, splitSpeakers, unconfirmedFields, type EditableField, type RequiredField,
} from "./fields.js";
import { findTicketKey } from "./git.js";
import { AskSchema, askMessages, DraftSchema, draftMessages, ExtractSchema, extractMessages, promptVersion, relayMessages, ReviewSchema, reviewMessages, type Extract, type RelayKind } from "./prompts.js";

export type Ticket = Request & { next?: ClarifyQuestion | null; unconfirmed?: string[] };

export interface TicketSummary {
  id: string;
  key: string;
  title: string;
  status: Request["status"];
  priority?: Request["priority"];
  assignee?: string;
  requester: string;
  affected: number;
  createdAt: number;
  updatedAt: number;
}

export interface Bundle {
  key: string; title: string; branch: string; repo: string; check: string;
  trusted: {
    problem: string; reproSteps: string[]; expected: string; actual: string;
    environment: WorkSpec["environment"]; impact: WorkSpec["impact"]; alreadyRuledOut: string[];
    acceptanceCriteria: string[]; outOfScope: string[]; forDeveloper: string;
    fields: WorkSpec["fields"];
  };
  untrusted?: { customerText: string };
  injectionFlags: { pattern: string; excerpt: string }[];
  customerClaims: string[];
  asks: { question: string; answer?: string }[];
}

/** 상태 코드가 있는 오류. 본문의 나머지 칸은 응답에 같이 나간다 (409 의 unconfirmed 같은 것) */
export class TicketError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

/** SSE 로 나가는 것. ticket 은 requests.bus 의 request:<id> 를 따로 듣는다 */
export interface TicketStreamEvent {
  event: "delta" | "queue";
  data: unknown;
}

export interface TicketFlowOptions {
  requests: RequestManager;
  ai: Ai;
  repo: string;
  check: string;
  /** 새 티켓이 들어갈 채팅 채널 (스레드가 거기 산다) */
  channel: string;
  team?: string;
  /** 질문 예산. 기본 5 */
  budget?: number;
  /** 팀 사전: 고객 이름 목록 (가리기) */
  names?: string[];
}

const FORM_MODE = "AI 없이 양식 모드로 정리했어요";
const INTAKE: RequestStatus[] = ["draft", "clarifying", "waiting_customer", "spec_ready"];
/** 보낸 뒤 개발자 손에 있는 상태 */
const WITH_DEV: RequestStatus[] = ["open", "assigned", "in_progress", "waiting_requester", "preview", "code_review"];
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const GREETING = /^(?:안녕하세요|안녕하십니까|안녕|hi|hello|문의\s*드립니다|문의드려요)[\s.!~?]*$/i;

const rid = () => `t${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
const aid = () => `a${Math.random().toString(36).slice(2, 8)}`;
export const normalizeTicketKey = (k: string) => (/^\d+$/.test(k) ? `T-${k}` : /^t-\d+$/i.test(k) ? k.toUpperCase() : k);
const keyNumber = (key: string | undefined) => Number(/^T-(\d+)$/.exec(key ?? "")?.[1] ?? 0);
const isTicket = (r: Request) => r.category !== undefined;
const fieldOfQuestion = (id: string): RequiredField | "review" | null => {
  if (id.startsWith("r-")) return "review";
  const m = /^f-([A-Za-z]+)-\d+$/.exec(id);
  return m && isRequired(m[1]) ? m[1] : null;
};

function emptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return !v.trim();
  if (Array.isArray(v)) return !v.some((x) => typeof x === "string" && x.trim());
  if (typeof v === "object") return !Object.values(v).some((x) => x !== undefined && x !== null && String(x).trim());
  return false;
}

/** extract 가 준 값을 그 칸에 (모양은 스키마가 이미 봤다) */
function setExtracted(spec: WorkSpec, f: RequiredField, v: NonNullable<Extract[RequiredField]>["value"]): WorkSpec {
  if (f === "reproSteps" || f === "alreadyRuledOut") return { ...spec, [f]: (v as string[]).map((x) => x.trim()).filter(Boolean) };
  if (f === "environment") {
    const e = v as NonNullable<WorkSpec["environment"]>;
    const env: NonNullable<WorkSpec["environment"]> = {};
    for (const k of ["browser", "os", "appVersion"] as const) if (e[k]?.trim()) env[k] = e[k]!.trim();
    return { ...spec, environment: env };
  }
  if (f === "impact") return { ...spec, impact: v as NonNullable<WorkSpec["impact"]> };
  return { ...spec, [f]: (v as string).trim() };
}

export class TicketFlow {
  /** `ticket:<id>` → TicketStreamEvent */
  readonly bus = new EventEmitter();
  private locks = new Map<string, Promise<unknown>>();

  constructor(private o: TicketFlowOptions) {
    this.bus.setMaxListeners(200);
    o.ai.queue.on("position", (id: string, n: number) => {
      if (this.o.requests.get(id)) this.emit(id, { event: "queue", data: { position: n } });
    });
  }

  // ------------------------------------------------------------------------------------------ reading

  /** 키(T-42, t-42, 42)나 요청 id 로. 티켓이 아닌 요청(B1)은 없는 것으로 */
  find(k: string): Request | undefined {
    const r = this.o.requests.get(k) ?? this.o.requests.list().find((x) => x.key === normalizeTicketKey(k));
    return r && isTicket(r) ? r : undefined;
  }

  private need(k: string): Request {
    const r = this.find(k);
    if (!r) throw new TicketError("티켓을 찾을 수 없어요", 404);
    return r;
  }

  view(req: Request): Ticket {
    const next = req.status === "clarifying" ? (req.questions.find((q) => !q.answer) ?? null) : null;
    return { ...publicRequest(req), next, unconfirmed: unconfirmedFields(req.spec) };
  }

  summary(r: Request): TicketSummary {
    return {
      id: r.id, key: r.key ?? r.id, title: r.title, status: r.status, priority: r.priority, assignee: r.assignee, requester: r.requester,
      affected: Math.max(r.affected?.length ?? 0, r.spec?.impact?.customers ?? 0), createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }

  /** 티켓함. status 는 여러 개, assignee 는 이름 ("none" 이면 담당 없음), requester 는 내가 보낸 것 */
  list(f: { status?: string[]; assignee?: string; requester?: string } = {}): TicketSummary[] {
    return this.o.requests.list()
      .filter(isTicket)
      .filter((r) => !f.status?.length || f.status.includes(r.status))
      .filter((r) => f.assignee === undefined || (f.assignee === "none" ? !r.assignee : r.assignee === f.assignee))
      .filter((r) => f.requester === undefined || r.requester === f.requester)
      .map((r) => this.summary(r));
  }

  bundle(k: string | Request, raw = false): Bundle {
    const req = typeof k === "string" ? this.need(k) : k;
    const s = req.spec ?? emptySpec(req.title);
    const review = req.questions.filter((q) => q.id.startsWith("r-")).map((q) => ({ question: q.question, answer: q.answer }));
    const asks = (req.asks ?? []).map((a) => ({ question: a.question, answer: a.answer }));
    return {
      key: req.key ?? req.id, title: s.title || req.title, branch: req.branch ?? this.branchName(req), repo: req.repo, check: req.check,
      trusted: {
        problem: s.problem, reproSteps: s.reproSteps ?? [], expected: s.expected, actual: s.actual ?? "", environment: s.environment ?? {},
        impact: s.impact, alreadyRuledOut: s.alreadyRuledOut ?? [], acceptanceCriteria: s.acceptanceCriteria, outOfScope: s.outOfScope,
        forDeveloper: s.summary.forDeveloper, fields: s.fields ?? {},
      },
      ...(raw ? { untrusted: { customerText: datamark(this.customerText(req)) } } : {}),
      injectionFlags: req.injectionFlags ?? [], customerClaims: req.customerClaims ?? [], asks: [...review, ...asks],
    };
  }

  asks(k: string): { askId: string; question: string; forRequester: string; answer?: string; answeredAt?: number }[] {
    return (this.need(k).asks ?? []).map((a) => ({ askId: a.askId, question: a.question, forRequester: a.forRequester, answer: a.answer, answeredAt: a.answeredAt }));
  }

  // ------------------------------------------------------------------------------------------ CS 쪽

  /** 문의 접수. 응답은 첫 질문이 있는 clarifying 이거나 바로 spec_ready */
  async intake(input: { text: string; user: string; channel?: string; attachments?: unknown; userTitle?: string; userAvatar?: string }): Promise<Ticket> {
    const original = String(input.text ?? "").trim();
    if (!original) throw new TicketError("문의 내용이 비어 있어요", 400);
    const now = Date.now();
    const id = rid();
    const red = redact(original, { names: this.o.names });
    const text = red.text;
    const utterances = splitSpeakers(text);
    const first = utterances.find((u) => u.speaker === "customer" && !GREETING.test(u.text.trim())) ?? utterances[0];
    const title = first.text.split("\n")[0].trim().slice(0, 40) || "새 문의";
    const req: Request = {
      id, key: this.o.requests.store.nextKey(), threadId: `req-${id}`, channel: input.channel?.trim() || this.o.channel, repo: this.o.repo, check: this.o.check,
      team: this.o.team ?? "platform", requester: input.user, requesterTitle: input.userTitle, requesterAvatar: input.userAvatar,
      text, attachments: [...parseAttachments(text), ...attachmentsOf(input.attachments)], status: "draft", title, questions: [], decisions: [], runIds: [],
      category: "new_bug", type: "bug", affected: [{ who: input.user, at: now, ref: "intake" }], utterances, spec: emptySpec(title),
      injectionFlags: [], customerClaims: [], edits: [], llm: [], actions: [], asks: [], notes: [], createdAt: now, updatedAt: now,
    };
    // redactionsRef 는 요청 id 만 둔다. 서버의 파일 경로는 응답과 저장소에 남기지 않는다 (loadRedactions 는 id 를 받는다)
    if (red.items.length) {
      saveRedactions(id, red.items);
      req.redactionsRef = id;
    }
    this.scan(req);
    this.o.requests.adopt(req);
    return this.locked(req, async () => {
      const on = await this.o.ai.enabled();
      req.planner = on ? { by: "llm" } : { by: "fallback", note: FORM_MODE };
      if (on) await this.extract(req);
      await this.advance(req);
      this.save(req);
      return this.view(req);
    });
  }

  /** CS 의 답 셋: answer (칸 채움), unknown (모름 확정), ask_customer (고객에게 물을 것, 그 칸은 보류) */
  async message(k: string, input: { questionId: string; kind: string; text?: string; by: string }): Promise<Ticket> {
    const req = this.need(k);
    return this.locked(req, async () => {
      if (req.status !== "clarifying" && req.status !== "waiting_customer") throw new TicketError("지금은 답할 질문이 없어요", 409);
      const q = req.questions.find((x) => x.id === input.questionId);
      if (!q) throw new TicketError("질문을 찾을 수 없어요", 404);
      const field = fieldOfQuestion(q.id);
      if (!field) throw new TicketError("질문을 찾을 수 없어요", 404);
      const kind = input.kind;
      if (kind !== "answer" && kind !== "unknown" && kind !== "ask_customer") throw new TicketError("답은 answer, unknown, ask_customer 중 하나예요", 400);
      const pending = field !== "review" && this.pendingFields(req).includes(field);
      // 고객에게 물으러 간 칸은 나중에 모름으로 둘 수 있다 (CS 가 그대로 보내기)
      if (q.answer && !(kind === "unknown" && pending)) throw new TicketError("이미 답한 질문이에요", 409);
      const spec = req.spec!;
      if (kind === "answer") {
        const t = this.redactMore(req, String(input.text ?? "").trim());
        if (!t) throw new TicketError("답이 비어 있어요", 400);
        const i = req.utterances!.push({ speaker: "cs", text: t }) - 1;
        if (field !== "review") this.fill(req, field, t, csSource(i), "high");
        q.answer = t.slice(0, 500);
      } else if (kind === "unknown") {
        if (field !== "review") {
          req.spec = { ...req.spec!, fields: { ...req.spec!.fields, [field]: { sources: [], confidence: "unknown" } }, askCustomer: (spec.askCustomer ?? []).filter((a) => !(a.field === field && a.answer === undefined)) };
        }
        q.answer = "모름";
      } else {
        const asked = this.redactMore(req, String(input.text ?? "").trim()) || (field === "review" ? q.question : CUSTOMER_QUESTION[field]);
        req.spec = { ...spec, askCustomer: [...(spec.askCustomer ?? []), { field: field === "review" ? `review:${q.id}` : field, question: asked.slice(0, 300) }] };
        q.answer = "고객에게 물을 것";
      }
      Object.assign(q, { answeredBy: input.by, answeredAt: Date.now() });
      this.act(req, input.by, "answer", `${q.question}: ${q.answer}`);
      if (req.status === "waiting_customer") transition(req, "clarifying");
      await this.advance(req);
      this.save(req);
      return this.view(req);
    });
  }

  /** 고객이 답한 것을 CS 가 붙인다. 보류였던 칸이 채워지고 흐름이 이어진다 */
  async customerAnswer(k: string, input: { field: string; answer: string; by: string }): Promise<Ticket> {
    const req = this.need(k);
    return this.locked(req, async () => {
      if (req.status !== "clarifying" && req.status !== "waiting_customer") throw new TicketError("지금은 고객 답을 붙일 수 없어요", 409);
      const field = String(input.field ?? "");
      const item = (req.spec?.askCustomer ?? []).find((a) => a.field === field && a.answer === undefined);
      if (!item) throw new TicketError("고객에게 물은 칸이 아니에요", 404);
      const t = this.redactMore(req, String(input.answer ?? "").trim());
      if (!t) throw new TicketError("고객 답이 비어 있어요", 400);
      item.answer = t.slice(0, 1000);
      const i = req.utterances!.push({ speaker: "customer", text: t }) - 1;
      if (isRequired(field)) this.fill(req, field, t, customerSource(i), "high");
      this.scan(req);
      this.act(req, input.by, "answer", `고객 답 (${isRequired(field) ? FIELD_KO[field] : "추가 질문"}): ${item.answer}`);
      if (req.status === "waiting_customer") transition(req, "clarifying");
      await this.advance(req);
      this.save(req);
      return this.view(req);
    });
  }

  /**
   * CS 가 칸을 고치거나(value) 추정 칸을 확인한다(confirm). 고친 것은 edits 에 전후로.
   * `{ value: null, confirm: true }` 는 "모름으로 두기": 그 칸을 unknown 으로 확정하고 고객에게 물으러 간 보류를 푼다.
   * 보류가 다 풀리면 waiting_customer 에서 다음 단계로 간다.
   */
  async editField(k: string, input: { field: string; value?: unknown; confirm?: boolean; by: string }): Promise<Ticket> {
    const req = this.need(k);
    return this.locked(req, async () => {
      if (!INTAKE.includes(req.status)) throw new TicketError("보낸 뒤에는 칸을 고칠 수 없어요", 409);
      const field = String(input.field ?? "");
      if (!isEditable(field)) throw new TicketError("고칠 수 없는 칸이에요", 400);
      if (input.value === null) {
        if (input.confirm !== true) throw new TicketError("모름으로 두려면 confirm 이 필요해요", 400);
        if (!isRequired(field)) throw new TicketError("모름으로 둘 수 있는 건 필수 칸뿐이에요", 400);
        const spec = req.spec!;
        req.spec = { ...spec, fields: { ...spec.fields, [field]: { sources: [], confidence: "unknown", confirmedBy: input.by } },
          askCustomer: (spec.askCustomer ?? []).filter((a) => !(a.field === field && a.answer === undefined)) };
        this.act(req, input.by, "confirm", `${FIELD_KO[field]}: 모름`);
        if (req.status === "waiting_customer" && !this.pendingFields(req).length) {
          transition(req, "clarifying");
          await this.advance(req);
        }
        this.save(req);
        return this.view(req);
      }
      return this.editValue(req, field, input);
    });
  }

  private editValue(req: Request, field: EditableField, input: { value?: unknown; confirm?: boolean; by: string }): Ticket {
    if (input.value === undefined && input.confirm !== true) throw new TicketError("value 나 confirm 이 필요해요", 400);
    if (input.confirm === true && input.value === undefined && !req.spec?.fields?.[field]) throw new TicketError("확인할 칸이 아니에요", 400);
    const now = Date.now();
    if (input.value !== undefined) {
      const v = this.redactMore(req, Array.isArray(input.value) ? input.value.map(String).join("\n") : String(input.value)).trim();
      const before = fieldText(req.spec!, field);
      req.spec = applyAnswer(req.spec!, field, v);
      const after = fieldText(req.spec, field);
      req.edits = [...(req.edits ?? []), { by: input.by, at: now, field, before, after }];
      const i = req.utterances!.push({ speaker: "cs", text: v }) - 1;
      req.spec.fields = { ...req.spec.fields, [field]: { sources: [csSource(i)], confidence: "high", confirmedBy: input.by } };
      if (field === "title" && after) req.title = after;
      this.act(req, input.by, "edit", `${FIELD_KO[field]}: ${before || "(빈 값)"} → ${after || "(빈 값)"}`);
    } else {
      req.spec!.fields![field] = { ...req.spec!.fields![field], confirmedBy: input.by };
      this.act(req, input.by, "confirm", FIELD_KO[field]);
    }
    this.save(req);
    return this.view(req);
  }

  /** 이대로 보내기. 대리 검토 질문이 남았거나 추정 칸을 확인하지 않았으면 409 */
  send(k: string, by: string): Ticket {
    const req = this.need(k);
    if (req.status !== "spec_ready") {
      const open = req.questions.filter((q) => !q.answer);
      if (req.status === "clarifying" && open.length && open.every((q) => q.id.startsWith("r-")))
        throw new TicketError("대리 검토 질문에 먼저 답해 주세요", 409, { reviewQuestions: open.map((q) => q.question) });
      if (req.status === "waiting_customer") throw new TicketError("고객 답을 기다리는 칸이 있어요. 모름으로 두면 보낼 수 있어요", 409);
      throw new TicketError("아직 보낼 수 있는 상태가 아니에요", 409);
    }
    const unconfirmed = unconfirmedFields(req.spec);
    if (unconfirmed.length) throw new TicketError("추정 칸을 하나씩 확인해 주세요", 409, { unconfirmed });
    transition(req, "open");
    this.act(req, by, "send");
    this.save(req);
    return this.view(req);
  }

  // ------------------------------------------------------------------------------------------ 개발자 쪽

  /** 담당자와 우선순위. 사람만 정한다 */
  assign(k: string, input: { assignee?: string; priority?: string; by: string }): Ticket {
    const req = this.need(k);
    if (input.priority !== undefined && !PRIORITIES.includes(input.priority as (typeof PRIORITIES)[number])) throw new TicketError("우선순위는 P0~P3 이에요", 400);
    if (!WITH_DEV.includes(req.status)) throw new TicketError("보낸 티켓만 담당자를 정할 수 있어요", 409);
    const who = String(input.assignee ?? "").trim() || input.by;
    req.assignee = who.slice(0, 60);
    if (input.priority) req.priority = input.priority as Request["priority"];
    if (req.status === "open") transition(req, "assigned");
    this.act(req, input.by, "assign", `${req.assignee}${input.priority ? `, ${input.priority}` : ""}`);
    this.save(req);
    return this.view(req);
  }

  /** 작업 시작: in_progress, 브랜치 이름, 묶음 */
  work(k: string, input: { agent?: string; by: string }): { ticket: Ticket; branch: string; bundle: Bundle } {
    const req = this.need(k);
    if (!["open", "assigned", "in_progress", "waiting_requester"].includes(req.status)) throw new TicketError("작업을 시작할 수 있는 상태가 아니에요", 409);
    if (input.agent !== undefined && !["claude", "codex", "none"].includes(input.agent)) throw new TicketError("agent 는 claude, codex, none 중 하나예요", 400);
    if (req.status === "open") {
      req.assignee ??= input.by;
      transition(req, "assigned");
      this.act(req, input.by, "assign", req.assignee);
    }
    req.assignee ??= input.by;
    req.branch ??= this.branchName(req);
    if (req.status === "assigned") transition(req, "in_progress");
    this.act(req, input.by, "work", `${req.branch}${input.agent ? ` (${input.agent})` : ""}`);
    this.save(req);
    return { ticket: this.view(req), branch: req.branch, bundle: this.bundle(req) };
  }

  /** 개발자가 CS 에게 묻는다. relay 로 CS 말로 바꾸고 원문도 둔다 → waiting_requester */
  async ask(k: string, input: { question: string; by: string }): Promise<{ ticket: Ticket; askId: string; forRequester: string }> {
    const req = this.need(k);
    const question = String(input.question ?? "").trim();
    if (!question) throw new TicketError("질문이 비어 있어요", 400);
    return this.locked(req, async () => {
      if (req.status !== "in_progress" && req.status !== "waiting_requester") throw new TicketError("작업 중인 티켓에만 물어볼 수 있어요", 409);
      const forRequester = await this.relay(req, "ask", question, `개발자가 물어봤어요: ${question}`);
      const a: TicketAsk = { askId: aid(), question: question.slice(0, 1000), forRequester, by: input.by, at: Date.now() };
      req.asks = [...(req.asks ?? []), a];
      if (req.status === "in_progress") transition(req, "waiting_requester");
      this.act(req, input.by, "ask", question.slice(0, 300));
      this.save(req);
      this.o.requests.bus.emit("ticket_ask", req, a);
      return { ticket: this.view(req), askId: a.askId, forRequester };
    });
  }

  /** CS 의 답. 남은 질문이 없으면 in_progress 로 */
  answerAsk(k: string, askId: string, input: { answer: string; by: string }): Ticket {
    const req = this.need(k);
    const a = (req.asks ?? []).find((x) => x.askId === askId);
    if (!a) throw new TicketError("질문을 찾을 수 없어요", 404);
    if (a.answer !== undefined) throw new TicketError("이미 답한 질문이에요", 409);
    const t = this.redactMore(req, String(input.answer ?? "").trim());
    if (!t) throw new TicketError("답이 비어 있어요", 400);
    Object.assign(a, { answer: t.slice(0, 2000), answeredBy: input.by, answeredAt: Date.now() });
    if (req.status === "waiting_requester" && (req.asks ?? []).every((x) => x.answer !== undefined)) transition(req, "in_progress");
    this.act(req, input.by, "answer", `${a.question}: ${a.answer}`);
    this.save(req);
    this.o.requests.bus.emit("ticket_ask_answer", req, a);
    return this.view(req);
  }

  async note(k: string, input: { text: string; by: string }): Promise<Ticket> {
    const req = this.need(k);
    const text = String(input.text ?? "").trim();
    if (!text) throw new TicketError("메모가 비어 있어요", 400);
    return this.locked(req, async () => {
      if (!WITH_DEV.includes(req.status)) throw new TicketError("보낸 티켓에만 메모를 남길 수 있어요", 409);
      const forRequester = await this.relay(req, "note", text, `개발자 메모: ${text}`);
      const n: TicketNote = { kind: "note", by: input.by, at: Date.now(), text: text.slice(0, 2000), forRequester };
      req.notes = [...(req.notes ?? []), n];
      this.act(req, input.by, "note", text.slice(0, 300));
      this.save(req);
      this.o.requests.bus.emit("ticket_note", req, n);
      return this.view(req);
    });
  }

  async decline(k: string, input: { reason: string; alt?: string; by: string }): Promise<Ticket> {
    const req = this.need(k);
    const reason = String(input.reason ?? "").trim();
    const alt = String(input.alt ?? "").trim();
    if (!reason) throw new TicketError("이유를 적어 주세요", 400);
    return this.locked(req, async () => {
      if (!WITH_DEV.includes(req.status)) throw new TicketError("보낸 티켓만 안 하기로 할 수 있어요", 409);
      const said = `이유: ${reason}${alt ? `\n대안: ${alt}` : ""}`;
      const fallback = `이번엔 진행하지 않기로 했어요. 이유: ${reason}${alt ? `. 대신 이렇게 할 수 있어요: ${alt}` : ""}`;
      const forRequester = await this.relay(req, "decline", said, fallback);
      req.decline = { reason: reason.slice(0, 1000), forRequester, alternatives: alt ? [{ title: alt.slice(0, 300), effort: "" }] : [] };
      transition(req, "declined");
      this.act(req, input.by, "decline", reason.slice(0, 300));
      this.save(req);
      this.o.requests.bus.emit("declined", req, input.by);
      return this.view(req);
    });
  }

  /** 완료. 화면 확인 대상이면 preview, 아니면 code_review. CS 용 요약의 날짜 약속은 경고로 */
  async done(k: string, input: { prUrl?: string; summary?: string; by: string }): Promise<Ticket> {
    const req = this.need(k);
    const prUrl = String(input.prUrl ?? "").trim();
    if (prUrl && !/^https?:\/\//i.test(prUrl)) throw new TicketError("PR 주소는 http 로 시작해야 해요", 400);
    return this.locked(req, async () => {
      if (req.status !== "in_progress" && req.status !== "waiting_requester") throw new TicketError("작업 중인 티켓만 끝낼 수 있어요", 409);
      const text = String(input.summary ?? "").trim() || `${req.title} 작업을 마쳤어요`;
      const forRequester = await this.relay(req, "done", text, text);
      const warnings = checkPromises(forRequester, { merged: false, deployed: false });
      if (prUrl) req.prUrl = prUrl;
      if (req.status === "waiting_requester") transition(req, "in_progress");
      transition(req, isVisual(req) ? "preview" : "code_review");
      const n: TicketNote = { kind: "done", by: input.by, at: Date.now(), text: text.slice(0, 2000), forRequester, ...(warnings.length ? { warnings } : {}) };
      req.notes = [...(req.notes ?? []), n];
      req.report = { forRequester, forDeveloper: n.text, ...(prUrl ? { prUrl } : {}), at: n.at };
      this.act(req, input.by, "done", prUrl || undefined);
      this.save(req);
      this.o.requests.bus.emit("ticket_note", req, n);
      return this.view(req);
    });
  }

  /**
   * 요청자 확인 (preview). run 이 없는 티켓 경로라서 RequestManager.requesterCheck 대신 여기서 본다.
   * ok (의도대로예요) → code_review, changes (다시 봐 주세요) → in_progress. 고칠 점은 메모로 개발자에게 간다
   */
  check(k: string, input: { verdict: string; note?: string; by: string }): Ticket {
    const req = this.need(k);
    if (input.verdict !== "ok" && input.verdict !== "changes") throw new TicketError("verdict 는 ok 나 changes 예요", 400);
    if (req.status !== "preview") throw new TicketError("지금은 확인할 화면이 없어요", 409);
    const note = String(input.note ?? "").trim() ? this.redactMore(req, String(input.note).trim()).slice(0, 1000) : "";
    if (input.verdict === "ok") {
      transition(req, "code_review");
      this.act(req, input.by, "check", note ? `의도대로예요: ${note}` : "의도대로예요");
    } else {
      transition(req, "in_progress");
      this.act(req, input.by, "check", note ? `다시 봐 주세요: ${note}` : "다시 봐 주세요");
    }
    this.save(req);
    this.o.requests.bus.emit("ticket_check", req, { verdict: input.verdict, note, by: input.by });
    return this.view(req);
  }

  // ------------------------------------------------------------------------------------------ git

  /** CLI 가 보고한 것. PR 이 있으면 열림, merged 면 병합 */
  gitSync(input: { branch?: string; prUrl?: string; prTitle?: string; merged?: boolean; sha?: string }, by?: string): { key?: string; status?: RequestStatus } {
    const key = findTicketKey({ branch: input.branch, title: input.prTitle });
    if (!key) return {};
    const req = this.find(key);
    if (!req) return { key };
    return this.applyGit(req, { branch: input.branch, prUrl: input.prUrl, opened: !!(input.prUrl || input.prTitle), merged: input.merged === true, sha: input.sha, via: "sync", by });
  }

  /** GitHub 웹훅 pull_request: opened(reopened, ready_for_review), closed + merged */
  gitEvent(event: string | undefined, payload: any): { ok: true; key?: string; status?: RequestStatus } {
    if (event !== "pull_request" || !payload?.pull_request) return { ok: true };
    const pr = payload.pull_request;
    const key = findTicketKey({ branch: pr.head?.ref, title: pr.title, body: pr.body });
    if (!key) return { ok: true };
    const req = this.find(key);
    if (!req) return { ok: true, key };
    const opened = ["opened", "reopened", "ready_for_review"].includes(payload.action);
    const merged = payload.action === "closed" && pr.merged === true;
    if (!opened && !merged) return { ok: true, key, status: req.status };
    const r = this.applyGit(req, { branch: pr.head?.ref, prUrl: pr.html_url, opened, merged, sha: pr.merge_commit_sha ?? pr.head?.sha, via: "webhook" });
    return { ok: true, ...r };
  }

  private applyGit(req: Request, g: { branch?: string; prUrl?: string; opened: boolean; merged: boolean; sha?: string; via: string; by?: string }) {
    if (g.prUrl && /^https?:\/\//i.test(g.prUrl)) req.prUrl = g.prUrl;
    if (!req.branch && g.branch && /^t-\d+-/i.test(g.branch)) req.branch = g.branch;
    const before = req.status;
    if (g.merged) this.toward(req, "merged");
    else if (g.opened) this.toward(req, "code_review");
    this.o.requests.store.appendEvent(req.id, { at: Date.now(), who: g.by, kind: "git", data: { via: g.via, branch: g.branch, prUrl: g.prUrl, sha: g.sha, merged: g.merged, from: before, to: req.status } });
    this.save(req);
    return { key: req.key, status: req.status };
  }

  /** PR 열림, 병합을 상태로. 이미 그 뒤거나 보내기 전이면 그대로 */
  private toward(req: Request, to: "code_review" | "merged") {
    const before: RequestStatus[] = ["open", "assigned", "in_progress", "waiting_requester", "preview", ...(to === "merged" ? (["code_review"] as RequestStatus[]) : [])];
    if (!before.includes(req.status)) return;
    if (req.status === "waiting_requester") transition(req, "in_progress");
    moveTo(req, to);
  }

  // ------------------------------------------------------------------------------------------ pipeline

  /** 다음 일: 열린 질문이 있으면 그대로, 아니면 다음 칸을 묻거나, 보류만 남으면 고객 답 기다림, 다 차면 초안과 검토 */
  private async advance(req: Request) {
    const open = () => req.questions.some((q) => !q.answer);
    if (req.reviewQuestions === undefined) {
      if (open()) return this.moveIntake(req, "clarifying");
      const pending = this.pendingFields(req);
      const todo = REQUIRED.filter((f) => !this.decided(req, f) && !pending.includes(f));
      const asked = req.questions.filter((q) => q.id.startsWith("f-")).length;
      if (todo.length && asked < (this.o.budget ?? 5)) {
        await this.askField(req, todo[0]);
        return this.moveIntake(req, "clarifying");
      }
      // 예산을 다 쓰면 남은 칸은 모름
      for (const f of todo) req.spec!.fields = { ...req.spec!.fields, [f]: { sources: [], confidence: "unknown" } };
      if (pending.length) return this.moveIntake(req, "waiting_customer");
      await this.draft(req);
    }
    this.moveIntake(req, open() ? "clarifying" : "spec_ready");
  }

  private moveIntake(req: Request, to: RequestStatus) {
    if (req.status === to) return;
    if (!moveTo(req, to)) throw new Error(`티켓 상태를 ${req.status} 에서 ${to} 로 바꿀 수 없어요`);
  }

  private decided(req: Request, f: RequiredField): boolean {
    const v = req.spec?.fields?.[f];
    return !!v && v.confidence !== "low";
  }

  /** 고객에게 물으러 간 필수 칸 */
  private pendingFields(req: Request): RequiredField[] {
    return (req.spec?.askCustomer ?? []).filter((a) => a.answer === undefined && isRequired(a.field)).map((a) => a.field as RequiredField);
  }

  private async extract(req: Request) {
    const r = await this.o.ai.structured("extract", ExtractSchema, extractMessages(req.utterances!), this.opts(req));
    this.record(req, r.record);
    if (!r.value) return;
    const us = req.utterances!;
    let spec = req.spec!;
    const fields = { ...spec.fields };
    for (const f of REQUIRED) {
      const slot = r.value[f];
      if (!slot || emptyValue(slot.value)) continue;
      spec = setExtracted(spec, f, slot.value);
      const sources: Source[] = [...new Set(slot.sources)].filter((i) => i < us.length).map((i) => ({ kind: "utterance", index: i, speaker: us[i].speaker }));
      // 근거 없는 칸은 추정: 확신도 low 로 두고 묻는다
      fields[f] = { sources, confidence: sources.length ? slot.confidence : "low" };
    }
    req.spec = { ...spec, fields };
  }

  private async askField(req: Request, f: RequiredField) {
    const r = await this.o.ai.structured("ask", AskSchema, askMessages(req.utterances!, req.spec!, f), this.opts(req));
    this.record(req, r.record);
    const q = r.value ? { question: r.value.question.trim(), choices: r.value.choices.map((c) => c.trim()).filter(Boolean) } : { question: DEFAULT_QUESTION[f], choices: DEFAULT_CHOICES[f] };
    const id = `f-${f}-${req.questions.length + 1}`;
    this.emit(req.id, { event: "delta", data: { text: q.question } });
    req.questions.push({ id, question: q.question, choices: q.choices.length >= 2 ? q.choices.slice(0, 4) : DEFAULT_CHOICES[f], why: FIELD_KO[f] });
  }

  /** 초안 (6) 과 대리 개발자 검토 (7). AI 가 없거나 실패하면 규칙 */
  private async draft(req: Request) {
    this.scan(req);
    const d = await this.o.ai.structured("draft", DraftSchema, draftMessages(req.utterances!, req.spec!), this.opts(req));
    this.record(req, d.record);
    let s = req.spec!;
    if (d.value) {
      const v = d.value;
      const slug = slugOf(v.slug);
      s = {
        ...s, title: v.title.trim(), acceptanceCriteria: v.acceptanceCriteria.map((x) => x.trim()).filter(Boolean), outOfScope: v.outOfScope.map((x) => x.trim()).filter(Boolean),
        summary: { forRequester: v.summary.forRequester.trim(), forDeveloper: v.summary.forDeveloper.trim() }, slug: slug === "ticket" ? undefined : slug,
        needsVisualCheck: v.needsVisualCheck || undefined,
      };
      // AI 가 쓴 칸은 출처가 없다: CS 가 확인해야 보낸다
      s.fields = { ...s.fields, acceptanceCriteria: { sources: [], confidence: "medium" }, ...(s.outOfScope.length ? { outOfScope: { sources: [], confidence: "medium" as const } } : {}) };
      if (v.type) req.type = v.type;
    } else s = ruleDraft(req, s);
    req.spec = s;
    if (s.title) req.title = s.title;

    const rv = await this.o.ai.structured("review", ReviewSchema, reviewMessages(s), this.opts(req));
    this.record(req, rv.record);
    if (rv.value) {
      req.reviewQuestions = rv.value.questions.map((q) => q.trim()).filter(Boolean).slice(0, 3);
      // 대리 검토 질문은 예산과 별개로 2개까지 지금 CS 에게. 자유 답이라 선택지는 없다 (화면이 "기타" 를 붙인다)
      req.reviewQuestions.slice(0, 2).forEach((question, i) => req.questions.push({ id: `r-${i + 1}`, question, choices: [], why: "대리 개발자 검토" }));
    } else {
      // 규칙: 모름으로 둔 칸이 개발자가 처음 물을 것. CS 는 이미 모른다고 했으니 다시 묻지 않는다
      req.reviewQuestions = REQUIRED.filter((f) => req.spec!.fields?.[f]?.confidence === "unknown").map((f) => `${FIELD_KO[f]}: ${DEFAULT_QUESTION[f]}`);
    }
  }

  private fill(req: Request, f: RequiredField, text: string, source: Source, confidence: "high" | "medium" | "low") {
    req.spec = applyAnswer(req.spec!, f, text);
    req.spec.fields = { ...req.spec.fields, [f]: { sources: [source], confidence } };
  }

  /** 인젝션은 고객과 상담원 글 전체에서, 고객 주장은 고객 말에서만 */
  private scan(req: Request) {
    const us = req.utterances ?? [];
    const outside = us.filter((u) => u.speaker !== "cs").map((u) => u.text).join("\n");
    const customer = us.filter((u) => u.speaker === "customer").map((u) => u.text).join("\n");
    req.injectionFlags = detectInjection(outside);
    req.customerClaims = customerClaims(customer);
  }

  /** 고객이 쓴 글 (가린 것): 접수 원문과 나중에 붙인 고객 답 */
  private customerText(req: Request): string {
    const answers = (req.spec?.askCustomer ?? []).filter((a) => a.answer !== undefined).map((a) => `고객 답 (${isRequired(a.field) ? FIELD_KO[a.field] : "추가 질문"}): ${a.answer}`);
    return [req.text, ...answers].join("\n\n");
  }

  /** 나중에 들어온 사람 글도 가린다. 같은 값은 같은 표시, 원래 값은 같은 파일에 더한다 */
  private redactMore(req: Request, text: string): string {
    if (!text) return text;
    const prev = req.redactionsRef ? loadRedactions(req.redactionsRef) : [];
    const r = redact(text, { names: this.o.names, prev });
    const fresh = r.items.filter((it) => !prev.some((p) => p.token === it.token));
    if (fresh.length) {
      saveRedactions(req.id, [...prev, ...fresh]);
      req.redactionsRef = req.id;
    }
    return r.text;
  }

  private async relay(req: Request, kind: RelayKind, text: string, fallback: string): Promise<string> {
    const r = await this.o.ai.text("relay", relayMessages(kind, req.title, text), {
      ...this.opts(req), onDelta: (s) => this.emit(req.id, { event: "delta", data: { text: s } }),
    });
    this.record(req, r.record);
    return r.text?.trim() || fallback;
  }

  private branchName(req: Request): string {
    return `t-${keyNumber(req.key)}-${slugOf(req.spec?.slug)}`;
  }

  private opts(req: Request) {
    return { requestId: req.id, promptVersion };
  }

  /** 실제로 부른 호출만 (AI 가 없으면 provider "none" 이라 남기지 않는다) */
  private record(req: Request, r: LlmRecord) {
    if (r.provider === "none") return;
    req.llm = [...(req.llm ?? []), r];
  }

  private act(req: Request, who: string, what: TicketActionKind, why?: string) {
    const e = { who, when: Date.now(), what, ...(why ? { why } : {}) };
    req.actions = [...(req.actions ?? []), e];
    this.o.requests.store.appendEvent(req.id, { at: e.when, who, kind: what, data: why ? { why } : undefined });
  }

  private save(req: Request) {
    this.o.requests.save(req);
  }

  private emit(id: string, e: TicketStreamEvent) {
    this.bus.emit(`ticket:${id}`, e);
  }

  /** 한 티켓의 일은 하나씩 (AI 호출 사이에 다른 답이 끼지 않게) */
  private locked<T>(req: Request, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(req.id) ?? Promise.resolve();
    const p = prev.then(fn);
    const tail = p.catch(() => undefined);
    this.locks.set(req.id, tail);
    void tail.then(() => {
      if (this.locks.get(req.id) === tail) this.locks.delete(req.id);
    });
    return p;
  }
}

/**
 * 응답에 내보내는 요청. 가린 값 파일 위치(redactionsRef)는 요청 id 로만 내보낸다. 예전에 서버 파일 경로로 저장된 것도
 * 경로를 빼고 id 로 바꾼다
 */
export function publicRequest<T extends Request>(r: T): T {
  return r.redactionsRef === undefined || r.redactionsRef === r.id ? r : { ...r, redactionsRef: r.id };
}

/** 양식 모드 초안: 칸에서 그대로 */
function ruleDraft(req: Request, s: WorkSpec): WorkSpec {
  const title = (s.problem || req.title).split("\n")[0].slice(0, 60);
  const ac = s.expected ? [s.expected] : s.actual ? [`실제 결과가 다시 나오지 않는다: ${s.actual}`] : [];
  const fromField = s.expected ? s.fields?.expected : s.actual ? s.fields?.actual : undefined;
  const dev = [
    s.problem && `증상: ${s.problem}`,
    s.reproSteps?.length && `재현: ${s.reproSteps.join(" → ")}`,
    s.expected && `기대: ${s.expected}`,
    s.actual && `실제: ${s.actual}`,
  ].filter(Boolean).join("\n");
  return {
    ...s, title, acceptanceCriteria: ac, summary: { forRequester: `${title}. 개발팀에 보낼 준비가 됐어요`, forDeveloper: dev },
    fields: { ...s.fields, ...(fromField ? { acceptanceCriteria: { sources: fromField.sources, confidence: fromField.confidence } } : {}) },
  };
}

function attachmentsOf(x: unknown): RequestAttachment[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((a): a is { kind?: unknown; url?: unknown } => !!a && typeof a === "object")
    .map((a) => ({ kind: a.kind === "image" || a.kind === "figma" ? a.kind : "link", url: String(a.url ?? "") }) as RequestAttachment)
    .filter((a) => /^https?:\/\//i.test(a.url))
    .slice(0, 10);
}

