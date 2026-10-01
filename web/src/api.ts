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
  Run,
  RunUpdate,
  Template,
  Triage,
} from "../../src/server/types";

export type { AgentEvent, AgentRun, AgentSpec, AgentStatus, Channel, ChatMessage, CheckStatus, CreateRunInput, FileStat, Preflight, Preview, Review, ReviewComment, Run, RunUpdate, Template, Triage };

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
}

export interface Api {
  config(): Promise<ServerConfig>;
  agents(): Promise<AgentInfo[]>;
  channels(): Promise<Channel[]>;
  messages(channel: string): Promise<ChatMessage[]>;
  postMessage(channel: string, user: string, text: string, team?: string, overrides?: PlanOverrides): Promise<{ message: ChatMessage; reply?: ChatMessage }>;
  /** instant keyword plan for the compose box */
  plan(text: string): Promise<Triage>;
  /** New or replaced chat messages for one channel (same id = replace). */
  subscribeChannel(channel: string, onMessage: (m: ChatMessage) => void): () => void;
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

/** `--host 0.0.0.0` prints a link with ?token=…; keep it for this browser and send it with every call. */
const TOKEN_KEY = "willnew.token";
function readToken(): string {
  try {
    const t = new URLSearchParams(window.location.search).get("token");
    if (t) localStorage.setItem(TOKEN_KEY, t);
    return t ?? localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return new URLSearchParams(window.location.search).get("token") ?? "";
  }
}
const TOKEN = typeof window === "undefined" ? "" : readToken();
const withToken = (url: string) => (TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : url);
const get = (url: string, init?: RequestInit) => fetch(withToken(url), init);

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
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
  agents: () => get("/api/agents").then((r) => json<AgentInfo[]>(r)),
  channels: () => get("/api/channels").then((r) => json<Channel[]>(r)),
  messages: (ch) => get(`/api/channels/${enc(ch)}/messages`).then((r) => json<ChatMessage[]>(r)),
  postMessage: (ch, user, text, team, overrides) => post(`/api/channels/${enc(ch)}/messages`, { user, text, team, overrides }).then((r) => json(r)),
  plan: (text) => post("/api/plan", { text }).then((r) => json<Triage>(r)),
  subscribeChannel: (ch, on) => sse<ChatMessage>(`/api/channels/${enc(ch)}/stream`, on),
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
