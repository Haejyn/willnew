/**
 * Team chat front door (Slack-like, inside the web app). A message that mentions @willnew becomes a Request: one live
 * request card in the thread (clarify → spec → proposal → developer decision → run → review → ship), with a body for
 * the requester and one for the developer. A developer's ⌘K "바로 맡기기" (direct) skips the Request and starts a run
 * the old way: ack → triage → run → result + review request → review outcome.
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
import type { AgentSpec, Channel, ChatMessage, ClarifyQuestion, Request, Run } from "./types.js";

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
      this.messages.set(c.id, existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []);
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
  }

  list(channel: string): ChatMessage[] {
    return this.messages.get(channel) ?? [];
  }

  /** Toggle one reaction. The emoji is user content; a short allow-list keeps it to the few the UI offers. */
  react(channel: string, messageId: string, emoji: string, user: string): ChatMessage {
    const msg = this.list(channel).find((m) => m.id === messageId);
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

  private push(msg: ChatMessage) {
    const list = this.messages.get(msg.channel);
    if (!list) throw new Error("unknown channel");
    const i = list.findIndex((m) => m.id === msg.id);
    if (i >= 0) list[i] = msg; else list.push(msg);
    if (list.length > 500) list.splice(0, list.length - 500);
    writeFileSync(join(CHAT_DIR, `${msg.channel}.json`), JSON.stringify(list));
    this.bus.emit(`chat:${msg.channel}`, msg);
    return msg;
  }

  private bot(channel: string, text: string, kind: ChatMessage["kind"], runId?: string, msgId = id()) {
    return this.push({ id: msgId, channel, ts: Date.now(), user: "willnew", bot: true, text, kind, runId });
  }

  /**
   * `direct`: a developer's ⌘K 바로 맡기기, which starts a run right away. Everything else that mentions @willnew
   * becomes a Request and waits for a developer to confirm the proposal.
   */
  async post(channelId: string, user: string, text: string, team?: string, overrides?: PlanOverrides, userTitle?: string, userAvatar?: string, direct = false): Promise<{ message: ChatMessage; requestId?: string }> {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) throw new Error("unknown channel");
    const message = this.push({ id: id(), channel: channelId, ts: Date.now(), user, userTitle: userTitle || undefined, userAvatar: userAvatar || undefined, bot: false, text });
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
    // a Request's run reports on its live card; only the reviewer mention goes into the thread
    if (!run.requestId) this.bot(run.channel,
      `완료 · ${w ? `추천 **${w.label}** · 승인 시 \`${run.baseBranch}\` 반영` : "반영할 결과 없음"}\n` + lines.join("\n"),
      w ? "review" : "result", run.id);
    // hand the review to a person: the first channel reviewer who is not the requester
    const reviewer = w ? pickReviewer(this.channels.find((c) => c.id === run.channel), run.requester) : undefined;
    if (!w || !reviewer) return;
    const conflicts = await this.runs.preflight(run.id, w.id).then((p) => p.conflicts).catch(() => null);
    this.bot(run.channel, reviewMessage(reviewer, w, run.baseBranch, conflicts), "review", run.id);
  }

  /** The approver's own answer to the requester, sent through willnew (shown with a "willnew로 보냄" tag). */
  private answer(run: Run, text: string) {
    const who = run.review.reviewer;
    if (!run.channel || !who) return;
    this.push({ id: id(), channel: run.channel, ts: Date.now(), user: who, bot: false, via: "willnew", text, runId: run.id });
  }

  private onReviewed(run: Run) {
    if (!run.channel) return;
    const r = run.review;
    const who = run.agents.find((a) => a.id === r.agentId)?.label ?? "";
    const pr = run.ship?.mode === "pr";
    const why = r.comment ? ` · “${r.comment}”` : "";
    this.bot(run.channel, r.status === "approved"
      ? (pr ? `${r.reviewer}님이 승인해서 PR을 올려요${why}` : `승인 · ${r.reviewer} · **${who}** → \`${run.baseBranch}\` 반영${why}`)
      : `반려 · ${r.reviewer}${why}`, "result", run.id);
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

  /** One live card per Request, replaced in place (same message id) as the request moves. */
  private requestCard(req: Request) {
    if (!this.messages.has(req.channel)) return;
    const b = cardBodies(req);
    this.push({ id: `req-${req.id}`, channel: req.channel, ts: req.createdAt + 1, user: "willnew", bot: true, text: b.forDeveloper, bodies: b, requestId: req.id, kind: "request" });
  }

  private say(req: Request, b: { forRequester: string; forDeveloper: string }, kind: ChatMessage["kind"] = "result") {
    if (!this.messages.has(req.channel)) return;
    this.push({ id: id(), channel: req.channel, ts: Date.now(), user: "willnew", bot: true, text: b.forDeveloper, bodies: b, requestId: req.id, kind });
  }

  /** A tapped choice shows up as the requester's own message. */
  private onAnswered(req: Request, q: ClarifyQuestion) {
    if (!this.messages.has(req.channel)) return;
    this.push({ id: id(), channel: req.channel, ts: Date.now(), user: q.answeredBy ?? req.requester, userTitle: req.requesterTitle, userAvatar: req.requesterAvatar,
      bot: false, text: `${q.question}: ${q.answer}`, requestId: req.id });
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
    this.push({ id: id(), channel: req.channel, ts: Date.now(), user: by, bot: false, via: "willnew", requestId: req.id,
      text: `@${req.requester} ${d.forRequester}${alts ? `\n이렇게는 할 수 있어요\n${alts}` : ""}` });
  }
}
