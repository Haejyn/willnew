/**
 * Cloud providers (anthropic, openai, gemini) come in M3. Until then each id has a placeholder that never calls out:
 * chat throws and health says it is not supported yet, so a task routed to one falls back to rules.
 */
import type { AiHealth, ChatChunk, Provider, ProviderId } from "./types.js";

export const notSupported = (id: ProviderId) => `${id} 는 아직 지원하지 않아요. 지금은 ollama 만 돼요`;

export class UnsupportedProvider implements Provider {
  constructor(readonly id: Exclude<ProviderId, "ollama">) {}

  async *chat(): AsyncIterable<ChatChunk> {
    throw new Error(notSupported(this.id));
  }

  async health(): Promise<AiHealth> {
    return { state: "not_installed", models: [], note: notSupported(this.id) };
  }
}
