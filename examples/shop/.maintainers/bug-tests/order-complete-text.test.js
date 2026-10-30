import { test } from "node:test";
import assert from "node:assert/strict";
import { orderComplete } from "../../src/views.js";
import { calculateTotals } from "../../src/pricing.js";
import { line } from "../../test/helpers.js";

test("주문 완료 화면 제목은 '주문이 완료되었습니다'", () => {
  const lines = [line(1, 1)];
  const order = {
    id: "ORD-20261030-0001",
    createdAt: "2026-10-30T05:00:00.000Z",
    items: lines,
    totals: calculateTotals(lines, null),
  };
  const html = orderComplete(order);
  assert.match(html, /<h1>주문이 완료되었습니다<\/h1>/);
  assert.doesNotMatch(html, /읍니다/);
});
