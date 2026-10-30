import { test } from "node:test";
import assert from "node:assert/strict";
import { productDetail } from "../../src/views.js";
import { buttonTag, product } from "../../test/helpers.js";

test("재고 0 상품 상세에서는 장바구니 담기 버튼이 눌리지 않는다", () => {
  const tag = buttonTag(productDetail(product(3)), "add-to-cart");
  assert.ok(tag);
  assert.match(tag, /\bdisabled\b/);
});
