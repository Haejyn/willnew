/**
 * Before/after screenshots for 요청자 확인 (B2). Each screen in the spec is captured on the base preview (전) and on the
 * branch preview (후) in the same viewport: 1440x900, plus 390x844 when the spec mentions phones.
 *
 * The browser comes from playwright-core, an optional dependency. When it is not installed, or no browser can be
 * launched, nothing is captured and the result carries a note saying so. Tests pass a fake capturer.
 * Files live under <willnew home>/shots/<requestId>/<round>/ and are served through the API.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Screen, ShotPair, ViewportName } from "./types.js";

export interface Viewport {
  name: ViewportName;
  width: number;
  height: number;
}
export const DESKTOP: Viewport = { name: "desktop", width: 1440, height: 900 };
export const MOBILE: Viewport = { name: "mobile", width: 390, height: 844 };

/** Opens `url` at `viewport` and writes a PNG to `file`. */
export interface Capturer {
  shot(url: string, viewport: Viewport, file: string): Promise<void>;
  close(): Promise<void>;
}
/** null = no capturer on this machine; `note` says why. */
export type CapturerFactory = () => Promise<{ capturer: Capturer | null; note?: string }>;

const NO_PLAYWRIGHT = "playwright-core 가 설치돼 있지 않아 전후 스크린샷은 건너뛰었어요 (pnpm add -O playwright-core)";

/**
 * playwright-core with a browser that is already on the machine: WILLNEW_SHOTS_BROWSER (chrome, msedge, or a path to
 * the executable), then Chrome, then Edge, then the Chromium that `npx playwright install chromium` puts in its cache.
 */
export const playwrightCapturer: CapturerFactory = async () => {
  let pw: { chromium: { launch(o: Record<string, unknown>): Promise<any> } };
  try {
    const name = "playwright-core";
    pw = await import(/* @vite-ignore */ name);
  } catch {
    return { capturer: null, note: NO_PLAYWRIGHT };
  }
  const want = process.env.WILLNEW_SHOTS_BROWSER;
  const tries: Record<string, unknown>[] = [];
  if (want && /[\\/]/.test(want)) tries.push({ executablePath: want });
  else if (want) tries.push({ channel: want });
  tries.push({ channel: "chrome" }, { channel: "msedge" }, {});
  let browser: any = null;
  let last = "";
  for (const t of tries) {
    try {
      browser = await pw.chromium.launch({ headless: true, ...t });
      break;
    } catch (e) {
      last = (e as Error).message.split("\n")[0];
    }
  }
  if (!browser) return { capturer: null, note: `스크린샷용 브라우저를 열지 못했어요. WILLNEW_SHOTS_BROWSER 로 chrome, msedge 또는 실행 파일 경로를 알려 주세요 (${last.slice(0, 120)})` };
  return {
    capturer: {
      async shot(url, vp, file) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
        try {
          const page = await ctx.newPage();
          await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => page.waitForTimeout(1500));
          await page.waitForTimeout(400);
          await page.screenshot({ path: file });
        } finally {
          await ctx.close();
        }
      },
      close: () => browser.close(),
    },
  };
};

export interface CaptureInput {
  requestId: string;
  round: number;
  screens: Screen[];
  mobile: boolean;
  /** local base URLs, e.g. http://127.0.0.1:5174 ; a missing one is skipped with a note */
  before?: string;
  after?: string;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9가-힣_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "screen";
const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export class ShotService {
  readonly dir: string;
  constructor(dir: string, private factory: CapturerFactory = playwrightCapturer) {
    this.dir = resolve(dir);
  }

  /** The URL the web app loads a stored shot from. */
  static url(requestId: string, round: number, file: string) {
    return `/api/requests/${encodeURIComponent(requestId)}/shots/${round}/${encodeURIComponent(file)}`;
  }

  /** Capture every screen × viewport on both sides. One failing page does not stop the others; it carries `error`. */
  async capture(input: CaptureInput): Promise<{ shots: ShotPair[]; note?: string }> {
    const notes: string[] = [];
    if (!input.after && !input.before) return { shots: [], note: "미리보기가 뜨지 않아 스크린샷을 찍지 못했어요" };
    if (!input.before) notes.push("main 미리보기가 뜨지 않아 후 화면만 찍었어요");
    if (!input.after) notes.push("브랜치 미리보기가 뜨지 않아 전 화면만 찍었어요");
    const screens = input.screens.length ? input.screens : [{ name: "첫 화면", path: "/" }];
    const { capturer, note } = await this.factory();
    if (!capturer) return { shots: [], note: note ?? NO_PLAYWRIGHT };
    const out = join(this.dir, safe(input.requestId), String(input.round));
    mkdirSync(out, { recursive: true });
    const viewports = input.mobile ? [DESKTOP, MOBILE] : [DESKTOP];
    const shots: ShotPair[] = [];
    try {
      for (const s of screens)
        for (const vp of viewports) {
          const pair: ShotPair = { screen: s.name, path: s.path, viewport: vp.name, width: vp.width, height: vp.height };
          for (const side of ["before", "after"] as const) {
            const base = input[side];
            if (!base) continue;
            const file = `${safe(s.name)}-${vp.name}-${side}.png`;
            try {
              await capturer.shot(joinUrl(base, s.path), vp, join(out, file));
              pair[side] = ShotService.url(input.requestId, input.round, file);
            } catch (e) {
              pair.error = `${side === "before" ? "전" : "후"} 화면을 찍지 못했어요: ${(e as Error).message.split("\n")[0].slice(0, 120)}`;
            }
          }
          shots.push(pair);
        }
    } finally {
      await capturer.close().catch(() => undefined);
    }
    return { shots, note: notes.join(". ") || undefined };
  }

  /** Path of a stored shot, or null when the name does not point inside this request's folder. */
  file(requestId: string, round: string, name: string): string | null {
    if (!/^\d+$/.test(round) || !/^[\w가-힣-]+\.png$/.test(name)) return null;
    const p = resolve(this.dir, safe(requestId), round, name);
    return p.startsWith(this.dir) && existsSync(p) ? p : null;
  }
}
