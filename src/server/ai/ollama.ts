/**
 * Ollama over its HTTP API: /api/chat (streamed NDJSON, `format` = JSON schema), /api/embed, /api/tags (names and
 * digests). When the server does not answer, the executable decides between "stopped" and "not_installed".
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AiHealth, ChatChunk, ChatRequest, Provider } from "./types.js";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
export const OLLAMA_DOWNLOAD = "https://ollama.com/download";

/**
 * `OLLAMA_HOST` read the way Ollama reads it: without a scheme it is http and the port defaults to 11434
 * (`0.0.0.0:11434`, `localhost`); with a scheme the scheme's own port applies. 0.0.0.0 (listen on all) is dialed as 127.0.0.1.
 */
export function ollamaBaseUrl(host?: string): string {
  const h = (host ?? "").trim();
  if (!h) return DEFAULT_OLLAMA_HOST;
  const schemeless = !/^https?:\/\//i.test(h);
  const u = new URL(schemeless ? `http://${h}` : h);
  if (schemeless && !/^[^/]*:\d+/.test(h)) u.port = "11434";
  if (u.hostname === "0.0.0.0") u.hostname = "127.0.0.1";
  return u.toString().replace(/\/+$/, "");
}

/** The Ollama executable: the Windows install folder, the mac app, or `ollama` on PATH. Null when none. */
export function findOllama(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const candidates: string[] = [];
  if (platform === "win32" && env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"));
  if (platform === "darwin") candidates.push("/Applications/Ollama.app");
  const names = platform === "win32" ? ["ollama.exe", "ollama"] : ["ollama"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) if (dir) for (const n of names) candidates.push(join(dir, n));
  return candidates.find((p) => existsSync(p)) ?? null;
}

const isLocal = (base: string) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(base).hostname);

async function failure(res: Response): Promise<Error> {
  let why = "";
  try {
    const body = await res.json() as { error?: string };
    why = body.error ?? "";
  } catch { /* not JSON */ }
  return new Error(`Ollama ${res.status}${why ? `: ${why}` : ""}`);
}

interface OllamaLine {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const toChunk = (line: OllamaLine): ChatChunk => {
  if (line.error) throw new Error(`Ollama: ${line.error}`);
  const chunk: ChatChunk = { text: line.message?.content ?? "" };
  if (line.done) {
    chunk.done = true;
    chunk.usage = { input: line.prompt_eval_count ?? 0, output: line.eval_count ?? 0 };
  }
  return chunk;
};

export class OllamaProvider implements Provider {
  readonly id = "ollama" as const;
  readonly baseUrl: string;
  private findBinary: () => string | null;
  private healthTimeoutMs: number;

  constructor(opts: { host?: string; findBinary?: () => string | null; healthTimeoutMs?: number } = {}) {
    this.baseUrl = ollamaBaseUrl(opts.host);
    this.findBinary = opts.findBinary ?? (() => findOllama());
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 2000;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const stream = req.stream ?? false;
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream };
    if (req.schema) body.format = req.schema;
    const res = await fetch(`${this.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: req.signal });
    if (!res.ok) throw await failure(res);
    if (!stream || !res.body) {
      yield toChunk(JSON.parse(await res.text()) as OllamaLine);
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield toChunk(JSON.parse(line) as OllamaLine);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield toChunk(JSON.parse(buf.trim()) as OllamaLine);
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: texts }) });
    if (!res.ok) throw await failure(res);
    const body = await res.json() as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) throw new Error("Ollama: embeddings 응답이 맞지 않아요");
    return body.embeddings;
  }

  async health(): Promise<AiHealth> {
    let tags: { models?: { name?: string; model?: string; digest?: string }[] };
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(this.healthTimeoutMs) });
      if (!res.ok) throw await failure(res);
      tags = await res.json() as typeof tags;
    } catch {
      if (isLocal(this.baseUrl) && !this.findBinary())
        return { state: "not_installed", models: [], note: `Ollama 가 설치돼 있지 않아요. ${OLLAMA_DOWNLOAD} 에서 받아 주세요` };
      return { state: "stopped", models: [], note: `Ollama 가 꺼져 있어요 (${this.baseUrl}). Ollama 를 켜 주세요` };
    }
    const models = (tags.models ?? [])
      .map((m) => ({ name: String(m.name ?? m.model ?? ""), digest: String(m.digest ?? "") }))
      .filter((m) => m.name);
    if (!models.length) return { state: "no_model", models, note: "받은 모델이 없어요. `ollama pull <모델 이름>` 으로 하나 받아 주세요" };
    return { state: "ready", models };
  }
}
