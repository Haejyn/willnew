/**
 * Team chat front door (Slack-like, inside the web app). A message that mentions @willnew becomes a request:
 * ack → triage (planner agent) → run (worker agents) → result + review request → review outcome, all as bot replies.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, suggestWinner, type RunManager } from "./runs.js";
import { defaultChannels, templateById } from "./templates.js";
import { triage } from "./triage.js";
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

  constructor(private runs: RunManager, repo: string, private defaultCheck: string) {
    mkdirSync(CHAT_DIR, { recursive: true });
    this.channels = defaultChannels(repo);
    for (const c of this.channels) {
      const f = join(CHAT_DIR, `${c.id}.json`);
      this.messages.set(c.id, existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []);
    }
    this.bus.setMaxListeners(200);
    runs.bus.on("finished", (run: Run) => this.onFinished(run));
    runs.bus.on("reviewed", (run: Run) => this.onReviewed(run));
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

  async post(channelId: string, user: string, text: string, team?: string, overrides?: PlanOverrides) {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) throw new Error("unknown channel");
    const message = this.push({ id: id(), channel: channelId, ts: Date.now(), user, bot: false, text });
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
        if (overrides?.check !== undefined) plan.check = overrides.check;
        const tpl = templateById(plan.template);
        this.bot(channelId,
          `분류 **${tpl.name}** · ${plan.by === "llm" ? "계획 에이전트" : "키워드 규칙"}${plan.durationMs ? ` · ${secs(plan.durationMs)}` : ""}\n` +
          plan.plan.map((s, i) => `${i + 1}. ${s}`).join("\n") +
          `\n투입 ${plan.agents.map((a) => a.label).join(" · ")}${plan.check ? ` · 검증 \`${plan.check}\`` : ""}`,
          "triage", undefined, ackId);
        const run = await this.runs.create({ repo: channel.repo, task: plan.task, title: plan.title, agents: plan.agents,
          check: plan.check, requester: user, team: team ?? channel.team, template: plan.template, channel: channelId, triage: plan });
        this.bot(channelId, run.agents.length > 1
          ? `작업 시작 · 에이전트 ${run.agents.length}개 병렬 · 워크트리 격리`
          : `작업 시작 · ${run.agents[0].label} · 워크트리 격리`, "progress", run.id);
      } catch (e) {
        this.bot(channelId, `시작 실패 · ${(e as Error).message}`, "error");
      }
    })();
    return { message };
  }

  private onFinished(run: Run) {
    if (!run.channel) return;
    const lines = run.agents.map((a) => {
      const verdict = a.status !== "done" ? `✗ ${a.status}` : a.check.status === "passed" ? "✓ 검증 통과" : a.check.status === "failed" ? "✗ 검증 실패" : "✓ 완료";
      return `• ${a.label} — ${verdict} · ${secs(a.durationMs)} · ${money(a.usage.costUsd)}${a.attempt > 1 ? ` · 재시도 ${a.attempt - 1}회` : ""} · +${a.diff.insertions} −${a.diff.deletions}`;
    });
    const w = suggestWinner(run);
    this.bot(run.channel,
      `완료 · ${w ? `추천 **${w.label}** · 승인 시 \`${run.baseBranch}\` 반영` : "반영할 결과 없음"}\n` + lines.join("\n"),
      w ? "review" : "result", run.id);
  }

  private onReviewed(run: Run) {
    if (!run.channel) return;
    const r = run.review;
    const who = run.agents.find((a) => a.id === r.agentId)?.label ?? "";
    this.bot(run.channel, r.status === "approved"
      ? `승인 · ${r.reviewer} · **${who}** → \`${run.baseBranch}\` 반영${r.comment ? ` · “${r.comment}”` : ""}`
      : `반려 · ${r.reviewer}${r.comment ? ` · “${r.comment}”` : ""}`, "result", run.id);
  }
}
