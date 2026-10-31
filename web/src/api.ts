import type {
  AgentEvent,
  AgentRun,
  AgentSpec,
  AgentStatus,
  Channel,
  ChatMessage,
  CheckStatus,
  CreateRunInput,
  FileStat,
  Preflight,
  Preview,
  Review,
  ReviewComment,
  Ship,
  Run,
  RunUpdate,
  Template,
  Triage,
  Bodies,
  ClarifyQuestion,
  DecisionEntry,
  Proposal,
  Request,
  RequestStatus,
  RequestUpdate,
  WorkSpec,
  ThreadSummary,
  RequesterCheck,
  ShotPair,
  Feedback,
  Screen,
} from "../../src/server/types";

export type { Ship, AgentEvent, AgentRun, AgentSpec, AgentStatus, Channel, ChatMessage, CheckStatus, CreateRunInput, FileStat, Preflight, Preview, Review, ReviewComment, Run, RunUpdate, Template, Triage };
export type { Bodies, ClarifyQuestion, DecisionEntry, Proposal, Request, RequestStatus, RequestUpdate, WorkSpec };
export type { ThreadSummary, RequesterCheck, ShotPair, Feedback, Screen };

/** 요청자 확인: 의도대로예요 / 다시 봐 주세요 (boxes) / 건너뛰기 (developer, with a reason) */
export interface RequesterCheckInput {
  verdict: "ok" | "changes" | "skip";
  by: string;
  feedback?: Feedback[];
  note?: string;
  reason?: string;
}

export interface ReplyInput {
  user: string;
  text: string;
  userTitle?: string;
  userAvatar?: string;
  /** 채널에도 보내기 */
  broadcast?: boolean;
}
export type { Member } from "./people";
import { membersFrom, type Member } from "./people";

/** The developer's call on a proposal. text: 고쳐서 진행 → constraint, 거절 → reason, 직접 할게 → note */
export interface DecideInput {
  decision: "proceed" | "proceed_with_changes" | "take_over" | "decline";
  by: string;
  text?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  installed: boolean;
}
export interface Team {
  id: string;
  name: string;
  budgetUsd: number;
}

export interface AdapterMetrics {
  agents: number;
  done: number;
  checkPassed: number;
  passRate: number;
  medianDurationMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgFilesChanged: number;
}
export interface TeamMetrics {
  requests: number;
  autoResolved: number;
  approved: number;
  rejected: number;
  costUsd: number;
  budgetUsd: number;
  medianLeadMs: number | null;
}
export interface TemplateMetrics {
  name: string;
  requests: number;
  autoResolvedRate: number;
  approvalRate: number;
  avgCostUsd: number | null;
  estHoursSaved: number;
}
export interface TimelineRow {
  runId: string;
  createdAt: number;
  adapter: string;
  label: string;
  durationMs: number | null;
  checkStatus: string;
  costUsd: number | null;
  tokens: number;
}
export interface Metrics {
  runs: number;
  totals: {
    requests: number;
    autoResolved: number;
    approved: number;
    rejected: number;
    pendingReview: number;
    estHoursSaved: number;
    costUsd: number;
  };
  byTeam: Record<string, TeamMetrics>;
  byTemplate: Record<string, TemplateMetrics>;
  byAdapter: Record<string, AdapterMetrics>;
  timeline: TimelineRow[];
}

export interface ReviewInput {
  decision: "approve" | "reject";
  agentId?: string;
  reviewer: string;
  comment?: string;
}

export interface PlanOverrides {
  template?: string;
  agents?: AgentSpec[];
  check?: string;
}

export interface ServerConfig {
  repo: string;
  check: string;
  preview: string;
  /** 승인 뒤 반영 방식: 로컬 병합 또는 PR */
  ship?: "merge" | "pr";
  /** 배포 확인 명령이 있는가 */
  deploy?: boolean;
  deployEnv?: string;
  /** --preview-base-url, e.g. http://127.0.0.1:{port} */
  previewBaseUrl?: string;
  /** preview links only open on the machine running willnew */
  previewLocalOnly?: boolean;
  /** team mode: people come from the hub (members.json), not from this browser */
  team?: boolean;
}

/** /api/me in team mode */
export interface TeamMe {
  name: string;
  title: string;
  role: "developer" | "requester";
  avatar?: string;
}

export interface Api {
  config(): Promise<ServerConfig>;
  /** team mode only: who this token belongs to */
  me?(): Promise<TeamMe>;
  agents(): Promise<AgentInfo[]>;
  channels(): Promise<Channel[]>;
  messages(channel: string): Promise<ChatMessage[]>;
  /** direct: a developer's ⌘K 바로 맡기기 (skips the Request). Everything else with @willnew becomes a Request. */
  postMessage(channel: string, user: string, text: string, team?: string, overrides?: PlanOverrides, userTitle?: string, userAvatar?: string, direct?: boolean): Promise<{ message: ChatMessage; requestId?: string }>;
  requests(): Promise<Request[]>;
  request(id: string): Promise<Request>;
  subscribeRequest(id: string, on: (r: Request) => void): () => void;
  answer(id: string, questionId: string, answer: string, by: string): Promise<Request>;
  decide(id: string, input: DecideInput): Promise<Request>;
  /** instant keyword plan for the compose box */
  plan(text: string): Promise<Triage>;
  /** New or replaced chat messages for one channel (same id = replace). Thread replies come through here too (they carry threadId). */
  subscribeChannel(channel: string, onMessage: (m: ChatMessage) => void): () => void;
  /** one summary per thread in the channel (count, last reply, who, mentions) */
  threads(channel: string): Promise<ThreadSummary[]>;
  threadMessages(channel: string, threadId: string): Promise<ChatMessage[]>;
  subscribeThread(channel: string, threadId: string, onMessage: (m: ChatMessage) => void): () => void;
  reply(channel: string, threadId: string, input: ReplyInput): Promise<{ message: ChatMessage }>;
  requesterCheck(id: string, input: RequesterCheckInput): Promise<Request>;
  setScreens(id: string, screens: Screen[], by: string): Promise<Request>;
  /** a stored screenshot URL as this browser loads it (token added) */
  shotUrl(url: string): string;
  /** toggle one reaction (👍 ✅ 👀) on a message; the changed message also arrives through subscribeChannel */
  react(channel: string, messageId: string, emoji: string, user: string): Promise<ChatMessage>;
  /** who is in a channel: message authors, reviewers and the bot (presence only in the demo) */
  members(channel: string): Promise<Member[]>;
  templates(): Promise<Template[]>;
  teams(): Promise<Team[]>;
  runs(): Promise<Run[]>;
  run(id: string): Promise<Run>;
  review(runId: string, input: ReviewInput): Promise<{ ok: boolean; message: string }>;
  cancel(runId: string, agentId: string): Promise<void>;
  remove(runId: string): Promise<void>;
  metrics(): Promise<Metrics>;
  subscribe(runId: string, onUpdate: (u: RunUpdate) => void, onState?: (live: boolean) => void): () => void;
  steer(runId: string, agentId: string, text: string, by: string): Promise<void>;
  preflight(runId: string, agentId: string): Promise<Preflight>;
  setReviewed(runId: string, agentId: string, file: string, reviewed: boolean): Promise<void>;
  addComment(runId: string, c: { agentId: string; file: string; line: number; text: string; by: string }): Promise<ReviewComment>;
  deleteComment(runId: string, commentId: string): Promise<void>;
  sendComments(runId: string, agentId: string, by: string): Promise<void>;
  startPreview(runId: string, agentId: string): Promise<Preview>;
  stopPreview(runId: string, agentId: string): Promise<void>;
  /** websocket url of a shell in the agent's worktree, or null when there is none (demo) */
  terminalUrl(runId: string, agentId: string, cols: number, rows: number): string | null;
  /** where a preview on `port` is reachable from this browser */
  previewUrl(port: number): string;
}

/**
 * `--host 0.0.0.0` prints a link with ?token=…; keep it for this browser and send it with every call.
 * Team mode: an invite link `/?invite=<token>` carries the person token. It is kept the same way and taken out of the address.
 */
const TOKEN_KEY = "willnew.token";
function readToken(): string {
  const q = new URLSearchParams(window.location.search);
  const invite = q.get("invite");
  if (invite) {
    q.delete("invite");
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${q.toString() ? `?${q}` : ""}${window.location.hash}`);
    } catch {
      /* address stays as it is */
    }
  }
  const t = invite || q.get("token");
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    return t ?? localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return t ?? "";
  }
}
const TOKEN = typeof window === "undefined" ? "" : readToken();
/** query token: EventSource, WebSocket and <img> cannot send headers */
export const withToken = (url: string) => (TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : url);
export const get = (url: string, init?: RequestInit) =>
  fetch(url, TOKEN ? { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${TOKEN}` } } : init);

/** Team mode answers 401 with { team: true } when the token is missing or unknown; the app shows the invite screen. */
const unauthorized = new Set<() => void>();
/** tickets/api.ts reads its own error bodies (409 has more than a message) and still tells the app about a 401 */
export const notifyUnauthorized = () => unauthorized.forEach((cb) => cb());
export function onUnauthorized(cb: () => void): () => void {
  unauthorized.add(cb);
  return () => unauthorized.delete(cb);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (res.status === 401 && body?.team) for (const cb of unauthorized) cb();
      if (body?.error) msg = String(body.error);
      else if (body?.message) msg = String(body.message);
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const post = (url: string, body?: unknown, method = "POST") =>
  get(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const enc = encodeURIComponent;

function sse<T>(url: string, on: (v: T) => void, onState?: (live: boolean) => void) {
  const es = new EventSource(withToken(url));
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  es.onmessage = (e) => {
    try {
      on(JSON.parse(e.data) as T);
    } catch {
      /* keep-alive */
    }
  };
  return () => es.close();
}

const A = (id: string, aid: string) => `/api/runs/${enc(id)}/agents/${enc(aid)}`;

export const httpApi: Api = {
  config: () => get("/api/config").then((r) => json<ServerConfig>(r)),
  me: () => get("/api/me").then((r) => json<TeamMe>(r)),
  agents: () => get("/api/agents").then((r) => json<AgentInfo[]>(r)),
  channels: () => get("/api/channels").then((r) => json<Channel[]>(r)),
  messages: (ch) => get(`/api/channels/${enc(ch)}/messages`).then((r) => json<ChatMessage[]>(r)),
  postMessage: (ch, user, text, team, overrides, userTitle, userAvatar, direct) => post(`/api/channels/${enc(ch)}/messages`, { user, text, team, overrides, userTitle, userAvatar, direct }).then((r) => json(r)),
  requests: () => get("/api/requests").then((r) => json<Request[]>(r)),
  request: (id) => get(`/api/requests/${enc(id)}`).then((r) => json<Request>(r)),
  subscribeRequest: (id, on) => sse<RequestUpdate>(`/api/requests/${enc(id)}/stream`, (u) => on(u.request)),
  answer: (id, questionId, answer, by) => post(`/api/requests/${enc(id)}/answer`, { questionId, answer, by }).then((r) => json<Request>(r)),
  decide: (id, input) => post(`/api/requests/${enc(id)}/decide`, input).then((r) => json<Request>(r)),
  plan: (text) => post("/api/plan", { text }).then((r) => json<Triage>(r)),
  subscribeChannel: (ch, on) => sse<ChatMessage>(`/api/channels/${enc(ch)}/stream`, on),
  threads: (ch) => get(`/api/channels/${enc(ch)}/threads`).then((r) => json<ThreadSummary[]>(r)),
  threadMessages: (ch, tid) => get(`/api/channels/${enc(ch)}/threads/${enc(tid)}/messages`).then((r) => json<ChatMessage[]>(r)),
  subscribeThread: (ch, tid, on) => sse<ChatMessage>(`/api/channels/${enc(ch)}/threads/${enc(tid)}/stream`, on),
  reply: (ch, tid, input) => post(`/api/channels/${enc(ch)}/messages`, { ...input, threadId: tid }).then((r) => json(r)),
  requesterCheck: (id, input) => post(`/api/requests/${enc(id)}/requester-check`, input).then((r) => json<Request>(r)),
  setScreens: (id, screens, by) => post(`/api/requests/${enc(id)}/screens`, { screens, by }, "PUT").then((r) => json<Request>(r)),
  shotUrl: (u) => (u.startsWith("/api/") ? withToken(u) : u),
  react: (ch, mid, emoji, user) => post(`/api/channels/${enc(ch)}/messages/${enc(mid)}/react`, { emoji, user }).then((r) => json<ChatMessage>(r)),
  members: async (ch) => {
    const [list, channels] = await Promise.all([httpApi.messages(ch), httpApi.channels()]);
    return membersFrom(list, channels.find((c) => c.id === ch));
  },
  templates: () => get("/api/templates").then((r) => json<Template[]>(r)),
  teams: () => get("/api/teams").then((r) => json<Team[]>(r)),
  runs: () => get("/api/runs").then((r) => json<Run[]>(r)),
  run: (id) => get(`/api/runs/${enc(id)}`).then((r) => json<Run>(r)),
  review: (id, input) => post(`/api/runs/${enc(id)}/review`, input).then((r) => json(r)),
  cancel: (id, aid) => post(`${A(id, aid)}/cancel`).then((r) => json<void>(r)),
  remove: (id) => post(`/api/runs/${enc(id)}`, undefined, "DELETE").then((r) => json<void>(r)),
  metrics: () => get("/api/metrics").then((r) => json<Metrics>(r)),
  subscribe: (id, on, onState) => sse<RunUpdate>(`/api/runs/${enc(id)}/stream`, on, onState),
  steer: (id, aid, text, by) => post(`${A(id, aid)}/steer`, { text, by }).then((r) => json<void>(r)),
  preflight: (id, aid) => get(`${A(id, aid)}/preflight`).then((r) => json<Preflight>(r)),
  setReviewed: (id, aid, file, reviewed) => post(`${A(id, aid)}/reviewed`, { file, reviewed }).then((r) => json<void>(r)),
  addComment: (id, c) => post(`/api/runs/${enc(id)}/comments`, c).then((r) => json<ReviewComment>(r)),
  deleteComment: (id, cid) => post(`/api/runs/${enc(id)}/comments/${enc(cid)}`, undefined, "DELETE").then((r) => json<void>(r)),
  sendComments: (id, aid, by) => post(`${A(id, aid)}/send-comments`, { by }).then((r) => json<void>(r)),
  startPreview: (id, aid) => post(`${A(id, aid)}/preview`).then((r) => json<Preview>(r)),
  stopPreview: (id, aid) => post(`${A(id, aid)}/preview`, undefined, "DELETE").then((r) => json<void>(r)),
  terminalUrl: (id, aid, cols, rows) => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return withToken(`${proto}//${window.location.host}${A(id, aid)}/terminal?cols=${cols}&rows=${rows}`);
  },
  previewUrl: (port) => `${window.location.protocol}//${window.location.hostname}:${port}/`,
};

export const MAX_EVENTS = 400;

/** Merge one streamed update into a run. Returns null when the agent is unknown (caller should refetch). */
export function applyUpdate(run: Run, u: RunUpdate): Run | null {
  if (u.runId !== run.id) return run;
  let next: Run = run;
  if (u.run) {
    next = { ...next, ...u.run, agents: u.run.agents ?? next.agents };
    if (u.run.review) next.review = { ...run.review, ...u.run.review };
  }
  if (!u.agentId) return next;
  const idx = next.agents.findIndex((a) => a.id === u.agentId);
  if (idx < 0) return null;
  const prev = next.agents[idx];
  let a: AgentRun = u.agent ? { ...prev, ...u.agent, events: u.agent.events ?? prev.events } : prev;
  if (u.agent?.usage) a = { ...a, usage: { ...prev.usage, ...u.agent.usage } };
  if (u.agent?.check) a = { ...a, check: { ...prev.check, ...u.agent.check } };
  if (u.agent?.diff) a = { ...a, diff: { ...prev.diff, ...u.agent.diff } };
  if (u.event) {
    const events = [...(a.events ?? []), u.event];
    a = { ...a, events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events };
  }
  const agents = next.agents.slice();
  agents[idx] = a;
  return { ...next, agents };
}

export const isDemo = () => new URLSearchParams(window.location.search).has("demo");
