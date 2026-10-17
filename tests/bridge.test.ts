import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { askJson, checkBrief, checkDecline, checkProposal, checkSpec, createPlanner, extractJson, type LlmCall } from "../src/server/brief.js";
import { codeNames, flagUnverified } from "../src/server/spec-check.js";
import { specPrompt, proposalPrompt } from "../src/server/prompts.js";
import { buildRunTask, canTransition, cardBodies, feedbackConstraints, moveTo, parseAttachments, routeAfterVerify, screensFromFiles, statusFromRun, transition, wantsMobile, withConstraint } from "../src/server/request-state.js";
import { ShotService, type Capturer } from "../src/server/shots.js";
import type { VisualCheck } from "../src/server/visual.js";
import type { AgentRun, ChatMessage, Request, RequesterCheck, Run } from "../src/server/types.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const FIX = resolve("tests/fixtures/fix-agent.mjs");

// ---------------------------------------------------------------------------------------------- fixtures

const J = (v: unknown) => JSON.stringify(v);
const BRIEF = {
  type: "ui",
  title: "결제 화면 버튼 여백",
  understood: { forRequester: "이렇게 이해했어요: 결제 화면 버튼 안쪽 여백을 늘리고 싶으신 거죠.", forDeveloper: "Checkout 버튼 padding-inline 확대 요청" },
  questions: [
    { question: "버튼 안쪽 여백", choices: ["지금보다 조금 (12px)", "넉넉하게 (16px)", "피그마 시안대로", "기타"], why: "padding 값" },
    { question: "모바일 화면도 같이 바꿀까요", choices: ["네", "아니요, 데스크톱만"], why: "적용 범위" },
  ],
};
const BRIEF_NO_Q = { ...BRIEF, questions: [] };
const SPEC = {
  title: "결제 화면 버튼 여백 16px",
  problem: "결제 화면 버튼이 답답해 보인다",
  expected: "버튼 안쪽 여백이 16px",
  acceptanceCriteria: ["Button size=lg 의 padding-inline 16px (space-4)", "결제 화면 4곳의 기본 버튼에 적용", "모바일 375px 에서 버튼 줄바꿈 없음"],
  outOfScope: ["색", "글꼴"],
  references: ["https://figma.com/file/demo/checkout"],
  summary: { forRequester: "결제 화면 버튼 안쪽 여백이 넉넉해져요.", forDeveloper: "Button lg padding-inline space-3 → space-4" },
};
const PROPOSAL = {
  summary: "Button 의 lg 패딩 토큰을 space-3 → space-4 로 바꾸고 결제 화면 버튼을 lg 로 맞출까요?",
  approach: ["tokens.css 에서 lg 패딩을 space-4 로", "Checkout.tsx 버튼을 size=lg 로"],
  files: [{ path: "src/components/Button.tsx", why: "size 별 패딩" }, { path: "src/pages/Checkout.tsx", why: "결제 화면 버튼" }],
  risks: ["lg 버튼을 쓰는 다른 화면 6곳도 같이 넓어짐"],
  testsToAdd: ["lg 버튼 padding-inline 이 16px"],
  estimate: { minutes: 6, costUsd: 0.12 },
  confidence: "medium",
};
const DECLINE = { forRequester: "이번 분기엔 결제 화면을 바꾸기 어려워요. 결제 완료율을 재는 중이라 화면이 바뀌면 숫자를 비교할 수 없어서요.", alternatives: [{ title: "측정이 끝나는 11월에 다시 보기", effort: "반나절" }] };

/** A fake small model: replies are queued per step, every prompt is kept. */
function fakeLlm(queues: { brief?: string[]; spec?: string[]; decline?: string[] }) {
  const prompts: { kind: string; prompt: string }[] = [];
  const llm: LlmCall = async (prompt) => {
    const kind = prompt.includes("Write the work spec") ? "spec" : prompt.includes("decided not to build") ? "decline" : "brief";
    prompts.push({ kind, prompt });
    const q = queues[kind as keyof typeof queues] ?? [];
    const text = q.length > 1 ? q.shift()! : q[0] ?? "";
    return { text, costUsd: 0.001 };
  };
  return { llm, prompts };
}

function agent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "a1", adapter: "claude-code", label: "claude-sonnet", branch: "b", worktree: "w", status: "done", attempt: 1, turns: 1,
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0.1 }, summary: "", check: { status: "passed", exitCode: 0, output: "ℹ pass 3" },
    diff: { files: 1, insertions: 3, deletions: 1, patch: "" }, merged: false, events: [], ...over,
  };
}
function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1", title: "t", task: "t", repo: "/x", baseRef: "abc", baseBranch: "main", checkCmd: "npm test", createdAt: 1, requester: "한지우",
    team: "design", template: "feature", channel: "backend", review: { status: "none" }, maxAttempts: 2, agents: [agent()], ...over,
  };
}
function req(over: Partial<Request> = {}): Request {
  return {
    id: "q1", channel: "backend", repo: "/x", check: "npm test", team: "platform", requester: "한지우", text: "@willnew 버튼 여백", attachments: [],
    status: "draft", title: "버튼 여백", questions: [], decisions: [], runIds: [], createdAt: 1, updatedAt: 1, reviewer: "이해준", ...over,
  };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 10_000) {
  for (let t = 0; t < ms; t += 20) {
    if (fn()) return;
    await settle(20);
  }
  throw new Error("timeout");
}

// ---------------------------------------------------------------------------------------------- state machine

describe("request state machine", () => {
  it("walks the happy path in order", () => {
    const r = req();
    for (const to of ["clarifying", "spec_ready", "proposed", "approved", "building", "verifying", "code_review", "merged", "deployed", "closed"] as const) {
      expect(canTransition(r.status, to), `${r.status} → ${to}`).toBe(true);
      transition(r, to);
    }
    expect(r.status).toBe("closed");
  });
  it("skips clarifying when nothing is missing", () => {
    expect(canTransition("draft", "spec_ready")).toBe(true);
  });
  it("refuses jumps and moves out of finished states", () => {
    expect(() => transition(req(), "proposed")).toThrow();
    expect(() => transition(req({ status: "proposed" }), "building")).toThrow();   // a person has to approve first
    expect(() => transition(req({ status: "spec_ready" }), "approved")).toThrow();
    expect(canTransition("closed", "declined")).toBe(false);
    expect(canTransition("merged", "cancelled")).toBe(false);
    expect(canTransition("declined", "proposed")).toBe(false);
  });
  it("declines or cancels from any open state and remembers where", () => {
    for (const from of ["draft", "clarifying", "spec_ready", "proposed", "approved", "building", "verifying", "code_review"] as const) {
      expect(canTransition(from, "declined")).toBe(true);
      expect(canTransition(from, "cancelled")).toBe(true);
    }
    const r = transition(req({ status: "proposed" }), "declined");
    expect(r.stoppedFrom).toBe("proposed");
  });
  it("follows the linked run: work, check, review, merge, deploy", () => {
    expect(statusFromRun(run({ agents: [agent({ status: "running" })] }))).toBe("building");
    expect(statusFromRun(run({ agents: [agent({ status: "checking" })] }))).toBe("verifying");
    expect(statusFromRun(run({ review: { status: "pending", agentId: "a1" } }))).toBe("code_review");
    expect(statusFromRun(run({ review: { status: "approved" } }))).toBe("merged");
    expect(statusFromRun(run({ review: { status: "approved" }, ship: { mode: "pr", stage: "ci", at: 1 } }))).toBe("code_review");
    expect(statusFromRun(run({ review: { status: "approved" }, ship: { mode: "pr", stage: "deployed", at: 1 } }))).toBe("deployed");
    expect(statusFromRun(run({ review: { status: "rejected" } }))).toBe("declined");
    expect(statusFromRun(run({ review: { status: "none" } }))).toBeNull();
    const r = req({ status: "code_review" });
    expect(moveTo(r, "deployed")).toBe(true);   // through merged
    expect(r.status).toBe("deployed");
  });
  it("finds Figma links and images in the message", () => {
    expect(parseAttachments("시안은 https://figma.com/file/demo/checkout 에 있고 캡처는 https://x.io/a.png.")).toEqual([
      { kind: "figma", url: "https://figma.com/file/demo/checkout" },
      { kind: "image", url: "https://x.io/a.png" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------- planner

describe("planner JSON: validate, retry once, fall back", () => {
  it("accepts a valid reply on the first try and strips 기타 from the choices", async () => {
    const { llm, prompts } = fakeLlm({ brief: [J(BRIEF)] });
    const r = await createPlanner(() => llm).brief("@willnew 버튼 여백", [], ".");
    expect(r).toMatchObject({ by: "llm", attempts: 1 });
    expect(r.value.questions[0].choices).toEqual(["지금보다 조금 (12px)", "넉넉하게 (16px)", "피그마 시안대로"]);
    expect(prompts).toHaveLength(1);
  });
  it("retries once with the validation error, then succeeds", async () => {
    const bad = J({ ...BRIEF, type: "design" });
    const { llm, prompts } = fakeLlm({ brief: [bad, "```json\n" + J(BRIEF) + "\n```"] });
    const r = await createPlanner(() => llm).brief("@willnew 버튼 여백", [], ".");
    expect(r).toMatchObject({ by: "llm", attempts: 2 });
    expect(prompts[1].prompt).toContain("Your previous reply was rejected: type must be one of");
  });
  it("falls back to a minimal spec after the second failure and says so", async () => {
    const { llm } = fakeLlm({ spec: ["not json", J({ ...SPEC, acceptanceCriteria: [] })] });
    const r = await createPlanner(() => llm).spec("@willnew 버튼 여백 넓혀주세요 https://figma.com/file/x", parseAttachments("https://figma.com/file/x"),
      [{ id: "q1", question: "여백", choices: ["12px", "16px"], answer: "16px" }], ".");
    expect(r.by).toBe("fallback");
    expect(r.note).toMatch(/두 번 다 형식에 맞지 않아/);
    expect(r.value.acceptanceCriteria[0]).toBe("여백: 16px");
    expect(r.value.acceptanceCriteria.at(-1)).toMatch(/^\[확인 필요/);
    expect(r.value.references).toEqual(["https://figma.com/file/x"]);
  });
  it("uses the fallback without a model and says why", async () => {
    const r = await createPlanner(() => null).brief("@willnew 결제 화면 버튼 여백", [], ".");
    expect(r).toMatchObject({ by: "fallback", attempts: 0 });
    expect(r.value).toMatchObject({ type: "ui", questions: [] });
    expect(r.note).toMatch(/AI 정리를 쓸 수 없는 환경/);
  });
  it("checks every field it relies on", () => {
    expect(() => checkBrief({ ...BRIEF, questions: [1, 2, 3, 4].map(() => BRIEF.questions[1]) })).toThrow(/at most 3/);
    expect(() => checkBrief({ ...BRIEF, questions: [{ question: "q", choices: ["a", "기타"] }] })).toThrow(/2 to 4/);
    expect(() => checkBrief({ ...BRIEF, questions: [{ question: "q", choices: ["a", "b", "c", "d", "e"] }] })).toThrow(/2 to 4/);
    expect(() => checkBrief({ ...BRIEF, understood: { forRequester: "x" } })).toThrow(/forDeveloper/);
    expect(checkBrief(BRIEF_NO_Q).questions).toEqual([]);
    expect(() => checkSpec({ ...SPEC, acceptanceCriteria: [] })).toThrow(/at least 1/);
    expect(() => checkProposal({ ...PROPOSAL, confidence: "sure" })).toThrow(/confidence/);
    expect(() => checkProposal({ ...PROPOSAL, estimate: { minutes: "six" } })).toThrow(/minutes/);
    expect(checkProposal({ ...PROPOSAL, estimate: { minutes: 6, costUsd: null } }).estimate.costUsd).toBeNull();
    expect(() => checkDecline({ ...DECLINE, alternatives: [1, 2, 3].map(() => DECLINE.alternatives[0]) })).toThrow(/at most 2/);
    expect(extractJson('네, 여기요: {"a":1} 끝')).toEqual({ a: 1 });
  });
  it("keeps going when the model call itself throws", async () => {
    let n = 0;
    const r = await askJson(async () => { if (n++ === 0) throw new Error("claude exited 1"); return { text: J(BRIEF), costUsd: null }; }, "p", checkBrief);
    expect(r.attempts).toBe(2);
    expect(r.value?.title).toBe(BRIEF.title);
  });
});

// ---------------------------------------------------------------------------------------------- request manager (stub runs)

let RequestManager: typeof import("../src/server/requests.js").RequestManager;
let Chat: typeof import("../src/server/chat.js").Chat;
let RunManager: typeof import("../src/server/runs.js").RunManager;
let propose: typeof import("../src/server/proposal.js").propose;
let HOME = "";

beforeAll(async () => {
  HOME = mkdtempSync(join(tmpdir(), "willnew-bridge-"));
  process.env.WILLNEW_HOME = HOME;
  process.env.WILLNEW_TRIAGE = "rules";
  ({ RequestManager } = await import("../src/server/requests.js"));
  ({ Chat } = await import("../src/server/chat.js"));
  ({ RunManager } = await import("../src/server/runs.js"));
  ({ propose } = await import("../src/server/proposal.js"));
});

function makeRepo() {
  const r = mkdtempSync(join(tmpdir(), "willnew-repo-"));
  git(r, "init", "-q", "-b", "main");
  writeFileSync(join(r, "math.js"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(r, "math.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  writeFileSync(join(r, "package.json"), '{ "type": "module", "scripts": { "test": "node --test" } }\n');
  git(r, "add", "-A");
  git(r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return r;
}

/** Records runs.create; `get` returns what was created so a test can move it along and emit "any". */
function stubRuns() {
  const bus = new EventEmitter();
  const created: (Run & { input: Record<string, unknown> })[] = [];
  return {
    bus, created,
    create: async (input: Record<string, unknown>) => {
      const r = { ...run({ id: `r${created.length + 1}`, requestId: input.requestId as string, agents: [agent({ status: "running" })] }), input };
      created.push(r);
      return r;
    },
    get: (id: string) => created.find((r) => r.id === id),
    preflight: async () => ({ conflicts: false }),
    steered: [] as { runId: string; agentId: string; text: string; by: string }[],
    steer(runId: string, agentId: string, text: string, by: string) {
      this.steered.push({ runId, agentId, text, by });
      const r = created.find((x) => x.id === runId)!;
      r.agents = r.agents.map((a) => (a.id === agentId ? { ...a, status: "running" as const } : a));
      r.review = { status: "none" };
      bus.emit("any", { runId });
    },
  };
}

const fakeProposer = (reply = J(PROPOSAL)) => {
  const seen: string[] = [];
  const fn = async (_prompt: string, cwd: string) => { seen.push(cwd); return { text: reply, costUsd: 0.05 }; };
  return { fn, seen };
};

function manager(opts: { brief?: unknown; decline?: string[]; spec?: unknown; repo?: string; visual?: VisualCheck | null } = {}) {
  const runs = stubRuns();
  const { llm, prompts } = fakeLlm({ brief: [J(opts.brief ?? BRIEF)], spec: [J(opts.spec ?? SPEC)], decline: opts.decline ?? [J(DECLINE)] });
  const repo = opts.repo ?? makeRepo();
  const m = new RequestManager(runs as never, { planner: createPlanner(() => llm), proposer: fakeProposer().fn, visual: opts.visual });
  const input = { channel: "backend", repo, check: "npm test", team: "platform", requester: "한지우", requesterTitle: "디자인", reviewer: "이해준",
    text: "@willnew 결제 화면 버튼들 좀 답답해 보여요 ㅠ 여백 좀 넉넉하게 해주실 수 있나요? 시안은 피그마에 올려뒀어요 https://figma.com/file/demo/checkout" };
  return { m, runs, prompts, input, repo };
}

async function proposed(opts: Parameters<typeof manager>[0] = {}) {
  const ctx = manager({ brief: BRIEF_NO_Q, ...opts });
  const r = ctx.m.create(ctx.input);
  await until(() => ctx.m.get(r.id)!.status === "proposed");
  return { ...ctx, id: r.id };
}

describe("clarify answers", () => {
  it("asks, waits for every answer, then writes the spec and the proposal", async () => {
    const { m, input } = manager();
    const r = m.create(input);
    expect(r.status).toBe("draft");
    expect(r.attachments).toEqual([{ kind: "figma", url: "https://figma.com/file/demo/checkout" }]);
    await until(() => m.get(r.id)!.status === "clarifying");
    const q = m.get(r.id)!.questions;
    expect(q.map((x) => x.id)).toEqual(["q1", "q2"]);
    await expect(m.decide(r.id, { decision: "proceed", by: "이해준" })).rejects.toThrow("확인할 제안이 없어요");

    await m.answer(r.id, { questionId: "q1", answer: "넉넉하게 (16px)", by: "한지우" });
    expect(m.get(r.id)!.status).toBe("clarifying");
    await m.answer(r.id, { questionId: "q2", answer: "네", by: "한지우" });
    await until(() => m.get(r.id)!.status === "proposed");
    const done = m.get(r.id)!;
    expect(done.spec?.acceptanceCriteria).toContain("모바일 375px 에서 버튼 줄바꿈 없음");
    expect(done.proposal).toMatchObject({ by: "agent", summary: PROPOSAL.summary, estimate: { minutes: 6, costUsd: 0.12 } });
    expect(done.decisions.map((d) => [d.who, d.what, d.why])).toEqual([["한지우", "answer", "버튼 안쪽 여백: 넉넉하게 (16px)"], ["한지우", "answer", "모바일 화면도 같이 바꿀까요: 네"]]);
    await expect(m.answer(r.id, { questionId: "q1", answer: "12px", by: "한지우" })).rejects.toThrow("답할 질문이 없어요");
  });

  it("goes straight to the spec when nothing is missing", async () => {
    const { m, id, prompts } = await proposed();
    expect(m.get(id)!.questions).toEqual([]);
    expect(prompts.map((p) => p.kind)).toEqual(["brief", "spec"]);
    expect(prompts[1].prompt).toContain("(no questions were needed)");
  });
});

describe("developer decision on the proposal", () => {
  it("proceed: starts the run with the spec, the criteria and the test-first rule", async () => {
    const { m, id, runs } = await proposed();
    await m.decide(id, { decision: "proceed", by: "이해준" });
    const r = m.get(id)!;
    expect(r.status).toBe("building");
    expect(r.runIds).toEqual(["r1"]);
    expect(r.decisions.at(-1)).toMatchObject({ who: "이해준", what: "proceed" });
    const task = String(runs.created[0].input.task);
    expect(runs.created[0].input).toMatchObject({ requestId: id, requester: "한지우", template: "feature", check: "npm test" });
    expect(task).toContain("Button size=lg 의 padding-inline 16px (space-4)");
    expect(task).toContain("Out of scope (do not change):\n- 색\n- 글꼴");
    expect(task).toContain("First write tests that check each acceptance criterion");
    expect(task).toContain("Do not edit or weaken existing tests that are unrelated");
    expect(task).not.toContain("Developer constraints");
  });

  it("proceed_with_changes: the text becomes a spec constraint, a log entry and part of the run task", async () => {
    const { m, id, runs } = await proposed();
    await expect(m.decide(id, { decision: "proceed_with_changes", by: "이해준", text: "  " })).rejects.toThrow("무엇을 고칠지");
    const ask = "lg 전체 말고 결제 화면 버튼에만 새 size=xl 추가해서 적용해주세요. 다른 화면 영향 없게";
    await m.decide(id, { decision: "proceed_with_changes", by: "이해준", text: ask });
    const r = m.get(id)!;
    expect(r.spec?.constraints).toEqual([ask]);
    expect(r.decisions.at(-1)).toMatchObject({ who: "이해준", what: "proceed_with_changes", why: ask });
    expect(String(runs.created[0].input.task)).toContain(`Developer constraints (these override the proposal):\n- ${ask}`);
  });

  it("take_over: leaves the AI flow, assigned to the developer, no run", async () => {
    const { m, id, runs } = await proposed();
    await m.decide(id, { decision: "take_over", by: "이해준", text: "토큰 정리랑 같이 할게요" });
    const r = m.get(id)!;
    expect(r).toMatchObject({ status: "approved", assignee: "이해준", runIds: [] });
    expect(runs.created).toHaveLength(0);
    expect(r.decisions.at(-1)).toMatchObject({ what: "take_over", why: "토큰 정리랑 같이 할게요" });
    expect(cardBodies(r).forRequester).toBe("이해준님이 직접 맡았어요");
    m.close(id, "이해준", "직접 반영함");
    expect(m.get(id)!.status).toBe("closed");
  });

  it("decline: needs a reason, and the planner explains it to the requester", async () => {
    const { m, id, prompts } = await proposed();
    await expect(m.decide(id, { decision: "decline", by: "이해준" })).rejects.toThrow("거절 사유");
    await m.decide(id, { decision: "decline", by: "이해준", text: "Q4 결제 완료율 A/B 중이라 화면 못 바꿈" });
    const r = m.get(id)!;
    expect(r.status).toBe("declined");
    expect(r.stoppedFrom).toBe("proposed");
    expect(r.decline).toMatchObject({ reason: "Q4 결제 완료율 A/B 중이라 화면 못 바꿈", forRequester: DECLINE.forRequester, alternatives: DECLINE.alternatives });
    expect(r.decisions.at(-1)).toMatchObject({ who: "이해준", what: "decline", why: "Q4 결제 완료율 A/B 중이라 화면 못 바꿈" });
    expect(prompts.at(-1)?.prompt).toContain("Do not blame the developer or the requester");
    await expect(m.decide(id, { decision: "proceed", by: "이해준" })).rejects.toThrow();
  });

  it("decline still answers the requester when the planner reply is unusable", async () => {
    const { m, id } = await proposed({ decline: ["{}", "nope"] });
    await m.decide(id, { decision: "decline", by: "이해준", text: "범위가 커요" });
    expect(m.get(id)!.decline).toMatchObject({ forRequester: "이번엔 진행하지 않기로 했어요. 개발자가 남긴 이유: 범위가 커요", alternatives: [] });
  });

  it("follows the run, and logs the review decision", async () => {
    // a bug fix has nothing for the requester to look at: verify goes straight to code review (a ui request goes to preview, below)
    const { m, id, runs } = await proposed({ brief: { ...BRIEF_NO_Q, type: "bug" } });
    await m.decide(id, { decision: "proceed", by: "이해준" });
    const r = runs.created[0];
    r.agents = [agent({ status: "checking" })];
    runs.bus.emit("any", { runId: r.id });
    expect(m.get(id)!.status).toBe("verifying");
    r.agents = [agent()];
    r.review = { status: "pending", agentId: "a1" };
    runs.bus.emit("any", { runId: r.id });
    expect(m.get(id)!.status).toBe("code_review");
    r.review = { status: "approved", reviewer: "이해준", agentId: "a1", at: 2 };
    runs.bus.emit("reviewed", r);
    expect(m.get(id)!.status).toBe("merged");
    expect(m.get(id)!.decisions.at(-1)).toMatchObject({ who: "이해준", what: "approve_result" });
  });
});

describe("withConstraint and buildRunTask", () => {
  it("adds the constraint once and keeps the original message in the task", () => {
    const spec = { ...SPEC, constraints: [] };
    expect(withConstraint(spec, "  ").constraints).toEqual([]);
    const task = buildRunTask({ spec: withConstraint(spec, "xl 추가"), text: "@willnew 원문", proposal: undefined }, "Implement it.");
    expect(task.startsWith("Implement it.")).toBe(true);
    expect(task).toContain('"""@willnew 원문"""');
  });
});

// ---------------------------------------------------------------------------------------------- proposal pass

describe("proposal pass", () => {
  it("runs in a fresh detached worktree that is removed afterwards", async () => {
    const repo = makeRepo();
    const { fn, seen } = fakeProposer();
    let inside = "";
    const p = await propose({ id: "q9", text: "x", spec: { ...SPEC, constraints: [] } }, repo, async (prompt, cwd) => {
      inside = readFileSync(join(cwd, "math.js"), "utf8");
      expect(prompt).toContain("read-only access");
      return fn(prompt, cwd);
    }, HOME);
    expect(p).toMatchObject({ by: "agent", confidence: "medium", costUsd: 0.05 });
    expect(inside).toContain("a - b");
    expect(seen[0]).toContain(join("worktrees", "proposals"));
    expect(existsSync(seen[0])).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("proposals");
  });
  it("falls back to a minimal proposal after two bad replies", async () => {
    const p = await propose({ id: "q8", text: "x", spec: { ...SPEC, constraints: [] } }, makeRepo(), fakeProposer("{}").fn, HOME);
    expect(p).toMatchObject({ by: "fallback", confidence: "low" });
    expect(p.note).toMatch(/두 번 다 형식에 맞지 않아/);
    expect(p.testsToAdd).toEqual(SPEC.acceptanceCriteria);
  });
});

// ---------------------------------------------------------------------------------------------- spec check

/** A small web repo: a Button with a padding token, a checkout page and a tokens file. */
function makeUiRepo() {
  const r = mkdtempSync(join(tmpdir(), "willnew-ui-"));
  git(r, "init", "-q", "-b", "main");
  const w = (f: string, body: string) => {
    mkdirSync(dirname(join(r, f)), { recursive: true });
    writeFileSync(join(r, f), body);
  };
  w("src/components/Button.tsx", "export function Button({ size = 'md' }) { return null }\n");
  w("src/pages/Checkout.tsx", "import { Button } from '../components/Button';\nexport const Checkout = () => null;\n");
  w("src/styles/tokens.css", ":root { --space-3: 12px; --space-4: 16px; --button-lg-padding-x: var(--space-3); }\n");
  git(r, "add", "-A");
  git(r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return r;
}

describe("spec check: code names nobody wrote or found", () => {
  it("finds CSS variables, paths and camel, Pascal and snake case names, not plain words", () => {
    expect(codeNames("Button size=lg 의 padding-inline 16px (--button-lg-padding-x)")).toEqual(["--button-lg-padding-x", "Button"]);
    expect(codeNames("src/pages/Checkout.tsx 의 PayButton 과 nextBillingDate, settle_daily")).toEqual(["src/pages/Checkout.tsx", "nextBillingDate", "PayButton", "settle_daily"]);
    expect(codeNames("모바일 375px 에서 버튼 줄바꿈 없음, Figma 시안과 같은 여백")).toEqual([]);
  });

  it("flags names that are not in the request, the proposal's files or the repo", async () => {
    const repo = makeUiRepo();
    const spec = { acceptanceCriteria: [
      "Button size=lg 의 padding-inline 16px",
      "--button-lg-padding-x 를 --space-4 로",
      "PayButton 도 같은 여백",
      "--button-xl-padding-x 를 새로 둔다",
      "CheckoutHero 문구는 그대로",
      "[확인 필요: 모바일 적용 범위]",
    ] };
    const flags = await flagUnverified(spec, { text: "@willnew 결제 화면 버튼 여백. CheckoutHero 는 건드리지 마세요", questions: [] }, { files: [{ path: "src/pages/Checkout.tsx", why: "" }] }, repo);
    expect(flags).toEqual([
      { criterion: "PayButton 도 같은 여백", names: ["PayButton"] },
      { criterion: "--button-xl-padding-x 를 새로 둔다", names: ["--button-xl-padding-x"] },
    ]);
  });

  it("the request keeps the flags on the spec and hands them to the run", async () => {
    const repo = makeUiRepo();
    const spec = { ...SPEC, acceptanceCriteria: [...SPEC.acceptanceCriteria, "PayButton 의 padding-inline 도 16px"] };
    const { m, id, runs } = await proposed({ spec, repo });
    expect(m.get(id)!.spec?.needsCheck).toEqual([{ criterion: "PayButton 의 padding-inline 도 16px", names: ["PayButton"] }]);
    await m.decide(id, { decision: "proceed", by: "이해준" });
    expect(String(runs.created[0].input.task)).toMatch(/not found in the repository[^]*PayButton/);
  });

  it("leaves a clean spec unflagged", async () => {
    const { m, id } = await proposed({ repo: makeUiRepo() });
    expect(m.get(id)!.spec?.needsCheck).toBeUndefined();
  });

  it("the spec and proposal prompts forbid invented code names", () => {
    const sp = specPrompt("@willnew 버튼 여백", [], [], "src");
    expect(sp).toContain("Do not invent code facts");
    expect(sp).toContain("only if the requester wrote that exact name");
    const pp = proposalPrompt({ text: "x", spec: { ...SPEC, constraints: [] } });
    expect(pp).toContain("Do not invent code facts");
    expect(pp).toContain("Every path is checked afterwards");
  });
});

// ---------------------------------------------------------------------------------------------- chat routing

describe("chat routing and role bodies", () => {
  function chatWith(brief: unknown = BRIEF) {
    const runs = stubRuns();
    const { llm } = fakeLlm({ brief: [J(brief)], spec: [J(SPEC)], decline: [J(DECLINE)] });
    const requests = new RequestManager(runs as never, { planner: createPlanner(() => llm), proposer: fakeProposer().fn });
    const chat = new Chat(runs as never, makeRepo(), "npm test", ["이해준"], requests);
    return { chat, runs, requests };
  }

  it("a requester's @willnew message becomes a Request with one live card, not a run", async () => {
    const { chat, runs, requests } = chatWith();
    const { requestId } = await chat.post("backend", "한지우", "@willnew 결제 화면 버튼 여백 넉넉하게", "platform", undefined, "디자인");
    expect(requestId).toBeTruthy();
    await until(() => requests.get(requestId!)!.status === "clarifying");
    expect(runs.created).toHaveLength(0);
    const cards = () => chat.list("backend").filter((m: ChatMessage) => m.requestId === requestId && m.kind === "request");
    expect(cards()).toHaveLength(1);
    expect(cards()[0].bodies?.forRequester).toBe("이렇게 이해했어요: 결제 화면 버튼 안쪽 여백을 늘리고 싶으신 거죠. 확인할 게 2개 있어요");

    await requests.answer(requestId!, { questionId: "q1", answer: "넉넉하게 (16px)", by: "한지우" });
    // the answer lives in the card's thread, not in the channel
    const thread = () => chat.thread("backend", `req-${requestId}`);
    expect(thread().at(-1)).toMatchObject({ user: "한지우", bot: false, userTitle: "디자인", text: "버튼 안쪽 여백: 넉넉하게 (16px)", threadId: `req-${requestId}` });
    await requests.answer(requestId!, { questionId: "q2", answer: "네", by: "한지우" });
    await until(() => requests.get(requestId!)!.status === "proposed");
    await settle();

    expect(cards()).toHaveLength(1);   // replaced in place
    expect(cards()[0].bodies).toEqual({ forRequester: "개발자가 제안을 보고 있어요 (이해준)", forDeveloper: `제안: ${PROPOSAL.summary}` });
    const mention = thread().find((m: ChatMessage) => m.kind === "mention")!;
    expect(mention.text).toBe(`@이해준 확인할 제안이 있어요. ${PROPOSAL.summary}`);
    expect(mention.bodies?.forRequester).toBe("이해준님께 확인을 부탁했어요");
    expect(mention.bodies?.forRequester).not.toMatch(/tsx|space-|lg/);
  });

  it("the decline explanation goes to the requester from the developer, through willnew", async () => {
    const { chat, requests } = chatWith(BRIEF_NO_Q);
    const { requestId } = await chat.post("backend", "한지우", "@willnew 결제 완료 화면에 폭죽 넣어주세요", "platform");
    await until(() => requests.get(requestId!)!.status === "proposed");
    await requests.decide(requestId!, { decision: "decline", by: "이해준", text: "A/B 측정 중" });
    const last = chat.thread("backend", `req-${requestId}`).at(-1)!;
    expect(last).toMatchObject({ user: "이해준", via: "willnew", bot: false });
    expect(last.text).toBe(`@한지우 ${DECLINE.forRequester}\n이렇게는 할 수 있어요\n- 측정이 끝나는 11월에 다시 보기 (반나절)`);
  });

  it("a developer's ⌘K direct message still starts a run right away", async () => {
    const { chat, runs, requests } = chatWith();
    const before = requests.list().length;   // requests from earlier tests are on disk in the same home
    const res = await chat.post("backend", "이해준", "@willnew 버그 고쳐줘", "platform", undefined, undefined, undefined, true);
    await settle(60);
    expect(res.requestId).toBeUndefined();
    expect(runs.created).toHaveLength(1);
    expect(requests.list()).toHaveLength(before);
  });

  it("plain messages stay plain", async () => {
    const { chat, requests } = chatWith();
    const before = requests.list().length;
    await chat.post("backend", "한지우", "점심 뭐 먹지", "platform");
    expect(requests.list()).toHaveLength(before);
  });

  it("reactions toggle per person and only from the offered set", async () => {
    const { chat } = chatWith();
    const { message } = await chat.post("backend", "한지우", "배포 끝났대요", "platform");
    chat.react("backend", message.id, "👍", "이해준");
    chat.react("backend", message.id, "👍", "한지우");
    expect(chat.list("backend").find((m) => m.id === message.id)!.reactions).toEqual({ "👍": ["이해준", "한지우"] });
    chat.react("backend", message.id, "👍", "이해준");
    chat.react("backend", message.id, "👍", "한지우");
    expect(chat.list("backend").find((m) => m.id === message.id)!.reactions).toBeUndefined();
    expect(() => chat.react("backend", message.id, "🔥", "이해준")).toThrow("쓸 수 없는 반응");
  });
});

// ---------------------------------------------------------------------------------------------- end to end with a real run

describe("request → proposal → proceed → real run → approve (offline agent)", () => {
  it("merges and closes the loop on the request", async () => {
    const repo = makeRepo();
    const runs = new RunManager();
    const { llm } = fakeLlm({ brief: [J({ ...BRIEF_NO_Q, type: "bug" })], spec: [J({ ...SPEC, acceptanceCriteria: ["add(2, 3) 이 5"] })] });
    const m = new RequestManager(runs, { planner: createPlanner(() => llm), proposer: fakeProposer().fn, agents: [{ adapter: "script", model: FIX, label: "fixer" }] });
    const r = m.create({ channel: "backend", repo, check: "node --test", team: "platform", requester: "윤서아", reviewer: "이해준", text: "@willnew 더하기가 이상해요" });
    await until(() => m.get(r.id)!.status === "proposed");
    await m.decide(r.id, { decision: "proceed", by: "이해준" });
    const runId = m.get(r.id)!.runIds[0];
    expect(runs.get(runId)!.requestId).toBe(r.id);
    expect(runs.get(runId)!.task).toContain("add(2, 3) 이 5");
    await until(() => m.get(r.id)!.status === "code_review", 20_000);
    await runs.review(runId, { decision: "approve", reviewer: "이해준" });
    expect(m.get(r.id)!.status).toBe("merged");
    expect(readFileSync(join(repo, "math.js"), "utf8")).toContain("a + b");
    expect(m.get(r.id)!.decisions.map((d) => d.what)).toEqual(["proceed", "approve_result"]);
    await runs.remove(runId);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------- B2: 요청자 확인

describe("preview (요청자 확인) in the state machine", () => {
  it("sits between verifying and code_review and can send the work back", () => {
    expect(canTransition("verifying", "preview")).toBe(true);
    expect(canTransition("building", "preview")).toBe(true);
    expect(canTransition("preview", "code_review")).toBe(true);
    expect(canTransition("preview", "building")).toBe(true);
    expect(canTransition("preview", "merged")).toBe(false);
    expect(canTransition("preview", "declined")).toBe(true);
    const r = req({ status: "building" });
    expect(moveTo(r, "preview")).toBe(true);
    expect(r.status).toBe("preview");
    expect(cardBodies(r)).toEqual({ forRequester: "화면을 확인해 주세요", forDeveloper: "요청자 확인 차례 (한지우)" });
  });

  it("routes ui and copy (or needsVisualCheck) to preview until a round is accepted or skipped", () => {
    const spec = { ...SPEC, constraints: [] };
    expect(routeAfterVerify({ type: "ui", spec })).toBe("preview");
    expect(routeAfterVerify({ type: "copy", spec })).toBe("preview");
    expect(routeAfterVerify({ type: "bug", spec })).toBe("code_review");
    expect(routeAfterVerify({ type: "bug", spec: { ...spec, needsVisualCheck: true } })).toBe("preview");
    const check = (status: RequesterCheck["status"]): RequesterCheck => ({ round: 1, runId: "r1", agentId: "a1", status, startedAt: 1, capture: "done", shots: [] });
    expect(routeAfterVerify({ type: "ui", spec, checks: [check("changes")] })).toBe("preview");
    expect(routeAfterVerify({ type: "ui", spec, checks: [check("approved")] })).toBe("code_review");
    expect(routeAfterVerify({ type: "ui", spec, checks: [check("skipped")] })).toBe("code_review");
  });

  it("guesses pages from the proposal's files and sees phones in the spec", () => {
    expect(screensFromFiles([{ path: "src/pages/Checkout.tsx" }, { path: "src/components/Button.tsx" }, { path: "app/settings/billing/page.tsx" }, { path: "src/pages/index.tsx" }]))
      .toEqual([{ name: "Checkout", path: "/checkout" }, { name: "billing", path: "/settings/billing" }, { name: "첫 화면", path: "/" }]);
    expect(wantsMobile({ ...SPEC, constraints: [] })).toBe(true);   // "모바일 375px 에서 버튼 줄바꿈 없음"
    expect(wantsMobile({ ...SPEC, acceptanceCriteria: ["버튼 여백 16px"], constraints: [] })).toBe(false);
    expect(checkSpec({ ...SPEC, screens: [{ name: "결제 화면", path: "/checkout" }], needsVisualCheck: true })).toMatchObject({ screens: [{ name: "결제 화면", path: "/checkout" }], needsVisualCheck: true });
    expect(() => checkSpec({ ...SPEC, screens: [{ name: "결제", path: "checkout" }] })).toThrow(/start with \//);
  });
});

/** Writes a tiny file per shot and remembers what it was asked; `fail` makes one URL throw. */
function fakeCapturer(fail?: string) {
  const calls: { url: string; viewport: string }[] = [];
  let closed = false;
  const capturer: Capturer = {
    async shot(url, vp, file) {
      calls.push({ url, viewport: `${vp.width}x${vp.height}` });
      if (fail && url.includes(fail)) throw new Error("net::ERR_CONNECTION_REFUSED\nmore");
      writeFileSync(file, "png");
    },
    async close() {
      closed = true;
    },
  };
  return { factory: async () => ({ capturer }), calls, closed: () => closed };
}

describe("screenshot service (fake capturer)", () => {
  it("captures every screen on both sides in the same viewports, desktop and mobile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "willnew-shots-"));
    const f = fakeCapturer();
    const svc = new ShotService(dir, f.factory);
    const r = await svc.capture({ requestId: "q1", round: 2, screens: [{ name: "결제 화면", path: "/checkout" }, { name: "주문 요약", path: "/summary" }], mobile: true, before: "http://127.0.0.1:5001", after: "http://127.0.0.1:5002/" });
    expect(r.note).toBeUndefined();
    expect(r.shots).toHaveLength(4);
    expect(r.shots[1]).toEqual({
      screen: "결제 화면", path: "/checkout", viewport: "mobile", width: 390, height: 844,
      before: "/api/requests/q1/shots/2/%EA%B2%B0%EC%A0%9C-%ED%99%94%EB%A9%B4-mobile-before.png",
      after: "/api/requests/q1/shots/2/%EA%B2%B0%EC%A0%9C-%ED%99%94%EB%A9%B4-mobile-after.png",
    });
    expect(f.calls.slice(0, 4)).toEqual([
      { url: "http://127.0.0.1:5001/checkout", viewport: "1440x900" },
      { url: "http://127.0.0.1:5002/checkout", viewport: "1440x900" },
      { url: "http://127.0.0.1:5001/checkout", viewport: "390x844" },
      { url: "http://127.0.0.1:5002/checkout", viewport: "390x844" },
    ]);
    expect(f.closed()).toBe(true);
    expect(svc.file("q1", "2", "결제-화면-mobile-after.png")).toBe(join(dir, "q1", "2", "결제-화면-mobile-after.png"));
    expect(svc.file("q1", "2", "../../secret.png")).toBeNull();
    expect(svc.file("q1", "x", "a.png")).toBeNull();
  });

  it("keeps going when one page fails, and says so", async () => {
    const f = fakeCapturer(":5002/summary");
    const r = await new ShotService(mkdtempSync(join(tmpdir(), "willnew-shots-")), f.factory).capture({ requestId: "q2", round: 1, screens: [{ name: "a", path: "/" }, { name: "b", path: "/summary" }], mobile: false, before: "http://127.0.0.1:5001", after: "http://127.0.0.1:5002" });
    expect(r.shots.map((s) => [s.screen, !!s.before, !!s.after, s.error])).toEqual([["a", true, true, undefined], ["b", true, false, "후 화면을 찍지 못했어요: net::ERR_CONNECTION_REFUSED"]]);
  });

  it("skips with a note when there is no capturer or no preview", async () => {
    const none = new ShotService(mkdtempSync(join(tmpdir(), "willnew-shots-")), async () => ({ capturer: null, note: "playwright-core 가 설치돼 있지 않아요" }));
    expect(await none.capture({ requestId: "q3", round: 1, screens: [], mobile: false, after: "http://127.0.0.1:1" })).toEqual({ shots: [], note: "playwright-core 가 설치돼 있지 않아요" });
    expect((await none.capture({ requestId: "q3", round: 1, screens: [], mobile: false })).note).toMatch(/미리보기가 뜨지 않아/);
  });
});

/** Previews on fixed ports, shots through the real ShotService with a fake capturer. */
function fakeVisual(localOnly = false) {
  const f = fakeCapturer();
  const svc = new ShotService(mkdtempSync(join(tmpdir(), "willnew-shots-")), f.factory);
  const seen: string[] = [];
  const visual: VisualCheck = {
    previews: async (run, agentId) => {
      seen.push(`${run.id}/${agentId}`);
      return { after: { local: "http://127.0.0.1:5002", url: "http://dev-box:5002" }, before: { local: "http://127.0.0.1:5001", url: "http://dev-box:5001" }, localOnly };
    },
    capture: (input) => svc.capture(input),
    file: (id, round, name) => svc.file(id, round, name),
  };
  return { visual, seen, calls: f.calls };
}

/** A ui request whose run has passed verification, so it sits in preview. */
async function inPreview(visual: VisualCheck | null = null) {
  const ctx = await proposed({ visual });
  await ctx.m.decide(ctx.id, { decision: "proceed", by: "이해준" });
  const r = ctx.runs.created[0];
  r.agents = [agent()];
  r.review = { status: "pending", agentId: "a1" };
  ctx.runs.bus.emit("any", { runId: r.id });
  return { ...ctx, run: r };
}

describe("요청자 확인: preview, feedback, follow-up, skip", () => {
  it("a passing ui result goes to the requester first, with links and before/after pairs", async () => {
    const v = fakeVisual();
    const { m, id, run, runs } = await inPreview(v.visual);
    expect(m.get(id)!.status).toBe("preview");
    await until(() => m.get(id)!.checks?.[0].capture === "done");
    const c = m.get(id)!.checks![0];
    expect(c).toMatchObject({ round: 1, runId: run.id, agentId: "a1", status: "waiting", previewUrl: "http://dev-box:5002", baseUrl: "http://dev-box:5001", localOnly: false });
    // the spec mentions 모바일 375px → desktop + mobile; the page comes from the proposal's files (src/pages/Checkout.tsx)
    expect(c.shots.map((s) => `${s.screen} ${s.viewport}`)).toEqual(["Checkout desktop", "Checkout mobile"]);
    expect(m.get(id)!.spec?.screens).toEqual([{ name: "Checkout", path: "/checkout" }]);
    expect(v.calls.map((x) => x.url)).toContain("http://127.0.0.1:5002/checkout");
    expect(m.shotFile(id, "1", "Checkout-desktop-after.png")).toBeTruthy();
    // more updates from the same run do not start another round
    run.agents = [agent({ preview: { status: "ready", port: 5002, log: "", startedAt: 1 } })];
    runs.bus.emit("any", { runId: run.id });
    expect(m.get(id)!.checks).toHaveLength(1);
  });

  it("without a preview command the round is still there, with a note", async () => {
    const { m, id } = await inPreview(null);
    expect(m.get(id)!.checks![0]).toMatchObject({ capture: "skipped", shots: [] });
    expect(m.get(id)!.checks![0].note).toMatch(/serve --preview/);
  });

  it("다시 봐 주세요: boxes become constraints and a log entry, and the same agent continues on the same branch", async () => {
    const { m, id, runs, run } = await inPreview();
    expect(() => m.requesterCheck(id, { verdict: "changes", by: "한지우", feedback: [] })).toThrow("다시 볼 곳");
    const box = { screen: "Checkout", viewport: "mobile" as const, rect: { x: 0.1, y: 0.62, w: 0.8, h: 0.12 }, note: "모바일에서 결제 버튼 두 줄로 보여요" };
    m.requesterCheck(id, { verdict: "changes", by: "한지우", feedback: [box] });
    const r = m.get(id)!;
    expect(r.status).toBe("building");
    expect(r.checks![0]).toMatchObject({ status: "changes", by: "한지우", feedback: [box] });
    expect(r.spec!.constraints).toEqual(feedbackConstraints(1, [box]));
    expect(r.spec!.constraints[0]).toBe("요청자 확인 1차, Checkout (모바일): 모바일에서 결제 버튼 두 줄로 보여요 (표시한 곳: 왼쪽 10%, 위 62%, 폭 80%, 높이 12%)");
    expect(r.decisions.at(-1)).toMatchObject({ who: "한지우", what: "preview_changes", why: "Checkout (모바일): 모바일에서 결제 버튼 두 줄로 보여요" });
    expect(runs.steered).toHaveLength(1);
    expect(runs.steered[0]).toMatchObject({ runId: run.id, agentId: "a1", by: "한지우" });
    expect(runs.steered[0].text).toContain('"모바일에서 결제 버튼 두 줄로 보여요"');
    expect(runs.steered[0].text).toContain("mobile 390x844");

    // the follow-up passes again → round 2 in preview → 의도대로예요 → code review
    run.agents = [agent({ attempt: 1 })];
    run.review = { status: "pending", agentId: "a1" };
    runs.bus.emit("any", { runId: run.id });
    expect(m.get(id)!.status).toBe("preview");
    expect(m.get(id)!.checks!.map((c) => [c.round, c.status])).toEqual([[1, "changes"], [2, "waiting"]]);
    m.requesterCheck(id, { verdict: "ok", by: "한지우" });
    expect(m.get(id)!.status).toBe("code_review");
    expect(m.get(id)!.decisions.at(-1)).toMatchObject({ who: "한지우", what: "preview_ok", why: "2차 확인" });
    expect(() => m.requesterCheck(id, { verdict: "ok", by: "한지우" })).toThrow("확인할 화면이 없어요");
    // the run keeps saying "pending": the request stays in code review
    runs.bus.emit("any", { runId: run.id });
    expect(m.get(id)!.status).toBe("code_review");
  });

  it("the developer can skip the check, only with a reason, and it is logged", async () => {
    const { m, id } = await inPreview();
    expect(() => m.requesterCheck(id, { verdict: "skip", by: "이해준", reason: " " })).toThrow("건너뛰는 이유");
    m.requesterCheck(id, { verdict: "skip", by: "이해준", reason: "한지우님 휴가라 시안과 같은지 제가 봤어요" });
    const r = m.get(id)!;
    expect(r.status).toBe("code_review");
    expect(r.checks![0]).toMatchObject({ status: "skipped", reason: "한지우님 휴가라 시안과 같은지 제가 봤어요", by: "이해준" });
    expect(r.decisions.at(-1)).toMatchObject({ who: "이해준", what: "preview_skip", why: "한지우님 휴가라 시안과 같은지 제가 봤어요" });
  });

  it("needsVisualCheck sends a bug fix to preview too, and the developer can edit the pages", async () => {
    const { m, id, runs } = await proposed({ brief: { ...BRIEF_NO_Q, type: "bug" }, spec: { ...SPEC, needsVisualCheck: true, screens: [{ name: "결제", path: "/checkout" }] } });
    expect(m.get(id)!.spec?.screens).toEqual([{ name: "결제", path: "/checkout" }]);
    expect(() => m.setScreens(id, [{ name: "요약", path: "summary" }], "이해준")).toThrow("/ 로 시작");
    m.setScreens(id, [{ name: "결제", path: "/checkout" }, { name: "영수증", path: "/receipt" }], "이해준");
    expect(m.get(id)!.spec?.screens).toHaveLength(2);
    await m.decide(id, { decision: "proceed", by: "이해준" });
    const r = runs.created[0];
    r.agents = [agent()];
    r.review = { status: "pending", agentId: "a1" };
    runs.bus.emit("any", { runId: r.id });
    expect(m.get(id)!.status).toBe("preview");
  });
});

// ---------------------------------------------------------------------------------------------- threads

describe("threads in the chat API", () => {
  function chatWith(brief: unknown = BRIEF_NO_Q) {
    const runs = stubRuns();
    const { llm } = fakeLlm({ brief: [J(brief)], spec: [J(SPEC)], decline: [J(DECLINE)] });
    const requests = new RequestManager(runs as never, { planner: createPlanner(() => llm), proposer: fakeProposer().fn, visual: null });
    const chat = new Chat(runs as never, makeRepo(), "npm test", ["이해준"], requests);
    return { chat, runs, requests };
  }

  it("a request's messages live in its card's thread; the channel keeps the root message and the card", async () => {
    const { chat, requests } = chatWith();
    const { message, requestId } = await chat.post("backend", "한지우", "@willnew 결제 화면 버튼 여백 넉넉하게", "platform", undefined, "디자인");
    await until(() => requests.get(requestId!)!.status === "proposed");
    await settle();
    const tid = `req-${requestId}`;
    expect(requests.get(requestId!)!.threadId).toBe(tid);
    const channel = chat.list("backend");
    expect(channel.some((m) => m.id === message.id)).toBe(true);
    expect(channel.some((m) => m.id === tid && m.kind === "request")).toBe(true);
    expect(channel.some((m) => m.threadId === tid)).toBe(false);
    const thread = chat.thread("backend", tid);
    expect(thread.map((m) => m.kind)).toEqual(["mention"]);
    const sum = chat.threads("backend").find((t) => t.id === tid)!;
    expect(sum).toMatchObject({ count: 1, users: [{ name: "willnew", bot: true }] });
    expect(sum.replies[0].mentions).toEqual(["이해준"]);
  });

  it("replies go to the thread (and stream on its topic); 채널에도 보내기 shows them in both; @willnew in a reply is just a message", async () => {
    const { chat, requests } = chatWith();
    const { message: root } = await chat.post("backend", "이해준", "배포는 금요일에 할게요", "platform");
    const heard: ChatMessage[] = [];
    chat.bus.on(`thread:backend:${root.id}`, (m: ChatMessage) => heard.push(m));
    const before = requests.list().length;
    const { message: r1 } = await chat.post("backend", "한지우", "@이해준 넵 @willnew 그 전에 시안 한 번 더 볼게요", "platform", undefined, "디자인", undefined, false, { id: root.id });
    const { message: r2 } = await chat.post("backend", "이해준", "좋아요", "platform", undefined, undefined, undefined, false, { id: root.id, broadcast: true });
    expect(requests.list()).toHaveLength(before);
    expect(r1).toMatchObject({ threadId: root.id });
    expect(heard.map((m) => m.id)).toEqual([r1.id, r2.id]);
    expect(chat.list("backend").some((m) => m.id === r1.id)).toBe(false);
    expect(chat.list("backend").some((m) => m.id === r2.id)).toBe(true);
    expect(chat.thread("backend", root.id).map((m) => m.text)).toEqual(["@이해준 넵 @willnew 그 전에 시안 한 번 더 볼게요", "좋아요"]);
    const sum = chat.threads("backend").find((t) => t.id === root.id)!;
    expect(sum.users.map((u) => u.name)).toEqual(["이해준", "한지우"]);
    expect(sum.replies[0].mentions).toEqual(["이해준", "willnew"]);
    await expect(chat.post("backend", "한지우", "x", "platform", undefined, undefined, undefined, false, { id: "nope" })).rejects.toThrow("스레드를 찾을 수 없어요");
    await expect(chat.post("backend", "한지우", "x", "platform", undefined, undefined, undefined, false, { id: r1.id })).rejects.toThrow("스레드를 찾을 수 없어요");
  });

  it("the requester check talks in the thread: ask the requester, pass the boxes on, then ask the reviewer", async () => {
    const runs = stubRuns();
    const { llm } = fakeLlm({ brief: [J(BRIEF_NO_Q)], spec: [J(SPEC)] });
    const requests = new RequestManager(runs as never, { planner: createPlanner(() => llm), proposer: fakeProposer().fn, visual: null });
    const chat = new Chat(runs as never, makeRepo(), "npm test", ["이해준"], requests);
    const { requestId } = await chat.post("backend", "한지우", "@willnew 결제 버튼 여백", "platform", undefined, "디자인");
    await until(() => requests.get(requestId!)!.status === "proposed");
    await requests.decide(requestId!, { decision: "proceed", by: "이해준" });
    const r = runs.created[0];
    r.agents = [agent()];
    r.review = { status: "pending", agentId: "a1" };
    runs.bus.emit("any", { runId: r.id });
    runs.bus.emit("finished", r);
    await settle();
    const thread = () => chat.thread("backend", `req-${requestId}`);
    expect(thread().filter((m) => m.kind === "review")).toHaveLength(0);   // no reviewer mention yet
    const ask = thread().filter((m) => m.kind === "check").at(-1)!;
    expect(ask.bodies?.forRequester).toBe("@한지우 화면을 보고 의도대로인지 알려 주세요");
    requests.requesterCheck(requestId!, { verdict: "changes", by: "한지우", feedback: [{ screen: "Checkout", viewport: "mobile", rect: { x: 0, y: 0, w: 1, h: 0.2 }, note: "두 줄로 보여요" }] });
    expect(thread().at(-1)!.text).toBe("@이해준 한지우님이 다시 봐 달래요 (1곳)\n- Checkout (모바일): 두 줄로 보여요\n같은 브랜치에서 2번째 시도를 시작했어요");
    r.agents = [agent()];
    r.review = { status: "pending", agentId: "a1" };
    runs.bus.emit("any", { runId: r.id });
    requests.requesterCheck(requestId!, { verdict: "ok", by: "한지우" });
    await settle();
    expect(thread().at(-1)).toMatchObject({ kind: "review", text: "@이해준 검토 차례예요. 테스트 3개 통과, main과 충돌 없음" });
    expect(chat.list("backend").some((m) => m.kind === "check" || m.kind === "review")).toBe(false);
  });

  it("migrates stored messages into their request's thread on load", async () => {
    const runs = stubRuns();
    await runs.create({ requestId: "q-old" });   // r1 belongs to q-old
    const old: ChatMessage[] = [
      { id: "m1", channel: "data", ts: 1, user: "한지우", bot: false, text: "@willnew 버튼 여백" },
      { id: "req-q-old", channel: "data", ts: 2, user: "willnew", bot: true, text: "제안", kind: "request", requestId: "q-old" },
      { id: "m2", channel: "data", ts: 3, user: "한지우", bot: false, text: "여백: 16px", requestId: "q-old" },
      { id: "m3", channel: "data", ts: 4, user: "willnew", bot: true, text: "@이해준 검토 차례예요", kind: "review", runId: "r1" },
      { id: "m4", channel: "data", ts: 5, user: "willnew", bot: true, text: "바로 맡긴 일", kind: "review", runId: "r-direct" },
    ];
    mkdirSync(join(HOME, "chat"), { recursive: true });
    writeFileSync(join(HOME, "chat", "data.json"), JSON.stringify(old));
    writeFileSync(join(HOME, "requests", "q-old.json"), JSON.stringify(req({ id: "q-old", channel: "data", status: "code_review" })));
    const requests = new RequestManager(runs as never, { planner: createPlanner(() => null), proposer: null, visual: null });
    const chat = new Chat(runs as never, makeRepo(), "npm test", [], requests);
    expect(chat.list("data").map((m) => m.id)).toEqual(["m1", "req-q-old", "m4"]);
    expect(chat.thread("data", "req-q-old").map((m) => m.id)).toEqual(["m2", "m3"]);
    expect(requests.get("q-old")!.threadId).toBe("req-q-old");
    expect(JSON.parse(readFileSync(join(HOME, "chat", "data.json"), "utf8")).find((m: ChatMessage) => m.id === "m2").threadId).toBe("req-q-old");
  });
});
