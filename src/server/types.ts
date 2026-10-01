export type AgentStatus = "queued" | "running" | "checking" | "retrying" | "done" | "failed" | "cancelled";
export type CheckStatus = "skipped" | "passed" | "failed";

/** One line of what an agent did, normalised across CLIs. */
export interface AgentEvent {
  ts: number;
  kind: "text" | "tool" | "tool_result" | "status" | "error" | "check" | "plan";
  text: string;
  attempt?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null; // null when the CLI does not report cost
}

export interface DiffSummary {
  files: number;
  insertions: number;
  deletions: number;
  patch: string;
}

export interface AgentRun {
  id: string;
  adapter: string;
  label: string;
  model?: string;
  branch: string;
  worktree: string;
  status: AgentStatus;
  attempt: number;          // 1 = first try, 2 = self-correction after a failed check
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  turns: number;
  usage: Usage;
  summary: string; // the agent's final message
  check: { status: CheckStatus; exitCode: number | null; output: string; durationMs?: number };
  diff: DiffSummary;
  merged: boolean;
  events: AgentEvent[];
}

/** What the triage (planner) agent decided for a request. */
export interface Triage {
  by: "llm" | "rules";
  template: string;
  title: string;
  task: string;          // the precise instruction handed to the worker agents
  plan: string[];
  agents: AgentSpec[];
  check: string;
  reason: string;
  durationMs?: number;
  costUsd?: number | null;
}

export interface Review {
  status: "none" | "pending" | "approved" | "rejected";
  reviewer?: string;
  comment?: string;
  agentId?: string;
  at?: number;
}

export interface Run {
  id: string;
  title: string;
  task: string;
  repo: string;
  baseRef: string;
  baseBranch: string;
  checkCmd: string;
  createdAt: number;
  requester: string;
  team: string;
  template: string;
  channel?: string;
  triage?: Triage;
  review: Review;
  maxAttempts: number;
  agents: AgentRun[];
}

export interface AgentSpec {
  adapter: string;
  model?: string;
  label?: string;
}

export interface CreateRunInput {
  repo?: string;
  task: string;
  title?: string;
  agents: AgentSpec[];
  check?: string;
  requester?: string;
  team?: string;
  template?: string;
  channel?: string;
  triage?: Triage;
  maxAttempts?: number;
}

/** Streaming update pushed to the web UI. */
export interface RunUpdate {
  runId: string;
  agentId?: string;
  event?: AgentEvent;
  agent?: Partial<AgentRun>;
  run?: Partial<Run>;
}

// ── chat ──
export interface ChatMessage {
  id: string;
  channel: string;
  ts: number;
  user: string;          // "willnew" for the bot
  bot: boolean;
  text: string;
  runId?: string;        // a bot message about a run renders a live run card
  kind?: "ack" | "triage" | "progress" | "result" | "review" | "error";
}

export interface Channel {
  id: string;            // e.g. "backend"
  name: string;
  team: string;
  repo: string;
  topic: string;
}

export interface Template {
  id: string;
  name: string;          // shown in UI (Korean)
  keywords: string[];
  instruction: string;   // prefix for the worker prompt
  check: string;         // default verification command ("" = use channel default)
  agents: AgentSpec[];
  estMinutes: number;    // [assumption] minutes an engineer would spend by hand — for "time saved"
}
