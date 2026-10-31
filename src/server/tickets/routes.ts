/**
 * 티켓 HTTP API (m1-contract.md 4절). 사람: 팀 모드는 토큰(team-auth.ts 가 본문 user 를 토큰 이름으로 덮는다),
 * 혼자 모드는 본문 user. 권한은 team-auth.ts 의 denied() 가 본다. 오류는 { error } 와 상태 코드.
 */
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Members } from "../members.js";
import type { RequestManager } from "../requests.js";
import { memberOf } from "../team-auth.js";
import type { RequestUpdate } from "../types.js";
import { TicketError, type TicketFlow, type TicketStreamEvent } from "./flow.js";
import { verifyGithubSignature } from "./git.js";

/** 본문 JSON. 비었거나 JSON 이 아니면 {} */
async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const BEFORE_SEND = ["draft", "clarifying", "waiting_customer", "spec_ready"];
const who = (b: Record<string, unknown>) => String(b.user ?? b.by ?? "").trim() || "anonymous";
const opt = (x: unknown) => (x === undefined || x === null ? undefined : String(x));

export function ticketRoutes(app: Hono, deps: { flow: TicketFlow; requests: RequestManager; team: boolean; members?: Members }) {
  const { flow, requests } = deps;

  /** TicketError 는 그 상태 코드로, 나머지는 app.onError (400) */
  const handle = (fn: (c: Context) => unknown) => async (c: Context) => {
    try {
      const out = await fn(c);
      return out instanceof Response ? out : c.json(out as object);
    } catch (e) {
      if (e instanceof TicketError) return c.json({ error: e.message, ...e.body }, e.status);
      throw e;
    }
  };
  const key = (c: Context) => c.req.param("key")!;
  /** 나: 팀 모드는 토큰의 사람, 혼자 모드는 쿼리 user */
  const me = (c: Context) => memberOf(c)?.name ?? c.req.query("user") ?? "anonymous";
  /**
   * 보내기 전(draft, clarifying, waiting_customer, spec_ready) 티켓은 보낸 사람만 본다 (F3, 개발자도 못 본다).
   * 팀 모드에서만 막는다. 혼자 모드는 사람을 가릴 수 없어서 다 보인다
   */
  const canSee = (c: Context, r: { status: string; requester: string }) => {
    const m = memberOf(c);
    return !m || !BEFORE_SEND.includes(r.status) || r.requester === m.name;
  };
  /** 보이는 티켓만. 안 보이면 403 */
  const seen = (c: Context) => {
    const r = flow.find(key(c));
    if (!r) throw new TicketError("티켓을 찾을 수 없어요", 404);
    if (!canSee(c, r)) throw new TicketError("보내기 전 티켓은 보낸 사람만 볼 수 있어요", 403);
    return r;
  };

  app.post("/api/intake", handle(async (c) => {
    const b = await body(c);
    const m = memberOf(c);
    return flow.intake({ text: String(b.text ?? ""), channel: opt(b.channel), attachments: b.attachments, user: who(b), userTitle: m?.title || undefined, userAvatar: m?.avatar });
  }));

  app.get("/api/tickets", handle((c) => {
    const status = c.req.query("status")?.split(",").map((s) => s.trim()).filter(Boolean);
    const a = c.req.query("assignee");
    const assignee = a === undefined || a === "" ? undefined : a === "me" ? me(c) : a;
    const requester = c.req.query("mine") === "1" ? me(c) : undefined;
    return flow.list({ status, assignee, requester }).filter((t) => canSee(c, t));
  }));

  app.get("/api/tickets/:key", handle((c) => flow.view(seen(c))));

  app.get("/api/tickets/:key/stream", (c) => {
    let r;
    try {
      r = seen(c);
    } catch (e) {
      const t = e as TicketError;
      return c.json({ error: t.message }, t.status);
    }
    const id = r.id;
    return streamSSE(c, async (stream) => {
      const queue: { event: string; data: unknown }[] = [];
      let wake: (() => void) | null = null;
      const push = (e: { event: string; data: unknown }) => {
        queue.push(e);
        wake?.();
      };
      const onFlow = (e: TicketStreamEvent) => push(e);
      const onReq = (u: RequestUpdate) => push({ event: "ticket", data: flow.view(u.request) });
      flow.bus.on(`ticket:${id}`, onFlow);
      requests.bus.on(`request:${id}`, onReq);
      stream.onAbort(() => {
        flow.bus.off(`ticket:${id}`, onFlow);
        requests.bus.off(`request:${id}`, onReq);
        wake?.();
      });
      push({ event: "ticket", data: flow.view(r) });
      while (!stream.aborted) {
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) });
        }
        await new Promise<void>((res) => {
          wake = res;
          setTimeout(res, 15000);
        });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    });
  });

  app.post("/api/tickets/:key/messages", handle(async (c) => {
    const b = await body(c);
    return flow.message(key(c), { questionId: String(b.questionId ?? ""), kind: String(b.kind ?? ""), text: opt(b.text), by: who(b) });
  }));
  app.post("/api/tickets/:key/customer-answer", handle(async (c) => {
    const b = await body(c);
    return flow.customerAnswer(key(c), { field: String(b.field ?? ""), answer: String(b.answer ?? ""), by: who(b) });
  }));
  app.patch("/api/tickets/:key/fields", handle(async (c) => {
    const b = await body(c);
    // value: null 은 "모름으로 두기" (flow.editField). 값이 없는 것과 구분한다
    return flow.editField(key(c), { field: String(b.field ?? ""), value: "value" in b ? b.value : undefined, confirm: b.confirm === true, by: who(b) });
  }));
  app.post("/api/tickets/:key/send", handle(async (c) => flow.send(key(c), who(await body(c)))));

  app.post("/api/tickets/:key/assign", handle(async (c) => {
    const b = await body(c);
    const assignee = opt(b.assignee)?.trim() || undefined;
    // 팀 모드: 담당자는 members 에 있는 개발자만. 비우면 배정하는 사람 자신 (이미 개발자다)
    if (deps.members && assignee !== undefined && deps.members.get(assignee)?.role !== "developer")
      throw new TicketError("담당자는 팀의 개발자 중에서 골라 주세요", 400);
    return flow.assign(key(c), { assignee, priority: opt(b.priority), by: who(b) });
  }));
  app.post("/api/tickets/:key/work", handle(async (c) => {
    const b = await body(c);
    return flow.work(key(c), { agent: opt(b.agent), by: who(b) });
  }));
  app.get("/api/tickets/:key/bundle", handle((c) => flow.bundle(seen(c), c.req.query("raw") === "1")));
  app.post("/api/tickets/:key/ask", handle(async (c) => {
    const b = await body(c);
    return flow.ask(key(c), { question: String(b.question ?? ""), by: who(b) });
  }));
  app.get("/api/tickets/:key/asks", handle((c) => flow.asks(seen(c).id)));
  app.post("/api/tickets/:key/asks/:askId/answer", handle(async (c) => {
    const b = await body(c);
    return flow.answerAsk(key(c), c.req.param("askId")!, { answer: String(b.answer ?? ""), by: who(b) });
  }));
  app.post("/api/tickets/:key/note", handle(async (c) => {
    const b = await body(c);
    return flow.note(key(c), { text: String(b.text ?? ""), by: who(b) });
  }));
  app.post("/api/tickets/:key/decline", handle(async (c) => {
    const b = await body(c);
    return flow.decline(key(c), { reason: String(b.reason ?? ""), alt: opt(b.alt), by: who(b) });
  }));
  app.post("/api/tickets/:key/done", handle(async (c) => {
    const b = await body(c);
    return flow.done(key(c), { prUrl: opt(b.prUrl), summary: opt(b.summary), by: who(b) });
  }));

  // 요청자 확인: 의도대로예요(ok) → code_review, 다시 봐 주세요(changes) → in_progress
  app.post("/api/tickets/:key/check", handle(async (c) => {
    const b = await body(c);
    return flow.check(key(c), { verdict: String(b.verdict ?? ""), note: opt(b.note), by: who(b) });
  }));

  app.post("/api/git/sync", handle(async (c) => {
    const b = await body(c);
    return flow.gitSync({ branch: opt(b.branch), prUrl: opt(b.prUrl), prTitle: opt(b.prTitle), merged: b.merged === true, sha: opt(b.sha) }, who(b));
  }));

  /**
   * GitHub 웹훅. 사람 토큰이 없어서 team-auth 를 거치지 않고 여기서 서명을 본다. WILLNEW_GITHUB_SECRET 이 있으면
   * X-Hub-Signature-256 이 맞아야 하고, 없으면 팀 모드에서는 받지 않는다(혼자 모드만 받는다)
   */
  app.post("/api/git/events", async (c) => {
    const raw = await c.req.text();
    const secret = process.env.WILLNEW_GITHUB_SECRET;
    if (secret) {
      if (!verifyGithubSignature(secret, raw, c.req.header("x-hub-signature-256"))) return c.json({ error: "웹훅 서명이 맞지 않아요" }, 401);
    } else if (deps.team) return c.json({ error: "팀 모드에서는 WILLNEW_GITHUB_SECRET 을 정해야 웹훅을 받아요" }, 403);
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: "웹훅 본문이 JSON 이 아니에요" }, 400);
    }
    return c.json(flow.gitEvent(c.req.header("x-github-event"), payload));
  });
}
