import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { askJson, checkBrief, checkDecline, checkProposal, checkSpec, createPlanner, extractJson, type LlmCall } from "../src/server/brief.js";
import { buildRunTask, canTransition, cardBodies, moveTo, parseAttachments, statusFromRun, transition, withConstraint } from "../src/server/request-state.js";
import type { AgentRun, ChatMessage, Request, Run } from "../src/server/types.js";

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
  };
}

const fakeProposer = (reply = J(PROPOSAL)) => {
  const seen: string[] = [];
  const fn = async (_prompt: string, cwd: string) => { seen.push(cwd); return { text: reply, costUsd: 0.05 }; };
  return { fn, seen };
};

function manager(opts: { brief?: unknown; decline?: string[] } = {}) {
  const runs = stubRuns();
  const { llm, prompts } = fakeLlm({ brief: [J(opts.brief ?? BRIEF)], spec: [J(SPEC)], decline: opts.decline ?? [J(DECLINE)] });
  const repo = makeRepo();
  const m = new RequestManager(runs as never, { planner: createPlanner(() => llm), proposer: fakeProposer().fn });
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
    const { m, id, runs } = await proposed();
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
    const answer = chat.list("backend").at(-1)!;
    expect(answer).toMatchObject({ user: "한지우", bot: false, userTitle: "디자인", text: "버튼 안쪽 여백: 넉넉하게 (16px)" });
    await requests.answer(requestId!, { questionId: "q2", answer: "네", by: "한지우" });
    await until(() => requests.get(requestId!)!.status === "proposed");
    await settle();

    expect(cards()).toHaveLength(1);   // replaced in place
    expect(cards()[0].bodies).toEqual({ forRequester: "개발자가 제안을 보고 있어요 (이해준)", forDeveloper: `제안: ${PROPOSAL.summary}` });
    const mention = chat.list("backend").find((m: ChatMessage) => m.kind === "mention")!;
    expect(mention.text).toBe(`@이해준 확인할 제안이 있어요. ${PROPOSAL.summary}`);
    expect(mention.bodies?.forRequester).toBe("이해준님께 확인을 부탁했어요");
    expect(mention.bodies?.forRequester).not.toMatch(/tsx|space-|lg/);
  });

  it("the decline explanation goes to the requester from the developer, through willnew", async () => {
    const { chat, requests } = chatWith(BRIEF_NO_Q);
    const { requestId } = await chat.post("backend", "한지우", "@willnew 결제 완료 화면에 폭죽 넣어주세요", "platform");
    await until(() => requests.get(requestId!)!.status === "proposed");
    await requests.decide(requestId!, { decision: "decline", by: "이해준", text: "A/B 측정 중" });
    const last = chat.list("backend").at(-1)!;
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
