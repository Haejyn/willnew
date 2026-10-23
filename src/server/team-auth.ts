/**
 * Team mode HTTP guard. Every /api call carries a person token (`Authorization: Bearer`, or `?token=` on GET for SSE,
 * websockets and screenshots). The token decides who is calling: `user`, `by`, `reviewer` and `requester` in the body
 * are replaced with that person's name, so the handlers in app.ts stay as they are. Then the role decides what they may
 * do. Solo mode never installs this.
 *
 *   developer only    제안 확인(decide), 결과 승인과 반려(review, merge), 바로 맡기기(POST /api/runs, direct message),
 *                     요청자 확인 건너뛰기(skip), 확인할 화면 고치기(screens), 요청 취소, 실행 삭제, 에이전트 멈추기,
 *                     미리보기 켜고 끄기, 내가 맡을게요(claim), 러너에 맡기기(assign)
 *   claims (hub)      제안 확인은 그 요청을 맡은 개발자만
 *   requester only    되묻기 답(answer): the request's requester
 *   requester or dev  요청자 확인 의도대로예요, 다시 봐 주세요: the request's requester, or any developer
 *   nobody            터미널 (팀 모드에서는 끈다)
 *   noSelfApprove     approving your own request, or a result you are assigned to, is refused
 *
 * 이어서 지시와 줄 댓글은 누구나 된다. 구독 러너면 러너 주인이 확인할 때까지 기다린다(held, runs.ts).
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Member, Members } from "./members.js";
import type { Request, Run } from "./types.js";

export interface TeamAuthOptions {
  members: Members;
  runs: { get(id: string): Run | undefined };
  requests: { get(id: string): Request | undefined };
  noSelfApprove?: boolean;
  /** hub: only the developer who claimed a request decides on its proposal */
  claims?: boolean;
}

/** The reason when approving this run would be approving your own work (noSelfApprove), else null. Slack uses it too. */
export function selfApproval(name: string, run: Run | undefined, req: Request | undefined): string | null {
  if (run && (run.requester === name || req?.requester === name || req?.assignee === name)) return "자기 요청이나 자기가 맡은 결과는 다른 개발자가 승인해요";
  return null;
}

/** What /api/me returns. */
export const publicMember = (m: Member) => ({ name: m.name, title: m.title, role: m.role, avatar: m.avatar });

const current = new WeakMap<Context, Member>();
/** The person the guard resolved for this request (team mode only). */
export const memberOf = (c: Context): Member | undefined => current.get(c);

const NAME_FIELDS = ["user", "by", "reviewer", "requester"] as const;

const dev = (m: Member) => m.role === "developer";

function tokenOf(c: Context): string | undefined {
  const h = c.req.header("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim() || undefined;
  // a query token only for reads: EventSource, WebSocket and <img> cannot send headers
  return c.req.method === "GET" ? (c.req.query("token") ?? undefined) : undefined;
}

/** A reason in Korean when `m` may not do this, else null. `body` is already rewritten. */
export function denied(m: Member, method: string, path: string, body: Record<string, unknown>, o: Omit<TeamAuthOptions, "members">): string | null {
  let x: RegExpExecArray | null;
  if (/^\/api\/runs\/[^/]+\/agents\/[^/]+\/terminal$/.test(path)) return "팀 모드에서는 터미널을 쓸 수 없어요";
  if (method === "GET") return null;

  if (method === "POST" && path === "/api/runs") return dev(m) ? null : "바로 맡기기는 개발자만 할 수 있어요";
  if (method === "POST" && /^\/api\/channels\/[^/]+\/messages$/.test(path) && body.direct === true && !body.threadId)
    return dev(m) ? null : "바로 맡기기는 개발자만 할 수 있어요";

  if (method === "POST" && (x = /^\/api\/requests\/([^/]+)\/decide$/.exec(path))) {
    if (!dev(m)) return "제안 확인은 개발자만 할 수 있어요";
    if (!o.claims) return null;
    const req = o.requests.get(decodeURIComponent(x[1]));
    if (req && !req.assignee) return "먼저 내가 맡을게요를 눌러 주세요";
    return !req || req.assignee === m.name ? null : `맡은 ${req.assignee}님만 제안을 확인할 수 있어요`;
  }
  if (method === "POST" && /^\/api\/requests\/[^/]+\/claim$/.test(path)) return dev(m) ? null : "내가 맡을게요는 개발자만 할 수 있어요";
  if (method === "POST" && /^\/api\/runs\/[^/]+\/assign$/.test(path)) return dev(m) ? null : "러너에 맡기기는 개발자만 할 수 있어요";
  if (method === "POST" && /^\/api\/requests\/[^/]+\/cancel$/.test(path)) return dev(m) ? null : "요청 취소는 개발자만 할 수 있어요";
  if (method === "DELETE" && /^\/api\/runs\/[^/]+$/.test(path)) return dev(m) ? null : "실행 삭제는 개발자만 할 수 있어요";
  if (method === "POST" && /^\/api\/runs\/[^/]+\/agents\/[^/]+\/cancel$/.test(path)) return dev(m) ? null : "에이전트 멈추기는 개발자만 할 수 있어요";
  if ((method === "POST" || method === "DELETE") && /^\/api\/runs\/[^/]+\/agents\/[^/]+\/preview$/.test(path)) return dev(m) ? null : "미리보기는 개발자만 켜고 끌 수 있어요";

  if (method === "POST" && (x = /^\/api\/requests\/([^/]+)\/answer$/.exec(path))) {
    const req = o.requests.get(decodeURIComponent(x[1]));
    return !req || req.requester === m.name ? null : "되묻기는 요청한 사람만 답할 수 있어요";
  }

  if (method === "POST" && (x = /^\/api\/requests\/([^/]+)\/requester-check$/.exec(path))) {
    if (body.verdict === "skip") return dev(m) ? null : "요청자 확인 건너뛰기는 개발자만 할 수 있어요";
    const req = o.requests.get(decodeURIComponent(x[1]));
    return !req || dev(m) || req.requester === m.name ? null : "요청한 사람만 확인할 수 있어요";
  }

  if (method === "PUT" && /^\/api\/requests\/[^/]+\/screens$/.test(path)) return dev(m) ? null : "확인할 화면은 개발자만 고칠 수 있어요";

  const review = method === "POST" ? /^\/api\/runs\/([^/]+)\/review$/.exec(path) : null;
  const merge = method === "POST" ? /^\/api\/runs\/([^/]+)\/agents\/[^/]+\/merge$/.exec(path) : null;
  if (review || merge) {
    if (!dev(m)) return "결과 승인과 반려는 개발자만 할 수 있어요";
    const approving = merge || body.decision === "approve";
    if (o.noSelfApprove && approving) {
      const run = o.runs.get(decodeURIComponent((review ?? merge)![1]));
      const req = run?.requestId ? o.requests.get(run.requestId) : undefined;
      const self = selfApproval(m.name, run, req);
      if (self) return self;
    }
    return null;
  }
  return null;
}

export function teamAuth(o: TeamAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const m = o.members.byToken(tokenOf(c));
    if (!m) return c.json({ error: "초대 링크로 들어와 주세요", team: true }, 401);
    current.set(c, m);

    let body: Record<string, unknown> = {};
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const text = await c.req.text();
      let parsed: unknown = text.trim() ? undefined : {};
      try {
        if (parsed === undefined) parsed = JSON.parse(text);
      } catch { /* not JSON: the handler answers 400 */ }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
        // who is acting comes from the token, never from the body
        for (const k of NAME_FIELDS) body[k] = m.name;
        if (/^\/api\/channels\/[^/]+\/messages$/.test(c.req.path)) {
          body.userTitle = m.title || undefined;
          body.userAvatar = m.avatar;
        }
        // Hono keeps the read body as a promise (the type says string); json() in the handler parses this one
        (c.req.bodyCache as Record<string, unknown>).text = Promise.resolve(JSON.stringify(body));
      }
    }

    const why = denied(m, c.req.method, c.req.path, body, o);
    if (why) return c.json({ error: why }, 403);
    await next();
  };
}
