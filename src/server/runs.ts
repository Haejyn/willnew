/**
 * Run manager: one request → N worker agents, each in its own git worktree and branch.
 * Per agent: queued → running (CLI streams JSONL) → checking → (check failed and attempts left →) retrying with the
 * failure output → checking → done | failed | cancelled. When every agent has finished, the run waits for human review.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ADAPTERS } from "./adapters.js";
import { addWorktree, commitAll, diffSummary, mergeBranch, mergeConflicts, removeWorktree, repoInfo } from "./git.js";
import type { AgentEvent, AgentRun, CreateRunInput, Preflight, Preview, ReviewComment, Run, RunUpdate } from "./types.js";

export const HOME = process.env.WILLNEW_HOME ?? join(homedir(), ".willnew");
const RUNS_DIR = join(HOME, "runs");
const MAX_EVENTS = 500;
const CHECK_TIMEOUT_MS = 5 * 60_000;
const FINISHED = new Set(["done", "failed", "cancelled"]);
const PREVIEW_READY_MS = 90_000;

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
  private procs = new Map<string, ChildProcess>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  /** follow-up instructions waiting for the agent's current turn to stop */
  private pending = new Map<string, string[]>();
  private interrupted = new Set<string>();
  private previews = new Map<string, ChildProcess>();

  constructor(private opts: { preview?: string } = {}) {
    mkdirSync(RUNS_DIR, { recursive: true });
    for (const f of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))) {
      try {
        const run: Run = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8"));
        for (const a of run.agents) {   // a server restart interrupts anything still in flight
          if (!FINISHED.has(a.status)) a.status = "cancelled";
          if (a.preview && a.preview.status !== "failed") a.preview = { ...a.preview, status: "stopped" };
        }
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
      requester: input.requester ?? "anonymous", team: input.team ?? "platform", template: input.template ?? "bugfix",
      channel: input.channel, triage: input.triage, review: { status: "none" },
      maxAttempts: input.maxAttempts ?? 2, agents,
    };
    this.runs.set(runId, run);
    this.save(run, true);
    for (const a of agents) void this.start(run, a);
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

  private note(run: Run, agent: AgentRun, kind: AgentEvent["kind"], text: string) {
    this.emit(run, agent, {}, { ts: Date.now(), kind, text });
  }

  private async start(run: Run, agent: AgentRun) {
    try {
      mkdirSync(join(agent.worktree, ".."), { recursive: true });
      await addWorktree(run.repo, agent.worktree, agent.branch, run.baseRef);
    } catch (e) {
      this.emit(run, agent, { status: "failed" }, { ts: Date.now(), kind: "error", text: `worktree: ${(e as Error).message}` });
      this.afterAgent(run);
      return;
    }
    const startedAt = Date.now();
    this.emit(run, agent, { status: "running", startedAt }, { ts: startedAt, kind: "status", text: `작업 시작 · ${agent.worktree}` });
    const early = this.take(agent.id);
    await this.attempt(run, agent, early.length ? `${run.task}\n\nAdditional instructions from the requester:\n${early.map((t) => `- ${t}`).join("\n")}` : run.task);
  }

  private take(agentId: string): string[] {
    const list = this.pending.get(agentId) ?? [];
    this.pending.delete(agentId);
    return list;
  }

  private followUp(run: Run, agent: AgentRun, texts: string[]): { prompt: string; resume: boolean } {
    const ask = texts.map((t) => `- ${t.replace(/\n/g, "\n  ")}`).join("\n");
    const check = run.checkCmd ? ` Make sure \`${run.checkCmd}\` still passes (do not edit or weaken tests unless asked).` : "";
    if (agent.sessionId && ADAPTERS[agent.adapter].resume)
      return { prompt: `Follow-up from the reviewer — apply it in this working tree:\n${ask}\n${check}`, resume: true };
    return { prompt: `${run.task}\n\nYour earlier work is already applied in this working tree. Follow-up from the reviewer:\n${ask}\n${check}`, resume: false };
  }

  /** One pass of the agent CLI, then commit + diff + check; retries once with the failing output. */
  private async attempt(run: Run, agent: AgentRun, prompt: string, resume = false): Promise<void> {
    let exit = await this.runCli(run, agent, prompt, resume);
    // a human sent an instruction mid-turn: the turn was stopped; continue the same session with it
    while (this.pending.get(agent.id)?.length && agent.status !== "cancelled") {
      const f = this.followUp(run, agent, this.take(agent.id));
      this.emit(run, agent, { status: "running" }, { ts: Date.now(), kind: "plan", text: "추가 지시를 반영해 이어서 작업" });
      exit = await this.runCli(run, agent, f.prompt, f.resume);
    }
    if (agent.status === "cancelled") return this.afterAgent(run);
    try {
      await commitAll(agent.worktree, `willnew: ${agent.label} (attempt ${agent.attempt})\n\n${run.title}`);
      this.emit(run, agent, { diff: await diffSummary(agent.worktree, run.baseRef) });
    } catch (e) {
      this.note(run, agent, "error", `diff: ${(e as Error).message}`);
    }
    const endedAt = Date.now();
    if (!exit.ok) {
      this.emit(run, agent, { status: "failed", endedAt, durationMs: endedAt - (agent.startedAt ?? endedAt) },
        { ts: endedAt, kind: "status", text: `종료 코드 ${exit.code}` });
      return this.afterAgent(run);
    }
    if (!run.checkCmd) {
      this.emit(run, agent, { status: "done", endedAt, durationMs: endedAt - (agent.startedAt ?? endedAt) });
      return this.afterAgent(run);
    }
    this.emit(run, agent, { status: "checking" }, { ts: Date.now(), kind: "check", text: `$ ${run.checkCmd}` });
    const t0 = Date.now();
    const res = await runShell(run.checkCmd, agent.worktree, CHECK_TIMEOUT_MS);
    const check = { status: res.code === 0 ? "passed" as const : "failed" as const, exitCode: res.code,
      output: res.output.slice(-6000), durationMs: Date.now() - t0 };
    this.emit(run, agent, { check }, { ts: Date.now(), kind: "check",
      text: `검증 ${check.status === "passed" ? "통과" : "실패"} (exit ${res.code}, ${(check.durationMs / 1000).toFixed(1)} s)` });
    if (this.pending.get(agent.id)?.length && (agent.status as string) !== "cancelled") {   // instruction arrived during the check
      const f = this.followUp(run, agent, this.take(agent.id));
      this.emit(run, agent, { status: "running" }, { ts: Date.now(), kind: "plan", text: "추가 지시를 반영해 이어서 작업" });
      return this.attempt(run, agent, f.prompt, f.resume);
    }

    if (check.status === "failed" && agent.attempt < run.maxAttempts && (agent.status as string) !== "cancelled") {
      // self-correction: hand the verifier's output back to the same agent in the same worktree
      this.emit(run, agent, { status: "retrying", attempt: agent.attempt + 1 },
        { ts: Date.now(), kind: "plan", text: `검증 실패 → 실패 로그를 돌려주고 다시 시도 (${agent.attempt + 1}/${run.maxAttempts})` });
      const retry = `${run.task}\n\nYour previous attempt is already applied in this working tree, but the verification command \`${run.checkCmd}\` failed:\n\n${check.output.slice(-3000)}\n\nFix the remaining problems (do not edit or weaken tests) and make the verification pass.`;
      return this.attempt(run, agent, retry);
    }
    const end = Date.now();
    this.emit(run, agent, { status: "done", endedAt: end, durationMs: end - (agent.startedAt ?? end) });
    this.afterAgent(run);
  }

  private runCli(run: Run, agent: AgentRun, prompt: string, resume = false): Promise<{ ok: boolean; code: number | null }> {
    const adapter = ADAPTERS[agent.adapter];
    if (agent.status === "retrying") this.emit(run, agent, { status: "running" });
    const opts = { model: agent.model, cwd: agent.worktree };
    const { cmd, args } = resume && agent.sessionId && adapter.resume ? adapter.resume(agent.sessionId, prompt, opts) : adapter.command(prompt, opts);
    // no shell: the task text goes to the CLI untouched by cmd.exe / sh quoting
    const child = spawn(cmd, args, { cwd: agent.worktree, windowsHide: true, shell: false, detached: process.platform !== "win32",
      stdio: [adapter.stdinPrompt ? "pipe" : "ignore", "pipe", "pipe"], env: { ...process.env, WILLNEW: "1" } });
    if (adapter.stdinPrompt) child.stdin?.end(prompt);
    this.procs.set(agent.id, child);
    const base = { ...agent.usage }, baseTurns = agent.turns;   // accumulate across attempts
    let buf = "", failed = false, stderr = "";
    const onLine = (line: string) => {
      const p = adapter.parse(line);
      const patch: Partial<AgentRun> = {};
      if (p.usage) {
        const u = { ...agent.usage };
        if (agent.adapter === "codex") {   // codex reports per turn → add up
          u.inputTokens += p.usage.inputTokens ?? 0; u.outputTokens += p.usage.outputTokens ?? 0; u.cachedTokens += p.usage.cachedTokens ?? 0;
        } else {                            // claude reports totals for this invocation → add to earlier attempts
          u.inputTokens = base.inputTokens + (p.usage.inputTokens ?? 0);
          u.outputTokens = base.outputTokens + (p.usage.outputTokens ?? 0);
          u.cachedTokens = base.cachedTokens + (p.usage.cachedTokens ?? 0);
          u.costUsd = p.usage.costUsd == null ? base.costUsd : (base.costUsd ?? 0) + p.usage.costUsd;
        }
        patch.usage = u;
      }
      if (p.turns) patch.turns = agent.adapter === "codex" ? agent.turns + p.turns : baseTurns + p.turns;
      if (p.summary) patch.summary = p.summary;
      if (p.sessionId && p.sessionId !== agent.sessionId) patch.sessionId = p.sessionId;
      if (p.failed) failed = true;
      if (!p.events.length && Object.keys(patch).length) this.emit(run, agent, patch);
      p.events.forEach((e, i) => this.emit(run, agent, i === 0 ? patch : {}, e));
    };
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-4000); });
    return new Promise((resolve) => {
      child.on("error", (e) => this.note(run, agent, "error", `${cmd} 실행 실패: ${e.message}`));
      child.on("close", (code) => {
        if (buf.trim()) onLine(buf);
        this.procs.delete(agent.id);
        const ok = code === 0 && !failed;
        if (this.interrupted.delete(agent.id)) return resolve({ ok, code });   // stopped on purpose for a follow-up
        if (!ok && agent.status !== "cancelled" && stderr.trim())
          this.note(run, agent, "error", stderr.trim().split("\n").slice(-6).join("\n"));
        resolve({ ok, code });
      });
    });
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
    const child = this.procs.get(agentId);
    const endedAt = Date.now();
    this.emit(run, agent, { status: "cancelled", endedAt, durationMs: agent.startedAt ? endedAt - agent.startedAt : undefined },
      { ts: endedAt, kind: "status", text: "취소됨" });
    this.pending.delete(agentId);
    if (child?.pid) killTree(child);
    else this.afterAgent(run);
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
    this.pending.set(agentId, [...(this.pending.get(agentId) ?? []), t]);
    if (agent.status === "running" || agent.status === "retrying") {
      const child = this.procs.get(agentId);
      if (child?.pid) {
        this.interrupted.add(agentId);
        killTree(child);
      }
      return;
    }
    if (agent.status === "queued" || agent.status === "checking") return;
    // finished: reopen in the same worktree
    const f = this.followUp(run, agent, this.take(agentId));
    const startedAt = Date.now() - (agent.durationMs ?? 0);   // keep working time, not idle time
    this.emit(run, agent, { status: "running", startedAt, endedAt: undefined, merged: false },
      { ts: Date.now(), kind: "plan", text: "추가 지시로 다시 작업" }, run.review.status === "pending" ? { review: { status: "none" } } : undefined);
    void this.attempt(run, agent, f.prompt, f.resume);
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
      conflicts: agent.merged ? false : await mergeConflicts(run.repo, agent.branch),
      files: (agent.diff.fileStats ?? []).map((f) => f.path),
      reviewed: run.reviewed?.[agentId] ?? [],
    };
  }

  get previewCommand() {
    return this.opts.preview ?? "";
  }

  /** Start the configured dev server inside one agent's worktree on a free port. */
  async startPreview(runId: string, agentId: string): Promise<Preview> {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    if (!this.opts.preview) throw new Error("미리보기 명령이 없어요 — serve --preview \"npm run dev -- --port {port}\"");
    const live = this.previews.get(agentId);
    if (live && agent.preview && agent.preview.status !== "stopped" && agent.preview.status !== "failed") return agent.preview;
    const port = await freePort();
    const cmd = this.opts.preview.replaceAll("{port}", String(port));
    const preview: Preview = { status: "starting", port, log: `$ ${cmd}\n`, startedAt: Date.now() };
    this.emit(run, agent, { preview }, { ts: Date.now(), kind: "status", text: `미리보기 시작 · :${port}` });
    const child = spawn(cmd, { cwd: agent.worktree, shell: true, windowsHide: true, detached: process.platform !== "win32",
      env: { ...process.env, PORT: String(port), BROWSER: "none" } });
    this.previews.set(agentId, child);
    let log = preview.log;
    const add = (d: Buffer) => {
      log = (log + d.toString("utf8")).slice(-8000);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const patch = (p: Partial<Preview>) => agent.preview && this.emit(run, agent, { preview: { ...agent.preview, ...p, log } });
    child.on("close", (code) => {
      if (this.previews.get(agentId) !== child) return;
      this.previews.delete(agentId);
      patch({ status: agent.preview?.status === "stopped" ? "stopped" : "failed" });
      if (code && agent.preview?.status === "failed") this.note(run, agent, "error", `미리보기 종료 (exit ${code})`);
    });
    const deadline = Date.now() + PREVIEW_READY_MS;
    while (Date.now() < deadline && this.previews.get(agentId) === child) {
      if (await portOpen(port)) {
        patch({ status: "ready" });
        return agent.preview!;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (this.previews.get(agentId) === child) {
      killTree(child);
      patch({ status: "failed" });
    }
    return agent.preview!;
  }

  stopPreview(runId: string, agentId: string) {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    const child = this.previews.get(agentId);
    if (agent.preview) this.emit(run, agent, { preview: { ...agent.preview, status: "stopped" } });
    if (child) killTree(child);
  }

  async merge(runId: string, agentId: string): Promise<string> {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    if (agent.status !== "done") throw new Error("끝난 에이전트만 반영할 수 있습니다");
    const out = await mergeBranch(run.repo, agent.branch, agent.label);
    this.emit(run, agent, { merged: true }, { ts: Date.now(), kind: "status", text: `${run.baseBranch} 에 반영됨` });
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
    if (input.decision === "approve") {
      if (!agentId) throw new Error("반영할 결과가 없습니다");
      message = await this.merge(runId, agentId);
    }
    this.emit(run, undefined, {}, undefined, { review: { status: input.decision === "approve" ? "approved" : "rejected",
      reviewer: input.reviewer, comment: input.comment, agentId, at: Date.now() } });
    this.bus.emit(`reviewed:${run.id}`, run);
    this.bus.emit("reviewed", run);
    return message;
  }

  async remove(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const a of run.agents) {
      if (this.procs.has(a.id)) this.cancel(runId, a.id);
      if (this.previews.has(a.id)) this.stopPreview(runId, a.id);
      this.bus.emit("worktree-removed", a.id);
      await removeWorktree(run.repo, a.worktree, a.branch);
    }
    this.runs.delete(runId);
    rmSync(join(RUNS_DIR, `${runId}.json`), { force: true });
  }

  private save(run: Run, now = false) {
    const write = () => { this.saveTimers.delete(run.id); writeFileSync(join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run)); };
    if (now) return write();
    if (!this.saveTimers.has(run.id)) this.saveTimers.set(run.id, setTimeout(write, 400));
  }
}

export function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: "1" } });
    let output = "";
    const add = (d: Buffer) => { output = (output + d.toString("utf8")).slice(-20000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => { output += `\n[timed out after ${timeoutMs / 1000}s]`; child.kill(); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, output: String(e) }); });
  });
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");   // detached children own a process group
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}
