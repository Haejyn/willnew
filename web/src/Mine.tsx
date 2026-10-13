/** 내 요청 — 맡긴 일이 어디까지 갔는지 쉬운 말로. 코드, 터미널, 에이전트 로그는 여기 없다. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api, Channel, Run } from "./api";
import { pickReviewer } from "../../src/server/handoff";
import { IconCheck, IconPlus } from "./icons";
import { Moon, runPhase, type Phase } from "./moon";
import { ErrorBox } from "./ui";
import { fmtDuration, isActive, relTime, runElapsed, useNow, type User } from "./util";

type Step = { id: string; label: string };
const STEPS: Step[] = [
  { id: "got", label: "접수" },
  { id: "fix", label: "고치는 중" },
  { id: "test", label: "테스트 확인" },
  { id: "review", label: "개발자 검토 대기" },
  { id: "end", label: "반영됨" },
];

/** 지금 어느 단계인지(0~4). 반영 안 함은 마지막 칸이 "반영 안 함" 으로 바뀐다. */
export function mineStage(phase: Phase): { at: number; stopped?: "rejected" | "empty" } {
  switch (phase) {
    case "new":
    case "plan":
      return { at: 0 };
    case "run":
    case "retry":
      return { at: 1 };
    case "check":
      return { at: 2 };
    case "turn":
      return { at: 3 };
    case "merged":
      return { at: 4 };
    case "rejected":
      return { at: 4, stopped: "rejected" };
    default:
      return { at: 2, stopped: "empty" };
  }
}

const title = (r: Run) => r.triage?.title ?? r.title;

export function Mine({ api, user, runs, error, reload, onNew, me }: { api: Api; user: User; runs: Run[] | null; error: string | null; reload: () => void; onNew: () => void; me?: ReactNode }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  useEffect(() => {
    api.channels().then(setChannels).catch(() => undefined);
  }, [api]);
  const mine = useMemo(() => (runs ?? []).filter((r) => r.requester === user.name).sort((a, b) => b.createdAt - a.createdAt), [runs, user.name]);
  const now = useNow(1000, mine.some((r) => r.agents.some(isActive)));

  return (
    <div className="turn-page">
      <div className="turn-col mine">
        <div className="turn-head">
          <h1>
            내 요청 {mine.length ? <span className="mono n">{mine.length}</span> : null}
          </h1>
          <span className="only-phone">{me}</span>
        </div>

        {error && !runs ? <ErrorBox error={`불러오기 실패 · ${error}`} onRetry={reload} /> : null}
        {!runs && !error ? (
          <div className="mcards" aria-busy>
            <div className="skel card-skel" />
            <div className="skel card-skel" />
          </div>
        ) : null}

        {runs && !mine.length ? (
          <section className="turn-empty">
            <Moon phase="new" size={64} />
            <p>맡긴 일이 아직 없어요</p>
            <button className="btn" onClick={onNew}>
              <IconPlus size={15} /> 맡기기
            </button>
          </section>
        ) : null}

        {mine.length ? (
          <div className="mcards">
            {mine.map((r) => (
              <MineCard key={r.id} run={r} channel={channels.find((c) => c.id === r.channel)} now={now} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MineCard({ run, channel, now }: { run: Run; channel?: Channel; now: number }) {
  const { phase } = runPhase(run, now);
  const { at, stopped } = mineStage(phase);
  const reviewer = pickReviewer(channel, run.requester);
  const winner = run.agents.find((a) => a.id === run.review.agentId) ?? run.agents.find((a) => a.userNote);
  const note = winner?.userNote;
  const live = run.agents.some(isActive);

  const label = (s: Step, i: number) => {
    if (i === 3) return reviewer ? `${s.label} (${reviewer})` : s.label;
    if (i === 4 && stopped === "rejected") return "반영 안 함";
    if (i === 2 && stopped === "empty") return "테스트 통과 못 함";
    return s.label;
  };
  const complete = phase === "merged";
  const headline =
    stopped === "rejected" ? "반영 안 함" : stopped === "empty" ? "테스트를 통과하지 못했어요" : complete ? "반영됨" : phase === "turn" ? `개발자 검토 대기 중${reviewer ? ` (${reviewer})` : ""}` : phase === "run" || phase === "retry" ? "고치는 중" : phase === "check" ? "테스트 확인 중" : "접수했어요";
  const detail =
    stopped === "rejected"
      ? run.review.comment
        ? `사유: ${run.review.comment}`
        : "개발자가 반영하지 않기로 했어요"
      : stopped === "empty"
        ? "에이전트가 테스트를 통과하지 못했어요. 개발자가 다시 확인해요"
        : phase === "merged"
          ? `${run.baseBranch}에 합쳐졌어요. 배포는 개발팀에 따로 확인해 주세요`
          : phase === "turn"
            ? reviewer
              ? `${reviewer} 님이 보고 있어요`
              : "개발자가 보고 있어요"
            : live
              ? `${fmtDuration(runElapsed(run, now))} 째 진행 중`
              : "";

  return (
    <article className={`mine-card ${stopped ? "stopped" : ""} ${complete ? "complete" : ""}`}>
      <div className={`mine-status s-${stopped ?? phase}`}>{headline}</div>
      <div className="mine-top">
        <h2>{title(run)}</h2>
        <span className="dim small">
          {run.channel ? `#${run.channel} · ` : ""}
          {relTime(run.createdAt, now)}
        </span>
      </div>
      <ol className="mine-track" aria-label="진행 단계">
        {STEPS.map((s, i) => {
          const state = complete || i < at ? "done" : i === at ? "now" : "todo";
          return (
            <li key={s.id} className={`mine-step ${state} ${state === "now" && stopped ? "stop" : ""}`} aria-current={state === "now" ? "step" : undefined}>
              <span className="mark">{state === "now" ? <Moon phase={phase} size={24} /> : state === "done" ? <IconCheck size={14} /> : null}</span>
              <span className="lab">{label(s, i)}</span>
            </li>
          );
        })}
      </ol>
      {detail ? <p className="mine-detail">{detail}</p> : null}
      {note ? (
        <blockquote className="mine-note">
          <span className="lab">결과 설명</span>
          {note}
        </blockquote>
      ) : null}
      {run.channel ? (
        <a className="msg-link" href={`#/chat/${run.channel}`}>
          채널에서 보기
        </a>
      ) : null}
    </article>
  );
}
