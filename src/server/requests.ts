/**
 * Requests: what a teammate asked for, from the chat message to the shipped change. A Request owns the clarify Q&A,
 * the work spec, the implementation proposal, the decision log and the runs started for it.
 *
 *   message → plan (classify + clarify) → [answers] → spec → proposal (read-only agent) → developer decides
 *     proceed / proceed_with_changes → run (existing run → verify → approve → ship flow, linked by run.requestId)
 *     take_over → assigned to that developer, no AI run
 *     decline → planner writes the requester-facing explanation
 *
 * AI only translates and organises. Scope, priority and approval are decided by people through decide().
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPlanner, fallbackProposal, type Planner } from "./brief.js";
import { defaultProposalAgent, propose, type ProposalAgent } from "./proposal.js";
import { buildRunTask, isOpenRequest, moveTo, parseAttachments, statusFromRun, TEMPLATE_FOR_TYPE, transition, withConstraint } from "./request-state.js";
import { HOME, type RunManager } from "./runs.js";
import { flagUnverified } from "./spec-check.js";
import { templateById } from "./templates.js";
import type { AgentSpec, DecisionEntry, DecisionKind, Request, RequestUpdate, Run, RunUpdate } from "./types.js";

const REQUESTS_DIR = join(HOME, "requests");
const rid = () => `q${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`;

export interface CreateRequestInput {
  channel: string;
  repo: string;
  check: string;
  team: string;
  requester: string;
  requesterTitle?: string;
  requesterAvatar?: string;
  text: string;
  /** the developer asked to confirm the proposal (first channel reviewer who is not the requester) */
  reviewer?: string;
}

export type Decision = "proceed" | "proceed_with_changes" | "take_over" | "decline";
export interface DecideInput {
  decision: Decision;
  by: string;
  /** proceed_with_changes: the constraint · decline: the reason · take_over: optional note */
  text?: string;
}

type Runs = Pick<RunManager, "bus" | "create" | "get">;

export class RequestManager {
  readonly bus = new EventEmitter();
  private reqs = new Map<string, Request>();
  private byRun = new Map<string, string>();
  private planner: Planner;
  private proposer: ProposalAgent | null;
  private agents?: AgentSpec[];

  constructor(private runs: Runs, deps: { planner?: Planner; proposer?: ProposalAgent | null; agents?: AgentSpec[] } = {}) {
    this.planner = deps.planner ?? createPlanner();
    this.proposer = deps.proposer !== undefined ? deps.proposer : defaultProposalAgent();
    this.agents = deps.agents;
    this.bus.setMaxListeners(200);
    mkdirSync(REQUESTS_DIR, { recursive: true });
    for (const f of readdirSync(REQUESTS_DIR).filter((f) => f.endsWith(".json"))) {
      try {
        const r: Request = JSON.parse(readFileSync(join(REQUESTS_DIR, f), "utf8"));
        this.reqs.set(r.id, r);
        for (const id of r.runIds) this.byRun.set(id, r.id);
      } catch { /* skip corrupt file */ }
    }
    runs.bus.on("any", (u: RunUpdate) => this.onRun(u.runId));
    runs.bus.on("reviewed", (run: Run) => this.onReviewed(run));
  }

  list(): Request[] {
    return [...this.reqs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Request | undefined {
    return this.reqs.get(id);
  }

  private need(id: string): Request {
    const r = this.reqs.get(id);
    if (!r) throw new Error("요청을 찾을 수 없어요");
    return r;
  }

  /** A requester's chat message becomes a Request; planning starts in the background. */
  create(input: CreateRequestInput): Request {
    const text = input.text.trim();
    if (!text) throw new Error("요청 내용이 비어 있습니다");
    const now = Date.now();
    const req: Request = {
      id: rid(), channel: input.channel, repo: input.repo, check: input.check, team: input.team,
      requester: input.requester, requesterTitle: input.requesterTitle, requesterAvatar: input.requesterAvatar,
      text, attachments: parseAttachments(text), status: "draft", title: text.replace(/@willnew\b/gi, "").trim().split("\n")[0].slice(0, 40),
      questions: [], decisions: [], reviewer: input.reviewer, runIds: [], createdAt: now, updatedAt: now,
    };
    this.reqs.set(req.id, req);
    this.changed(req);
    void this.plan(req);
    return req;
  }

  /** The requester picked a choice (or wrote one under 기타). When the last one is in, the spec is written. */
  async answer(id: string, input: { questionId: string; answer: string; by: string }): Promise<Request> {
    const req = this.need(id);
    if (req.status !== "clarifying") throw new Error("지금은 답할 질문이 없어요");
    const q = req.questions.find((x) => x.id === input.questionId);
    if (!q) throw new Error("질문을 찾을 수 없어요");
    const a = input.answer.trim();
    if (!a) throw new Error("답이 비어 있어요");
    Object.assign(q, { answer: a.slice(0, 200), answeredBy: input.by, answeredAt: Date.now() });
    this.log(req, input.by, "answer", `${q.question}: ${q.answer}`);
    this.changed(req);
    this.bus.emit("answered", req, q);
    // the spec and the proposal take a while (the proposal reads the repo); the card follows along
    if (req.questions.every((x) => x.answer)) void this.specify(req);
    return req;
  }

  /** The developer's call on the proposal. Only people move a request past "proposed". */
  async decide(id: string, input: DecideInput): Promise<Request> {
    const req = this.need(id);
    if (req.status !== "proposed") throw new Error("확인할 제안이 없어요");
    const by = input.by.trim() || "anonymous";
    const text = input.text?.trim() ?? "";
    switch (input.decision) {
      case "proceed":
        await this.startRun(req, () => this.log(req, by, "proceed"));
        break;
      case "proceed_with_changes":
        if (!text) throw new Error("무엇을 고칠지 적어 주세요");
        await this.startRun(req, () => {
          req.spec = req.spec ? withConstraint(req.spec, text) : req.spec;
          this.log(req, by, "proceed_with_changes", text);
        });
        break;
      case "take_over":
        this.log(req, by, "take_over", text || undefined);
        req.assignee = by;
        transition(req, "approved");
        this.changed(req);
        this.bus.emit("taken_over", req, by);
        break;
      case "decline": {
        if (!text) throw new Error("거절 사유를 적어 주세요");
        this.log(req, by, "decline", text);
        const note = await this.planner.decline(req, text, by);
        req.decline = note.value;
        if (note.by === "fallback") req.planner = { ...(req.planner ?? { by: "llm" }), note: note.note };
        transition(req, "declined");
        this.changed(req);
        this.bus.emit("declined", req, by);
        break;
      }
      default:
        throw new Error("알 수 없는 결정이에요");
    }
    return req;
  }

  cancel(id: string, by: string, why?: string): Request {
    const req = this.need(id);
    if (!isOpenRequest(req.status)) throw new Error("이미 끝난 요청이에요");
    this.log(req, by, "cancel", why);
    transition(req, "cancelled");
    this.changed(req);
    return req;
  }

  /** 직접 할게 끝, or a shipped request put away. */
  close(id: string, by: string, why?: string): Request {
    const req = this.need(id);
    this.log(req, by, "close", why);
    transition(req, "closed");
    this.changed(req);
    return req;
  }

  // -------------------------------------------------------------------------------------------- pipeline

  private async plan(req: Request) {
    try {
      const b = await this.planner.brief(req.text, req.attachments, req.repo);
      Object.assign(req, { type: b.value.type, title: b.value.title, understood: b.value.understood, questions: b.value.questions });
      req.planner = { by: b.by, note: b.note, costUsd: b.costUsd };
      if (req.questions.length) {
        transition(req, "clarifying");
        this.changed(req);
        return;
      }
      this.changed(req);
      await this.specify(req);
    } catch (e) {
      req.planner = { by: "fallback", note: `정리 중 오류: ${(e as Error).message}` };
      this.changed(req);
    }
  }

  private async specify(req: Request) {
    try {
      await this.specifyAndPropose(req);
    } catch (e) {
      req.planner = { ...(req.planner ?? { by: "fallback" }), note: `명세나 제안을 만드는 중 오류: ${(e as Error).message}` };
      this.changed(req);
    }
  }

  private async specifyAndPropose(req: Request) {
    const s = await this.planner.spec(req.text, req.attachments, req.questions, req.repo);
    req.spec = s.value;
    req.title = s.value.title || req.title;
    req.planner = { by: req.planner?.by === "fallback" || s.by === "fallback" ? "fallback" : "llm", note: s.note ?? req.planner?.note, costUsd: add(req.planner?.costUsd, s.costUsd) };
    transition(req, "spec_ready");
    this.changed(req);
    let p;
    try {
      p = await propose(req, req.repo, this.proposer, HOME);
    } catch (e) {
      p = fallbackProposal(req.spec, `제안을 만들지 못했어요: ${(e as Error).message.slice(0, 160)}`);
    }
    req.proposal = p;
    // names in the criteria that the requester never wrote and nobody can find in the repo → 확인 필요
    const flags = await flagUnverified(req.spec, req, p, req.repo).catch(() => []);
    req.spec = { ...req.spec, needsCheck: flags.length ? flags : undefined };
    transition(req, "proposed");
    this.changed(req);
    this.bus.emit("proposed", req);
  }

  /** proceed: the run gets the spec, the acceptance criteria, the developer's constraints and the test-first rule. */
  private async startRun(req: Request, record: () => void) {
    const tpl = templateById(TEMPLATE_FOR_TYPE[req.type ?? "other"]);
    const before = { spec: req.spec, decisions: req.decisions.length };
    record();
    const task = buildRunTask(req, tpl.instruction);
    const agents = this.agents ?? tpl.agents;
    const check = req.check || tpl.check;
    const title = req.spec?.title ?? req.title;
    let run: Run;
    try {
      run = await this.runs.create({
        repo: req.repo, task, title, agents, check, requester: req.requester, requesterTitle: req.requesterTitle, requesterAvatar: req.requesterAvatar,
        team: req.team, template: tpl.id, channel: req.channel, requestId: req.id,
        triage: { by: "llm", template: tpl.id, title, task, plan: req.proposal?.approach ?? [], agents, check, reason: "개발자가 제안을 확인했어요" },
      });
    } catch (e) {
      // nothing started: the decision did not take effect
      req.spec = before.spec;
      req.decisions.length = before.decisions;
      throw e;
    }
    transition(req, "approved");
    req.runIds.push(run.id);
    this.byRun.set(run.id, req.id);
    moveTo(req, "building");
    this.changed(req);
    this.bus.emit("run_started", req, run);
  }

  private onRun(runId: string) {
    const reqId = this.byRun.get(runId);
    const req = reqId ? this.reqs.get(reqId) : undefined;
    const run = this.runs.get(runId);
    if (!req || !run || (!isOpenRequest(req.status) && req.status !== "merged")) return;
    const to = statusFromRun(run);
    if (!to || to === req.status) return;
    if (to === "declined") {
      if (!req.decline) req.decline = { reason: run.review.comment ?? "", forRequester: `이번엔 반영하지 않았어요.${run.review.comment ? ` 사유: ${run.review.comment}` : ""}`, alternatives: [] };
      transition(req, "declined");
    } else if (!moveTo(req, to)) return;
    this.changed(req);
  }

  private onReviewed(run: Run) {
    const req = run.requestId ? this.reqs.get(run.requestId) : undefined;
    if (!req) return;
    const r = run.review;
    if (r.status !== "approved" && r.status !== "rejected") return;
    this.log(req, r.reviewer ?? "anonymous", r.status === "approved" ? "approve_result" : "reject_result", r.comment);
    this.onRun(run.id);
    this.changed(req);
  }

  private log(req: Request, who: string, what: DecisionKind, why?: string) {
    const e: DecisionEntry = { who, when: Date.now(), what };
    if (why) e.why = why;
    req.decisions.push(e);
  }

  private changed(req: Request) {
    req.updatedAt = Date.now();
    writeFileSync(join(REQUESTS_DIR, `${req.id}.json`), JSON.stringify(req));
    const u: RequestUpdate = { requestId: req.id, request: req };
    this.bus.emit(`request:${req.id}`, u);
    this.bus.emit("changed", req);
  }
}

const add = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
