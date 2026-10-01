import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffSummary, FileStat } from "./types.js";

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export async function repoInfo(repo: string) {
  const root = (await git(repo, "rev-parse", "--show-toplevel")).trim();
  const baseRef = (await git(root, "rev-parse", "HEAD")).trim();
  const baseBranch = (await git(root, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  return { root, baseRef, baseBranch };
}

export async function addWorktree(root: string, path: string, branch: string, baseRef: string) {
  await git(root, "worktree", "add", "-b", branch, path, baseRef);
}

export async function removeWorktree(root: string, path: string, branch: string) {
  await git(root, "worktree", "remove", "--force", path).catch(() => undefined);
  await git(root, "branch", "-D", branch).catch(() => undefined);
}

/** Commit whatever the agent left in its worktree so the result is a mergeable branch. */
export async function commitAll(wt: string, message: string): Promise<boolean> {
  await git(wt, "add", "-A");
  const status = await git(wt, "status", "--porcelain");
  if (!status.trim()) return false;
  await git(wt, "-c", "user.name=willnew", "-c", "user.email=willnew@localhost", "commit", "-q", "-m", message);
  return true;
}

const MAX_PATCH = 200_000;

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$/;
export const isTestFile = (path: string) => TEST_FILE.test(path);

export async function diffSummary(wt: string, baseRef: string): Promise<DiffSummary> {
  const numstat = await git(wt, "diff", "--numstat", baseRef, "HEAD");
  let files = 0, insertions = 0, deletions = 0;
  const fileStats: FileStat[] = [];
  for (const line of numstat.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    if (a === undefined || d === undefined || !rest.length) continue;
    files += 1;
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
    fileStats.push({ path: rest.join("\t"), insertions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  let patch = await git(wt, "diff", baseRef, "HEAD");
  if (patch.length > MAX_PATCH) patch = patch.slice(0, MAX_PATCH) + "\n… (patch truncated)";
  return { files, insertions, deletions, patch, fileStats, testsTouched: fileStats.map((f) => f.path).filter(isTestFile) };
}

/** Would merging `branch` into the current HEAD of `root` conflict? null when git cannot tell (needs git ≥ 2.38). */
export async function mergeConflicts(root: string, branch: string): Promise<boolean | null> {
  try {
    await run("git", ["-C", root, "merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", branch], { windowsHide: true });
    return false;
  } catch (e) {
    const code = (e as { code?: number }).code;
    return code === 1 ? true : null;
  }
}

export async function mergeBranch(root: string, branch: string, label: string): Promise<string> {
  const dirty = (await git(root, "status", "--porcelain", "--untracked-files=no")).trim();
  if (dirty) throw new Error("the base repository has uncommitted changes — commit or stash them first");
  return git(root, "-c", "user.name=willnew", "-c", "user.email=willnew@localhost",
    "merge", "--no-ff", "-m", `willnew: merge ${label}`, branch);
}
