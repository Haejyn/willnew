/**
 * Team mode hub (docs/design/hub-runner.md). The hub keeps state, review and shipping; runners on developers' PCs run
 * the agents. `Hub` is the RemoteExecutor: RunManager calls it like any Executor, and it turns the calls into websocket
 * messages to the runner that took the run. It also owns the queue: a run waits here until someone assigns it to a
 * runner (`assign`) or, for runners that pay per use (`auth: "api"`, `claim: "auto"`), until one has a free slot.
 * Subscription runners only ever get runs their owner assigned explicitly.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "./app.js";
import type { Members } from "./members.js";
import type { ProposalAgent } from "./proposal.js";
import { memberOf } from "./team-auth.js";
import type { AgentSink, Executor, ExecutorHost } from "./executor.js";
import { HOME } from "./home.js";
import {
  capDiff, CLOSE_PROTO, CLOSE_REFUSED, CLOSE_UNAUTHORIZED, ghRepoOf, MAX_ARTIFACT_BYTES, normalizeRemote, PROTO,
  type Hello, type HubMessage, type Job, type PlanInput, type PlanResults, type PlanStep, type RpcMethod, type RpcResults, type RunnerMessage, type RunReport,
} from "./protocol.js";
import { RequestManager, type RemotePlanning } from "./requests.js";
import { RunManager } from "./runs.js";
import type { ShipOptions } from "./ship.js";
import { safe, ShotService } from "./shots.js";
import { checkBrief, checkDecline, checkProposal, checkSpec, type Planned, type Planner } from "./brief.js";
import type { AgentEvent, AgentRun, AgentSpec, Preview, Proposal, Request, Run, SpecFlag, Usage } from "./types.js";
import type { VisualCheck } from "./visual.js";

const FINISHED = new Set(["done", "failed", "cancelled"]);
const MAX_EVENTS = 500;
const GRACE_MS = 2 * 60_000;
const RPC_TIMEOUT_MS = 60_000;
/** fields the hub owns; a runner's patch or snapshot never overwrites them */
const HUB_OWNED = new Set(["id", "adapter", "label", "model", "branch", "worktree", "merged", "steers", "events"]);
const RUN_REPORT = new Set(["triage", "task", "title", "checkCmd", "baseRef"]);

/** Who a runner token belongs to (members.byRunnerToken). */
export type ResolveRunner = (token: string) => { name: string } | null;

export interface RunnerInfo {
  runnerId: string;
  owner: string;
  connected: boolean;
  auth?: Hello["auth"];
  claim?: Hello["claim"];
  slots: number;
  used: number;
  adapters: Hello["adapters"];
  repos: Hello["repos"];
  version?: string;
  connectedAt?: number;
  lastSeen: number;
  /** why the hub refused this runner (e.g. 러너 버전이 달라요) */
  problem?: string;
}

interface Conn {
  send(m: HubMessage): void;
  close(code: number, reason: string): void;
}

interface RunnerEntry {
  id: string;
  owner: string;
  hello?: Hello;
  conn?: Conn;
  connectedAt?: number;
  lastSeen: number;
  problem?: string;
}

interface QueuedJob {
  run: Run;
  sinks: Map<string, AgentSink>;
  runnerId?: string;
  /** job.assign went out */
  sent: boolean;
  noted?: boolean;
}

interface Pending {
  runnerId: string;
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

const note = (sink: AgentSink, kind: AgentEvent["kind"], text: string) => sink.patch({}, { ts: Date.now(), kind, text });
const key = (runId: string, agentId: string) => `${runId}/${agentId}`;
const pick = <T extends object>(o: T, keep: (k: string) => boolean): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => keep(k))) as Partial<T>;

export class Hub implements Executor {
  private runners = new Map<string, RunnerEntry>();
  private jobs = new Map<string, QueuedJob>();
  private pending = new Map<number, Pending>();
  private grace = new Map<string, NodeJS.Timeout>();
  /** agents cancelled because their runner stayed away; later reports about them are ignored */
  private dropped = new Set<string>();
  /** finished agents the hub reopened with a steer; only those may go back to work on a runner report */
  private reopened = new Set<string>();
  private host?: ExecutorHost;
  private seq = 0;
  readonly shotsDir: string;

  constructor(private opts: { resolveRunner: ResolveRunner; graceMs?: number; rpcTimeoutMs?: number; shotsDir?: string; log?: (s: string) => void }) {
    this.shotsDir = opts.shotsDir ?? join(HOME, "shots");
  }

  private log(s: string) {
    (this.opts.log ?? ((x: string) => console.log(x)))(s);
  }

  // ------------------------------------------------------------------------------------------ Executor

  attach(host: ExecutorHost) {
    this.host = host;
    for (const run of host.runs()) {
      const open = run.agents.filter((a) => !FINISHED.has(a.status));
      if (!open.length) continue;
      const sent = !!run.runnerId && open.some((a) => a.worktree.startsWith("runner:"));
      const job: QueuedJob = { run, sinks: new Map(open.map((a) => [a.id, host.sink(run, a)])), runnerId: run.runnerId, sent };
      this.jobs.set(run.id, job);
      // the hub restarted: the runner keeps working and sends a snapshot when it is back
      if (sent) for (const a of open) this.startGrace(job, a);
    }
  }

  start(run: Run, agent: AgentRun, sink: AgentSink) {
    let job = this.jobs.get(run.id);
    if (!job) {
      this.jobs.set(run.id, (job = { run, sinks: new Map(), sent: false }));
      // a claimed request's run: pinned to the claimer's runner, never handed to anyone else
      if (run.runnerId) {
        job.runnerId = run.runnerId;
        const r = this.runners.get(run.runnerId);
        if (r) sink.run?.({ runnerOwner: r.owner, runnerAuth: r.hello?.auth });
      }
    }
    job.sinks.set(agent.id, sink);
    // RunManager.create starts every agent in one go; send the run once they are all in
    queueMicrotask(() => this.dispatch());
  }

  assign(run: Run, runnerId: string) {
    const job = this.jobs.get(run.id);
    if (!job || job.run !== run) throw new Error("맡길 수 있는 작업이 없어요");
    if (job.runnerId || job.sent) throw new Error("이미 다른 러너가 맡았어요");
    const r = this.runners.get(runnerId);
    if (!r?.conn || !r.hello) throw new Error("러너가 연결돼 있지 않아요");
    const why = this.mismatch(r, job);
    if (why) throw new Error(why);
    job.runnerId = runnerId;
    this.sinkOf(job).run?.({ runnerId, runnerOwner: r.owner, runnerAuth: r.hello.auth });
    this.dispatch();
  }

  /**
   * A subscription runner only does work its owner asked for (docs/design/hub-runner.md, 약관 검토). A follow-up from
   * anyone else waits for the owner. Usage-billed runners take everything. When the runner is unknown (the hub
   * restarted and it has not come back), it counts as a subscription runner.
   */
  holdFor(run: Run, by: string): string | null {
    const runnerId = this.jobs.get(run.id)?.runnerId ?? run.runnerId;
    if (!runnerId) return null;
    const r = this.runners.get(runnerId);
    const auth = run.runnerAuth ?? r?.hello?.auth;
    if (auth === "api") return null;
    const owner = run.runnerOwner ?? r?.owner;
    if (owner && owner === by) return null;
    return owner ?? "러너 주인";
  }

  steer(run: Run, agent: AgentRun, text: string, sink: AgentSink) {
    const job = this.jobOf(run);
    if (job) job.sinks.set(agent.id, sink);
    // still in the queue: agent.steers (kept by RunManager) goes out with job.assign
    if (!job?.sent) return;
    if (FINISHED.has(agent.status)) this.reopened.add(key(run.id, agent.id));
    const by = agent.steers?.at(-1)?.by;
    this.call(run, "steer", { runId: run.id, agentId: agent.id, text, by }).catch((e: Error) => note(sink, "error", `이어서 지시를 러너에 보내지 못했어요: ${e.message}`));
  }

  cancel(run: Run, agent: AgentRun, sink: AgentSink) {
    const job = this.jobs.get(run.id);
    this.clearGrace(run.id, agent.id);
    if (job && !job.sent) {
      job.sinks.delete(agent.id);
      if (!job.sinks.size) this.jobs.delete(run.id);
    } else if (run.runnerId) {
      this.call(run, "cancel", { runId: run.id, agentId: agent.id }).catch(() => undefined);
    }
    sink.finished();
    queueMicrotask(() => this.dispatch());
  }

  busy(agent: AgentRun) {
    if (FINISHED.has(agent.status)) return false;
    for (const j of this.jobs.values()) if (j.sent && j.run.agents.includes(agent)) return true;
    return false;
  }

  async conflicts(run: Run, agent: AgentRun) {
    return this.call(run, "conflicts", { runId: run.id, agentId: agent.id }).catch(() => null);
  }

  push(run: Run, agent: AgentRun) {
    return this.call(run, "push", { runId: run.id, agentId: agent.id }, 5 * 60_000);
  }

  startPreview(run: Run, agent: AgentRun) {
    return this.call(run, "preview.start", { runId: run.id, agentId: agent.id }, 150_000);
  }

  stopPreview(run: Run, agent: AgentRun) {
    this.call(run, "preview.stop", { runId: run.id, agentId: agent.id }).catch(() => undefined);
  }

  async startBasePreview(run: Run, set: (p: Preview) => void) {
    const p = await this.call(run, "preview.base.start", { runId: run.id }, 150_000);
    set(p);
    return p;
  }

  stopBasePreview(run: Run) {
    this.call(run, "preview.base.stop", { runId: run.id }).catch(() => undefined);
  }

  async remove(run: Run) {
    const job = this.jobs.get(run.id);
    this.jobs.delete(run.id);
    for (const a of run.agents) this.clearGrace(run.id, a.id);
    if (run.runnerId && (job?.sent ?? true)) await this.call(run, "remove", { runId: run.id }).catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------ queue

  /** Runner-side work in flight (agents sent and not finished), counted against its slots. */
  private used(runnerId: string) {
    let n = 0;
    for (const j of this.jobs.values())
      if (j.sent && j.runnerId === runnerId) n += j.run.agents.filter((a) => j.sinks.has(a.id) && !FINISHED.has(a.status)).length;
    return n;
  }

  private fits(r: RunnerEntry, need: number) {
    const slots = r.hello?.slots ?? 0;
    return !!r.conn && slots - this.used(r.id) >= Math.min(need, slots);
  }

  /** Why this runner cannot take the job, or undefined. */
  private mismatch(r: RunnerEntry, job: QueuedJob): string | undefined {
    const remote = normalizeRemote(job.run.repo);
    if (!r.hello?.repos.some((x) => normalizeRemote(x.remote) === remote)) return "이 러너에는 그 저장소가 없어요";
    for (const a of job.run.agents)
      if (job.sinks.has(a.id) && !r.hello.adapters.some((x) => x.id === a.adapter && x.installed)) return `이 러너에서 쓸 수 없는 에이전트예요: ${a.adapter}`;
    return undefined;
  }

  /** Hand queued runs to runners: pinned ones to their runner, the rest to an auto runner with room. */
  private dispatch() {
    const queued = [...this.jobs.values()].filter((j) => !j.sent).sort((a, b) => a.run.createdAt - b.run.createdAt);
    for (const job of queued) {
      const need = job.sinks.size;
      let target: RunnerEntry | undefined;
      if (job.runnerId) {
        const r = this.runners.get(job.runnerId);
        if (r && this.fits(r, need)) target = r;
      } else {
        const auto = [...this.runners.values()].filter((r) => r.hello?.claim === "auto" && r.hello.auth === "api" && this.fits(r, need) && !this.mismatch(r, job));
        target = auto.sort((a, b) => (b.hello!.slots - this.used(b.id)) - (a.hello!.slots - this.used(a.id)))[0];
      }
      if (!target) {
        if (!job.noted) {
          job.noted = true;
          for (const s of job.sinks.values()) note(s, "status", job.runnerId ? "러너 슬롯이 비면 시작해요" : "맡을 사람 기다리는 중");
        }
        continue;
      }
      this.send(job, target);
    }
  }

  private send(job: QueuedJob, r: RunnerEntry) {
    const run = job.run;
    job.runnerId = r.id;
    job.sent = true;
    this.sinkOf(job).run?.({ runnerId: r.id, runnerOwner: r.owner, runnerAuth: r.hello?.auth });
    const agents = run.agents.filter((a) => job.sinks.has(a.id));
    for (const a of agents) job.sinks.get(a.id)!.patch({ worktree: `runner:${r.id}` }, { ts: Date.now(), kind: "status", text: `${r.owner}의 러너가 맡았어요` });
    const msg: Job = {
      id: run.id, remote: normalizeRemote(run.repo), baseBranch: run.baseBranch, title: run.title, text: run.task, check: run.checkCmd,
      maxAttempts: run.maxAttempts, requester: run.requester, requestId: run.requestId,
      agents: agents.map((a) => ({ id: a.id, adapter: a.adapter, label: a.label, model: a.model, branch: a.branch, steers: a.steers?.map((s) => s.text) })),
    };
    r.conn!.send({ t: "job.assign", run: msg });
  }

  // ------------------------------------------------------------------------------------------ rpc

  /** Ask the runner that took `run`. Rejects when nobody has it, the runner is away, or it does not answer in time. */
  call<M extends RpcMethod>(run: Run, method: M, params: Record<string, unknown>, timeoutMs = this.opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS): Promise<RpcResults[M]> {
    const runnerId = this.jobs.get(run.id)?.runnerId ?? run.runnerId;
    if (!runnerId) return Promise.reject(new Error("아직 맡은 러너가 없어요"));
    const conn = this.runners.get(runnerId)?.conn;
    if (!conn) return Promise.reject(new Error("러너가 연결돼 있지 않아요"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("러너가 답하지 않아요"));
      }, timeoutMs);
      this.pending.set(id, { runnerId, resolve: resolve as (v: unknown) => void, reject, timer });
      conn.send({ t: "rpc", id, method, params });
    });
  }

  // ------------------------------------------------------------------------------------------ planning

  /** Ask one runner for a plan step (plan.request → plan.result). */
  plan<S extends PlanStep>(runnerId: string, step: S, input: PlanInput, timeoutMs = step === "proposal" ? 15 * 60_000 : 3 * 60_000): Promise<PlanResults[S]> {
    const conn = this.runners.get(runnerId)?.conn;
    if (!conn) return Promise.reject(new Error("맡은 사람의 러너가 연결돼 있지 않아요"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("러너가 답하지 않아요"));
      }, timeoutMs);
      this.pending.set(id, { runnerId, resolve: resolve as (v: unknown) => void, reject, timer });
      conn.send({ t: "plan.request", id, requestId: input.requestId, step, input });
    });
  }

  /**
   * RequestManager's planning in team mode without a hub API key: every step goes to the runner of the developer who
   * claimed the request. What comes back is checked again here (same validation as the local planner), and a
   * subscription runner's cost is dropped.
   */
  planning(): RemotePlanning {
    const input = (req: Request, extra: Partial<PlanInput> = {}): PlanInput => ({
      requestId: req.id, text: req.text, attachments: req.attachments, questions: req.questions, spec: req.spec, requester: req.requester, ...extra,
    });
    const runnerOf = (req: Request) => {
      if (!req.runnerId) throw new Error("아직 맡은 사람이 없어요");
      return req.runnerId;
    };
    const paid = (runnerId: string) => this.runners.get(runnerId)?.hello?.auth === "api";
    const planned = <T>(runnerId: string, v: Planned<unknown>, value: T): Planned<T> => ({
      value, by: v.by === "llm" ? "llm" : "fallback", note: typeof v.note === "string" ? v.note.slice(0, 300) : undefined,
      costUsd: paid(runnerId) && typeof v.costUsd === "number" ? v.costUsd : null, attempts: Number(v.attempts) || 0,
    });
    return {
      brief: async (req) => {
        const id = runnerOf(req);
        const v = await this.plan(id, "brief", input(req));
        return planned(id, v, checkBrief(v.value));
      },
      spec: async (req) => {
        const id = runnerOf(req);
        const v = await this.plan(id, "spec", input(req));
        return planned(id, v, { ...checkSpec(v.value), constraints: [] });
      },
      proposal: async (req) => {
        const id = runnerOf(req);
        const v = await this.plan(id, "proposal", input(req));
        const p = v.proposal;
        const proposal: Proposal = {
          ...checkProposal(p), by: p?.by === "agent" ? "agent" : "fallback", note: typeof p?.note === "string" ? p.note.slice(0, 300) : undefined,
          costUsd: paid(id) && typeof p?.costUsd === "number" ? p.costUsd : null, durationMs: typeof p?.durationMs === "number" ? p.durationMs : undefined,
        };
        const needsCheck = (Array.isArray(v.needsCheck) ? v.needsCheck : [])
          .filter((f): f is SpecFlag => typeof f?.criterion === "string" && Array.isArray(f.names))
          .map((f) => ({ criterion: f.criterion, names: f.names.filter((n) => typeof n === "string").slice(0, 10) }));
        return { proposal, needsCheck };
      },
      decline: async (req, reason, developer) => {
        const id = runnerOf(req);
        const v = await this.plan(id, "decline", input(req, { reason, developer }));
        return planned(id, v, { reason, ...checkDecline(v.value) });
      },
    };
  }

  // ------------------------------------------------------------------------------------------ connections

  /**
   * One runner websocket. `token` comes from the Authorization header. Returns the handlers for incoming messages and
   * for the close; the caller wires them to its websocket library.
   */
  connect(token: string | undefined, send: (data: string) => void, close: (code: number, reason: string) => void) {
    const who = token ? this.opts.resolveRunner(token) : null;
    const conn: Conn = { send: (m) => send(JSON.stringify(m)), close };
    if (!who) {
      close(CLOSE_UNAUTHORIZED, "러너 토큰을 확인해 주세요");
      return { message: () => undefined, closed: () => undefined };
    }
    let entry: RunnerEntry | undefined;
    return {
      message: (raw: string) => {
        let m: RunnerMessage;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (!entry) {
          if (m.t !== "hello") return close(CLOSE_PROTO, "hello 가 먼저예요");
          entry = this.hello(m, who.name, conn);
          return;
        }
        entry.lastSeen = Date.now();
        this.onMessage(entry, m);
      },
      closed: () => {
        if (entry && entry.conn === conn) this.lost(entry);
      },
    };
  }

  private refuse(m: Hello, owner: string, conn: Conn, code: number, problem: string) {
    const id = String(m.runnerId ?? "").slice(0, 64) || "unknown";
    const cur = this.runners.get(id);
    if (!cur?.conn) this.runners.set(id, { id, owner, hello: undefined, lastSeen: Date.now(), problem });
    this.log(`러너 ${id} (${owner}) 거절: ${problem}`);
    conn.close(code, problem);
    return undefined;
  }

  private hello(m: Hello, owner: string, conn: Conn): RunnerEntry | undefined {
    if (m.proto !== PROTO) return this.refuse(m, owner, conn, CLOSE_PROTO, "러너 버전이 달라요");
    if (typeof m.runnerId !== "string" || !/^[\w.-]{1,64}$/.test(m.runnerId)) return this.refuse(m, owner, conn, CLOSE_REFUSED, "러너 이름이 이상해요");
    if (m.auth !== "api" && m.claim === "auto") return this.refuse(m, owner, conn, CLOSE_REFUSED, "개인 구독 러너는 자동으로 가져갈 수 없어요");
    const prev = this.runners.get(m.runnerId);
    if (prev?.conn && prev.owner !== owner) return this.refuse(m, owner, conn, CLOSE_REFUSED, "다른 사람이 쓰는 러너 이름이에요");
    if (prev?.conn) prev.conn.close(1000, "새 연결로 바뀌었어요");
    const hello: Hello = { ...m, slots: Math.max(1, Math.min(16, Number(m.slots) || 1)), repos: (m.repos ?? []).map((r) => ({ remote: normalizeRemote(r.remote), alias: r.alias })), adapters: m.adapters ?? [] };
    const entry: RunnerEntry = { id: m.runnerId, owner, hello, conn, connectedAt: Date.now(), lastSeen: Date.now() };
    this.runners.set(entry.id, entry);
    this.log(`러너 연결: ${entry.id} (${owner}, ${hello.auth}, ${hello.claim}, 슬롯 ${hello.slots})`);
    // back within the grace period: keep everything, the snapshot that follows overwrites the agents
    for (const job of this.jobs.values()) {
      if (job.runnerId !== entry.id) continue;
      for (const a of job.run.agents) if (this.clearGrace(job.run.id, a.id) && !FINISHED.has(a.status)) note(this.sinkFor(job, a), "status", "러너가 다시 붙었어요");
    }
    queueMicrotask(() => this.dispatch());
    return entry;
  }

  private lost(entry: RunnerEntry) {
    entry.conn = undefined;
    entry.lastSeen = Date.now();
    this.log(`러너 끊김: ${entry.id}`);
    for (const [id, p] of this.pending) {
      if (p.runnerId !== entry.id) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error("러너 연결이 끊겼어요"));
    }
    for (const job of this.jobs.values()) {
      if (!job.sent || job.runnerId !== entry.id) continue;
      for (const a of job.run.agents) {
        if (FINISHED.has(a.status) || !job.sinks.has(a.id)) continue;
        note(this.sinkFor(job, a), "status", "러너 연결 끊김");
        this.startGrace(job, a);
      }
    }
  }

  private startGrace(job: QueuedJob, agent: AgentRun) {
    const k = key(job.run.id, agent.id);
    if (this.grace.has(k)) return;
    this.grace.set(k, setTimeout(() => {
      this.grace.delete(k);
      if (this.runners.get(job.runnerId ?? "")?.conn || FINISHED.has(agent.status)) return;
      this.dropped.add(k);
      const sink = this.sinkFor(job, agent);
      const endedAt = Date.now();
      sink.patch({ status: "cancelled", endedAt, durationMs: agent.startedAt ? endedAt - agent.startedAt : undefined },
        { ts: endedAt, kind: "error", text: "러너 연결이 끊겨 취소됐어요" });
      sink.finished();
      this.dispatch();
    }, this.opts.graceMs ?? GRACE_MS));
  }

  /** true when a timer was running */
  private clearGrace(runId: string, agentId: string) {
    const k = key(runId, agentId);
    const t = this.grace.get(k);
    if (t) clearTimeout(t);
    return this.grace.delete(k);
  }

  private jobOf(run: Run): QueuedJob | undefined {
    let job = this.jobs.get(run.id);
    if (!job && run.runnerId && this.host) {
      // a finished run that is reopened (steer) after the hub restarted or after it left the queue
      job = { run, sinks: new Map(), runnerId: run.runnerId, sent: true };
      this.jobs.set(run.id, job);
    }
    return job;
  }

  private sinkFor(job: QueuedJob, agent: AgentRun): AgentSink {
    let s = job.sinks.get(agent.id);
    if (!s && this.host) job.sinks.set(agent.id, (s = this.host.sink(job.run, agent)));
    return s ?? { patch: () => undefined, finished: () => undefined };
  }

  private sinkOf(job: QueuedJob): AgentSink {
    return job.sinks.values().next().value ?? (this.host && job.run.agents[0] ? this.sinkFor(job, job.run.agents[0]) : { patch: () => undefined, finished: () => undefined });
  }

  /** The job and agent a runner message is about, only when that runner has the run. */
  private mine(entry: RunnerEntry, runId: string, agentId: string) {
    const run = this.jobs.get(runId)?.run ?? this.host?.runs().find((r) => r.id === runId);
    if (!run || run.runnerId !== entry.id) return undefined;
    const job = this.jobOf(run);
    const agent = run.agents.find((a) => a.id === agentId);
    if (!job || !agent) return undefined;
    return { job, agent, run };
  }

  private onMessage(entry: RunnerEntry, m: RunnerMessage) {
    switch (m.t) {
      case "agent.update": {
        const it = this.mine(entry, m.runId, m.agentId);
        if (!it || this.dropped.has(key(m.runId, m.agentId))) return;
        const sink = this.sinkFor(it.job, it.agent);
        if (m.run) {
          const r = pick(m.run as RunReport, (k) => RUN_REPORT.has(k));
          if (Object.keys(r).length) sink.run?.(r);
        }
        const was = FINISHED.has(it.agent.status);
        const p = pick(m.patch ?? {}, (k) => !HUB_OWNED.has(k));
        if (p.diff) p.diff = capDiff(p.diff);
        if (p.usage) p.usage = this.costOf(entry, p.usage);
        // a late report must not bring a cancelled agent back; a steer the hub sent may
        if (was && p.status && !FINISHED.has(p.status) && !this.reopened.delete(key(m.runId, m.agentId))) delete p.status;
        if (Object.keys(p).length || m.event) sink.patch(p, m.event);
        if (!was && FINISHED.has(it.agent.status)) {
          sink.finished();
          this.dispatch();
        }
        return;
      }
      case "agent.snapshot": {
        const it = this.mine(entry, m.runId, m.agent?.id);
        if (!it) return;
        const finishedThere = FINISHED.has(m.agent.status);
        // the hub already let go (grace ran out, or someone cancelled while the runner was away): stop it there too
        if (this.dropped.has(key(m.runId, it.agent.id)) || FINISHED.has(it.agent.status)) {
          if (!finishedThere && FINISHED.has(it.agent.status)) this.call(it.run, "cancel", { runId: m.runId, agentId: it.agent.id }).catch(() => undefined);
          return;
        }
        const sink = this.sinkFor(it.job, it.agent);
        const p = pick(m.agent, (k) => !HUB_OWNED.has(k));
        if (p.diff) p.diff = capDiff(p.diff);
        if (p.usage) p.usage = this.costOf(entry, p.usage);
        (p as Partial<AgentRun>).events = (m.agent.events ?? []).slice(-MAX_EVENTS);
        sink.patch(p);
        if (finishedThere) {
          sink.finished();
          this.dispatch();
        }
        return;
      }
      case "rpc.result":
      case "plan.result": {
        const p = this.pending.get(m.id);
        if (!p || p.runnerId !== entry.id) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error));
        return;
      }
      case "artifact.put":
        this.artifact(entry, m);
        return;
      default:
        return;   // terminal frames: later (6단계)
    }
  }

  /** A subscription runner reports no cost (지표에서는 구독으로 따로 센다); token counts stay. */
  private costOf(entry: RunnerEntry, usage: Usage): Usage {
    return entry.hello?.auth === "api" ? usage : { ...usage, costUsd: null };
  }

  /** A screenshot from the runner, stored where the web already reads shots: <home>/shots/<requestId>/<round>/<file>. */
  private artifact(entry: RunnerEntry, m: Extract<RunnerMessage, { t: "artifact.put" }>) {
    const it = this.mine(entry, m.runId, m.agentId);
    const name = /^shots\/(\d+)\/([\w가-힣-]+\.png)$/.exec(String(m.name));
    if (!it?.run.requestId || !name || m.mime !== "image/png") return;
    const buf = Buffer.from(String(m.base64), "base64");
    if (buf.length > MAX_ARTIFACT_BYTES) return;
    const dir = join(this.shotsDir, safe(it.run.requestId), name[1]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name[2]), buf);
  }

  /** One runner as /api/runners shows it. */
  runner(id: string): RunnerInfo | undefined {
    return this.list().find((r) => r.runnerId === id);
  }

  /** What /api/runners shows. */
  list(): RunnerInfo[] {
    return [...this.runners.values()].map((r) => ({
      runnerId: r.id, owner: r.owner, connected: !!r.conn, auth: r.hello?.auth, claim: r.hello?.claim, slots: r.hello?.slots ?? 0,
      used: this.used(r.id), adapters: r.hello?.adapters ?? [], repos: r.hello?.repos ?? [], version: r.hello?.version,
      connectedAt: r.connectedAt, lastSeen: r.lastSeen, problem: r.problem,
    }));
  }

  /**
   * 요청자 확인 screenshots in team mode: the runner that has the run opens both previews and captures the pairs, then
   * uploads each PNG (artifact.put) before it answers, so the files are here when the result arrives.
   */
  visual(): VisualCheck {
    const shots = new ShotService(this.shotsDir);
    const last = new Map<string, { run: Run; agentId: string }>();
    return {
      previews: async (run, agentId) => {
        if (run.requestId) last.set(run.requestId, { run, agentId });
        const pv = await this.call(run, "shots.previews", { runId: run.id, agentId }, 150_000);
        // without --preview-base-url on the runner the links only open on that PC: screenshots only, no links
        if (pv.localOnly) for (const side of [pv.after, pv.before]) if (side) side.url = "";
        return pv;
      },
      capture: async (input) => {
        const it = last.get(input.requestId);
        if (!it) return { shots: [], note: "스크린샷을 찍을 러너를 찾지 못했어요" };
        return this.call(it.run, "shots.capture", { ...input, runId: it.run.id, agentId: it.agentId }, 10 * 60_000);
      },
      file: (id, round, name) => shots.file(id, round, name),
    };
  }
}

type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];

/**
 * `/runner` (websocket), `GET /api/runners`, `POST /api/runs/:id/assign { runnerId }`,
 * `POST /api/requests/:id/claim { runnerId }` (내가 맡을게요), `POST /api/runs/:id/held/release` (이어서 실행).
 * The person comes from the team-auth guard; a developer may only hand work to a runner they own.
 */
export function mountHub(app: Hono, upgradeWebSocket: UpgradeWebSocket, hub: Hub, runs: RunManager, requests: RequestManager) {
  app.get("/runner", upgradeWebSocket((c) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
    let h: ReturnType<Hub["connect"]> | undefined;
    return {
      onOpen(_e, ws) {
        h = hub.connect(token, (d) => ws.send(d), (code, reason) => ws.close(code, reason));
      },
      onMessage(e) {
        h?.message(String(e.data));
      },
      onClose() {
        h?.closed();
      },
    };
  }));
  app.get("/api/runners", (c) => c.json(hub.list()));

  /** The runner, when `name` owns it and it is connected; otherwise the reason as a response. */
  const ownRunner = (c: Context, runnerId: string) => {
    const m = memberOf(c);
    const r = runnerId ? hub.runner(runnerId) : undefined;
    if (!m || !r || r.owner !== m.name) return { error: c.json({ error: "자기 러너로만 맡을 수 있어요" }, 403) };
    if (!r.connected) return { error: c.json({ error: "러너가 연결돼 있지 않아요. 러너를 먼저 띄워 주세요" }, 400) };
    return { member: m, runner: r };
  };

  app.post("/api/runs/:id/assign", async (c) => {
    const { runnerId } = await c.req.json();
    const own = ownRunner(c, String(runnerId ?? ""));
    if (own.error) return own.error;
    runs.assign(c.req.param("id"), own.runner.runnerId);
    return c.json({ ok: true });
  });

  app.post("/api/requests/:id/claim", async (c) => {
    const { runnerId } = await c.req.json();
    const own = ownRunner(c, String(runnerId ?? ""));
    if (own.error) return own.error;
    const req = requests.get(c.req.param("id"));
    if (!req) return c.json({ error: "요청을 찾을 수 없어요" }, 404);
    const why = requests.claimable(req, own.member.name);
    if (why) return c.json({ error: why }, 409);
    if (!own.runner.repos.some((x) => normalizeRemote(x.remote) === normalizeRemote(req.repo))) return c.json({ error: "이 러너에는 그 저장소가 없어요" }, 400);
    return c.json(requests.claim(req.id, { by: own.member.name, runnerId: own.runner.runnerId }));
  });

  app.post("/api/runs/:id/held/release", (c) => {
    const m = memberOf(c);
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const owner = run.runnerOwner ?? (run.runnerId ? hub.runner(run.runnerId)?.owner : undefined);
    if (!m || !owner || owner !== m.name) return c.json({ error: `러너 주인(${owner ?? "모름"})만 이어서 실행할 수 있어요` }, 403);
    return c.json({ ok: true, released: runs.releaseHeld(run.id, m.name) });
  });
}

export interface HubOptions {
  /** `github.com/org/app`; channels and runs use it as their repo */
  remote: string;
  /** people (members.json): person tokens for the web, runner tokens for runners, Slack ids */
  members: Members;
  /** approving your own request or a result you are assigned to is refused */
  noSelfApprove?: boolean;
  /**
   * The hub plans before anyone claims (되묻기, 명세, 제안) with its own API key. Off: planning waits for the claim and
   * runs on the claimer's runner. The CLI turns it on when ANTHROPIC_API_KEY is set.
   */
  planOnHub?: boolean;
  /** tests: the hub's own planner and proposal agent (planOnHub) */
  planner?: Planner;
  proposer?: ProposalAgent | null;
  /** tests: the agents a request's run uses instead of the template's */
  agents?: AgentSpec[];
  baseBranch?: string;
  check?: string;
  reviewers?: string[];
  deployCheck?: string;
  deployEnv?: string;
  /** extra ship options (tests: a fake gh runner, fast polling) */
  ship?: Partial<ShipOptions>;
  graceMs?: number;
  rpcTimeoutMs?: number;
  log?: (s: string) => void;
}

/** The hub: createApp with a RunManager in team mode driving a Hub, pr-only shipping with `gh --repo`, no terminal. */
export function createHub(opts: HubOptions) {
  const remote = normalizeRemote(opts.remote);
  const ghRepo = ghRepoOf(remote);
  if (!ghRepo) throw new Error(`--repo-remote 는 github.com/org/app 처럼 적어 주세요 (받은 값: ${opts.remote})`);
  const members = opts.members;
  const hub = new Hub({ resolveRunner: (t) => members.byRunnerToken(t), graceMs: opts.graceMs, rpcTimeoutMs: opts.rpcTimeoutMs, log: opts.log });
  const runs = new RunManager({ executor: hub, team: { baseBranch: opts.baseBranch ?? "main" },
    ship: { deployCheck: opts.deployCheck, deployEnv: opts.deployEnv, ...opts.ship, mode: "pr", ghRepo } });
  const requests = new RequestManager(runs, { visual: hub.visual(), planner: opts.planner, proposer: opts.proposer, agents: opts.agents, team: { remote: opts.planOnHub ? undefined : hub.planning() } });
  const app = createApp({ repo: remote, check: opts.check ?? "", reviewers: opts.reviewers, manager: runs, requests, terminal: false,
    members, noSelfApprove: opts.noSelfApprove, claims: true, routes: (a, up) => mountHub(a, up, hub, runs, requests) });
  return { ...app, hub, members };
}
