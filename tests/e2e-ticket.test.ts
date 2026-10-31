/**
 * 끝에서 끝: 기획서 4절 쿠폰 시나리오 1~8 을 HTTP 로 한 번에 (m1-contract.md 7절, ticket-plan.md 15절 M1 완료 확인).
 * 팀 모드(members, 사람 토큰 둘), 가짜 Ai, 실제 CLI, 임시 git 저장소의 examples/shop 복사본.
 *
 *   접수(상담 기록 붙여 넣기) → 대화 → 초안 → 대리 검토 → 추정 칸 확인 → 보내기 → 배정 → willnew work
 *   → 고치고 커밋(꼬리말 hook) → willnew ask 와 CS 답 → willnew done → 요청자 확인 → git sync → 웹훅 병합 → merged
 *
 * 전 과정에서 fetch 를 감시한다. 127.0.0.1 말고 다른 곳으로 나가면 실패.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ai, LlmRecord, LlmTask, Msg } from "../src/server/ai/index.js";
import { hashToken, Members, type Member } from "../src/server/members.js";
import { loadRedactions } from "../src/server/safety/index.js";
import { githubSignature } from "../src/server/tickets/index.js";

process.env.WILLNEW_TRIAGE = "rules";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const person = (name: string, role: Member["role"], token: string): Member => ({ name, title: "", role, tokenHash: hashToken(token) });
const T = { dev: "e2e-tok-dev", cs: "e2e-tok-cs" };
const COUPON = readFileSync(resolve("examples/shop/inquiries/01-coupon-total.md"), "utf8");
const PII = ["010-0000-1234", "gildong.hong@example.com", "홍길동"];

// ------------------------------------------------------------------------------------------ 외부 호출 감시

const realFetch = globalThis.fetch;
const outside: string[] = [];
beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") outside.push(url.href);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ------------------------------------------------------------------------------------------ 가짜 Ai (정해진 응답)

function scenarioAi() {
  const sent: string[] = [];
  const rec = (task: LlmTask, pv?: string): LlmRecord => ({ task, provider: "fake", model: "fake-1", digest: "sha256:fake", tokens: 10, costUsd: 0, ms: 1, promptVersion: pv ?? "" });
  const replies: Partial<Record<LlmTask, (m: Msg[]) => unknown>> = {
    extract: () => ({
      problem: { value: "쿠폰을 적용해도 최종 결제 금액이 줄지 않는다", sources: [1, 4], confidence: "high" },
      reproSteps: { value: ["마우스와 데스크매트를 장바구니에 담는다", "쿠폰 WELCOME5000 을 넣고 적용을 누른다"], sources: [3, 5], confidence: "medium" },
      expected: { value: "최종 결제 금액이 38,000원", sources: [5], confidence: "high" },
      actual: { value: "할인 -5,000원은 뜨지만 최종 결제 금액은 43,000원 그대로", sources: [4], confidence: "high" },
      impact: { value: { customers: 1 }, sources: [], confidence: "medium" },
      environment: null,
    }),
    ask: (m) => {
      const field = /물을 칸: .+? \((\w+)\)/.exec(m.at(-1)!.content)?.[1] ?? "problem";
      return field === "environment"
        ? { question: "고객이 쓴 브라우저나 기기를 아세요?", choices: ["PC 웹", "모바일 웹", "앱"] }
        : { question: `${field} 를 알려 주세요`, choices: ["하나", "둘"] };
    },
    draft: () => ({
      title: "쿠폰 넣었는데 결제 금액이 그대로",
      acceptanceCriteria: ["WELCOME5000 을 적용하면 최종 결제 금액이 5,000원 줄어든다"],
      outOfScope: ["배송비 계산"],
      summary: { forRequester: "쿠폰 할인이 합계에 안 들어가는 문제예요", forDeveloper: "할인 줄은 보이는데 total 계산에 쿠폰이 빠짐" },
      slug: "coupon total",
      type: "bug",
      // 결제 화면 금액이 바뀌니 CS 가 화면으로 확인한다
      needsVisualCheck: true,
    }),
    review: () => ({ questions: ["정액 쿠폰인지 정률 쿠폰인지 알려 주세요"] }),
  };
  const ai: Ai = {
    queue: Object.assign(new EventEmitter(), { size: () => 0 }),
    enabled: async () => true,
    status: async () => ({ state: "ready", models: [], enabled: true, queue: 0, routing: {} as never }),
    async structured(task, schema, messages, o) {
      sent.push(messages.map((x) => x.content).join("\n"));
      const raw = replies[task]?.(messages);
      const p = raw === undefined ? null : schema.safeParse(raw);
      return { value: p?.success ? p.data : null, record: rec(task, o?.promptVersion) };
    },
    async text(task, messages, o) {
      sent.push(messages.map((x) => x.content).join("\n"));
      const t = `CS 용: ${messages.at(-1)!.content.split("개발자 글:\n")[1] ?? ""}`.trim();
      o?.onDelta?.(t);
      return { text: t, record: rec(task, o?.promptVersion) };
    },
  };
  return { ai, sent };
}

// ------------------------------------------------------------------------------------------ 서버와 HTTP

let createApp: typeof import("../src/server/app.js").createApp;
let membersPath: string;
beforeAll(async () => {
  membersPath = join(tmp("willnew-e2e-team-"), "members.json");
  writeFileSync(membersPath, JSON.stringify([person("이해준", "developer", T.dev), person("한지우", "requester", T.cs)]));
  ({ createApp } = await import("../src/server/app.js"));
});

describe("끝에서 끝: 쿠폰 시나리오 1~8 (팀 모드, 외부 호출 0건)", () => {
  it("접수부터 병합까지", { timeout: 60_000 }, async () => {
    const { ai, sent } = scenarioAi();
    const { app, injectWebSocket } = createApp({ repo: "/nowhere", check: "node --test", members: Members.load(membersPath), ai });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    injectWebSocket(server);
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(`${url}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : undefined };
    };
    const post = (path: string, token: string, body: unknown = {}) => call("POST", path, token, body);
    const get = (path: string, token: string) => call("GET", path, token);

    try {
      // 1. 접수: 지우가 채널톡 상담 기록을 통째로 붙여 넣는다. 개인정보는 규칙으로 먼저 가린다
      let r = await post("/api/intake", T.cs, { text: COUPON, channel: "channeltalk" });
      expect(r.status).toBe(200);
      let t = r.body;
      const key: string = t.key;
      const n = key.slice(2);
      expect(t).toMatchObject({ status: "clarifying", requester: "한지우", category: "new_bug" });
      expect(t.utterances.filter((u: { speaker: string }) => u.speaker === "agent").length).toBeGreaterThan(0);
      for (const pii of PII) {
        expect(JSON.stringify(t)).not.toContain(pii);
        expect(sent.join("\n")).not.toContain(pii);
      }
      expect(t.text).toContain("[PHONE_1]");
      expect(t.redactionsRef).toBe(t.id);
      expect(loadRedactions(t.redactionsRef).map((x) => x.value)).toEqual(expect.arrayContaining(PII));

      // 2. 대화: 상담 기록에 있는 칸은 묻지 않는다. 지우가 모르는 브라우저는 고객에게 물을 것으로
      expect(t.spec.expected).toBe("최종 결제 금액이 38,000원");
      expect(t.questions.map((q: { id: string }) => q.id)).toEqual([expect.stringMatching(/^f-environment-/)]);
      expect(t.next.question).toBe("고객이 쓴 브라우저나 기기를 아세요?");
      t = (await post(`/api/tickets/${key}/messages`, T.cs, { questionId: t.next.id, kind: "ask_customer" })).body;
      expect(t.spec.askCustomer[0]).toMatchObject({ field: "environment" });
      expect(t.next.id).toMatch(/^f-impact-/);
      t = (await post(`/api/tickets/${key}/messages`, T.cs, { questionId: t.next.id, kind: "answer", text: "한 명이요" })).body;
      t = (await post(`/api/tickets/${key}/messages`, T.cs, { questionId: t.next.id, kind: "answer", text: "새로고침" })).body;
      expect(t.status).toBe("waiting_customer");
      // 보내기 전 티켓은 개발자에게 안 보이고, 개발자가 대신 답하지도 못한다
      expect((await get(`/api/tickets/${key}`, T.dev)).status).toBe(403);
      expect((await get("/api/requests", T.dev)).body.map((x: { id: string }) => x.id)).not.toContain(t.id);
      t = (await post(`/api/tickets/${key}/customer-answer`, T.cs, { field: "environment", answer: "윈도우 크롬이요" })).body;
      expect(t.spec.environment).toEqual({ browser: "크롬", os: "윈도우" });

      // 3. 초안과 대리 검토: 필수 칸이 차면 초안. 대리 개발자 검토가 정액/정률을 한 번 더 묻는다
      expect(t.title).toBe("쿠폰 넣었는데 결제 금액이 그대로");
      expect(t.reviewQuestions).toEqual(["정액 쿠폰인지 정률 쿠폰인지 알려 주세요"]);
      expect(t.priority).toBeUndefined();
      expect(t.assignee).toBeUndefined();
      expect((await post(`/api/tickets/${key}/send`, T.cs)).status).toBe(409);
      t = (await post(`/api/tickets/${key}/messages`, T.cs, { questionId: "r-1", kind: "answer", text: "정액 5000원 쿠폰이에요" })).body;
      expect(t.status).toBe("spec_ready");

      // 추정 칸은 하나씩 확인해야 보낸다. 지우가 한 줄 고친다
      r = await post(`/api/tickets/${key}/send`, T.cs);
      expect(r.status).toBe(409);
      expect(r.body.unconfirmed.length).toBeGreaterThan(0);
      for (const field of r.body.unconfirmed) t = (await call("PATCH", `/api/tickets/${key}/fields`, T.cs, { field, confirm: true })).body;
      t = (await call("PATCH", `/api/tickets/${key}/fields`, T.cs, { field: "actual", value: "할인 -5,000원 줄은 뜨는데 최종 결제 금액은 43,000원 그대로" })).body;
      expect(t.edits.at(-1)).toMatchObject({ by: "한지우", field: "actual" });
      expect(t.unconfirmed).toEqual([]);
      t = (await post(`/api/tickets/${key}/send`, T.cs)).body;
      expect(t.status).toBe("open");

      // 4. 티켓함: 개발자가 P1 과 담당을 정한다. 담당은 members 의 개발자만
      expect((await get("/api/tickets?status=open", T.dev)).body.map((x: { key: string }) => x.key)).toContain(key);
      expect((await post(`/api/tickets/${key}/assign`, T.dev, { assignee: "한지우", priority: "P1" })).status).toBe(400);
      t = (await post(`/api/tickets/${key}/assign`, T.dev, { assignee: "이해준", priority: "P1" })).body;
      expect(t).toMatchObject({ status: "assigned", assignee: "이해준", priority: "P1" });

      // 5. 터미널: 실제 CLI 로 login, work. 저장소는 examples/shop 복사본
      const dir = tmp("willnew-e2e-shop-");
      cpSync(resolve("examples/shop"), dir, { recursive: true });
      g(dir, "init", "-q", "-b", "main");
      g(dir, "config", "user.email", "dev@example.com");
      g(dir, "config", "user.name", "dev");
      g(dir, "config", "commit.gpgsign", "false");
      g(dir, "add", ".");
      g(dir, "commit", "-q", "-m", "shop");
      const { runCli, defaultExec } = await import("../src/cli/index.js");
      const home = tmp("willnew-e2e-cli-");
      const out: string[] = [];
      const err: string[] = [];
      const env = { ...process.env, EDITOR: "", VISUAL: "" };
      const deps = {
        cwd: dir, env, out: (s: string) => out.push(s), err: (s: string) => err.push(s), prompt: async () => "", fetch: globalThis.fetch,
        credentialsPath: join(home, "credentials.json"), bins: { claude: "no-claude", codex: "no-codex", gh: "no-gh" }, exec: defaultExec(env), pollMs: 5, color: false,
      };
      const cli = async (cmd: string, ...args: string[]) => {
        const code = await runCli(cmd, args, deps);
        if (code !== 0) throw new Error(`${cmd} 실패: ${err.join("\n")}`);
      };
      await cli("login", url, "--token", T.dev);
      await cli("list");
      expect(out.some((l) => l.startsWith(key) && l.includes("P1") && l.includes("이해준"))).toBe(true);
      await cli("work", key, "--agent", "none", "--yes");
      const branch = `t-${n}-coupon-total`;
      expect(g(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
      const md = readFileSync(join(dir, ".willnew", "ticket.md"), "utf8");
      expect(md).toContain(`# ${key} 쿠폰 넣었는데 결제 금액이 그대로`);
      expect(md).toContain("WELCOME5000 을 적용하면 최종 결제 금액이 5,000원 줄어든다");
      for (const pii of PII) expect(md).not.toContain(pii);
      expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).permissions.deny.length).toBeGreaterThan(0);
      expect((await get(`/api/tickets/${key}`, T.cs)).body.status).toBe("in_progress");

      // 심은 버그가 재현되고, 고치면 통과한다. 커밋에는 hook 이 Ticket 꼬리말을 단다
      const bugTest = () => spawnSync(process.execPath, ["--test", ".maintainers/bug-tests/coupon-total.test.js"], { cwd: dir, encoding: "utf8" }).status;
      expect(bugTest()).not.toBe(0);
      const pricing = join(dir, "src", "pricing.js");
      const src = readFileSync(pricing, "utf8");
      const fixed = src.replace(/export function applyCoupon\(subtotal, coupon\) \{[\s\S]*?\n\}/, "export function applyCoupon(subtotal, coupon) {\n  return subtotal - getDiscount(subtotal, coupon);\n}");
      expect(fixed).not.toBe(src);
      writeFileSync(pricing, fixed);
      expect(bugTest()).toBe(0);
      g(dir, "commit", "-q", "-am", "쿠폰 할인을 최종 금액에 넣는다");
      expect(g(dir, "log", "-1", "--format=%B")).toContain(`Ticket: ${key}`);

      // 6. 되묻기: 터미널에서 묻고 지우가 답한다
      await cli("ask", key, "쿠폰 적용 순서가 배송비 전인가요 후인가요?");
      expect(out.join("\n")).toContain("CS 용: 쿠폰 적용 순서가 배송비 전인가요 후인가요?");
      expect((await get(`/api/tickets/${key}`, T.cs)).body.status).toBe("waiting_requester");
      const ask = (await get(`/api/tickets/${key}/asks`, T.cs)).body[0];
      expect((await post(`/api/tickets/${key}/asks/${ask.askId}/answer`, T.dev, { answer: "제가 답함" })).status).toBe(403);
      t = (await post(`/api/tickets/${key}/asks/${ask.askId}/answer`, T.cs, { answer: "배송비 전이요. 할인은 상품 금액에만" })).body;
      expect(t.status).toBe("in_progress");

      // 7. 완료: 화면 확인 대상이라 preview. CS 용 요약이 만들어진다
      await cli("done", key);
      t = (await get(`/api/tickets/${key}`, T.cs)).body;
      expect(t.status).toBe("preview");
      expect(t.report.forRequester).toContain("CS 용:");

      // 8. 요청자 확인: 다시 봐 주세요 → 개발자가 다시 끝냄 → 의도대로예요
      expect((await post(`/api/tickets/${key}/check`, T.dev, { verdict: "ok" })).status).toBe(403);
      t = (await post(`/api/tickets/${key}/check`, T.cs, { verdict: "changes", note: "할인 줄 금액도 같이 봐 주세요" })).body;
      expect(t.status).toBe("in_progress");
      await cli("done", key);
      expect((await get(`/api/tickets/${key}`, T.cs)).body.status).toBe("preview");
      t = (await post(`/api/tickets/${key}/check`, T.cs, { verdict: "ok" })).body;
      expect(t.status).toBe("code_review");

      // git: CLI 가 보고하는 sync 는 code_review 그대로(PR 주소를 남김), 웹훅 병합 → merged
      const sha = g(dir, "rev-parse", "HEAD");
      r = await post("/api/git/sync", T.dev, { branch, prUrl: "https://github.com/acme/shop/pull/42", prTitle: `${key} 쿠폰 넣었는데 결제 금액이 그대로`, sha });
      expect(r.body).toEqual({ key, status: "code_review" });
      process.env.WILLNEW_GITHUB_SECRET = "e2e-secret";
      try {
        const hook = JSON.stringify({ action: "closed", pull_request: { title: `${key} 쿠폰 합계`, body: `Ticket: ${key}`, merged: true, html_url: "https://github.com/acme/shop/pull/42", merge_commit_sha: sha, head: { ref: branch } } });
        r = await call("POST", "/api/git/events", undefined, hook, { "x-github-event": "pull_request", "x-hub-signature-256": githubSignature("e2e-secret", hook) });
        expect(r.body).toEqual({ ok: true, key, status: "merged" });
      } finally {
        delete process.env.WILLNEW_GITHUB_SECRET;
      }

      t = (await get(`/api/tickets/${key}`, T.cs)).body;
      expect(t).toMatchObject({ status: "merged", prUrl: "https://github.com/acme/shop/pull/42", branch });
      expect(t.actions.map((a: { who: string; what: string }) => `${a.who}:${a.what}`)).toEqual([
        "한지우:answer", "한지우:answer", "한지우:answer", "한지우:answer", "한지우:answer",
        ...t.actions.filter((a: { what: string }) => a.what === "confirm").map(() => "한지우:confirm"),
        "한지우:edit", "한지우:send", "이해준:assign", "이해준:work", "이해준:ask", "한지우:answer", "이해준:done", "한지우:check", "이해준:done", "한지우:check",
      ]);
      expect(t.llm.map((x: LlmRecord) => x.task)).toEqual(["extract", "ask", "ask", "ask", "draft", "review", "relay", "relay", "relay"]);
      for (const pii of PII) expect(JSON.stringify(t)).not.toContain(pii);
    } finally {
      server.close();
    }
    // 1~8 전부에서 외부 호출 0건
    expect(outside).toEqual([]);
  });
});
