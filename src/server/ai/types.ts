/**
 * AI layer types (docs/design/m1-contract.md section 1). Every model call goes through one `Ai`: a provider per task,
 * one queue per process, schema output checked again with zod, and an `LlmRecord` for each call.
 */
import type { EventEmitter } from "node:events";
import type { ZodType } from "zod";
import type { LlmRecord } from "../types.js";

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
}

/** `GET /api/ai/status`. `routing` is what each task resolves to right now (null: no model for it). Never holds key values. */
export type AiStatus = AiHealth & { enabled: boolean; queue: number; routing: Record<LlmTask, AiRoute | null> };

export interface AiQueue extends EventEmitter {
  /** jobs waiting plus jobs running */
  size(): number;
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
