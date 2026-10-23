import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hashToken, Members, type Member } from "../src/server/members.js";
import { membersCli } from "../src/server/members-cli.js";
import type { AgentRun, Request, Run } from "../src/server/types.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const write = (path: string, list: unknown) => writeFileSync(path, JSON.stringify(list));
const person = (name: string, role: Member["role"], token: string, over: Partial<Member> = {}): Member => ({ name, title: "", role, tokenHash: hashToken(token), ...over });

describe("Members", () => {
  it("keeps only sha256 hex hashes and finds people by token", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const path = join(tmp("willnew-members-"), "members.json");
    write(path, [person("이해준", "developer", "tok-dev", { title: "백엔드", slackId: "U1", runnerTokenHashes: [hashToken("run-1")] }), person("한지우", "requester", "tok-req")]);
    const m = Members.load(path);
    expect(m.byToken("tok-dev")?.name).toBe("이해준");
    expect(m.byToken("tok-req")?.role).toBe("requester");
    expect(m.byToken("nope")).toBeNull();
    expect(m.byToken("")).toBeNull();
    expect(m.byToken(hashToken("tok-dev"))).toBeNull();   // the hash itself is not a token
    expect(m.byRunnerToken("run-1")?.name).toBe("이해준");
    expect(m.byRunnerToken("tok-dev")).toBeNull();          // person and runner tokens are separate
    expect(m.byToken("run-1")).toBeNull();
    expect(m.bySlackId("U1")?.name).toBe("이해준");
    expect(m.get("한지우")?.role).toBe("requester");
    expect(m.get("없음")).toBeNull();
    expect(m.all().map((x) => x.name)).toEqual(["이해준", "한지우"]);
  });

  it("treats a missing file as an empty team and skips broken entries", () => {
    const dir = tmp("willnew-members-");
    expect(Members.load(join(dir, "none.json")).all()).toEqual([]);
    const path = join(dir, "members.json");
    write(path, [{ name: "x" }, person("최민", "requester", "t"), { name: "역할 없음", tokenHash: hashToken("u") }]);
    const m = Members.load(path);
    expect(m.all().map((x) => x.name)).toEqual(["최민", "역할 없음"]);
    expect(m.get("역할 없음")?.role).toBe("requester");
  });

  it("reads the file again: reload(), and on a lookup that misses after the file changed", () => {
    const path = join(tmp("willnew-members-"), "members.json");
    write(path, [person("이해준", "developer", "a")]);
    const m = Members.load(path);
    expect(m.byToken("b")).toBeNull();
    write(path, [person("이해준", "developer", "a"), person("박서연", "developer", "b")]);
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    expect(m.byToken("b")?.name).toBe("박서연");   // new invite works without a restart
    write(path, [person("박서연", "developer", "b")]);
    m.reload();
    expect(m.get("이해준")).toBeNull();
  });
});

describe("willnew invite / runner-token", () => {
  it("writes the hash, prints the link once, and adds runner tokens to the same person", () => {
    const path = join(tmp("willnew-invite-"), "sub", "members.json");
    const out: string[] = [];
    const err: string[] = [];
    expect(membersCli("invite", ["이해준", "--role", "developer", "--title", "백엔드", "--slack-id", "U9", "--members", path, "--url", "http://hub:7777/"], (s) => out.push(s), (s) => err.push(s))).toBe(0);
    const link = out.join("\n").match(/http:\/\/hub:7777\/\?invite=([A-Za-z0-9_-]+)/);
    expect(link).toBeTruthy();
    const token = link![1];
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved).toEqual([{ name: "이해준", title: "백엔드", role: "developer", slackId: "U9", tokenHash: hashToken(token) }]);
    expect(readFileSync(path, "utf8")).not.toContain(token);

    // default role is requester
    expect(membersCli("invite", ["--members", path, "한지우"], (s) => out.push(s), (s) => err.push(s))).toBe(0);
    expect(Members.load(path).get("한지우")?.role).toBe("requester");

    out.length = 0;
    expect(membersCli("runner-token", ["이해준", "--members", path], (s) => out.push(s), (s) => err.push(s))).toBe(0);
    const r1 = out.at(-1)!;
    expect(membersCli("runner-token", ["이해준", "--members", path], (s) => out.push(s), (s) => err.push(s))).toBe(0);
    const r2 = out.at(-1)!;
    expect(r1).not.toBe(r2);
    const m = Members.load(path);
    expect(m.get("이해준")?.runnerTokenHashes).toEqual([hashToken(r1), hashToken(r2)]);
    expect(m.byRunnerToken(r1)?.name).toBe("이해준");
    expect(m.byToken(token)?.name).toBe("이해준");
    expect(readFileSync(path, "utf8")).not.toContain(r1);

    // a second invite replaces the person token: the old link stops working, runner tokens stay
    out.length = 0;
    expect(membersCli("invite", ["이해준", "--members", path], (s) => out.push(s), (s) => err.push(s))).toBe(0);
    const again = Members.load(path);
    expect(again.byToken(token)).toBeNull();
    expect(again.get("이해준")).toMatchObject({ role: "developer", title: "백엔드" });
    expect(again.byRunnerToken(r2)?.name).toBe("이해준");
    expect(again.all()).toHaveLength(2);
  });

  it("refuses a runner token for someone not invited, a bad role, and no name", () => {
    const path = join(tmp("willnew-invite-"), "members.json");
    const err: string[] = [];
    expect(membersCli("runner-token", ["누구", "--members", path], () => undefined, (s) => err.push(s))).toBe(1);
    expect(membersCli("invite", ["누구", "--role", "admin", "--members", path], () => undefined, (s) => err.push(s))).toBe(1);
    expect(membersCli("invite", ["--members", path], () => undefined, (s) => err.push(s))).toBe(1);
    expect(err.join("\n")).toMatch(/초대하지 않은/);
    expect(Members.load(path).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- team mode HTTP

function agent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "a1", adapter: "script", label: "note", branch: "b", worktree: "w", status: "done", attempt: 1, turns: 1,
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0 }, summary: "", check: { status: "passed", exitCode: 0, output: "" },
    diff: { files: 1, insertions: 1, deletions: 0, patch: "" }, merged: false, events: [], ...over,
  };
}
function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id, title: "t", task: "t", repo: "/nowhere", baseRef: "abc", baseBranch: "main", checkCmd: "", createdAt: 1, requester: "한지우",
    team: "platform", template: "bugfix", channel: "backend", review: { status: "pending", agentId: "a1" }, maxAttempts: 1, agents: [agent()], ...over,
  };
}
function req(id: string, over: Partial<Request> = {}): Request {
  return {
    id, threadId: `req-${id}`, channel: "backend", repo: "/nowhere", check: "", team: "platform", requester: "한지우", text: "@willnew 버튼", attachments: [],
    status: "proposed", title: "버튼", questions: [], decisions: [], runIds: [], createdAt: 1, updatedAt: 1, ...over,
  };
}

describe("team mode API", () => {
  const T = { dev: "tok-dev", dev2: "tok-dev2", req: "tok-req", other: "tok-other" };
  let createApp: typeof import("../src/server/app.js").createApp;
  let membersPath: string;

  beforeAll(async () => {
    const home = tmp("willnew-team-");
    process.env.WILLNEW_HOME = home;
    process.env.WILLNEW_TRIAGE = "rules";
    mkdirSync(join(home, "runs"), { recursive: true });
    mkdirSync(join(home, "requests"), { recursive: true });
    const rq = (r: Request) => write(join(home, "requests", `${r.id}.json`), r);
    const rn = (r: Run) => write(join(home, "runs", `${r.id}.json`), r);
    rq(req("qprop"));
    rq(req("qprop2"));
    rq(req("qclar", { status: "clarifying", questions: [
      { id: "c1", question: "어디요", choices: ["결제", "기타"] },
      { id: "c2", question: "모바일도", choices: ["네", "아니요"] },
    ] }));
    rq(req("qprev", { status: "preview", runIds: ["rprev"], checks: [{ round: 1, runId: "rprev", agentId: "a1", status: "waiting", startedAt: 1, capture: "skipped", shots: [] }] }));
    rq(req("qmine", { status: "code_review", requester: "이해준", runIds: ["rmine"] }));
    rq(req("qtaken", { status: "code_review", assignee: "이해준", runIds: ["rtaken"] }));
    rn(run("rmine", { requester: "이해준", requestId: "qmine" }));
    rn(run("rtaken", { requestId: "qtaken" }));
    rn(run("rplain"));
    membersPath = join(home, "members.json");
    write(membersPath, [
      person("이해준", "developer", T.dev, { title: "백엔드" }),
      person("박서연", "developer", T.dev2),
      person("한지우", "requester", T.req, { title: "디자인", avatar: "https://x.io/a.png" }),
      person("최민", "requester", T.other),
    ]);
    ({ createApp } = await import("../src/server/app.js"));
  });

  const make = (noSelfApprove = false) => createApp({ repo: "/nowhere", check: "", members: Members.load(membersPath), noSelfApprove }).app;
  const call = (app: ReturnType<typeof make>, path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    app.request(path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body) });

  it("401 without a person token, with the invite hint", async () => {
    const app = make();
    const r = await call(app, "/api/requests");
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "초대 링크로 들어와 주세요", team: true });
    expect((await call(app, "/api/requests", "wrong")).status).toBe(401);
    expect((await call(app, "/api/config", T.req)).status).toBe(200);
  });

  it("a query token works for reads only (SSE, websocket, images)", async () => {
    const app = make();
    expect((await app.request(`/api/requests?token=${T.req}`)).status).toBe(200);
    expect((await app.request(`/api/requests/qprop/decide?token=${T.dev}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "take_over" }) })).status).toBe(401);
  });

  it("/api/me and the team flag in config", async () => {
    const app = make();
    expect(await (await call(app, "/api/me", T.req)).json()).toEqual({ name: "한지우", title: "디자인", role: "requester", avatar: "https://x.io/a.png" });
    expect(await (await call(app, "/api/config", T.dev)).json()).toMatchObject({ team: true });
  });

  it("a requester cannot confirm a proposal; a developer can, under their own name", async () => {
    const app = make();
    const no = await call(app, "/api/requests/qprop/decide", T.req, { decision: "take_over", by: "이해준" });
    expect(no.status).toBe(403);
    expect((await no.json()).error).toMatch(/개발자만/);
    const ok = await call(app, "/api/requests/qprop/decide", T.dev, { decision: "take_over", by: "가짜 이름" });
    expect(ok.status).toBe(200);
    const r = (await ok.json()) as Request;
    expect(r.assignee).toBe("이해준");
    expect(r.decisions.at(-1)).toMatchObject({ who: "이해준", what: "take_over" });
  });

  it("ignores user and title in a chat message body", async () => {
    const app = make();
    const r = await call(app, "/api/channels/backend/messages", T.req, { user: "이해준", userTitle: "CTO", text: "점심 뭐 먹어요" });
    expect(r.status).toBe(200);
    expect((await r.json()).message).toMatchObject({ user: "한지우", userTitle: "디자인", userAvatar: "https://x.io/a.png" });
    expect((await call(app, "/api/channels/backend/messages", T.req, { text: "@willnew 바로 해 줘", direct: true })).status).toBe(403);
    expect((await call(app, "/api/runs", T.req, { task: "x" })).status).toBe(403);
  });

  it("clarify answers come from the requester only", async () => {
    const app = make();
    expect((await call(app, "/api/requests/qclar/answer", T.dev, { questionId: "c1", answer: "결제", by: "한지우" })).status).toBe(403);
    expect((await call(app, "/api/requests/qclar/answer", T.other, { questionId: "c1", answer: "결제" })).status).toBe(403);
    const ok = await call(app, "/api/requests/qclar/answer", T.req, { questionId: "c1", answer: "결제", by: "누군가" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Request).questions[0]).toMatchObject({ answer: "결제", answeredBy: "한지우" });
  });

  it("requester check: skip is for developers, 의도대로예요 for the requester", async () => {
    const app = make();
    expect((await call(app, "/api/requests/qprev/requester-check", T.req, { verdict: "skip", reason: "급해요" })).status).toBe(403);
    expect((await call(app, "/api/requests/qprev/requester-check", T.other, { verdict: "ok" })).status).toBe(403);
    const ok = await call(app, "/api/requests/qprev/requester-check", T.req, { verdict: "ok", by: "이해준" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Request).checks?.[0]).toMatchObject({ status: "approved", by: "한지우" });
  });

  it("only developers approve or reject results, and the reviewer is the token's person", async () => {
    const app = make();
    expect((await call(app, "/api/runs/rplain/review", T.req, { decision: "reject", comment: "별로", reviewer: "이해준" })).status).toBe(403);
    expect((await call(app, "/api/runs/rplain/agents/a1/merge", T.req, {})).status).toBe(403);
    const ok = await call(app, "/api/runs/rplain/review", T.dev2, { decision: "reject", comment: "다시", reviewer: "이해준" });
    expect(ok.status).toBe(200);
    const runR = await (await call(app, "/api/runs/rplain", T.dev2)).json();
    expect(runR.review).toMatchObject({ status: "rejected", reviewer: "박서연" });
  });

  it("self approval is allowed by default", async () => {
    const app = make();
    // gets past the guard; the merge itself fails on the fake repo (400), not 403
    expect((await call(app, "/api/runs/rmine/review", T.dev, { decision: "approve" })).status).not.toBe(403);
  });

  it("--no-self-approve: not your own request or the result you were assigned", async () => {
    const app = make(true);
    for (const id of ["rmine", "rtaken"]) {
      const r = await call(app, `/api/runs/${id}/review`, T.dev, { decision: "approve" });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/다른 개발자/);
      expect((await call(app, `/api/runs/${id}/agents/a1/merge`, T.dev, {})).status).toBe(403);
    }
    // rejecting your own is fine, and another developer may approve
    expect((await call(app, "/api/runs/rtaken/review", T.dev, { decision: "reject", comment: "내가 다시 할게요" })).status).toBe(200);
    expect((await call(app, "/api/runs/rmine/review", T.dev2, { decision: "approve" })).status).not.toBe(403);
  });

  it("the terminal is closed in team mode", async () => {
    const app = make();
    const r = await app.request(`/api/runs/rplain/agents/a1/terminal?token=${T.dev}`, { headers: { upgrade: "websocket", connection: "Upgrade" } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/터미널/);
  });

  it("a new invite works without restarting", async () => {
    const app = make();
    expect((await call(app, "/api/me", "tok-new")).status).toBe(401);
    const list = JSON.parse(readFileSync(membersPath, "utf8"));
    write(membersPath, [...list, person("새사람", "requester", "tok-new")]);
    const later = new Date(Date.now() + 10_000);
    utimesSync(membersPath, later, later);
    expect(await (await call(app, "/api/me", "tok-new")).json()).toMatchObject({ name: "새사람" });
  });
});
