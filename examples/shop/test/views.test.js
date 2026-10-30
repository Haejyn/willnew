import { test } from "node:test";
import assert from "node:assert/strict";
import { cartView, checkoutView, orderComplete, ordersView, productDetail, productList } from "../src/views.js";
import { calculateTotals } from "../src/pricing.js";
import { buttonTag, coupon, line, product, products } from "./helpers.js";

test("목록에서 재고 0 상품은 품절로 보인다", () => {
  const html = productList(products);
  assert.equal(html.match(/class="badge">품절</g)?.length, 1);
  assert.match(html, /card sold-out[\s\S]*?캔버스 에코백/);
});

test("재고 있는 상품 상세는 장바구니 담기 버튼이 눌린다", () => {
  const tag = buttonTag(productDetail(product(1)), "add-to-cart");
  assert.ok(tag);
  assert.doesNotMatch(tag, /disabled/);
});

test("결제 화면에 금액 줄 네 개가 있다", () => {
  const lines = [line(5, 2)];
  const html = checkoutView(lines, calculateTotals(lines, coupon("SALE10")), coupon("SALE10"));
  assert.match(html, /<dd data-row="subtotal">50,000원<\/dd>/);
  assert.match(html, /<dd data-row="discount">-5,000원<\/dd>/);
  assert.match(html, /<dd data-row="shipping">무료<\/dd>/);
  assert.match(html, /<dd data-row="total">45,000원<\/dd>/);
  assert.match(html, /적용된 쿠폰: <strong>가을 10% 할인<\/strong>/);
});

test("빈 장바구니 안내", () => {
  assert.match(cartView([], calculateTotals([], null)), /장바구니가 비어 있어요/);
  assert.match(checkoutView([], calculateTotals([], null), null), /결제할 상품이 없어요/);
});

test("상품 이름은 이스케이프한다", () => {
  const html = productDetail({ id: 9, name: "<b>x</b>", price: 1000, stock: 1, description: "" });
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

const order = {
  id: "ORD-20261030-0001",
  createdAt: "2026-10-30T05:00:00.000Z",
  items: [line(1, 1), line(4, 2)],
  couponCode: null,
  totals: calculateTotals([line(1, 1), line(4, 2)], null),
};

test("주문 완료 화면에 주문번호와 최종 금액", () => {
  const html = orderComplete(order);
  assert.match(html, /ORD-20261030-0001/);
  assert.match(html, /<dd data-row="total">27,000원<\/dd>/);
});

test("내 주문 목록은 첫 상품 외 몇 건으로 줄인다", () => {
  assert.match(ordersView([order]), /도자기 머그컵 외 1건/);
  assert.match(ordersView([]), /아직 주문이 없어요/);
});
