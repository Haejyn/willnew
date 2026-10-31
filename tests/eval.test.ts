/**
 * 골든 세트와 평가 (src/eval/, ticket-plan.md F12). 골든 10건의 모양, none 과 fake 로 끝까지 도는지, Wilson 구간.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { caseText, loadGolden } from "../src/eval/golden.js";
import { reportMarkdown, runEval, totals, wilson } from "../src/eval/run.js";
import { REQUIRED } from "../src/server/tickets/fields.js";

process.env.WILLNEW_TRIAGE = "rules";
const root = resolve(".");
const cases = loadGolden(resolve("tests/golden"));

describe("골든 세트", () => {
  it("10건: shop 문의 5건 + 직접 만든 5건, 정답 칸과 출처 메모", () => {
    expect(cases).toHaveLength(10);
    expect(cases.filter((c) => c.source === "examples/shop").map((c) => c.textFile)).toEqual([
      "examples/shop/inquiries/01-coupon-total.md", "examples/shop/inquiries/02-shipping-fee.md", "examples/shop/inquiries/03-sold-out.md",
      "examples/shop/inquiries/04-order-complete-text.md", "examples/shop/inquiries/05-coupon-usage.md",
    ]);
    expect(cases.filter((c) => c.source === "synthetic")).toHaveLength(5);
    expect(cases.filter((c) => c.injection).map((c) => c.id)).toEqual(["06-injection"]);
    expect(cases.filter((c) => c.category === "question").map((c) => c.id)).toEqual(["05-coupon-usage", "10-usage-question"]);
    for (const c of cases) {
      expect(c.note.length).toBeGreaterThan(10);
      expect(caseText(c, root).trim().length).toBeGreaterThan(0);
      expect(Object.keys(c.fields).every((f) => (REQUIRED as readonly string[]).includes(f))).toBe(true);
      expect(Object.values(c.fields).every((f) => f!.keywords.length > 0)).toBe(true);
    }
  });

  it("Wilson 구간: 100건 중 80건이면 약 71~87%", () => {
    const [lo, hi] = wilson(80, 100)!;
    expect(lo).toBeCloseTo(0.711, 2);
    expect(hi).toBeCloseTo(0.867, 2);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(10, 10)![1]).toBe(1);
  });

  it("none 과 fake 로 10건 모두 spec_ready 까지, 외부 호출 0건", async () => {
    const none = await runEval({ mode: "none", cases, root });
    const fake = await runEval({ mode: "fake", cases, root });
    for (const r of [none, fake]) {
      expect(r.outside).toEqual([]);
      expect(r.cases.map((c) => c.status)).toEqual(Array(10).fill("spec_ready"));
      // 인젝션 표시는 규칙이라 두 모드가 같다
      expect(r.cases.find((c) => c.id === "06-injection")!.injectionFlagged).toBe(true);
    }
    const tn = totals(none.cases);
    const tf = totals(fake.cases);
    expect(tn.schemaCalls).toBe(0);
    expect(tf.schemaCalls).toBeGreaterThan(0);
    // 양식 모드는 예산 5개를 다 쓴다. 정해진 응답이 칸을 먼저 채우면 덜 묻는다
    expect(Number(tn.questions)).toBe(5);
    expect(Number(tf.questions)).toBeLessThan(5);
    const md = reportMarkdown([none, fake], "2026-10-31");
    expect(md).toContain("신뢰구간이 넓다");
    expect(md).toContain("## 비교");
    expect(md).toContain("95% 구간 (Wilson)");
    expect(md).not.toContain("걸린 시간 (초)");
  });

  it("ollama 결과에는 pace, 걸린 시간, 쉰 시간 합, 최고 GPU 온도가 붙는다", async () => {
    const fake = await runEval({ mode: "fake", cases: cases.slice(0, 1), root });
    const md = reportMarkdown([{ ...fake, mode: "ollama", timing: { pace: "gentle", seconds: 61.24, restSeconds: 30.5, maxGpuC: 78 } }], "2026-10-31");
    expect(md).toContain("pace `gentle`.");
    expect(md).toContain("| 걸린 시간 (초) | 61.2 | |");
    expect(md).toContain("| 쉰 시간 합 (초) | 30.5 | |");
    expect(md).toContain("| 최고 GPU 온도 | 78°C | |");
    expect(reportMarkdown([{ ...fake, mode: "ollama", timing: { pace: "fast", seconds: 1, restSeconds: 0 } }], "d")).toContain("| 최고 GPU 온도 | 못 읽음 | |");
  });
});
