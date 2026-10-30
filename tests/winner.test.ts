import { describe, expect, it } from "vitest";
import type { AgentRun, CheckStatus, Run } from "../src/server/types.js";
import { suggestWinner as serverWinner } from "../src/server/runs.js";
import { suggestWinner as webWinner, winnerReason } from "../web/src/util.ts";

const result = (id: string, check: CheckStatus, durationMs: number, overrides: Partial<AgentRun> = {}): AgentRun => ({
  id, label: id, status: "done", check: { status: check, exitCode: null, output: "" },
  diff: { files: 1, insertions: 1, deletions: 0, patch: "", testsTouched: [] },
  durationMs, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0.1 }, ...overrides,
}) as AgentRun;
const runOf = (...agents: AgentRun[]) => ({ agents, review: { status: "none" } }) as Run;
const expectWinner = (run: Run, id: string | null) => {
  expect(serverWinner(run)?.id ?? null).toBe(id);
  expect(webWinner(run)).toBe(id);
};

describe("winner recommendation and explanation", () => {
  it("a manually selected failed result is never described as passed", () => {
    const broken = result("broken", "failed", 10);
    for (const agents of [[broken], [broken, result("checked", "passed", 40)], [broken, result("unchecked", "skipped", 40)]]) {
      const run = runOf(...agents);
      run.review = { status: "pending", agentId: broken.id };
      expect(webWinner(run)).toBe("broken");
      expect(winnerReason(run, "broken")).toBe("이 결과는 검증에 실패했어요.");
    }
  });

  it("legacy results without a check are excluded without throwing", () => {
    const legacy = result("legacy", "passed", 1, { check: undefined });
    expectWinner(runOf(legacy), null);
    expectWinner(runOf(legacy, result("unchecked", "skipped", 40)), "unchecked");
    expectWinner(runOf(legacy, result("checked", "passed", 50)), "checked");
  });

  it("a manually selected legacy result is not described as passed", () => {
    const run = runOf(result("legacy", "passed", 10, { check: undefined }));
    run.review = { status: "pending", agentId: "legacy" };
    expect(webWinner(run)).toBe("legacy");
    expect(winnerReason(run, "legacy")).toBe("검증 기록이 없어요.");
  });

  it.each(["passed", "skipped"] as const)("%s candidates use the fastest time for the cost window regardless of input order", (check) => {
    const priced = (id: string, durationMs: number, costUsd: number) => result(id, check, durationMs, {
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd },
    });
    const fast = priced("fast", 100, 0.3), near = priced("near", 109, 0.2), far = priced("far", 118, 0.1);
    for (const agents of [[fast, near, far], [fast, far, near], [near, fast, far], [near, far, fast], [far, fast, near], [far, near, fast]]) {
      expectWinner(runOf(...agents), "near");
    }
  });

  it("equal costs within the time window prefer the faster candidate", () => {
    expectWinner(runOf(result("near", "passed", 109), result("fast", "passed", 100)), "fast");
  });

  it.each(["queued", "running", "checking", "retrying", "failed", "cancelled"] as const)("%s results cannot enter the automatic recommendation", (status) => {
    for (const check of ["passed", "skipped"] as const) {
      expectWinner(runOf(result("unfinished", check, 1, { status }), result("unchecked", "skipped", 40)), "unchecked");
    }
  });

  it("results with no changes and failed checks cannot enter the recommendation", () => {
    const empty = result("empty", "passed", 1);
    empty.diff.files = 0;
    expectWinner(runOf(empty, result("unchecked", "skipped", 40)), "unchecked");
    expectWinner(runOf(empty, result("broken", "failed", 10)), null);
    expectWinner(runOf(), null);
  });

  it("check status takes priority over test edits and clean results win within that status", () => {
    const touched = (id: string, check: CheckStatus) => {
      const a = result(id, check, 1);
      a.diff.testsTouched = ["math.test.js"];
      return a;
    };
    expectWinner(runOf(touched("checked", "passed"), result("unchecked", "skipped", 40)), "checked");
    for (const check of ["passed", "skipped"] as const) {
      expectWinner(runOf(touched("edited", check), result("clean", check, 40)), "clean");
    }
  });

  it("the test edit explanation only blames eligible results with the same check status", () => {
    const winner = result("checked", "passed", 40);
    const skipped = result("unchecked", "skipped", 1);
    skipped.diff.testsTouched = ["math.test.js"];
    const unfinished = result("unfinished", "passed", 1, { status: "running" });
    unfinished.diff.testsTouched = ["math.test.js"];
    const empty = result("empty", "passed", 1);
    empty.diff.files = 0;
    empty.diff.testsTouched = ["math.test.js"];
    expect(winnerReason(runOf(winner, skipped, unfinished), winner.id)).toBe("검증을 통과한 건 이 결과뿐이에요.");
    expect(winnerReason(runOf(winner, empty), winner.id)).not.toContain("테스트를 고쳐서");
    const edited = result("edited", "passed", 1);
    edited.diff.testsTouched = ["math.test.js"];
    expect(winnerReason(runOf(winner, edited), winner.id)).toContain("edited 은 테스트를 고쳐서 뒤로 뺐어요.");
  });

  it("an existing review choice stays selected even when automatic ranking prefers a passed result", () => {
    const run = runOf(result("unchecked", "skipped", 1), result("checked", "passed", 40));
    expectWinner(run, "checked");
    run.review = { status: "pending", agentId: "unchecked" };
    expect(serverWinner(run)?.id).toBe("checked");
    expect(webWinner(run)).toBe("unchecked");
    expect(winnerReason(run, "unchecked")).toContain("검증 명령이 없어");
    expect(winnerReason(run, "unchecked")).not.toContain("통과");
  });
});
