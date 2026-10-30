import { readFileSync } from "node:fs";

export const products = JSON.parse(readFileSync(new URL("../data/products.json", import.meta.url), "utf8"));
export const coupons = JSON.parse(readFileSync(new URL("../data/coupons.json", import.meta.url), "utf8"));

export const product = (id) => products.find((p) => p.id === id);
export const coupon = (code) => coupons.find((c) => c.code === code);

// 상품 id 와 수량으로 결제 줄을 만든다.
export function line(id, qty) {
  const p = product(id);
  return { id: p.id, name: p.name, price: p.price, qty };
}

// 버튼 태그만 잘라 낸다.
export function buttonTag(html, id) {
  const m = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
  return m ? m[0] : null;
}
