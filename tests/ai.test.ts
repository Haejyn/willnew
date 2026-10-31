/**
 * AI layer against a fake Ollama (a local HTTP server). The real Ollama is never called: every Ai here gets an
 * OllamaProvider pointed at the fake or at a closed port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAi, extractJson, loadAiConfig, loadKeys, ollamaBaseUrl, OllamaProvider, Queue, type Msg } from "../src/server/ai/index.js";
import { hashToken, Members } from "../src/server/members.js";

// ---------------------------------------------------------------------------------------------- fake Ollama

interface Fake {
  url: string;
  /** bodies of POST /api/chat, in order */
  chats: any[];
  /** what /api/tags lists */
  models: { name: string; digest: string }[];
  /** replies for /api/chat, used in order (the last one repeats) */
  replies: (string | string[])[];
  close(): Promise<void>;
}

const servers: Server[] = [];

async function fakeOllama(models = [{ name: "qwen3:8b", digest: "sha-1" }]): Promise<Fake> {
  const fake = { chats: [] as any[], models, replies: [] as (string | string[])[] } as Fake;
  const read = (req: IncomingMessage) => new Promise<any>((r) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => r(s ? JSON.parse(s) : {}));
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ models: fake.models.map((m) => ({ ...m, model: m.name, size: 1 })) }));
    }
    if (req.url === "/api/embed") {
      const body = await read(req);
      return res.end(JSON.stringify({ model: body.model, embeddings: body.input.map((_: string, i: number) => [i, 0.5]) }));
    }
    if (req.url === "/api/chat") {
      const body = await read(req);
      fake.chats.push(body);
      const reply = fake.replies[Math.min(fake.chats.length - 1, fake.replies.length - 1)] ?? "";
      const parts = Array.isArray(reply) ? reply : [reply];
      if (!body.stream) {
        return res.end(JSON.stringify({ model: body.model, message: { role: "assistant", content: parts.join("") }, done: true, prompt_eval_count: 10, eval_count: 5 }));
      }
      res.setHeader("content-type", "application/x-ndjson");
      for (const p of parts) {
        res.write(JSON.stringify({ model: body.model, message: { role: "assistant", content: p }, done: false }) + "\n");
        await new Promise((r) => setTimeout(r, 5));
      }
      return res.end(JSON.stringify({ model: body.model, message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 7, eval_count: parts.length }) + "\n");
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake;
}

/** A port nothing listens on. */
async function closedPort(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

const provider = (host: string, binary: string | null = "/fake/ollama") => new OllamaProvider({ host, findBinary: () => binary, healthTimeoutMs: 500 });
const user = (content: string): Msg[] => [{ role: "user", content }];

// every test gets its own home and no AI variables from the shell
const ENV = ["WILLNEW_HOME", "OLLAMA_HOST", "WILLNEW_LOCAL_MODEL", "WILLNEW_LOCAL_EMBED_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];
let saved: Record<string, string | undefined>;
let home: string;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "willnew-ai-"));
  process.env.WILLNEW_HOME = home;
});
afterEach(async () => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

// ---------------------------------------------------------------------------------------------- tests

describe("Ollama provider", () => {
  it("reads OLLAMA_HOST the way Ollama does", () => {
    expect(ollamaBaseUrl()).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseUrl("0.0.0.0:11434")).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseUrl("localhost")).toBe("http://localhost:11434");
    expect(ollamaBaseUrl("http://10.0.0.5:9000/")).toBe("http://10.0.0.5:9000");
  });

  it("health: names and digests from /api/tags, no_model on an empty list", async () => {
    const fake = await fakeOllama([{ name: "qwen3:8b", digest: "sha-1" }, { name: "bge-m3:latest", digest: "sha-2" }]);
    expect(await provider(fake.url).health()).toEqual({ state: "ready", models: [{ name: "qwen3:8b", digest: "sha-1" }, { name: "bge-m3:latest", digest: "sha-2" }] });
    fake.models = [];
    expect(await provider(fake.url).health()).toMatchObject({ state: "no_model", models: [] });
  });

  it("health: stopped when it does not answer, not_installed when there is no executable", async () => {
    const url = await closedPort();
    expect(await provider(url, "/fake/ollama").health()).toMatchObject({ state: "stopped" });
    const missing = await provider(url, null).health();
    expect(missing.state).toBe("not_installed");
    expect(missing.note).toContain("https://ollama.com/download");
  });

  it("embed through /api/embed", async () => {
    const fake = await fakeOllama();
    expect(await provider(fake.url).embed(["가", "나"], "bge-m3")).toEqual([[0, 0.5], [1, 0.5]]);
  });
});

describe("extractJson", () => {
  it("finds the value inside fences, sentences and think blocks", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('여기요\n```json\n{"a":2}\n```\n끝')).toEqual({ a: 2 });
    expect(extractJson('네, {"a":"}{"} 입니다')).toEqual({ a: "}{" });
    expect(extractJson('<think>{"no":1}</think>{"a":3}')).toEqual({ a: 3 });
    expect(extractJson('목록: [1,2] 끝')).toEqual([1, 2]);
    expect(extractJson('{깨짐} 그리고 {"a":4}')).toEqual({ a: 4 });
    expect(() => extractJson("JSON 없음")).toThrow(/no JSON/);
  });
});

describe("createAi", () => {
  const Field = z.object({ question: z.string().min(1), choices: z.array(z.string()).min(2).max(4) });

  it("text streams through onDelta and keeps a record", async () => {
    const fake = await fakeOllama();
    fake.replies = [["안녕", "하세요", "."]];
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) } });
    const deltas: string[] = [];
    const r = await ai.text("relay", user("인사"), { promptVersion: "relay@1", onDelta: (s) => deltas.push(s) });
    expect(r.text).toBe("안녕하세요.");
    expect(deltas).toEqual(["안녕", "하세요", "."]);
    expect(fake.chats[0]).toMatchObject({ model: "qwen3:8b", stream: true });
    expect(fake.chats[0].format).toBeUndefined();
    expect(r.record).toMatchObject({ task: "relay", provider: "ollama", model: "qwen3:8b", digest: "sha-1", tokens: 10, costUsd: 0, promptVersion: "relay@1" });
  });

  it("chat turns thinking off and caps the output (2048 with a schema, 4096 without, or maxTokens)", async () => {
    const fake = await fakeOllama();
    fake.replies = ['{"ok":true}'];
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) } });
    await ai.structured("classify", z.object({ ok: z.boolean() }), user("x"), { promptVersion: "v" });
    await ai.text("relay", user("y"), { promptVersion: "v" });
    for await (const _ of provider(fake.url).chat({ model: "qwen3:8b", messages: user("z"), maxTokens: 64 })) { /* drain */ }
    expect(fake.chats.map((c) => [c.think, c.options])).toEqual([
      [false, { num_predict: 2048 }],
      [false, { num_predict: 4096 }],
      [false, { num_predict: 64 }],
    ]);
  });

  it("text hides a leading think block from the stream", async () => {
    const fake = await fakeOllama();
    fake.replies = [["<thi", "nk>생각 중</think>", "\n답이에요"]];
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) } });
    const deltas: string[] = [];
    const r = await ai.text("relay", user("x"), { promptVersion: "v", onDelta: (s) => deltas.push(s) });
    expect(r.text).toBe("답이에요");
    expect(deltas.join("")).toBe("답이에요");
  });

  it("structured sends the zod schema as format and returns the checked value", async () => {
    const fake = await fakeOllama();
    fake.replies = ['좋아요\n```json\n{"question":"어느 화면이에요","choices":["결제","장바구니"]}\n```'];
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) } });
    const r = await ai.structured("ask", Field, user("쿠폰이 안 돼요"), { promptVersion: "ask@1" });
    expect(r.value).toEqual({ question: "어느 화면이에요", choices: ["결제", "장바구니"] });
    expect(fake.chats).toHaveLength(1);
    expect(fake.chats[0].stream).toBe(false);
    expect(fake.chats[0].format).toMatchObject({ type: "object", properties: { question: { type: "string" }, choices: { type: "array" } } });
    expect(fake.chats[0].format.$schema).toBeUndefined();
    expect(r.record).toMatchObject({ task: "ask", provider: "ollama", digest: "sha-1", tokens: 15, promptVersion: "ask@1" });
  });

  it("structured retries once with the error after a bad reply", async () => {
    const fake = await fakeOllama();
    fake.replies = ['{"question":"","choices":["하나"]}', '{"question":"언제부터요","choices":["오늘","어제"]}'];
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) } });
    const r = await ai.structured("ask", Field, user("x"), { promptVersion: "v" });
    expect(r.value).toEqual({ question: "언제부터요", choices: ["오늘", "어제"] });
    expect(fake.chats).toHaveLength(2);
    const retry = fake.chats[1].messages as Msg[];
    expect(retry).toHaveLength(3);
    expect(retry[1]).toEqual({ role: "assistant", content: '{"question":"","choices":["하나"]}' });
    expect(retry[2].role).toBe("user");
    expect(retry[2].content).toMatch(/rejected/);
    expect(retry[2].content).toMatch(/choices/);
    expect(r.record.tokens).toBe(30);
  });

  it("structured gives null after two failures", async () => {
    const fake = await fakeOllama();
    fake.replies = ["JSON 이 아니에요", "{깨진"];
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) } });
    const r = await ai.structured("ask", Field, user("x"), { promptVersion: "v" });
    expect(r.value).toBeNull();
    expect(fake.chats).toHaveLength(2);
    expect(r.record.provider).toBe("ollama");
  });

  it("Ollama off: stopped, enabled false, null without throwing", async () => {
    const ai = createAi({ config: {}, providers: { ollama: provider(await closedPort()) } });
    expect(await ai.enabled()).toBe(false);
    const s = await ai.status();
    expect(s).toMatchObject({ state: "stopped", enabled: false, queue: 0, models: [] });
    expect(s.routing.ask).toBeNull();
    expect((await ai.structured("ask", Field, user("x"), { promptVersion: "v" })).value).toBeNull();
    expect((await ai.text("relay", user("x"))).text).toBeNull();
  });

  it("enabled: false in config keeps form mode even with Ollama ready", async () => {
    const fake = await fakeOllama();
    const ai = createAi({ config: { enabled: false }, providers: { ollama: provider(fake.url) } });
    expect(await ai.enabled()).toBe(false);
    expect((await ai.structured("ask", Field, user("x"), { promptVersion: "v" })).value).toBeNull();
    expect(fake.chats).toHaveLength(0);
    expect((await ai.status()).note).toMatch(/껐어요/);
  });

  it("routing: config first, then WILLNEW_LOCAL_MODEL, then the first model; embed only when named", async () => {
    const fake = await fakeOllama([{ name: "qwen3:8b", digest: "a" }, { name: "phi4:latest", digest: "b" }, { name: "bge-m3:latest", digest: "c" }]);
    process.env.WILLNEW_LOCAL_MODEL = "phi4";
    const ai = createAi({ config: { routing: { ask: { provider: "ollama", model: "qwen3:8b" } } }, providers: { ollama: provider(fake.url) } });
    const s = await ai.status();
    expect(s.routing.ask).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(s.routing.draft).toEqual({ provider: "ollama", model: "phi4" });
    expect(s.routing.embed).toBeNull();
    fake.replies = ["글"];
    const r = await ai.text("draft", user("x"));
    expect(fake.chats[0].model).toBe("phi4");
    expect(r.record.digest).toBe("b");   // phi4 is phi4:latest
    delete process.env.WILLNEW_LOCAL_MODEL;
    expect((await createAi({ config: {}, providers: { ollama: provider(fake.url) } }).status()).routing.judge).toEqual({ provider: "ollama", model: "qwen3:8b" });
  });

  it("a cloud provider is a placeholder: null, no call, a note", async () => {
    const fake = await fakeOllama();
    const ai = createAi({ config: { routing: { relay: { provider: "anthropic", model: "claude-x" } } }, providers: { ollama: provider(fake.url) } });
    const r = await ai.text("relay", user("x"));
    expect(r.text).toBeNull();
    expect(r.record).toMatchObject({ provider: "anthropic", costUsd: null });
    expect(fake.chats).toHaveLength(0);
    expect((await ai.status()).note).toMatch(/anthropic 는 아직 지원하지 않아요/);
  });

  it("a configured model Ollama does not have: null and a note", async () => {
    const fake = await fakeOllama();
    const ai = createAi({ config: { routing: { ask: { provider: "ollama", model: "gemma3:12b" } } }, providers: { ollama: provider(fake.url) } });
    expect((await ai.structured("ask", Field, user("x"), { promptVersion: "v" })).value).toBeNull();
    expect(fake.chats).toHaveLength(0);
    expect((await ai.status()).note).toMatch(/gemma3:12b/);
  });

  it("digest: a changed digest since last time shows in the note for this process", async () => {
    const fake = await fakeOllama([{ name: "qwen3:8b", digest: "sha-old" }]);
    const first = await createAi({ config: {}, providers: { ollama: provider(fake.url) } }).status();
    expect(first.note).toBeUndefined();
    const state = JSON.parse(readFileSync(join(home, "ai-state.json"), "utf8"));
    expect(state.digests.ask).toEqual({ model: "qwen3:8b", digest: "sha-old" });

    fake.models = [{ name: "qwen3:8b", digest: "sha-new" }];
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) } });
    expect((await ai.status()).note).toBe("모델이 바뀌었어요. 평가를 다시 돌려 주세요 (qwen3:8b)");
    expect((await ai.status()).note).toContain("모델이 바뀌었어요");   // stays for this process
    expect(JSON.parse(readFileSync(join(home, "ai-state.json"), "utf8")).digests.ask.digest).toBe("sha-new");
    expect((await createAi({ config: {}, providers: { ollama: provider(fake.url) } }).status()).note).toBeUndefined();
  });
});

describe("queue", () => {
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it("runs in order, one at a time by default, and reports positions", async () => {
    const q = new Queue();
    const events: [string, number][] = [];
    q.on("position", (id: string, n: number) => events.push([id, n]));
    const started: string[] = [];
    const gates = { a: gate(), b: gate(), c: gate() };
    const job = (id: "a" | "b" | "c") => q.run(id, async () => {
      started.push(id);
      await gates[id].p;
      return id;
    });
    const all = Promise.all([job("a"), job("b"), job("c")]);
    expect(q.size()).toBe(3);
    expect(events).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a"]);
    gates.a.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a", "b"]);
    expect(events.slice(3)).toEqual([["b", 0], ["c", 1]]);
    gates.b.open();
    gates.c.open();
    expect(await all).toEqual(["a", "b", "c"]);
    expect(events.at(-1)).toEqual(["c", 0]);
    expect(q.size()).toBe(0);
  });

  it("concurrency limits how many run at once; errors pass through", async () => {
    const q = new Queue(2);
    let running = 0, peak = 0;
    const work = (ms: number) => q.run(undefined, async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return ms;
    });
    const results = await Promise.all([work(20), work(10), work(15), work(5), work(5)]);
    expect(results).toEqual([20, 10, 15, 5, 5]);
    expect(peak).toBe(2);
    await expect(q.run("x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(q.size()).toBe(0);
  });

  it("an Ai call waits in the shared queue and reports its place", async () => {
    const fake = await fakeOllama();
    fake.replies = ['{"ok":true}'];
    const ai = createAi({ config: { concurrency: 1 }, providers: { ollama: provider(fake.url) } });
    const events: [string, number][] = [];
    ai.queue.on("position", (id: string, n: number) => events.push([id, n]));
    const S = z.object({ ok: z.boolean() });
    const [a, b] = await Promise.all([
      ai.structured("classify", S, user("1"), { requestId: "r1", promptVersion: "v" }),
      ai.structured("classify", S, user("2"), { requestId: "r2", promptVersion: "v" }),
    ]);
    expect(a.value).toEqual({ ok: true });
    expect(b.value).toEqual({ ok: true });
    expect(events.filter(([, n]) => n === 1)).toHaveLength(1);   // the second one waited behind the first
    expect(events.filter(([, n]) => n === 0)).toHaveLength(2);
    expect(events.at(-1)?.[1]).toBe(0);
  });
});

describe("pacing in createAi", () => {
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it("a local Ollama call returns at once; the next waits while the queue rests, and status says so", async () => {
    const fake = await fakeOllama();
    fake.replies = ['{"ok":true}'];
    const rest = gate();
    const rests: number[] = [];
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) }, pacing: { pace: () => "gentle", read: async () => 72, sleep: (ms) => (rests.push(ms), rest.p) } });
    const S = z.object({ ok: z.boolean() });
    expect((await ai.structured("classify", S, user("1"), { promptVersion: "v" })).value).toEqual({ ok: true });
    const second = ai.structured("classify", S, user("2"), { promptVersion: "v" });
    await new Promise((r) => setTimeout(r, 20));
    expect(rests).toHaveLength(1);
    expect(fake.chats).toHaveLength(1);
    expect(await ai.status()).toMatchObject({ pace: "gentle", resting: true, hot: false, gpuTempC: 72 });
    rest.open();
    expect((await second).value).toEqual({ ok: true });
    expect(fake.chats).toHaveLength(2);
  });

  it("cloud calls never rest and never read the GPU", async () => {
    const fake = await fakeOllama();
    const cloud = { id: "anthropic" as const, health: async () => ({ state: "ready" as const, models: [] }), async *chat() { yield { text: "답", done: true, usage: { input: 1, output: 1 } }; } };
    let touched = 0;
    const fail = async () => { touched++; return undefined; };
    const ai = createAi({
      config: { routing: { relay: { provider: "anthropic", model: "m" }, ask: { provider: "anthropic", model: "m" } } },
      providers: { ollama: provider(fake.url), anthropic: cloud },
      pacing: { pace: () => "gentle", read: fail, sleep: fail },
    });
    expect((await ai.text("relay", user("x"), { promptVersion: "v" })).text).toBe("답");
    expect((await ai.text("relay", user("y"), { promptVersion: "v" })).text).toBe("답");
    expect(touched).toBe(0);
    expect(await ai.status()).toMatchObject({ pace: "gentle", resting: false });
  });

  it("status in fast pace does not read the GPU", async () => {
    const fake = await fakeOllama();
    let reads = 0;
    const ai = createAi({ config: { pace: "fast" }, providers: { ollama: provider(fake.url) }, pacing: { read: async () => (reads++, 90) } });
    const s = await ai.status();
    expect(s).toMatchObject({ pace: "fast", resting: false, hot: false });
    expect(s.gpuTempC).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("keys and config", () => {
  it("loadKeys reads keys.env and the environment wins", () => {
    writeFileSync(join(home, "keys.env"), [
      "# 견본",
      "ANTHROPIC_API_KEY=file-key",
      'export OPENAI_API_KEY="quoted key"',
      "OLLAMA_HOST=127.0.0.1:9999  # 메모",
      "WILLNEW_LOCAL_MODEL=",
      "",
    ].join("\n"));
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.GEMINI_API_KEY = "env-gemini";
    expect(loadKeys()).toEqual({ ANTHROPIC_API_KEY: "env-key", OPENAI_API_KEY: "quoted key", OLLAMA_HOST: "127.0.0.1:9999", GEMINI_API_KEY: "env-gemini" });
    expect(loadKeys({ env: {} })).toEqual({ ANTHROPIC_API_KEY: "file-key", OPENAI_API_KEY: "quoted key", OLLAMA_HOST: "127.0.0.1:9999" });
  });

  it("createAi takes OLLAMA_HOST and WILLNEW_LOCAL_MODEL from keys.env", async () => {
    const fake = await fakeOllama([{ name: "qwen3:8b", digest: "a" }, { name: "phi4:latest", digest: "b" }]);
    writeFileSync(join(home, "keys.env"), `OLLAMA_HOST=${fake.url}\nWILLNEW_LOCAL_MODEL=phi4\n`);
    const s = await createAi({ config: {} }).status();
    expect(s.state).toBe("ready");
    expect(s.routing.ask).toEqual({ provider: "ollama", model: "phi4" });
  });

  it("key values never appear in status", async () => {
    const fake = await fakeOllama();
    writeFileSync(join(home, "keys.env"), "ANTHROPIC_API_KEY=sk-ant-secret-123\nOPENAI_API_KEY=sk-oa-secret-456\n");
    process.env.GEMINI_API_KEY = "gm-secret-789";
    const ai = createAi({ config: { routing: { relay: { provider: "anthropic", model: "m" } } }, providers: { ollama: provider(fake.url) } });
    const text = JSON.stringify(await ai.status());
    for (const secret of ["sk-ant-secret-123", "sk-oa-secret-456", "gm-secret-789"]) expect(text).not.toContain(secret);
  });

  it("loadAiConfig reads the ai section and falls back with a reason", () => {
    expect(loadAiConfig()).toEqual({ config: {} });
    writeFileSync(join(home, "config.json"), JSON.stringify({ other: 1, ai: { routing: { ask: { provider: "ollama", model: "qwen3:8b" } }, concurrency: 2, enabled: true } }));
    expect(loadAiConfig()).toEqual({ config: { routing: { ask: { provider: "ollama", model: "qwen3:8b" } }, concurrency: 2, enabled: true } });
    writeFileSync(join(home, "config.json"), JSON.stringify({ ai: { routing: { ask: { provider: "nope", model: "x" } } } }));
    const bad = loadAiConfig();
    expect(bad.config).toEqual({});
    expect(bad.problem).toMatch(/routing\.ask\.provider/);
    writeFileSync(join(home, "config.json"), "{ 깨짐");
    expect(loadAiConfig().problem).toMatch(/읽지 못해서/);
  });

  it("createAi reads concurrency from config.json and shows a config problem in the note", async () => {
    const fake = await fakeOllama();
    writeFileSync(join(home, "config.json"), JSON.stringify({ ai: { concurrency: 3 } }));
    expect((createAi({ providers: { ollama: provider(fake.url) } }).queue as Queue).concurrency).toBe(3);
    writeFileSync(join(home, "config.json"), JSON.stringify({ ai: { concurrency: 0 } }));
    expect((await createAi({ providers: { ollama: provider(fake.url) } }).status()).note).toMatch(/concurrency/);
  });
});

describe("GET /api/ai/status", () => {
  it("answers in solo mode, and only developers in team mode", async () => {
    const fake = await fakeOllama();
    const { createApp } = await import("../src/server/app.js");
    const ai = createAi({ config: {}, providers: { ollama: provider(fake.url) } });
    const solo = createApp({ repo: "/nowhere", check: "", ai }).app;
    const r = await solo.request("/api/ai/status");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "ready", enabled: true, queue: 0, models: [{ name: "qwen3:8b", digest: "sha-1" }] });

    const dir = mkdtempSync(join(tmpdir(), "willnew-ai-team-"));
    mkdirSync(dir, { recursive: true });
    const membersPath = join(dir, "members.json");
    writeFileSync(membersPath, JSON.stringify([
      { name: "이해준", title: "", role: "developer", tokenHash: hashToken("tok-dev") },
      { name: "한지우", title: "", role: "requester", tokenHash: hashToken("tok-req") },
    ]));
    const team = createApp({ repo: "/nowhere", check: "", ai, members: Members.load(membersPath) }).app;
    const as = (t: string) => team.request("/api/ai/status", { headers: { authorization: `Bearer ${t}` } });
    expect((await as("tok-dev")).status).toBe(200);
    const no = await as("tok-req");
    expect(no.status).toBe(403);
    expect((await no.json()).error).toMatch(/개발자만/);
    expect(existsSync(join(home, "ai-state.json"))).toBe(true);
  });
});
