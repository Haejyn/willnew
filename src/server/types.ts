export type AgentStatus = "queued" | "running" | "checking" | "retrying" | "done" | "failed" | "cancelled";
export type CheckStatus = "skipped" | "passed" | "failed";

/** One line of what an agent did, normalised across CLIs. */
export interface AgentEvent {
  ts: number;
  kind: "text" | "tool" | "tool_result" | "status" | "error" | "check" | "plan" | "steer";
  text: string;
  attempt?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null; // null when the CLI does not report cost
}

export interface FileStat {
  path: string;
  insertions: number;
  deletions: number;
}

export interface DiffSummary {
  files: number;
  insertions: number;
  deletions: number;
  patch: string;
  fileStats?: FileStat[];
  /** changed files that look like tests — a fix that edits its own tests needs a closer look */
  testsTouched?: string[];
}

/** A dev server started in one agent's worktree so a human can click through the result. */
export interface Preview {
  status: "starting" | "ready" | "failed" | "stopped";
  port: number;
  log: string;
  startedAt: number;
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
  summary: string; // the agent's final message (without the 요청자에게 line)
  /** plain-language answer for the person who asked, from the agent's `요청자에게:` line */
  userNote?: string;
  check: { status: CheckStatus; exitCode: number | null; output: string; durationMs?: number };
  diff: DiffSummary;
  merged: boolean;
  events: AgentEvent[];
  /** CLI conversation id, so a follow-up instruction continues the same session */
  sessionId?: string;
  /** instructions a human sent while this agent was working or after it finished */
  steers?: { text: string; by: string; at: number }[];
  preview?: Preview;
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

export type ShipStage = "pr" | "ci" | "merged" | "deploying" | "deployed" | "ci_failed" | "deploy_failed";

/** What happens after approval: PR, CI, merge, deploy. Streamed like any other run update. */
export interface Ship {
  mode: "merge" | "pr";
  stage: ShipStage;
  prNumber?: number;
  prUrl?: string;
  checks?: { name: string; state: "pending" | "pass" | "fail" }[];
  /** set only when deploy tracking is on (--deploy-check) */
  env?: string;
  at: number;
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
  /** free label the requester gave themselves ("CS", "PM"), no account behind it */
  requesterTitle?: string;
  requesterAvatar?: string;
  team: string;
  template: string;
  channel?: string;
  triage?: Triage;
  review: Review;
  ship?: Ship;
  maxAttempts: number;
  agents: AgentRun[];
  /** line comments left during review; sending them hands the work back to that agent */
  comments?: ReviewComment[];
  /** files a reviewer has marked as read, per agent */
  reviewed?: Record<string, string[]>;
  /** the Request this run was started for (bridge flow); absent for direct runs */
  requestId?: string;
}

export interface ReviewComment {
  id: string;
  agentId: string;
  file: string;
  line: number;
  text: string;
  by: string;
  at: number;
  sentAt?: number;
}

/** What the reviewer should know before pressing merge. */
export interface Preflight {
  checkPassed: boolean;
  checkSkipped: boolean;
  testsTouched: string[];
  /** null = could not tell (old git, missing branch) */
  conflicts: boolean | null;
  files: string[];
  reviewed: string[];
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
  requesterTitle?: string;
  requesterAvatar?: string;
  team?: string;
  template?: string;
  channel?: string;
  triage?: Triage;
  maxAttempts?: number;
  requestId?: string;
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
  userTitle?: string;    // the sender's self-chosen label, shown as a chip
  userAvatar?: string;   // image URL the sender chose, initials when absent
  /** sent by willnew on behalf of `user` (the approver's answer to the requester) */
  via?: "willnew";
  bot: boolean;
  text: string;
  runId?: string;        // a bot message about a run renders a live run card
  /** a bot message about a Request renders the live request card */
  requestId?: string;
  /** role-specific bodies; the web shows forRequester to requesters and forDeveloper to developers. `text` = forDeveloper */
  bodies?: Bodies;
  kind?: "ack" | "triage" | "progress" | "result" | "review" | "error" | "request" | "mention";
  /** emoji → who reacted (user content; the UI itself never writes emoji) */
  reactions?: Record<string, string[]>;
}

// ── bridge: Request (요청자 말 → 되묻기 → 명세 → 제안 → 개발자 확인 → run) ──

/** Two versions of the same message: plain Korean for the requester, technical for the developer. */
export interface Bodies {
  forRequester: string;
  forDeveloper: string;
}

export type RequestStatus =
  | "draft" | "clarifying" | "spec_ready" | "proposed" | "approved" | "building" | "verifying"
  // B2 inserts "preview" (요청자 확인) between verifying and code_review
  | "code_review" | "merged" | "deployed" | "closed"
  | "declined" | "cancelled";

export type RequestType = "bug" | "ui" | "copy" | "data" | "other";

export interface RequestAttachment {
  kind: "image" | "figma" | "link";
  url: string;
}

/** One clarify question for the requester. `choices` has 2–4 entries; the UI always adds "기타" (free text). */
export interface ClarifyQuestion {
  id: string;
  question: string;
  choices: string[];
  /** what this answer is needed for (developer-facing) */
  why?: string;
  answer?: string;
  answeredBy?: string;
  answeredAt?: number;
}

export interface WorkSpec {
  title: string;
  problem: string;
  expected: string;
  /** measurable: px, colour token, copy text, behaviour */
  acceptanceCriteria: string[];
  outOfScope: string[];
  references: string[];
  /** added by the developer on 고쳐서 진행 */
  constraints: string[];
  summary: Bodies;
  /** after the proposal pass: criteria that name code nobody could find (shown to the developer as 확인 필요) */
  needsCheck?: SpecFlag[];
}

/** One acceptance criterion with the code-like names that are not in the request, the proposal's files or the repo. */
export interface SpecFlag {
  criterion: string;
  names: string[];
}

export interface Proposal {
  /** "이렇게 개발할까요?" in one line */
  summary: string;
  approach: string[];
  files: { path: string; why: string }[];
  risks: string[];
  testsToAdd: string[];
  /** an estimate, not a measurement */
  estimate: { minutes: number; costUsd: number | null };
  confidence: "low" | "medium" | "high";
  by: "agent" | "fallback";
  /** set when the agent pass failed and the fallback was used */
  note?: string;
  costUsd?: number | null;
  durationMs?: number;
}

export type DecisionKind =
  | "answer" | "proceed" | "proceed_with_changes" | "take_over" | "decline" | "cancel" | "close"
  | "approve_result" | "reject_result";

/** Who decided what, when, and why. Every proposal decision lands here. */
export interface DecisionEntry {
  who: string;
  when: number;
  what: DecisionKind;
  why?: string;
}

export interface DeclineNote {
  reason: string;
  /** the planner's explanation for the requester: why, without blaming */
  forRequester: string;
  alternatives: { title: string; effort: string }[];
}

export interface Request {
  id: string;
  channel: string;
  repo: string;
  check: string;
  team: string;
  requester: string;
  requesterTitle?: string;
  requesterAvatar?: string;
  /** the original message, never rewritten */
  text: string;
  attachments: RequestAttachment[];
  status: RequestStatus;
  /** where it was when it was declined or cancelled */
  stoppedFrom?: RequestStatus;
  type?: RequestType;
  title: string;
  /** "이렇게 이해했어요" */
  understood?: Bodies;
  questions: ClarifyQuestion[];
  spec?: WorkSpec;
  proposal?: Proposal;
  decline?: DeclineNote;
  decisions: DecisionEntry[];
  /** the developer asked to confirm the proposal */
  reviewer?: string;
  /** 직접 할게: the developer who took it out of the AI flow */
  assignee?: string;
  runIds: string[];
  planner?: { by: "llm" | "fallback"; note?: string; costUsd?: number | null };
  createdAt: number;
  updatedAt: number;
}

export interface RequestUpdate {
  requestId: string;
  request: Request;
}

export interface Channel {
  id: string;            // e.g. "backend"
  name: string;
  team: string;
  repo: string;
  topic: string;
  /** who is asked to review runs from this channel, in order (first one who is not the requester) */
  reviewers: string[];
  /** sidebar group, e.g. "요청", "개발", "운영" */
  category?: string;
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
