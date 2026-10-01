import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ADAPTERS, installed } from "./adapters.js";
import { Chat } from "./chat.js";
import { computeMetrics, computeTeamMetrics } from "./metrics.js";
import { RunManager } from "./runs.js";
import { Terminals } from "./terminal.js";
import { TEAMS, TEMPLATES } from "./templates.js";
import type { ChatMessage, CreateRunInput, Run, RunUpdate } from "./types.js";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon" };

const lite = (r: Run): Run => ({ ...r, agents: r.agents.map((a) => ({ ...a, events: [], diff: { ...a.diff, patch: "" } })) });

function sse(c: any, bus: import("node:events").EventEmitter, topic: string) {
  return streamSSE(c, async (stream) => {
    const queue: (RunUpdate | ChatMessage)[] = [];
    let wake: (() => void) | null = null;
    const on = (u: RunUpdate | ChatMessage) => { queue.push(u); wake?.(); };
    bus.on(topic, on);
    stream.onAbort(() => { bus.off(topic, on); wake?.(); });
    while (!stream.aborted) {
      while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
      await new Promise<void>((r) => { wake = r; setTimeout(r, 15000); });
      wake = null;
      if (!queue.length) await stream.writeSSE({ event: "ping", data: "{}" });
    }
  });
}

export function createApp(opts: { repo: string; check: string; token?: string; preview?: string; manager?: RunManager }) {
  const runs = opts.manager ?? new RunManager({ preview: opts.preview });
  const chat = new Chat(runs, opts.repo, opts.check);
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const terminals = new Terminals();
  runs.bus.on("worktree-removed", (agentId: string) => terminals.close(agentId));
  const agentOf = (runId: string, agentId: string) => {
    const run = runs.get(runId);
    const agent = run?.agents.find((a) => a.id === agentId);
    if (!run || !agent) throw new Error("not found");
    return { run, agent };
  };

  if (opts.token) {
    app.use("/api/*", async (c, next) => {
      const t = c.req.header("authorization")?.replace(/^Bearer /, "") ?? c.req.query("token");
      if (t !== opts.token) return c.json({ error: "unauthorized" }, 401);
      await next();
    });
  }

  app.onError((err, c) => c.json({ error: err.message }, 400));

  app.get("/api/agents", (c) => c.json(Object.values(ADAPTERS).map((a) => ({ id: a.id, name: a.name, installed: installed(a) }))));
  app.get("/api/config", (c) => c.json({ repo: opts.repo, check: opts.check, preview: runs.previewCommand }));
  app.get("/api/runs", (c) => c.json(runs.list().map(lite)));
  app.post("/api/runs", async (c) => {
    const body = (await c.req.json()) as CreateRunInput;
    const run = await runs.create({ ...body, repo: body.repo || opts.repo, check: body.check ?? opts.check });
    return c.json({ id: run.id });
  });
  app.get("/api/runs/:id", (c) => {
    const run = runs.get(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/runs/:id/stream", (c) => sse(c, runs.bus, `run:${c.req.param("id")}`));
  app.post("/api/runs/:id/agents/:aid/cancel", (c) => {
    runs.cancel(c.req.param("id"), c.req.param("aid"));
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/agents/:aid/steer", async (c) => {
    const { text, by } = await c.req.json();
    runs.steer(c.req.param("id"), c.req.param("aid"), String(text ?? ""), String(by ?? "anonymous"));
    return c.json({ ok: true });
  });
  app.get("/api/runs/:id/agents/:aid/preflight", async (c) => c.json(await runs.preflight(c.req.param("id"), c.req.param("aid"))));
  app.post("/api/runs/:id/agents/:aid/reviewed", async (c) => {
    const { file, reviewed } = await c.req.json();
    runs.setReviewed(c.req.param("id"), c.req.param("aid"), String(file), reviewed !== false);
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/agents/:aid/preview", async (c) => c.json(await runs.startPreview(c.req.param("id"), c.req.param("aid"))));
  app.delete("/api/runs/:id/agents/:aid/preview", (c) => {
    runs.stopPreview(c.req.param("id"), c.req.param("aid"));
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/comments", async (c) => {
    const body = await c.req.json();
    return c.json(runs.addComment(c.req.param("id"), { agentId: String(body.agentId), file: String(body.file), line: Number(body.line),
      text: String(body.text ?? ""), by: String(body.by ?? "anonymous") }));
  });
  app.delete("/api/runs/:id/comments/:cid", (c) => {
    runs.deleteComment(c.req.param("id"), c.req.param("cid"));
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/agents/:aid/send-comments", async (c) => {
    const { by } = await c.req.json();
    return c.json({ ok: true, sent: runs.sendComments(c.req.param("id"), c.req.param("aid"), String(by ?? "anonymous")) });
  });
  // a shell inside the agent's worktree — raw terminal bytes out, {type:"input"|"resize"} JSON in
  app.get("/api/runs/:id/agents/:aid/terminal", upgradeWebSocket((c) => {
    let off: (() => void) | undefined;
    let term: import("./terminal.js").Terminal | undefined;
    return {
      async onOpen(_e, ws) {
        try {
          const { agent } = agentOf(c.req.param("id")!, c.req.param("aid")!);
          term = await terminals.get(agent.id, agent.worktree, Number(c.req.query("cols")) || 100, Number(c.req.query("rows")) || 30);
          if (term.scrollback) ws.send(term.scrollback);
          else if (!term.pty) ws.send("\x1b[2m(간이 셸 — node-pty 가 없어 줄 편집은 안 돼요)\x1b[0m\r\n");
          off = term.subscribe((d) => ws.send(d), () => { ws.send("\r\n\x1b[2m[셸이 끝났어요 — 다시 열면 새로 시작해요]\x1b[0m\r\n"); ws.close(); });
        } catch (e) {
          ws.send(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`);
          ws.close();
        }
      },
      onMessage(e) {
        try {
          const m = JSON.parse(String(e.data));
          if (m.type === "input" && typeof m.data === "string") term?.backend.write(m.data);
          if (m.type === "resize") term?.backend.resize(Number(m.cols) || 100, Number(m.rows) || 30);
        } catch { /* ignore */ }
      },
      onClose() {
        off?.();
      },
    };
  }));
  app.post("/api/runs/:id/agents/:aid/merge", async (c) => {
    const message = await runs.merge(c.req.param("id"), c.req.param("aid"));
    return c.json({ ok: true, message });
  });
  app.delete("/api/runs/:id", async (c) => {
    await runs.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/metrics", (c) => c.json({ ...computeMetrics(runs.list()), ...computeTeamMetrics(runs.list(), TEAMS, TEMPLATES) }));
  app.get("/api/templates", (c) => c.json(TEMPLATES));
  app.get("/api/teams", (c) => c.json(TEAMS));
  app.post("/api/runs/:id/review", async (c) => {
    const body = await c.req.json();
    const message = await runs.review(c.req.param("id"), body);
    return c.json({ ok: true, message });
  });
  app.get("/api/channels", (c) => c.json(chat.channels));
  app.get("/api/channels/:id/messages", (c) => c.json(chat.list(c.req.param("id"))));
  app.post("/api/channels/:id/messages", async (c) => {
    const { user, text, team } = await c.req.json();
    return c.json(await chat.post(c.req.param("id"), String(user ?? "anonymous"), String(text ?? ""), team));
  });
  app.get("/api/channels/:id/stream", (c) => sse(c, chat.bus, `chat:${c.req.param("id")}`));

  // built web UI
  app.get("*", (c) => {
    const p = c.req.path === "/" ? "/index.html" : c.req.path;
    let file = join(WEB_DIR, p);
    if (!file.startsWith(WEB_DIR) || !existsSync(file)) file = join(WEB_DIR, "index.html");
    if (!existsSync(file)) return c.text("web UI not built — run `pnpm build`", 404);
    return new Response(readFileSync(file), { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
  });

  return { app, runs, chat, injectWebSocket, terminals };
}
