// 금액 계산. 서버(주문 저장)와 브라우저(결제 화면)가 같이 쓴다.

export const SHIPPING_FEE = 3000;
export const FREE_SHIPPING_MIN = 30000;

export function lineTotal(line) {
  return line.price * line.qty;
}

export function subtotalOf(lines) {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}

export function getDiscount(subtotal, coupon) {
  if (!coupon) return 0;
  if (coupon.type === "percent") return Math.floor((subtotal * coupon.value) / 100);
  if (coupon.type === "fixed") return Math.min(coupon.value, subtotal);
  return 0;
}

export function applyCoupon(subtotal, coupon) {
  if (coupon && coupon.type === "percent") {
    return subtotal - Math.floor((subtotal * coupon.value) / 100);
  }
  return subtotal;
}

export function getShippingFee(amount) {
  if (amount === 0) return 0;
  return amount > FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE;
}

export function calculateTotals(lines, coupon) {
  const subtotal = subtotalOf(lines);
  const discount = getDiscount(subtotal, coupon);
  const shipping = getShippingFee(subtotal);
  const total = applyCoupon(subtotal, coupon) + shipping;
  return { subtotal, discount, shipping, total };
}
