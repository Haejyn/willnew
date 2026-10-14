/** 결정 — 승인 / 고쳐 달라 / 반려. 작업 화면 맨 아래 결정 바와 내 차례 카드가 같은 호출을 쓴다(검토 화면에서도 재사용). */
import { useEffect, useState, type ReactNode } from "react";
import type { Api, Preflight, Run } from "./api";
import { IconBell, IconCheck } from "./icons";
import { Moon, runPhase } from "./moon";
import { ShipRow } from "./Ship";
import { Modal, SlideToApprove, Spinner, useToast } from "./ui";
import { isActive, relTime, suggestWinner, winnerReason, type User } from "./util";

/** 승인·반려 호출. 승인은 확인 없이 바로 병합한다. */
export function useDecide(api: Api, run: Run, user: User) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const call = async (input: Parameters<Api["review"]>[1], ok: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      await api.review(run.id, input);
      toast(ok, "ok");
      return true;
    } catch (e) {
      toast((e as Error).message, "err");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    approve: (agentId?: string) => call({ decision: "approve", agentId: agentId ?? suggestWinner(run) ?? undefined, reviewer: user.name }, "병합했어요"),
    reject: (reason: string, ok = "반려했어요 · 사유가 채널에 남아요") => call({ decision: "reject", reviewer: user.name, comment: reason.trim() }, ok),
  };
}

export function RejectModal({ title = "반려할까요?", confirm = "반려", initial = "", busy, onSubmit, onClose }: { title?: string; confirm?: string; initial?: string; busy?: boolean; onSubmit: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState(initial);
  return (
    <Modal title={title} confirmLabel={confirm} danger busy={busy} disabled={!reason.trim()} onClose={onClose} onConfirm={() => onSubmit(reason)}>
      <label className="field">
        <span>사유 · 요청자와 채널에 그대로 남아요</span>
        <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 증상만 가렸어요. 서버 타임존 설정이 원인이에요." />
      </label>
    </Modal>
  );
}

/** 도는 에이전트를 모두 멈춘다 */
export function StopModal({ api, run, onClose }: { api: Api; run: Run; onClose: () => void }) {
  const live = run.agents.filter(isActive);
  return (
    <Modal title="모두 멈출까요?" confirmLabel={`${live.length}개 멈추기`} danger onClose={onClose} onConfirm={async () => {
      onClose();
      for (const a of live) await api.cancel(run.id, a.id).catch(() => undefined);
    }}>
      지금 작업 중인 에이전트를 멈춰요. 워크트리와 지금까지의 변경은 남아요.
    </Modal>
  );
}

function Gate({ ok, loading, children }: { ok: boolean | null; loading?: boolean; children: string }) {
  return (
    <span className={`gchip ${loading ? "" : ok === true ? "ok" : "warn"}`}>
      {loading ? null : ok === true ? <IconCheck size={13} /> : <b aria-hidden>!</b>}
      {children}
    </span>
  );
}

export interface DecisionProps {
  api: Api;
  run: Run;
  user: User;
  go: (p: string) => void;
  now: number;
  watched: boolean;
  onWatch: () => void;
  /** 고쳐 달라 / 다시 맡기기 — 보통 지시 입력으로 간다 */
  onRevise?: () => void;
  /** 승인할 결과를 직접 고른 경우(검토 화면) */
  agentId?: string;
  /** 휴대폰 검토 화면 — 승인을 탭 대신 밀어서 */
  slide?: boolean;
  /** 검토 화면 단축키 — ⌘↵ 승인 · R 반려 */
  keys?: boolean;
}

export function DecisionBar({ api, run, user, go, now, watched, onWatch, onRevise, agentId, slide, keys }: DecisionProps) {
  const { phase, label, detail } = runPhase(run, now);
  const { busy, approve, reject } = useDecide(api, run, user);
  const [modal, setModal] = useState<"reject" | "close" | "stop" | null>(null);
  const live = run.agents.filter(isActive);
  const winnerId = agentId ?? suggestWinner(run);
  const winner = run.agents.find((a) => a.id === winnerId);
  const [pf, setPf] = useState<Preflight | null>(null);
  useEffect(() => {
    setPf(null);
    if (phase !== "turn" || !winnerId) return;
    api.preflight(run.id, winnerId).then(setPf).catch(() => undefined);
  }, [api, run.id, phase, winnerId, winner?.diff.patch]);

  const touched = winner?.diff.testsTouched ?? [];
  // 검토 화면(agentId 가 넘어온다)에서는 검증을 넘긴 결과면 바로 승인한다. 그 밖에서는 테스트 파일을 고쳤거나 main 과 충돌하면 검토를 거친다.
  const passed = !!winner && winner.status === "done" && winner.check.status !== "failed";
  const direct = !!winner && (agentId ? passed : !touched.length && !pf?.conflicts);
  const revise = onRevise ?? (() => go(`/runs/${run.id}/review`));
  useEffect(() => {
    if (!keys || phase !== "turn" || user.role === "requester") return;
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("textarea, input")) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && direct && winner) void approve(winner.id);
      else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey) setModal("reject");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
  let info: ReactNode;
  let act: ReactNode = null;

  if (phase === "turn" && user.role === "requester") {
    // 요청자는 읽을 수만 있다. 승인은 개발자 몫이라 버튼을 두지 않는다
    info = <span className="dbar-text">개발자 검토 대기{winner ? ` · ${winner.label} 결과를 개발자가 보고 있어요` : ""}</span>;
  } else if (phase === "turn") {
    const reason = !winner
      ? "추천할 결과를 고르지 못했어요 · 검토 화면에서 골라 주세요"
      : agentId && !passed
        ? `${winner.label} 은 검증을 넘기지 못했어요 · 다른 결과를 고르거나 고쳐 달라고 해 주세요`
        : run.agents.length === 1
          ? `${winner.label} · ${winner.attempt > 1 ? `${winner.attempt}차 시도에 통과했어요.` : winnerReason(run, winner.id)}`
          : `${winner.label} ${agentId ? "· " : "추천 · "}${winnerReason(run, winner.id)}`;
    info = (
      <>
        <span className="dbar-text" title={reason}>{reason}</span>
        {winner ? (
          <span className="gates">
            <Gate ok={!touched.length}>{touched.length ? "테스트 파일 고침" : "테스트 파일 그대로"}</Gate>
            <Gate ok={pf ? (pf.conflicts === null ? null : !pf.conflicts) : null} loading={!pf}>
              {!pf ? "충돌 확인 중" : pf.conflicts ? `${run.baseBranch}과 충돌` : pf.conflicts === null ? "충돌 여부를 알 수 없어요" : `${run.baseBranch}과 충돌 없음`}
            </Gate>
          </span>
        ) : null}
      </>
    );
    act = (
      <>
        {direct && winner ? (
          slide ? (
            <SlideToApprove label={`밀어서 ${run.baseBranch}에 병합`} onDone={() => approve(winner.id)} disabled={busy} />
          ) : (
            <button className="btn m" onClick={() => approve(winner.id)} disabled={busy}>
              {busy ? <Spinner size={12} /> : null}승인
            </button>
          )
        ) : agentId ? null : (
          <a className="btn m" href={`#/runs/${run.id}/review`}>검토하고 승인</a>
        )}
        <button className="btn" onClick={revise}>고쳐 달라</button>
        <button className="btn q" onClick={() => setModal("reject")}>반려</button>
      </>
    );
  } else if (phase === "empty") {
    const failed = run.agents.filter((a) => a.status === "failed" || a.check.status === "failed").sort((a, b) => b.attempt - a.attempt)[0];
    info = <span className="dbar-text">통과한 결과가 없어요{failed ? ` · ${failed.label} ${failed.attempt > 1 ? `${failed.attempt}차 시도도 ` : ""}실패` : ""}</span>;
    act = (
      <>
        <button className="btn" onClick={revise}>다시 맡기기</button>
        <button className="btn q" onClick={() => setModal("close")}>닫기</button>
      </>
    );
  } else if (phase === "merged" || phase === "rejected") {
    const r = run.review;
    const head = run.ship && r.status === "approved" ? `승인됨 · ${label}` : label === "병합" ? "병합됨" : "반려됨";
    info = (
      <>
        <span className="dbar-text">
          {head} · {r.reviewer} · {relTime(r.at ?? run.createdAt, now)}
          {r.comment ? <span className="dim"> · “{r.comment}”</span> : null}
        </span>
        {run.ship ? <ShipRow ship={run.ship} base={run.baseBranch} /> : null}
      </>
    );
  } else {
    info = (
      <span className="dbar-text">
        <b>{label}</b> · {detail}
      </span>
    );
    act = (
      <>
        <button className="btn sm" aria-pressed={watched} onClick={onWatch} title="검토할 차례가 되면 브라우저 알림">
          <IconBell size={14} filled={watched} />끝나면 알림
        </button>
        {live.length ? <button className="btn q sm" onClick={() => setModal("stop")}>멈추기</button> : null}
      </>
    );
  }

  return (
    <footer className="dbar" aria-label="결정">
      <Moon phase={phase} size={phase === "turn" ? 22 : 20} />
      <div className="dbar-info">{info}</div>
      <div className="dbar-act">{act}</div>
      {modal === "reject" ? <RejectModal busy={busy} onClose={() => setModal(null)} onSubmit={async (r) => (await reject(r)) && setModal(null)} /> : null}
      {modal === "close" ? (
        <RejectModal title="닫을까요?" confirm="닫기" initial="통과한 결과가 없어 닫았어요" busy={busy} onClose={() => setModal(null)} onSubmit={async (r) => (await reject(r, "닫았어요")) && setModal(null)} />
      ) : null}
      {modal === "stop" ? <StopModal api={api} run={run} onClose={() => setModal(null)} /> : null}
    </footer>
  );
}
