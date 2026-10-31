/**
 * 요청 카드. 같은 요청을 역할마다 다르게 보여 준다.
 * 요청자: AI가 이해한 것(원문 보기), 한 번에 하나씩 되묻기, 네 단계 진행. 파일과 diff 는 보이지 않는다.
 * 개발자: 작업 명세(수용 기준 체크리스트, 확인 필요 표시), "이렇게 개발할까요?" 제안과 결정 버튼, 결과 검토 버튼.
 *
 * 채널 본문에는 짧은 embed(RequestEmbed), 스레드와 요청 화면에는 전체(RequestView). 결정 기록은 요청 화면 오른쪽 맥락 칸에.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Api, ClarifyQuestion, DecideInput, DecisionEntry, Proposal, Request, Run, Screen, WorkSpec } from "./api";
import { isVisual, STATUS_KO, TYPE_KO } from "../../src/server/request-state";
import { CheckPanel } from "./Check";
import { ReviewActions } from "./Decision";
import { useLiveRequest, useLiveRun } from "./flow";
import { IconCheck, IconChevron } from "./icons";
import { Moon, runPhase, type Phase } from "./moon";
import { AiText, Avatar, ErrorBox, LinkChip, Spinner, Working, useToast } from "./ui";
import { fmtCost, relTime, type User } from "./util";

// ---------------------------------------------------------------------------------------------- stages

/** 열 칸의 하위 단계. 화면에는 네 단계(이해 → 합의 → 작업 → 반영)로 묶어 보이고, 지금 칸은 낱말 하나로 옆에 쓴다. */
export const REQ_STEPS = ["정리", "되묻기", "명세", "제안", "확인", "작업", "검증", "화면 확인", "검토", "병합", "배포"];
export const PHASES: { name: string; steps: number[] }[] = [
  { name: "이해", steps: [0, 1, 2] },
  { name: "합의", steps: [3, 4] },
  { name: "작업", steps: [5, 6, 7, 8] },
  { name: "반영", steps: [9, 10] },
];
const AT: Record<Request["status"], number> = {
  draft: 0, clarifying: 1, waiting_customer: 1, spec_ready: 3, open: 4, assigned: 4, in_progress: 5, waiting_requester: 5, proposed: 4, approved: 5, building: 5, verifying: 6, preview: 7, code_review: 8, merged: 10, deployed: 11, closed: 11, declined: -1, cancelled: -1,
};
/** 티켓 경로의 상태는 칸 낱말 대신 상태 이름을 쓴다 */
const TICKET = new Set<Request["status"]>(["waiting_customer", "open", "assigned", "in_progress", "waiting_requester"]);
const STEP_PHASE: Phase[] =["new", "plan", "plan", "plan", "turn", "run", "check", "turn", "turn", "check", "check"];

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

/** 네 단계 진행 줄의 상태. phase 0~3 은 지금 단계, 4 는 모두 끝. fill 은 지금 단계의 달이 찬 정도. */
export interface Progress {
  phase: number;
  fill: number;
  word: string;
  state?: "stop" | "done";
  /** 지금 보는 사람이 할 차례: 지금 달과 띠가 액센트 */
  mine?: boolean;
}

const isDev = (u: User) => u.role !== "requester";

/** 이 요청에서 지금 보는 사람이 할 일이 있는가 (되묻기 답, 제안 확인, 결과 검토) */
export function myTurn(req: Request, user: User): boolean {
  if (req.status === "clarifying") return user.name === req.requester && req.questions.some((q) => !q.answer);
  // 요청자 확인: the requester's move
  if (req.status === "preview") return user.name === req.requester;
  // the developer asked CS something, or CS has to ask the customer
  if (req.status === "waiting_requester" || req.status === "waiting_customer") return user.name === req.requester;
  if (!isDev(user)) return false;
  if (req.status === "proposed" || req.status === "code_review") return !req.reviewer || req.reviewer === user.name;
  return false;
}

export function reqProgress(req: Request, user: User, deployTracked = true): Progress {
  const { at, stopped, complete } = reqStage(req, deployTracked);
  if (complete) return { phase: 4, fill: 1, word: req.assignee ? "끝남" : deployTracked ? "배포됨" : "병합됨", state: "done" };
  const phase = Math.max(0, PHASES.findIndex((p) => p.steps.includes(at)));
  const steps = PHASES[phase].steps;
  const fill = (steps.indexOf(at) + 1) / (steps.length + 1);
  if (stopped) return { phase, fill, word: stopped === "declined" ? "거절됨" : "취소됨", state: "stop" };
  const word = TICKET.has(req.status) ? STATUS_KO[req.status] : at === 5 && req.assignee ? "직접 작업" : at === 10 && !deployTracked ? "병합" : REQ_STEPS[at];
  return { phase, fill, word, mine: myTurn(req, user) };
}

/** 예전 방식(바로 맡긴 run)도 같은 네 단계로. 합의 단계는 건너뛴 것으로 본다. */
export function runProgress(run: Run, now = Date.now()): Progress {
  const { phase } = runPhase(run, now);
  const st = run.ship?.stage;
  if (run.review.status === "approved") {
    if (st === "ci_failed") return { phase: 3, fill: 0.5, word: "CI 실패", state: "stop" };
    if (st === "deploy_failed") return { phase: 3, fill: 0.5, word: "배포 확인 실패", state: "stop" };
    if (st === "pr" || st === "ci") return { phase: 3, fill: 0.33, word: "CI 확인" };
    if (st === "merged" || st === "deploying") return { phase: 3, fill: 0.67, word: "배포 중" };
    return { phase: 4, fill: 1, word: st === "deployed" ? "배포됨" : "반영됨", state: "done" };
  }
  switch (phase) {
    case "new":
    case "plan":
      return { phase: 0, fill: 0.5, word: "접수" };
    case "run":
    case "retry":
      return { phase: 2, fill: 0.25, word: "고치는 중" };
    case "check":
      return { phase: 2, fill: 0.5, word: "테스트" };
    case "turn":
      return { phase: 2, fill: 0.75, word: "검토 대기" };
    case "rejected":
      return { phase: 2, fill: 0.75, word: "반영 안 함", state: "stop" };
    default:
      return { phase: 2, fill: 0.5, word: "테스트 실패", state: "stop" };
  }
}

/** 네 칸 진행 줄: 칸마다 달이 차오르고, 지금 하위 단계는 옆에 낱말 하나로. 채널 embed, 요청 화면, 내 요청, 휴대폰이 같이 쓴다. */
export function PhaseTrack({ p, who }: { p: Progress; who?: string }) {
  const lunar = (i: number): { fill: number; tone: Phase } => {
    if (p.state === "done" || i < p.phase) return { fill: 1, tone: "check" };
    if (i === p.phase) return { fill: p.fill, tone: p.state === "stop" ? "rejected" : p.mine ? "turn" : "run" };
    return { fill: 0, tone: "new" };
  };
  return (
    <div className={`ptrack ${p.state ?? ""} ${p.mine ? "mine" : ""}`}>
      <ol aria-label="진행 단계">
        {PHASES.map((ph, i) => {
          const m = lunar(i);
          const state = p.state === "done" || i < p.phase ? "done" : i === p.phase ? "now" : "todo";
          return (
            <li key={ph.name} className={`pseg ${state}`} aria-current={state === "now" ? "step" : undefined}>
              <Moon phase={m.tone} fill={m.fill} size={16} label={`${ph.name} ${state === "done" ? "끝남" : state === "now" ? "지금" : "아직"}`} />
              <span>{ph.name}</span>
            </li>
          );
        })}
      </ol>
      <span className={`ptrack-word st ${p.state === "done" ? "ok" : p.state === "stop" ? "warn" : ""}`}>
        {p.word}
        {who ? <span className="dim"> {who}</span> : null}
      </span>
    </div>
  );
}

/** 단계별 왼쪽 띠 색. 액센트는 쓰지 않는다(주 버튼과 지금 단계 달이 맡는다). */
export function phaseBar(p: Progress): CSSProperties {
  const c = p.state === "stop" ? "var(--text4)" : p.state === "done" ? "var(--phase-4)" : `var(--phase-${Math.min(p.phase, 3) + 1})`;
  return { "--bar": c } as CSSProperties;
}

// ---------------------------------------------------------------------------------------------- words

/** 카드 맨 위 한 줄. 요청자 쪽은 쉬운 말, 개발자 쪽은 짧게. */
export function reqHeadline(req: Request, user: User): string {
  const dev = req.reviewer ?? "개발자";
  if (!isDev(user)) {
    switch (req.status) {
      case "draft": return "받았어요. 정리하는 중";
      case "clarifying": return req.questions.every((q) => q.answer) ? "답 받았어요. 정리하는 중" : "확인할 게 있어요";
      case "waiting_customer": return "고객 답 기다리는 중";
      case "spec_ready": return "어떻게 만들지 살펴보는 중";
      case "open": return "개발팀에 보냈어요";
      case "assigned": return `${req.assignee ?? "담당자"}님이 맡았어요`;
      case "in_progress": return `${req.assignee ?? "개발자"}님이 작업하고 있어요`;
      case "waiting_requester": return user.name === req.requester ? "개발자가 물어본 게 있어요" : `${req.requester}님 답 기다리는 중`;
      case "proposed": return `개발자가 제안을 보고 있어요 (${dev})`;
      case "approved": return req.assignee ? `${req.assignee}님이 직접 맡았어요` : "작업 시작해요";
      case "building": return "만드는 중";
      case "verifying": return "테스트로 확인하는 중";
      case "preview": return user.name === req.requester ? "확인해 주세요" : `${req.requester}님이 화면을 확인하는 중`;
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
    case "waiting_customer": return "고객 답 기다림";
    case "spec_ready": return "저장소 읽고 제안 만드는 중";
    case "open": return "담당자 없음";
    case "assigned": return `담당자 정해짐 (${req.assignee ?? "미정"})`;
    case "in_progress": return `작업 중 (${req.assignee ?? "담당 미정"})`;
    case "waiting_requester": return `CS 답 기다림 (${req.requester})`;
    case "proposed": return req.reviewer && req.reviewer !== user.name ? `제안 확인 대기 (${req.reviewer})` : "확인할 제안이 있어요";
    case "approved": return req.assignee ? `직접 작업 (${req.assignee})` : "작업 시작";
    case "building": return "작업 중";
    case "verifying": return "검증 중";
    case "preview": return `요청자 확인 대기 (${req.requester})`;
    case "code_review": return "결과 검토 차례";
    case "merged": return "병합됨";
    case "deployed": return "배포됨";
    case "closed": return "닫힘";
    case "declined": return "거절됨";
    case "cancelled": return "취소됨";
  }
}

const WHAT_KO: Record<DecisionEntry["what"], string> = {
  answer: "답했어요", proceed: "진행", proceed_with_changes: "고쳐서 진행", take_over: "직접 맡았어요", decline: "거절", cancel: "취소", close: "닫았어요",
  approve_result: "결과 승인", reject_result: "결과 반려",
  preview_ok: "화면 확인: 의도대로예요", preview_changes: "화면 확인: 다시 봐 주세요", preview_skip: "요청자 확인 건너뜀",
  reopen: "다시 열었어요",
};
const working = (req: Request) => req.status === "draft" || req.status === "spec_ready" || (req.status === "clarifying" && req.questions.every((q) => q.answer));
/** 요청자 확인이 지금 일인가: 확인 차례이거나, 다시 봐 달라고 한 뒤 고치는 중 */
const checkNow = (req: Request) =>
  !!req.checks?.length && (req.status === "preview" || ((req.status === "building" || req.status === "verifying") && req.checks.at(-1)!.status === "changes"));

// ---------------------------------------------------------------------------------------------- clarify: 한 번에 하나

export function Clarify({ api, req, user }: { api: Api; req: Request; user: User }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [otherText, setOtherText] = useState("");
  const n = req.questions.length;
  const open = req.questions.findIndex((q) => !q.answer);
  if (open < 0) return null;
  const q = req.questions[open];
  // 답은 요청한 사람만 고른다. 다른 사람은 읽기만
  const mine = req.status === "clarifying" && user.name === req.requester;
  const send = async (x: ClarifyQuestion, answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(answer);
    try {
      await api.answer(req.id, x.id, answer.trim(), user.name);
      setOther(false);
      setOtherText("");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="cq" aria-label="되묻기">
      {req.questions.slice(0, open).map((d) => (
        <p key={d.id} className="cq-done">
          <IconCheck size={12} /> {d.question}: <b>{d.answer}</b>
        </p>
      ))}
      <div className="cq-head">
        <span className="cq-q">{q.question}</span>
        {n > 1 ? <span className="t-meta mono">{open + 1}/{n}</span> : null}
      </div>
      <div className="chips cq-chips">
        {q.choices.map((c) => (
          <button key={c} className={`chip pick ${busy === c ? "on" : ""}`} aria-pressed={busy === c} disabled={!mine || !!busy} onClick={() => send(q, c)}>
            {busy === c ? <IconCheck size={14} /> : null}
            {c}
          </button>
        ))}
        <button className={`chip pick ${other ? "on" : ""}`} aria-expanded={other} disabled={!mine || !!busy} onClick={() => setOther((o) => !o)}>
          기타
        </button>
      </div>
      {other && mine ? (
        <form className="rq-other" onSubmit={(e) => { e.preventDefault(); void send(q, otherText); }}>
          <input autoFocus aria-label="직접 적기" value={otherText} onChange={(e) => setOtherText(e.target.value)} placeholder="직접 적어 주세요" maxLength={200} />
          <button className="btn sm w" type="submit" disabled={!otherText.trim() || !!busy}>보내기</button>
        </form>
      ) : null}
      {!mine ? <span className="t-meta">{req.requester}님 답 기다리는 중</span> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- spec

export function SpecCard({ spec, done }: { spec: WorkSpec; done?: boolean }) {
  const flags = new Map((spec.needsCheck ?? []).map((f) => [f.criterion, f.names]));
  return (
    <section className="rq-sec" aria-label="작업 명세">
      <h3 className="sec-t">작업 명세</h3>
      <dl className="rq-dl">
        <dt>문제</dt>
        <dd>{spec.problem}</dd>
        <dt>기대 결과</dt>
        <dd>{spec.expected}</dd>
      </dl>
      <ul className="rq-check" aria-label="수용 기준">
        {spec.acceptanceCriteria.map((c) => {
          const names = flags.get(c);
          return (
            <li key={c} className={done ? "on" : names ? "flag" : ""}>
              <span className="box" aria-hidden>{done ? <IconCheck size={11} /> : null}</span>
              <span>
                {c}
                {names ? (
                  <span className="flag-note">
                    <span className="st warn">확인 필요</span> 저장소에서 못 찾은 이름: {names.map((x) => <code key={x}>{x}</code>)}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
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
          {spec.outOfScope.map((x) => (
            <span key={x} className="chip muted">{x}</span>
          ))}
        </div>
      ) : null}
      {spec.references.length ? (
        <div className="rq-row">
          {spec.references.map((u) => (
            <LinkChip key={u} url={u} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- 전후 화면을 찍을 페이지

/** 계획 에이전트가 채운 페이지 목록. 개발자가 고칠 수 있고, 다음 확인부터 이 목록으로 찍는다. */
function ScreensEdit({ api, req, user }: { api: Api; req: Request; user: User }) {
  const toast = useToast();
  const screens = req.spec?.screens ?? [];
  const [edit, setEdit] = useState<Screen[] | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api.setScreens(req.id, edit.filter((s) => s.name.trim() || s.path.trim()), user.name);
      setEdit(null);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rq-sec" aria-label="확인할 화면">
      <div className="chk-head">
        <h3 className="sec-t">확인할 화면</h3>
        <span className="grow" />
        {!edit ? (
          <button className="btn q sm" onClick={() => setEdit(screens.map((s) => ({ ...s })))}>
            고치기
          </button>
        ) : null}
      </div>
      {!edit ? (
        <div className="rq-row">
          {screens.length ? screens.map((s) => (
            <span key={s.path} className="chip muted">
              {s.name} <span className="mono">{s.path}</span>
            </span>
          )) : <span className="t-meta">아직 없어요. 첫 화면을 찍어요</span>}
        </div>
      ) : (
        <form className="scr-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {edit.map((s, i) => (
            <div key={i} className="scr-row">
              <input aria-label="화면 이름" value={s.name} placeholder="결제 화면" onChange={(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input aria-label="경로" className="mono" value={s.path} placeholder="/checkout" onChange={(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
              <button type="button" className="btn q sm" onClick={() => setEdit(edit.filter((_, j) => j !== i))}>
                빼기
              </button>
            </div>
          ))}
          <div className="row-btns">
            <button type="button" className="btn q sm" onClick={() => setEdit([...edit, { name: "", path: "/" }])}>
              화면 더하기
            </button>
            <span className="grow" />
            <button className="btn w sm" type="submit" disabled={busy}>
              {busy ? <Spinner size={12} /> : null}저장
            </button>
            <button className="btn q sm" type="button" onClick={() => setEdit(null)}>
              닫기
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- proposal: 이렇게 개발할까요?

function Row({ label, n, children, more }: { label: string; n?: number; children?: ReactNode; more?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="prow">
      <dt>
        {more ? (
          <button type="button" className="prow-t" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <IconChevron size={12} /> {label} {n != null ? <span className="mono">{n}</span> : null}
          </button>
        ) : (
          <span className="prow-t">
            {label} {n != null ? <span className="mono">{n}</span> : null}
          </span>
        )}
      </dt>
      <dd>
        {children}
        {open ? <div className="prow-more">{more}</div> : null}
      </dd>
    </div>
  );
}

/** 제안 카드. 결정 버튼은 개발자이고 제안 차례일 때만 카드 안 맨 아래에 붙는다. */
export function ProposalCard({ p, decide }: { p: Proposal; decide?: ReactNode }) {
  const est = `${p.estimate.minutes ? `${p.estimate.minutes}분` : "시간 모름"}, ${p.estimate.costUsd != null ? fmtCost(p.estimate.costUsd) : "비용 모름"} (추정${p.confidence === "low" ? ", 확신 낮음" : ""})`;
  return (
    <section className="prop" aria-label="구현 제안">
      <h3 className="t-title">이렇게 개발할까요?</h3>
      <p className="prop-sum">{p.summary}</p>
      {p.by === "fallback" ? <p className="warn-chip">AI 제안 실패{p.note ? `: ${p.note}` : ""}</p> : null}
      <hr />
      <dl className="prows">
        <Row
          label="바꿀 파일"
          n={p.files.length}
          more={
            p.files.length ? (
              <ul className="rq-files">
                {p.files.map((f) => (
                  <li key={f.path}>
                    <span className="mono">{f.path}</span>
                    <span className="t-meta">{f.why}</span>
                  </li>
                ))}
              </ul>
            ) : undefined
          }
        >
          {p.files.length ? <span className="mono prow-files">{p.files.map((f) => f.path.split("/").pop()).join(", ")}</span> : <span className="dim">못 찾았어요</span>}
        </Row>
        <Row
          label="위험"
          n={p.risks.length}
          more={
            p.risks.length > 1 ? (
              <ul className="rq-list risk">
                {p.risks.slice(1).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            ) : undefined
          }
        >
          {p.risks.length ? <span className="st warn prow-risk">{p.risks[0]}</span> : <span className="dim">없음</span>}
        </Row>
        <Row
          label="테스트"
          n={p.testsToAdd.length}
          more={
            p.testsToAdd.length ? (
              <ul className="rq-list">
                {p.testsToAdd.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            ) : undefined
          }
        >
          <span className="dim">{p.testsToAdd.length ? "수용 기준마다 하나씩 먼저 써요" : "추가 없음"}</span>
        </Row>
        <Row label="예상">
          <span className="mono">{est}</span>
        </Row>
      </dl>
      {decide ? (
        <>
          <hr />
          {decide}
        </>
      ) : null}
    </section>
  );
}

type Mode = "changes" | "take_over" | "decline";
const MODE: Record<Mode, { label: string; ask: string; placeholder: string; required: boolean; decision: DecideInput["decision"] }> = {
  changes: { label: "고쳐서 진행", ask: "무엇을 바꿀까요. 명세에 조건으로 붙어요", placeholder: "예: lg 전체 말고 결제 화면 버튼에만 새 size=xl 추가", required: true, decision: "proceed_with_changes" },
  take_over: { label: "직접 할게", ask: "메모 (선택). AI 작업 없이 내가 맡아요", placeholder: "예: 토큰 정리랑 같이 할게요", required: false, decision: "take_over" },
  decline: { label: "거절", ask: "사유. 요청자에게는 쉬운 말로 풀어서 전해요", placeholder: "예: 결제 완료율 측정 중이라 이번 분기엔 화면을 못 바꿔요", required: true, decision: "decline" },
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
          <button key={k} className="btn q" aria-pressed={mode === k} disabled={busy} onClick={() => { setMode(mode === k ? null : k); setText(""); }}>
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

// ---------------------------------------------------------------------------------------------- decision timeline

export function DecisionTimeline({ req, now }: { req: Request; now: number }) {
  if (!req.decisions.length) return <p className="t-meta">아직 결정한 게 없어요</p>;
  return (
    <ol className="tl" aria-label="결정 기록">
      {req.decisions.map((d, i) => (
        <li key={i}>
          <Avatar name={d.who} size={16} />
          <div>
            <p className="tl-what">
              <b>{d.who}</b> {WHAT_KO[d.what]} <span className="t-meta">{relTime(d.when, now)}</span>
            </p>
            {d.why ? <p className="tl-why">{d.why}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Declined({ req, dev }: { req: Request; dev: boolean }) {
  const d = req.decline;
  if (!d) return null;
  return (
    <section className="rq-declined">
      <AiText read={!dev} original={dev ? d.reason : undefined} label="개발자가 쓴 사유 보기">
        {d.forRequester}
      </AiText>
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

/** 결과 검토 차례면 요청 카드가 run 의 검토 버튼을 대신 단다(카드 하나로). */
function RunReview({ api, runId, user }: { api: Api; runId: string; user: User }) {
  const { run } = useLiveRun(api, runId);
  if (!run) return null;
  return <ReviewActions api={api} run={run} user={user} />;
}

// ---------------------------------------------------------------------------------------------- the full card (thread, request page)

export function RequestView({ api, req, user, deployTracked = true, now = Date.now(), timeline }: { api: Api; req: Request; user: User; deployTracked?: boolean; now?: number; timeline?: boolean }) {
  const dev = isDev(user);
  const p = reqProgress(req, user, deployTracked);
  const understood = req.spec ? (dev ? req.spec.summary.forDeveloper : req.spec.summary.forRequester) : dev ? req.understood?.forDeveloper : req.understood?.forRequester;
  const decide = dev && req.status === "proposed" ? <DecideBar api={api} req={req} user={user} /> : null;
  return (
    <div className="rq">
      <div className="rq-head">
        <h2 className="t-title">{req.title}</h2>
        {req.type ? <span className="t-meta">{TYPE_KO[req.type]}</span> : null}
      </div>
      <PhaseTrack p={p} />
      <p className="rq-status">{reqHeadline(req, user)}</p>
      {understood ? (
        <AiText read={!dev} original={req.text}>
          {understood}
        </AiText>
      ) : null}
      {working(req) ? <Working text={req.status === "spec_ready" ? "저장소 읽는 중" : "정리하는 중"} /> : null}
      {req.status === "clarifying" ? <Clarify api={api} req={req} user={user} /> : null}
      {checkNow(req) ? <CheckPanel api={api} req={req} user={user} /> : null}
      {dev && req.questions.some((q) => q.answer) && req.status !== "clarifying" ? (
        <ul className="rq-list qa" aria-label="되묻기 답">
          {req.questions.map((q) => (
            <li key={q.id}>
              {q.question} <b>{q.answer ?? "답 없음"}</b>
            </li>
          ))}
        </ul>
      ) : null}
      {dev && req.spec ? <SpecCard spec={req.spec} done={p.state === "done" || req.status === "merged"} /> : null}
      {dev && req.spec && isVisual(req) ? <ScreensEdit api={api} req={req} user={user} /> : null}
      {dev && req.proposal ? <ProposalCard p={req.proposal} decide={decide} /> : null}
      {req.checks?.length && !checkNow(req) ? <CheckPanel api={api} req={req} user={user} /> : null}
      {req.planner?.by === "fallback" && req.planner.note && dev ? <p className="warn-chip rq-warn">{req.planner.note}</p> : null}
      {req.status === "declined" ? <Declined req={req} dev={dev} /> : null}
      {req.status === "code_review" && req.runIds.length ? <RunReview api={api} runId={req.runIds.at(-1)!} user={user} /> : null}
      {req.attachments.some((a) => !(dev && req.spec?.references.includes(a.url))) ? (
        <div className="rq-row">
          {req.attachments
            .filter((a) => !(dev && req.spec?.references.includes(a.url)))
            .map((a) => (
              <LinkChip key={a.url} url={a.url} />
            ))}
        </div>
      ) : null}
      {timeline ? (
        <section className="rq-tl">
          <h3 className="sec-t">결정 기록</h3>
          <DecisionTimeline req={req} now={now} />
        </section>
      ) : null}
      {req.runIds.length && dev ? (
        <a className="msg-link" href={`#/runs/${req.runIds.at(-1)}`}>
          작업 공간 <IconChevron size={12} />
        </a>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- compact embed (channel)

/**
 * 채널 본문의 요청 embed: 왼쪽 3px 띠(단계 색, 내 차례면 액센트) + 제목 + 진행 줄 + 필드 두세 개 + 지금 할 일.
 * 요청자의 되묻기와 개발자의 진행, 결과 검토는 여기서 바로 한다. 나머지는 스레드에서.
 */
export function RequestEmbed({ api, id, user, deployTracked, onThread, onWorking, threaded }: { api: Api; id: string; user: User; deployTracked?: boolean; onThread?: () => void; onWorking?: (id: string, on: boolean) => void; threaded?: boolean }) {
  const { req, error, reload } = useLiveRequest(api, id);
  const busy = !!req && working(req);
  useEffect(() => {
    onWorking?.(id, busy);
    return () => onWorking?.(id, false);
  }, [id, busy, onWorking]);
  if (error && !req) return <ErrorBox error={error} onRetry={reload} />;
  if (!req) return <div className="embed skel" aria-busy style={{ height: 120 }} />;
  return <EmbedBody api={api} req={req} user={user} deployTracked={deployTracked} onThread={onThread} threaded={threaded} />;
}

/** threaded: the channel draws a reply footer under the card, so the card does not need its own "스레드 보기" */
function EmbedBody({ api, req, user, deployTracked = true, onThread, threaded }: { api: Api; req: Request; user: User; deployTracked?: boolean; onThread?: () => void; threaded?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const dev = isDev(user);
  const p = reqProgress(req, user, deployTracked);
  const summary = req.spec ? (dev ? req.spec.summary.forDeveloper : req.spec.summary.forRequester) : dev ? req.understood?.forDeveloper : req.understood?.forRequester;
  const proceed = async () => {
    setBusy(true);
    try {
      await api.decide(req.id, { decision: "proceed", by: user.name });
      toast("진행해요. 에이전트가 시작해요", "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  const flagged = req.spec?.needsCheck?.length ?? 0;
  return (
    <article className="embed slide-in" style={phaseBar(p)} aria-label={`요청: ${req.title}`}>
      <div className="embed-head">
        <b className="t-title">{req.title}</b>
        {req.type ? <span className="t-meta">{TYPE_KO[req.type]}</span> : null}
      </div>
      <PhaseTrack p={p} />
      <dl className="embed-fields">
        <div>
          <dt>상태</dt>
          <dd>{reqHeadline(req, user)}</dd>
        </div>
        {dev && req.status === "proposed" && req.proposal ? (
          <div>
            <dt>제안</dt>
            <dd>
              {req.proposal.summary}
              {flagged ? <span className="st warn"> 확인 필요 {flagged}</span> : null}
            </dd>
          </div>
        ) : summary && !working(req) ? (
          <div>
            <dt>{dev ? "요약" : "이해한 것"}</dt>
            <dd className={dev ? "" : "t-read"}>{summary}</dd>
          </div>
        ) : null}
        {req.status === "declined" && req.decline ? (
          <div>
            <dt>이유</dt>
            <dd className={dev ? "" : "t-read"}>{req.decline.forRequester}</dd>
          </div>
        ) : null}
      </dl>
      {working(req) ? <Working text={req.status === "spec_ready" ? "저장소 읽는 중" : "정리하는 중"} /> : null}
      {req.status === "clarifying" && !dev ? <Clarify api={api} req={req} user={user} /> : null}
      {checkNow(req) ? <CheckPanel api={api} req={req} user={user} compact /> : null}
      {dev && req.status === "proposed" ? (
        <div className="row-btns">
          <button className="btn m" disabled={busy} onClick={proceed}>
            {busy ? <Spinner size={12} /> : null}진행
          </button>
          <button className="btn q" onClick={onThread}>
            제안 자세히
          </button>
        </div>
      ) : null}
      {req.status === "code_review" && req.runIds.length ? <RunReview api={api} runId={req.runIds.at(-1)!} user={user} /> : null}
      <div className="embed-foot">
        {req.attachments.map((a) => (
          <LinkChip key={a.url} url={a.url} />
        ))}
        <span className="grow" />
        {threaded ? null : onThread ? (
          <button className="msg-link" onClick={onThread}>
            스레드 보기 <IconChevron size={12} />
          </button>
        ) : (
          <a className="msg-link" href={`#/requests/${req.id}`}>
            자세히 <IconChevron size={12} />
          </a>
        )}
      </div>
    </article>
  );
}

/** 예전 이름: 채널 카드 = embed */
export const RequestCard = RequestEmbed;

// ---------------------------------------------------------------------------------------------- request page

export function RequestPage({ api, id, user, deployTracked }: { api: Api; id: string; user: User; deployTracked?: boolean }) {
  const { req, error, reload } = useLiveRequest(api, id);
  const now = Date.now();
  return (
    <div className="turn-page">
      <div className="rq-layout">
        <div className="rq-main">
          <a className="msg-link" href="#/mine" onClick={(e) => { if (window.history.length > 1) { e.preventDefault(); window.history.back(); } }}>
            뒤로
          </a>
          {error && !req ? <ErrorBox error={`불러오기 실패 · ${error}`} onRetry={reload} /> : null}
          {!req && !error ? <div className="skel card-skel" /> : null}
          {req ? (
            <article className="mine-card">
              <RequestView api={api} req={req} user={user} deployTracked={deployTracked} now={now} />
            </article>
          ) : null}
        </div>
        {req ? (
          <aside className="rq-ctx" aria-label="맥락">
            <section>
              <h3 className="sec-t">요청</h3>
              <dl className="ctx-dl">
                <dt>요청자</dt>
                <dd>
                  <Avatar name={req.requester} size={20} src={req.requesterAvatar} /> {req.requester}
                  {req.requesterTitle ? <span className="title-chip">{req.requesterTitle}</span> : null}
                </dd>
                <dt>채널</dt>
                <dd>
                  <a href={`#/chat/${req.channel}`}>#{req.channel}</a>
                </dd>
                {req.reviewer ? (
                  <>
                    <dt>확인</dt>
                    <dd>{req.reviewer}</dd>
                  </>
                ) : null}
                {req.assignee ? (
                  <>
                    <dt>담당</dt>
                    <dd>{req.assignee}</dd>
                  </>
                ) : null}
                <dt>받은 때</dt>
                <dd className="t-meta">{relTime(req.createdAt, now)}</dd>
              </dl>
            </section>
            <section>
              <h3 className="sec-t">결정 기록</h3>
              <DecisionTimeline req={req} now={now} />
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- 내 차례, 내 요청

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
          <span>#{req.channel}</span>
          <Avatar name={req.requester} size={16} src={req.requesterAvatar} />
          <span>{req.requester}</span>
          <span>{relTime(req.createdAt, now)}</span>
        </div>
        {p ? (
          <div className="mc-rec">
            <span>{p.summary}</span>
            <span className="t-meta mono">
              {p.files.length ? `파일 ${p.files.length}, ` : ""}
              {p.estimate.minutes ? `${p.estimate.minutes}분` : ""}
              {p.estimate.costUsd != null ? `, ${fmtCost(p.estimate.costUsd)} (추정)` : ""}
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
        <a className="btn q" href={`#${href}`}>
          제안 보기
        </a>
      </div>
    </article>
  );
}

/** 내 요청 카드 (요청자) */
export function RequestMineCard({ api, req, user, now, note, deployTracked = true }: { api: Api; req: Request; user: User; now: number; note?: string; deployTracked?: boolean }) {
  const p = reqProgress(req, user, deployTracked);
  const summary = req.spec?.summary.forRequester ?? req.understood?.forRequester;
  return (
    <article className="mine-card embed" style={phaseBar(p)}>
      <div className="mine-top">
        <h2>{req.title}</h2>
        <span className="t-meta">
          #{req.channel}, {relTime(req.createdAt, now)}
        </span>
      </div>
      <PhaseTrack p={p} />
      <p className={`mine-status ${p.mine ? "turn" : ""}`}>{reqHeadline(req, user)}</p>
      {summary && req.status !== "declined" ? (
        <AiText read original={req.text}>
          {summary}
        </AiText>
      ) : null}
      {working(req) ? <Working /> : null}
      {req.status === "clarifying" ? <Clarify api={api} req={req} user={user} /> : null}
      {checkNow(req) ? <CheckPanel api={api} req={req} user={user} compact /> : null}
      {req.status === "declined" ? <Declined req={req} dev={false} /> : null}
      {note ? (
        <blockquote className="mine-note">
          <span className="lab">결과 설명</span>
          {note}
        </blockquote>
      ) : null}
      <div className="embed-foot">
        <a className="msg-link" href={`#/chat/${req.channel}`}>채널에서 보기</a>
        <span className="grow" />
        <a className="msg-link" href={`#/requests/${req.id}`}>
          자세히 <IconChevron size={12} />
        </a>
      </div>
    </article>
  );
}
