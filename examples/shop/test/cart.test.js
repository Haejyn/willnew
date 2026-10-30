import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, emptyCart, itemCount, removeItem, setCoupon, setQty, toLines } from "../src/cart.js";
import { products } from "./helpers.js";

test("같은 상품을 다시 담으면 수량이 늘어난다", () => {
  let cart = addItem(emptyCart(), 1, 1);
  cart = addItem(cart, 1, 2);
  assert.deepEqual(cart.items, [{ id: 1, qty: 3 }]);
  assert.equal(itemCount(cart), 3);
});

test("수량을 0으로 바꾸면 빠진다", () => {
  const cart = setQty(addItem(emptyCart(), 2, 1), 2, 0);
  assert.deepEqual(cart.items, []);
});

test("장바구니에서 빼기", () => {
  const cart = removeItem(addItem(addItem(emptyCart(), 1), 2), 1);
  assert.deepEqual(cart.items, [{ id: 2, qty: 1 }]);
});

test("쿠폰은 하나만 남는다. 새 쿠폰을 넣으면 앞의 쿠폰을 바꾼다", () => {
  let cart = setCoupon(emptyCart(), "WELCOME5000");
  cart = setCoupon(cart, "SALE10");
  assert.equal(cart.couponCode, "SALE10");
  assert.equal(setCoupon(cart, null).couponCode, null);
});

test("결제 줄에는 상품 이름과 가격이 붙고 없는 상품은 빠진다", () => {
  const cart = { items: [{ id: 1, qty: 2 }, { id: 999, qty: 1 }], couponCode: null };
  assert.deepEqual(toLines(cart, products), [{ id: 1, name: "도자기 머그컵", price: 12000, qty: 2 }]);
});
