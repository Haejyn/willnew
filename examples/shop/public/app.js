import { calculateTotals } from "/src/pricing.js";
import { addItem, emptyCart, itemCount, removeItem, setCoupon, setQty, toLines } from "/src/cart.js";
import {
  cartView,
  checkoutView,
  notFound,
  orderComplete,
  ordersView,
  productDetail,
  productList,
} from "/src/views.js";

const CART_KEY = "shop.cart";
const app = document.getElementById("app");

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY));
    if (saved && Array.isArray(saved.items)) return { ...emptyCart(), ...saved };
  } catch {
    // 저장된 값이 없거나 깨졌으면 빈 장바구니로 시작
  }
  return emptyCart();
}

function saveCart(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // 저장 못 해도 화면은 계속 쓴다
  }
  updateCount(cart);
}

function updateCount(cart) {
  const n = itemCount(cart);
  document.getElementById("cart-count").textContent = n ? String(n) : "";
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "요청이 실패했어요.");
  return body;
}

async function loadCoupon(code) {
  if (!code) return null;
  try {
    return await api(`/api/coupons/${encodeURIComponent(code)}`);
  } catch {
    return null;
  }
}

async function showList() {
  const products = await api("/api/products");
  app.innerHTML = productList(products);
}

async function showDetail(id) {
  let product;
  try {
    product = await api(`/api/products/${id}`);
  } catch {
    app.innerHTML = notFound("상품을 찾을 수 없어요.");
    return;
  }
  app.innerHTML = productDetail(product);
  document.getElementById("add-to-cart").addEventListener("click", () => {
    const qty = Math.max(1, Math.floor(Number(document.getElementById("qty").value)) || 1);
    saveCart(addItem(loadCart(), product.id, qty));
    document.getElementById("notice").innerHTML = `장바구니에 담았어요. <a href="/cart">장바구니 보기</a>`;
  });
}

async function showCart() {
  const products = await api("/api/products");
  const cart = loadCart();
  const lines = toLines(cart, products);
  const coupon = await loadCoupon(cart.couponCode);
  app.innerHTML = cartView(lines, calculateTotals(lines, coupon));

  app.querySelectorAll(".line").forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelector(".line-qty").addEventListener("change", (e) => {
      saveCart(setQty(loadCart(), id, Math.floor(Number(e.target.value)) || 0));
      showCart();
    });
    row.querySelector(".remove").addEventListener("click", () => {
      saveCart(removeItem(loadCart(), id));
      showCart();
    });
  });
}

async function showCheckout(message = "") {
  const products = await api("/api/products");
  const cart = loadCart();
  const lines = toLines(cart, products);
  const coupon = await loadCoupon(cart.couponCode);
  app.innerHTML = checkoutView(lines, calculateTotals(lines, coupon), coupon, message);
  if (lines.length === 0) return;

  document.getElementById("coupon-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("coupon-code").value.trim();
    if (!code) return;
    const found = await loadCoupon(code);
    if (!found) {
      showCheckout("없는 쿠폰 코드예요.");
      return;
    }
    saveCart(setCoupon(loadCart(), found.code));
    showCheckout("쿠폰을 적용했어요.");
  });

  document.getElementById("remove-coupon")?.addEventListener("click", () => {
    saveCart(setCoupon(loadCart(), null));
    showCheckout();
  });

  document.getElementById("place-order").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const order = await api("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: cart.items, couponCode: cart.couponCode }),
      });
      saveCart(emptyCart());
      location.href = `/orders/${order.id}`;
    } catch (err) {
      e.target.disabled = false;
      document.getElementById("coupon-message").textContent = err.message;
    }
  });
}

async function showOrders() {
  app.innerHTML = ordersView(await api("/api/orders"));
}

async function showOrder(id) {
  try {
    app.innerHTML = orderComplete(await api(`/api/orders/${id}`));
  } catch {
    app.innerHTML = notFound("주문을 찾을 수 없어요.");
  }
}

async function route() {
  updateCount(loadCart());
  const path = location.pathname;
  let m;
  if (path === "/") return showList();
  if ((m = path.match(/^\/products\/(\d+)$/))) return showDetail(m[1]);
  if (path === "/cart") return showCart();
  if (path === "/checkout") return showCheckout();
  if (path === "/orders") return showOrders();
  if ((m = path.match(/^\/orders\/([A-Za-z0-9-]+)$/))) return showOrder(m[1]);
  app.innerHTML = notFound();
}

route().catch((err) => {
  app.innerHTML = notFound(err.message);
});
