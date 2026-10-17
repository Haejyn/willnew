/**
 * 요청 카드. 같은 요청을 역할마다 다르게 보여 준다.
 * 요청자: AI가 이해한 것, 되묻기 선택지, 진행 단계. 파일과 diff 는 보이지 않는다.
 * 개발자: 작업 명세(수용 기준 체크리스트), 구현 제안(파일, 위험, 추가할 테스트, 예상치), 진행 / 고쳐서 진행 / 직접 할게 / 거절.
 * 원문은 어느 쪽이든 접어서 항상 볼 수 있다.
 */
import { useState, type ReactNode } from "react";
import type { Api, ClarifyQuestion, DecideInput, DecisionEntry, Proposal, Request, WorkSpec } from "./api";
import { TYPE_KO } from "../../src/server/request-state";
import { useLiveRequest } from "./flow";
import { IconCheck, IconChevron, IconExternal } from "./icons";
import { Moon, type Phase } from "./moon";
import { Avatar, ErrorBox, Spinner, useToast } from "./ui";
import { fmtCost, relTime, type User } from "./util";

// ---------------------------------------------------------------------------------------------- stage track

export const REQ_STEPS = ["정리", "되묻기", "명세", "제안", "개발자 확인", "작업", "검증", "검토", "병합", "배포"];
const AT: Record<Request["status"], number> = {
  draft: 0, clarifying: 1, spec_ready: 3, proposed: 4, approved: 5, building: 5, verifying: 6, code_review: 7, merged: 9, deployed: 10, closed: 10, declined: -1, cancelled: -1,
};
const STEP_PHASE: Phase[] = ["new", "plan", "plan", "plan", "turn", "run", "check", "turn", "check", "check"];

/** 지금 몇 번째 칸인지. at = REQ_STEPS.length 이면 모두 끝. 병합만 추적하면(배포 확인 없음) 병합에서 끝난다. */
export function reqStage(req: Request, deployTracked = true): { at: number; stopped?: "declined" | "cancelled"; complete: boolean; phase: Phase } {
  if (req.status === "declined" || req.status === "cancelled") {
    const at = Math.max(0, Math.min(AT[req.stoppedFrom ?? "proposed"], REQ_STEPS.length - 1));
    return { at, stopped: req.status, complete: false, phase: "rejected" };
  }
  let at = AT[req.status];
  if (req.status === "merged" && !deployTracked) at = REQ_STEPS.length;
  if (req.assignee && req.status === "closed") at = REQ_STEPS.length;
  const complete = at >= REQ_STEPS.length;
  return { at, complete, phase: complete ? "merged" : STEP_PHASE[at] };
}

export function RequestTrack({ req, deployTracked = true }: { req: Request; deployTracked?: boolean }) {
  const { at, stopped, complete, phase } = reqStage(req, deployTracked);
  const label = (s: string, i: number): ReactNode => {
    if (i === at && stopped) return stopped === "declined" ? "거절됨" : "취소됨";
    if (i === 1 && !req.questions.length && at > 1) return "되묻기 없음";
    if (i === 4 && req.reviewer) return <>{s}<span className="who">{req.reviewer}</span></>;
    if (i === 5 && req.assignee) return <>직접 작업<span className="who">{req.assignee}</span></>;
    if (i === 9 && !deployTracked) return "배포 (따로)";
    return s;
  };
  return (
    <ol className={`rq-track ${complete ? "complete" : ""}`} aria-label="진행 단계">
      {REQ_STEPS.map((s, i) => {
        const state = complete || i < at ? "done" : i === at ? "now" : "todo";
        return (
          <li key={s} className={`rq-step ${state} ${state === "now" && stopped ? "stop" : ""}`} aria-current={state === "now" ? "step" : undefined}>
            <span className="mark">{state === "now" ? <Moon phase={phase} size={22} /> : state === "done" ? <IconCheck size={12} /> : null}</span>
            <span className="lab">{label(s, i)}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------- words

const isDev = (u: User) => u.role !== "requester";

/** 카드 맨 위 한 줄. 요청자 쪽은 쉬운 말, 개발자 쪽은 짧게. */
export function reqHeadline(req: Request, user: User): string {
  const dev = req.reviewer ?? "개발자";
  if (!isDev(user)) {
    switch (req.status) {
      case "draft": return "받았어요. 정리하는 중";
      case "clarifying": return req.questions.every((q) => q.answer) ? "답 받았어요. 정리하는 중" : "확인할 게 있어요";
      case "spec_ready": return "어떻게 만들지 살펴보는 중";
      case "proposed": return `개발자가 제안을 보고 있어요 (${dev})`;
      case "approved": return req.assignee ? `${req.assignee}님이 직접 맡았어요` : "작업 시작해요";
      case "building": return "만드는 중";
      case "verifying": return "테스트로 확인하는 중";
      case "code_review": return `개발자가 결과를 보고 있어요 (${dev})`;
      case "merged": return "반영했어요";
      case "deployed": return "배포까지 끝났어요";
      case "closed": return "끝났어요";
      case "declined": return "이번엔 진행하지 않기로 했어요";
      case "cancelled": return "취소했어요";
    }
  }
  switch (req.status) {
    case "draft": return "정리 중";
    case "clarifying": return "요청자 답 기다리는 중";
    case "spec_ready": return "저장소 읽고 제안 만드는 중";
    case "proposed": return req.reviewer && req.reviewer !== user.name ? `제안 확인 대기 (${req.reviewer})` : "확인할 제안이 있어요";
    case "approved": return req.assignee ? `직접 작업 (${req.assignee})` : "작업 시작";
    case "building": return "작업 중";
    case "verifying": return "검증 중";
    case "code_review": return "결과 검토 차례";
    case "merged": return "병합됨";
    case "deployed": return "배포됨";
    case "closed": return "닫힘";
    case "declined": return "거절됨";
    case "cancelled": return "취소됨";
  }
}

const WHAT_KO: Record<DecisionEntry["what"], string> = {
  answer: "답함", proceed: "진행", proceed_with_changes: "고쳐서 진행", take_over: "직접 맡음", decline: "거절", cancel: "취소", close: "닫음",
  approve_result: "결과 승인", reject_result: "결과 반려",
};
const CONF_KO: Record<Proposal["confidence"], string> = { high: "높음", medium: "보통", low: "낮음" };

// ---------------------------------------------------------------------------------------------- pieces

export function Original({ req }: { req: Request }) {
  return (
    <details className="rq-orig">
      <summary>
        원문 보기 <IconChevron size={12} />
      </summary>
      <p>{req.text}</p>
      {req.attachments.length ? (
        <ul className="rq-links">
          {req.attachments.map((a) => (
            <li key={a.url}>
              <a href={a.url} target="_blank" rel="noreferrer">
                {a.kind === "figma" ? "Figma" : a.kind === "image" ? "이미지" : "링크"} <IconExternal size={12} />
              </a>
              <span className="mono dim small">{a.url.replace(/^https?:\/\//, "")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function Clarify({ api, req, user }: { api: Api; req: Request; user: User }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");
  // 답은 요청한 사람만 고른다. 다른 사람은 읽기만
  const mine = req.status === "clarifying" && user.name === req.requester;
  const send = async (q: ClarifyQuestion, answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(q.id);
    try {
      await api.answer(req.id, q.id, answer.trim(), user.name);
      setOther(null);
      setOtherText("");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };
  return (
    <ol className="rq-qs">
      {req.questions.map((q, i) => {
        const custom = !!q.answer && !q.choices.includes(q.answer);
        return (
          <li key={q.id} className="rq-q">
            <span className="rq-qt">
              {req.questions.length > 1 ? `${i + 1}. ` : ""}
              {q.question}
            </span>
            <div className="chips">
              {q.choices.map((c) => (
                <button key={c} className={`chip pick ${q.answer === c ? "on" : ""}`} aria-pressed={q.answer === c} disabled={!mine || !!q.answer || !!busy} onClick={() => send(q, c)}>
                  {q.answer === c ? <IconCheck size={13} /> : null}
                  {c}
                </button>
              ))}
              <button className={`chip pick ${custom ? "on" : ""}`} aria-pressed={custom} disabled={!mine || !!q.answer || !!busy} onClick={() => setOther(other === q.id ? null : q.id)}>
                {custom ? <IconCheck size={13} /> : null}
                {custom ? `기타: ${q.answer}` : "기타"}
              </button>
              {busy === q.id ? <Spinner size={12} /> : null}
            </div>
            {other === q.id && !q.answer ? (
              <form className="rq-other" onSubmit={(e) => { e.preventDefault(); void send(q, otherText); }}>
                <input autoFocus aria-label="직접 적기" value={otherText} onChange={(e) => setOtherText(e.target.value)} placeholder="직접 적어 주세요" maxLength={200} />
                <button className="btn sm w" type="submit" disabled={!otherText.trim() || !!busy}>보내기</button>
              </form>
            ) : null}
            {!mine && !q.answer ? <span className="dim small">{req.requester}님 답 기다리는 중</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function SpecCard({ spec, done }: { spec: WorkSpec; done?: boolean }) {
  return (
    <section className="rq-sec" aria-label="작업 명세">
      <span className="lab">작업 명세</span>
      <dl className="rq-dl">
        <dt>문제</dt>
        <dd>{spec.problem}</dd>
        <dt>기대 결과</dt>
        <dd>{spec.expected}</dd>
      </dl>
      <span className="lab">수용 기준</span>
      <ul className="rq-check">
        {spec.acceptanceCriteria.map((c) => (
          <li key={c} className={done ? "on" : ""}>
            <span className="box" aria-hidden>{done ? <IconCheck size={11} /> : null}</span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
      {spec.constraints.length ? (
        <>
          <span className="lab">개발자 조건</span>
          <ul className="rq-list cons">
            {spec.constraints.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      ) : null}
      {spec.outOfScope.length ? (
        <div className="rq-row">
          <span className="lab">범위 밖</span>
          <span className="chips">
            {spec.outOfScope.map((x) => (
              <span key={x} className="tag">{x}</span>
            ))}
          </span>
        </div>
      ) : null}
      {spec.references.length ? (
        <div className="rq-row">
          <span className="lab">참고</span>
          <span className="chips">
            {spec.references.map((u) => (
              <a key={u} className="tag" href={u} target="_blank" rel="noreferrer">
                {/figma\.com/.test(u) ? "Figma" : u.replace(/^https?:\/\//, "").slice(0, 32)} <IconExternal size={11} />
              </a>
            ))}
          </span>
        </div>
      ) : null}
    </section>
  );
}

export function ProposalCard({ p }: { p: Proposal }) {
  return (
    <section className="rq-sec rq-prop" aria-label="구현 제안">
      <span className="lab">구현 제안 {p.by === "fallback" ? <span className="warn-chip">AI 제안 실패</span> : null}</span>
      <p className="rq-sum">{p.summary}</p>
      {p.note ? <p className="dim small">{p.note}</p> : null}
      {p.approach.length ? (
        <ol className="rq-list">
          {p.approach.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ol>
      ) : null}
      {p.files.length ? (
        <>
          <span className="lab">바꿀 파일</span>
          <ul className="rq-files">
            {p.files.map((f) => (
              <li key={f.path}>
                <span className="mono">{f.path}</span>
                <span className="dim">{f.why}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {p.risks.length ? (
        <>
          <span className="lab">위험</span>
          <ul className="rq-list risk">
            {p.risks.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      ) : null}
      {p.testsToAdd.length ? (
        <>
          <span className="lab">추가할 테스트</span>
          <ul className="rq-list">
            {p.testsToAdd.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="rq-est small">
        예상 {p.estimate.minutes ? `약 ${p.estimate.minutes}분` : "시간 모름"}, {p.estimate.costUsd != null ? `약 ${fmtCost(p.estimate.costUsd)}` : "비용 모름"} <span className="dim">(추정치, 확신 {CONF_KO[p.confidence]})</span>
      </p>
    </section>
  );
}

type Mode = "changes" | "take_over" | "decline";
const MODE: Record<Mode, { label: string; ask: string; placeholder: string; required: boolean; decision: DecideInput["decision"] }> = {
  changes: { label: "고쳐서 진행", ask: "무엇을 바꿀까요 · 명세에 조건으로 붙어요", placeholder: "예: lg 전체 말고 결제 화면 버튼에만 새 size=xl 추가", required: true, decision: "proceed_with_changes" },
  take_over: { label: "직접 할게", ask: "메모 (선택) · AI 작업 없이 내가 맡아요", placeholder: "예: 토큰 정리랑 같이 할게요", required: false, decision: "take_over" },
  decline: { label: "거절", ask: "사유 · 요청자에게는 쉬운 말로 풀어서 전해요", placeholder: "예: 결제 완료율 측정 중이라 이번 분기엔 화면을 못 바꿔요", required: true, decision: "decline" },
};

export function DecideBar({ api, req, user }: { api: Api; req: Request; user: User }) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (decision: DecideInput["decision"], body?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.decide(req.id, { decision, by: user.name, text: body });
      toast(decision === "decline" ? "거절했어요. 요청자에게 설명이 가요" : decision === "take_over" ? "직접 맡았어요" : "진행해요. 에이전트가 시작해요", "ok");
      setMode(null);
      setText("");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  const m = mode ? MODE[mode] : null;
  return (
    <div className="rq-decide">
      <div className="row-btns">
        <button className="btn m" disabled={busy} onClick={() => go("proceed")}>
          {busy && !mode ? <Spinner size={12} /> : null}진행
        </button>
        {(Object.keys(MODE) as Mode[]).map((k) => (
          <button key={k} className={`btn ${k === "decline" ? "q" : ""}`} aria-pressed={mode === k} disabled={busy} onClick={() => { setMode(mode === k ? null : k); setText(""); }}>
            {MODE[k].label}
          </button>
        ))}
      </div>
      {m && mode ? (
        <form className="rq-box" onSubmit={(e) => { e.preventDefault(); if (!m.required || text.trim()) void go(m.decision, text.trim() || undefined); }}>
          <label className="field">
            <span>{m.ask}</span>
            <textarea autoFocus rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={m.placeholder} />
          </label>
          <div className="row-btns">
            <button className={`btn ${mode === "decline" ? "danger" : "w"} sm`} type="submit" disabled={busy || (m.required && !text.trim())}>
              {busy ? <Spinner size={12} /> : null}
              {m.label}
            </button>
            <button className="btn q sm" type="button" onClick={() => setMode(null)}>닫기</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function DecisionLog({ req, now }: { req: Request; now: number }) {
  if (!req.decisions.length) return null;
  return (
    <section className="rq-sec" aria-label="결정 기록">
      <span className="lab">결정 기록</span>
      <ol className="rq-log">
        {req.decisions.map((d, i) => (
          <li key={i}>
            <Avatar name={d.who} size={20} />
            <span>
              <b>{d.who}</b> {WHAT_KO[d.what]} <span className="dim small">{relTime(d.when, now)}</span>
              {d.why ? <span className="rq-why">{d.why}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Declined({ req }: { req: Request }) {
  const d = req.decline;
  if (!d) return null;
  return (
    <section className="rq-sec rq-declined">
      <p>{d.forRequester}</p>
      {d.alternatives.length ? (
        <>
          <span className="lab">이렇게는 할 수 있어요</span>
          <ul className="rq-list">
            {d.alternatives.map((a) => (
              <li key={a.title}>
                {a.title} <span className="dim">({a.effort})</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- the card

export function RequestView({ api, req, user, inChat, deployTracked = true, now = Date.now() }: { api: Api; req: Request; user: User; inChat?: boolean; deployTracked?: boolean; now?: number }) {
  const dev = isDev(user);
  const [more, setMore] = useState(false);
  const { stopped, complete } = reqStage(req, deployTracked);
  const shipped = ["merged", "deployed", "closed"].includes(req.status) && !req.assignee;
  // 채팅에서는 개발자가 결정할 때만 명세와 제안을 펼친다. 그 밖에는 눌러서 연다
  const showSpec = dev && !!req.spec && (!inChat || req.status === "proposed" || more);
  const understood = req.spec ? (dev ? req.spec.summary.forDeveloper : req.spec.summary.forRequester) : dev ? req.understood?.forDeveloper : req.understood?.forRequester;
  let body: ReactNode = null;
  if (!dev) {
    body = (
      <>
        {understood ? <p className="rq-understood">{understood}</p> : null}
        {req.status === "clarifying" && req.questions.some((q) => !q.answer) ? <p className="rq-ask">{req.questions.length === 1 ? "하나만 확인할게요" : `${["", "하나", "두 가지", "세 가지"][req.questions.length]}만 확인할게요`}</p> : null}
        {req.questions.length && req.status === "clarifying" ? <Clarify api={api} req={req} user={user} /> : null}
      </>
    );
  } else {
    body = (
      <>
        {understood ? <p className="rq-understood dev">{understood}</p> : null}
        {req.questions.length ? (
          <section className="rq-sec">
            <span className="lab">되묻기</span>
            {req.status === "clarifying" ? <Clarify api={api} req={req} user={user} /> : (
              <ul className="rq-list qa">
                {req.questions.map((q) => (
                  <li key={q.id}>
                    {q.question} <b>{q.answer ?? "답 없음"}</b>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
        {showSpec && req.spec ? <SpecCard spec={req.spec} done={complete || req.status === "merged" || req.status === "deployed"} /> : null}
        {showSpec && req.proposal ? <ProposalCard p={req.proposal} /> : null}
        {inChat && dev && req.spec && req.status !== "proposed" ? (
          <button className="btn q sm rq-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            {more ? "명세와 제안 접기" : "명세와 제안 보기"}
          </button>
        ) : null}
        {req.planner?.by === "fallback" && req.planner.note ? <p className="warn-chip rq-warn">{req.planner.note}</p> : null}
      </>
    );
  }
  return (
    <div className={`rq ${inChat ? "in-chat" : ""}`}>
      <div className="rc-head">
        <Moon phase={reqStage(req, deployTracked).phase} size={16} />
        <b>{req.title}</b>
        {req.type ? <span className="rc-phase">{TYPE_KO[req.type]}</span> : null}
      </div>
      <div className={`rq-status ${stopped ? "stop" : complete || shipped ? "ok" : ""}`}>{reqHeadline(req, user)}</div>
      {body}
      {req.status === "declined" ? <Declined req={req} /> : null}
      <RequestTrack req={req} deployTracked={deployTracked} />
      {dev && req.status === "proposed" ? <DecideBar api={api} req={req} user={user} /> : null}
      {dev && (!inChat || more) ? <DecisionLog req={req} now={now} /> : null}
      <div className="rq-foot">
        <Original req={req} />
        <span className="grow" />
        {req.runIds.length && dev ? (
          <a className="msg-link" href={`#/runs/${req.runIds.at(-1)}`}>
            작업 공간 <IconChevron size={12} />
          </a>
        ) : null}
        {inChat ? (
          <a className="msg-link" href={`#/requests/${req.id}`}>
            자세히 <IconChevron size={12} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function RequestCard({ api, id, user, deployTracked }: { api: Api; id: string; user: User; deployTracked?: boolean }) {
  const { req, error, reload } = useLiveRequest(api, id);
  if (error && !req) return <ErrorBox error={error} onRetry={reload} />;
  if (!req) return <div className="runcard skel" aria-busy style={{ height: 120 }} />;
  return (
    <div className="runcard rq-card">
      <RequestView api={api} req={req} user={user} inChat deployTracked={deployTracked} />
    </div>
  );
}

export function RequestPage({ api, id, user, deployTracked }: { api: Api; id: string; user: User; deployTracked?: boolean }) {
  const { req, error, reload } = useLiveRequest(api, id);
  return (
    <div className="turn-page">
      <div className="turn-col rq-page">
        <a className="msg-link" href={user.role === "requester" ? "#/" : "#/mine"} onClick={(e) => { if (window.history.length > 1) { e.preventDefault(); window.history.back(); } }}>
          뒤로
        </a>
        {error && !req ? <ErrorBox error={`불러오기 실패 · ${error}`} onRetry={reload} /> : null}
        {!req && !error ? <div className="skel card-skel" /> : null}
        {req ? (
          <article className="mine-card">
            <div className="mine-top">
              <span className="dim small who">
                <Avatar name={req.requester} size={20} src={req.requesterAvatar} />
                {req.requester}
                {req.requesterTitle ? <span className="title-chip">{req.requesterTitle}</span> : null}
                <span>#{req.channel} · {relTime(req.createdAt)}</span>
              </span>
            </div>
            <RequestView api={api} req={req} user={user} deployTracked={deployTracked} />
          </article>
        ) : null}
      </div>
    </div>
  );
}

/** 내 차례 맨 위: 내가 확인할 제안 */
export function ProposalTurnCard({ api, req, user, now, go }: { api: Api; req: Request; user: User; now: number; go: (p: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const href = `/requests/${req.id}`;
  const p = req.proposal;
  return (
    <article className="mcard" onClick={() => go(href)}>
      <Moon phase="turn" size={28} />
      <div className="mc-main">
        <h2>
          <a href={`#${href}`} onClick={(e) => e.stopPropagation()}>
            {req.title}
          </a>
        </h2>
        <div className="mc-meta">
          #{req.channel} · <Avatar name={req.requester} size={18} src={req.requesterAvatar} />
          {req.requester} · {relTime(req.createdAt, now)}
        </div>
        {p ? (
          <div className="mc-rec">
            <span>{p.summary}</span>
            <span className="mono">
              {p.files.length ? `파일 ${p.files.length}개 · ` : ""}
              {p.estimate.minutes ? `약 ${p.estimate.minutes}분` : ""}
              {p.estimate.costUsd != null ? ` · 약 ${fmtCost(p.estimate.costUsd)}` : ""}
            </span>
            {p.risks.length ? <span className="warn-chip">위험 {p.risks.length}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="mc-act" onClick={(e) => e.stopPropagation()}>
        <button
          className="btn m"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.decide(req.id, { decision: "proceed", by: user.name });
              toast("진행해요. 에이전트가 시작해요", "ok");
            } catch (e) {
              toast((e as Error).message, "err");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size={12} /> : null}진행
        </button>
        <a className="btn" href={`#${href}`}>
          제안 보기
        </a>
      </div>
    </article>
  );
}

/** 내 요청 카드 (요청자) */
export function RequestMineCard({ api, req, user, now, note, deployTracked = true }: { api: Api; req: Request; user: User; now: number; note?: string; deployTracked?: boolean }) {
  const { stopped, complete } = reqStage(req, deployTracked);
  const summary = req.spec?.summary.forRequester ?? req.understood?.forRequester;
  return (
    <article className={`mine-card ${stopped ? "stopped" : ""} ${complete ? "complete" : ""}`}>
      <div className={`mine-status ${stopped ? "s-rejected" : complete ? "s-merged" : ""}`}>{reqHeadline(req, user)}</div>
      <div className="mine-top">
        <h2>{req.title}</h2>
        <span className="dim small who">
          <Avatar name={req.requester} size={20} src={req.requesterAvatar} />#{req.channel} · {relTime(req.createdAt, now)}
        </span>
      </div>
      <RequestTrack req={req} deployTracked={deployTracked} />
      {summary && req.status !== "declined" ? <p className="mine-detail">{summary}</p> : null}
      {req.status === "clarifying" ? <Clarify api={api} req={req} user={user} /> : null}
      {req.status === "declined" ? <Declined req={req} /> : null}
      {note ? (
        <blockquote className="mine-note">
          <span className="lab">결과 설명</span>
          {note}
        </blockquote>
      ) : null}
      <div className="rq-foot">
        <Original req={req} />
        <span className="grow" />
        <a className="msg-link" href={`#/chat/${req.channel}`}>채널에서 보기</a>
        <a className="msg-link" href={`#/requests/${req.id}`}>
          자세히 <IconChevron size={12} />
        </a>
      </div>
    </article>
  );
}
