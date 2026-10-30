import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

let server;
let base;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (body) =>
  fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("화면 경로는 200", async () => {
  for (const path of ["/", "/products/1", "/cart", "/checkout", "/orders"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /text\/html/);
    await res.text();
  }
});

test("없는 상품과 없는 경로는 404", async () => {
  assert.equal((await fetch(`${base}/products/999`)).status, 404);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("공유 모듈만 내보낸다", async () => {
  assert.equal((await fetch(`${base}/src/pricing.js`)).status, 200);
  assert.equal((await fetch(`${base}/src/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/data/products.json`)).status, 404);
});

test("상품 API", async () => {
  const list = await (await fetch(`${base}/api/products`)).json();
  assert.equal(list.length, 6);
  const one = await (await fetch(`${base}/api/products/3`)).json();
  assert.equal(one.stock, 0);
});

test("쿠폰 조회는 대소문자를 가리지 않는다", async () => {
  const res = await fetch(`${base}/api/coupons/sale10`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, "SALE10");
  assert.equal((await fetch(`${base}/api/coupons/NOPE`)).status, 404);
});

test("주문하면 서버가 금액을 다시 계산하고 내 주문에 남는다", async () => {
  const res = await post({ items: [{ id: 5, qty: 2 }], couponCode: "SALE10" });
  assert.equal(res.status, 201);
  const order = await res.json();
  assert.match(order.id, /^ORD-\d{8}-0001$/);
  assert.deepEqual(order.totals, { subtotal: 50000, discount: 5000, shipping: 0, total: 45000 });

  const orders = await (await fetch(`${base}/api/orders`)).json();
  assert.equal(orders[0].id, order.id);
  assert.equal((await fetch(`${base}/orders/${order.id}`)).status, 200);
});

test("빈 주문과 없는 쿠폰은 400", async () => {
  assert.equal((await post({ items: [] })).status, 400);
  assert.equal((await post({ items: [{ id: 1, qty: 1 }], couponCode: "NOPE" })).status, 400);
});
