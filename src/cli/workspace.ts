/**
 * What `willnew work` changes in the developer's own checkout: the branch, `.willnew/`, `.git/info/exclude`,
 * the Claude Code permission frame and the commit trailer hook. Nothing here widens a permission.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

/** The repository's top folder, or null when `cwd` is not in a git repository. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    return null;
  }
}

/** Changed or untracked paths (`git status --porcelain`). Ignored and excluded files do not count. */
export async function dirtyPaths(root: string): Promise<string[]> {
  // not git(): trimming would eat the leading space of " M file"
  const { stdout } = await run("git", ["status", "--porcelain"], { cwd: root, windowsHide: true });
  return stdout.split("\n").filter((l) => l.trim()).map((l) => l.slice(3));
}

export async function currentBranch(root: string): Promise<string> {
  return git(root, "rev-parse", "--abbrev-ref", "HEAD");
}

/** Switch to `branch`: the local one, else a remote `origin/<branch>`, else a new one from HEAD. */
export async function switchBranch(root: string, branch: string): Promise<"switched" | "tracked" | "created" | "already"> {
  if ((await currentBranch(root)) === branch) return "already";
  const has = async (ref: string) => {
    try {
      await git(root, "rev-parse", "--verify", "--quiet", ref);
      return true;
    } catch {
      return false;
    }
  };
  if (await has(`refs/heads/${branch}`)) {
    await git(root, "switch", branch);
    return "switched";
  }
  if (await has(`refs/remotes/origin/${branch}`)) {
    await git(root, "switch", "-c", branch, "--track", `origin/${branch}`);
    return "tracked";
  }
  await git(root, "switch", "-c", branch);
  return "created";
}

/** A path inside the git dir (follows worktrees and core.hooksPath). */
async function gitPath(root: string, p: string): Promise<string> {
  const out = await git(root, "rev-parse", "--git-path", p);
  return isAbsolute(out) ? out : join(root, out);
}

/** Adds the lines that are not there yet. Returns the added ones. */
export async function addExcludes(root: string, lines: string[]): Promise<string[]> {
  const file = await gitPath(root, "info/exclude");
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(before.split(/\r?\n/).map((l) => l.trim()));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return [];
  mkdirSync(dirname(file), { recursive: true });
  const head = before && !before.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${before}${head}# willnew\n${add.join("\n")}\n`);
  return add;
}

// ── Claude Code permission frame ──
// Format checked against https://code.claude.com/docs/en/permissions and https://code.claude.com/docs/en/settings
// (2026-10-31): `permissions.deny` holds `Tool(specifier)` rules; `Bash(curl *)` matches `curl` and `curl ...`;
// Read rules use gitignore patterns (a bare name matches at any depth, `~/` is the home folder);
// `permissions.disableBypassPermissionsMode: "disable"` turns bypassPermissions mode off.

export const DENY_RULES = ["Bash(curl *)", "Bash(wget *)", "Read(.env)", "Read(.env.*)", "Read(~/.ssh/**)", "Read(*.pem)"];

export interface SettingsPlan {
  file: string;
  /** null: the file is there but not JSON we can merge into */
  current: Record<string, unknown> | null;
  addDeny: string[];
  setBypassOff: boolean;
  next: Record<string, unknown>;
}

export function planSettings(root: string): SettingsPlan {
  const file = join(root, ".claude", "settings.local.json");
  let current: Record<string, unknown> | null = {};
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      current = v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      current = null;
    }
  }
  if (!current) return { file, current, addDeny: [], setBypassOff: false, next: {} };
  const perms = current.permissions && typeof current.permissions === "object" && !Array.isArray(current.permissions) ? (current.permissions as Record<string, unknown>) : {};
  const deny = Array.isArray(perms.deny) ? (perms.deny as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const addDeny = DENY_RULES.filter((r) => !deny.includes(r));
  const setBypassOff = perms.disableBypassPermissionsMode !== "disable";
  const nextPerms: Record<string, unknown> = { ...perms, deny: [...(Array.isArray(perms.deny) ? perms.deny : []), ...addDeny] };
  if (setBypassOff) nextPerms.disableBypassPermissionsMode = "disable";
  return { file, current, addDeny, setBypassOff, next: { ...current, permissions: nextPerms } };
}

export function describeSettings(p: SettingsPlan): string[] {
  return [
    ...p.addDeny.map((r) => `  + permissions.deny  ${r}`),
    ...(p.setBypassOff ? [`  + permissions.disableBypassPermissionsMode  "disable"`] : []),
  ];
}

export function writeSettings(p: SettingsPlan) {
  mkdirSync(dirname(p.file), { recursive: true });
  writeFileSync(p.file, JSON.stringify(p.next, null, 2) + "\n");
}

// ── commit trailer hook ──

/** LF only and plain sh, so Git for Windows (Git Bash) runs it as well. */
export const HOOK_SCRIPT = [
  "#!/bin/sh",
  "# willnew: 브랜치가 t-<번호>-... 이면 커밋 꼬리말 Ticket: T-<번호> 를 단다. 이미 Ticket: 꼬리말이 있으면 그대로 둔다",
  'case "$2" in merge|squash) exit 0 ;; esac',
  "branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0",
  "n=$(printf '%s\\n' \"$branch\" | sed -n 's/^t-\\([0-9][0-9]*\\)-.*/\\1/p')",
  '[ -n "$n" ] || exit 0',
  'git interpret-trailers --in-place --if-exists doNothing --trailer "Ticket: T-$n" "$1"',
  "",
].join("\n");

/** Installs prepare-commit-msg when there is none. Returns the path and whether it was written. */
export async function installHook(root: string): Promise<{ path: string; installed: boolean }> {
  const path = await gitPath(root, "hooks/prepare-commit-msg");
  if (existsSync(path)) return { path, installed: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, HOOK_SCRIPT, { mode: 0o755 });
  try {
    chmodSync(path, 0o755);
  } catch {
    /* Windows */
  }
  return { path, installed: true };
}
