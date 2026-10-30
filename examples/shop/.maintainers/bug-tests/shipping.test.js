import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTotals, SHIPPING_FEE } from "../../src/pricing.js";
import { coupon, line } from "../../test/helpers.js";

test("상품 금액이 정확히 30,000원이면 배송비 무료", () => {
  const totals = calculateTotals([line(2, 2)], null);
  assert.equal(totals.subtotal, 30000);
  assert.equal(totals.shipping, 0);
});

test("배송비는 할인 후 금액으로 판단한다", () => {
  // 31,000원에서 10% 할인하면 27,900원. 3만 원 미만이라 배송비가 붙는다.
  const totals = calculateTotals([line(4, 1), line(5, 1)], coupon("SALE10"));
  assert.equal(totals.subtotal, 31000);
  assert.equal(totals.discount, 3100);
  assert.equal(totals.shipping, SHIPPING_FEE);
});
