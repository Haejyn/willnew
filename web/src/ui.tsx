import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentStatus, CheckStatus } from "./api";
import { IconCheck, IconX, AgentMark } from "./icons";
import { STATUS_KO, adapterName } from "./util";

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />;
}


export function StatusPill({ status, check }: { status: AgentStatus; check?: CheckStatus }) {
  const live = status === "running" || status === "checking" || status === "retrying";
  const cls = status === "done" && check === "failed" ? "st-done-failed" : `st-${status}`;
  return (
    <span className={`pill ${cls}`} title={status === "done" && check === "failed" ? "작업 완료 · 검증 실패" : undefined}>
      {live ? <Spinner size={10} /> : <span className="dot" />}
      {STATUS_KO[status] ?? status}
    </span>
  );
}

export function StatusDot({ status, check }: { status: AgentStatus; check?: CheckStatus }) {
  const cls = status === "done" && check === "failed" ? "st-failed" : `st-${status}`;
  return <span className={`sdot ${cls}`} title={`${status}${check && check !== "skipped" ? ` · check ${check}` : ""}`} />;
}

export function CheckBadge({ status }: { status: CheckStatus | string }) {
  if (status === "skipped") return <span className="cbadge cb-skipped">검증 없음</span>;
  if (status !== "passed" && status !== "failed") return <span className="cbadge cb-skipped cap">{status}</span>;
  return (
    <span className={`cbadge cb-${status}`}>
      {status === "passed" ? <IconCheck size={12} /> : <IconX size={12} />}
      {status === "passed" ? "검증 통과" : "검증 실패"}
    </span>
  );
}

export function AdapterBadge({ adapter, model }: { adapter: string; model?: string }) {
  return (
    <span className={`abadge ad-${adapter}`} title={model ? `${adapterName(adapter)} · ${model}` : adapterName(adapter)}>
      <AgentMark adapter={adapter} size={20} />
      <span className="abadge-name">{adapterName(adapter)}</span>
      {model ? <span className="abadge-model">{model}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------- modal

export function Modal({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
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
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            닫기
          </button>
          <button ref={btn} className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm} disabled={busy}>
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
        <button className="btn ghost sm" onClick={onRetry}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}
