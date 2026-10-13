/** 달 — 일 하나 = 달 하나. 계획 전 삭에서 시작해 차오르다가, 보름달이 뜨면 사람 차례. */
import type { CSSProperties, ReactNode } from "react";
import type { Run } from "./api";
import { TEMPLATE_KO, fmtDuration, isActive, runElapsed } from "./util";

export type Phase = "new" | "plan" | "run" | "retry" | "check" | "turn" | "merged" | "rejected" | "empty";

/** 달의 밝은 부분(0~1). 반려는 같은 폭을 왼쪽에 둔다. */
const LIT: Record<Phase, number> = { new: 0, plan: 0.2, run: 0.5, retry: 0.5, check: 0.8, turn: 1, merged: 1, rejected: 0.2, empty: 0 };
const NAME: Record<Phase, string> = { new: "읽는 중", plan: "계획", run: "실행 중", retry: "다시 시도", check: "검증 중", turn: "내 차례", merged: "병합", rejected: "반려", empty: "결과 없음" };
/** 얼마나 찼는지 — 비어 있는 화면에서 "지금 가장 많이 찬 일"을 고른다 */
export const PHASE_FILL: Record<Phase, number> = { new: 0, plan: 1, run: 2, retry: 2, check: 3, turn: 4, merged: -1, rejected: -1, empty: -1 };
export const isOpen = (p: Phase) => PHASE_FILL[p] >= 0 && p !== "turn";
export const isDone = (p: Phase) => p === "merged" || p === "rejected" || p === "empty";

/** 판정은 예전 진행 레일과 같다: 계획 전 → 계획 → 실행/자기 수정 → 검증 → 사람 차례 → 병합·반려·결과 없음 */
export function runPhase(run: Run, now = Date.now()): { phase: Phase; label: string; detail: string } {
  const a = run.agents;
  const planned = !!run.triage || a.length > 0;
  const live = a.filter(isActive);
  const working = a.some((x) => x.status === "running" || x.status === "retrying");
  const checking = a.some((x) => x.status === "checking");
  const finished = a.length > 0 && !live.length;
  const retry = live.find((x) => x.attempt > 1 && (x.status === "running" || x.status === "retrying"));
  const passed = a.filter((x) => x.check.status === "passed").length;
  let phase: Phase;
  let detail: string;
  if (finished) {
    const s = run.review.status;
    phase = s === "approved" ? "merged" : s === "rejected" ? "rejected" : s === "pending" ? "turn" : "empty";
    detail = phase === "turn" ? `${passed}/${a.length} 통과` : phase === "empty" ? "반영할 결과 없음" : (run.review.reviewer ?? "");
  } else if (!planned) {
    phase = "new";
    detail = `${run.requester} 의 요청을 읽는 중`;
  } else if (retry) {
    phase = "retry";
    detail = `${retry.label} ${retry.attempt}차 시도`;
  } else if (working) {
    phase = "run";
    detail = `에이전트 ${live.length} · ${fmtDuration(runElapsed(run, now))}`;
  } else if (checking) {
    phase = "check";
    detail = run.checkCmd || "검증";
  } else {
    phase = "plan";
    detail = a.length ? "에이전트를 기다리는 중" : "에이전트를 준비하는 중";
  }
  // 승인 뒤 PR · CI · 배포가 도는 중이거나 멈춘 경우
  const st = run.ship?.stage;
  if (phase === "merged" && st) {
    if (st === "pr" || st === "ci") return { phase: "check", label: "CI 확인 중", detail: run.ship?.prNumber ? `PR #${run.ship.prNumber}` : "PR 을 올리는 중" };
    if (st === "ci_failed") return { phase: "rejected", label: "CI 실패", detail: "자동으로 다시 돌리지 않아요" };
    if (st === "deploy_failed") return { phase: "rejected", label: "배포 확인 실패", detail: run.ship?.env ?? "" };
    if (st === "deploying") return { phase, label: "배포 중", detail: run.ship?.env ?? "" };
    if (st === "deployed") return { phase, label: "배포됨", detail: run.ship?.env ?? "" };
  }
  return { phase, label: NAME[phase], detail };
}

/** 오른쪽이 밝은 달. 호(원의 오른쪽 반) + 터미네이터(타원 호). 모든 단계가 같은 모양의 path 라 전환이 부드럽다. */
function lit(f: number) {
  const rx = Math.abs(1 - 2 * f) * 10;
  return `M12 2A10 10 0 0 1 12 22A${rx} 10 0 0 ${f > 0.5 ? 1 : 0} 12 2Z`;
}

export function Moon({ phase, size = 16, label }: { phase: Phase; size?: number; label?: string }) {
  return (
    <svg className={`moon m-${phase}`} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label ?? NAME[phase]}>
      <circle className="moon-ring" cx="12" cy="12" r="10" fill="none" strokeWidth="1.5" />
      <path className="moon-lit" d={lit(LIT[phase])} style={{ d: `path("${lit(LIT[phase])}")` } as CSSProperties} transform={phase === "rejected" ? "translate(24 0) scale(-1 1)" : undefined} />
      {phase === "retry" ? <circle className="moon-dot" cx="20" cy="4" r="3" /> : null}
    </svg>
  );
}

/** 작업 화면과 검토 화면이 같이 쓰는 머리 — 큰 달 + 단계 + 제목 + 메타 한 줄. */
export function RunHead({ run, now, lead, tools }: { run: Run; now: number; lead?: ReactNode; tools?: ReactNode }) {
  const { phase, label, detail } = runPhase(run, now);
  return (
    <header className="ws-head">
      {lead}
      <Moon phase={phase} size={40} />
      <div className="ws-title">
        <div className="ws-phase">
          <b>{label}</b>
          {detail ? <span> · {detail}</span> : null}
        </div>
        <h1>{run.triage?.title ?? run.title}</h1>
        <div className="ws-meta">
          {run.channel ? <a href={`#/chat/${run.channel}`}>#{run.channel}</a> : null}
          <span>{run.requester}</span>
          <span>{TEMPLATE_KO[run.template] ?? run.template}</span>
          <span className="mono">
            {run.baseBranch} @{run.baseRef.slice(0, 7)}
          </span>
        </div>
      </div>
      {tools ? <div className="ws-tools">{tools}</div> : null}
    </header>
  );
}
