/**
 * Run manager: one request → N worker agents, each in its own git worktree and branch.
 * Per agent: queued → running (CLI streams JSONL) → checking → (check failed and attempts left →) retrying with the
 * failure output → checking → done | failed | cancelled. When every agent has finished, the run waits for human review.
 *
 * RunManager owns the state (runs, saving, review, line comments, the review queue). Running the agents is the
 * Executor's job (LocalExecutor by default); it reports back through an AgentSink.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ADAPTERS } from "./adapters.js";
import { LocalExecutor, type AgentSink, type Executor } from "./executor.js";
import { repoInfo } from "./git.js";
import { HOME } from "./home.js";
import { Shipper, type ShipOptions } from "./ship.js";
import type { AgentEvent, AgentRun, CreateRunInput, Preflight, Preview, ReviewComment, Run, RunUpdate } from "./types.js";

export { HOME } from "./home.js";
export { runShell, LocalExecutor, type AgentSink, type Executor } from "./executor.js";

const RUNS_DIR = join(HOME, "runs");
const MAX_EVENTS = 500;
const FINISHED = new Set(["done", "failed", "cancelled"]);
/** a preview whose process is still up */
const live = (p?: Preview) => p?.status === "starting" || p?.status === "ready";

const id = (n = 6) => Math.random().toString(36).slice(2, 2 + n);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";

/** Among agents whose check passed: the fastest; within 10 % time, the cheaper one. Results that left the tests alone come first. */
export function suggestWinner(run: Run): AgentRun | undefined {
  const ok = run.agents.filter((a) => a.status === "done" && a.check.status !== "failed" && a.diff.files > 0);
  if (!ok.length) return undefined;
  const clean = ok.filter((a) => !a.diff.testsTouched?.length);
  return (clean.length ? clean : ok).reduce((best, a) => {
    const bt = best.durationMs ?? Infinity, at = a.durationMs ?? Infinity;
    if (Math.abs(at - bt) <= 0.1 * Math.min(at, bt)) return (a.usage.costUsd ?? Infinity) < (best.usage.costUsd ?? Infinity) ? a : best;
    return at < bt ? a : best;
  });
}

export class RunManager {
  readonly bus = new EventEmitter();
  private runs = new Map<string, Run>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  /** agents a human cancelled: later executor patches cannot move them out of "cancelled" (a steer reopens them) */
  private cancelled = new Set<string>();

  readonly shipper: Shipper;
  readonly executor: Executor;

  constructor(private opts: { preview?: string; previewBaseUrl?: string; ship?: ShipOptions; executor?: Executor } = {}) {
    this.shipper = new Shipper(opts.ship ?? { mode: "merge" });
    this.executor = opts.executor ?? new LocalExecutor({ preview: opts.preview });
    mkdirSync(RUNS_DIR, { recursive: true });
    for (const f of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))) {
      try {
        const run: Run = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8"));
        for (const a of run.agents) {   // a server restart interrupts anything still in flight
          if (!FINISHED.has(a.status)) a.status = "cancelled";
          if (a.preview && a.preview.status !== "failed") a.preview = { ...a.preview, status: "stopped" };
        }
        if (run.basePreview && run.basePreview.status !== "failed") run.basePreview = { ...run.basePreview, status: "stopped" };
        this.runs.set(run.id, run);
      } catch { /* skip corrupt file */ }
    }
    this.bus.setMaxListeners(200);
  }

  list(): Run[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  async create(input: CreateRunInput & { repo: string }): Promise<Run> {
    if (!input.task.trim()) throw new Error("요청 내용이 비어 있습니다");
    if (!input.agents.length) throw new Error("에이전트를 하나 이상 고르세요");
    for (const a of input.agents) if (!ADAPTERS[a.adapter]) throw new Error(`unknown agent: ${a.adapter}`);
    const { root, baseRef, baseBranch } = await repoInfo(input.repo);
    const runId = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${id(4)}`;
    const labels = new Map<string, number>();
    const agents: AgentRun[] = input.agents.map((spec) => {
      const base = spec.label?.trim() || (spec.model ? `${ADAPTERS[spec.adapter].name} ${spec.model}` : ADAPTERS[spec.adapter].name);
      const n = (labels.get(base) ?? 0) + 1;
      labels.set(base, n);
      const label = n > 1 ? `${base}-${n}` : base;
      const aid = `${slug(label)}-${id(3)}`;
      return {
        id: aid, adapter: spec.adapter, label, model: spec.model,
        branch: `willnew/${runId}/${aid}`,
        worktree: join(HOME, "worktrees", `${basename(root)}-${runId}`, aid),
        status: "queued", attempt: 1, turns: 0,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null },
        summary: "", check: { status: "skipped", exitCode: null, output: "" },
        diff: { files: 0, insertions: 0, deletions: 0, patch: "" }, merged: false, events: [],
      };
    });
    const run: Run = {
      id: runId, title: input.title?.trim() || input.task.trim().split("\n")[0].slice(0, 60), task: input.task.trim(),
      repo: root, baseRef, baseBranch, checkCmd: input.check?.trim() ?? "", createdAt: Date.now(),
      requester: input.requester ?? "anonymous", requesterTitle: input.requesterTitle, team: input.team ?? "platform", template: input.template ?? "bugfix",
      channel: input.channel, triage: input.triage, review: { status: "none" },
      maxAttempts: input.maxAttempts ?? 2, agents, requestId: input.requestId,
    };
    this.runs.set(runId, run);
    this.save(run, true);
    for (const a of agents) this.executor.start(run, a, this.sink(run, a));
    return run;
  }

  private emit(run: Run, agent: AgentRun | undefined, patch: Partial<AgentRun>, event?: AgentEvent, runPatch?: Partial<Run>) {
    if (agent) Object.assign(agent, patch);
    if (runPatch) Object.assign(run, runPatch);
    if (agent && event) {
      agent.events.push({ ...event, attempt: agent.attempt });
      if (agent.events.length > MAX_EVENTS) agent.events.splice(0, agent.events.length - MAX_EVENTS);
    }
    const update: RunUpdate = { runId: run.id, agentId: agent?.id, event: event && agent ? { ...event, attempt: agent.attempt } : undefined,
      agent: agent && Object.keys(patch).length ? patch : undefined, run: runPatch };
    this.bus.emit(`run:${run.id}`, update);
    this.bus.emit("any", update);
    this.save(run);
  }

  /** What the executor writes one agent's progress into. */
  private sink(run: Run, agent: AgentRun): AgentSink {
    return {
      patch: (p, event) => {
        if (this.cancelled.has(agent.id) && p.status && p.status !== "cancelled") {
          const { status: _s, endedAt: _e, durationMs: _d, ...rest } = p;
          p = rest;
        }
        this.emit(run, agent, p, event);
      },
      finished: () => this.afterAgent(run),
    };
  }

  /** When the last agent finishes, the run goes to human review (if anything is worth merging). */
  private afterAgent(run: Run) {
    if (!run.agents.every((a) => FINISHED.has(a.status))) return;
    const winner = suggestWinner(run);
    this.emit(run, undefined, {}, undefined, { review: winner ? { status: "pending", agentId: winner.id } : { status: "none" } });
    this.bus.emit(`finished:${run.id}`, run);
    this.bus.emit("finished", run);
  }

  cancel(runId: string, agentId: string) {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    const endedAt = Date.now();
    this.emit(run, agent, { status: "cancelled", endedAt, durationMs: agent.startedAt ? endedAt - agent.startedAt : undefined },
      { ts: endedAt, kind: "status", text: "취소됨" });
    this.cancelled.add(agent.id);
    this.executor.cancel(run, agent, this.sink(run, agent));
  }

  /**
   * Hand an instruction to one agent. Working → its current turn stops and the same session continues with it.
   * Checking → it is picked up right after the check. Finished → the agent reopens, works on it, and is re-verified.
   */
  steer(runId: string, agentId: string, text: string, by = "anonymous") {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    const t = text.trim();
    if (!t) throw new Error("지시 내용이 비어 있습니다");
    if (run.review.status === "approved") throw new Error("이미 병합된 요청입니다");
    const at = Date.now();
    this.emit(run, agent, { steers: [...(agent.steers ?? []), { text: t, by, at }] }, { ts: at, kind: "steer", text: `${by}: ${t}` });
    // finished: the agent reopens, so the run is back at work rather than waiting on a human
    if (FINISHED.has(agent.status) && run.review.status === "pending") this.emit(run, undefined, {}, undefined, { review: { status: "none" } });
    if (FINISHED.has(agent.status)) this.cancelled.delete(agent.id);   // reopening a cancelled agent is allowed
    this.executor.steer(run, agent, t, this.sink(run, agent));
  }

  addComment(runId: string, input: { agentId: string; file: string; line: number; text: string; by: string }): ReviewComment {
    const run = this.runs.get(runId);
    if (!run || !run.agents.some((a) => a.id === input.agentId)) throw new Error("not found");
    if (!input.text.trim()) throw new Error("댓글이 비어 있습니다");
    const c: ReviewComment = { id: id(6), agentId: input.agentId, file: input.file, line: Number(input.line) || 0, text: input.text.trim(), by: input.by, at: Date.now() };
    this.emit(run, undefined, {}, undefined, { comments: [...(run.comments ?? []), c] });
    return c;
  }

  deleteComment(runId: string, commentId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("not found");
    this.emit(run, undefined, {}, undefined, { comments: (run.comments ?? []).filter((c) => c.id !== commentId) });
  }

  /** Send every unsent line comment for one agent back to it as a follow-up. */
  sendComments(runId: string, agentId: string, by: string): number {
    const run = this.runs.get(runId);
    if (!run) throw new Error("not found");
    const open = (run.comments ?? []).filter((c) => c.agentId === agentId && !c.sentAt);
    if (!open.length) throw new Error("보낼 댓글이 없습니다");
    const text = `Review comments:\n${open.map((c) => `${c.file}:${c.line} — ${c.text}`).join("\n")}`;
    const now = Date.now();
    this.emit(run, undefined, {}, undefined, { comments: (run.comments ?? []).map((c) => (open.includes(c) ? { ...c, sentAt: now } : c)) });
    this.steer(runId, agentId, text, by);
    return open.length;
  }

  setReviewed(runId: string, agentId: string, file: string, reviewed: boolean) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("not found");
    const cur = new Set(run.reviewed?.[agentId] ?? []);
    if (reviewed) cur.add(file);
    else cur.delete(file);
    this.emit(run, undefined, {}, undefined, { reviewed: { ...(run.reviewed ?? {}), [agentId]: [...cur] } });
  }

  async preflight(runId: string, agentId: string): Promise<Preflight> {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    return {
      checkPassed: agent.check.status === "passed",
      checkSkipped: agent.check.status === "skipped",
      testsTouched: agent.diff.testsTouched ?? [],
      testsAdded: agent.diff.testsAdded ?? [],
      conflicts: agent.merged ? false : await this.executor.conflicts(run, agent),
      files: (agent.diff.fileStats ?? []).map((f) => f.path),
      reviewed: run.reviewed?.[agentId] ?? [],
    };
  }

  get previewCommand() {
    return this.opts.preview ?? "";
  }

  /** `--preview-base-url`: where other people reach a preview. Default http://127.0.0.1:{port} (this machine only). */
  get previewBaseUrl() {
    return this.opts.previewBaseUrl || "http://127.0.0.1:{port}";
  }

  /** The shareable link for a preview port, and whether it only opens on the machine running willnew. */
  previewLink(port: number): { url: string; localOnly: boolean } {
    const url = this.previewBaseUrl.replaceAll("{port}", String(port));
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a URL: treat as local */
    }
    return { url, localOnly: !host || host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" };
  }

  /** Start the configured dev server inside one agent's worktree on a free port. */
  async startPreview(runId: string, agentId: string): Promise<Preview> {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    return this.executor.startPreview(run, agent, this.sink(run, agent));
  }

  stopPreview(runId: string, agentId: string) {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    if (agent.preview) this.emit(run, agent, { preview: { ...agent.preview, status: "stopped" } });
    this.executor.stopPreview(run, agent);
  }

  /** The dev server on the run's base commit, for the "before" screenshots. */
  async startBasePreview(runId: string): Promise<Preview> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("not found");
    return this.executor.startBasePreview(run, (basePreview) => this.emit(run, undefined, {}, undefined, { basePreview }));
  }

  stopBasePreview(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.basePreview) this.emit(run, undefined, {}, undefined, { basePreview: { ...run.basePreview, status: "stopped" } });
    this.executor.stopBasePreview(run);
  }

  async merge(runId: string, agentId: string): Promise<string> {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    if (agent.status !== "done") throw new Error("끝난 에이전트만 반영할 수 있습니다");
    if (!this.executor.merge) throw new Error("이 실행 환경에서는 바로 반영할 수 없어요. PR 로 반영해 주세요");
    const out = await this.executor.merge(run, agent);
    this.emit(run, agent, { merged: true }, { ts: Date.now(), kind: "status", text: `${run.baseBranch}에 반영됨` });
    return out.trim() || "merged";
  }

  /** Human-in-the-loop: approve merges the chosen (or suggested) agent; reject records why. */
  async review(runId: string, input: { decision: "approve" | "reject"; agentId?: string; reviewer: string; comment?: string }) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("not found");
    if (!run.agents.every((a) => FINISHED.has(a.status))) throw new Error("아직 작업 중입니다");
    if (run.review.status === "approved") throw new Error("이미 승인된 요청입니다");
    if (input.decision === "reject" && !input.comment?.trim()) throw new Error("반려 사유를 적어 주세요");
    let message = "반려됨";
    const agentId = input.agentId ?? run.review.agentId ?? suggestWinner(run)?.id;
    const pr = input.decision === "approve" && this.shipper.mode === "pr";
    if (input.decision === "approve") {
      if (!agentId) throw new Error("반영할 결과가 없습니다");
      const a = run.agents.find((x) => x.id === agentId);
      if (a?.status !== "done") throw new Error("끝난 에이전트만 반영할 수 있습니다");
      // pr mode: the decision is recorded now, merge happens through the PR once CI passes
      message = pr ? "승인했어요. PR을 올리고 CI를 기다려요" : await this.merge(runId, agentId);
    }
    if (pr) this.emit(run, undefined, {}, undefined, { ship: { mode: "pr", stage: "pr", env: this.shipper.tracksDeploy ? (this.shipper.opts.deployEnv ?? "production") : undefined, at: Date.now() } });
    this.emit(run, undefined, {}, undefined, { review: { status: input.decision === "approve" ? "approved" : "rejected",
      reviewer: input.reviewer, comment: input.comment, agentId, at: Date.now() } });
    this.bus.emit(`reviewed:${run.id}`, run);
    this.bus.emit("reviewed", run);
    if (pr) {
      const agent = run.agents.find((a) => a.id === agentId)!;
      void this.shipper.run(run, agent, input.reviewer, {
        set: (ship) => this.emit(run, undefined, {}, undefined, { ship }),
        event: (e) => this.bus.emit("ship", run, e),
        merged: () => this.emit(run, agent, { merged: true }, { ts: Date.now(), kind: "status", text: `${run.baseBranch}에 반영됨 (PR 병합)` }),
      }).catch((e: Error) => {
        this.emit(run, undefined, {}, undefined, { ship: { mode: "pr", stage: "ci_failed", checks: [{ name: e.message.slice(0, 80), state: "fail" }], at: Date.now() } });
        this.bus.emit("ship", run, "ci_failed");
      });
    }
    return message;
  }

  async remove(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const a of run.agents) {
      if (this.executor.busy(a)) this.cancel(runId, a.id);
      if (live(a.preview)) this.stopPreview(runId, a.id);
      this.bus.emit("worktree-removed", a.id);
    }
    if (live(run.basePreview)) this.stopBasePreview(runId);
    await this.executor.remove(run);
    this.runs.delete(runId);
    clearTimeout(this.saveTimers.get(runId));
    this.saveTimers.delete(runId);
    for (const a of run.agents) this.cancelled.delete(a.id);
    rmSync(join(RUNS_DIR, `${runId}.json`), { force: true });
  }

  private save(run: Run, now = false) {
    const write = () => {
      this.saveTimers.delete(run.id);
      if (this.runs.get(run.id) !== run) return;   // removed: do not bring the file back
      writeFileSync(join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run));
    };
    if (now) return write();
    if (!this.saveTimers.has(run.id)) this.saveTimers.set(run.id, setTimeout(write, 400));
  }
}
