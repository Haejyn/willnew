import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const LAZY = resolve("tests/fixtures/lazy-agent.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe("cancelling a real local run", () => {
  it("cancel during the check stays cancelled and stops the check process", async () => {
    const m = new RunManager();
    // the check writes late.txt after 2 s unless it is killed first
    const check = `node -e "setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 2000)"`;
    const run = await m.create({ repo, task: "noop", check, agents: [{ adapter: "script", model: LAZY }] });
    const agent = run.agents[0];
    for (let i = 0; i < 100 && agent.status !== "checking"; i++) await sleep(50);
    expect(agent.status).toBe("checking");
    m.cancel(run.id, agent.id);
    await sleep(3000);
    expect(agent.status).toBe("cancelled");
    expect(existsSync(join(agent.worktree, "late.txt"))).toBe(false);
    await m.remove(run.id);
  }, 20_000);

  it("cancel while the worktree is being made does not start the agent", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "noop", agents: [{ adapter: "script", model: LAZY }] });
    const agent = run.agents[0];
    m.cancel(run.id, agent.id);   // addWorktree is still running
    await sleep(2000);
    expect(agent.status).toBe("cancelled");
    expect(agent.events.some((e) => e.text.startsWith("작업 시작"))).toBe(false);
    expect(agent.startedAt).toBeUndefined();
    await m.remove(run.id);
  }, 20_000);
});
