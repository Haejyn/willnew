import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Shipper, parseChecks, type CmdResult, type Runner, type ShipEvent } from "../src/server/ship.js";
import type { AgentRun, ChatMessage, Run, Ship } from "../src/server/types.js";

const agent = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: "a1", adapter: "claude-code", label: "claude-sonnet", branch: "willnew/r1/a1", worktree: "w", status: "done", attempt: 1, turns: 1,
  usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0.1 }, summary: "고쳤어요", userNote: "2월은 28일에 결제돼요.",
  check: { status: "passed", exitCode: 0, output: "ℹ pass 7" }, diff: { files: 1, insertions: 1, deletions: 1, patch: "" }, merged: false, events: [], ...over,
});
const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", title: "결제일 수정", task: "t", repo: "/x", baseRef: "abc", baseBranch: "main", checkCmd: "npm test", createdAt: 1, requester: "윤서아",
  team: "cs", template: "bugfix", channel: "cs", review: { status: "approved", agentId: "a1", reviewer: "이해준" }, maxAttempts: 2, agents: [agent()], ...over,
});

const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr = "boom"): CmdResult => ({ code: 1, stdout: "", stderr });
const row = (name: string, bucket: string) => ({ name, state: bucket.toUpperCase(), bucket });

/** A fake gh: `checks` is consumed one poll at a time, the last entry repeats. */
function fakeRunner(opts: { checks: object[][]; deploy?: (n: number) => CmdResult }) {
  const calls: string[] = [];
  let poll = 0;
  let deploys = 0;
  const runner: Runner = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "git") return ok();
    if (file === "gh" && args[0] === "pr" && args[1] === "create") return ok("https://github.com/acme/billing/pull/512\n");
    if (file === "gh" && args[1] === "checks") return ok(JSON.stringify(opts.checks[Math.min(poll++, opts.checks.length - 1)]));
    if (file === "gh" && args[1] === "merge") return ok();
    if (file === "gh" && args[1] === "view") return ok("9f2c1ab\n");
    deploys += 1;
    return opts.deploy ? opts.deploy(deploys) : ok();
  };
  return { runner, calls, deploys: () => deploys };
}

async function go(shipper: Shipper) {
  const states: Ship[] = [];
  const events: ShipEvent[] = [];
  let merged = 0;
  await shipper.run(run(), agent(), "이해준", { set: (s) => states.push(s), event: (e) => events.push(e), merged: () => merged++ });
  return { states, events, merged, last: states.at(-1)! };
}

describe("ship pipeline (fake gh, nothing real is run)", () => {
  it("parses gh check buckets", () => {
    const rows = [row("a", "pass"), row("b", "fail"), row("c", "pending"), row("d", "skipping")];
    expect(parseChecks(JSON.stringify(rows))?.map((c) => c.state)).toEqual(["pass", "fail", "pending", "pass"]);
    expect(parseChecks("not json")).toBeNull();
  });

  it("happy path: PR, CI, squash merge, then deploy tracking with the merge commit", async () => {
    const f = fakeRunner({
      checks: [[row("test", "pending"), row("lint", "pass")], [row("test", "pass"), row("lint", "pass"), row("build", "pass")]],
      deploy: (n) => (n < 3 ? bad() : ok()),
    });
    const sleeps: number[] = [];
    const r = await go(new Shipper({ mode: "pr", deployCheck: "curl -f https://x/version | grep {sha}", deployEnv: "production", runner: f.runner, sleep: async (ms) => void sleeps.push(ms) }));
    expect(r.events).toEqual(["pr", "ci_passed", "merged", "deployed"]);
    expect(r.last).toMatchObject({ mode: "pr", stage: "deployed", prNumber: 512, env: "production", prUrl: "https://github.com/acme/billing/pull/512" });
    expect(r.last.checks).toHaveLength(3);
    expect(r.merged).toBe(1);
    expect(f.calls[0]).toBe("git push origin willnew/r1/a1");
    const create = f.calls.find((c) => c.startsWith("gh pr create"))!;
    expect(create).toContain("--title 결제일 수정");
    expect(create).toContain("요청: 윤서아");
    expect(create).toContain("승인: 이해준");
    expect(create).toContain("검증 통과");
    expect(f.calls).toContain("gh pr merge 512 --squash --delete-branch");
    expect(f.calls.some((c) => c.includes("grep 9f2c1ab"))).toBe(true);
    expect(f.deploys()).toBe(3);
    expect(sleeps.filter((s) => s === 15_000)).toHaveLength(2);
  });

  it("without --deploy-check it stops at the merge", async () => {
    const f = fakeRunner({ checks: [[row("test", "pass")]] });
    const r = await go(new Shipper({ mode: "pr", runner: f.runner, sleep: async () => undefined }));
    expect(r.events).toEqual(["pr", "ci_passed", "merged"]);
    expect(r.last.stage).toBe("merged");
    expect(r.last.env).toBeUndefined();
  });

  it("a failing check stops the pipeline: no merge, no retry", async () => {
    const f = fakeRunner({ checks: [[row("test", "pass"), row("lint", "fail"), row("build", "pending")], [row("test", "pass"), row("lint", "fail"), row("build", "pass")]] });
    const r = await go(new Shipper({ mode: "pr", deployCheck: "true", runner: f.runner, sleep: async () => undefined }));
    expect(r.events).toEqual(["pr", "ci_failed"]);
    expect(r.last.stage).toBe("ci_failed");
    expect(r.last.checks?.filter((c) => c.state === "fail").map((c) => c.name)).toEqual(["lint"]);
    expect(r.merged).toBe(0);
    expect(f.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
    expect(f.calls.filter((c) => c.startsWith("gh pr create"))).toHaveLength(1);
  });

  it("a deploy that never comes up times out as deploy_failed", async () => {
    const f = fakeRunner({ checks: [[row("test", "pass")]], deploy: () => bad() });
    const r = await go(new Shipper({ mode: "pr", deployCheck: "false", deployPollMs: 15_000, deployTimeoutMs: 60_000, runner: f.runner, sleep: async () => undefined }));
    expect(r.events).toEqual(["pr", "ci_passed", "merged", "deploy_failed"]);
    expect(r.last.stage).toBe("deploy_failed");
    expect(r.merged).toBe(1);
    expect(f.deploys()).toBe(5);
  });

  it("a push that fails is reported and nothing else runs", async () => {
    const calls: string[] = [];
    const runner: Runner = async (file, args) => {
      calls.push(`${file} ${args[0]}`);
      return bad("no remote");
    };
    const r = await go(new Shipper({ mode: "pr", runner, sleep: async () => undefined }));
    expect(r.events).toEqual(["ci_failed"]);
    expect(r.last.checks?.[0].name).toBe("git push");
    expect(calls).toEqual(["git push"]);
  });

  it("merge mode is the default and tracks no deploy", () => {
    const s = new Shipper({ mode: "merge", deployCheck: "true" });
    expect(s.mode).toBe("merge");
    expect(s.tracksDeploy).toBe(false);
  });
});

describe("chat lines per stage", () => {
  let Chat: typeof import("../src/server/chat.js").Chat;
  beforeAll(async () => {
    process.env.WILLNEW_HOME = mkdtempSync(join(tmpdir(), "willnew-ship-"));
    ({ Chat } = await import("../src/server/chat.js"));
  });
  const make = (ch = "backend") => {
    const bus = new EventEmitter();
    const chat = new Chat({ bus, create: async () => ({}) } as never, "/x", "npm test", ["이해준"]);
    return { bus, texts: () => chat.list(ch).map((m: ChatMessage) => m.text), last: () => chat.list(ch).at(-1)! };
  };
  const shipped = (over: Partial<Ship>, ch = "backend"): Run => run({ channel: ch, ship: { mode: "pr", stage: "ci", prNumber: 512, at: 1, ...over } });

  it("one short bot line per stage, then the approver answers after the deploy", () => {
    const { bus, texts, last } = make();
    const base = { env: "production", prNumber: 512 };
    bus.emit("ship", shipped({ ...base, stage: "ci" }), "pr");
    bus.emit("ship", shipped({ ...base, checks: [{ name: "test", state: "pass" }, { name: "lint", state: "pass" }, { name: "build", state: "pass" }] }), "ci_passed");
    bus.emit("ship", shipped({ ...base, stage: "merged" }), "merged");
    expect(last().bot).toBe(true); // deploy tracking is on, so no answer yet
    bus.emit("ship", shipped({ ...base, stage: "deployed" }), "deployed");
    expect(texts()).toEqual(["PR #512 올렸어요", "CI 3개 통과", "main에 병합했어요", "production 배포 끝났어요", "@윤서아 배포까지 끝났어요. 2월은 28일에 결제돼요."]);
    expect(last()).toMatchObject({ user: "이해준", bot: false, via: "willnew" });
  });

  it("without deploy tracking the answer comes at the merge, and a failed CI names the checks", () => {
    const { bus, texts, last } = make("data");
    bus.emit("ship", shipped({ stage: "merged" }, "data"), "merged");
    expect(texts()).toEqual(["main에 병합했어요", "@윤서아 반영했어요. 2월은 28일에 결제돼요."]);
    expect(last().via).toBe("willnew");
    bus.emit("ship", shipped({ stage: "ci_failed", checks: [{ name: "lint", state: "fail" }, { name: "test", state: "pass" }] }, "data"), "ci_failed");
    expect(texts().at(-1)).toBe("CI 실패: lint. 자동으로 다시 돌리지 않았어요");
    expect(last().bot).toBe(true);
  });
});
