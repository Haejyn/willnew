/**
 * Executor: the side that actually runs an agent (worktree, CLI, check, self-correction, follow-ups, previews, merge).
 * RunManager keeps the state and hands every result back through an AgentSink, so the same RunManager can later drive
 * agents on another machine (RemoteExecutor, see docs/design/hub-runner.md). LocalExecutor runs them in this process.
 *
 * An executor may read the Run and AgentRun it is given but never writes them: every change goes through the sink.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ADAPTERS } from "./adapters.js";
import { addWorktree, commitAll, diffSummary, git, mergeBranch, mergeConflicts, removeWorktree } from "./git.js";
import { parseUserNote, USER_NOTE_RULE } from "./handoff.js";
import { HOME } from "./home.js";
import type { AgentEvent, AgentRun, Preview, Run } from "./types.js";

/** Where one agent's progress goes. RunManager applies it to the stored run, saves, and broadcasts it. */
export interface AgentSink {
  patch(p: Partial<AgentRun>, event?: AgentEvent): void;
  /** the agent stopped (done, failed or cancelled); the run may now wait for review */
  finished(): void;
}

export interface Executor {
  start(run: Run, agent: AgentRun, sink: AgentSink): void;
  /** Working → the current turn stops and continues with `text`. Checking or queued → picked up next. Finished → reopens. */
  steer(run: Run, agent: AgentRun, text: string, sink: AgentSink): void;
  /** Stops the agent's CLI; when nothing is running, calls `sink.finished()` right away. */
  cancel(run: Run, agent: AgentRun, sink: AgentSink): void;
  /** An agent CLI process is running right now (remove() cancels only those). */
  busy(agent: AgentRun): boolean;
  /** Would the agent's branch conflict with the base? null when git cannot tell. */
  conflicts(run: Run, agent: AgentRun): Promise<boolean | null>;
  /** Merge the agent's branch into the local base branch. Only a local executor can. */
  merge?(run: Run, agent: AgentRun): Promise<string>;
  startPreview(run: Run, agent: AgentRun, sink: AgentSink): Promise<Preview>;
  stopPreview(run: Run, agent: AgentRun): void;
  /** The same dev server on the run's base commit, for "before" screenshots. `set` stores the run's basePreview. */
  startBasePreview(run: Run, set: (p: Preview) => void): Promise<Preview>;
  stopBasePreview(run: Run): void;
  /** Delete the run's worktrees and branches. Processes are stopped by the caller first. */
  remove(run: Run): Promise<void>;
}

const CHECK_TIMEOUT_MS = 5 * 60_000;
const PREVIEW_READY_MS = 90_000;

/** What the worker agent is asked to do: the task plus the rule for the closing line to the requester. */
const taskPrompt = (run: Run) => `${run.task}\n\n${USER_NOTE_RULE}`;

const note = (sink: AgentSink, kind: AgentEvent["kind"], text: string) => sink.patch({}, { ts: Date.now(), kind, text });

/** Runs agents in git worktrees on this machine. Per agent: worktree → CLI → commit + diff → check → (retry) → done. */
export class LocalExecutor implements Executor {
  private procs = new Map<string, ChildProcess>();
  /** follow-up instructions waiting for the agent's current turn to stop */
  private pending = new Map<string, string[]>();
  private interrupted = new Set<string>();
  private previews = new Map<string, ChildProcess>();

  constructor(private opts: { preview?: string } = {}) {}

  start(run: Run, agent: AgentRun, sink: AgentSink) {
    void this.begin(run, agent, sink);
  }

  private async begin(run: Run, agent: AgentRun, sink: AgentSink) {
    try {
      mkdirSync(join(agent.worktree, ".."), { recursive: true });
      await addWorktree(run.repo, agent.worktree, agent.branch, run.baseRef);
    } catch (e) {
      sink.patch({ status: "failed" }, { ts: Date.now(), kind: "error", text: `worktree: ${(e as Error).message}` });
      sink.finished();
      return;
    }
    const startedAt = Date.now();
    sink.patch({ status: "running", startedAt }, { ts: startedAt, kind: "status", text: `작업 시작 · ${agent.worktree}` });
    const early = this.take(agent.id);
    await this.attempt(run, agent, sink, early.length ? `${taskPrompt(run)}\n\nAdditional instructions from the requester:\n${early.map((t) => `- ${t}`).join("\n")}` : taskPrompt(run));
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
    return { prompt: `${taskPrompt(run)}\n\nYour earlier work is already applied in this working tree. Follow-up from the reviewer:\n${ask}\n${check}`, resume: false };
  }

  /** One pass of the agent CLI, then commit + diff + check; retries once with the failing output. */
  private async attempt(run: Run, agent: AgentRun, sink: AgentSink, prompt: string, resume = false): Promise<void> {
    let exit = await this.runCli(agent, sink, prompt, resume);
    // a human sent an instruction mid-turn: the turn was stopped; continue the same session with it
    while (this.pending.get(agent.id)?.length && agent.status !== "cancelled") {
      const f = this.followUp(run, agent, this.take(agent.id));
      sink.patch({ status: "running" }, { ts: Date.now(), kind: "plan", text: "추가 지시를 반영해 이어서 작업" });
      exit = await this.runCli(agent, sink, f.prompt, f.resume);
    }
    if (agent.status === "cancelled") return sink.finished();
    try {
      await commitAll(agent.worktree, `willnew: ${agent.label} (attempt ${agent.attempt})\n\n${run.title}`);
      sink.patch({ diff: await diffSummary(agent.worktree, run.baseRef) });
    } catch (e) {
      note(sink, "error", `diff: ${(e as Error).message}`);
    }
    const endedAt = Date.now();
    if (!exit.ok) {
      sink.patch({ status: "failed", endedAt, durationMs: endedAt - (agent.startedAt ?? endedAt) },
        { ts: endedAt, kind: "status", text: `종료 코드 ${exit.code}` });
      return sink.finished();
    }
    if (!run.checkCmd) {
      sink.patch({ status: "done", endedAt, durationMs: endedAt - (agent.startedAt ?? endedAt) });
      return sink.finished();
    }
    sink.patch({ status: "checking" }, { ts: Date.now(), kind: "check", text: `$ ${run.checkCmd}` });
    const t0 = Date.now();
    const res = await runShell(run.checkCmd, agent.worktree, CHECK_TIMEOUT_MS);
    const check = { status: res.code === 0 ? "passed" as const : "failed" as const, exitCode: res.code,
      output: res.output.slice(-6000), durationMs: Date.now() - t0 };
    sink.patch({ check }, { ts: Date.now(), kind: "check",
      text: `검증 ${check.status === "passed" ? "통과" : "실패"} (exit ${res.code}, ${(check.durationMs / 1000).toFixed(1)} s)` });
    if (this.pending.get(agent.id)?.length && (agent.status as string) !== "cancelled") {   // instruction arrived during the check
      const f = this.followUp(run, agent, this.take(agent.id));
      sink.patch({ status: "running" }, { ts: Date.now(), kind: "plan", text: "추가 지시를 반영해 이어서 작업" });
      return this.attempt(run, agent, sink, f.prompt, f.resume);
    }

    if (check.status === "failed" && agent.attempt < run.maxAttempts && (agent.status as string) !== "cancelled") {
      // self-correction: hand the verifier's output back to the same agent in the same worktree
      sink.patch({ status: "retrying", attempt: agent.attempt + 1 },
        { ts: Date.now(), kind: "plan", text: `검증 실패 → 실패 로그를 돌려주고 다시 시도 (${agent.attempt + 1}/${run.maxAttempts})` });
      const retry = `${taskPrompt(run)}\n\nYour previous attempt is already applied in this working tree, but the verification command \`${run.checkCmd}\` failed:\n\n${check.output.slice(-3000)}\n\nFix the remaining problems (do not edit or weaken tests) and make the verification pass.`;
      return this.attempt(run, agent, sink, retry);
    }
    const end = Date.now();
    sink.patch({ status: "done", endedAt: end, durationMs: end - (agent.startedAt ?? end) });
    sink.finished();
  }

  private runCli(agent: AgentRun, sink: AgentSink, prompt: string, resume = false): Promise<{ ok: boolean; code: number | null }> {
    const adapter = ADAPTERS[agent.adapter];
    if (agent.status === "retrying") sink.patch({ status: "running" });
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
      if (p.summary) {
        const parsed = parseUserNote(p.summary);
        patch.summary = parsed.summary;
        if (parsed.userNote) patch.userNote = parsed.userNote;
      }
      if (p.sessionId && p.sessionId !== agent.sessionId) patch.sessionId = p.sessionId;
      if (p.failed) failed = true;
      if (!p.events.length && Object.keys(patch).length) sink.patch(patch);
      p.events.forEach((e, i) => sink.patch(i === 0 ? patch : {}, e));
    };
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-4000); });
    return new Promise((resolve) => {
      child.on("error", (e) => note(sink, "error", `${cmd} 실행 실패: ${e.message}`));
      child.on("close", (code) => {
        if (buf.trim()) onLine(buf);
        this.procs.delete(agent.id);
        const ok = code === 0 && !failed;
        if (this.interrupted.delete(agent.id)) return resolve({ ok, code });   // stopped on purpose for a follow-up
        if (!ok && agent.status !== "cancelled" && stderr.trim())
          note(sink, "error", stderr.trim().split("\n").slice(-6).join("\n"));
        resolve({ ok, code });
      });
    });
  }

  steer(run: Run, agent: AgentRun, text: string, sink: AgentSink) {
    this.pending.set(agent.id, [...(this.pending.get(agent.id) ?? []), text]);
    if (agent.status === "running" || agent.status === "retrying") {
      const child = this.procs.get(agent.id);
      if (child?.pid) {
        this.interrupted.add(agent.id);
        killTree(child);
      }
      return;
    }
    if (agent.status === "queued" || agent.status === "checking") return;
    // finished: reopen in the same worktree
    const f = this.followUp(run, agent, this.take(agent.id));
    const startedAt = Date.now() - (agent.durationMs ?? 0);   // keep working time, not idle time
    sink.patch({ status: "running", startedAt, endedAt: undefined, merged: false }, { ts: Date.now(), kind: "plan", text: "추가 지시로 다시 작업" });
    void this.attempt(run, agent, sink, f.prompt, f.resume);
  }

  cancel(_run: Run, agent: AgentRun, sink: AgentSink) {
    const child = this.procs.get(agent.id);
    this.pending.delete(agent.id);
    if (child?.pid) killTree(child);
    else sink.finished();
  }

  busy(agent: AgentRun) {
    return this.procs.has(agent.id);
  }

  conflicts(run: Run, agent: AgentRun) {
    return mergeConflicts(run.repo, agent.branch);
  }

  async merge(run: Run, agent: AgentRun) {
    return mergeBranch(run.repo, agent.branch, agent.label);
  }

  /**
   * Start the preview command in `cwd` on a free port and wait until the port answers. `get` and `set` read and write
   * the Preview on whatever owns it (an agent, or the run for the base preview).
   */
  private async launchPreview(key: string, cwd: string, get: () => Preview | undefined, set: (p: Preview) => void, onExit?: (code: number | null) => void): Promise<Preview> {
    if (!this.opts.preview) throw new Error("미리보기 명령이 없어요. serve --preview \"npm run dev -- --port {port}\" 처럼 띄워 주세요");
    const cur = get();
    if (this.previews.get(key) && cur && cur.status !== "stopped" && cur.status !== "failed") return cur;
    const port = await freePort();
    const cmd = this.opts.preview.replaceAll("{port}", String(port));
    set({ status: "starting", port, log: `$ ${cmd}\n`, startedAt: Date.now() });
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32",
      env: { ...process.env, PORT: String(port), BROWSER: "none" } });
    this.previews.set(key, child);
    let log = get()!.log;
    const add = (d: Buffer) => {
      log = (log + d.toString("utf8")).slice(-8000);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const patch = (p: Partial<Preview>) => {
      const now = get();
      if (now) set({ ...now, ...p, log });
    };
    child.on("close", (code) => {
      if (this.previews.get(key) !== child) return;
      this.previews.delete(key);
      patch({ status: get()?.status === "stopped" ? "stopped" : "failed" });
      if (get()?.status === "failed") onExit?.(code);
    });
    const deadline = Date.now() + PREVIEW_READY_MS;
    while (Date.now() < deadline && this.previews.get(key) === child) {
      if (await portOpen(port)) {
        patch({ status: "ready" });
        return get()!;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (this.previews.get(key) === child) {
      killTree(child);
      patch({ status: "failed" });
    }
    return get()!;
  }

  /** Start the configured dev server inside one agent's worktree on a free port. */
  startPreview(_run: Run, agent: AgentRun, sink: AgentSink): Promise<Preview> {
    let first = true;
    return this.launchPreview(agent.id, agent.worktree, () => agent.preview, (preview) => {
      sink.patch({ preview }, first ? { ts: Date.now(), kind: "status", text: `미리보기 시작 · :${preview.port}` } : undefined);
      first = false;
    }, (code) => {
      if (code) note(sink, "error", `미리보기 종료 (exit ${code})`);
    });
  }

  stopPreview(_run: Run, agent: AgentRun) {
    const child = this.previews.get(agent.id);
    if (child) killTree(child);
  }

  /** Where the base worktree for a run's "before" preview lives. */
  private baseWorktree(run: Run) {
    return join(HOME, "worktrees", `${basename(run.repo)}-${run.id}`, "_base");
  }

  /**
   * The same dev server on a detached worktree of the run's base commit (main as it was when the run started), so the
   * "before" screenshots come from the same kind of server as the "after" ones.
   */
  async startBasePreview(run: Run, set: (p: Preview) => void): Promise<Preview> {
    if (!this.opts.preview) throw new Error("미리보기 명령이 없어요");
    const wt = this.baseWorktree(run);
    if (!existsSync(wt)) {
      mkdirSync(join(wt, ".."), { recursive: true });
      await git(run.repo, "worktree", "add", "--detach", wt, run.baseRef);
    }
    return this.launchPreview(`base:${run.id}`, wt, () => run.basePreview, set);
  }

  stopBasePreview(run: Run) {
    const child = this.previews.get(`base:${run.id}`);
    if (child) killTree(child);
  }

  async remove(run: Run) {
    for (const a of run.agents) await removeWorktree(run.repo, a.worktree, a.branch);
    if (existsSync(this.baseWorktree(run))) await git(run.repo, "worktree", "remove", "--force", this.baseWorktree(run)).catch(() => undefined);
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
