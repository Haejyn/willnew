/**
 * Team chat front door (Slack-like, inside the web app). A message that mentions @willnew becomes a request:
 * ack → triage (planner agent) → run (worker agents) → result + review request → review outcome, all as bot replies.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, suggestWinner, type RunManager } from "./runs.js";
import { deployedReply, mergedReply, pickReviewer, rejectedReply, reviewMessage } from "./handoff.js";
import { defaultChannels, templateById, wantsRace, withRace } from "./templates.js";
import { triage } from "./triage.js";
import type { ShipEvent } from "./ship.js";
import type { AgentSpec, Channel, ChatMessage, Run } from "./types.js";

/** What the person changed in the compose box before sending — wins over the planner's choice. */
export interface PlanOverrides {
  template?: string;
  agents?: AgentSpec[];
  check?: string;
}

const CHAT_DIR = join(HOME, "chat");
const id = () => Math.random().toString(36).slice(2, 10);
const money = (x: number | null | undefined) => (x == null ? "비용 미보고" : `$${x.toFixed(2)}`);
const secs = (ms?: number) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}초`);

export class Chat {
  readonly bus = new EventEmitter();
  readonly channels: Channel[];
  private messages = new Map<string, ChatMessage[]>();

  constructor(private runs: RunManager, repo: string, private defaultCheck: string, reviewers: string[] = []) {
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
  }

  list(channel: string): ChatMessage[] {
    return this.messages.get(channel) ?? [];
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

  async post(channelId: string, user: string, text: string, team?: string, overrides?: PlanOverrides, userTitle?: string, userAvatar?: string) {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) throw new Error("unknown channel");
    const message = this.push({ id: id(), channel: channelId, ts: Date.now(), user, userTitle: userTitle || undefined, userAvatar: userAvatar || undefined, bot: false, text });
    if (!/@willnew\b/i.test(text)) return { message };

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
    this.bot(run.channel,
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
      ? (pr ? `승인 · ${r.reviewer} · ${who} 결과로 PR 을 올려요${why}` : `승인 · ${r.reviewer} · **${who}** → \`${run.baseBranch}\` 반영${why}`)
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
    const say = (t: string) => this.bot(run.channel!, t, "result", run.id);
    if (e === "pr") say(`PR #${s.prNumber} 올렸어요`);
    else if (e === "ci_passed") say(`CI ${s.checks?.length ?? 0}개 통과`);
    else if (e === "ci_failed") say(/^(git|gh) /.test(failed[0] ?? "") ? `PR 을 올리지 못했어요: ${failed[0]}` : `CI 실패: ${failed.join(", ") || "시간 초과"}. 자동으로 다시 돌리지 않았어요`);
    else if (e === "merged") {
      say(`${run.baseBranch}에 병합했어요`);
      if (!s.env) this.answer(run, mergedReply(run, note));
    } else if (e === "deployed") {
      say(`${env} 배포 끝났어요`);
      this.answer(run, deployedReply(run, note));
    } else say(`${env} 배포가 확인되지 않았어요. 정해 둔 시간 안에 끝나지 않았어요`);
  }
}
