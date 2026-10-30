// 화면 HTML. 순수 함수라 브라우저와 테스트가 같이 쓴다.
import { escapeHtml as h, formatDate, won } from "./format.js";

export function isSoldOut(product) {
  return product.stock <= 0;
}

function thumb(product, size = "") {
  const hue = (product.id * 57) % 360;
  return `<div class="thumb ${size}" style="--hue:${hue}" aria-hidden="true">${h(product.name.slice(0, 1))}</div>`;
}

export function productList(products) {
  const cards = products
    .map((p) => {
      const soldOut = isSoldOut(p);
      return `<li class="card${soldOut ? " sold-out" : ""}">
  <a href="/products/${p.id}">
    ${thumb(p)}
    <span class="card-name">${h(p.name)}</span>
    <span class="card-price">${won(p.price)}</span>
    ${soldOut ? '<span class="badge">품절</span>' : ""}
  </a>
</li>`;
    })
    .join("\n");
  return `<h1>상품</h1>
<ul class="grid" data-view="product-list">
${cards}
</ul>`;
}

export function productDetail(product) {
  return `<a class="back" href="/">상품 목록</a>
<section class="detail" data-view="product-detail">
  ${thumb(product, "large")}
  <div class="detail-body">
    <h1>${h(product.name)}</h1>
    <p class="detail-price">${won(product.price)}</p>
    <p class="detail-desc">${h(product.description)}</p>
    <label class="qty">수량 <input id="qty" type="number" min="1" value="1"></label>
    <button id="add-to-cart" class="primary" data-id="${product.id}"${product.soldOut ? " disabled" : ""}>장바구니 담기</button>
    <p id="notice" class="notice" role="status"></p>
  </div>
</section>`;
}

export function amountRows(totals) {
  return `<dl class="amounts" data-view="amounts">
  <div class="row"><dt>상품 금액</dt><dd data-row="subtotal">${won(totals.subtotal)}</dd></div>
  <div class="row discount"><dt>할인</dt><dd data-row="discount">${won(-totals.discount)}</dd></div>
  <div class="row"><dt>배송비</dt><dd data-row="shipping">${totals.shipping === 0 ? "무료" : won(totals.shipping)}</dd></div>
  <div class="row total"><dt>최종 결제 금액</dt><dd data-row="total">${won(totals.total)}</dd></div>
</dl>`;
}

function lineRows(lines, editable) {
  return lines
    .map(
      (line) => `<li class="line" data-id="${line.id}">
  <span class="line-name">${h(line.name)}</span>
  ${
    editable
      ? `<input class="line-qty" type="number" min="0" value="${line.qty}" aria-label="${h(line.name)} 수량">`
      : `<span class="line-qty-text">${line.qty}개</span>`
  }
  <span class="line-price">${won(line.price * line.qty)}</span>
  ${editable ? '<button class="link remove">빼기</button>' : ""}
</li>`,
    )
    .join("\n");
}

export function cartView(lines, totals) {
  if (lines.length === 0) {
    return `<h1>장바구니</h1>
<p class="empty" data-view="cart">장바구니가 비어 있어요. <a href="/">상품 보러 가기</a></p>`;
  }
  return `<h1>장바구니</h1>
<section data-view="cart">
  <ul class="lines">
${lineRows(lines, true)}
  </ul>
  ${amountRows(totals)}
  <a class="button primary" href="/checkout">주문하기</a>
</section>`;
}

export function checkoutView(lines, totals, coupon, message = "") {
  if (lines.length === 0) {
    return `<h1>결제</h1>
<p class="empty" data-view="checkout">결제할 상품이 없어요. <a href="/">상품 보러 가기</a></p>`;
  }
  const couponBlock = coupon
    ? `<p class="coupon-applied">적용된 쿠폰: <strong>${h(coupon.name)}</strong> (${h(coupon.code)}) <button id="remove-coupon" class="link">빼기</button></p>`
    : "";
  return `<h1>결제</h1>
<section class="checkout" data-view="checkout">
  <h2>주문 상품</h2>
  <ul class="lines">
${lineRows(lines, false)}
  </ul>
  <h2>쿠폰</h2>
  <form id="coupon-form" class="coupon-form">
    <input id="coupon-code" name="code" placeholder="쿠폰 코드" autocomplete="off">
    <button type="submit">적용</button>
  </form>
  ${couponBlock}
  <p id="coupon-message" class="notice" role="status">${h(message)}</p>
  <h2>결제 금액</h2>
  ${amountRows(totals)}
  <button id="place-order" class="primary wide">${won(totals.total)} 결제하기</button>
</section>`;
}

export function orderComplete(order) {
  return `<section class="complete" data-view="order-complete">
  <h1>주문이 완료되었읍니다</h1>
  <p>주문번호 <strong>${h(order.id)}</strong></p>
  ${amountRows(order.totals)}
  <p class="muted">상품은 영업일 기준 2~3일 안에 출발합니다.</p>
  <div class="actions">
    <a class="button" href="/orders">내 주문 보기</a>
    <a class="button primary" href="/">쇼핑 계속하기</a>
  </div>
</section>`;
}

export function ordersView(orders) {
  if (orders.length === 0) {
    return `<h1>내 주문</h1>
<p class="empty" data-view="orders">아직 주문이 없어요.</p>`;
  }
  const rows = orders
    .map(
      (o) => `<li class="order">
  <a href="/orders/${h(o.id)}">
    <span class="order-id">${h(o.id)}</span>
    <span class="order-date">${formatDate(o.createdAt)}</span>
    <span class="order-items">${h(summary(o))}</span>
    <span class="order-total">${won(o.totals.total)}</span>
  </a>
</li>`,
    )
    .join("\n");
  return `<h1>내 주문</h1>
<ul class="orders" data-view="orders">
${rows}
</ul>`;
}

function summary(order) {
  const [first, ...rest] = order.items;
  if (!first) return "";
  return rest.length ? `${first.name} 외 ${rest.length}건` : first.name;
}

export function notFound(text = "페이지를 찾을 수 없어요.") {
  return `<section class="empty" data-view="not-found"><h1>${h(text)}</h1><p><a href="/">상품 목록으로</a></p></section>`;
}
