import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSink, Executor } from "../src/server/executor.js";
import type { AgentRun, Preview, Run, RunUpdate } from "../src/server/types.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });

let repo = "";
let RunManager: typeof import("../src/server/runs.js").RunManager;

beforeAll(async () => {
  process.env.WILLNEW_HOME = mkdtempSync(join(tmpdir(), "willnew-home-"));
  repo = mkdtempSync(join(tmpdir(), "willnew-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  ({ RunManager } = await import("../src/server/runs.js"));
});

/** Runs nothing: records every call and keeps the sinks so a test can play the agent's side. */
class FakeExecutor implements Executor {
  calls: { method: string; agentId?: string; text?: string }[] = [];
  sinks = new Map<string, AgentSink>();
  running = new Set<string>();
  merge?: (run: Run, agent: AgentRun) => Promise<string>;

  constructor(opts: { merge?: boolean } = {}) {
    if (opts.merge !== false) this.merge = async (_run, agent) => {
      this.calls.push({ method: "merge", agentId: agent.id });
      return "Merge made by the 'ort' strategy.\n";
    };
  }
  start(_run: Run, agent: AgentRun, sink: AgentSink) {
    this.calls.push({ method: "start", agentId: agent.id });
    this.sinks.set(agent.id, sink);
  }
  steer(_run: Run, agent: AgentRun, text: string, sink: AgentSink) {
    this.calls.push({ method: "steer", agentId: agent.id, text });
    this.sinks.set(agent.id, sink);
  }
  cancel(_run: Run, agent: AgentRun, sink: AgentSink) {
    this.calls.push({ method: "cancel", agentId: agent.id });
    this.running.delete(agent.id);
    sink.finished();
  }
  busy(agent: AgentRun) {
    return this.running.has(agent.id);
  }
  async conflicts(_run: Run, agent: AgentRun) {
    this.calls.push({ method: "conflicts", agentId: agent.id });
    return true;
  }
  async startPreview(): Promise<Preview> {
    throw new Error("not used");
  }
  stopPreview() {}
  async startBasePreview(): Promise<Preview> {
    throw new Error("not used");
  }
  stopBasePreview() {}
  async remove(run: Run) {
    this.calls.push({ method: "remove", agentId: run.id });
  }
  /** the agent finishes with a passing change */
  finish(agentId: string) {
    const sink = this.sinks.get(agentId)!;
    sink.patch({ diff: { files: 1, insertions: 1, deletions: 0, patch: "+b" } });
    sink.patch({ status: "done", endedAt: Date.now(), durationMs: 1000 });
    sink.finished();
  }
}

async function setup(opts: { merge?: boolean } = {}) {
  const ex = new FakeExecutor(opts);
  const m = new RunManager({ executor: ex });
  const run = await m.create({ repo, task: "fix it", agents: [{ adapter: "script", model: "x.mjs", label: "one" }] });
  return { ex, m, run, agent: run.agents[0] };
}

describe("RunManager with a fake executor", () => {
  it("starts each agent and applies what the sink reports", async () => {
    const ex = new FakeExecutor();
    const m = new RunManager({ executor: ex });
    const updates: RunUpdate[] = [];
    m.bus.on("any", (u: RunUpdate) => updates.push(u));
    const run = await m.create({ repo, task: "fix it", agents: [{ adapter: "script", model: "x.mjs", label: "one" }, { adapter: "script", model: "y.mjs", label: "two" }] });
    expect(ex.calls.filter((c) => c.method === "start").map((c) => c.agentId)).toEqual(run.agents.map((a) => a.id));

    const [a] = run.agents;
    ex.sinks.get(a.id)!.patch({ status: "running", startedAt: 1 }, { ts: 1, kind: "status", text: "작업 시작" });
    expect(m.get(run.id)!.agents[0]).toMatchObject({ status: "running", startedAt: 1 });
    expect(a.events.at(-1)).toMatchObject({ kind: "status", text: "작업 시작", attempt: 1 });
    expect(updates.at(-1)).toMatchObject({ runId: run.id, agentId: a.id, agent: { status: "running" }, event: { attempt: 1 } });
    await m.remove(run.id);
  });

  it("waits for review only after every agent has finished", async () => {
    const ex = new FakeExecutor();
    const m = new RunManager({ executor: ex });
    const run = await m.create({ repo, task: "fix it", agents: [{ adapter: "script", model: "x.mjs", label: "one" }, { adapter: "script", model: "y.mjs", label: "two" }] });
    const finished: Run[] = [];
    m.bus.on("finished", (r: Run) => finished.push(r));
    const [a, b] = run.agents;
    ex.finish(a.id);
    expect(m.get(run.id)!.review.status).toBe("none");
    expect(finished).toHaveLength(0);
    ex.sinks.get(b.id)!.patch({ status: "failed" });
    ex.sinks.get(b.id)!.finished();
    expect(m.get(run.id)!.review).toEqual({ status: "pending", agentId: a.id });
    expect(finished).toEqual([run]);
    await m.remove(run.id);
  });

  it("records a steer and reopens a finished result for work", async () => {
    const { ex, m, run, agent } = await setup();
    ex.finish(agent.id);
    expect(m.get(run.id)!.review.status).toBe("pending");
    m.steer(run.id, agent.id, "  버튼 색도 바꿔 주세요  ", "한지우");
    expect(agent.steers).toEqual([{ text: "버튼 색도 바꿔 주세요", by: "한지우", at: expect.any(Number) }]);
    expect(agent.events.at(-1)).toMatchObject({ kind: "steer", text: "한지우: 버튼 색도 바꿔 주세요" });
    expect(m.get(run.id)!.review.status).toBe("none");
    expect(ex.calls.at(-1)).toEqual({ method: "steer", agentId: agent.id, text: "버튼 색도 바꿔 주세요" });
    expect(() => m.steer(run.id, agent.id, "   ")).toThrow("비어");
    await m.remove(run.id);
  });

  it("leaves the review alone when the agent is still working", async () => {
    const { ex, m, run, agent } = await setup();
    ex.sinks.get(agent.id)!.patch({ status: "running" });
    m.steer(run.id, agent.id, "하나 더", "lead");
    expect(m.get(run.id)!.review.status).toBe("none");
    expect(ex.calls.filter((c) => c.method === "steer")).toHaveLength(1);
    await m.remove(run.id);
  });

  it("cancel marks the agent cancelled and the executor reports it finished", async () => {
    const { ex, m, run, agent } = await setup();
    ex.sinks.get(agent.id)!.patch({ status: "running", startedAt: Date.now() - 500 });
    m.cancel(run.id, agent.id);
    expect(agent.status).toBe("cancelled");
    expect(agent.durationMs).toBeGreaterThanOrEqual(0);
    expect(agent.events.at(-1)).toMatchObject({ kind: "status", text: "취소됨" });
    expect(ex.calls.at(-1)).toEqual({ method: "cancel", agentId: agent.id });
    expect(m.get(run.id)!.review.status).toBe("none");   // nothing to merge
    await m.remove(run.id);
  });

  it("approval merges through the executor", async () => {
    const { ex, m, run, agent } = await setup();
    await expect(m.review(run.id, { decision: "approve", reviewer: "lead" })).rejects.toThrow("작업 중");
    ex.finish(agent.id);
    expect((await m.preflight(run.id, agent.id)).conflicts).toBe(true);
    const message = await m.review(run.id, { decision: "approve", reviewer: "lead" });
    expect(message).toBe("Merge made by the 'ort' strategy.");
    expect(ex.calls.filter((c) => c.method === "merge")).toEqual([{ method: "merge", agentId: agent.id }]);
    expect(agent.merged).toBe(true);
    expect(m.get(run.id)!.review).toMatchObject({ status: "approved", reviewer: "lead", agentId: agent.id });
    expect(await m.preflight(run.id, agent.id)).toMatchObject({ conflicts: false });   // merged: no need to ask
    expect(() => m.steer(run.id, agent.id, "more")).toThrow("병합");
    await m.remove(run.id);
  });

  it("refuses a direct merge when the executor cannot merge", async () => {
    const { ex, m, run, agent } = await setup({ merge: false });
    ex.finish(agent.id);
    await expect(m.review(run.id, { decision: "approve", reviewer: "lead" })).rejects.toThrow("PR");
    expect(m.get(run.id)!.review.status).toBe("pending");
    await m.remove(run.id);
  });

  it("remove cancels running agents, then hands the worktrees to the executor", async () => {
    const { ex, m, run, agent } = await setup();
    ex.running.add(agent.id);
    const removed: string[] = [];
    m.bus.on("worktree-removed", (id: string) => removed.push(id));
    await m.remove(run.id);
    expect(ex.calls.map((c) => c.method)).toEqual(["start", "cancel", "remove"]);
    expect(removed).toEqual([agent.id]);
    expect(m.get(run.id)).toBeUndefined();
  });
});
