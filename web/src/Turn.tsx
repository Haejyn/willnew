/** 내 차례. 첫 화면. 확인할 제안이 맨 위, 그 아래 보름달이 뜬 결과가 카드로, 나머지는 한 줄씩. */
import { useMemo, useState, type ReactNode } from "react";
import type { AgentInfo, Api, Request, Run } from "./api";
import { Compose } from "./Compose";
import { TestChips, useDecide } from "./Decision";
import { AgentMark, IconPlus } from "./icons";
import { Moon, PHASE_FILL, isDone, runPhase, type Phase } from "./moon";
import { ProposalTurnCard } from "./Request";
import { Avatar, ErrorBox, Spinner } from "./ui";
import { adapterName, fmtDuration, isActive, relTime, runElapsed, suggestWinner, testSummary, useNow, winnerReason, type User } from "./util";

const EXAMPLES = [
  "어제 배포 이후로 parseDuration 테스트 7개 다 깨짐. 1h30m 같은 거 못 읽는 듯",
  "settle_daily 중복 제거 로직 세 군데 복붙돼있어요 하나로 합쳐주세요 동작은 그대로",
  "README 옵션이 예전꺼라 신입분들이 계속 물어봐요. 지금 CLI 기준으로 고쳐주실 수 있나요?",
];

const title = (r: Run) => r.triage?.title ?? r.title;
const doneAt = (r: Run) => r.review.at ?? r.createdAt;

export function Turn({ api, user, agents, runs, requests, error, reload, go, onNew, me }: { api: Api; user: User; agents: AgentInfo[] | null; runs: Run[] | null; requests?: Request[] | null; error: string | null; reload: () => void; go: (p: string) => void; onNew: () => void; me?: ReactNode }) {
  const now = useNow(1000, !!runs?.some((r) => r.agents.some(isActive)));
  const [example, setExample] = useState("");
  // 화면 수정 결과는 요청자가 먼저 본다(요청자 확인). 그동안은 내 차례가 아니라 차오르는 중
  const checking = useMemo(() => new Set((requests ?? []).filter((r) => r.status === "preview").flatMap((r) => r.runIds)), [requests]);
  const rows = useMemo(() => (runs ?? []).map((r) => {
    const p = runPhase(r, now);
    return checking.has(r.id) && p.phase === "turn" ? { run: r, ...p, phase: "check" as Phase, label: "요청자 확인 중" } : { run: r, ...p };
  }), [runs, now, checking]);
  const turn = rows.filter((x) => x.phase === "turn").sort((a, b) => b.run.createdAt - a.run.createdAt);
  const rising = rows.filter((x) => !isDone(x.phase) && x.phase !== "turn");
  const done = rows.filter((x) => isDone(x.phase)).sort((a, b) => doneAt(b.run) - doneAt(a.run));
  const proposals = (requests ?? []).filter((r) => r.status === "proposed" && (!r.reviewer || r.reviewer === user.name)).sort((a, b) => a.updatedAt - b.updatedAt);
  const waiting = turn.length + proposals.length;
  const fullest: Phase = rising.reduce<Phase>((best, x) => (PHASE_FILL[x.phase] > PHASE_FILL[best] ? x.phase : best), "new");

  return (
    <div className="turn-page">
      <div className="turn-col">
        <div className="turn-head">
          <h1>
            내 차례 {waiting ? <span className="mono n">{waiting}</span> : null}
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

        {runs && !runs.length && !proposals.length ? (
          <section className="turn-empty first">
            <Moon phase="new" size={64} />
            <p>한 줄로 맡겨 보세요</p>
            <Compose key={example} inline api={api} user={user} agents={agents} runs={runs} initialText={example} onClose={() => undefined} go={go} />
            <div className="examples">
              {EXAMPLES.map((e) => (
                <button key={e} className="chip" onClick={() => setExample(e)}>
                  {e}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {proposals.length ? (
          <section className="mcards" aria-label="확인할 제안">
            <h2 className="sec-h">확인할 제안</h2>
            {proposals.map((r) => (
              <ProposalTurnCard key={r.id} api={api} req={r} user={user} now={now} go={go} />
            ))}
          </section>
        ) : null}

        {runs?.length && !waiting ? (
          <section className="turn-empty">
            <Moon phase={fullest} size={64} />
            <p>보름달이 뜨면 여기로 올라와요</p>
            <button className="btn" onClick={onNew}>
              <IconPlus size={15} /> 맡기기
            </button>
          </section>
        ) : null}

        {turn.length ? (
          <div className="mcards" aria-label="승인할 결과">
            {proposals.length ? <h2 className="sec-h">승인할 결과</h2> : null}
            {turn.map((x) => (
              <MoonCard key={x.run.id} api={api} user={user} run={x.run} now={now} go={go} />
            ))}
          </div>
        ) : null}

        {rising.length ? (
          <section className="rows">
            <h2>차오르는 중</h2>
            {rising.map((x) => (
              <Row key={x.run.id} run={x.run} phase={x.phase} text={runElapsed(x.run, now) >= 1000 ? `${x.label} · ${fmtDuration(runElapsed(x.run, now))}` : x.label} />
            ))}
          </section>
        ) : null}

        {done.length ? (
          <section className="rows dim">
            <h2>
              최근 끝남 <a href="#/runs">모두 보기</a>
            </h2>
            {done.slice(0, 5).map((x) => (
              <Row key={x.run.id} run={x.run} phase={x.phase} text={`${x.label} · ${relTime(doneAt(x.run), now)}`} />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Row({ run, phase, text }: { run: Run; phase: Phase; text: string }) {
  return (
    <a className="trow" href={`#/runs/${run.id}`}>
      <Moon phase={phase} size={16} />
      <span className="trow-title">{title(run)}</span>
      <span className="trow-st">{text}</span>
    </a>
  );
}

function MoonCard({ api, user, run, now, go }: { api: Api; user: User; run: Run; now: number; go: (p: string) => void }) {
  const { busy, approve } = useDecide(api, run, user);
  const winner = run.agents.find((a) => a.id === suggestWinner(run));
  const test = winner ? testSummary(winner) : null;
  const review = `/runs/${run.id}/review`;
  return (
    <article className="mcard" onClick={() => go(review)}>
      <Moon phase="turn" size={28} />
      <div className="mc-main">
        <h2>
          <a href={`#${review}`} onClick={(e) => e.stopPropagation()}>
            {title(run)}
          </a>
        </h2>
        <div className="mc-meta">
          {run.channel ? `#${run.channel} · ` : ""}
          <Avatar name={run.requester} size={18} src={run.requesterAvatar} />
          {run.requester} · {relTime(run.createdAt, now)}
        </div>
        {winner ? (
          <div className="mc-rec" title={winnerReason(run, winner.id)}>
            <AgentMark adapter={winner.adapter} size={16} />
            <span>
              {winner.label || adapterName(winner.adapter)}{run.agents.length > 1 ? " 추천" : ""}
            </span>
            <span className="mono">
              {fmtDuration(winner.durationMs)} · +{winner.diff.insertions} −{winner.diff.deletions}
              {test ? ` · 테스트 ${test}` : ""}
            </span>
            <TestChips diff={winner.diff} />
            {winner.check.status === "skipped" ? <span className="st warn">검증 없음</span> : null}
          </div>
        ) : null}
      </div>
      <div className="mc-act" onClick={(e) => e.stopPropagation()}>
        {/* 테스트 파일을 고친 결과는 바로 병합하지 않고 검토를 거친다 */}
        {winner && !winner.diff.testsTouched?.length ? (
          <>
            <button className="btn m" disabled={busy} onClick={() => approve(winner.id)}>
              {busy ? <Spinner size={12} /> : null}승인
            </button>
            <a className="btn" href={`#${review}`}>
              검토
            </a>
          </>
        ) : (
          <a className="btn m" href={`#${review}`}>
            검토하고 승인
          </a>
        )}
      </div>
    </article>
  );
}
