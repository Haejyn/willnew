import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentRun, Run } from "./api";
import { IconCheck, IconX, Star } from "./icons";
import { fmtDuration, isActive, runElapsed } from "./util";

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} aria-label="진행 중" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export type Tone = "ok" | "bad" | "now" | "dim" | undefined;
export function Tag({ tone, mono, children, title }: { tone?: Tone; mono?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`tag ${tone ? `t-${tone}` : ""} ${mono ? "mono" : ""}`} title={title}>
      {tone === "now" ? <Star size={10} /> : null}
      {children}
    </span>
  );
}

export function Avatar({ name, size = 28, bot }: { name: string; size?: number; bot?: boolean }) {
  return (
    <span className={`avatar ${bot ? "bot" : ""}`} style={{ width: size, height: size, fontSize: size >= 32 ? 12 : 11 }} aria-hidden>
      {size < 24 ? name.slice(-1) : name.slice(-2)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------- rail

/**
 * 별자리 레일 — 요청 · 계획 · 실행 · 검증 관문 · 승인. 지금 차례인 단계만 달빛 별.
 * d done · n now · h now (partly) · - todo · g merged · r rejected/no result · f failed then retrying · o done (closed run)
 */
export type Stage = "d" | "n" | "h" | "-" | "g" | "r" | "f" | "o";
export const STAGE_NAMES = ["요청", "계획", "실행", "검증 관문", "승인"];

export function runStages(run: Run, now = Date.now()): { states: Stage[]; details: string[] } {
  const a = run.agents;
  const planned = !!run.triage || a.length > 0;
  const working = a.some((x) => x.status === "queued" || x.status === "running" || x.status === "retrying");
  const checking = a.some((x) => x.status === "checking");
  const finished = a.length > 0 && !a.some(isActive);
  const retried = a.some((x) => x.attempt > 1 && isActive(x));
  const states: Stage[] = ["d", planned ? "d" : "n", "-", "-", "-"];
  if (planned) states[2] = working ? "h" : "d";
  if (planned && !working) states[3] = checking ? "n" : finished ? "d" : "-";
  if (retried && working) states[3] = "f";
  if (finished) {
    states[4] = run.review.status === "approved" ? "g" : run.review.status === "rejected" ? "r" : run.review.status === "pending" ? "n" : "r";
    if (run.review.status === "approved" || run.review.status === "rejected") for (const i of [0, 1, 2, 3]) states[i] = "o";
  }
  const passed = a.filter((x) => x.check.status === "passed").length;
  const details = [
    run.requester,
    run.triage ? `${run.triage.by === "llm" ? "계획 에이전트" : "키워드"}${run.triage.durationMs ? ` · ${fmtDuration(run.triage.durationMs)}` : ""}` : a.length ? "직접 맡김" : "읽는 중",
    a.length ? `에이전트 ${a.length} · ${fmtDuration(runElapsed(run, now))}` : "",
    run.checkCmd ? (finished || checking ? `${run.checkCmd} · ${passed}/${a.length}` : run.checkCmd) : "검증 없음",
    run.review.status === "approved"
      ? `병합 · ${run.review.reviewer ?? ""}`
      : run.review.status === "rejected"
        ? `반려 · ${run.review.reviewer ?? ""}`
        : run.review.status === "pending"
          ? "사람 차례"
          : finished
            ? "반영할 결과 없음"
            : "사람",
  ];
  return { states, details };
}

function Node({ s, big = true }: { s: Stage; big?: boolean }) {
  if (s === "n" || s === "h") return <Star size={big ? 16 : 11} className="node-star" />;
  return <span className={`node n-${s === "-" ? "todo" : s} ${big ? "" : "sm"}`} />;
}

export function Rail({ run, labels = true, now }: { run: Run; labels?: boolean; now?: number }) {
  const { states, details } = runStages(run, now);
  const reached = (s?: Stage) => !!s && s !== "-";
  return (
    <ol className={`rail ${labels ? "" : "bare"}`} aria-label="진행 단계">
      {states.map((s, i) => (
        <li key={i} className={`stage s-${s === "-" ? "todo" : s}`} aria-current={s === "n" || s === "h" ? "step" : undefined}>
          <div className="stage-line">
            <span className="stage-node">
              <Node s={s} />
            </span>
            {i < states.length - 1 ? <span className={`link ${reached(states[i + 1]) ? "on" : ""}`} /> : null}
          </div>
          {labels ? (
            <div className="stage-text">
              <span className="stage-name">{STAGE_NAMES[i]}</span>
              {details[i] ? <span className="stage-detail">{details[i]}</span> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function MiniRail({ run }: { run: Run }) {
  const { states } = runStages(run);
  return (
    <span className="minirail" aria-hidden>
      {states.map((s, i) => (
        <span key={i} className="mr-cell">
          <Node s={s} big={false} />
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------- agent status

export function agentState(a: AgentRun, maxAttempts: number): { text: string; tone: Tone } {
  if (a.status === "queued") return { text: "대기", tone: "dim" };
  if (a.status === "running") return { text: a.attempt > 1 ? `자기 수정 ${a.attempt}/${maxAttempts}` : "작업 중", tone: "now" };
  if (a.status === "retrying") return { text: "자기 수정 준비", tone: "now" };
  if (a.status === "checking") return { text: "검증 중", tone: "now" };
  if (a.status === "cancelled") return { text: "중지됨", tone: "dim" };
  if (a.status === "failed") return { text: "실패", tone: "bad" };
  if (a.check.status === "passed") return { text: a.attempt > 1 ? `${a.attempt}차 통과` : "통과", tone: "ok" };
  if (a.check.status === "failed") return { text: "검증 실패", tone: "bad" };
  return { text: "끝남", tone: undefined };
}

// ---------------------------------------------------------------------------------------------- slide to approve

/** Phone: a drag across instead of a tap, so a merge is never an accident. Keyboard: Enter. */
export function SlideToApprove({ label, onDone, disabled }: { label: string; onDone: () => void; disabled?: boolean }) {
  const track = useRef<HTMLButtonElement>(null);
  const [x, setX] = useState(0);
  const drag = useRef<{ start: number; max: number } | null>(null);
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (d && x >= d.max - 4) onDone();
    setX(0);
  };
  return (
    <button
      ref={track}
      className="slide"
      disabled={disabled}
      aria-label={label}
      onKeyDown={(e) => e.key === "Enter" && onDone()}
      onPointerDown={(e) => {
        const el = track.current;
        if (!el || disabled) return;
        el.setPointerCapture(e.pointerId);
        drag.current = { start: e.clientX, max: el.clientWidth - 60 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setX(Math.max(0, Math.min(d.max, e.clientX - d.start)));
      }}
      onPointerUp={end}
      onPointerCancel={() => {
        drag.current = null;
        setX(0);
      }}
    >
      <span className="slide-thumb" style={{ transform: `translateX(${x}px)` }}>
        <Star size={22} />
      </span>
      <span className="slide-label">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------- modal

export function Modal({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  disabled,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-labelledby="modal-title">
        <h3 id="modal-title">{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button className="btn q" onClick={onClose} disabled={busy}>
            닫기
          </button>
          <button className={`btn ${danger ? "danger" : "w"}`} onClick={onConfirm} disabled={busy || disabled}>
            {busy ? <Spinner size={12} /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- toasts

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "err" | "info";
}
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast t-${t.tone}`}>
            {t.tone === "ok" ? <IconCheck size={14} /> : t.tone === "err" ? <IconX size={14} /> : null}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
      {action}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="errbox">
      <IconX size={14} />
      <span>{error}</span>
      {onRetry ? (
        <button className="btn q sm" onClick={onRetry}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}
