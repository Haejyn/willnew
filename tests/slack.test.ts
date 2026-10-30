import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createPlanner, type LlmCall } from "../src/server/brief.js";
import { fromSlack, mentionify } from "../src/server/slack/blocks.js";
import type { SlackApp } from "../src/server/slack/index.js";
import type { SlackClient } from "../src/server/slack/client.js";
import type { VisualCheck } from "../src/server/visual.js";
import type { AgentRun, Run } from "../src/server/types.js";

// ---------------------------------------------------------------------------------------------- fixtures

const J = (v: unknown) => JSON.stringify(v);
const BRIEF = {
  type: "ui",
  title: "결제 화면 버튼 여백",
  understood: { forRequester: "이렇게 이해했어요: 결제 화면 버튼 안쪽 여백을 늘리고 싶으신 거죠.", forDeveloper: "Checkout 버튼 padding-inline 확대 요청" },
  questions: [{ question: "버튼 안쪽 여백", choices: ["지금보다 조금 (12px)", "넉넉하게 (16px)"], why: "padding 값" }],
};
const SPEC = {
  title: "결제 화면 버튼 여백 16px",
  problem: "결제 화면 버튼이 답답해 보인다",
  expected: "버튼 안쪽 여백이 16px",
  acceptanceCriteria: ["Button size=lg 의 padding-inline 16px"],
  outOfScope: ["색"],
  references: [],
  summary: { forRequester: "결제 화면 버튼 안쪽 여백이 넉넉해져요.", forDeveloper: "Button lg padding-inline space-3 → space-4" },
};
const PROPOSAL = {
  summary: "Button 의 lg 패딩 토큰을 space-4 로 바꿀까요?",
  approach: ["tokens.css 에서 lg 패딩을 space-4 로"],
  files: [{ path: "src/pages/Checkout.tsx", why: "결제 화면 버튼" }],
  risks: ["lg 버튼을 쓰는 다른 화면도 넓어짐"],
  testsToAdd: ["lg 버튼 padding-inline 이 16px"],
  estimate: { minutes: 6, costUsd: 0.12 },
  confidence: "medium",
};
const DECLINE = { forRequester: "이번 분기엔 결제 화면을 바꾸기 어려워요.", alternatives: [{ title: "11월에 다시 보기", effort: "반나절" }] };

const PEOPLE: Record<string, { name: string; role: "developer" | "requester"; title?: string }> = {
  U_JIWOO: { name: "한지우", role: "requester", title: "디자인" },
  U_HJ: { name: "이해준", role: "developer" },
};
const resolveSlackUser = (id: string) => PEOPLE[id] ?? null;
const slackIdOf = (name: string) => Object.entries(PEOPLE).find(([, p]) => p.name === name)?.[0] ?? null;

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
function makeRepo() {
  const r = mkdtempSync(join(tmpdir(), "willnew-repo-"));
  git(r, "init", "-q", "-b", "main");
  writeFileSync(join(r, "a.txt"), "a\n");
  git(r, "add", "-A");
  git(r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return r;
}

function fakeLlm(brief: unknown) {
  const llm: LlmCall = async (prompt) => {
    const text = prompt.includes("Write the work spec") ? J(SPEC) : prompt.includes("decided not to build") ? J(DECLINE) : J(brief);
    return { text, costUsd: 0.001 };
  };
  return llm;
}

function agent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "a1", adapter: "claude-code", label: "claude-sonnet", branch: "b", worktree: "w", status: "done", attempt: 1, turns: 1,
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0.1 }, summary: "", check: { status: "passed", exitCode: 0, output: "ℹ pass 3" },
    diff: { files: 1, insertions: 3, deletions: 1, patch: "" }, merged: false, events: [], ...over,
  };
}

/** runs.create records; review() acts like merge mode (approve merges right away) unless the run already has ship.mode pr. */
function stubRuns() {
  const bus = new EventEmitter();
  const created: Run[] = [];
  const reviews: Record<string, unknown>[] = [];
  return {
    bus, created, reviews,
    create: async (input: Record<string, unknown>) => {
      const r: Run = {
        id: `r${created.length + 1}`, title: "t", task: String(input.task), repo: "/x", baseRef: "abc", baseBranch: "main", checkCmd: "npm test", createdAt: 1,
        requester: String(input.requester), team: "platform", template: "feature", channel: String(input.channel), review: { status: "none" }, maxAttempts: 2,
        agents: [agent({ status: "running" })], requestId: input.requestId as string,
      };
      created.push(r);
      return r;
    },
    get: (id: string) => created.find((r) => r.id === id),
    preflight: async () => ({ conflicts: false }),
    async review(runId: string, input: { decision: "approve" | "reject"; agentId?: string; reviewer: string; comment?: string }) {
      reviews.push(input);
      const r = created.find((x) => x.id === runId)!;
      r.review = { status: input.decision === "approve" ? "approved" : "rejected", reviewer: input.reviewer, comment: input.comment, agentId: input.agentId ?? "a1", at: Date.now() };
      bus.emit("reviewed", r);
      bus.emit("any", { runId });
      return "ok";
    },
  };
}

function fakeVisual(): VisualCheck {
  const dir = mkdtempSync(join(tmpdir(), "willnew-shots-"));
  return {
    previews: async () => ({ after: { local: "http://127.0.0.1:5002", url: "http://dev-box:5002" }, before: { local: "http://127.0.0.1:5001", url: "http://dev-box:5001" }, localOnly: false }),
    capture: async ({ requestId, round }) => {
      const d = join(dir, requestId, String(round));
      mkdirSync(d, { recursive: true });
      for (const n of ["Checkout-desktop-before.png", "Checkout-desktop-after.png"]) writeFileSync(join(d, n), "png");
      const u = (n: string) => `/api/requests/${requestId}/shots/${round}/${n}`;
      return { shots: [{ screen: "Checkout", path: "/checkout", viewport: "desktop" as const, width: 1440, height: 900, before: u("Checkout-desktop-before.png"), after: u("Checkout-desktop-after.png") }] };
    },
    file: (id, round, name) => (existsSync(join(dir, id, round, name)) ? join(dir, id, round, name) : null),
  };
}

type Call = { m: "post" | "update" | "ephemeral" | "modal" | "upload"; a: any; ts?: string };

function fakeClient() {
  const calls: Call[] = [];
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
  return { client, calls };
}

function fakeApp() {
  const h: { event: Record<string, (a: any) => Promise<void>>; action?: (a: any) => Promise<void>; view?: (a: any) => Promise<void> } = { event: {} };
  const app: SlackApp = {
    event: (name, fn) => (h.event[name] = fn),
    action: (_m, fn) => (h.action = fn),
    view: (_id, fn) => (h.view = fn),
    start: async () => undefined,
    stop: async () => undefined,
  };
  return { app, h };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 10_000) {
  for (let t = 0; t < ms; t += 20) {
    if (fn()) return;
    await settle(20);
  }
  throw new Error("timeout");
}

const textOf = (c: Call) => JSON.stringify(c.a.blocks ?? []) + (c.a.text ?? "");
/** every button in a message: action_id → parsed value */
const buttonsOf = (c: Call): { action_id: string; value?: string; url?: string }[] =>
  (c.a.blocks ?? []).filter((b: any) => b.type === "actions").flatMap((b: any) => b.elements);

// ---------------------------------------------------------------------------------------------- harness

let RequestManager: typeof import("../src/server/requests.js").RequestManager;
let startSlack: typeof import("../src/server/slack/index.js").startSlack;

beforeAll(async () => {
  process.env.WILLNEW_HOME = mkdtempSync(join(tmpdir(), "willnew-slack-"));
  process.env.WILLNEW_TRIAGE = "rules";
  ({ RequestManager } = await import("../src/server/requests.js"));
  ({ startSlack } = await import("../src/server/slack/index.js"));
});

async function setup(opts: { brief?: unknown; visual?: VisualCheck | null; storePath?: string; requests?: any; runs?: ReturnType<typeof stubRuns> } = {}) {
  const runs = opts.runs ?? stubRuns();
  const proposer = async () => ({ text: J(PROPOSAL), costUsd: 0.05 });
  const requests = opts.requests ?? new RequestManager(runs as never, { planner: createPlanner(() => fakeLlm(opts.brief ?? BRIEF)), proposer, visual: opts.visual ?? null });
  const { client, calls } = fakeClient();
  const { app, h } = fakeApp();
  const storePath = opts.storePath ?? join(mkdtempSync(join(tmpdir(), "willnew-slack-store-")), "threads.json");
  const logs: string[] = [];
  const slack = await startSlack({
    requests, runs: runs as never, resolveSlackUser, slackIdOf, channelMap: { C1: "backend" },
    channels: [{ id: "backend", repo: makeRepo(), team: "platform", reviewers: ["이해준"] }], check: "npm test",
    webBaseUrl: "http://hub:7777", client, app, storePath, log: (m) => logs.push(m),
  });
  const mention = (text: string, ts: string, user = "U_JIWOO", thread_ts?: string) =>
    h.event.app_mention({ event: { type: "app_mention", channel: "C1", user, text, ts, thread_ts }, context: { botUserId: "UBOT" } });
  const reply = (text: string, ts: string, thread_ts: string, user = "U_JIWOO") =>
    h.event.message({ event: { type: "message", channel: "C1", user, text, ts, thread_ts }, context: { botUserId: "UBOT" } });
  /** press the button with this action_id on the latest message that has it */
  const press = async (actionId: string, user: string) => {
    const msg = [...calls].reverse().find((c) => (c.m === "post" || c.m === "update") && buttonsOf(c).some((b) => b.action_id === actionId));
    if (!msg) throw new Error(`no button ${actionId}`);
    const b = buttonsOf(msg).find((x) => x.action_id === actionId)!;
    const acks: unknown[] = [];
    await h.action!({ ack: async (r?: unknown) => void acks.push(r ?? "ok"), body: { user: { id: user }, trigger_id: "T1" }, action: { action_id: actionId, value: b.value } });
    return acks;
  };
  const submit = async (user: string, text: string) => {
    const modal = [...calls].reverse().find((c) => c.m === "modal")!;
    const acks: unknown[] = [];
    await h.view!({ ack: async (r?: unknown) => void acks.push(r ?? "ok"), body: { user: { id: user } }, view: { private_metadata: modal.a.view.private_metadata, state: { values: { text: { v: { value: text } } } } } });
    return acks;
  };
  const idle = () => slack.bridge.idle();
  const ephemerals = () => calls.filter((c) => c.m === "ephemeral").map((c) => c.a.text as string);
  return { requests, runs, calls, slack, mention, reply, press, submit, idle, ephemerals, storePath, logs };
}

/** mention → clarify → answer → proposal, the request in "proposed" */
async function toProposal(ctx: Awaited<ReturnType<typeof setup>>, ts = "100.1") {
  await ctx.mention("<@UBOT> 결제 화면 버튼들 좀 답답해 보여요 ㅠ 여백 좀 넉넉하게", ts);
  const id = ctx.requests.list().find((r: any) => r.text.includes("결제 화면 버튼들"))!.id;
  await until(() => ["clarifying", "proposed"].includes(ctx.requests.get(id)!.status));
  await ctx.idle();
  if (ctx.requests.get(id)!.status === "clarifying") await ctx.press("wn_answer_1", "U_JIWOO");
  await until(() => ctx.requests.get(id)!.status === "proposed");
  await ctx.idle();
  return id as string;
}

// ---------------------------------------------------------------------------------------------- tests

describe("slack text", () => {
  it("turns Slack's format into the request's text and back", () => {
    expect(fromSlack("<@UBOT> <@U_HJ> 봐 주세요 <https://figma.com/file/x|시안> &lt;b&gt; &amp;", "UBOT", (id) => PEOPLE[id]?.name)).toBe("@willnew @이해준 봐 주세요 https://figma.com/file/x <b> &");
    expect(mentionify("@한지우 반영했어요. <b> @모르는사람", (n) => (slackIdOf(n) ? `<@${slackIdOf(n)}>` : `@${n}`))).toBe("<@U_JIWOO> 반영했어요. &lt;b&gt; @모르는사람");
  });
});

describe("slack: one request from mention to the requester's answer", () => {
  it("clarify → proposal → proceed → result → 요청자 확인 → approve → reply, all in the thread", async () => {
    const ctx = await setup({ visual: fakeVisual() });
    const { calls, requests, runs, press, idle } = ctx;

    await ctx.mention("<@UBOT> 결제 화면 버튼들 좀 답답해 보여요 ㅠ 여백 좀 넉넉하게", "100.1");
    const id = requests.list()[0].id;
    expect(requests.get(id)).toMatchObject({ channel: "backend", requester: "한지우", requesterTitle: "디자인", reviewer: "이해준" });
    expect(requests.get(id)!.text).toBe("@willnew 결제 화면 버튼들 좀 답답해 보여요 ㅠ 여백 좀 넉넉하게");
    await until(() => requests.get(id)!.status === "clarifying");
    await idle();

    // the card is the first bot message in the thread; later states edit it in place
    const card = calls[0];
    expect(card).toMatchObject({ m: "post", a: { channel: "C1", thread_ts: "100.1" } });
    const cardTs = card.ts;
    const question = calls.find((c) => c.m === "post" && buttonsOf(c).some((b) => b.action_id === "wn_answer_0"))!;
    expect(question.a.thread_ts).toBe("100.1");
    expect(textOf(question)).toContain("<@U_JIWOO> 확인할 게 1개 있어요");
    expect(buttonsOf(question).map((b) => b.action_id)).toEqual(["wn_answer_0", "wn_answer_1", "wn_write"]);
    expect(textOf(question)).toContain("개발자용: padding 값");

    // only the requester answers
    await press("wn_answer_1", "U_HJ");
    await idle();
    expect(ctx.ephemerals().at(-1)).toBe("요청한 한지우님만 답할 수 있어요");
    expect(requests.get(id)!.status).toBe("clarifying");

    const acks = await press("wn_answer_1", "U_JIWOO");
    expect(acks).toEqual(["ok"]);
    await until(() => requests.get(id)!.status === "proposed");
    await idle();
    const answered = calls.find((c) => c.m === "update" && c.a.ts === question.ts)!;
    expect(textOf(answered)).toContain("답: *넉넉하게 (16px)* (한지우)");
    expect(buttonsOf(answered)).toEqual([]);
    const proposal = calls.find((c) => c.m === "post" && buttonsOf(c).some((b) => b.action_id === "wn_decide_proceed"))!;
    expect(textOf(proposal)).toContain("<@U_HJ> 확인할 제안이 있어요");
    expect(textOf(proposal)).toContain("결제 화면 버튼 안쪽 여백이 넉넉해져요.");
    expect(textOf(proposal)).toContain("개발자용: Button 의 lg 패딩 토큰을 space-4 로 바꿀까요? (바꿀 파일 1개, 예상 6분, 위험 1개)");
    expect(buttonsOf(proposal).map((b) => b.action_id)).toEqual(["wn_decide_proceed", "wn_decide_changes", "wn_decide_take", "wn_decide_decline", "wn_details"]);

    // the developer's view opens as an ephemeral message
    await press("wn_details", "U_JIWOO");
    await idle();
    const details = calls.filter((c) => c.m === "ephemeral").at(-1)!;
    expect(details.a.user).toBe("U_JIWOO");
    expect(textOf(details)).toContain("Button size=lg 의 padding-inline 16px");

    // only a developer decides
    await press("wn_decide_proceed", "U_JIWOO");
    await idle();
    expect(ctx.ephemerals().at(-1)).toBe("제안 확인은 개발자만 할 수 있어요");
    expect(runs.created).toHaveLength(0);
    await press("wn_decide_proceed", "U_HJ");
    await until(() => runs.created.length === 1);
    await idle();
    const decided = calls.filter((c) => c.m === "update" && c.a.ts === proposal.ts).at(-1)!;
    expect(textOf(decided)).toContain("이해준님이 진행했어요");
    expect(buttonsOf(decided)).toEqual([]);

    // the run passes → 요청자 확인 with links and the before/after pair uploaded into the thread
    const run = runs.created[0];
    run.agents = [agent({ userNote: "결제 버튼 안쪽이 넉넉해졌어요" })];
    run.review = { status: "pending", agentId: "a1" };
    runs.bus.emit("any", { runId: run.id });
    await until(() => requests.get(id)!.checks?.[0]?.capture === "done");
    await idle();
    const check = calls.find((c) => c.m === "post" && buttonsOf(c).some((b) => b.action_id === "wn_check_ok"))!;
    expect(textOf(check)).toContain("<@U_JIWOO> 화면을 보고 의도대로인지 알려 주세요");
    const upload = calls.find((c) => c.m === "upload")!;
    expect(upload.a).toMatchObject({ channel: "C1", thread_ts: "100.1", comment: "1차 전후 화면이에요. 화면마다 전, 후 순서예요" });
    expect(upload.a.files.map((f: any) => f.title)).toEqual(["Checkout 데스크톱 전", "Checkout 데스크톱 후"]);
    expect(upload.a.files.every((f: any) => existsSync(f.path))).toBe(true);
    const withLinks = calls.filter((c) => c.m === "update" && buttonsOf(c).some((b) => b.url === "http://dev-box:5002")).at(-1)!;
    expect(buttonsOf(withLinks).map((b) => b.action_id)).toContain("wn_check_ok");

    // the requester says it is what they meant → code review with 승인 and 반려
    await press("wn_check_ok", "U_JIWOO");
    await until(() => requests.get(id)!.status === "code_review");
    await idle();
    const review = calls.find((c) => c.m === "post" && buttonsOf(c).some((b) => b.action_id === "wn_review_approve"))!;
    expect(review.a.text).toBe("<@U_HJ> 검토 차례예요. 테스트 3개 통과, main과 충돌 없음");

    // a requester cannot approve; the developer can
    await press("wn_review_approve", "U_JIWOO");
    await idle();
    expect(ctx.ephemerals().at(-1)).toBe("결과 승인과 반려는 개발자만 할 수 있어요");
    await press("wn_review_approve", "U_HJ");
    await until(() => requests.get(id)!.status === "merged");
    await idle();
    expect(runs.reviews).toEqual([{ decision: "approve", agentId: "a1", reviewer: "이해준" }]);
    const last = calls.at(-1)!;
    expect(last).toMatchObject({ m: "post", a: { thread_ts: "100.1", text: "<@U_JIWOO> 반영했어요. 결제 버튼 안쪽이 넉넉해졌어요" } });
    expect(textOf(last)).toContain("이해준님이 willnew 로 보낸 답장이에요");

    // every bot message went to the same thread; the card was posted once and edited after that
    expect(calls.filter((c) => c.m === "post").every((c) => c.a.thread_ts === "100.1")).toBe(true);
    expect(calls.filter((c) => c.m === "post" && textOf(c).includes("개발자용 보기") && textOf(c).includes("요청 한지우"))).toHaveLength(1);
    expect(calls.filter((c) => c.m === "update" && c.a.ts === cardTs).length).toBeGreaterThan(3);
    const lastCard = calls.filter((c) => c.m === "update" && c.a.ts === cardTs).at(-1)!;
    expect(textOf(lastCard)).toContain("반영했어요");
    // order of what the thread saw
    const order = ["wn_answer_0", "wn_decide_proceed", "wn_check_ok", "wn_review_approve"].map((a) => calls.findIndex((c) => c.m === "post" && buttonsOf(c).some((b) => b.action_id === a)));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(calls.indexOf(upload)).toBeGreaterThan(order[2]);
    expect(calls.indexOf(upload)).toBeLessThan(order[3]);
    expect(ctx.logs).toEqual([]);
  }, 30_000);
});

describe("slack: decisions with a modal", () => {
  it("거절 opens a modal; an empty reason keeps it open; the reason reaches the requester in plain words", async () => {
    const ctx = await setup({ brief: { ...BRIEF, questions: [] } });
    const id = await toProposal(ctx);
    await ctx.press("wn_decide_decline", "U_HJ");
    await ctx.idle();
    const modal = ctx.calls.at(-1)!;
    expect(modal.m).toBe("modal");
    expect(modal.a.triggerId).toBe("T1");
    expect(modal.a.view).toMatchObject({ type: "modal", callback_id: "wn_modal" });
    expect(JSON.parse(modal.a.view.private_metadata)).toMatchObject({ k: "decline", r: id, ch: "C1", th: "100.1" });

    expect(await ctx.submit("U_HJ", "  ")).toEqual([{ response_action: "errors", errors: { text: "한 줄 적어 주세요" } }]);
    expect(ctx.requests.get(id)!.status).toBe("proposed");
    expect(await ctx.submit("U_HJ", "A/B 측정 중")).toEqual(["ok"]);
    await until(() => ctx.requests.get(id)!.status === "declined");
    await ctx.idle();
    const reply = ctx.calls.filter((c) => c.m === "post").at(-1)!;
    expect(reply.a.text).toBe(`<@U_JIWOO> ${DECLINE.forRequester}\n이렇게는 할 수 있어요\n- 11월에 다시 보기 (반나절)`);
    expect(textOf(reply)).toContain("개발자용: 이해준님이 거절했어요. 사유: A/B 측정 중");
    expect(ctx.calls.some((c) => c.m === "update" && textOf(c).includes("이해준님이 거절했어요") && !buttonsOf(c).length)).toBe(true);
  });

  it("고쳐서 진행 puts the developer's text on the spec; a requester's modal is refused", async () => {
    const ctx = await setup({ brief: { ...BRIEF, questions: [] } });
    const id = await toProposal(ctx);
    await ctx.press("wn_decide_changes", "U_HJ");
    await ctx.idle();
    await ctx.submit("U_JIWOO", "아무거나");
    await ctx.idle();
    expect(ctx.ephemerals().at(-1)).toBe("제안 확인은 개발자만 할 수 있어요");
    await ctx.submit("U_HJ", "토큰은 건드리지 말고 Checkout 버튼만");
    await until(() => ctx.runs.created.length === 1);
    await ctx.idle();
    expect(ctx.requests.get(id)!.spec!.constraints).toEqual(["토큰은 건드리지 말고 Checkout 버튼만"]);
    expect(ctx.calls.some((c) => c.m === "update" && textOf(c).includes("이해준님이 고쳐서 진행했어요: 토큰은 건드리지 말고 Checkout 버튼만"))).toBe(true);
  });
});

describe("slack: buttons are acknowledged right away", () => {
  it("acks before the work is done (Slack wants it within 3 seconds)", async () => {
    const runs = stubRuns();
    const real = new RequestManager(runs as never, { planner: createPlanner(() => fakeLlm({ ...BRIEF, questions: [] })), proposer: async () => ({ text: J(PROPOSAL), costUsd: 0 }), visual: null });
    let started = false;
    const slow = Object.create(real);
    slow.decide = () => { started = true; return new Promise(() => undefined); };
    const ctx = await setup({ requests: slow, runs });
    await toProposal(ctx);
    const t0 = Date.now();
    const acks = await ctx.press("wn_decide_proceed", "U_HJ");
    expect(acks).toEqual(["ok"]);
    expect(Date.now() - t0).toBeLessThan(500);
    await until(() => started);
  });
});

describe("slack: who may do what", () => {
  it("unknown people and unlinked channels get a private note, no request", async () => {
    const ctx = await setup();
    const before = ctx.requests.list().length;
    await ctx.mention("<@UBOT> 버튼 고쳐 주세요", "200.1", "U_STRANGER");
    await ctx.slack.bridge.mention({ channel: "C_OTHER", user: "U_JIWOO", text: "<@UBOT> 버튼", ts: "200.2" }, "UBOT");
    expect(ctx.requests.list()).toHaveLength(before);
    expect(ctx.ephemerals()).toEqual([
      "willnew 에 등록되지 않은 Slack 계정이에요. 허브를 띄운 사람에게 Slack ID 를 알려 주세요",
      "이 채널은 willnew 에 연결돼 있지 않아요. 허브를 띄울 때 --slack-channel 로 연결해 주세요",
    ]);
    expect(ctx.calls.filter((c) => c.m === "post")).toHaveLength(0);
  });

  it("the same event delivered twice makes one request", async () => {
    const ctx = await setup();
    const before = ctx.requests.list().length;
    await ctx.mention("<@UBOT> 버튼 여백", "300.1");
    await ctx.mention("<@UBOT> 버튼 여백", "300.1");
    expect(ctx.requests.list()).toHaveLength(before + 1);
  });
});

describe("slack: restart", () => {
  it("a new process keeps the thread: 직접 쓰기 reply answers, and the stored card and question are edited, not posted again", async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "willnew-slack-store-")), "threads.json");
    const runs = stubRuns();
    const requests = new RequestManager(runs as never, { planner: createPlanner(() => fakeLlm(BRIEF)), proposer: async () => ({ text: J(PROPOSAL), costUsd: 0 }), visual: null });
    const first = await setup({ storePath, requests, runs });
    await first.mention("<@UBOT> 결제 화면 버튼 여백 넉넉하게", "400.1");
    const id = requests.list().find((r) => r.text.includes("결제 화면 버튼 여백 넉넉하게"))!.id;
    await until(() => requests.get(id)!.status === "clarifying");
    await first.idle();
    await first.press("wn_write", "U_JIWOO");
    await first.idle();
    expect(first.ephemerals().at(-1)).toBe("이 스레드에 답을 적어 주세요. 다음 답글을 이 질문의 답으로 받을게요");
    await first.slack.stop();

    const second = await setup({ storePath, requests, runs });
    // someone else's reply in the thread is just conversation
    await second.reply("저도 그렇게 생각해요", "400.5", "400.1", "U_HJ");
    expect(requests.get(id)!.status).toBe("clarifying");
    await second.reply("14px 정도요", "400.6", "400.1");
    await until(() => requests.get(id)!.status === "proposed");
    await second.idle();
    expect(requests.get(id)!.questions[0]).toMatchObject({ answer: "14px 정도요", answeredBy: "한지우" });
    const posts = second.calls.filter((c) => c.m === "post");
    expect(posts.some((c) => textOf(c).includes("요청 한지우"))).toBe(false);   // no second card
    expect(second.calls.some((c) => c.m === "update" && c.a.ts === "900.1")).toBe(true);   // the card from the first process
    expect(second.calls.some((c) => c.m === "update" && c.a.ts === "900.2" && textOf(c).includes("답: *14px 정도요*"))).toBe(true);
    expect(posts.some((c) => buttonsOf(c).some((b) => b.action_id === "wn_decide_proceed"))).toBe(true);
    await second.slack.stop();
  });
});

describe("slack: PR, CI, merge and deploy lines", () => {
  it("one ship message edited per stage, then the approver's answer to the requester", async () => {
    const ctx = await setup({ brief: { ...BRIEF, type: "bug", questions: [] } });
    const id = await toProposal(ctx);
    await ctx.press("wn_decide_proceed", "U_HJ");
    await until(() => ctx.runs.created.length === 1);
    const run = ctx.runs.created[0];
    run.agents = [agent({ userNote: "결제가 다시 돼요" })];
    run.review = { status: "pending", agentId: "a1" };
    ctx.runs.bus.emit("any", { runId: run.id });
    await until(() => ctx.requests.get(id)!.status === "code_review");
    await ctx.idle();
    // pr mode: the shipper sets ship before the review event
    run.ship = { mode: "pr", stage: "pr", env: "production", at: 1 };
    await ctx.press("wn_review_approve", "U_HJ");
    await ctx.idle();
    for (const [stage, e] of [["pr", "pr"], ["merged", "ci_passed"], ["merged", "merged"], ["deployed", "deployed"]] as const) {
      run.ship = { ...run.ship!, stage, prNumber: 12, prUrl: "https://github.com/o/r/pull/12", checks: [{ name: "test", state: "pass" }] };
      ctx.runs.bus.emit("ship", run, e);
    }
    await ctx.idle();
    const ship = ctx.calls.find((c) => c.m === "post" && textOf(c).includes("*반영*"))!;
    const final = ctx.calls.filter((c) => c.m === "update" && c.a.ts === ship.ts).at(-1)!;
    expect(final.a.blocks[0].text.text).toBe("*반영*\n이해준님이 승인해서 PR을 올려요\nPR #12 https://github.com/o/r/pull/12 올렸어요\nCI 1개 통과\nmain에 병합했어요\nproduction 배포 끝났어요");
    expect(ctx.calls.filter((c) => c.m === "post" && textOf(c).includes("*반영*"))).toHaveLength(1);
    expect(ctx.calls.at(-1)!.a.text).toBe("<@U_JIWOO> 배포까지 끝났어요. 결제가 다시 돼요");
    // merged with deploy tracking on: no reply until the deploy is confirmed
    expect(ctx.calls.filter((c) => c.m === "post" && /반영했어요/.test(c.a.text ?? ""))).toHaveLength(0);
  });
});
