/**
 * GPU temperature for pacing local Ollama calls. Read with nvidia-smi; without it (AMD, Apple, integrated graphics)
 * the temperature is unknown and pacing falls back to plain work-then-rest. Not knowing never makes anything slower.
 */
import { execFile } from "node:child_process";

/** From this temperature the rest ratio doubles. */
export const HOT_C = 80;
const CACHE_MS = 5_000;

let cache: { at: number; c?: number } | undefined;
let injected: number | null | undefined;
/** Tests set a temperature so the real GPU is never read. null means unknown; undefined goes back to nvidia-smi. */
export function __setGpuTempForTest(c?: number | null): void {
  injected = c;
  cache = undefined;
}

/** GPU temperature in °C, undefined when it cannot be read. Cached 5 s and limited to 2 s so per-call reads stay cheap. */
export async function gpuTempC(): Promise<number | undefined> {
  if (injected !== undefined) return injected ?? undefined;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.c;
  const c = await new Promise<number | undefined>((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"], { timeout: 2_000, windowsHide: true }, (err, out) => {
      const n = Number(String(out ?? "").trim().split(/\r?\n/)[0]);
      resolve(err || !Number.isFinite(n) || n <= 0 ? undefined : n);
    });
  });
  cache = { at: Date.now(), c };
  return c;
}

/** Multiplier on the rest ratio: 2 when hot, 1 when not or unknown. */
export function restFactor(tempC?: number): number {
  return tempC !== undefined && tempC >= HOT_C ? 2 : 1;
}
