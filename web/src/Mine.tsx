/** 내 요청. 맡긴 일이 어디까지 갔는지 쉬운 말로. 코드, 터미널, 에이전트 로그는 여기 없다. 요청 흐름으로 들어온 것은 요청 카드로, 바로 맡긴 일은 예전 카드로. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api, Channel, Request, Run, ServerConfig } from "./api";
import { pickReviewer } from "../../src/server/handoff";
import { IconChat } from "./icons";
import { Moon, runPhase } from "./moon";
import { PhaseTrack, RequestMineCard, runProgress } from "./Request";
import { ErrorBox } from "./ui";
import { fmtDuration, isActive, relTime, runElapsed, useNow, type User } from "./util";

const title = (r: Run) => r.triage?.title ?? r.title;

export function Mine({ api, user, config, runs, requests, error, reload, me }: { api: Api; user: User; config: ServerConfig | null; runs: Run[] | null; requests?: Request[] | null; error: string | null; reload: () => void; onNew?: () => void; me?: ReactNode }) {
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
            <Moon phase="new" size={48} />
            <p>아직 맡긴 일이 없어요. 채널에 @willnew 로 한 줄 남겨 보세요</p>
            <a className="btn m" href={`#/chat/${channels.find((c) => c.team === user.team)?.id ?? channels[0]?.id ?? ""}`}>
              <IconChat size={16} /> 채널로 가기
            </a>
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

function MineCard({ run, channel, now }: { run: Run; channel?: Channel; config: ServerConfig | null; now: number }) {
  const p = runProgress(run, now);
  const raw = runPhase(run, now).phase;
  const st = run.review.status === "approved" ? run.ship?.stage : undefined;
  const reviewer = pickReviewer(channel, run.requester);
  const winner = run.agents.find((a) => a.id === run.review.agentId) ?? run.agents.find((a) => a.userNote);
  const note = winner?.userNote;
  const live = run.agents.some(isActive);
  const env = run.ship?.env ?? "production";
  const headline =
    raw === "rejected" ? "반영 안 함"
    : raw === "empty" ? "테스트를 통과하지 못했어요"
    : st === "ci_failed" ? "CI가 실패해서 멈췄어요"
    : st === "deploy_failed" ? "배포를 확인하지 못했어요"
    : st === "pr" ? "PR 올리는 중"
    : st === "ci" ? "CI 확인 중"
    : st === "merged" || st === "deploying" ? "배포 중"
    : st === "deployed" ? "배포됨"
    : run.review.status === "approved" ? "반영됨"
    : raw === "turn" ? `개발자 검토 대기 중${reviewer ? ` (${reviewer})` : ""}`
    : raw === "run" || raw === "retry" ? "고치는 중"
    : raw === "check" ? "테스트 확인 중"
    : "접수했어요";
  const detail =
    raw === "rejected" ? (run.review.comment ? `사유: ${run.review.comment}` : "개발자가 반영하지 않기로 했어요")
    : raw === "empty" ? "에이전트가 테스트를 통과하지 못했어요. 개발자가 다시 확인해요"
    : st === "ci_failed" || st === "deploy_failed" ? "개발자가 확인해요. 자동으로 다시 돌리지 않아요"
    : st === "merged" || st === "deploying" ? `${run.baseBranch}에 합쳐졌어요. ${env}에 올라갈 때까지 기다려요`
    : st === "pr" || st === "ci" ? "개발자가 승인했고, 자동 검사가 끝나면 합쳐져요"
    : st === "deployed" ? `${env}에 배포됐어요`
    : run.review.status === "approved" ? `${run.baseBranch}에 합쳐졌어요. 배포는 개발팀에 따로 확인해 주세요`
    : raw === "turn" ? (reviewer ? `${reviewer} 님이 보고 있어요` : "개발자가 보고 있어요")
    : live ? `${fmtDuration(runElapsed(run, now))} 째 진행 중`
    : "";

  return (
    <article className="mine-card embed">
      <div className="mine-top">
        <h2>{title(run)}</h2>
        <span className="t-meta">
          {run.channel ? `#${run.channel}, ` : ""}
          {relTime(run.createdAt, now)}
        </span>
      </div>
      <PhaseTrack p={p} />
      <p className="mine-status">{headline}</p>
      {detail ? <p className="mine-detail">{detail}</p> : null}
      {note ? (
        <blockquote className="mine-note">
          <span className="lab">결과 설명</span>
          {note}
        </blockquote>
      ) : null}
      {run.channel ? (
        <div className="embed-foot">
          <a className="msg-link" href={`#/chat/${run.channel}`}>
            채널에서 보기
          </a>
        </div>
      ) : null}
    </article>
  );
}
