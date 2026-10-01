import { describe, expect, it } from "vitest";
import { rulesTriage } from "../src/server/triage.js";

describe("triage by rules (LLM fallback)", () => {
  it("routes by keywords and keeps the request in the worker instruction", () => {
    const t = rulesTriage("@willnew duration 테스트가 깨져요. 고쳐주세요", "npm test");
    expect(t).toMatchObject({ by: "rules", template: "bugfix", check: "npm test" });
    expect(t.task).toContain("duration 테스트가 깨져요");
    expect(t.task).not.toContain("@willnew");
  });
  it("picks docs work without a check command", () => {
    expect(rulesTriage("@willnew README 문서 정리 부탁해요", "npm test")).toMatchObject({ template: "docs", check: "npm test" });
  });
});
