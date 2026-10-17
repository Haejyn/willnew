/**
 * Proposal pass: after the spec is ready, an agent reads the repository in a fresh, detached worktree with read-only
 * tools and answers "이렇게 개발할까요?" as strict JSON. Nothing it does can change the code: Claude Code runs in plan
 * permission mode with only Read, Grep and Glob available, and the worktree is thrown away afterwards.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS, installed } from "./adapters.js";
import { askJson, checkProposal, fallbackProposal, type LlmCall } from "./brief.js";
import { git } from "./git.js";
import { proposalPrompt } from "./prompts.js";
import { runClaude } from "./triage.js";
import type { Proposal, Request } from "./types.js";

/** Runs one read-only agent pass with `cwd` = the fresh worktree. Tests pass a fake. */
export type ProposalAgent = (prompt: string, cwd: string) => Promise<{ text: string; costUsd: number | null }>;

const PROPOSAL_TIMEOUT_MS = 6 * 60_000;

/** Claude Code, read-only: plan mode, tools limited to Read/Grep/Glob. null when Claude Code is not installed. */
export function defaultProposalAgent(): ProposalAgent | null {
  if (process.env.WILLNEW_TRIAGE === "rules" || !installed(ADAPTERS["claude-code"])) return null;
  return async (prompt, cwd) => {
    const out = await runClaude(prompt, cwd, {
      model: process.env.WILLNEW_PROPOSAL_MODEL ?? "sonnet",
      args: ["--permission-mode", "plan", "--tools", "Read,Grep,Glob", "--max-turns", "30"],
      timeoutMs: PROPOSAL_TIMEOUT_MS,
    });
    const env = JSON.parse(out) as { result?: string; total_cost_usd?: number };
    return { text: env.result ?? "", costUsd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : null };
  };
}

/**
 * Make the proposal for `req` (which must have a spec). Validation and the one retry are the same as the planner's;
 * on a second failure, or when no agent can run, a minimal proposal marked `by: "fallback"` comes back with a note.
 */
export async function propose(req: Pick<Request, "id" | "text" | "spec">, repo: string, agent: ProposalAgent | null, home: string): Promise<Proposal> {
  if (!agent) return fallbackProposal(req.spec, "제안 에이전트를 쓸 수 없는 환경이에요 (Claude Code 없음 또는 규칙 모드)");
  const t0 = Date.now();
  const root = (await git(repo, "rev-parse", "--show-toplevel")).trim();
  const wt = join(home, "worktrees", "proposals", `${req.id}-${Date.now().toString(36)}`);
  mkdirSync(join(wt, ".."), { recursive: true });
  await git(root, "worktree", "add", "--detach", wt, "HEAD");
  try {
    const call: LlmCall = (prompt) => agent(prompt, wt);
    const r = await askJson(call, proposalPrompt(req), checkProposal);
    if (!r.value) return { ...fallbackProposal(req.spec, `제안 에이전트 답이 두 번 다 형식에 맞지 않아 최소 제안으로 대신했어요 (${(r.error ?? "").slice(0, 120)})`), costUsd: r.costUsd, durationMs: Date.now() - t0 };
    return { ...r.value, by: "agent", costUsd: r.costUsd, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ...fallbackProposal(req.spec, `제안 에이전트 실행 실패: ${(e as Error).message.slice(0, 160)}`), durationMs: Date.now() - t0 };
  } finally {
    await git(root, "worktree", "remove", "--force", wt).catch(() => undefined);
  }
}
