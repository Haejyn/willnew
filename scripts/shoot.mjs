// 스크린샷·프레임 캡처 — 원격 디버깅 크롬을 CDP 로 직접 조작한다 (실시간 스트림이 열려 있어도 끝난다).
//   node scripts/shoot.mjs shot <url> <out.png> [width height]
//   node scripts/shoot.mjs frames <url> <outDir> <seconds> [fps] [width height]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const [mode, url, out, a3, a4, a5, a6] = process.argv.slice(2);
const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "willnew-shot-"));
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) pending.get(m.id)(m.result);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

const isFrames = mode === "frames";
const [w, h] = isFrames ? [Number(a5 ?? 1280), Number(a6 ?? 720)] : [Number(a3 ?? 1440), Number(a4 ?? 900)];
await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(3500);

const grab = async (file) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
};

if (mode === "shot") {
  await grab(out);
} else if (isFrames) {
  mkdirSync(out, { recursive: true });
  const seconds = Number(a3);
  const fps = Number(a4 ?? 1);
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) {
    await grab(join(out, `f${String(i).padStart(4, "0")}.png`));
    await sleep(1000 / fps);
  }
}
ws.close();
chrome.kill();
process.exit(0);
