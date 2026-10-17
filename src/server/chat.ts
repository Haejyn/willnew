/**
 * Team chat front door (Slack-like, inside the web app). A message that mentions @willnew becomes a Request: one live
 * request card in the channel (clarify → spec → proposal → developer decision → run → 요청자 확인 → review → ship), with
 * a body for the requester and one for the developer. Everything said about the request after that (answers, mentions,
 * decisions, the requester check, replies) lives in the card's thread, not in the channel stream.
 * A developer's ⌘K "바로 맡기기" (direct) skips the Request and starts a run the old way: ack → triage → run → result +
 * review request → review outcome, in the channel.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardBodies } from "./request-state.js";
import { RequestManager } from "./requests.js";
import { HOME, suggestWinner, type RunManager } from "./runs.js";
import { deployedReply, mergedReply, pickReviewer, rejectedReply, reviewMessage } from "./handoff.js";
import { defaultChannels, templateById, wantsRace, withRace } from "./templates.js";
import { triage } from "./triage.js";
import type { ShipEvent } from "./ship.js";
import type { AgentSpec, Bodies, Channel, ChatMessage, ClarifyQuestion, Request, RequesterCheck, Run, ThreadSummary } from "./types.js";

/** What the person changed in the compose box before sending — wins over the planner's choice. */
export interface PlanOverrides {
  template?: string;
  agents?: AgentSpec[];
  check?: string;
}

const CHAT_DIR = join(HOME, "chat");
/** the reactions the UI offers */
export const REACTIONS = ["👍", "✅", "👀"];
const id = () => Math.random().toString(36).slice(2, 10);
const money = (x: number | null | undefined) => (x == null ? "비용 미보고" : `$${x.toFixed(2)}`);
const secs = (ms?: number) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}초`);
const MENTION = /@([\p{L}\p{N}_]+)/gu;

/** The thread a Request's messages live in: its card. */
export const requestThread = (req: Pick<Request, "id" | "threadId">) => req.threadId ?? `req-${req.id}`;
const runThread = (run: Pick<Run, "requestId">) => (run.requestId ? `req-${run.requestId}` : undefined);
/** Shown in the channel stream: everything that is not a thread reply, plus replies also sent to the channel. */
const inChannel = (m: ChatMessage) => !m.threadId || !!m.broadcast;

/** Names mentioned with @ in any body of the message. */
export function mentionsOf(m: Pick<ChatMessage, "text" | "bodies">): string[] {
  const all = [m.text, m.bodies?.forRequester ?? "", m.bodies?.forDeveloper ?? ""].join("\n");
  return [...new Set([...all.matchAll(MENTION)].map((x) => x[1]))];
}

export class Chat {
  readonly bus = new EventEmitter();
  readonly channels: Channel[];
  private messages = new Map<string, ChatMessage[]>();
  readonly requests: RequestManager;

  constructor(private runs: RunManager, repo: string, private defaultCheck: string, reviewers: string[] = [], requests?: RequestManager) {
    this.requests = requests ?? new RequestManager(runs);
    mkdirSync(CHAT_DIR, { recursive: true });
    this.channels = defaultChannels(repo, reviewers);
    for (const c of this.channels) {
      const f = join(CHAT_DIR, `${c.id}.json`);
      const list: ChatMessage[] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
      this.messages.set(c.id, list);
      if (this.migrate(list)) this.save(c.id);
    }
    this.bus.setMaxListeners(200);
    runs.bus.on("finished", (run: Run) => void this.onFinished(run));
    runs.bus.on("reviewed", (run: Run) => this.onReviewed(run));
    runs.bus.on("ship", (run: Run, e: ShipEvent) => this.onShip(run, e));
    const rq = this.requests.bus;
    rq.on("changed", (req: Request) => this.requestCard(req));
    rq.on("answered", (req: Request, q: ClarifyQuestion) => this.onAnswered(req, q));
    rq.on("proposed", (req: Request) => this.onProposed(req));
    rq.on("declined", (req: Request, by: string) => this.onDeclined(req, by));
    rq.on("taken_over", (req: Request, by: string) => this.say(req, { forRequester: `${by}님이 직접 맡았어요`, forDeveloper: `${by} 직접 작업 · AI 흐름에서 빠짐` }));
    rq.on("preview", (req: Request, c: RequesterCheck) => this.onPreview(req, c));
    rq.on("preview_ok", (req: Request, c: RequesterCheck, by: string) => void this.onPreviewOk(req, c, by));
    rq.on("preview_changes", (req: Request, c: RequesterCheck, by: string) => this.onPreviewChanges(req, c, by));
    rq.on("preview_skip", (req: Request, c: RequesterCheck, by: string) => void this.onPreviewSkip(req, c, by));
  }

  /**
   * Messages stored before threads existed: anything tied to a request (requestId, or a runId of a request's run)
   * moves into that request's thread. The card itself stays in the channel. Returns whether anything changed.
   */
  private migrate(list: ChatMessage[]): boolean {
    let changed = false;
    for (const m of list) {
      if (m.threadId || m.kind === "request") continue;
      const req = m.requestId ?? (m.runId ? this.runs.get?.(m.runId)?.requestId : undefined);
      if (!req || m.id === `req-${req}`) continue;
      m.threadId = `req-${req}`;
      changed = true;
    }
    return changed;
  }

  /** The channel stream (thread replies are left out unless they were also sent to the channel). */
  list(channel: string): ChatMessage[] {
    return (this.messages.get(channel) ?? []).filter(inChannel);
  }

  /** Replies in one thread, oldest first. */
  thread(channel: string, threadId: string): ChatMessage[] {
    return (this.messages.get(channel) ?? []).filter((m) => m.threadId === threadId).sort((a, b) => a.ts - b.ts);
  }

  /** One summary per thread in the channel, for the footer under each root. */
  threads(channel: string): ThreadSummary[] {
    const by = new Map<string, ChatMessage[]>();
    for (const m of this.messages.get(channel) ?? []) if (m.threadId) by.set(m.threadId, [...(by.get(m.threadId) ?? []), m]);
    return [...by].map(([tid, list]) => {
      const sorted = list.sort((a, b) => a.ts - b.ts);
      const users: ThreadSummary["users"] = [];
      for (const m of [...sorted].reverse()) {
        const name = m.bot ? "willnew" : m.user;
        if (users.length < 3 && !users.some((u) => u.name === name)) users.push({ name, avatar: m.bot ? undefined : m.userAvatar, bot: m.bot || undefined });
      }
      return { id: tid, count: sorted.length, lastTs: sorted.at(-1)!.ts, users, replies: sorted.map((m) => ({ ts: m.ts, user: m.bot ? "willnew" : m.user, mentions: mentionsOf(m) })) };
    });
  }

  private all(channel: string): ChatMessage[] {
    return this.messages.get(channel) ?? [];
  }

  /** Toggle one reaction. The emoji is user content; a short allow-list keeps it to the few the UI offers. */
  react(channel: string, messageId: string, emoji: string, user: string): ChatMessage {
    const msg = this.all(channel).find((m) => m.id === messageId);
    if (!msg) throw new Error("메시지를 찾을 수 없어요");
    if (!REACTIONS.includes(emoji)) throw new Error("쓸 수 없는 반응이에요");
    const who = user.trim() || "anonymous";
    const cur = new Set(msg.reactions?.[emoji] ?? []);
    if (cur.has(who)) cur.delete(who);
    else cur.add(who);
    const reactions = { ...(msg.reactions ?? {}), [emoji]: [...cur] };
    if (!cur.size) delete reactions[emoji];
    return this.push({ ...msg, reactions: Object.keys(reactions).length ? reactions : undefined });
  }

  private save(channel: string) {
    writeFileSync(join(CHAT_DIR, `${channel}.json`), JSON.stringify(this.all(channel)));
  }

  /** Store (same id = replace) and stream: the channel topic carries every message, a thread topic only its replies. */
  private push(msg: ChatMessage) {
    const list = this.messages.get(msg.channel);
    if (!list) throw new Error("unknown channel");
    const i = list.findIndex((m) => m.id === msg.id);
    if (i >= 0) list[i] = msg; else list.push(msg);
    if (list.length > 1000) list.splice(0, list.length - 1000);
    this.save(msg.channel);
    this.bus.emit(`chat:${msg.channel}`, msg);
    if (msg.threadId) this.bus.emit(`thread:${msg.channel}:${msg.threadId}`, msg);
    return msg;
  }

  private bot(channel: string, text: string, kind: ChatMessage["kind"], runId?: string, msgId = id(), threadId?: string) {
    return this.push({ id: msgId, channel, ts: Date.now(), user: "willnew", bot: true, text, kind, runId, threadId });
  }

  /**
   * `direct`: a developer's ⌘K 바로 맡기기, which starts a run right away. Everything else that mentions @willnew
   * becomes a Request and waits for a developer to confirm the proposal. `thread`: a reply in that thread (never a
   * new request), optionally also shown in the channel.
   */
  async post(channelId: string, user: string, text: string, team?: string, overrides?: PlanOverrides, userTitle?: string, userAvatar?: string, direct = false,
    thread?: { id: string; broadcast?: boolean }): Promise<{ message: ChatMessage; requestId?: string }> {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) throw new Error("unknown channel");
    const base = { id: id(), channel: channelId, ts: Date.now(), user, userTitle: userTitle || undefined, userAvatar: userAvatar || undefined, bot: false, text };
    if (thread?.id) {
      const root = this.all(channelId).find((m) => m.id === thread.id);
      if (!root || root.threadId) throw new Error("스레드를 찾을 수 없어요");
      if (!text.trim()) throw new Error("메시지가 비어 있어요");
      return { message: this.push({ ...base, threadId: root.id, broadcast: thread.broadcast || undefined, requestId: root.requestId, runId: root.runId }) };
    }
    const message = this.push(base);
    if (!/@willnew\b/i.test(text)) return { message };
    if (!direct) {
      const req = this.requests.create({ channel: channelId, repo: channel.repo, check: this.defaultCheck, team: team ?? channel.team, requester: user,
        requesterTitle: userTitle || undefined, requesterAvatar: userAvatar || undefined, text, reviewer: pickReviewer(channel, user) });
      return { message, requestId: req.id };
    }

    const ackId = id();
    this.bot(channelId, "접수 · 분류 중", "ack", undefined, ackId);
    void (async () => {
      try {
        const plan = await triage(text, channel.repo, this.defaultCheck);
        if (overrides?.template && overrides.template !== plan.template) {
          const t = templateById(overrides.template);
          plan.template = t.id;
          if (!overrides.agents?.length) plan.agents = t.agents;
        }
        if (overrides?.agents?.length) plan.agents = overrides.agents;
        else if (wantsRace(text)) plan.agents = withRace(plan.agents);
        if (overrides?.check !== undefined) plan.check = overrides.check;
        const tpl = templateById(plan.template);
        this.bot(channelId,
          `분류 **${tpl.name}** · ${plan.by === "llm" ? "계획 에이전트" : "키워드 규칙"}${plan.durationMs ? ` · ${secs(plan.durationMs)}` : ""}\n` +
          plan.plan.map((s, i) => `${i + 1}. ${s}`).join("\n") +
          `\n투입 ${plan.agents.length > 1 ? "겨루기 " : ""}${plan.agents.map((a) => a.label).join(" · ")}${plan.check ? ` · 검증 \`${plan.check}\`` : ""}`,
          "triage", undefined, ackId);
        const run = await this.runs.create({ repo: channel.repo, task: plan.task, title: plan.title, agents: plan.agents,
          check: plan.check, requester: user, requesterTitle: userTitle || undefined, requesterAvatar: userAvatar || undefined, team: team ?? channel.team, template: plan.template, channel: channelId, triage: plan });
        this.bot(channelId, run.agents.length > 1
          ? `작업 시작 · 겨루기 ${run.agents.length}개 병렬 · 워크트리 격리`
          : `작업 시작 · ${run.agents[0].label} · 워크트리 격리`, "progress", run.id);
      } catch (e) {
        this.bot(channelId, `시작 실패 · ${(e as Error).message}`, "error");
      }
    })();
    return { message };
  }

  private async onFinished(run: Run) {
    if (!run.channel) return;
    const lines = run.agents.map((a) => {
      const verdict = a.status !== "done" ? `✗ ${a.status}` : a.check.status === "passed" ? "✓ 검증 통과" : a.check.status === "failed" ? "✗ 검증 실패" : "✓ 완료";
      return `• ${a.label} · ${verdict} · ${secs(a.durationMs)} · ${money(a.usage.costUsd)}${a.attempt > 1 ? ` · 재시도 ${a.attempt - 1}회` : ""} · +${a.diff.insertions} −${a.diff.deletions}`;
    });
    const w = suggestWinner(run);
    // a Request's run reports on its live card; only the reviewer mention goes into its thread
    if (!run.requestId) this.bot(run.channel,
      `완료 · ${w ? `추천 **${w.label}** · 승인 시 \`${run.baseBranch}\` 반영` : "반영할 결과 없음"}\n` + lines.join("\n"),
      w ? "review" : "result", run.id);
    // the requester looks first (요청자 확인); the developer is asked once they say it is what they meant
    if (run.requestId && this.requests.get(run.requestId)?.status === "preview") return;
    await this.askReviewer(run);
  }

  /** `@이해준 검토 차례예요. 테스트 7개 통과, main과 충돌 없음` to the first channel reviewer who is not the requester. */
  private async askReviewer(run: Run, skip?: string) {
    const w = suggestWinner(run);
    const reviewer = w ? pickReviewer(this.channels.find((c) => c.id === run.channel), run.requester) : undefined;
    if (!run.channel || !w || !reviewer || reviewer === skip) return;
    const conflicts = await this.runs.preflight(run.id, w.id).then((p) => p.conflicts).catch(() => null);
    this.bot(run.channel, reviewMessage(reviewer, w, run.baseBranch, conflicts), "review", run.id, id(), runThread(run));
  }

  /** The approver's own answer to the requester, sent through willnew (shown with a "willnew로 보냄" tag). */
  private answer(run: Run, text: string) {
    const who = run.review.reviewer;
    if (!run.channel || !who) return;
    this.push({ id: id(), channel: run.channel, ts: Date.now(), user: who, bot: false, via: "willnew", text, runId: run.id, threadId: runThread(run) });
  }

  private onReviewed(run: Run) {
    if (!run.channel) return;
    const r = run.review;
    const who = run.agents.find((a) => a.id === r.agentId)?.label ?? "";
    const pr = run.ship?.mode === "pr";
    const why = r.comment ? ` · “${r.comment}”` : "";
    this.bot(run.channel, r.status === "approved"
      ? (pr ? `${r.reviewer}님이 승인해서 PR을 올려요${why}` : `승인 · ${r.reviewer} · **${who}** → \`${run.baseBranch}\` 반영${why}`)
      : `반려 · ${r.reviewer}${why}`, "result", run.id, id(), runThread(run));
    const note = run.agents.find((a) => a.id === r.agentId)?.userNote;
    if (r.status === "rejected") this.answer(run, rejectedReply(run, r.comment));
    else if (!pr) this.answer(run, mergedReply(run, note));
  }

  /** One short bot line per pipeline stage; the requester hears back from the approver at the last stage. */
  private onShip(run: Run, e: ShipEvent) {
    if (!run.channel || !run.ship) return;
    const s = run.ship;
    const failed = (s.checks ?? []).filter((c) => c.state === "fail").map((c) => c.name);
    const note = run.agents.find((a) => a.id === run.review.agentId)?.userNote;
    const env = s.env ?? "production";
    // a Request's run shows the pipeline on its card; the stage lines stay out of the thread
    const say = (t: string) => { if (!run.requestId) this.bot(run.channel!, t, "result"); };
    if (e === "pr") say(`PR #${s.prNumber} 올렸어요`);
    else if (e === "ci_passed") say(`CI ${s.checks?.length ?? 0}개 통과`);
    else if (e === "ci_failed") say(/^(git|gh) /.test(failed[0] ?? "") ? `PR을 올리지 못했어요: ${failed[0]}` : `CI 실패: ${failed.join(", ") || "시간 초과"}. 자동으로 다시 돌리지 않았어요`);
    else if (e === "merged") {
      say(`${run.baseBranch}에 병합했어요`);
      if (!s.env) this.answer(run, mergedReply(run, note));
    } else if (e === "deployed") {
      say(`${env} 배포 끝났어요`);
      this.answer(run, deployedReply(run, note));
    } else say(`${env} 배포가 확인되지 않았어요. 정해 둔 시간 안에 끝나지 않았어요`);
  }

  // ------------------------------------------------------------------------------------------ requests

  /** One live card per Request, replaced in place (same message id) as the request moves. It is the thread root. */
  private requestCard(req: Request) {
    if (!this.messages.has(req.channel)) return;
    const b = cardBodies(req);
    this.push({ id: `req-${req.id}`, channel: req.channel, ts: req.createdAt + 1, user: "willnew", bot: true, text: b.forDeveloper, bodies: b, requestId: req.id, kind: "request" });
  }

  private say(req: Request, b: Bodies, kind: ChatMessage["kind"] = "result") {
    if (!this.messages.has(req.channel)) return;
    this.push({ id: id(), channel: req.channel, ts: Date.now(), user: "willnew", bot: true, text: b.forDeveloper, bodies: b, requestId: req.id, kind, threadId: requestThread(req) });
  }

  /** A tapped choice shows up as the requester's own message in the thread. */
  private onAnswered(req: Request, q: ClarifyQuestion) {
    if (!this.messages.has(req.channel)) return;
    this.push({ id: id(), channel: req.channel, ts: Date.now(), user: q.answeredBy ?? req.requester, userTitle: req.requesterTitle, userAvatar: req.requesterAvatar,
      bot: false, text: `${q.question}: ${q.answer}`, requestId: req.id, threadId: requestThread(req) });
  }

  /** `@이해준 확인할 제안이 있어요. <one line>` */
  private onProposed(req: Request) {
    const who = req.reviewer;
    if (!who || !req.proposal) return;
    this.say(req, { forRequester: `${who}님께 확인을 부탁했어요`, forDeveloper: `@${who} 확인할 제안이 있어요. ${req.proposal.summary}` }, "mention");
  }

  /** The developer's decline, explained by the planner, sent as that developer through willnew. */
  private onDeclined(req: Request, by: string) {
    const d = req.decline;
    if (!d || !this.messages.has(req.channel)) return;
    const alts = d.alternatives.map((a) => `- ${a.title} (${a.effort})`).join("\n");
    this.push({ id: id(), channel: req.channel, ts: Date.now(), user: by, bot: false, via: "willnew", requestId: req.id, threadId: requestThread(req),
      text: `@${req.requester} ${d.forRequester}${alts ? `\n이렇게는 할 수 있어요\n${alts}` : ""}` });
  }

  /** 요청자 확인 starts: the requester is asked to look. */
  private onPreview(req: Request, c: RequesterCheck) {
    const again = c.round > 1 ? "다시 고친 결과예요. " : "";
    this.say(req, {
      forRequester: `@${req.requester} ${again}화면을 보고 의도대로인지 알려 주세요`,
      forDeveloper: `@${req.requester} 요청자 확인 차례예요 (${c.round}차). 미리보기와 전후 화면을 붙여요`,
    }, "check");
  }

  private async onPreviewOk(req: Request, c: RequesterCheck, by: string) {
    this.say(req, { forRequester: "확인했어요. 이제 개발자가 코드를 봐요", forDeveloper: `${by}님이 의도대로라고 했어요 (${c.round}차)` }, "check");
    const run = this.runs.get(c.runId);
    if (run) await this.askReviewer(run);
  }

  private onPreviewChanges(req: Request, c: RequesterCheck, by: string) {
    const fb = c.feedback ?? [];
    const lines = fb.map((f) => `- ${f.screen}${f.viewport === "mobile" ? " (모바일)" : ""}: ${f.note}`).join("\n");
    const dev = req.reviewer ? `@${req.reviewer} ` : "";
    this.say(req, {
      forRequester: `표시한 ${fb.length || 1}곳을 넘겼어요. 고쳐서 다시 보여 드릴게요`,
      forDeveloper: `${dev}${by}님이 다시 봐 달래요${fb.length ? ` (${fb.length}곳)` : ""}\n${lines}${lines ? "\n" : ""}같은 브랜치에서 ${c.round + 1}번째 시도를 시작했어요`,
    }, "check");
  }

  private async onPreviewSkip(req: Request, c: RequesterCheck, by: string) {
    this.say(req, {
      forRequester: `${by}님이 화면 확인 없이 코드 검토로 넘겼어요. 이유: ${c.reason ?? ""}`,
      forDeveloper: `${by}님이 요청자 확인을 건너뛰었어요. 이유: ${c.reason ?? ""}`,
    }, "check");
    const run = this.runs.get(c.runId);
    if (run) await this.askReviewer(run, by);
  }
}
