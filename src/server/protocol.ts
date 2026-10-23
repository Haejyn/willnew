/**
 * Hub ↔ runner protocol (docs/design/hub-runner.md, "프로토콜"). The runner opens a websocket to the hub
 * (`/runner`, `Authorization: Bearer <runner token>`); every message is one JSON object.
 */
import type { Brief, Planned } from "./brief.js";
import type { AgentEvent, AgentRun, ClarifyQuestion, DeclineNote, DiffSummary, Preview, Proposal, RequestAttachment, Run, Screen, ShotPair, SpecFlag, WorkSpec } from "./types.js";
import type { Previews } from "./visual.js";

export const PROTO = 1;
/** diff.patch on the wire is cut here and marked as truncated */
export const MAX_PATCH_BYTES = 1024 * 1024;
/** one artifact (screenshot) per message */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
/** close codes the runner does not retry after */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_PROTO = 4400;
export const CLOSE_REFUSED = 4403;

export type RunnerAuth = "subscription" | "api";
export type Claim = "manual" | "auto";

export interface Hello {
  t: "hello";
  proto: number;
  runnerId: string;
  owner: string;
  version: string;
  auth: RunnerAuth;
  claim: Claim;
  slots: number;
  adapters: { id: string; installed: boolean }[];
  /** remote addresses only, never local paths */
  repos: { remote: string; alias: string }[];
}

/** Run fields a runner may report back (hub keeps the rest). */
export type RunReport = Partial<Pick<Run, "triage" | "task" | "title" | "checkCmd" | "baseRef">>;

export type RunnerMessage =
  | Hello
  | { t: "agent.update"; runId: string; agentId: string; patch?: Partial<AgentRun>; event?: AgentEvent; run?: RunReport }
  | { t: "agent.snapshot"; runId: string; agent: AgentRun }
  | { t: "rpc.result"; id: number; ok: true; value: unknown }
  | { t: "rpc.result"; id: number; ok: false; error: string }
  | { t: "artifact.put"; runId: string; agentId: string; name: string; mime: string; base64: string }
  | { t: "plan.result"; id: number; requestId: string; ok: true; value: unknown }
  | { t: "plan.result"; id: number; requestId: string; ok: false; error: string }
  | { t: "term.data"; sid: string; data: string }
  | { t: "term.exit"; sid: string };

export interface JobAgent {
  id: string;
  adapter: string;
  label: string;
  model?: string;
  branch: string;
  /** instructions that arrived while the run was still waiting in the queue */
  steers?: string[];
}

export interface Job {
  id: string;
  remote: string;
  baseBranch: string;
  title: string;
  text: string;
  check: string;
  agents: JobAgent[];
  maxAttempts: number;
  requester: string;
  requestId?: string;
}

export type RpcMethod =
  | "steer" | "cancel" | "conflicts" | "push" | "remove"
  | "preview.start" | "preview.stop" | "preview.base.start" | "preview.base.stop"
  | "shots.previews" | "shots.capture";

export interface ShotsCaptureParams {
  runId: string;
  agentId: string;
  requestId: string;
  round: number;
  screens: Screen[];
  mobile: boolean;
  before?: string;
  after?: string;
}

/** What each rpc returns. */
export interface RpcResults {
  steer: null;
  cancel: null;
  conflicts: boolean | null;
  push: { branch: string; sha: string };
  remove: null;
  "preview.start": Preview;
  "preview.stop": null;
  "preview.base.start": Preview;
  "preview.base.stop": null;
  "shots.previews": Previews;
  "shots.capture": { shots: ShotPair[]; note?: string };
}

/**
 * Planning before the work starts (되묻기, 명세, 제안, 거절 설명), done by the runner of the developer who claimed the
 * request when the hub has no API key. The runner uses its own clone and its own login.
 */
export type PlanStep = "brief" | "spec" | "proposal" | "decline";

export interface PlanInput {
  requestId: string;
  text: string;
  attachments: RequestAttachment[];
  questions?: ClarifyQuestion[];
  spec?: WorkSpec;
  requester?: string;
  /** decline: the developer's reason and name */
  reason?: string;
  developer?: string;
}

/** What each plan step returns. */
export interface PlanResults {
  brief: Planned<Brief>;
  spec: Planned<WorkSpec>;
  proposal: { proposal: Proposal; needsCheck: SpecFlag[] };
  decline: Planned<DeclineNote>;
}

export type HubMessage =
  | { t: "job.assign"; run: Job }
  | { t: "plan.request"; id: number; requestId: string; step: PlanStep; input: PlanInput }
  | { t: "rpc"; id: number; method: RpcMethod; params: Record<string, unknown> }
  | { t: "term.open"; sid: string; runId: string; agentId: string; cols: number; rows: number }
  | { t: "term.input"; sid: string; data: string }
  | { t: "term.resize"; sid: string; cols: number; rows: number };

const TRUNCATED_NOTE = "\n… (1MB 에서 잘림)";

/** Cut diff.patch at `max` bytes (UTF-8) and mark it. Leaves smaller patches untouched. */
export function capDiff(diff: DiffSummary, max = MAX_PATCH_BYTES): DiffSummary {
  const bytes = Buffer.byteLength(diff.patch, "utf8");
  if (bytes <= max) return diff;
  const cut = Buffer.from(diff.patch, "utf8").subarray(0, max).toString("utf8").replace(/�$/, "");
  return { ...diff, patch: cut + TRUNCATED_NOTE, truncated: true };
}

/**
 * The same repository written different ways → one address: `github.com/org/app`.
 * Accepts https, ssh (`git@host:org/app.git`, `ssh://git@host/org/app`) and plain `host/org/app`; anything else (a
 * local path) is kept with forward slashes and without `.git`.
 */
export function normalizeRemote(url: string): string {
  let s = url.trim().replace(/\\/g, "/");
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(s);
    if (m && !/^file:/i.test(s)) s = `${m[1]}/${m[2]}`;
  }
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  const slash = s.indexOf("/");
  if (slash > 0 && /^[\w.-]+\.[a-z]{2,}(:\d+)?$/i.test(s.slice(0, slash))) s = s.slice(0, slash).toLowerCase() + s.slice(slash);
  return s;
}

/** `github.com/org/app` → `org/app` for `gh --repo`. undefined when the address has no host/owner/name shape. */
export function ghRepoOf(remote: string): string | undefined {
  const m = /^[\w.-]+\.[a-z]{2,}(?::\d+)?\/([^/]+\/[^/]+)$/i.exec(normalizeRemote(remote));
  return m?.[1];
}
