import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const FIX = resolve("tests/fixtures/fix-agent.mjs");
const LAZY = resolve("tests/fixtures/lazy-agent.mjs");
const HALF = resolve("tests/fixtures/halfway-agent.mjs");

let repo = "";
let RunManager: typeof import("../src/server/runs.js").RunManager;
let computeMetrics: typeof import("../src/server/metrics.js").computeMetrics;

beforeAll(async () => {
  process.env.WILLNEW_HOME = mkdtempSync(join(tmpdir(), "willnew-home-"));
  repo = mkdtempSync(join(tmpdir(), "willnew-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "math.js"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(repo, "math.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  writeFileSync(join(repo, "package.json"), '{ "type": "module", "scripts": { "test": "node --test" } }\n');
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  ({ RunManager } = await import("../src/server/runs.js"));
  ({ computeMetrics } = await import("../src/server/metrics.js"));
});

async function waitDone(m: InstanceType<typeof RunManager>, id: string) {
  for (let i = 0; i < 200; i++) {
    const run = m.get(id)!;
    if (run.agents.every((a) => ["done", "failed", "cancelled"].includes(a.status))) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout");
}

describe("a fleet run end to end (offline agents)", () => {
  it("self-corrects: a failed check is fed back and the second attempt passes", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "fix add()", check: "node --test", agents: [{ adapter: "script", model: HALF, label: "halfway" }] });
    const done = await waitDone(m, run.id);
    const a = done.agents[0];
    expect(a.attempt).toBe(2);
    expect(a.check.status).toBe("passed");
    expect(a.events.some((e) => e.kind === "plan" && e.text.includes("다시 시도"))).toBe(true);
    expect(a.usage.costUsd).toBeCloseTo(0.005);   // both attempts counted
    await m.review(run.id, { decision: "reject", reviewer: "lead", comment: "not now" });
    expect(m.get(run.id)!.review).toMatchObject({ status: "rejected", comment: "not now" });
    await m.remove(run.id);
  }, 30_000);

  it("runs agents in separate worktrees, verifies, compares and merges the winner", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "fix add()", check: "node --test",
      agents: [{ adapter: "script", model: FIX, label: "fixer" }, { adapter: "script", model: LAZY, label: "lazy" }] });
    const done = await waitDone(m, run.id);
    const fixer = done.agents.find((a) => a.label === "fixer")!;
    const lazy = done.agents.find((a) => a.label === "lazy")!;

    expect(fixer.status).toBe("done");
    expect(fixer.check.status).toBe("passed");
    expect(fixer.diff).toMatchObject({ files: 1, insertions: 1, deletions: 1 });
    expect(fixer.usage.costUsd).toBeCloseTo(0.004);
    expect(fixer.summary).toContain("Fixed add()");
    expect(lazy.check.status).toBe("failed");
    expect(lazy.diff.files).toBe(0);
    // the base checkout is untouched until we merge
    expect(readFileSync(join(repo, "math.js"), "utf8")).toContain("a - b");

    expect(done.review).toMatchObject({ status: "pending", agentId: fixer.id });   // waits for a human
    await m.review(run.id, { decision: "approve", reviewer: "reviewer" });
    expect(readFileSync(join(repo, "math.js"), "utf8")).toContain("a + b");
    expect(m.get(run.id)!.review).toMatchObject({ status: "approved", reviewer: "reviewer", agentId: fixer.id });

    const metrics = computeMetrics(m.list());
    expect(metrics.byAdapter.script.agents).toBe(2);
    expect(metrics.byAdapter.script.passRate).toBeCloseTo(0.5);

    await m.remove(run.id);
    expect(git(repo, "worktree", "list")).not.toContain(fixer.id);
  }, 30_000);

  it("refuses to merge an agent that has not finished", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "noop", agents: [{ adapter: "script", model: LAZY }] });
    await expect(m.merge(run.id, run.agents[0].id)).rejects.toThrow();
    await waitDone(m, run.id);
    await m.remove(run.id);
  }, 30_000);
});
