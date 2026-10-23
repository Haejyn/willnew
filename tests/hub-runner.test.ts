import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// protocol.ts has no runtime imports; anything that loads home.js is imported after WILLNEW_HOME is set
import { capDiff, ghRepoOf, MAX_PATCH_BYTES, normalizeRemote, PROTO } from "../src/server/protocol.js";
import type { Runner as ShipRunner } from "../src/server/ship.js";
import type { AgentRun, Run } from "../src/server/types.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const NOTE = resolve("tests/fixtures/note-agent.mjs");
const TINY = resolve("tests/fixtures/tiny-server.mjs");
const REMOTE = "github.com/acme/app";
const FINISHED = ["done", "failed", "cancelled"];

async function waitFor<T>(get: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 40));
  }
}

let bare = "";
let clone = "";
let runnerHome = "";
let hubHome = "";
let port = 0;
let server: ReturnType<typeof serve>;
let hubApp: ReturnType<typeof import("../src/server/hub.js").createHub>;
let runner: import("../src/server/runner.js").Runner;
let detectAuth: typeof import("../src/server/runner.js").detectAuth;
let planRunner: typeof import("../src/server/runner.js").planRunner;
const gh: string[] = [];

/** A fake gh: PR 512, CI passes, merge works. Anything else (git) is recorded and would fail the test. */
const fakeGh: ShipRunner = async (file, args) => {
  gh.push([file, ...args].join(" "));
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  if (file === "gh" && args[1] === "create") return ok("https://github.com/acme/app/pull/512\n");
  if (file === "gh" && args[1] === "checks") return ok(JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]));
  if (file === "gh") return ok();
  return { code: 1, stdout: "", stderr: "not expected" };
};

beforeAll(async () => {
  hubHome = mkdtempSync(join(tmpdir(), "willnew-hub-"));
  runnerHome = mkdtempSync(join(tmpdir(), "willnew-runner-"));
  process.env.WILLNEW_HOME = hubHome;
  process.env.WILLNEW_TRIAGE = "rules";
  // origin: a bare repo the runner reaches through `https://github.com/acme/app.git` (insteadOf)
  bare = mkdtempSync(join(tmpdir(), "willnew-origin-")).replace(/\\/g, "/");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "willnew-seed-"));
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "math.js"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(seed, "math.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  writeFileSync(join(seed, "package.json"), '{ "type": "module", "scripts": { "test": "node --test" } }\n');
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  git(seed, "push", "-q", bare, "main");
  clone = mkdtempSync(join(tmpdir(), "willnew-clone-"));
  execFileSync("git", ["clone", "-q", bare, clone]);
  git(clone, "remote", "set-url", "origin", "https://github.com/acme/app.git");
  git(clone, "config", `url.${bare}.insteadOf`, "https://github.com/acme/app.git");

  const { HOME } = await import("../src/server/home.js");
  if (HOME !== hubHome) throw new Error(`home.js was loaded before WILLNEW_HOME was set (${HOME})`);
  const { createHub } = await import("../src/server/hub.js");
  const { hashToken, Members } = await import("../src/server/members.js");
  // people: 이해준 owns runner token tok-1, 한지우 owns tok-2; p-1 is 이해준's person token for the web API
  const membersPath = join(hubHome, "members.json");
  writeFileSync(membersPath, JSON.stringify([
    { name: "이해준", title: "", role: "developer", tokenHash: hashToken("p-1"), runnerTokenHashes: [hashToken("tok-1")] },
    { name: "한지우", title: "", role: "developer", tokenHash: hashToken("p-2"), runnerTokenHashes: [hashToken("tok-2")] },
  ]));
  hubApp = createHub({ remote: REMOTE, check: "node --test", members: Members.load(membersPath),
    ship: { runner: fakeGh, sleep: async () => undefined, ciPollMs: 1 }, graceMs: 400, log: () => undefined });
  server = serve({ fetch: hubApp.app.fetch, port: 0, hostname: "127.0.0.1" });
  hubApp.injectWebSocket(server);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;

  const { Runner } = await import("../src/server/runner.js");
  ({ detectAuth, planRunner } = await import("../src/server/runner.js"));
  runner = new Runner({ auth: "subscription", claim: "manual", slots: 1, adapters: [{ id: "script", installed: true }],
    hub: `ws://127.0.0.1:${port}/runner`, token: "tok-1", repo: clone, home: runnerHome, runnerId: "haejun-pc", owner: "haejun",
    preview: `node "${TINY}"`, backoff: { minMs: 50, maxMs: 200 }, log: () => undefined,
    capturer: async () => ({ capturer: { shot: async (_u, _v, file) => writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex")), close: async () => undefined } }) });
  await runner.start();
  await waitFor(() => hubApp.hub.list().find((r) => r.runnerId === "haejun-pc" && r.connected));
}, 60_000);

afterAll(async () => {
  runner?.stop();
  await new Promise((r) => server?.close(r));
});

const runs = () => hubApp.runs;
const api = (path: string, body?: unknown) =>
  hubApp.app.request(path, body === undefined ? { headers: { authorization: "Bearer p-1" } } : { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer p-1" }, body: JSON.stringify(body) });
const create = (extra: Partial<{ requestId: string; agents: { adapter: string; model?: string; label?: string }[] }> = {}) =>
  runs().create({ repo: REMOTE, task: "fix add()", check: "node --test", agents: extra.agents ?? [{ adapter: "script", model: NOTE, label: "note" }], requester: "한지우", requestId: extra.requestId });
const agentOf = (id: string) => runs().get(id)!.agents[0];
const settled = (id: string) => waitFor(() => { const a = agentOf(id); return FINISHED.includes(a.status) && a; }, 30_000);

describe("hub and runner over loopback (offline agent, fake gh)", () => {
  it("assign → work → check → follow-up → line comment → approve → runner push → PR → merge", async () => {
    const run = await create();
    expect(run.repo).toBe(REMOTE);
    expect(run.agents[0].worktree).toBe("");
    await waitFor(() => agentOf(run.id).events.some((e) => e.text === "맡을 사람 기다리는 중"));
    expect(agentOf(run.id).status).toBe("queued");   // a subscription runner never takes work by itself

    const res = await api(`/api/runs/${run.id}/assign`, { runnerId: "haejun-pc" });
    expect(res.status).toBe(200);
    expect((await api(`/api/runs/${run.id}/assign`, { runnerId: "haejun-pc" })).status).toBe(400);   // first one wins
    let a: AgentRun = await settled(run.id);
    expect(a).toMatchObject({ status: "done", worktree: "runner:haejun-pc", check: { status: "passed" } });
    expect(a.diff.files).toBeGreaterThan(0);
    const r: Run = runs().get(run.id)!;
    expect(r.runnerId).toBe("haejun-pc");
    expect(r.baseRef).toMatch(/^[0-9a-f]{40}$/);
    expect(r.review.status).toBe("pending");
    // no local path of the runner reaches the hub
    const stored = JSON.stringify(r);
    expect(stored).not.toContain(runnerHome);
    expect(stored).not.toContain(runnerHome.replace(/\\/g, "/"));
    expect(stored).not.toContain(clone);
    expect(a.events.some((e) => e.text.includes("runner:haejun-pc"))).toBe(true);

    const list = await (await api("/api/runners")).json();
    expect(list.find((x: { runnerId: string }) => x.runnerId === "haejun-pc")).toMatchObject({ owner: "이해준", connected: true, auth: "subscription", claim: "manual", slots: 1, used: 0, repos: [{ remote: REMOTE }] });

    // follow-up after it finished: the runner reopens the same session
    runs().steer(run.id, a.id, "README 도 고쳐 주세요", "이해준");
    await waitFor(() => agentOf(run.id).status === "running");
    a = await settled(run.id);
    expect(a.summary).toContain("followed up: README 도 고쳐 주세요");
    expect(runs().get(run.id)!.review.status).toBe("pending");

    // a line comment goes back the same way
    runs().addComment(run.id, { agentId: a.id, file: "math.js", line: 1, text: "이름 더 분명하게", by: "이해준" });
    expect(runs().sendComments(run.id, a.id, "이해준")).toBe(1);
    await waitFor(() => agentOf(run.id).status === "running");
    a = await settled(run.id);
    expect(a.summary).toContain("Review comments");
    expect(runs().get(run.id)!.comments?.[0].sentAt).toBeTruthy();

    expect((await runs().preflight(run.id, a.id)).conflicts).toBe(false);
    const msg = await runs().review(run.id, { decision: "approve", reviewer: "이해준" });
    expect(msg).toContain("PR");
    await waitFor(() => runs().get(run.id)!.ship?.stage === "merged");
    expect(agentOf(run.id).merged).toBe(true);
    // the runner pushed the branch to origin; the hub ran gh with --repo, never git
    expect(execFileSync("git", ["--git-dir", bare, "branch", "--list", a.branch], { encoding: "utf8" })).toContain(a.branch);
    expect(gh.every((c) => c.startsWith("gh "))).toBe(true);
    expect(gh.find((c) => c.startsWith("gh pr create"))).toContain(`--head ${a.branch}`);
    expect(gh.find((c) => c.startsWith("gh pr create"))).toMatch(/--repo acme\/app$/);
    expect(gh).toContain("gh pr merge 512 --squash --delete-branch --repo acme/app");

    await runs().remove(run.id);
    expect(existsSync(join(runnerHome, "jobs", `${run.id}.json`))).toBe(false);
    expect(git(clone, "worktree", "list")).not.toContain(a.id);
  }, 90_000);

  it("screenshots: the runner opens both previews, captures, uploads, and the hub serves the PNGs", async () => {
    const run = await create({ requestId: "q-shots" });
    runs().assign(run.id, "haejun-pc");
    const a = await settled(run.id);
    const v = hubApp.hub.visual();
    const pv = await v.previews(runs().get(run.id)!, a.id);
    expect(pv.after?.local).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(pv.before?.local).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const shots = await v.capture({ requestId: "q-shots", round: 1, screens: [{ name: "첫 화면", path: "/" }], mobile: false, before: pv.before?.local, after: pv.after?.local });
    expect(shots.shots).toHaveLength(1);
    expect(shots.shots[0].after).toMatch(/^\/api\/requests\/q-shots\/shots\/1\//);
    const file = v.file("q-shots", "1", "첫-화면-desktop-after.png");
    expect(file).toBeTruthy();
    expect(file!.startsWith(hubHome)).toBe(true);
    expect(readFileSync(file!).toString("hex")).toBe("89504e470d0a1a0a");
    await runs().remove(run.id);
  }, 90_000);

  it("the runner reconnects on its own after the connection drops", async () => {
    (runner as unknown as { ws: WebSocket }).ws.close();
    await waitFor(() => hubApp.hub.list().find((r) => r.runnerId === "haejun-pc" && !r.connected), 5000);
    await waitFor(() => runner.connected && hubApp.hub.list().find((r) => r.runnerId === "haejun-pc" && r.connected), 5000);
  });
});

/** A runner played by the test: raw websocket, every message kept. */
function fake(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/runner`, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  const msgs: any[] = [];
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.addEventListener("close", (e) => r({ code: e.code, reason: e.reason })));
  ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data))));
  const open = new Promise<void>((r) => ws.addEventListener("open", () => r()));
  const send = (m: object) => ws.send(JSON.stringify(m));
  const hello = (over: object = {}) => send({ t: "hello", proto: PROTO, runnerId: "fake", owner: "jiwoo", version: "test", auth: "api", claim: "manual", slots: 2,
    adapters: [{ id: "script", installed: true }], repos: [{ remote: REMOTE, alias: "app" }], ...over });
  return { ws, msgs, closed, open, send, hello };
}

describe("hub failure handling (a fake runner)", () => {
  it("refuses a bad token, another proto, and a subscription runner that wants to claim automatically", async () => {
    expect((await fake("nope").closed).code).toBe(4401);
    const old = fake("tok-2");
    await old.open;
    old.hello({ proto: PROTO + 1, runnerId: "old-pc" });
    expect(await old.closed).toEqual({ code: 4400, reason: "러너 버전이 달라요" });
    expect(hubApp.hub.list().find((r) => r.runnerId === "old-pc")).toMatchObject({ connected: false, problem: "러너 버전이 달라요" });
    const sub = fake("tok-2");
    await sub.open;
    sub.hello({ runnerId: "sub-pc", auth: "subscription", claim: "auto" });
    expect((await sub.closed).code).toBe(4403);
  });

  it("a runner that drops keeps its work for the grace period, then the agent is cancelled", async () => {
    const f = fake("tok-2");
    await f.open;
    f.hello({ runnerId: "drop-pc" });
    await waitFor(() => hubApp.hub.list().find((r) => r.runnerId === "drop-pc" && r.connected));
    const run = await create();
    expect(() => runs().assign(run.id, "nobody")).toThrow("연결");
    runs().assign(run.id, "drop-pc");
    const job = await waitFor(() => f.msgs.find((m) => m.t === "job.assign" && m.run.id === run.id));
    expect(job.run).toMatchObject({ remote: REMOTE, baseBranch: "main", check: "node --test", agents: [{ id: run.agents[0].id, adapter: "script" }] });
    f.send({ t: "agent.update", runId: run.id, agentId: run.agents[0].id, patch: { status: "running", startedAt: Date.now(), worktree: "C:/secret" } });
    await waitFor(() => agentOf(run.id).status === "running");
    expect(agentOf(run.id).worktree).toBe("runner:drop-pc");   // the runner cannot set paths on the hub
    f.ws.close();
    await waitFor(() => agentOf(run.id).events.some((e) => e.text === "러너 연결 끊김"));
    expect(agentOf(run.id).status).toBe("running");
    await waitFor(() => agentOf(run.id).status === "cancelled", 3000);
    expect(agentOf(run.id).events.at(-1)).toMatchObject({ kind: "error", text: "러너 연결이 끊겨 취소됐어요" });
    await runs().remove(run.id);
  });

  it("a runner back within the grace period overwrites the agent with its snapshot", async () => {
    const f = fake("tok-2");
    await f.open;
    f.hello({ runnerId: "flaky-pc" });
    await waitFor(() => hubApp.hub.list().find((r) => r.runnerId === "flaky-pc" && r.connected));
    const run = await create();
    runs().assign(run.id, "flaky-pc");
    await waitFor(() => f.msgs.find((m) => m.t === "job.assign" && m.run.id === run.id));
    const aid = run.agents[0].id;
    f.send({ t: "agent.update", runId: run.id, agentId: aid, patch: { status: "running", startedAt: Date.now() } });
    await waitFor(() => agentOf(run.id).status === "running");
    f.ws.close();
    await waitFor(() => agentOf(run.id).events.some((e) => e.text === "러너 연결 끊김"));

    const back = fake("tok-2");
    await back.open;
    back.hello({ runnerId: "flaky-pc" });
    const snap: Partial<AgentRun> = { ...agentOf(run.id), status: "done", summary: "끊긴 사이에 끝냈어요", check: { status: "passed", exitCode: 0, output: "ok" },
      diff: { files: 1, insertions: 1, deletions: 1, patch: "x".repeat(MAX_PATCH_BYTES + 10) }, events: [{ ts: 1, kind: "text", text: "on the runner" }] };
    back.send({ t: "agent.snapshot", runId: run.id, agent: snap });
    await waitFor(() => agentOf(run.id).status === "done");
    const a = agentOf(run.id);
    expect(a.summary).toBe("끊긴 사이에 끝냈어요");
    expect(a.diff.truncated).toBe(true);
    expect(a.events.map((e) => e.text)).toEqual(["on the runner"]);
    expect(runs().get(run.id)!.review).toMatchObject({ status: "pending", agentId: aid });
    await new Promise((r) => setTimeout(r, 600));   // past the grace period: nothing gets cancelled
    expect(agentOf(run.id).status).toBe("done");
    back.ws.close();
    await runs().remove(run.id);
  });

  it("an auto runner on an API key takes queued work by itself; a runner without the repo is refused", async () => {
    const other = fake("tok-2");
    await other.open;
    other.hello({ runnerId: "other-repo", repos: [{ remote: "github.com/acme/other", alias: "other" }] });
    await waitFor(() => hubApp.hub.list().find((r) => r.runnerId === "other-repo" && r.connected));
    const run = await create();
    expect(() => runs().assign(run.id, "other-repo")).toThrow("저장소");
    const auto = fake("tok-2");
    await auto.open;
    auto.hello({ runnerId: "ci-box", claim: "auto", auth: "api" });
    const job = await waitFor(() => auto.msgs.find((m) => m.t === "job.assign" && m.run.id === run.id));
    expect(job).toBeTruthy();
    expect(runs().get(run.id)!.runnerId).toBe("ci-box");
    expect(other.msgs.some((m) => m.t === "job.assign")).toBe(false);
    other.ws.close();
    auto.ws.close();
  });
});

describe("runner auth, protocol helpers", () => {
  it("only certain usage billing counts as api", () => {
    expect(detectAuth({}).auth).toBe("subscription");
    expect(detectAuth({ ANTHROPIC_API_KEY: "sk-ant" }).auth).toBe("api");
    expect(detectAuth({ CLAUDE_CODE_USE_BEDROCK: "1" }).auth).toBe("api");
    expect(detectAuth({ CLAUDE_CODE_USE_VERTEX: "true" }).auth).toBe("api");
    expect(detectAuth({ CLAUDE_CODE_USE_FOUNDRY: "1" }).auth).toBe("api");
    expect(detectAuth({ CLAUDE_CODE_USE_BEDROCK: "0" }).auth).toBe("subscription");
    expect(detectAuth({ CLAUDE_CODE_OAUTH_TOKEN: "x" }).auth).toBe("subscription");
    expect(detectAuth({ CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_API_KEY: "sk" }).auth).toBe("subscription");
    // with Codex on, both have to be usage billed
    expect(detectAuth({ ANTHROPIC_API_KEY: "sk" }, { codex: true })).toEqual({ auth: "subscription", claude: "api", codex: "subscription" });
    expect(detectAuth({ ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "o" }, { codex: true }).auth).toBe("api");
    expect(detectAuth({ ANTHROPIC_API_KEY: "sk", CODEX_API_KEY: "c" }, { codex: true }).auth).toBe("api");
  });

  it("refuses subscription + auto, defaults slots, leaves Codex out unless allowed", () => {
    const installed = () => true;
    expect(() => planRunner({ env: {}, claim: "auto", installed })).toThrow("--claim auto");
    expect(planRunner({ env: {}, installed })).toMatchObject({ auth: "subscription", claim: "manual", slots: 1 });
    expect(planRunner({ env: { ANTHROPIC_API_KEY: "sk" }, claim: "auto", installed })).toMatchObject({ auth: "api", claim: "auto", slots: 2 });
    expect(planRunner({ env: {}, installed }).adapters.map((a) => a.id)).not.toContain("codex");
    expect(planRunner({ env: {}, allowCodex: true, installed }).adapters.map((a) => a.id)).toContain("codex");
    expect(() => planRunner({ env: {}, claim: "sometimes", installed })).toThrow("--claim");
  });

  it("cuts diff.patch at 1 MB and marks it", () => {
    const small = { files: 1, insertions: 1, deletions: 0, patch: "+a" };
    expect(capDiff(small)).toBe(small);
    const big = capDiff({ ...small, patch: "가".repeat(MAX_PATCH_BYTES) });
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.patch)).toBeLessThan(MAX_PATCH_BYTES + 100);
    expect(big.patch).not.toContain("\uFFFD");
    expect(big.patch.endsWith("(1MB 에서 잘림)")).toBe(true);
  });

  it("matches remotes however they are written", () => {
    for (const u of ["https://github.com/acme/app.git", "git@github.com:acme/app.git", "ssh://git@github.com/acme/app", "github.com/acme/app/", "https://user@GitHub.com/acme/app"])
      expect(normalizeRemote(u)).toBe("github.com/acme/app");
    expect(ghRepoOf("https://github.com/acme/app.git")).toBe("acme/app");
    expect(ghRepoOf("C:\\repos\\app")).toBeUndefined();
  });
});
