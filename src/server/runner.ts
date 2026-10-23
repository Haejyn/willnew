/**
 * `willnew runner`: runs agents on a developer's PC for a hub (docs/design/hub-runner.md). A thin layer around one
 * LocalExecutor: hub messages become method calls, and what the executor reports goes back as agent.update.
 *
 * The runner keeps its own copy of every run it took, with local paths (repo clone, worktrees under its own home).
 * Local paths never go to the hub: the hub stores `runner:<id>` as the worktree and the remote address as the repo.
 * Jobs are saved under <home>/runner/jobs so a restart can report what it was doing (in flight → cancelled).
 *
 * It never reads AI login files (~/.claude/.credentials.json, ~/.codex/auth.json); the auth kind comes from
 * environment variables only (detectAuth).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { ADAPTERS, installed as isInstalled } from "./adapters.js";
import { createPlanner, type Planner } from "./brief.js";
import { LocalExecutor, type AgentSink } from "./executor.js";
import { git, mergeConflicts } from "./git.js";
import { HOME } from "./home.js";
import { defaultProposalAgent, propose, type ProposalAgent } from "./proposal.js";
import { flagUnverified } from "./spec-check.js";
import {
  capDiff, CLOSE_PROTO, CLOSE_REFUSED, CLOSE_UNAUTHORIZED, MAX_ARTIFACT_BYTES, normalizeRemote, PROTO,
  type Claim, type Hello, type HubMessage, type Job, type PlanInput, type PlanResults, type PlanStep, type RunnerAuth, type RunnerMessage, type ShotsCaptureParams,
} from "./protocol.js";
import { safe, ShotService, type CapturerFactory } from "./shots.js";
import type { AgentRun, Preview, Run } from "./types.js";
import { defaultVisualCheck, type VisualCheck } from "./visual.js";

const FINISHED = new Set(["done", "failed", "cancelled"]);
const MAX_EVENTS = 500;
const VERSION = "0.1.0";

// ------------------------------------------------------------------------------------------------ auth

const on = (v: string | undefined) => !!v && v.trim() !== "" && !/^(0|false|no|off)$/i.test(v.trim());

/**
 * How this runner pays for AI, from environment variables only. `api` only when it is certainly usage-billed:
 * ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY for Claude, and
 * OPENAI_API_KEY or CODEX_API_KEY for Codex (when Codex is enabled). Everything else (CLAUDE_CODE_OAUTH_TOKEN, a plain
 * login, nothing set) is `subscription`. A CLAUDE_CODE_OAUTH_TOKEN next to an API key also counts as subscription,
 * because we cannot be sure which one the CLI uses.
 */
export function detectAuth(env: Record<string, string | undefined>, opts: { codex?: boolean } = {}): { auth: RunnerAuth; claude: RunnerAuth; codex?: RunnerAuth } {
  const claudeApi = !on(env.CLAUDE_CODE_OAUTH_TOKEN) &&
    (on(env.ANTHROPIC_API_KEY) || on(env.CLAUDE_CODE_USE_BEDROCK) || on(env.CLAUDE_CODE_USE_VERTEX) || on(env.CLAUDE_CODE_USE_FOUNDRY));
  const claude: RunnerAuth = claudeApi ? "api" : "subscription";
  if (!opts.codex) return { auth: claude, claude };
  const codex: RunnerAuth = on(env.OPENAI_API_KEY) || on(env.CODEX_API_KEY) ? "api" : "subscription";
  return { auth: claude === "api" && codex === "api" ? "api" : "subscription", claude, codex };
}

export interface RunnerPlan {
  auth: RunnerAuth;
  claim: Claim;
  slots: number;
  adapters: { id: string; installed: boolean }[];
}

/**
 * What a runner announces in hello. Refuses subscription + `--claim auto` (consumer plans cannot take work
 * automatically). Subscription runners default to 1 slot, api runners to 2. Codex is left out unless allowed.
 */
export function planRunner(input: { env: Record<string, string | undefined>; claim?: string; slots?: number; allowCodex?: boolean; installed?: (id: string) => boolean }): RunnerPlan {
  const claim = (input.claim ?? "manual") as Claim;
  if (claim !== "manual" && claim !== "auto") throw new Error("--claim 은 manual 또는 auto 예요");
  const { auth } = detectAuth(input.env, { codex: input.allowCodex });
  if (auth === "subscription" && claim === "auto")
    throw new Error("개인 구독 로그인으로는 --claim auto 를 쓸 수 없어요. 일을 직접 맡거나(--claim manual), ANTHROPIC_API_KEY 같은 사용량 과금 인증으로 띄워 주세요");
  const slots = input.slots ?? (auth === "subscription" ? 1 : 2);
  if (!Number.isInteger(slots) || slots < 1 || slots > 16) throw new Error("--slots 는 1 에서 16 사이예요");
  const has = input.installed ?? ((id: string) => isInstalled(ADAPTERS[id]));
  const adapters = Object.values(ADAPTERS).filter((a) => a.id !== "codex" || input.allowCodex).map((a) => ({ id: a.id, installed: has(a.id) }));
  return { auth, claim, slots, adapters };
}

// ------------------------------------------------------------------------------------------------ runner

export interface RunnerOptions extends RunnerPlan {
  /** ws://host:port/runner */
  hub: string;
  token: string;
  /** local clone */
  repo: string;
  runnerId?: string;
  owner?: string;
  preview?: string;
  previewBaseUrl?: string;
  /** where worktrees, jobs and shots go (default the willnew home) */
  home?: string;
  capturer?: CapturerFactory;
  backoff?: { minMs: number; maxMs: number };
  log?: (s: string) => void;
  /** the hub refused this runner for good (bad token, other proto, subscription + auto) */
  onFatal?: (reason: string) => void;
  /** planning for claimed requests (되묻기, 명세, 거절 설명); default Haiku through this PC's Claude Code */
  planner?: Planner;
  /** the read-only proposal pass; default this PC's Claude Code */
  proposer?: ProposalAgent | null;
}

interface LocalJob {
  run: Run;
}

export class Runner {
  readonly id: string;
  private home: string;
  private jobsDir: string;
  private executor: LocalExecutor;
  private visual: VisualCheck;
  private jobs = new Map<string, LocalJob>();
  private ws?: WebSocket;
  private stopped = false;
  private tries = 0;
  private timer?: NodeJS.Timeout;
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private remote = "";
  private root = "";
  private planner?: Planner;
  connected = false;

  constructor(private opts: RunnerOptions) {
    this.home = opts.home ?? HOME;
    this.id = opts.runnerId ?? `${hostname()}-${basename(opts.repo)}`.replace(/[^\w.-]+/g, "-").slice(0, 64);
    this.jobsDir = join(this.home, "runner", "jobs");
    this.executor = new LocalExecutor({ preview: opts.preview, home: this.home });
    const runs = {
      previewCommand: opts.preview ?? "",
      previewLink: (port: number) => this.previewLink(port),
      startPreview: async (runId: string, agentId: string) => {
        const { run, agent } = this.need(runId, agentId);
        return this.executor.startPreview(run, agent, this.sink(run, agent));
      },
      startBasePreview: async (runId: string) => {
        const { run } = this.need(runId);
        return this.executor.startBasePreview(run, (p) => { run.basePreview = p; });
      },
    };
    this.visual = defaultVisualCheck(runs, this.home, new ShotService(join(this.home, "shots"), opts.capturer));
  }

  private log(s: string) {
    (this.opts.log ?? ((x: string) => console.log(x)))(s);
  }

  /** Read the clone, load saved jobs, connect. Resolves once the first connection attempt has been made. */
  async start() {
    this.root = (await git(this.opts.repo, "rev-parse", "--show-toplevel")).trim();
    // the configured address, not the insteadOf-expanded one: that is what the hub knows
    const url = (await git(this.root, "config", "--get", "remote.origin.url").catch(() => "")).trim();
    if (!url) throw new Error("저장소에 origin 원격이 없어요");
    this.remote = normalizeRemote(url);
    this.load();
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, "runner stopped");
    // dev servers started for previews and screenshots do not outlive the runner
    for (const { run } of this.jobs.values()) {
      for (const a of run.agents) this.executor.stopPreview(run, a);
      this.executor.stopBasePreview(run);
    }
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      const job = this.jobs.get(id);
      if (job) this.write(job);
    }
    this.saveTimers.clear();
  }

  private load() {
    mkdirSync(this.jobsDir, { recursive: true });
    for (const f of readdirSync(this.jobsDir).filter((f) => f.endsWith(".json"))) {
      try {
        const run: Run = JSON.parse(readFileSync(join(this.jobsDir, f), "utf8"));
        for (const a of run.agents) {
          // a runner restart interrupts what was in flight; the worktree stays
          if (!FINISHED.has(a.status)) {
            a.status = "cancelled";
            a.events.push({ ts: Date.now(), kind: "status", text: "러너가 다시 시작돼서 멈췄어요", attempt: a.attempt });
          }
          if (a.preview && a.preview.status !== "failed") a.preview = { ...a.preview, status: "stopped" };
        }
        if (run.basePreview && run.basePreview.status !== "failed") run.basePreview = { ...run.basePreview, status: "stopped" };
        this.jobs.set(run.id, { run });
      } catch { /* skip corrupt file */ }
    }
  }

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.hub, { headers: { authorization: `Bearer ${this.opts.token}` } } as unknown as string[]);
    } catch (e) {
      this.log(`허브 주소를 열 수 없어요: ${(e as Error).message}`);
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.connected = true;
      this.log(`허브에 연결했어요: ${this.opts.hub}`);
      this.hello();
    };
    ws.onmessage = (e) => {
      let m: HubMessage;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      void this.onMessage(m);
    };
    ws.onerror = () => undefined;
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = undefined;
      if (this.stopped) return;
      if (e.code === CLOSE_UNAUTHORIZED || e.code === CLOSE_PROTO || e.code === CLOSE_REFUSED) {
        this.stopped = true;
        this.log(`허브가 연결을 거절했어요: ${e.reason || e.code}`);
        this.opts.onFatal?.(e.reason || String(e.code));
        return;
      }
      this.retry();
    };
  }

  /** Exponential backoff with a little jitter. */
  private retry() {
    if (this.stopped) return;
    const { minMs, maxMs } = this.opts.backoff ?? { minMs: 1000, maxMs: 60_000 };
    const ms = Math.min(maxMs, minMs * 2 ** this.tries++) * (0.8 + Math.random() * 0.4);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), ms);
  }

  private send(m: RunnerMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private hello() {
    const hello: Hello = {
      t: "hello", proto: PROTO, runnerId: this.id, owner: this.opts.owner ?? userInfo().username, version: VERSION,
      auth: this.opts.auth, claim: this.opts.claim, slots: this.opts.slots, adapters: this.opts.adapters,
      repos: [{ remote: this.remote, alias: basename(this.root) }],
    };
    this.send(hello);
    // everything this runner knows, in flight or finished; the hub keeps what it already let go
    for (const { run } of this.jobs.values())
      for (const a of run.agents) this.send({ t: "agent.snapshot", runId: run.id, agent: this.outAgent(run, a) });
  }

  // ---------------------------------------------------------------------------------------------- paths out

  /** Replace local paths with something that says where the work is without saying the path. */
  private scrub(run: Run, s: string): string {
    let out = s;
    for (const a of run.agents)
      for (const p of variants(a.worktree)) out = out.split(p).join(`runner:${this.id}`);
    for (const p of variants(this.root)) out = out.split(p).join(`(${basename(this.root)})`);
    for (const p of variants(this.home)) out = out.split(p).join("(runner home)");
    return out;
  }

  private outPatch(run: Run, p: Partial<AgentRun>): Partial<AgentRun> {
    const o: Partial<AgentRun> = { ...p };
    delete o.worktree;
    if (o.diff) o.diff = capDiff(o.diff);
    if (o.check) o.check = { ...o.check, output: this.scrub(run, o.check.output) };
    if (o.preview) o.preview = { ...o.preview, log: this.scrub(run, o.preview.log) };
    if (o.summary) o.summary = this.scrub(run, o.summary);
    if (o.userNote) o.userNote = this.scrub(run, o.userNote);
    if (o.events) o.events = o.events.slice(-MAX_EVENTS).map((e) => ({ ...e, text: this.scrub(run, e.text) }));
    return o;
  }

  private outAgent(run: Run, a: AgentRun): AgentRun {
    return { ...(this.outPatch(run, a) as AgentRun), worktree: "" };
  }

  // ---------------------------------------------------------------------------------------------- state

  private need(runId: string, agentId?: string) {
    const job = this.jobs.get(runId);
    if (!job) throw new Error("이 러너에는 그 작업이 없어요");
    const agent = agentId ? job.run.agents.find((a) => a.id === agentId) : undefined;
    if (agentId && !agent) throw new Error("이 러너에는 그 에이전트가 없어요");
    return { run: job.run, agent: agent! };
  }

  /** Applies a patch to the local copy (the executor reads it) and forwards it to the hub. */
  private sink(run: Run, agent: AgentRun): AgentSink {
    return {
      patch: (p, event) => {
        Object.assign(agent, p);
        if (event) {
          agent.events.push({ ...event, attempt: agent.attempt });
          if (agent.events.length > MAX_EVENTS) agent.events.splice(0, agent.events.length - MAX_EVENTS);
        }
        this.save(run);
        const out: RunnerMessage = { t: "agent.update", runId: run.id, agentId: agent.id };
        if (Object.keys(p).length) out.patch = this.outPatch(run, p);
        if (event) out.event = { ...event, text: this.scrub(run, event.text) };
        this.send(out);
      },
      finished: () => this.save(run, true),
    };
  }

  private write(job: LocalJob) {
    mkdirSync(this.jobsDir, { recursive: true });
    writeFileSync(join(this.jobsDir, `${job.run.id}.json`), JSON.stringify(job.run));
  }

  private save(run: Run, now = false) {
    const job = this.jobs.get(run.id);
    if (!job) return;
    if (now) {
      clearTimeout(this.saveTimers.get(run.id));
      this.saveTimers.delete(run.id);
      return this.write(job);
    }
    if (!this.saveTimers.has(run.id)) this.saveTimers.set(run.id, setTimeout(() => { this.saveTimers.delete(run.id); this.write(job); }, 400));
  }

  private previewLink(port: number): { url: string; localOnly: boolean } {
    const url = (this.opts.previewBaseUrl || "http://127.0.0.1:{port}").replaceAll("{port}", String(port));
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a URL: treat as local */
    }
    return { url, localOnly: !host || host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" };
  }

  // ---------------------------------------------------------------------------------------------- hub messages

  private async onMessage(m: HubMessage) {
    if (m.t === "job.assign") return this.take(m.run);
    if (m.t === "plan.request") {
      try {
        const value = await this.plan(m.step, m.input);
        this.send({ t: "plan.result", id: m.id, requestId: m.requestId, ok: true, value });
      } catch (e) {
        this.send({ t: "plan.result", id: m.id, requestId: m.requestId, ok: false, error: this.scrubLocal((e as Error).message) });
      }
      return;
    }
    if (m.t !== "rpc") return;   // terminal frames: later (6단계)
    try {
      const value = await this.rpc(m.method, m.params);
      this.send({ t: "rpc.result", id: m.id, ok: true, value: value ?? null });
    } catch (e) {
      this.send({ t: "rpc.result", id: m.id, ok: false, error: (e as Error).message });
    }
  }

  /** job.assign: fetch, make the local copy, start every agent from origin/<base>. */
  private async take(job: Job) {
    if (this.jobs.has(job.id)) return;
    const agents: AgentRun[] = job.agents.map((a) => ({
      id: a.id, adapter: a.adapter, label: a.label, model: a.model, branch: a.branch,
      worktree: join(this.home, "worktrees", `${basename(this.root)}-${job.id}`, a.id),
      status: "queued", attempt: 1, turns: 0,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null },
      summary: "", check: { status: "skipped", exitCode: null, output: "" },
      diff: { files: 0, insertions: 0, deletions: 0, patch: "" }, merged: false, events: [],
    }));
    const run: Run = {
      id: job.id, title: job.title, task: job.text, repo: this.root, baseRef: "", baseBranch: job.baseBranch, checkCmd: job.check,
      createdAt: Date.now(), requester: job.requester, team: "", template: "", review: { status: "none" },
      maxAttempts: job.maxAttempts, agents, requestId: job.requestId,
    };
    this.jobs.set(run.id, { run });
    this.save(run, true);
    const fail = (text: string) => {
      for (const a of agents) this.sink(run, a).patch({ status: "failed", endedAt: Date.now() }, { ts: Date.now(), kind: "error", text });
      this.save(run, true);
    };
    if (normalizeRemote(job.remote) !== this.remote) return fail("이 러너에는 그 저장소가 없어요");
    const bad = agents.find((a) => !this.opts.adapters.some((x) => x.id === a.adapter && x.installed));
    if (bad) return fail(`이 러너에서 쓸 수 없는 에이전트예요: ${bad.adapter}`);
    try {
      await git(this.root, "fetch", "origin", job.baseBranch);
      run.baseRef = (await git(this.root, "rev-parse", `origin/${job.baseBranch}`)).trim();
    } catch (e) {
      return fail(`git fetch 실패: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
    }
    this.send({ t: "agent.update", runId: run.id, agentId: agents[0].id, run: { baseRef: run.baseRef } });
    this.log(`맡았어요: ${run.title} (${run.id})`);
    for (const a of agents) {
      const sink = this.sink(run, a);
      for (const s of job.agents.find((x) => x.id === a.id)?.steers ?? []) this.executor.steer(run, a, s, sink);   // queued: picked up at start
      this.executor.start(run, a, sink);
    }
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const runId = String(params.runId ?? "");
    const agentId = params.agentId == null ? undefined : String(params.agentId);
    switch (method) {
      case "steer": {
        const { run, agent } = this.need(runId, agentId);
        this.executor.steer(run, agent, String(params.text ?? ""), this.sink(run, agent));
        return null;
      }
      case "cancel": {
        const { run, agent } = this.need(runId, agentId);
        if (FINISHED.has(agent.status)) return null;
        const sink = this.sink(run, agent);
        const endedAt = Date.now();
        sink.patch({ status: "cancelled", endedAt, durationMs: agent.startedAt ? endedAt - agent.startedAt : undefined }, { ts: endedAt, kind: "status", text: "취소됨" });
        this.executor.cancel(run, agent, sink);
        return null;
      }
      case "conflicts": {
        const { run, agent } = this.need(runId, agentId);
        await git(run.repo, "fetch", "origin", run.baseBranch).catch(() => undefined);
        return mergeConflicts(run.repo, agent.branch, `origin/${run.baseBranch}`);
      }
      case "push": {
        const { run, agent } = this.need(runId, agentId);
        if (agent.status !== "done") throw new Error("끝난 에이전트만 올릴 수 있어요");
        const r = await this.executor.push(run, agent);
        this.log(`올렸어요: ${r.branch} ${r.sha.slice(0, 7)}`);
        return r;
      }
      case "remove": {
        const job = this.jobs.get(runId);
        if (!job) return null;
        const run = job.run;
        for (const a of run.agents) {
          if (this.executor.busy(a)) {
            const sink = this.sink(run, a);
            sink.patch({ status: "cancelled", endedAt: Date.now() });
            this.executor.cancel(run, a, sink);
          }
          this.executor.stopPreview(run, a);
        }
        this.executor.stopBasePreview(run);
        await this.executor.remove(run);
        this.jobs.delete(runId);
        clearTimeout(this.saveTimers.get(runId));
        this.saveTimers.delete(runId);
        rmSync(join(this.jobsDir, `${runId}.json`), { force: true });
        return null;
      }
      case "preview.start": {
        const { run, agent } = this.need(runId, agentId);
        return this.executor.startPreview(run, agent, this.sink(run, agent));
      }
      case "preview.stop": {
        const { run, agent } = this.need(runId, agentId);
        if (agent.preview) this.sink(run, agent).patch({ preview: { ...agent.preview, status: "stopped" } });
        this.executor.stopPreview(run, agent);
        return null;
      }
      case "preview.base.start": {
        const { run } = this.need(runId);
        const p: Preview = await this.executor.startBasePreview(run, (x) => { run.basePreview = x; });
        return { ...p, log: this.scrub(run, p.log) };
      }
      case "preview.base.stop": {
        const { run } = this.need(runId);
        this.executor.stopBasePreview(run);
        return null;
      }
      case "shots.previews": {
        const { run } = this.need(runId, agentId);
        return this.visual.previews(run, agentId!);
      }
      case "shots.capture":
        return this.capture(params as unknown as ShotsCaptureParams);
      default:
        throw new Error(`모르는 요청이에요: ${method}`);
    }
  }

  /**
   * One planning step for a request this runner's owner claimed, on the local clone with this PC's login. The proposal
   * pass reads the repo in a throwaway detached worktree, read-only, exactly as `willnew serve` does.
   */
  private async plan<S extends PlanStep>(step: S, input: PlanInput): Promise<PlanResults[S]> {
    const planner = (this.planner ??= this.opts.planner ?? createPlanner());
    const text = String(input.text ?? "");
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    const questions = Array.isArray(input.questions) ? input.questions : [];
    let out: unknown;
    switch (step) {
      case "brief":
        out = await planner.brief(text, attachments, this.root);
        break;
      case "spec":
        out = await planner.spec(text, attachments, questions, this.root);
        break;
      case "proposal": {
        if (!input.spec) throw new Error("명세가 없어요");
        const agent = this.opts.proposer !== undefined ? this.opts.proposer : defaultProposalAgent();
        const proposal = await propose({ id: String(input.requestId), text, spec: input.spec }, this.root, agent, this.home);
        const needsCheck = await flagUnverified(input.spec, { text, questions }, proposal, this.root).catch(() => []);
        if (proposal.note) proposal.note = this.scrubLocal(proposal.note);
        out = { proposal, needsCheck };
        break;
      }
      case "decline":
        out = await planner.decline({ text, spec: input.spec, requester: String(input.requester ?? ""), repo: this.root }, String(input.reason ?? ""), String(input.developer ?? ""));
        break;
      default:
        throw new Error(`모르는 계획 단계예요: ${step}`);
    }
    return out as PlanResults[S];
  }

  /** Local paths out of a message that is not about one run. */
  private scrubLocal(s: string): string {
    let out = s;
    for (const p of variants(this.root)) out = out.split(p).join(`(${basename(this.root)})`);
    for (const p of variants(this.home)) out = out.split(p).join("(runner home)");
    return out;
  }

  /** Capture the pairs here, upload every PNG (artifact.put), then answer with the same result the web expects. */
  private async capture(p: ShotsCaptureParams) {
    const { run } = this.need(p.runId, p.agentId);
    const r = await this.visual.capture({ requestId: p.requestId, round: Number(p.round), screens: p.screens ?? [], mobile: !!p.mobile, before: p.before, after: p.after });
    const dir = join(this.home, "shots", safe(p.requestId), String(p.round));
    for (const pair of r.shots)
      for (const side of ["before", "after"] as const) {
        const url = pair[side];
        if (!url) continue;
        const file = decodeURIComponent(url.split("/").pop() ?? "");
        const path = join(dir, file);
        try {
          if (statSync(path).size > MAX_ARTIFACT_BYTES) throw new Error("5MB 를 넘어요");
          this.send({ t: "artifact.put", runId: run.id, agentId: p.agentId, name: `shots/${p.round}/${file}`, mime: "image/png", base64: readFileSync(path).toString("base64") });
        } catch (e) {
          pair[side] = undefined;
          pair.error = `${side === "before" ? "전" : "후"} 화면을 올리지 못했어요: ${(e as Error).message.slice(0, 80)}`;
        }
      }
    return r;
  }
}

/** A path as it may appear in output: as is, with forward slashes, with backslashes. */
function variants(p: string): string[] {
  if (!p) return [];
  return [...new Set([p, p.replace(/\\/g, "/"), p.replace(/\//g, "\\")])].sort((a, b) => b.length - a.length);
}

