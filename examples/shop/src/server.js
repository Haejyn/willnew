import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateTotals } from "./pricing.js";
import { toLines } from "./cart.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// 브라우저에 내보내는 파일. 이 목록에 없는 경로는 404.
const STATIC = {
  "/assets/app.js": "public/app.js",
  "/assets/style.css": "public/style.css",
  "/src/pricing.js": "src/pricing.js",
  "/src/cart.js": "src/cart.js",
  "/src/format.js": "src/format.js",
  "/src/views.js": "src/views.js",
};

function loadJson(file) {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
}

export function createStore() {
  return {
    products: loadJson("data/products.json"),
    coupons: loadJson("data/coupons.json"),
    orders: [],
  };
}

function orderId(store, now) {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = String(store.orders.length + 1).padStart(4, "0");
  return `ORD-${ymd}-${seq}`;
}

export function findCoupon(store, code) {
  if (!code) return null;
  const wanted = String(code).trim().toUpperCase();
  return store.coupons.find((c) => c.code === wanted) || null;
}

export function placeOrder(store, body, now = new Date()) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const cart = {
    items: items
      .map((item) => ({ id: Number(item.id), qty: Math.floor(Number(item.qty)) }))
      .filter((item) => Number.isFinite(item.id) && item.qty > 0),
  };
  const lines = toLines(cart, store.products);
  if (lines.length === 0) return { error: "주문할 상품이 없어요." };

  let coupon = null;
  if (body.couponCode) {
    coupon = findCoupon(store, body.couponCode);
    if (!coupon) return { error: "쓸 수 없는 쿠폰이에요." };
  }

  const order = {
    id: orderId(store, now),
    createdAt: now.toISOString(),
    items: lines,
    couponCode: coupon ? coupon.code : null,
    totals: calculateTotals(lines, coupon),
  };
  store.orders.unshift(order);
  return { order };
}

function send(res, status, body, type = TYPES[".json"]) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function sendShell(res, status = 200) {
  const html = await readFile(join(ROOT, "public/index.html"), "utf8");
  send(res, status, html, TYPES[".html"]);
}

async function handleApi(store, req, res, path) {
  const parts = path.split("/").filter(Boolean).slice(1);
  const [resource, id] = parts;

  if (req.method === "GET" && resource === "products" && !id) return send(res, 200, store.products);
  if (req.method === "GET" && resource === "products") {
    const product = store.products.find((p) => p.id === Number(id));
    return product ? send(res, 200, product) : send(res, 404, { error: "상품을 찾을 수 없어요." });
  }
  if (req.method === "GET" && resource === "coupons" && id) {
    const coupon = findCoupon(store, decodeURIComponent(id));
    return coupon ? send(res, 200, coupon) : send(res, 404, { error: "없는 쿠폰 코드예요." });
  }
  if (req.method === "GET" && resource === "orders" && !id) return send(res, 200, store.orders);
  if (req.method === "GET" && resource === "orders") {
    const order = store.orders.find((o) => o.id === id);
    return order ? send(res, 200, order) : send(res, 404, { error: "주문을 찾을 수 없어요." });
  }
  if (req.method === "POST" && resource === "orders" && !id) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "요청 형식이 잘못됐어요." });
    }
    const result = placeOrder(store, body);
    return result.error ? send(res, 400, { error: result.error }) : send(res, 201, result.order);
  }
  return send(res, 404, { error: "없는 API 예요." });
}

export function createApp(store = createStore()) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      if (path.startsWith("/api/")) return await handleApi(store, req, res, path);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "허용하지 않는 요청이에요." });

      if (STATIC[path]) {
        const file = STATIC[path];
        const body = await readFile(join(ROOT, file), "utf8");
        return send(res, 200, body, TYPES[extname(file)]);
      }

      if (path === "/" || path === "/cart" || path === "/checkout" || path === "/orders") return await sendShell(res);

      const product = path.match(/^\/products\/(\d+)$/);
      if (product) {
        const exists = store.products.some((p) => p.id === Number(product[1]));
        return await sendShell(res, exists ? 200 : 404);
      }

      const order = path.match(/^\/orders\/([A-Za-z0-9-]+)$/);
      if (order) {
        const exists = store.orders.some((o) => o.id === order[1]);
        return await sendShell(res, exists ? 200 : 404);
      }

      return await sendShell(res, 404);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "서버 오류가 났어요." });
      else res.end();
    }
  });
}
