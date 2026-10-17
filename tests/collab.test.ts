import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { deployedReply, mergedReply, parseUserNote, passedTests, pickReviewer, rejectedReply, reviewMessage } from "../src/server/handoff.js";
import { rulesTriage } from "../src/server/triage.js";
import { TEMPLATES, wantsRace, withRace } from "../src/server/templates.js";
import type { AgentRun, ChatMessage, Run } from "../src/server/types.js";

const NODE_OUT = "> x test\n> node --test\n\n✔ a (1ms)\nℹ tests 7\nℹ suites 0\nℹ pass 7\nℹ fail 0\n";

function agent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "a1", adapter: "claude-code", label: "claude-sonnet", branch: "b", worktree: "w", status: "done", attempt: 1, turns: 1,
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0.1 }, summary: "", check: { status: "passed", exitCode: 0, output: NODE_OUT },
    diff: { files: 1, insertions: 3, deletions: 1, patch: "" }, merged: false, events: [], ...over,
  };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1", title: "t", task: "t", repo: "/x", baseRef: "abc", baseBranch: "main", checkCmd: "npm test", createdAt: 1, requester: "윤서아",
    team: "platform", template: "bugfix", channel: "backend", review: { status: "pending", agentId: "a1" }, maxAttempts: 2, agents: [agent()], ...over,
  };
}

describe("one agent by default, racing is opt-in", () => {
  it("every template starts with a single agent", () => {
    for (const t of TEMPLATES) expect(t.agents, t.id).toHaveLength(1);
    expect(TEMPLATES[0].agents[0]).toMatchObject({ adapter: "claude-code", model: "sonnet", label: "claude-sonnet" });
  });
  it("the keyword plan has one agent too", () => {
    expect(rulesTriage("@willnew 버그 고쳐줘", "npm test").agents).toHaveLength(1);
  });
  it("only 겨뤄 or 둘 다 asks for two, and codex is added once", () => {
    expect(wantsRace("@willnew 이거 고쳐줘")).toBe(false);
    expect(wantsRace("@willnew 둘 다 돌려봐")).toBe(true);
    expect(wantsRace("@willnew 겨뤄서 고쳐줘")).toBe(true);
    const two = withRace(TEMPLATES[0].agents);
    expect(two.map((a) => a.label)).toEqual(["claude-sonnet", "codex"]);
    expect(withRace(two)).toHaveLength(2);
  });
});

describe("요청자에게 line", () => {
  it("is split off the summary", () => {
    const r = parseUserNote("원인은 날짜 계산이었어요. 테스트 7개 통과.\n\n요청자에게: 1/31 가입자는 2/28에 결제돼요.\n");
    expect(r.userNote).toBe("1/31 가입자는 2/28에 결제돼요.");
    expect(r.summary).toBe("원인은 날짜 계산이었어요. 테스트 7개 통과.");
  });
  it("tolerates bold, full-width colon and a wrapped line; the last one wins", () => {
    const r = parseUserNote("요청자에게: 예전 것\n\n**요청자에게：** 첫 줄이고\n둘째 줄이에요");
    expect(r.userNote).toBe("첫 줄이고 둘째 줄이에요");
  });
  it("leaves a message without the line alone", () => {
    expect(parseUserNote("끝났어요")).toEqual({ summary: "끝났어요" });
    expect(parseUserNote("끝\n요청자에게:  ")).toEqual({ summary: "끝\n요청자에게:  " });
  });
});

describe("review handoff words", () => {
  it("mentions the reviewer with the real numbers", () => {
    expect(passedTests(NODE_OUT)).toBe(7);
    expect(reviewMessage("이해준", agent(), "main", false)).toBe("@이해준 검토 차례예요. 테스트 7개 통과, main과 충돌 없음");
  });
  it("leaves out what it does not know", () => {
    expect(reviewMessage("이해준", agent({ check: { status: "skipped", exitCode: null, output: "" } }), "main", null)).toBe("@이해준 검토 차례예요.");
    expect(reviewMessage("이해준", agent({ check: { status: "passed", exitCode: 0, output: "ok" } }), "main", true)).toBe("@이해준 검토 차례예요. 테스트 통과, main과 충돌해요");
  });
  it("picks the first reviewer who is not the requester", () => {
    const ch = { reviewers: ["이해준", "정하늘"] };
    expect(pickReviewer(ch, "윤서아")).toBe("이해준");
    expect(pickReviewer(ch, "이해준")).toBe("정하늘");
    expect(pickReviewer({ reviewers: ["이해준"] }, "이해준")).toBeUndefined();
    expect(pickReviewer({ reviewers: [] }, "윤서아")).toBeUndefined();
  });
  it("answers the requester after merge or reject", () => {
    expect(mergedReply({ requester: "윤서아" }, "2/28에 결제돼요.")).toBe("@윤서아 반영했어요. 2/28에 결제돼요.");
    expect(mergedReply({ requester: "윤서아" }, undefined)).toBe("@윤서아 반영했어요.");
    expect(deployedReply({ requester: "윤서아" }, "2/28에 결제돼요.")).toBe("@윤서아 배포까지 끝났어요. 2/28에 결제돼요.");
    expect(rejectedReply({ requester: "윤서아" }, "범위가 달라요")).toBe("@윤서아 이번엔 반영하지 않았어요. 사유: 범위가 달라요");
  });
});

describe("chat in a channel (stub run manager)", () => {
  let Chat: typeof import("../src/server/chat.js").Chat;
  beforeAll(async () => {
    process.env.WILLNEW_HOME = mkdtempSync(join(tmpdir(), "willnew-chat-"));
    process.env.WILLNEW_TRIAGE = "rules";
    ({ Chat } = await import("../src/server/chat.js"));
  });
  const stub = () => {
    const bus = new EventEmitter();
    const created: unknown[] = [];
    const runs = {
      bus, created,
      create: async (input: { agents: unknown[] }) => { created.push(input); return { id: "r9", agents: input.agents.map((a) => ({ ...(a as object) })) }; },
      preflight: async () => ({ conflicts: false }),
    };
    return runs;
  };
  const settle = () => new Promise((r) => setTimeout(r, 40));

  // the direct path (developer ⌘K 바로 맡기기); chat messages go through a Request first (see bridge.test.ts)
  it("uses one agent unless the message says 겨뤄", async () => {
    const runs = stub();
    const chat = new Chat(runs as never, "/x", "npm test", ["이해준"]);
    await chat.post("backend", "윤서아", "@willnew 버그 고쳐줘", "platform", undefined, "CS", undefined, true);
    await settle();
    await chat.post("backend", "윤서아", "@willnew 버그 겨뤄서 고쳐줘", "platform", undefined, undefined, undefined, true);
    await settle();
    const [one, two] = runs.created as { agents: { label: string }[]; requesterTitle?: string }[];
    expect(one.agents.map((a) => a.label)).toEqual(["claude-sonnet"]);
    expect(one.requesterTitle).toBe("CS");
    expect(two.agents.map((a) => a.label)).toEqual(["claude-sonnet", "codex"]);
    expect(chat.list("backend").find((m) => m.userTitle === "CS")?.user).toBe("윤서아");
  });

  it("asks the reviewer, then answers the requester after merge and after reject", async () => {
    const runs = stub();
    const chat = new Chat(runs as never, "/x", "npm test", ["이해준", "정하늘"]);
    const r = run({ agents: [agent({ userNote: "2월은 28일에 결제돼요." })] });
    runs.bus.emit("finished", r);
    await settle();
    const texts = () => chat.list("backend").map((m: ChatMessage) => m.text);
    expect(texts().some((t) => t === "@이해준 검토 차례예요. 테스트 7개 통과, main과 충돌 없음")).toBe(true);

    runs.bus.emit("reviewed", { ...r, review: { status: "approved", reviewer: "이해준", agentId: "a1", at: 2 } });
    const last = () => chat.list("backend").at(-1)!;
    expect(texts().at(-1)).toBe("@윤서아 반영했어요. 2월은 28일에 결제돼요.");
    // the answer comes from the approver, sent through willnew
    expect(last()).toMatchObject({ user: "이해준", bot: false, via: "willnew" });

    runs.bus.emit("reviewed", { ...r, review: { status: "rejected", reviewer: "이해준", comment: "범위가 달라요", at: 3 } });
    expect(texts().at(-1)).toBe("@윤서아 이번엔 반영하지 않았어요. 사유: 범위가 달라요");
    expect(last()).toMatchObject({ user: "이해준", via: "willnew" });
  });

  it("does not mention anyone when the requester is the only reviewer", async () => {
    const runs = stub();
    const chat = new Chat(runs as never, "/x", "npm test", ["윤서아"]);
    runs.bus.emit("finished", run({ channel: "content-ops" }));
    await settle();
    expect(chat.list("content-ops").some((m: ChatMessage) => m.text.startsWith("@"))).toBe(false);
  });
});
