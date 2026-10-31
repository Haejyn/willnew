/** 티켓 화면들이 같이 쓰는 조각: 살아 있는 티켓, 목록, 상태 점, 출처, 확신도, 복사 버튼, 진행 단계, 고객 원문, 칸 목록. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { STATUS_KO } from "../../../src/server/request-state";
import { IconCheck, IconChevron, IconEdit, IconLink, IconSpark } from "../icons";
import { Spinner, useToast } from "../ui";
import {
  CONF_KO,
  FIELDS,
  fieldLabel,
  fieldMeta,
  fieldText,
  heldFields,
  isGuess,
  sourceLabel,
  TICKET_STEPS,
  utterances,
  type Confidence,
  type FieldName,
  type ListQuery,
  type RequestStatus,
  type Ticket,
  type TicketApi,
  type TicketSummary,
} from "./api";

export const TicketApiCtx = createContext<TicketApi | null>(null);
export function useTicketApi(): TicketApi {
  const t = useContext(TicketApiCtx);
  if (!t) throw new Error("TicketApiCtx 가 없어요");
  return t;
}

// ---------------------------------------------------------------------------------------------- data

/** 티켓 하나. 스트림의 ticket 이벤트로 갈아 끼우고, delta 는 질문이 흘러나오는 글자, queue 는 대기열 위치 */
export function useTicket(key: string | undefined) {
  const tapi = useTicketApi();
  const [ticket, setTicketRaw] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [queue, setQueue] = useState(0);
  const setTicket = useCallback((t: Ticket) => {
    setTicketRaw((cur) => (!cur || cur.id !== t.id || t.updatedAt >= cur.updatedAt ? t : cur));
    setDelta("");
    setQueue(0);
  }, []);
  const reload = useCallback(() => {
    if (!key) return;
    setError(null);
    tapi.get(key).then(setTicket).catch((e: Error) => setError(e.message));
  }, [tapi, key, setTicket]);
  useEffect(() => {
    setTicketRaw(null);
    setDelta("");
    if (!key) return;
    reload();
    return tapi.stream(key, {
      ticket: setTicket,
      delta: (s) => setDelta((d) => d + s),
      queue: (q) => setQueue(q.position),
    });
  }, [tapi, key, reload, setTicket]);
  return { ticket, setTicket, error, reload, delta, queue };
}

/** 목록, 몇 초마다 다시 읽는다 */
export function useTicketList(q: ListQuery | null, ms = 4000) {
  const tapi = useTicketApi();
  const [list, setList] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qs = JSON.stringify(q);
  const reload = useCallback(() => {
    if (!q) return;
    tapi
      .list(q)
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [tapi, qs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setList(null);
    reload();
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [reload, ms]);
  return { list, error, reload };
}

/** 버튼 하나의 바쁨과 오류 토스트 */
export function useAct() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(id: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      setBusy(id);
      try {
        const v = await fn();
        if (ok) toast(ok, "ok");
        return v;
      } catch (e) {
        toast((e as Error).message, "err");
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---------------------------------------------------------------------------------------------- small pieces

const tone = (s: RequestStatus) =>
  s === "merged" || s === "deployed" || s === "closed" ? "ok" : s === "waiting_requester" || s === "waiting_customer" ? "warn" : s === "declined" || s === "cancelled" ? "" : "";

export function StatusDot({ status }: { status: RequestStatus }) {
  return <span className={`st ${tone(status)}`}>{STATUS_KO[status] ?? status}</span>;
}

export function Priority({ p }: { p?: string }) {
  return p ? <span className="tk-pri mono">{p}</span> : <span className="t-meta">없음</span>;
}

export function ConfDot({ c }: { c: Confidence }) {
  const cls = c === "high" ? "ok" : c === "low" ? "warn" : "";
  return <span className={`st tk-conf ${cls}`} title="확신도">{CONF_KO[c]}</span>;
}

/** AI 가 짐작해 채운 칸. 달빛 글자로, 사람이 확인하면 "확인함" 으로 바뀐다 */
export function GuessBadge() {
  return (
    <span className="tk-guess">
      <IconSpark size={12} filled />
      추정
    </span>
  );
}

/** 칸의 출처 칩들. 말이면 그 말을 툴팁으로 */
export function Sources({ t, field }: { t: Ticket; field: string }) {
  const m = fieldMeta(t.spec, field);
  if (!m) return null;
  const utt = utterances(t.text);
  if (!m.sources.length) return <span className="t-meta">출처 없음</span>;
  return (
    <span className="tk-srcs">
      {m.sources.map((s, i) => (
        <span key={i} className="tk-src" title={s.kind === "utterance" && s.speaker !== "cs" ? utt[s.index]?.text : undefined}>
          {sourceLabel(s)}
        </span>
      ))}
    </span>
  );
}

export function CopyBtn({ text, label, ok = "복사했어요", className = "btn sm", disabled, title }: { text: string; label: ReactNode; ok?: string; className?: string; disabled?: boolean; title?: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      title={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          toast(ok, "ok");
          timer.current = setTimeout(() => setDone(false), 1600);
        } catch {
          toast("복사하지 못했어요. 직접 골라서 복사해 주세요", "err");
        }
      }}
    >
      {done ? <IconCheck size={14} /> : <IconLink size={14} />}
      {label}
    </button>
  );
}

/** 보낸 티켓의 진행: 보냄 → 담당자 → 작업 → 검토 → 반영 */
export function TicketSteps({ status }: { status: RequestStatus }) {
  const at = TICKET_STEPS.findIndex((s) => s.at.includes(status));
  const stopped = status === "declined" || status === "cancelled";
  return (
    <ol className={`tk-steps ${stopped ? "stop" : ""}`} aria-label="진행 단계">
      {TICKET_STEPS.map((s, i) => {
        const state = stopped ? "todo" : at < 0 ? "todo" : i < at || (i === at && i === TICKET_STEPS.length - 1) ? "done" : i === at ? "now" : "todo";
        return (
          <li key={s.name} className={state} aria-current={state === "now" ? "step" : undefined}>
            <i aria-hidden />
            <span>{s.name}</span>
          </li>
        );
      })}
      {stopped ? <li className="now"><span>{STATUS_KO[status]}</span></li> : null}
    </ol>
  );
}

/** 고객 원문. 접혀 있고 언제든 펼친다 */
export function Original({ text, label = "고객 원문", open: start = false }: { text: string; label?: string; open?: boolean }) {
  const [open, setOpen] = useState(start);
  return (
    <section className="tk-orig">
      <button type="button" className="prow-t" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconChevron size={12} /> {label}
      </button>
      {open ? <blockquote className="quote">{text}</blockquote> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- field list

/** 칸 고치기 상자. 목록 칸은 줄마다 하나, 환경은 세 칸, 영향 범위는 숫자와 메모 */
function FieldEditor({ t, f, onSave, onCancel, busy }: { t: Ticket; f: FieldName; onSave: (v: unknown) => void; onCancel: () => void; busy: boolean }) {
  const s = t.spec;
  const [text, setText] = useState(() => (f === "reproSteps" ? (s?.reproSteps ?? []).join("\n") : f === "alreadyRuledOut" ? (s?.alreadyRuledOut ?? []).join("\n") : f === "environment" || f === "impact" ? "" : fieldText(s, f)));
  const [env, setEnv] = useState({ browser: s?.environment?.browser ?? "", os: s?.environment?.os ?? "", appVersion: s?.environment?.appVersion ?? "" });
  const [imp, setImp] = useState({ customers: String(s?.impact?.customers ?? ""), note: s?.impact?.note ?? "" });
  const value = () => {
    if (f === "reproSteps" || f === "alreadyRuledOut") return text.split(/\r?\n/).map((x) => x.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
    if (f === "environment") return Object.fromEntries(Object.entries(env).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    if (f === "impact") return { customers: Number(imp.customers) || 0, ...(imp.note.trim() ? { note: imp.note.trim() } : {}) };
    return text.trim();
  };
  return (
    <form
      className="tk-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value());
      }}
    >
      {f === "environment" ? (
        <div className="tk-edit-grid">
          <label className="field"><span>브라우저</span><input value={env.browser} onChange={(e) => setEnv({ ...env, browser: e.target.value })} placeholder="사파리" /></label>
          <label className="field"><span>기기, OS</span><input value={env.os} onChange={(e) => setEnv({ ...env, os: e.target.value })} placeholder="iOS 18" /></label>
          <label className="field"><span>앱 버전</span><input value={env.appVersion} onChange={(e) => setEnv({ ...env, appVersion: e.target.value })} placeholder="웹이면 비워 두기" /></label>
        </div>
      ) : f === "impact" ? (
        <div className="tk-edit-grid">
          <label className="field"><span>고객 수</span><input inputMode="numeric" value={imp.customers} onChange={(e) => setImp({ ...imp, customers: e.target.value.replace(/\D/g, "") })} /></label>
          <label className="field wide"><span>메모</span><input value={imp.note} onChange={(e) => setImp({ ...imp, note: e.target.value })} /></label>
        </div>
      ) : (
        <label className="field">
          <span className="sr">{fieldLabel(f)}</span>
          <textarea autoFocus rows={f === "reproSteps" || f === "alreadyRuledOut" ? 4 : 2} value={text} onChange={(e) => setText(e.target.value)} placeholder={f === "reproSteps" || f === "alreadyRuledOut" ? "한 줄에 하나씩" : undefined} />
        </label>
      )}
      <div className="row-btns">
        <button className="btn sm w" type="submit" disabled={busy}>
          {busy ? <Spinner size={12} /> : null}저장
        </button>
        <button className="btn sm q" type="button" onClick={onCancel} disabled={busy}>
          취소
        </button>
      </div>
    </form>
  );
}

function FieldValue({ t, f }: { t: Ticket; f: FieldName }) {
  const held = heldFields(t).some((a) => a.field === f);
  const meta = fieldMeta(t.spec, f);
  if (f === "reproSteps" && t.spec?.reproSteps?.length)
    return (
      <ol className="tk-ol">
        {t.spec.reproSteps.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ol>
    );
  const v = fieldText(t.spec, f);
  if (v && held)
    return (
      <span>
        {v} <span className="tk-held">고객에게 묻는 중</span>
      </span>
    );
  if (v) return <span>{v}</span>;
  if (held) return <span className="dim">고객에게 묻는 중</span>;
  if (meta?.confidence === "unknown") return <span className="dim">모름</span>;
  return <span className="dim">비어 있음</span>;
}

/**
 * 필수 칸 목록. mode:
 *  live: 새 문의 오른쪽, 방금 채워진 칸은 잠깐 밝게
 *  review: 초안 확인, 추정 칸은 확인 버튼, 칸마다 고치기
 *  read: 상세(개발자), 출처와 확신도만
 */
export function FieldList({ t, mode, onConfirm, onEdit, busy, fields = FIELDS }: { t: Ticket; mode: "live" | "review" | "read"; onConfirm?: (f: FieldName) => void; onEdit?: (f: FieldName, value: unknown) => Promise<unknown>; busy?: string | null; fields?: FieldName[] }) {
  const [editing, setEditing] = useState<FieldName | null>(null);
  // 새 문의: 방금 채워진 칸을 잠깐 밝게
  const prev = useRef<Record<string, string>>({});
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const sig = fields.map((f) => fieldText(t.spec, f)).join("");
  useEffect(() => {
    const changed = fields.filter((f) => prev.current[f] !== undefined && prev.current[f] !== fieldText(t.spec, f) && fieldText(t.spec, f));
    for (const f of fields) prev.current[f] = fieldText(t.spec, f);
    if (mode !== "live" || !changed.length) return;
    setFresh(new Set(changed));
    const tm = setTimeout(() => setFresh(new Set()), 1600);
    return () => clearTimeout(tm);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // 확인 버튼 중 액센트는 첫 칸 하나만
  const firstNeed = fields.find((f) => isGuess(t.spec, f) && !fieldMeta(t.spec, f)?.confirmedBy);
  return (
    <dl className="tk-fields">
      {fields.map((f) => {
        const meta = fieldMeta(t.spec, f);
        const guess = isGuess(t.spec, f);
        const confirmed = !!meta?.confirmedBy;
        return (
          <div key={f} className={`tk-field ${fresh.has(f) ? "fresh" : ""} ${guess && !confirmed && mode === "review" ? "need" : ""}`}>
            <dt>
              <span>{fieldLabel(f)}</span>
              {guess && !confirmed ? <GuessBadge /> : null}
              {confirmed && guess ? <span className="st ok tk-confirmed">확인함</span> : null}
            </dt>
            <dd>
              {editing === f && onEdit ? (
                <FieldEditor t={t} f={f} busy={busy === `edit-${f}`} onCancel={() => setEditing(null)} onSave={async (v) => { await onEdit(f, v); setEditing(null); }} />
              ) : (
                <div className="tk-val">
                  <FieldValue t={t} f={f} />
                </div>
              )}
              {meta && editing !== f ? (
                <div className="tk-meta">
                  <ConfDot c={meta.confidence} />
                  <Sources t={t} field={f} />
                </div>
              ) : null}
              {mode === "review" && editing !== f ? (
                <div className="tk-acts">
                  {guess && !confirmed && onConfirm ? (
                    <button className={`btn sm ${f === firstNeed ? "m" : ""}`} onClick={() => onConfirm(f)} disabled={busy === `confirm-${f}`}>
                      {busy === `confirm-${f}` ? <Spinner size={12} /> : <IconCheck size={14} />}이대로 맞아요
                    </button>
                  ) : null}
                  {onEdit ? (
                    <button className="btn sm q" onClick={() => setEditing(f)}>
                      <IconEdit size={14} /> 고치기
                    </button>
                  ) : null}
                </div>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** 칸 몇 개가 찼는지 ("4/7") */
export function filledCount(t: Ticket): number {
  return FIELDS.filter((f) => fieldText(t.spec, f) || fieldMeta(t.spec, f)?.confidence === "unknown").length;
}
