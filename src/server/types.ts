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
  /** existing test files the agent edited, deleted or renamed. A fix that bends its own tests needs a closer look (merge gate) */
  testsTouched?: string[];
  /** new test files (test first). Shown as a neutral chip, never blocks */
  testsAdded?: string[];
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
  /** dev server on a detached worktree of baseRef, for before/after screenshots (B2) */
  basePreview?: Preview;
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
  testsAdded?: string[];
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
  kind?: "ack" | "triage" | "progress" | "result" | "review" | "error" | "request" | "mention" | "check";
  /** emoji → who reacted (user content; the UI itself never writes emoji) */
  reactions?: Record<string, string[]>;
  /** reply in the thread of this root message. A Request's thread root is its card (`req-<id>`) */
  threadId?: string;
  /** a thread reply that was also sent to the channel ("채널에도 보내기") */
  broadcast?: boolean;
}

/** What the channel shows under a thread root: count, last reply, who replied, and enough to count unread and mentions. */
export interface ThreadSummary {
  id: string;
  count: number;
  lastTs: number;
  /** most recent distinct repliers first, at most 3 */
  users: { name: string; avatar?: string; bot?: boolean }[];
  replies: { ts: number; user: string; mentions: string[] }[];
}

// ── bridge: Request (요청자 말 → 되묻기 → 명세 → 제안 → 개발자 확인 → run) ──

/** Two versions of the same message: plain Korean for the requester, technical for the developer. */
export interface Bodies {
  forRequester: string;
  forDeveloper: string;
}

export type RequestStatus =
  | "draft" | "clarifying" | "spec_ready" | "proposed" | "approved" | "building" | "verifying"
  // preview = 요청자 확인 (B2): the requester checks the result on screen before the developer reviews the code
  | "preview" | "code_review" | "merged" | "deployed" | "closed"
  | "declined" | "cancelled"
  // ticket path (docs/design/ticket-plan.md 10절): CS waits on the customer, sends the ticket, a person builds it
  | "waiting_customer" | "open" | "assigned" | "in_progress" | "waiting_requester";

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
  /** the planner thinks the requester should look at the result even though the type is not ui/copy */
  needsVisualCheck?: boolean;
  /** pages to capture before/after (planner fills them, the developer can edit) */
  screens?: Screen[];
  // ticket fields (ticket-plan.md 11절). Typed now, filled from M1
  reproSteps?: string[];
  actual?: string;
  /** what CS already tried */
  alreadyRuledOut?: string[];
  environment?: { browser?: string; os?: string; appVersion?: string; deployedSha?: string };
  impact?: { customers: number; note?: string };
  /** where each field came from and how sure the AI is */
  fields?: Record<string, { sources: Source[]; confidence: "low" | "medium" | "high" | "unknown"; confirmedBy?: string }>;
  /** questions CS has to take to the customer */
  askCustomer?: { field: string; question: string; answer?: string }[];
}

/** Where a ticket field came from. */
export type Source =
  | { kind: "utterance"; index: number; speaker: "customer" | "agent" | "cs" }
  | { kind: "ticket"; key: string }
  | { kind: "doc"; path: string; heading?: string }
  | { kind: "evidence"; adapter: string; ref: string }
  | { kind: "screen"; route: string; shot: string };

/** Something a context adapter attached (a log line, an error event, a screenshot). The shape firms up with F11. */
export interface Evidence {
  adapter: string;
  ref: string;
  summary?: string;
}

/** One model call, for cost and digest tracking. */
export interface LlmRecord {
  task: string;
  provider: string;
  model: string;
  digest: string;
  tokens: number;
  costUsd: number | null;
  ms: number;
  promptVersion: string;
}

/** One page of the app to look at: a name the requester knows and the path on the dev server. */
export interface Screen {
  name: string;
  /** path on the preview server, e.g. "/checkout" */
  path: string;
}

export type ViewportName = "desktop" | "mobile";

/** One screen in one viewport, captured on the base (전) and on the branch (후). URLs are served by the API. */
export interface ShotPair {
  screen: string;
  path: string;
  viewport: ViewportName;
  width: number;
  height: number;
  before?: string;
  after?: string;
  error?: string;
}

/** A box the requester drew on a screenshot. rect is a fraction of the image (0..1) so it does not depend on the display size. */
export interface Feedback {
  screen: string;
  viewport?: ViewportName;
  rect: { x: number; y: number; w: number; h: number };
  note: string;
}

/** One round of 요청자 확인: the result of one attempt, its preview, the screenshot pairs and what the requester said. */
export interface RequesterCheck {
  round: number;
  runId: string;
  agentId: string;
  status: "waiting" | "approved" | "changes" | "skipped";
  startedAt: number;
  /** shareable link to the branch preview (--preview-base-url) */
  previewUrl?: string;
  /** the same for main */
  baseUrl?: string;
  /** the link only opens on the machine running willnew (127.0.0.1 / localhost) */
  localOnly?: boolean;
  capture: "running" | "done" | "skipped";
  shots: ShotPair[];
  /** why something is missing (no preview command, no playwright-core, a page failed) */
  note?: string;
  feedback?: Feedback[];
  by?: string;
  at?: number;
  /** skip: the developer's reason */
  reason?: string;
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
  | "approve_result" | "reject_result"
  | "preview_ok" | "preview_changes" | "preview_skip"
  // an ended request opened again (counted for G3)
  | "reopen";

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
  /** the thread every message about this request lives in (= the card's message id, `req-<id>`) */
  threadId?: string;
  /** 요청자 확인 rounds, oldest first. A new round starts each time a passing result reaches preview */
  checks?: RequesterCheck[];
  planner?: { by: "llm" | "fallback"; note?: string; costUsd?: number | null };
  /** ticket key, "T-42". The store hands out the next number */
  key?: string;
  // ticket fields (ticket-plan.md 11절). Typed now, filled from M1
  category?: "question" | "known" | "new_bug" | "new_request";
  /** people set it, never the AI */
  priority?: "P0" | "P1" | "P2" | "P3";
  duplicateOf?: string;
  /** reports merged into this ticket */
  affected?: { who: string; at: number; ref?: string }[];
  evidence?: Evidence[];
  redactionsRef?: string;
  injectionFlags?: { pattern: string; excerpt: string }[];
  /** instruction-like sentences that only came from the customer's text */
  customerClaims?: string[];
  /** questions the stand-in developer review left */
  reviewQuestions?: string[];
  edits?: { by: string; at: number; field: string; before: string; after: string }[];
  llm?: LlmRecord[];
  branch?: string;
  prUrl?: string;
  external?: { system: "jira" | "linear"; id: string; url: string };
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
