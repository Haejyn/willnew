import type {
  AgentEvent,
  AgentRun,
  AgentSpec,
  AgentStatus,
  Channel,
  ChatMessage,
  CheckStatus,
  CreateRunInput,
  Review,
  Run,
  RunUpdate,
  Template,
  Triage,
} from "../../src/server/types";

export type { AgentEvent, AgentRun, AgentSpec, AgentStatus, Channel, ChatMessage, CheckStatus, CreateRunInput, Review, Run, RunUpdate, Template, Triage };

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

export interface Api {
  agents(): Promise<AgentInfo[]>;
  channels(): Promise<Channel[]>;
  messages(channel: string): Promise<ChatMessage[]>;
  postMessage(channel: string, user: string, text: string, team?: string): Promise<{ message: ChatMessage; reply?: ChatMessage }>;
  /** New or replaced chat messages for one channel (same id = replace). */
  subscribeChannel(channel: string, onMessage: (m: ChatMessage) => void): () => void;
  templates(): Promise<Template[]>;
  teams(): Promise<Team[]>;
  runs(): Promise<Run[]>;
  run(id: string): Promise<Run>;
  review(runId: string, input: ReviewInput): Promise<{ ok: boolean; message: string }>;
  cancel(runId: string, agentId: string): Promise<void>;
  metrics(): Promise<Metrics>;
  subscribe(runId: string, onUpdate: (u: RunUpdate) => void, onState?: (live: boolean) => void): () => void;
}

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

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const enc = encodeURIComponent;

function sse<T>(url: string, on: (v: T) => void, onState?: (live: boolean) => void) {
  const es = new EventSource(url);
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

export const httpApi: Api = {
  agents: () => fetch("/api/agents").then((r) => json<AgentInfo[]>(r)),
  channels: () => fetch("/api/channels").then((r) => json<Channel[]>(r)),
  messages: (ch) => fetch(`/api/channels/${enc(ch)}/messages`).then((r) => json<ChatMessage[]>(r)),
  postMessage: (ch, user, text, team) => post(`/api/channels/${enc(ch)}/messages`, { user, text, team }).then((r) => json(r)),
  subscribeChannel: (ch, on) => sse<ChatMessage>(`/api/channels/${enc(ch)}/stream`, on),
  templates: () => fetch("/api/templates").then((r) => json<Template[]>(r)),
  teams: () => fetch("/api/teams").then((r) => json<Team[]>(r)),
  runs: () => fetch("/api/runs").then((r) => json<Run[]>(r)),
  run: (id) => fetch(`/api/runs/${enc(id)}`).then((r) => json<Run>(r)),
  review: (id, input) => post(`/api/runs/${enc(id)}/review`, input).then((r) => json(r)),
  cancel: (id, aid) => post(`/api/runs/${enc(id)}/agents/${enc(aid)}/cancel`).then((r) => json<void>(r)),
  metrics: () => fetch("/api/metrics").then((r) => json<Metrics>(r)),
  subscribe: (id, on, onState) => sse<RunUpdate>(`/api/runs/${enc(id)}/stream`, on, onState),
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
