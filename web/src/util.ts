import { useEffect, useState } from "react";
import type { AgentRun, Run } from "./api";

export const ADAPTER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  script: "Script",
};
export const adapterName = (id: string) => ADAPTER_NAMES[id] ?? id;

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}초`;
  if (s < 60) return `${Math.round(s)}초`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  if (m < 60) return m >= 10 || rs === 0 ? `${m}분` : `${m}분 ${rs}초`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

/** Stopwatch style — 01:24 */
export function fmtClock(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms) || ms < 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts) / 1000;
  if (d < 45) return "방금";
  if (d < 3600) return `${Math.round(d / 60)}분 전`;
  if (d < 86400) return `${Math.round(d / 3600)}시간 전`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)}일 전`;
  return new Date(ts).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

export const isActive = (a: AgentRun) =>
  a.status === "queued" || a.status === "running" || a.status === "checking" || a.status === "retrying";

export const STATUS_KO: Record<string, string> = {
  queued: "대기",
  running: "작업 중",
  checking: "검증 중",
  retrying: "자가 수정",
  done: "완료",
  failed: "실패",
  cancelled: "취소",
};

export type RunState = "active" | "pending" | "approved" | "rejected" | "failed";
/** One word for where a request stands, from the requester's point of view. */
export function runState(run: Run): RunState {
  if (run.agents.some(isActive) || (!run.agents.length && !run.triage)) return "active";
  if (run.review?.status === "approved") return "approved";
  if (run.review?.status === "rejected") return "rejected";
  if (run.agents.some((a) => a.status === "done" && a.check?.status !== "failed")) return "pending";
  return "failed";
}
export const RUN_STATE_KO: Record<RunState, string> = {
  active: "진행 중",
  pending: "검토 대기",
  approved: "승인",
  rejected: "반려",
  failed: "실패",
};

export const TEMPLATE_KO: Record<string, string> = {
  bugfix: "버그 수정",
  tests: "테스트 작성",
  feature: "기능 구현",
  refactor: "리팩터링",
  docs: "문서화",
};
export const TEAM_KO: Record<string, string> = { platform: "플랫폼", data: "데이터", "content-ops": "콘텐츠 운영" };

export interface User {
  name: string;
  team: string;
}
const USER_KEY = "willnew.user";
export function loadUser(): User {
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) ?? "null");
    if (u?.name && u?.team) return u;
  } catch {
    /* storage blocked */
  }
  return { name: "이해준", team: "platform" };
}
export function saveUser(u: User) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  } catch {
    /* storage blocked */
  }
}

export function agentElapsed(a: AgentRun, now: number): number | null {
  if (a.durationMs != null && !isActive(a)) return a.durationMs;
  if (!a.startedAt) return null;
  return (a.endedAt ?? now) - a.startedAt;
}

export function runElapsed(run: Run, now: number): number {
  const live = run.agents.some(isActive);
  if (live) return now - run.createdAt;
  const ends = run.agents.map((a) => a.endedAt ?? (a.startedAt && a.durationMs ? a.startedAt + a.durationMs : 0));
  const end = Math.max(run.createdAt, ...ends);
  return end - run.createdAt;
}

/** Same convention as the server's metrics: input + output + cached. */
export const totalTokens = (a: AgentRun) => (a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0) + (a.usage?.cachedTokens ?? 0);
export const tokenBreakdown = (a: AgentRun) =>
  `in ${fmtTokens(a.usage?.inputTokens)} · out ${fmtTokens(a.usage?.outputTokens)} · cached ${fmtTokens(a.usage?.cachedTokens)}`;

/** Replace the agent's absolute worktree path with "." so logs stay readable. */
export function shortenPaths(text: string, worktree?: string): string {
  if (!worktree) return text;
  const plain = worktree;
  const slashed = worktree.replace(/\\/g, "/");
  const escaped = worktree.replace(/\\/g, "\\\\"); // as it appears inside JSON-encoded tool input
  let out = text;
  for (const [v, sep] of [
    [escaped, "\\\\"],
    [plain, "\\"],
    [slashed, "/"],
  ] as const) {
    out = out.split(v + sep).join("./").split(v).join(".");
  }
  return out;
}

/**
 * Suggested winner: among finished agents whose check passed, the fastest; cost breaks near-ties
 * (within 10% of the fastest time, the cheaper one wins).
 */
export function suggestWinner(run: Run): string | null {
  const ok = run.agents.filter((a) => a.status === "done" && a.check?.status === "passed");
  if (!ok.length) return null;
  const dur = (a: AgentRun) => a.durationMs ?? Number.MAX_SAFE_INTEGER;
  const fastest = Math.min(...ok.map(dur));
  const near = ok.filter((a) => dur(a) <= fastest * 1.1);
  near.sort((a, b) => {
    const ca = a.usage?.costUsd ?? Number.MAX_VALUE;
    const cb = b.usage?.costUsd ?? Number.MAX_VALUE;
    return ca - cb || dur(a) - dur(b);
  });
  return near[0]?.id ?? null;
}

export function runCounts(run: Run) {
  const c = { total: run.agents.length, active: 0, done: 0, passed: 0, failed: 0 };
  for (const a of run.agents) {
    if (isActive(a)) c.active++;
    if (a.status === "done") c.done++;
    if (a.check?.status === "passed") c.passed++;
    if (a.status === "failed" || a.check?.status === "failed") c.failed++;
  }
  return c;
}

/** Re-renders every `ms` while `enabled`, returning the current time. */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

export interface FileDiff {
  path: string;
  add: number;
  del: number;
  lines: string[];
}

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m ? m[2] : line.slice(11), add: 0, del: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) {
      if (!line.trim()) continue;
      cur = { path: "(patch)", add: 0, del: 0, lines: [] };
      files.push(cur);
    }
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to))/.test(line)) continue;
    if (line.startsWith("+")) cur.add++;
    else if (line.startsWith("-")) cur.del++;
    cur.lines.push(line);
  }
  return files;
}
