/** 내 요청. 맡긴 일이 어디까지 갔는지 쉬운 말로. 코드, 터미널, 에이전트 로그는 여기 없다. 요청 흐름으로 들어온 것은 요청 카드로, 바로 맡긴 일은 예전 카드로. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api, Channel, Request, Run, ServerConfig } from "./api";
import { pickReviewer } from "../../src/server/handoff";
import { IconCheck, IconPlus } from "./icons";
import { Moon, runPhase, type Phase } from "./moon";
import { RequestMineCard } from "./Request";
import { Avatar, ErrorBox } from "./ui";
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

export function Mine({ api, user, config, runs, requests, error, reload, onNew, me }: { api: Api; user: User; config: ServerConfig | null; runs: Run[] | null; requests?: Request[] | null; error: string | null; reload: () => void; onNew: () => void; me?: ReactNode }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  useEffect(() => {
    api.channels().then(setChannels).catch(() => undefined);
  }, [api]);
  // 요청에 딸린 run 은 요청 카드 안에서 보인다
  const mine = useMemo(() => (runs ?? []).filter((r) => r.requester === user.name && !r.requestId).sort((a, b) => b.createdAt - a.createdAt), [runs, user.name]);
  const myReqs = useMemo(() => (requests ?? []).filter((r) => r.requester === user.name), [requests, user.name]);
  const items = useMemo(
    () => [...myReqs.map((r) => ({ at: r.createdAt, req: r as Request, run: undefined as Run | undefined })), ...mine.map((r) => ({ at: r.createdAt, req: undefined as Request | undefined, run: r as Run }))].sort((a, b) => b.at - a.at),
    [myReqs, mine],
  );
  const now = useNow(1000, mine.some((r) => r.agents.some(isActive)));
  const noteOf = (req: Request) => {
    const run = (runs ?? []).find((r) => r.id === req.runIds.at(-1));
    if (!run || run.review.status !== "approved") return undefined;
    return (run.agents.find((a) => a.id === run.review.agentId) ?? run.agents.find((a) => a.userNote))?.userNote;
  };

  return (
    <div className="turn-page">
      <div className="turn-col mine">
        <div className="turn-head">
          <h1>
            내 요청 {items.length ? <span className="mono n">{items.length}</span> : null}
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

        {runs && !items.length ? (
          <section className="turn-empty">
            <Moon phase="new" size={64} />
            <p>맡긴 일이 아직 없어요</p>
            <button className="btn" onClick={onNew}>
              <IconPlus size={15} /> 맡기기
            </button>
          </section>
        ) : null}

        {items.length ? (
          <div className="mcards">
            {items.map((x) =>
              x.req ? (
                <RequestMineCard key={x.req.id} api={api} req={x.req} user={user} now={now} note={noteOf(x.req)} deployTracked={config?.deploy !== false} />
              ) : x.run ? (
                <MineCard key={x.run.id} run={x.run} channel={channels.find((c) => c.id === x.run!.channel)} config={config} now={now} />
              ) : null,
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MineCard({ run, channel, config, now }: { run: Run; channel?: Channel; config: ServerConfig | null; now: number }) {
  const raw = runPhase(run, now).phase;
  const ship = run.ship;
  const approved = run.review.status === "approved";
  const st = approved ? ship?.stage : undefined;
  // 승인 뒤 PR · CI · 배포가 도는 중인지, 멈췄는지
  const inFlight = st === "pr" || st === "ci" || st === "deploying" || (st === "merged" && !!ship?.env);
  const shipFailed = st === "ci_failed" || st === "deploy_failed";
  const deployTracked = !!ship?.env || !!config?.deploy;
  const complete = approved && !inFlight && !shipFailed;
  const phase: Phase = inFlight ? "check" : shipFailed ? "rejected" : raw;
  const stage = approved ? { at: 4, stopped: shipFailed ? ("failed" as const) : undefined } : mineStage(raw);
  const { at, stopped } = stage as { at: number; stopped?: "rejected" | "empty" | "failed" };
  const reviewer = pickReviewer(channel, run.requester);
  const winner = run.agents.find((a) => a.id === run.review.agentId) ?? run.agents.find((a) => a.userNote);
  const note = winner?.userNote;
  const live = run.agents.some(isActive);
  const env = ship?.env ?? config?.deployEnv ?? "production";

  const label = (s: Step, i: number) => {
    if (i === 3) {
      const text = at > 3 ? "개발자 승인" : s.label;
      return reviewer ? `${text} (${reviewer})` : text;
    }
    if (i === 4 && stopped === "rejected") return "반영 안 함";
    if (i === 4) return deployTracked ? "배포됨" : "반영됨";
    if (i === 2 && stopped === "empty") return "테스트 통과 못 함";
    return s.label;
  };
  const headline =
    stopped === "rejected"
      ? "반영 안 함"
      : stopped === "empty"
        ? "테스트를 통과하지 못했어요"
        : st === "ci_failed"
          ? "CI가 실패해서 멈췄어요"
          : st === "deploy_failed"
            ? "배포를 확인하지 못했어요"
            : st === "pr"
              ? "PR 올리는 중"
              : st === "ci"
                ? "CI 확인 중"
                : st === "merged" || st === "deploying"
                  ? "배포 중"
                  : complete
                    ? st === "deployed"
                      ? "배포됨"
                      : "반영됨"
                    : raw === "turn"
                      ? `개발자 검토 대기 중${reviewer ? ` (${reviewer})` : ""}`
                      : raw === "run" || raw === "retry"
                        ? "고치는 중"
                        : raw === "check"
                          ? "테스트 확인 중"
                          : "접수했어요";
  const detail =
    stopped === "rejected"
      ? run.review.comment
        ? `사유: ${run.review.comment}`
        : "개발자가 반영하지 않기로 했어요"
      : stopped === "empty"
        ? "에이전트가 테스트를 통과하지 못했어요. 개발자가 다시 확인해요"
        : shipFailed
          ? "개발자가 확인해요. 자동으로 다시 돌리지 않아요"
          : st === "merged" || st === "deploying"
            ? `${run.baseBranch}에 합쳐졌어요. ${env}에 올라갈 때까지 기다려요`
            : st === "pr" || st === "ci"
              ? "개발자가 승인했고, 자동 검사가 끝나면 합쳐져요"
              : st === "deployed"
                ? `${env}에 배포됐어요`
                : complete
                  ? `${run.baseBranch}에 합쳐졌어요. 배포는 개발팀에 따로 확인해 주세요`
                  : raw === "turn"
                    ? reviewer
                      ? `${reviewer} 님이 보고 있어요`
                      : "개발자가 보고 있어요"
                    : live
                      ? `${fmtDuration(runElapsed(run, now))} 째 진행 중`
                      : "";

  return (
    <article className={`mine-card ${stopped ? "stopped" : ""} ${complete ? "complete" : ""}`}>
      <div className={`mine-status s-${stopped ?? (complete ? "merged" : phase)}`}>{headline}</div>
      <div className="mine-top">
        <h2>{title(run)}</h2>
        <span className="dim small who">
          <Avatar name={run.requester} size={20} src={run.requesterAvatar} />
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
