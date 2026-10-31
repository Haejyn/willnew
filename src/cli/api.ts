/**
 * The developer CLI's HTTP client for the team server (docs/design/m1-contract.md 4절).
 * It only trusts the contract's shapes: the ticket routes are built in src/server/tickets/ by someone else.
 */
import type { ClarifyQuestion, Request, WorkSpec } from "../server/types.js";
import type { Credentials } from "./credentials.js";

export type Ticket = Request & { next?: ClarifyQuestion | null; unconfirmed?: string[] };

export interface TicketSummary {
  id: string;
  key: string;
  title: string;
  status: Request["status"];
  priority?: Request["priority"];
  assignee?: string;
  requester: string;
  affected: number;
  createdAt: number;
  updatedAt: number;
}

export interface Bundle {
  key: string;
  title: string;
  branch: string;
  repo: string;
  check: string;
  trusted: {
    problem: string;
    reproSteps: string[];
    expected: string;
    actual: string;
    environment: WorkSpec["environment"];
    impact: WorkSpec["impact"];
    alreadyRuledOut: string[];
    acceptanceCriteria: string[];
    outOfScope: string[];
    forDeveloper: string;
    fields: WorkSpec["fields"];
  };
  untrusted?: { customerText: string };
  injectionFlags: { pattern: string; excerpt: string }[];
  customerClaims: string[];
  asks: { question: string; answer?: string }[];
}

export interface AskEntry {
  askId: string;
  question: string;
  forRequester: string;
  answer?: string;
  answeredAt?: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

/** `T-42`, `t-42` and `42` all become `T-42`. A request id passes through as it is. */
export const normalizeKey = (k: string) => (/^\d+$/.test(k) ? `T-${k}` : /^t-\d+$/i.test(k) ? k.toUpperCase() : k);

export class Api {
  constructor(private readonly cred: Credentials, private readonly fetcher: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.cred.token) headers.authorization = `Bearer ${this.cred.token}`;
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      // solo mode has no token: the server takes the name from `user` (team mode replaces it with the token's person)
      payload = JSON.stringify({ user: this.cred.name, ...body });
    }
    let res: Response;
    try {
      res = await this.fetcher(this.cred.server.replace(/\/+$/, "") + path, { method, headers, body: payload });
    } catch (e) {
      throw new ApiError(`서버에 닿지 않아요: ${this.cred.server} (${(e as Error).message})`, 0);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not json */
    }
    if (!res.ok) {
      const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
      const why = typeof obj.error === "string" ? obj.error : text.slice(0, 200) || res.statusText;
      if (res.status === 401) throw new ApiError(`로그인이 필요해요 (${why}). willnew login 으로 다시 넣어 주세요`, 401, obj);
      throw new ApiError(`서버가 거절했어요 (${res.status}): ${why}`, res.status, obj);
    }
    return json as T;
  }

  me() {
    return this.call<{ name: string; role?: string }>("GET", "/api/me");
  }
  list(q: { status?: string; assignee?: string }) {
    const p = new URLSearchParams();
    if (q.status) p.set("status", q.status);
    if (q.assignee) p.set("assignee", q.assignee);
    const s = p.toString();
    return this.call<TicketSummary[]>("GET", `/api/tickets${s ? `?${s}` : ""}`);
  }
  get(key: string) {
    return this.call<Ticket>("GET", `/api/tickets/${encodeURIComponent(key)}`);
  }
  bundle(key: string, raw = false) {
    return this.call<Bundle>("GET", `/api/tickets/${encodeURIComponent(key)}/bundle${raw ? "?raw=1" : ""}`);
  }
  work(key: string, agent?: string) {
    return this.call<{ ticket: Ticket; branch: string; bundle: Bundle }>("POST", `/api/tickets/${encodeURIComponent(key)}/work`, agent ? { agent } : {});
  }
  ask(key: string, question: string) {
    return this.call<{ ticket: Ticket; askId: string; forRequester: string }>("POST", `/api/tickets/${encodeURIComponent(key)}/ask`, { question });
  }
  asks(key: string) {
    return this.call<AskEntry[]>("GET", `/api/tickets/${encodeURIComponent(key)}/asks`);
  }
  note(key: string, text: string) {
    return this.call<Ticket>("POST", `/api/tickets/${encodeURIComponent(key)}/note`, { text });
  }
  decline(key: string, reason: string, alt?: string) {
    return this.call<Ticket>("POST", `/api/tickets/${encodeURIComponent(key)}/decline`, alt ? { reason, alt } : { reason });
  }
  done(key: string, body: { prUrl?: string; summary?: string }) {
    return this.call<Ticket>("POST", `/api/tickets/${encodeURIComponent(key)}/done`, body);
  }
  gitSync(body: { branch?: string; prUrl?: string; prTitle?: string; merged?: boolean; sha?: string }) {
    return this.call<{ key?: string; status?: string }>("POST", "/api/git/sync", body);
  }
}
