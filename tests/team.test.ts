/**
 * Team mode end to end on one PC: a hub (members.json, a fake Slack, a fake gh) and a real runner process object on a
 * personal subscription, over loopback, with an offline agent and a fake planner. Then the permission refusals.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SlackClient } from "../src/server/slack/client.js";
import type { SlackApp } from "../src/server/slack/index.js";
import type { Runner as ShipRunner } from "../src/server/ship.js";
import type { Request, Run } from "../src/server/types.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const NOTE = resolve("tests/fixtures/note-agent.mjs");
const LAZY = resolve("tests/fixtures/lazy-agent.mjs");
const TINY = resolve("tests/fixtures/tiny-server.mjs");
const REMOTE = "github.com/acme/app";
const J = (v: unknown) => JSON.stringify(v);
const T = { hj: "p-hj", sy: "p-sy", jw: "p-jw" };

const BRIEF = {
  type: "ui", title: "결제 버튼 여백",
  understood: { forRequester: "결제 화면 버튼 안쪽 여백을 늘리고 싶으신 거죠.", forDeveloper: "Checkout 버튼 padding 확대" },
  questions: [{ question: "버튼 안쪽 여백", choices: ["12px", "16px"], why: "padding 값" }],
};
const SPEC = {
  title: "결제 버튼 여백 16px", problem: "결제 버튼이 답답해 보인다", expected: "버튼 안쪽 여백 16px",
  acceptanceCriteria: ["결제 버튼 padding-inline 16px"], outOfScope: [], references: [],
  summary: { forRequester: "결제 버튼 안쪽 여백이 넉넉해져요.", forDeveloper: "Checkout 버튼 padding-inline 16px" },
  screens: [{ name: "결제", path: "/" }],
};
const PROPOSAL = {
  summary: "math.js 를 고칠까요?", approach: ["math.js 를 고친다"], files: [{ path: "math.js", why: "여기" }], risks: [],
  testsToAdd: ["padding 16px"], estimate: { minutes: 3, costUsd: 0.05 }, confidence: "medium",
};

async function waitFor<T>(get: () => T | undefined | false | null, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 40));
  }
}

type Call = { m: "post" | "update" | "ephemeral" | "modal" | "upload"; a: any; ts?: string };
const textOf = (c: Call) => JSON.stringify(c.a.blocks ?? []) + (c.a.text ?? "");
const buttonsOf = (c: Call): { action_id: string; value?: string }[] => (c.a.blocks ?? []).filter((b: any) => b.type === "actions").flatMap((b: any) => b.elements);

let hubHome = "";
let runnerHome = "";
let bare = "";
let clone = "";
let server: ReturnType<typeof serve>;
let hub: ReturnType<typeof import("../src/server/hub.js").createHub>;
let runner: import("../src/server/runner.js").Runner;
let bridge: import("../src/server/slack/bridge.js").SlackBridge;
const gh: string[] = [];
const calls: Call[] = [];
const h: { event: Record<string, (a: any) => Promise<void>>; action?: (a: any) => Promise<void>; view?: (a: any) => Promise<void> } = { event: {} };

const fakeGh: ShipRunner = async (file, args) => {
  gh.push([file, ...args].join(" "));
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  if (file === "gh" && args[1] === "create") return ok("https://github.com/acme/app/pull/77\n");
  if (file === "gh" && args[1] === "checks") return ok(J([{ name: "test", state: "SUCCESS", bucket: "pass" }]));
  if (file === "gh") return ok();
  return { code: 1, stdout: "", stderr: "not expected" };
};

beforeAll(async () => {
  hubHome = mkdtempSync(join(tmpdir(), "willnew-team-hub-"));
  runnerHome = mkdtempSync(join(tmpdir(), "willnew-team-runner-"));
  process.env.WILLNEW_HOME = hubHome;
  bare = mkdtempSync(join(tmpdir(), "willnew-team-origin-")).replace(/\\/g, "/");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "willnew-team-seed-"));
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "math.js"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(seed, "math.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  writeFileSync(join(seed, "package.json"), '{ "type": "module", "scripts": { "test": "node --test" } }\n');
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  git(seed, "push", "-q", bare, "main");
  clone = mkdtempSync(join(tmpdir(), "willnew-team-clone-"));
  execFileSync("git", ["clone", "-q", bare, clone]);
  git(clone, "remote", "set-url", "origin", "https://github.com/acme/app.git");
  git(clone, "config", `url.${bare}.insteadOf`, "https://github.com/acme/app.git");

  const { HOME } = await import("../src/server/home.js");
  if (HOME !== hubHome) throw new Error(`home.js was loaded before WILLNEW_HOME was set (${HOME})`);
  const { hashToken, Members } = await import("../src/server/members.js");
  const membersPath = join(hubHome, "members.json");
  writeFileSync(membersPath, J([
    { name: "이해준", title: "백엔드", role: "developer", slackId: "U_HJ", tokenHash: hashToken(T.hj), runnerTokenHashes: [hashToken("r-hj")] },
    { name: "박서연", title: "", role: "developer", slackId: "U_SY", tokenHash: hashToken(T.sy), runnerTokenHashes: [hashToken("r-sy")] },
    { name: "한지우", title: "디자인", role: "requester", slackId: "U_JW", tokenHash: hashToken(T.jw) },
  ]));
  const members = Members.load(membersPath);
  const { createHub } = await import("../src/server/hub.js");
  hub = createHub({ remote: REMOTE, members, noSelfApprove: true, check: "node --test", reviewers: ["이해준"],
    agents: [{ adapter: "script", model: NOTE, label: "note" }],
    ship: { runner: fakeGh, sleep: async () => undefined, ciPollMs: 1 }, graceMs: 400, log: () => undefined });
  server = serve({ fetch: hub.app.fetch, port: 0, hostname: "127.0.0.1" });
  hub.injectWebSocket(server);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;

  // Slack on the hub: people from members.json, runs from the hub
  let n = 0;
  const client: SlackClient = {
    post: async (a) => {
      const ts = `900.${++n}`;
      calls.push({ m: "post", a, ts });
      return { ts };
    },
    update: async (a) => void calls.push({ m: "update", a }),
    ephemeral: async (a) => void calls.push({ m: "ephemeral", a }),
    openModal: async (triggerId, view) => void calls.push({ m: "modal", a: { triggerId, view } }),
    upload: async (a) => void calls.push({ m: "upload", a }),
  };
  const app: SlackApp = {
    event: (name, fn) => (h.event[name] = fn), action: (_m, fn) => (h.action = fn), view: (_id, fn) => (h.view = fn),
    start: async () => undefined, stop: async () => undefined,
  };
  const { startSlack } = await import("../src/server/slack/index.js");
  const { slackPeopleFrom } = await import("../src/server/slack/cli.js");
  ({ bridge } = await startSlack({ requests: hub.requests, runs: hub.runs, ...slackPeopleFrom(members), channelMap: { C1: "backend" }, channels: hub.chat.channels,
    repo: REMOTE, check: "node --test", noSelfApprove: true, client, app, storePath: join(hubHome, "slack.json"), log: () => undefined }));

  // 이해준's runner: personal subscription, plans and works with his own (fake) login
  const { Runner } = await import("../src/server/runner.js");
  const { createPlanner } = await import("../src/server/brief.js");
  const llm = async (prompt: string) => ({ text: prompt.includes("Write the work spec") ? J(SPEC) : J(BRIEF), costUsd: 0.002 });
  runner = new Runner({ auth: "subscription", claim: "manual", slots: 1, adapters: [{ id: "script", installed: true }],
    hub: `ws://127.0.0.1:${port}/runner`, token: "r-hj", repo: clone, home: runnerHome, runnerId: "hj-pc",
    preview: `node "${TINY}"`, backoff: { minMs: 50, maxMs: 200 }, log: () => undefined,
    planner: createPlanner(() => llm), proposer: async () => ({ text: J(PROPOSAL), costUsd: 0.05 }),
    capturer: async () => ({ capturer: { shot: async (_u, _v, file) => writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex")), close: async () => undefined } }) });
  await runner.start();
  await waitFor(() => hub.hub.list().find((r) => r.runnerId === "hj-pc" && r.connected));
}, 60_000);

afterAll(async () => {
  runner?.stop();
  await new Promise((r) => server?.close(r));
});

const api = (path: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  hub.app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : J(body) });
const mention = (text: string, ts: string, user = "U_JW") => h.event.app_mention({ event: { type: "app_mention", channel: "C1", user, text, ts }, context: { botUserId: "UBOT" } });
const press = async (actionId: string, user: string) => {
  const msg = [...calls].reverse().find((c) => (c.m === "post" || c.m === "update") && buttonsOf(c).some((b) => b.action_id === actionId));
  if (!msg) throw new Error(`no button ${actionId}`);
  const b = buttonsOf(msg).find((x) => x.action_id === actionId)!;
  await h.action!({ ack: async () => undefined, body: { user: { id: user }, trigger_id: "T1" }, action: { action_id: actionId, value: b.value } });
};
const submit = async (user: string, text: string) => {
  const modal = [...calls].reverse().find((c) => c.m === "modal")!;
  await h.view!({ ack: async () => undefined, body: { user: { id: user } }, view: { private_metadata: modal.a.view.private_metadata, state: { values: { text: { v: { value: text } } } } } });
};
const req = (id: string) => hub.requests.get(id) as Request;
const posts = () => calls.filter((c) => c.m === "post");
const ephemerals = () => calls.filter((c) => c.m === "ephemeral").map((c) => String(c.a.text));
const runOf = (id: string) => hub.runs.get(req(id).runIds.at(-1)!) as Run;

describe("team mode: Slack mention to merge with a subscription runner", () => {
  let id = "";

  it("a mention waits for someone to claim it; nothing is planned on the hub", async () => {
    await mention("<@UBOT> 결제 화면 버튼들 좀 답답해 보여요 ㅠ 여백 넉넉하게", "100.1");
    id = hub.requests.list()[0].id;
    expect(req(id)).toMatchObject({ status: "draft", unclaimed: true, requester: "한지우" });
    await bridge.idle();
    await new Promise((r) => setTimeout(r, 200));
    expect(req(id).planner).toBeUndefined();
    expect(textOf(posts()[0])).toContain("받았어요. 맡을 사람 기다리는 중");
    // nobody asked the runner anything yet
    expect(req(id).status).toBe("draft");
  });

  it("refuses a claim with someone else's runner, a requester's claim, and a decision before the claim", async () => {
    const other = await api(`/api/requests/${id}/claim`, T.sy, { runnerId: "hj-pc" });
    expect(other.status).toBe(403);
    expect((await other.json()).error).toContain("자기 러너");
    expect((await api(`/api/requests/${id}/claim`, T.jw, { runnerId: "hj-pc" })).status).toBe(403);
    expect((await api(`/api/requests/${id}/claim`, T.hj, { runnerId: "nope" })).status).toBe(403);
    expect(req(id).assignee).toBeUndefined();
  });

  it("claim → the claimer's runner asks, the requester answers in Slack, the runner writes the spec and proposal", async () => {
    const res = await api(`/api/requests/${id}/claim`, T.hj, { runnerId: "hj-pc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ assignee: "이해준", runnerId: "hj-pc" });
    expect(req(id).unclaimed).toBeUndefined();
    expect(req(id).decisions.at(-1)).toMatchObject({ who: "이해준", what: "claim" });
    await waitFor(() => req(id).status === "clarifying");
    expect(req(id).planner).toMatchObject({ by: "llm", costUsd: null });   // subscription runner: no cost
    // a second developer cannot take it over
    expect((await api(`/api/requests/${id}/claim`, T.sy, { runnerId: "hj-pc" })).status).toBe(403);
    await bridge.idle();
    expect(posts().some((c) => textOf(c).includes("이해준님이 맡았어요"))).toBe(true);
    await press("wn_answer_1", "U_JW");
    await waitFor(() => req(id).status === "proposed");
    expect(req(id).spec?.title).toBe("결제 버튼 여백 16px");
    expect(req(id).proposal).toMatchObject({ by: "agent", summary: "math.js 를 고칠까요?", costUsd: null });
  }, 60_000);

  it("only the developer who claimed it decides; the run goes to that runner", async () => {
    const no = await api(`/api/requests/${id}/decide`, T.sy, { decision: "proceed" });
    expect(no.status).toBe(403);
    expect((await no.json()).error).toContain("이해준님만");
    await bridge.idle();
    await press("wn_decide_proceed", "U_SY");
    await bridge.idle();
    expect(ephemerals().at(-1)).toContain("이해준님만");
    expect(req(id).status).toBe("proposed");
    await press("wn_decide_proceed", "U_HJ");
    await waitFor(() => req(id).runIds.length > 0);
    const run = runOf(id);
    expect(run).toMatchObject({ runnerId: "hj-pc", runnerOwner: "이해준", runnerAuth: "subscription" });
    // the runner works and checks, then the requester looks at the screenshots (no links: no --preview-base-url)
    await waitFor(() => req(id).status === "preview" && req(id).checks?.at(-1)?.capture === "done", 60_000);
    const a = runOf(id).agents[0];
    expect(a).toMatchObject({ status: "done", worktree: "runner:hj-pc", check: { status: "passed" } });
    expect(a.usage.costUsd).toBeNull();
    const check = req(id).checks!.at(-1)!;
    expect(check.previewUrl).toBeUndefined();
    expect(check.shots.length).toBeGreaterThan(0);
    const file = hub.requests.shotFile(id, "1", decodeURIComponent(check.shots[0].after!.split("/").pop()!));
    expect(file && file.startsWith(hubHome)).toBe(true);
    await bridge.idle();
    expect(calls.some((c) => c.m === "upload")).toBe(true);
  }, 90_000);

  it("다시 봐 주세요 from the requester waits for the runner owner; only the owner releases it", async () => {
    await press("wn_check_changes", "U_JW");
    await submit("U_JW", "버튼이 아직 좁아요");
    const run = await waitFor(() => (runOf(id).held?.length ? runOf(id) : undefined));
    expect(run.held![0]).toMatchObject({ by: "한지우", kind: "changes" });
    expect(run.agents[0].status).toBe("done");   // nothing went to the runner
    await bridge.idle();
    expect(posts().some((c) => textOf(c).includes("이해준님 확인 뒤에 이어서 작업해요"))).toBe(true);

    const no = await api(`/api/runs/${run.id}/held/release`, T.jw, {});
    expect(no.status).toBe(403);
    expect((await api(`/api/runs/${run.id}/held/release`, T.sy, {})).status).toBe(403);
    expect(runOf(id).held).toHaveLength(1);

    const ok = await api(`/api/runs/${run.id}/held/release`, T.hj, {});
    expect(ok.status).toBe(200);
    expect(runOf(id).held).toEqual([]);
    await waitFor(() => runOf(id).agents[0].status === "running");
    await waitFor(() => req(id).status === "preview" && req(id).checks?.length === 2 && req(id).checks![1].capture === "done", 60_000);
    expect(runOf(id).agents[0].steers?.at(-1)).toMatchObject({ by: "한지우" });
  }, 90_000);

  it("의도대로예요 → approval by another developer (no self approval) → runner push → PR → merge → reply", async () => {
    await bridge.idle();
    await press("wn_check_ok", "U_JW");
    await waitFor(() => req(id).status === "code_review");
    await bridge.idle();
    await press("wn_review_approve", "U_HJ");
    await bridge.idle();
    expect(ephemerals().at(-1)).toContain("다른 개발자가 승인해요");
    expect(runOf(id).review.status).toBe("pending");
    const self = await api(`/api/runs/${runOf(id).id}/review`, T.hj, { decision: "approve" });
    expect(self.status).toBe(403);

    await press("wn_review_approve", "U_SY");
    await waitFor(() => runOf(id).ship?.stage === "merged");
    const a = runOf(id).agents[0];
    expect(execFileSync("git", ["--git-dir", bare, "branch", "--list", a.branch], { encoding: "utf8" })).toContain(a.branch);
    expect(gh.find((c) => c.startsWith("gh pr create"))).toMatch(/--repo acme\/app$/);
    await waitFor(() => req(id).status === "merged");
    await bridge.idle();
    expect(calls.some((c) => (c.m === "post" || c.m === "update") && textOf(c).includes("PR #77"))).toBe(true);
    expect(posts().some((c) => textOf(c).includes("willnew 로 보낸 답장"))).toBe(true);
  }, 60_000);
});

describe("team mode: the rest of the rules", () => {
  it("a line comment from someone else is held too; the owner's own follow-up goes straight through", async () => {
    const run = await hub.runs.create({ repo: REMOTE, task: "fix add()", check: "node --test", agents: [{ adapter: "script", model: NOTE }], requester: "한지우", runnerId: "hj-pc" });
    const aid = run.agents[0].id;
    await waitFor(() => hub.runs.get(run.id)!.agents[0].status === "done");
    hub.runs.addComment(run.id, { agentId: aid, file: "math.js", line: 1, text: "이름 바꿔 주세요", by: "박서연" });
    expect((await api(`/api/runs/${run.id}/agents/${aid}/send-comments`, T.sy, {})).status).toBe(200);
    expect(hub.runs.get(run.id)!.held).toMatchObject([{ by: "박서연", kind: "comments" }]);
    const steer = await api(`/api/runs/${run.id}/agents/${aid}/steer`, T.hj, { text: "README 도요" });
    expect(await steer.json()).toEqual({ ok: true, held: false });
    await waitFor(() => hub.runs.get(run.id)!.agents[0].status === "running");
    await waitFor(() => hub.runs.get(run.id)!.agents[0].status === "done");
    expect(hub.runs.get(run.id)!.held).toHaveLength(1);
    await hub.runs.remove(run.id);
  }, 60_000);

  it("only developers cancel requests, delete runs and turn previews on", async () => {
    const r = hub.requests.create({ channel: "backend", repo: REMOTE, check: "", team: "platform", requester: "한지우", text: "@willnew 문구 하나" });
    expect((await api(`/api/requests/${r.id}/cancel`, T.jw, {})).status).toBe(403);
    expect((await api(`/api/runs/nope`, T.jw, undefined, "DELETE")).status).toBe(403);
    expect((await api(`/api/runs/nope/agents/a/preview`, T.jw, {})).status).toBe(403);
    expect((await api(`/api/requests/${r.id}/cancel`, T.hj, {})).status).toBe(200);
  });

  it("a cancel on the hub stops the agent on the runner too (its own copy goes to cancelled)", async () => {
    const check = `node -e "setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 2000)"`;
    const run = await hub.runs.create({ repo: REMOTE, task: "noop", check, agents: [{ adapter: "script", model: LAZY }], requester: "이해준", runnerId: "hj-pc" });
    const aid = run.agents[0].id;
    await waitFor(() => hub.runs.get(run.id)!.agents[0].status === "checking");
    hub.runs.cancel(run.id, aid);
    const local = join(runnerHome, "runner", "jobs", `${run.id}.json`);
    await waitFor(() => existsSync(local) && JSON.parse(readFileSync(local, "utf8")).agents[0].status === "cancelled", 5000);
    await new Promise((r) => setTimeout(r, 2500));
    expect(hub.runs.get(run.id)!.agents[0].status).toBe("cancelled");
    expect(JSON.parse(readFileSync(local, "utf8")).agents[0].status).toBe("cancelled");
    const wt = join(runnerHome, "worktrees", `${clone.split(/[\\/]/).pop()}-${run.id}`, aid);
    expect(existsSync(join(wt, "late.txt"))).toBe(false);
    await hub.runs.remove(run.id);
  }, 30_000);

  it("/api/runners lists the runner with its auth and slots; /api/me says who is calling", async () => {
    const list = await (await api("/api/runners", T.hj)).json();
    expect(list.find((x: { runnerId: string }) => x.runnerId === "hj-pc")).toMatchObject({ owner: "이해준", connected: true, auth: "subscription", slots: 1 });
    expect(await (await api("/api/me", T.jw)).json()).toMatchObject({ name: "한지우", role: "requester" });
  });

  it("metrics count subscription runs on their own, without cost", async () => {
    const m = await (await api("/api/metrics", T.hj)).json();
    expect(m.totals.subscription.runs).toBeGreaterThan(0);
    expect(m.totals.costUsd).toBe(0);
  });
});

describe("team mode with an API key on the hub", () => {
  it("the hub plans right away; the request waits at the proposal until a developer claims it", async () => {
    const { EventEmitter } = await import("node:events");
    const { RequestManager } = await import("../src/server/requests.js");
    const { createPlanner } = await import("../src/server/brief.js");
    const created: Record<string, unknown>[] = [];
    const runs = { bus: new EventEmitter(), get: () => undefined, create: async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: `r${created.length}`, agents: [], review: { status: "none" } } as unknown as Run;
    } };
    const llm = async (prompt: string) => ({ text: prompt.includes("Write the work spec") ? J(SPEC) : J({ ...BRIEF, questions: [] }), costUsd: 0.01 });
    const rm = new RequestManager(runs as never, { planner: createPlanner(() => llm), proposer: null, visual: null, team: {} });
    const r = rm.create({ channel: "backend", repo: REMOTE, check: "", team: "platform", requester: "한지우", text: "@willnew 버튼 여백" });
    expect(r.unclaimed).toBe(true);
    await waitFor(() => rm.get(r.id)!.status === "proposed");
    expect(rm.get(r.id)!.planner?.costUsd).toBeGreaterThan(0);
    await expect(rm.decide(r.id, { decision: "proceed", by: "이해준" })).rejects.toThrow("내가 맡을게요");
    rm.claim(r.id, { by: "이해준", runnerId: "hj-pc" });
    expect(() => rm.claim(r.id, { by: "박서연", runnerId: "sy-pc" })).toThrow("이해준님이 맡았어요");
    await expect(rm.decide(r.id, { decision: "proceed", by: "박서연" })).rejects.toThrow("이해준님만");
    await rm.decide(r.id, { decision: "proceed", by: "이해준" });
    expect(created[0]).toMatchObject({ runnerId: "hj-pc", requestId: r.id });
  });
});
