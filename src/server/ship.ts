/**
 * After approval in `--ship pr` mode: push the agent branch, open a PR with `gh`, wait for CI, squash-merge when every
 * check passes, then (optionally) poll a deploy command until it exits 0. A failing CI stops here and is never retried.
 * Commands go through an injected runner so tests use a fake gh and a fake deploy command.
 */
import { execFile } from "node:child_process";
import type { AgentRun, Run, Ship } from "./types.js";

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** file + args, no shell, except `shell: true` for the user's deploy command. */
export type Runner = (file: string, args: string[], opts: { cwd: string; shell?: boolean }) => Promise<CmdResult>;

export const nodeRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, shell: opts.shell, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface ShipOptions {
  mode: "merge" | "pr";
  /** command that exits 0 once the merge commit is live; `{sha}` is replaced by the merge commit */
  deployCheck?: string;
  deployEnv?: string;
  runner?: Runner;
  sleep?: (ms: number) => Promise<void>;
  ciPollMs?: number;
  ciTimeoutMs?: number;
  deployPollMs?: number;
  deployTimeoutMs?: number;
  /**
   * Team mode (hub): `owner/name`. gh gets `--repo owner/name` and runs in `cwd` (default the process cwd) instead of
   * in run.repo, because the hub has no clone. The push itself comes from the runner (the `push` hook of run()).
   */
  ghRepo?: string;
  cwd?: string;
}

export type ShipEvent = "pr" | "ci_passed" | "ci_failed" | "merged" | "deployed" | "deploy_failed";

type Check = NonNullable<Ship["checks"]>[number];

/** `gh pr checks --json name,state,bucket` rows → pending / pass / fail. */
export function parseChecks(json: string): Check[] | null {
  try {
    const rows = JSON.parse(json) as { name: string; state?: string; bucket?: string }[];
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => {
      const b = (r.bucket ?? "").toLowerCase();
      return { name: r.name, state: b === "pass" || b === "skipping" ? "pass" : b === "fail" || b === "cancel" ? "fail" : "pending" };
    });
  } catch {
    return null;
  }
}

export function prBody(run: Run, agent: AgentRun, reviewer: string): string {
  const note = agent.userNote || agent.summary || run.title;
  const check = agent.check.status === "passed" ? `검증 통과 (\`${run.checkCmd}\`)` : agent.check.status === "failed" ? `검증 실패 (\`${run.checkCmd}\`)` : "검증 없음";
  return `${note}\n\n${check}\n\n요청: ${run.requester}\n승인: ${reviewer}`;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Shipper {
  constructor(readonly opts: ShipOptions) {}

  get mode() {
    return this.opts.mode;
  }
  get tracksDeploy() {
    return this.opts.mode === "pr" && !!this.opts.deployCheck;
  }

  /**
   * Runs the pipeline for one approved run. `set` publishes the new ship state, `event` tells the chat what just happened,
   * `merged` is called once the PR is merged so the agent can be marked as merged. `push`, when given, replaces the
   * local `git push origin <branch>` (team mode: the runner pushes).
   */
  async run(run: Run, agent: AgentRun, reviewer: string, hooks: { set: (s: Ship) => void; event: (e: ShipEvent) => void; merged: () => void; push?: () => Promise<unknown> }): Promise<void> {
    const o = this.opts;
    const base = o.runner ?? nodeRunner;
    const cwd = o.ghRepo ? (o.cwd ?? process.cwd()) : run.repo;
    const repoArgs = o.ghRepo ? ["--repo", o.ghRepo] : [];
    const exec: Runner = (file, args, opts) => base(file, file === "gh" ? [...args, ...repoArgs] : args, { ...opts, cwd });
    const sleep = o.sleep ?? defaultSleep;
    const env = this.tracksDeploy ? (o.deployEnv ?? "production") : undefined;
    let ship: Ship = { mode: "pr", stage: "pr", env, at: Date.now() };
    const set = (patch: Partial<Ship>) => {
      ship = { ...ship, ...patch, at: Date.now() };
      hooks.set(ship);
    };
    const fail = (name: string, detail: string) => {
      set({ stage: "ci_failed", checks: [{ name, state: "fail" }] });
      hooks.event("ci_failed");
      void detail;
    };
    set({});

    if (hooks.push) {
      try {
        await hooks.push();
      } catch (e) {
        return fail("git push", (e as Error).message);
      }
    } else {
      const push = await exec("git", ["push", "origin", agent.branch], { cwd: run.repo });
      if (push.code !== 0) return fail("git push", push.stderr);
    }
    const create = await exec("gh", ["pr", "create", "--base", run.baseBranch, "--head", agent.branch, "--title", run.title, "--body", prBody(run, agent, reviewer)], { cwd: run.repo });
    const url = /https?:\/\/\S+\/pull\/(\d+)/.exec(create.stdout);
    if (create.code !== 0 || !url) return fail("gh pr create", create.stderr);
    const prNumber = Number(url[1]);
    set({ stage: "ci", prNumber, prUrl: url[0] });
    hooks.event("pr");

    // CI: poll until nothing is pending
    let waited = 0; // counted from the sleeps, so tests with a fake sleep need no fake clock
    let checks: Check[] = [];
    let errors = 0;
    for (;;) {
      const res = await exec("gh", ["pr", "checks", String(prNumber), "--json", "name,state,bucket"], { cwd: run.repo });
      const rows = parseChecks(res.stdout);
      if (rows) {
        errors = 0;
        checks = rows;
        set({ checks });
        if (!rows.some((c) => c.state === "pending")) break;
      } else if (/no checks/i.test(res.stderr + res.stdout)) {
        checks = [];
        break;
      } else if (++errors >= 3) {
        return fail("gh pr checks", res.stderr);
      }
      if (waited >= (o.ciTimeoutMs ?? 30 * 60_000)) {
        set({ stage: "ci_failed", checks: checks.map((c) => (c.state === "pending" ? { ...c, state: "fail" as const } : c)) });
        return hooks.event("ci_failed");
      }
      await sleep(o.ciPollMs ?? 10_000);
      waited += o.ciPollMs ?? 10_000;
    }
    if (checks.some((c) => c.state === "fail")) {
      set({ stage: "ci_failed", checks });
      return hooks.event("ci_failed");
    }
    hooks.event("ci_passed");

    const merge = await exec("gh", ["pr", "merge", String(prNumber), "--squash", "--delete-branch"], { cwd: run.repo });
    if (merge.code !== 0) return fail("gh pr merge", merge.stderr);
    set({ stage: "merged" });
    hooks.merged();
    hooks.event("merged");
    if (!o.deployCheck) return;

    // deploy tracking: the merge commit is what must be live
    const view = await exec("gh", ["pr", "view", String(prNumber), "--json", "mergeCommit", "--jq", ".mergeCommit.oid"], { cwd: run.repo });
    const sha = view.stdout.trim();
    const cmd = o.deployCheck.replaceAll("{sha}", sha);
    set({ stage: "deploying" });
    waited = 0;
    for (;;) {
      const res = await exec(cmd, [], { cwd: run.repo, shell: true });
      if (res.code === 0) {
        set({ stage: "deployed" });
        return hooks.event("deployed");
      }
      const every = o.deployPollMs ?? 15_000;
      if (waited + every > (o.deployTimeoutMs ?? 30 * 60_000)) break;
      await sleep(every);
      waited += every;
    }
    set({ stage: "deploy_failed" });
    hooks.event("deploy_failed");
  }
}
