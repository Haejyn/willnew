/**
 * The `ai` section of `~/.willnew/config.json`, and `~/.willnew/ai-state.json` (the digest each task used last time).
 * Paths follow WILLNEW_HOME and are read when called, so tests can switch homes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LLM_TASKS, PROVIDER_IDS, type AiConfig, type LlmTask } from "./types.js";

const PACES = ["gentle", "fast"] as const;

export const willnewHome = () => process.env.WILLNEW_HOME ?? join(homedir(), ".willnew");

const Route = z.object({ provider: z.enum(PROVIDER_IDS), model: z.string().trim().min(1) });
const AiSection = z.object({
  routing: z.partialRecord(z.enum(LLM_TASKS), Route).optional(),
  concurrency: z.number().int().min(1).max(32).optional(),
  enabled: z.boolean().optional(),
  pace: z.enum(PACES).optional(),
});

/** The config, and a reason in Korean when the file or the section could not be used (the defaults apply then). */
export function loadAiConfig(home = willnewHome()): { config: AiConfig; problem?: string } {
  const file = join(home, "config.json");
  if (!existsSync(file)) return { config: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { config: {}, problem: "config.json 을 읽지 못해서 AI 기본 설정으로 돌아요" };
  }
  const ai = raw && typeof raw === "object" ? (raw as Record<string, unknown>).ai : undefined;
  if (ai === undefined) return { config: {} };
  const parsed = AiSection.safeParse(ai);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join(".") || "ai").join(", ");
    return { config: {}, problem: `config.json 의 ai 설정이 맞지 않아서 기본값으로 돌아요 (${where})` };
  }
  return { config: parsed.data as AiConfig };
}

export interface AiState {
  /** per task: the model and the digest it had last time */
  digests: Partial<Record<LlmTask, { model: string; digest: string }>>;
}

export const aiStatePath = (home = willnewHome()) => join(home, "ai-state.json");

export function loadAiState(home = willnewHome()): AiState {
  try {
    const v = JSON.parse(readFileSync(aiStatePath(home), "utf8"));
    if (v && typeof v === "object" && v.digests && typeof v.digests === "object") return { digests: v.digests };
  } catch { /* missing or broken: start over */ }
  return { digests: {} };
}

export function saveAiState(state: AiState, home = willnewHome()) {
  const file = aiStatePath(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}
