/**
 * Pacing for local Ollama calls. "gentle" rests as long as each call worked (times 2 when the GPU is hot), so the GPU
 * runs at about half load and a long batch takes about twice as long. Cloud providers do not heat this machine and
 * never rest; "fast" never rests either.
 */
import { loadAiConfig } from "./config.js";
import { gpuTempC } from "./thermal.js";
import type { AiConfig } from "./types.js";

export type AiPace = "gentle" | "fast";
export const AI_PACES: readonly AiPace[] = ["gentle", "fast"];

const REST_RATIO = 1;
/** One rest is at most this (times the heat factor), so a slow CPU call does not look like a stall. */
const REST_MAX_MS = 30_000;
/** Rest left over beyond one rest carries to the next, up to this, so one very long call cannot make the queue rest forever. */
const CARRY_MAX_MS = 120_000;

/**
 * Rest after one call: work time × ratio × heat factor plus what was carried. At most REST_MAX_MS × factor now, the
 * rest carries over (without carrying, a 45 s call rested 30 s and the duty went past 50%). Fast or cloud: none, carry dropped.
 */
export function planRest(workMs: number, carryMs: number, pace: AiPace, local: boolean, factor = 1): { restMs: number; carryMs: number } {
  if (pace === "fast" || !local) return { restMs: 0, carryMs: 0 };
  const want = Math.max(0, Math.round(workMs * REST_RATIO * factor)) + Math.max(0, carryMs);
  const now = Math.min(REST_MAX_MS * factor, want);
  return { restMs: now, carryMs: Math.min(CARRY_MAX_MS, want - now) };
}

/** Stop at this temperature and wait until it drops below the resume one. */
const HOT_STOP_C = 80;
const HOT_RESUME_C = 75;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** At 80°C or more, wait in place until the GPU is below 75°C. Unknown temperature never waits. True when it waited. */
export async function holdWhileHot(
  state: { hot?: boolean; resting?: boolean },
  read: () => Promise<number | undefined> = gpuTempC,
  wait: (ms: number) => Promise<void> = sleep,
  waitMs = 5_000,
): Promise<boolean> {
  if (((await read()) ?? 0) < HOT_STOP_C) return false;
  state.hot = true;
  state.resting = true;
  try {
    while (((await read()) ?? 0) >= HOT_RESUME_C) await wait(waitMs);
  } finally {
    state.resting = false;
  }
  return true;
}

/** WILLNEW_AI_PACE first (for measuring scripts), then `ai.pace` in config.json, else gentle. */
export function currentPace(config?: AiConfig): AiPace {
  const env = process.env.WILLNEW_AI_PACE;
  if (env === "fast" || env === "gentle") return env;
  return (config ?? loadAiConfig().config).pace === "fast" ? "fast" : "gentle";
}
