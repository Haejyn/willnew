import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTotals, getDiscount, getShippingFee, subtotalOf, SHIPPING_FEE } from "../src/pricing.js";
import { coupon, line } from "./helpers.js";

test("상품 금액은 가격 x 수량의 합", () => {
  assert.equal(subtotalOf([line(1, 2), line(4, 1)]), 30000);
});

test("빈 장바구니는 모두 0원", () => {
  assert.deepEqual(calculateTotals([], null), { subtotal: 0, discount: 0, shipping: 0, total: 0 });
});

test("쿠폰 없이 3만 원 미만이면 배송비가 붙는다", () => {
  const totals = calculateTotals([line(2, 1)], null);
  assert.deepEqual(totals, { subtotal: 15000, discount: 0, shipping: SHIPPING_FEE, total: 18000 });
});

test("쿠폰 없이 3만 원을 넘으면 배송비 무료", () => {
  const totals = calculateTotals([line(5, 2)], null);
  assert.deepEqual(totals, { subtotal: 50000, discount: 0, shipping: 0, total: 50000 });
});

test("정률 쿠폰은 상품 금액의 비율만큼 깎는다", () => {
  const totals = calculateTotals([line(5, 2)], coupon("SALE10"));
  assert.equal(totals.discount, 5000);
  assert.equal(totals.total, 45000);
});

test("정률 할인은 원 단위 아래를 버린다", () => {
  assert.equal(getDiscount(12345, { type: "percent", value: 10 }), 1234);
});

test("정액 쿠폰 할인액은 쿠폰 금액", () => {
  assert.equal(getDiscount(50000, coupon("WELCOME5000")), 5000);
});

test("정액 할인은 상품 금액을 넘지 않는다", () => {
  assert.equal(getDiscount(3000, coupon("WELCOME5000")), 3000);
});

test("배송비 기준 아래와 한참 위", () => {
  assert.equal(getShippingFee(29999), SHIPPING_FEE);
  assert.equal(getShippingFee(45000), 0);
});
