/**
 * AI layer types (docs/design/m1-contract.md section 1). Every model call goes through one `Ai`: a provider per task,
 * one queue per process, schema output checked again with zod, and an `LlmRecord` for each call.
 */
import type { EventEmitter } from "node:events";
import type { ZodType } from "zod";
import type { LlmRecord } from "../types.js";
import type { AiPace } from "./pace.js";

export type { AiPace };

export type { LlmRecord };

export type LlmTask = "classify" | "extract" | "ask" | "draft" | "review" | "relay" | "embed" | "judge";
export const LLM_TASKS: readonly LlmTask[] = ["classify", "extract", "ask", "draft", "review", "relay", "embed", "judge"];

export interface Msg { role: "system" | "user" | "assistant"; content: string }

export type ProviderId = "ollama" | "anthropic" | "openai" | "gemini";
export const PROVIDER_IDS: readonly ProviderId[] = ["ollama", "anthropic", "openai", "gemini"];

export interface ChatRequest {
  model: string;
  messages: Msg[];
  /** JSON schema the reply must follow (Ollama `format`) */
  schema?: object;
  stream?: boolean;
  /** Ollama `num_predict`; the default cap is 2048 with a schema, 4096 without */
  maxTokens?: number;
  /** without one, Ollama calls stop after 180 s */
  signal?: AbortSignal;
}

export interface ChatChunk { text: string; done?: boolean; usage?: { input: number; output: number } }

export interface Provider {
  id: ProviderId;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  embed?(texts: string[], model: string): Promise<number[][]>;
  health(): Promise<AiHealth>;
}

export interface AiHealth {
  state: "not_installed" | "stopped" | "no_model" | "ready";
  models: { name: string; digest: string }[];
  note?: string;
}

/** Which provider and model one task uses. */
export interface AiRoute { provider: ProviderId; model: string }

/** The `ai` section of `~/.willnew/config.json`. */
export interface AiConfig {
  routing?: Partial<Record<LlmTask, AiRoute>>;
  /** calls running at once (default 1) */
  concurrency?: number;
  /** false turns AI off (form mode) even when Ollama is ready */
  enabled?: boolean;
  /** local Ollama calls: "gentle" rests as long as each call worked (default), "fast" never rests */
  pace?: AiPace;
}

/** `GET /api/ai/status`. `routing` is what each task resolves to right now (null: no model for it). Never holds key values. */
export type AiStatus = AiHealth & {
  enabled: boolean;
  queue: number;
  routing: Record<LlmTask, AiRoute | null>;
  pace: AiPace;
  /** the queue is resting after a local call, or waiting for a hot GPU to cool */
  resting: boolean;
  /** the GPU was hot at the last reading (80°C or more) */
  hot: boolean;
  /** only when it could be read */
  gpuTempC?: number;
};

/** What the queue's pacing has done so far. */
export interface PaceStats {
  resting: boolean;
  hot: boolean;
  /** rest finished so far, including waiting for a hot GPU */
  restedMs: number;
  /** highest GPU temperature read, when any was read */
  maxGpuC?: number;
}

export interface AiQueue extends EventEmitter {
  /** jobs waiting plus jobs running (a slot held only for rest is not counted) */
  size(): number;
  pacing?(): PaceStats;
}

export interface Ai {
  /** Schema output. Checked again with zod and retried once on failure. Still failing, or no AI: null (the caller falls back to rules) */
  structured<T>(task: LlmTask, schema: ZodType<T>, messages: Msg[], opts?: { requestId?: string; promptVersion: string }): Promise<{ value: T | null; record: LlmRecord }>;
  /** Text. Streamed through onDelta */
  text(task: LlmTask, messages: Msg[], opts?: { requestId?: string; promptVersion: string; onDelta?: (s: string) => void }): Promise<{ text: string | null; record: LlmRecord }>;
  status(): Promise<AiStatus>;
  /** The queue. ("position", requestId, n) when a job's place changes: n jobs ahead of it, 0 once it runs */
  readonly queue: AiQueue;
  /** false in form mode (Ollama not ready, or turned off in config) */
  enabled(): Promise<boolean>;
}
