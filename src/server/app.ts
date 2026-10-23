import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ADAPTERS, installed } from "./adapters.js";
import { Chat } from "./chat.js";
import type { Members } from "./members.js";
import { computeMetrics, computeTeamMetrics } from "./metrics.js";
import { RequestManager } from "./requests.js";
import { RunManager } from "./runs.js";
import { memberOf, publicMember, teamAuth } from "./team-auth.js";
import { Terminals } from "./terminal.js";
import { TEAMS, TEMPLATES } from "./templates.js";
import { rulesTriage } from "./triage.js";
import type { ChatMessage, CreateRunInput, RequestUpdate, Run, RunUpdate } from "./types.js";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon" };

const lite = (r: Run): Run => ({ ...r, agents: r.agents.map((a) => ({ ...a, events: [], diff: { ...a.diff, patch: "" } })) });

function sse(c: any, bus: import("node:events").EventEmitter, topic: string) {
  return streamSSE(c, async (stream) => {
    const queue: (RunUpdate | ChatMessage | RequestUpdate)[] = [];
    let wake: (() => void) | null = null;
    const on = (u: RunUpdate | ChatMessage | RequestUpdate) => { queue.push(u); wake?.(); };
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

export function createApp(opts: { repo: string; check: string; token?: string; preview?: string; previewBaseUrl?: string; reviewers?: string[]; ship?: "merge" | "pr"; deployCheck?: string; deployEnv?: string; manager?: RunManager; requests?: RequestManager;
  /** team mode: people come from members.json, every /api call needs a person token */
  members?: Members; noSelfApprove?: boolean }) {
  const runs = opts.manager ?? new RunManager({ preview: opts.preview, previewBaseUrl: opts.previewBaseUrl, ship: { mode: opts.ship ?? "merge", deployCheck: opts.deployCheck, deployEnv: opts.deployEnv } });
  const requests = opts.requests ?? new RequestManager(runs);
  const chat = new Chat(runs, opts.repo, opts.check, opts.reviewers, requests);
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

  // team mode: the person token decides who is calling and what they may do (team-auth.ts)
  if (opts.members) app.use("/api/*", teamAuth({ members: opts.members, runs, requests, noSelfApprove: opts.noSelfApprove }));

  if (opts.token && !opts.members) {
    app.use("/api/*", async (c, next) => {
      const t = c.req.header("authorization")?.replace(/^Bearer /, "") ?? c.req.query("token");
      if (t !== opts.token) return c.json({ error: "unauthorized" }, 401);
      await next();
    });
  }

  app.onError((err, c) => c.json({ error: err.message }, 400));

  app.get("/api/me", (c) => {
    const m = memberOf(c);
    return m ? c.json(publicMember(m)) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/agents", (c) => c.json(Object.values(ADAPTERS).map((a) => ({ id: a.id, name: a.name, installed: installed(a) }))));
  app.get("/api/config", (c) => c.json({ repo: opts.repo, check: opts.check, preview: runs.previewCommand, previewBaseUrl: runs.previewBaseUrl, previewLocalOnly: runs.previewLink(0).localOnly,
    ship: runs.shipper.mode, deploy: runs.shipper.tracksDeploy, deployEnv: runs.shipper.opts.deployEnv ?? "production", team: opts.members ? true : undefined }));
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
  // instant preview for the compose box (keyword rules); the real plan comes from the planner agent on send
  app.post("/api/plan", async (c) => {
    const { text } = await c.req.json();
    return c.json(rulesTriage(String(text ?? ""), opts.check));
  });
  app.get("/api/teams", (c) => c.json(TEAMS));
  app.post("/api/runs/:id/review", async (c) => {
    const body = await c.req.json();
    // a screen change waits for the requester first; the developer can skip that with a reason (요청자 확인 건너뛰기)
    const linked = runs.get(c.req.param("id"))?.requestId;
    if (linked && requests.get(linked)?.status === "preview") throw new Error("요청자 확인이 먼저예요. 건너뛰려면 요청 카드에서 이유를 적어 주세요");
    const message = await runs.review(c.req.param("id"), body);
    return c.json({ ok: true, message });
  });
  app.get("/api/channels", (c) => c.json(chat.channels));
  // the channel stream leaves thread replies out; threads have their own list and stream. The channel SSE carries both
  // (a reply updates the footer under its root).
  app.get("/api/channels/:id/messages", (c) => c.json(chat.list(c.req.param("id"))));
  app.post("/api/channels/:id/messages", async (c) => {
    const { user, text, team, overrides, userTitle, userAvatar, direct, threadId, broadcast } = await c.req.json();
    return c.json(await chat.post(c.req.param("id"), String(user ?? "anonymous"), String(text ?? ""), team, overrides, userTitle ? String(userTitle) : undefined, userAvatar ? String(userAvatar) : undefined, direct === true,
      threadId ? { id: String(threadId), broadcast: broadcast === true } : undefined));
  });
  app.get("/api/channels/:id/stream", (c) => sse(c, chat.bus, `chat:${c.req.param("id")}`));
  app.get("/api/channels/:id/threads", (c) => c.json(chat.threads(c.req.param("id"))));
  app.get("/api/channels/:id/threads/:tid/messages", (c) => c.json(chat.thread(c.req.param("id"), c.req.param("tid"))));
  app.get("/api/channels/:id/threads/:tid/stream", (c) => sse(c, chat.bus, `thread:${c.req.param("id")}:${c.req.param("tid")}`));
  app.post("/api/channels/:id/messages/:mid/react", async (c) => {
    const { emoji, user } = await c.req.json();
    return c.json(chat.react(c.req.param("id"), c.req.param("mid"), String(emoji ?? ""), String(user ?? "anonymous")));
  });

  // requests (bridge): list, one, live updates, clarify answers, the developer's decision
  app.get("/api/requests", (c) => c.json(requests.list()));
  app.get("/api/requests/:id", (c) => {
    const r = requests.get(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/requests/:id/stream", (c) => sse(c, requests.bus, `request:${c.req.param("id")}`));
  app.post("/api/requests/:id/answer", async (c) => {
    const { questionId, answer, by } = await c.req.json();
    return c.json(await requests.answer(c.req.param("id"), { questionId: String(questionId ?? ""), answer: String(answer ?? ""), by: String(by ?? "anonymous") }));
  });
  app.post("/api/requests/:id/decide", async (c) => {
    const { decision, by, text } = await c.req.json();
    return c.json(await requests.decide(c.req.param("id"), { decision, by: String(by ?? "anonymous"), text: text == null ? undefined : String(text) }));
  });
  // 요청자 확인: 의도대로예요 / 다시 봐 주세요 (boxes) / 건너뛰기 (developer, reason)
  app.post("/api/requests/:id/requester-check", async (c) => {
    const { verdict, by, feedback, note, reason } = await c.req.json();
    return c.json(requests.requesterCheck(c.req.param("id"), { verdict, by: String(by ?? "anonymous"), feedback, note: note == null ? undefined : String(note), reason: reason == null ? undefined : String(reason) }));
  });
  app.put("/api/requests/:id/screens", async (c) => {
    const { screens, by } = await c.req.json();
    return c.json(requests.setScreens(c.req.param("id"), screens, String(by ?? "anonymous")));
  });
  app.get("/api/requests/:id/shots/:round/:file", (c) => {
    const f = requests.shotFile(c.req.param("id"), c.req.param("round"), c.req.param("file"));
    return f ? new Response(readFileSync(f), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } }) : c.json({ error: "not found" }, 404);
  });
  app.post("/api/requests/:id/cancel", async (c) => {
    const { by, reason } = await c.req.json();
    return c.json(requests.cancel(c.req.param("id"), String(by ?? "anonymous"), reason ? String(reason) : undefined));
  });

  // built web UI
  app.get("*", (c) => {
    const p = c.req.path === "/" ? "/index.html" : c.req.path;
    let file = join(WEB_DIR, p);
    if (!file.startsWith(WEB_DIR) || !existsSync(file)) file = join(WEB_DIR, "index.html");
    if (!existsSync(file)) return c.text("web UI not built — run `pnpm build`", 404);
    return new Response(readFileSync(file), { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
  });

  return { app, runs, requests, chat, injectWebSocket, terminals };
}
