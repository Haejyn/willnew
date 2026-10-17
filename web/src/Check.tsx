/**
 * 요청자 확인 (B2). 테스트를 통과한 화면 수정은 개발자 코드 검토 전에 요청자가 먼저 본다.
 * 미리보기 링크, 같은 크기의 전후 스크린샷(나란히 또는 끌어서 비교), 두 버튼(의도대로예요, 다시 봐 주세요).
 * 다시 봐 주세요는 스크린샷 위에 상자를 그리고 상자마다 한 줄을 적는 화면을 연다. 개발자는 이유를 적고 건너뛸 수 있다.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { Api, Feedback, Request, RequesterCheck, ShotPair } from "./api";
import { IconExternal, IconTrash, IconX } from "./icons";
import { Spinner, Working, useToast } from "./ui";
import type { User } from "./util";

const vpKo = (v: ShotPair["viewport"]) => (v === "mobile" ? "모바일" : "데스크톱");
const pairLabel = (p: ShotPair, all: ShotPair[]) => (new Set(all.map((x) => x.screen)).size > 1 ? `${p.screen} ${vpKo(p.viewport)}` : vpKo(p.viewport));

const STATUS: Record<RequesterCheck["status"], { text: string; tone: string }> = {
  waiting: { text: "확인 기다리는 중", tone: "now" },
  approved: { text: "의도대로예요", tone: "ok" },
  changes: { text: "다시 봐 달라고 했어요", tone: "warn" },
  skipped: { text: "건너뜀", tone: "" },
};

// ---------------------------------------------------------------------------------------------- the panel

export function CheckPanel({ api, req, user, compact }: { api: Api; req: Request; user: User; compact?: boolean }) {
  const check = req.checks?.at(-1);
  const [annotating, setAnnotating] = useState(false);
  const [skipping, setSkipping] = useState(false);
  if (!check) return null;
  const waiting = req.status === "preview" && check.status === "waiting";
  const requester = user.name === req.requester;
  const dev = user.role !== "requester";
  const st = STATUS[check.status];
  const earlier = (req.checks ?? []).filter((c) => c !== check && c.status === "changes" && c.feedback?.length);
  const again = req.status === "building" || req.status === "verifying" ? check.status === "changes" : false;
  return (
    <section className={`chk ${compact ? "compact" : ""}`} aria-label="화면 확인">
      <div className="chk-head">
        <span className="sec-t">화면 확인</span>
        {check.round > 1 ? <span className="t-meta">{check.round}번째 결과</span> : null}
        <span className="grow" />
        <span className={`st ${st.tone}`}>{st.text}</span>
      </div>
      {again ? <p className="chk-again">표시한 곳을 고치는 중이에요. 끝나면 다시 보여 드려요 ({check.round + 1}번째 시도)</p> : null}
      {check.previewUrl || check.baseUrl ? (
        <div className="chk-links">
          {check.previewUrl ? (
            <a className="btn sm" href={check.previewUrl} target="_blank" rel="noreferrer">
              미리보기 열기 <IconExternal size={12} />
            </a>
          ) : null}
          {check.baseUrl ? (
            <a className="btn q sm" href={check.baseUrl} target="_blank" rel="noreferrer">
              지금 화면 (main)
            </a>
          ) : null}
          {check.previewUrl ? <span className="t-meta mono chk-url">{check.previewUrl.replace(/^https?:\/\//, "")}</span> : null}
        </div>
      ) : null}
      {check.localOnly && check.previewUrl ? <p className="t-meta">이 링크는 willnew 를 띄운 컴퓨터에서만 열려요</p> : null}
      {check.capture === "running" ? <Working text={check.previewUrl ? "전후 화면 찍는 중" : "미리보기 띄우는 중"} lines={1} /> : null}
      {check.note ? <p className="chk-note">{check.note}</p> : null}
      {check.shots.length ? <PairViewer api={api} shots={check.shots} feedback={check.status === "changes" ? check.feedback : undefined} /> : null}
      {check.status === "changes" && check.feedback?.length ? <FeedbackList feedback={check.feedback} who={check.by} /> : null}
      {check.status === "skipped" && check.reason ? (
        <p className="chk-reason">
          <b>{check.by}</b> 건너뛴 이유: {check.reason}
        </p>
      ) : null}
      {earlier.length && !compact ? (
        <details className="chk-earlier">
          <summary className="t-meta">이전 확인 {earlier.length}번</summary>
          {earlier.map((c) => (
            <div key={c.round}>
              <span className="t-meta">{c.round}번째 결과</span>
              <FeedbackList feedback={c.feedback!} who={c.by} />
            </div>
          ))}
        </details>
      ) : null}
      {waiting && requester ? (
        <RequesterButtons api={api} req={req} user={user} onAnnotate={() => setAnnotating(true)} />
      ) : waiting && dev ? (
        skipping ? (
          <SkipBox api={api} req={req} user={user} onClose={() => setSkipping(false)} />
        ) : (
          <div className="row-btns">
            <span className="t-meta">{req.requester}님 확인 기다리는 중</span>
            <span className="grow" />
            <button className="btn q sm" onClick={() => setSkipping(true)}>
              요청자 확인 건너뛰기
            </button>
          </div>
        )
      ) : waiting ? (
        <span className="t-meta">{req.requester}님 확인 기다리는 중</span>
      ) : null}
      {annotating ? <Annotate api={api} req={req} check={check} user={user} onClose={() => setAnnotating(false)} /> : null}
    </section>
  );
}

function RequesterButtons({ api, req, user, onAnnotate }: { api: Api; req: Request; user: User; onAnnotate: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ok = async () => {
    setBusy(true);
    try {
      await api.requesterCheck(req.id, { verdict: "ok", by: user.name });
      toast("전했어요. 이제 개발자가 코드를 봐요", "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row-btns chk-act">
      <button className="btn m" disabled={busy} onClick={ok}>
        {busy ? <Spinner size={12} /> : null}의도대로예요
      </button>
      <button className="btn q" disabled={busy} onClick={onAnnotate}>
        다시 봐 주세요
      </button>
    </div>
  );
}

function SkipBox({ api, req, user, onClose }: { api: Api; req: Request; user: User; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await api.requesterCheck(req.id, { verdict: "skip", by: user.name, reason: reason.trim() });
      toast("건너뛰었어요. 결정 기록에 남아요", "ok");
      onClose();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="rq-box" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label className="field">
        <span>건너뛰는 이유. 결정 기록과 스레드에 남아요</span>
        <textarea autoFocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 한지우님 휴가라 시안과 같은지 제가 확인했어요" />
      </label>
      <div className="row-btns">
        <button className="btn w sm" type="submit" disabled={busy || !reason.trim()}>
          {busy ? <Spinner size={12} /> : null}건너뛰고 코드 검토로
        </button>
        <button className="btn q sm" type="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </form>
  );
}

function FeedbackList({ feedback, who }: { feedback: Feedback[]; who?: string }) {
  return (
    <ol className="fb-list" aria-label="표시한 곳">
      {feedback.map((f, i) => (
        <li key={i}>
          <span className="fb-n mono">{i + 1}</span>
          <span>
            {f.note}
            <span className="t-meta">
              {" "}
              {f.screen}
              {f.viewport === "mobile" ? ", 모바일" : ""}
              {who && i === 0 ? `, ${who}` : ""}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------- 전/후

/** 같은 크기의 전후 쌍. 나란히 보거나, 한 장 위에서 손잡이를 끌어 전과 후를 비교한다. */
export function PairViewer({ api, shots, feedback }: { api: Api; shots: ShotPair[]; feedback?: Feedback[] }) {
  const [i, setI] = useState(0);
  const [mode, setMode] = useState<"side" | "slider">("side");
  const p = shots[Math.min(i, shots.length - 1)];
  const boxes = (feedback ?? []).map((f, n) => ({ ...f, n: n + 1 })).filter((f) => f.screen === p.screen && (f.viewport ?? "desktop") === p.viewport);
  return (
    <div className={`pair ${p.viewport}`}>
      <div className="pair-bar">
        {shots.length > 1 ? (
          <div className="seg" role="tablist" aria-label="화면">
            {shots.map((s, k) => (
              <button key={k} role="tab" aria-selected={k === i} className={k === i ? "on" : ""} onClick={() => setI(k)}>
                {pairLabel(s, shots)}
              </button>
            ))}
          </div>
        ) : (
          <span className="t-meta">{pairLabel(p, shots)}</span>
        )}
        <span className="grow" />
        <div className="seg" aria-label="보기">
          <button className={mode === "side" ? "on" : ""} aria-pressed={mode === "side"} onClick={() => setMode("side")}>
            나란히
          </button>
          <button className={mode === "slider" ? "on" : ""} aria-pressed={mode === "slider"} onClick={() => setMode("slider")}>
            전/후
          </button>
        </div>
      </div>
      {mode === "side" ? (
        <div className="pair-side">
          <Shot api={api} url={p.before} pair={p} label="전" sub="main" />
          <Shot api={api} url={p.after} pair={p} label="후" sub="이 결과" boxes={boxes} />
        </div>
      ) : (
        <Slider api={api} pair={p} />
      )}
      {p.error ? <p className="chk-note">{p.error}</p> : null}
    </div>
  );
}

function Shot({ api, url, pair, label, sub, boxes }: { api: Api; url?: string; pair: ShotPair; label: string; sub: string; boxes?: (Feedback & { n: number })[] }) {
  return (
    <figure className="shot">
      <figcaption>
        <b>{label}</b> <span className="t-meta">{sub}</span>
      </figcaption>
      <div className="shot-img" style={{ aspectRatio: `${pair.width} / ${pair.height}` }}>
        {url ? <img src={api.shotUrl(url)} alt={`${pair.screen} ${label}`} loading="lazy" draggable={false} /> : <span className="shot-none t-meta">없음</span>}
        {boxes?.map((b) => <BoxMark key={b.n} rect={b.rect} n={b.n} />)}
      </div>
    </figure>
  );
}

function BoxMark({ rect, n, on }: { rect: Feedback["rect"]; n: number; on?: boolean }) {
  const style: CSSProperties = { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` };
  return (
    <span className={`box-mark ${on ? "on" : ""}`} style={style}>
      <span className="box-n mono">{n}</span>
    </span>
  );
}

function Slider({ api, pair }: { api: Api; pair: ShotPair }) {
  const [pos, setPos] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const at = (x: number) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setPos(Math.round(Math.min(100, Math.max(0, ((x - r.left) / r.width) * 100))));
  };
  return (
    <div
      className="slider"
      ref={box}
      style={{ aspectRatio: `${pair.width} / ${pair.height}` }}
      onPointerDown={(e) => {
        drag.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        at(e.clientX);
      }}
      onPointerMove={(e) => drag.current && at(e.clientX)}
      onPointerUp={() => (drag.current = false)}
    >
      {pair.after ? <img src={api.shotUrl(pair.after)} alt={`${pair.screen} 후`} draggable={false} /> : null}
      {pair.before ? <img className="slider-before" src={api.shotUrl(pair.before)} alt={`${pair.screen} 전`} draggable={false} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} /> : null}
      <span className="slider-line" style={{ left: `${pos}%` }} aria-hidden>
        <span className="slider-knob" />
      </span>
      <span className="slider-tag l">전</span>
      <span className="slider-tag r">후</span>
      <input className="slider-range" type="range" min={0} max={100} value={pos} aria-label="전과 후 경계" onChange={(e) => setPos(Number(e.target.value))} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- 다시 봐 주세요: 상자 그리기

interface Box {
  pair: number;
  rect: Feedback["rect"];
  note: string;
}

/** 스크린샷 위에 끌어서 상자를 그리고 상자마다 한 줄을 적는다. 상자는 다음 시도의 조건이 된다. */
export function Annotate({ api, req, check, user, onClose }: { api: Api; req: Request; check: RequesterCheck; user: User; onClose: () => void }) {
  const toast = useToast();
  const shots = check.shots;
  const [pi, setPi] = useState(0);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [draft, setDraft] = useState<Feedback["rect"] | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const notes = useRef<(HTMLInputElement | null)[]>([]);
  const p = shots[pi];
  const close = useCallback(() => !busy && onClose(), [busy, onClose]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [close]);
  useEffect(() => {
    if (focus != null) notes.current[focus]?.focus();
  }, [focus, boxes.length]);

  const frac = (e: RPointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".box-mark")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = frac(e);
    setDraft({ ...start.current, w: 0, h: 0 });
  };
  const move = (e: RPointerEvent) => {
    if (!start.current) return;
    const c = frac(e);
    const s = start.current;
    setDraft({ x: Math.min(s.x, c.x), y: Math.min(s.y, c.y), w: Math.abs(c.x - s.x), h: Math.abs(c.y - s.y) });
  };
  const up = () => {
    const d = draft;
    start.current = null;
    setDraft(null);
    if (!d || d.w < 0.02 || d.h < 0.01) return;
    setBoxes((b) => [...b, { pair: pi, rect: d, note: "" }]);
    setFocus(boxes.length);
  };
  const ready = (boxes.length > 0 && boxes.every((b) => b.note.trim())) || (!shots.length && note.trim());
  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const feedback: Feedback[] = boxes.map((b) => ({ screen: shots[b.pair].screen, viewport: shots[b.pair].viewport, rect: b.rect, note: b.note.trim() }));
      await api.requesterCheck(req.id, { verdict: "changes", by: user.name, feedback, note: note.trim() || undefined });
      toast("보냈어요. 고쳐서 다시 보여 드릴게요", "ok");
      onClose();
    } catch (e) {
      toast((e as Error).message, "err");
      setBusy(false);
    }
  };

  // 스레드 칸은 흐림 효과가 있는 면이라 fixed 가 그 안에 갇힌다. body 로 띄운다
  return createPortal(
    <div className="anno-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="anno" role="dialog" aria-modal aria-label="다시 볼 곳 표시">
        <header className="anno-top">
          <b className="t-title">다시 볼 곳 표시</b>
          <span className="grow" />
          <button className="ib sm" aria-label="닫기" onClick={close}>
            <IconX size={16} />
          </button>
        </header>
        <div className="anno-body">
          <div className="anno-stage">
            {shots.length > 1 ? (
              <div className="seg" role="tablist" aria-label="화면">
                {shots.map((s, k) => (
                  <button key={k} role="tab" aria-selected={k === pi} className={k === pi ? "on" : ""} onClick={() => setPi(k)}>
                    {pairLabel(s, shots)}
                    {boxes.some((b) => b.pair === k) ? <span className="mono">{boxes.filter((b) => b.pair === k).length}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {p ? (
              <div className={`anno-canvas ${p.viewport}`}>
                <div className="anno-img" ref={area} style={{ aspectRatio: `${p.width} / ${p.height}` }} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
                  {p.after ?? p.before ? <img src={api.shotUrl((p.after ?? p.before)!)} alt={`${p.screen} 후`} draggable={false} /> : null}
                  {boxes.map((b, k) => (b.pair === pi ? <BoxMark key={k} rect={b.rect} n={k + 1} on={focus === k} /> : null))}
                  {draft ? <span className="box-mark draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} /> : null}
                </div>
              </div>
            ) : (
              <p className="t-meta">찍힌 화면이 없어요. 어디가 다른지 글로 적어 주세요</p>
            )}
          </div>
          <aside className="anno-side">
            <p className="t-meta">{shots.length ? "고칠 곳을 끌어서 상자로 표시하고, 상자마다 한 줄 적어 주세요" : "다시 볼 곳을 적어 주세요"}</p>
            {boxes.length ? (
              <ol className="anno-list">
                {boxes.map((b, k) => (
                  <li key={k} className={focus === k ? "on" : ""}>
                    <span className="fb-n mono">{k + 1}</span>
                    <div className="anno-item">
                      <span className="t-meta">{pairLabel(shots[b.pair], shots)}</span>
                      <input
                        ref={(el) => {
                          notes.current[k] = el;
                        }}
                        value={b.note}
                        maxLength={60}
                        aria-label={`${k + 1}번 상자 설명`}
                        placeholder="예: 여기 아직 좁아요"
                        onFocus={() => {
                          setFocus(k);
                          if (b.pair !== pi) setPi(b.pair);
                        }}
                        onChange={(e) => setBoxes((cur) => cur.map((x, j) => (j === k ? { ...x, note: e.target.value } : x)))}
                      />
                    </div>
                    <button className="ib sm" aria-label={`${k + 1}번 상자 지우기`} onClick={() => setBoxes((cur) => cur.filter((_, j) => j !== k))}>
                      <IconTrash size={14} />
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
            <label className="field">
              <span>전체에 한 줄 (선택)</span>
              <input value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="예: 버튼 색은 좋아요" />
            </label>
            <div className="row-btns anno-foot">
              <button className="btn m" disabled={!ready || busy} onClick={send}>
                {busy ? <Spinner size={12} /> : null}보내기
              </button>
              <button className="btn q" onClick={close}>
                닫기
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
