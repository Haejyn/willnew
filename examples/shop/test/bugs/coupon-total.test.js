import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTotals } from "../../src/pricing.js";
import { coupon, line } from "../helpers.js";

test("정액 쿠폰을 적용하면 최종 결제 금액이 할인만큼 줄어든다", () => {
  const totals = calculateTotals([line(5, 2)], coupon("WELCOME5000"));
  assert.equal(totals.discount, 5000);
  assert.equal(totals.total, 45000);
});

test("최종 결제 금액은 상품 금액 - 할인 + 배송비", () => {
  for (const code of ["WELCOME5000", "SALE10"]) {
    const t = calculateTotals([line(5, 2), line(6, 1)], coupon(code));
    assert.equal(t.total, t.subtotal - t.discount + t.shipping, code);
  }
});
