import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AgentRun } from "./api";
import { IconCheck, IconX } from "./icons";

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} aria-label="진행 중" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Calls `onOut` on a press outside `ref` or on Escape — for popovers and menus. */
export function useOutside(ref: RefObject<HTMLElement | null>, open: boolean, onOut: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOut();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onOut();
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [ref, open, onOut]);
}

export type Tone = "ok" | "bad" | "now" | "dim" | undefined;
export function Tag({ tone, mono, children, title }: { tone?: Tone; mono?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`tag ${tone ? `t-${tone}` : ""} ${mono ? "mono" : ""}`} title={title}>
      {children}
    </span>
  );
}

export function Avatar({ name, size = 28, bot, src }: { name: string; size?: number; bot?: boolean; src?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`avatar ${bot ? "bot" : ""}`} style={{ width: size, height: size, fontSize: size >= 40 ? 14 : 12 }} aria-hidden>
      {src && !broken ? <img src={src} alt="" width={size} height={size} onError={() => setBroken(true)} /> : size < 24 ? name.slice(-1) : name.slice(-2)}
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
        <IconCheck size={22} />
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
