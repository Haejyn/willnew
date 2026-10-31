/**
 * `createAi`: the one door to models (docs/design/m1-contract.md section 1).
 *
 * - Each task resolves to a provider and model: `ai.routing` in config.json, else WILLNEW_LOCAL_MODEL
 *   (WILLNEW_LOCAL_EMBED_MODEL for embed), else the first model Ollama has. Embed has no first-model fallback,
 *   since the first model is usually a chat model.
 * - Every call waits in one queue. structured() turns the zod schema into Ollama `format`, checks the reply with zod
 *   again and retries once with the error; then null. text() streams through onDelta. No AI: null, never a throw.
 * - Calls to Ollama on this machine are paced (pace.ts, queue.ts): in "gentle" the queue rests after each one as long
 *   as it worked, and waits while the GPU is hot. Cloud providers and a remote Ollama never rest.
 * - On the first ready health check the digest of each task's model is compared with ai-state.json; a change shows
 *   in status().note for the rest of this process.
 */
import { z, type ZodType } from "zod";
import { UnsupportedProvider, notSupported } from "./cloud.js";
import { loadAiConfig, loadAiState, saveAiState } from "./config.js";
import { extractJson } from "./json.js";
import { loadKeys } from "./keys.js";
import { DEFAULT_OLLAMA_HOST, isLocal, OllamaProvider } from "./ollama.js";
import { currentPace } from "./pace.js";
import { Queue, type QueuePacing } from "./queue.js";
import { gpuTempC, HOT_C } from "./thermal.js";
import { LLM_TASKS, type Ai, type AiConfig, type AiHealth, type AiRoute, type AiStatus, type LlmRecord, type LlmTask, type Msg, type Provider, type ProviderId } from "./types.js";

export * from "./types.js";
export { extractJson, stripThink } from "./json.js";
export { loadKeys } from "./keys.js";
export { loadAiConfig } from "./config.js";
export { OllamaProvider, findOllama, ollamaBaseUrl } from "./ollama.js";
export { Queue, type QueuePacing } from "./queue.js";
export { currentPace, holdWhileHot, planRest } from "./pace.js";
export { gpuTempC, restFactor } from "./thermal.js";
export { UnsupportedProvider } from "./cloud.js";

/** How long a health check is reused by calls (status() always checks again). */
const HEALTH_TTL_MS = 2000;
export const DIGEST_CHANGED = "모델이 바뀌었어요. 평가를 다시 돌려 주세요";

const findModel = (h: AiHealth, name: string) => h.models.find((m) => m.name === name || m.name === `${name}:latest`);

/** The schema as Ollama `format` wants it: plain JSON schema without the `$schema` line. */
function jsonSchemaOf(schema: ZodType<unknown>): object | undefined {
  try {
    const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
    return rest;
  } catch {
    return undefined; // a schema JSON schema cannot express: zod still checks the reply
  }
}

const retryMessage = (error: string): Msg => ({
  role: "user",
  content: `Your previous reply was rejected: ${error.slice(0, 1500)}\nReply again with ONLY the JSON, fixing that.`,
});

/** What a stream has shown so far: nothing while a leading <think> block is open, the text after it once closed. */
function visible(acc: string): string {
  const s = acc.trimStart();
  if ("<think>".startsWith(s)) return "";
  if (!s.startsWith("<think>")) return acc;
  const end = s.indexOf("</think>");
  return end < 0 ? "" : s.slice(end + "</think>".length).trimStart();
}

export function createAi(opts: { config?: AiConfig; providers?: Partial<Record<ProviderId, Provider>>; pacing?: Partial<QueuePacing> } = {}): Ai {
  const loaded = opts.config ? { config: opts.config } : loadAiConfig();
  const config = loaded.config;
  const problem = "problem" in loaded ? loaded.problem : undefined;
  const keys = loadKeys();
  const providers: Record<ProviderId, Provider> = {
    ollama: opts.providers?.ollama ?? new OllamaProvider({ host: keys.OLLAMA_HOST }),
    anthropic: opts.providers?.anthropic ?? new UnsupportedProvider("anthropic"),
    openai: opts.providers?.openai ?? new UnsupportedProvider("openai"),
    gemini: opts.providers?.gemini ?? new UnsupportedProvider("gemini"),
  };
  const pacing: QueuePacing = { pace: () => currentPace(config), ...opts.pacing };
  const readTemp = pacing.read ?? gpuTempC;
  const queue = new Queue(config.concurrency ?? 1, pacing);
  const ollamaBase = (providers.ollama as { baseUrl?: string }).baseUrl ?? DEFAULT_OLLAMA_HOST;
  /** Only a call to Ollama on this machine heats this GPU. */
  const isLocalRoute = (r: AiRoute) => r.provider === "ollama" && isLocal(ollamaBase);
  let cached: { at: number; health: AiHealth } | undefined;
  let digestChecked = false;
  let digestNote: string | undefined;

  function resolve(task: LlmTask, h: AiHealth): AiRoute | null {
    const set = config.routing?.[task];
    if (set) return set;
    const fromEnv = task === "embed" ? keys.WILLNEW_LOCAL_EMBED_MODEL : keys.WILLNEW_LOCAL_MODEL;
    if (fromEnv) return { provider: "ollama", model: fromEnv };
    if (task === "embed") return null;
    const first = h.models[0];
    return first ? { provider: "ollama", model: first.name } : null;
  }

  /** Compare each task's digest with last time and remember this time. The note when any changed. */
  function checkDigests(h: AiHealth): string | undefined {
    const state = loadAiState();
    const changed = new Set<string>();
    let dirty = false;
    for (const task of LLM_TASKS) {
      const r = resolve(task, h);
      const m = r?.provider === "ollama" ? findModel(h, r.model) : undefined;
      if (!r || !m?.digest) continue;
      const prev = state.digests[task];
      if (prev && prev.digest !== m.digest) changed.add(r.model);
      if (!prev || prev.digest !== m.digest || prev.model !== r.model) {
        state.digests[task] = { model: r.model, digest: m.digest };
        dirty = true;
      }
    }
    if (dirty) {
      try {
        saveAiState(state);
      } catch { /* a read-only home: the note still shows */ }
    }
    return changed.size ? `${DIGEST_CHANGED} (${[...changed].join(", ")})` : undefined;
  }

  let inflight: Promise<AiHealth> | undefined;
  async function check(): Promise<AiHealth> {
    let h: AiHealth;
    try {
      h = await providers.ollama.health();
    } catch (e) {
      h = { state: "stopped", models: [], note: `Ollama 상태를 읽지 못했어요: ${(e as Error).message}` };
    }
    cached = { at: Date.now(), health: h };
    if (h.state === "ready" && !digestChecked) {
      digestChecked = true;
      digestNote = checkDigests(h);
    }
    return h;
  }
  /** Calls reuse a recent check and share one in flight; status() asks for a fresh one. */
  function health(fresh = false): Promise<AiHealth> {
    if (!fresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return Promise.resolve(cached.health);
    if (!fresh && inflight) return inflight;
    const p = check().finally(() => {
      if (inflight === p) inflight = undefined;
    });
    inflight = p;
    return p;
  }

  const on = (h: AiHealth) => config.enabled !== false && h.state === "ready";

  /** A route that can be called right now: an Ollama model that is there, or another provider (which says itself if it cannot). */
  const callable = (r: AiRoute, h: AiHealth) => (r.provider === "ollama" ? !!findModel(h, r.model) : true);

  function recordOf(task: LlmTask, r: AiRoute | null, h: AiHealth, promptVersion?: string): LlmRecord {
    return {
      task,
      provider: r?.provider ?? "none",
      model: r?.model ?? "",
      digest: r?.provider === "ollama" ? (findModel(h, r.model)?.digest ?? "") : "",
      tokens: 0,
      costUsd: !r || r.provider === "ollama" ? 0 : null,
      ms: 0,
      promptVersion: promptVersion ?? "",
    };
  }

  /** Where a call goes, or null when there is no AI for it. */
  async function prepare(task: LlmTask, promptVersion?: string) {
    const h = await health();
    const route = resolve(task, h);
    const record = recordOf(task, route, h, promptVersion);
    return { route: route && on(h) && callable(route, h) ? route : null, record };
  }

  const ai: Ai = {
    queue,

    async structured<T>(task: LlmTask, schema: ZodType<T>, messages: Msg[], o?: { requestId?: string; promptVersion: string }) {
      const { route, record } = await prepare(task, o?.promptVersion);
      if (!route) return { value: null, record };
      const format = jsonSchemaOf(schema as ZodType<unknown>);
      return queue.run(o?.requestId, async () => {
        const t0 = Date.now();
        let msgs = messages;
        let value: T | null = null;
        for (let attempt = 1; attempt <= 2 && value === null; attempt++) {
          let reply = "";
          let error: string;
          try {
            for await (const c of providers[route.provider].chat({ model: route.model, messages: msgs, schema: format, stream: false })) {
              reply += c.text;
              if (c.usage) record.tokens += c.usage.input + c.usage.output;
            }
            const parsed = schema.safeParse(extractJson(reply));
            if (parsed.success) {
              value = parsed.data;
              break;
            }
            error = z.prettifyError(parsed.error);
          } catch (e) {
            error = (e as Error).message;
            cached = undefined;
          }
          msgs = [...messages, ...(reply ? [{ role: "assistant" as const, content: reply }] : []), retryMessage(error)];
        }
        record.ms = Date.now() - t0;
        return { value, record };
      }, { local: isLocalRoute(route) });
    },

    async text(task: LlmTask, messages: Msg[], o?: { requestId?: string; promptVersion: string; onDelta?: (s: string) => void }) {
      const { route, record } = await prepare(task, o?.promptVersion);
      if (!route) return { text: null, record };
      return queue.run(o?.requestId, async () => {
        const t0 = Date.now();
        let acc = "";
        let shown = 0;
        let ok = true;
        try {
          for await (const c of providers[route.provider].chat({ model: route.model, messages, stream: true })) {
            acc += c.text;
            if (c.usage) record.tokens += c.usage.input + c.usage.output;
            const v = visible(acc);
            if (v.length > shown) {
              o?.onDelta?.(v.slice(shown));
              shown = v.length;
            }
          }
        } catch {
          ok = false;
          cached = undefined;
        }
        record.ms = Date.now() - t0;
        const text = visible(acc);
        return { text: ok && text.trim() ? text : null, record };
      }, { local: isLocalRoute(route) });
    },

    async status(): Promise<AiStatus> {
      const h = await health(true);
      const routing = {} as Record<LlmTask, AiRoute | null>;
      const missing = new Set<string>();
      const cloud = new Set<ProviderId>();
      for (const task of LLM_TASKS) {
        const r = resolve(task, h);
        routing[task] = r;
        if (r?.provider === "ollama" && h.state === "ready" && !findModel(h, r.model)) missing.add(r.model);
        if (r && r.provider !== "ollama") cloud.add(r.provider);
      }
      const notes = [
        problem,
        config.enabled === false ? "설정에서 AI 를 껐어요. 양식 모드로 돌아요" : undefined,
        h.note,
        missing.size ? `설정한 모델이 Ollama 에 없어요: ${[...missing].join(", ")}` : undefined,
        ...[...cloud].map(notSupported),
        digestNote,
      ].filter((n): n is string => !!n);
      const pace = await pacing.pace();
      // the GPU is read only when local calls are paced, so a cloud setup or "fast" never runs nvidia-smi
      let temp: number | undefined;
      if (pace === "gentle" && LLM_TASKS.some((t) => routing[t] && isLocalRoute(routing[t]!))) {
        try {
          temp = await readTemp();
        } catch { /* unknown */ }
      }
      const p = queue.pacing();
      return {
        state: h.state, models: h.models, ...(notes.length ? { note: notes.join("\n") } : {}), enabled: on(h), queue: queue.size(), routing,
        pace, resting: p.resting, hot: p.hot || (temp !== undefined && temp >= HOT_C), ...(temp !== undefined ? { gpuTempC: temp } : {}),
      };
    },

    async enabled() {
      return on(await health());
    },
  };
  return ai;
}
