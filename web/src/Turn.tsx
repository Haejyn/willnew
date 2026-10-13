/** 내 차례 — 첫 화면. 보름달이 뜬 일만 카드로 올라오고, 나머지는 한 줄씩. */
import { useMemo, useState, type ReactNode } from "react";
import type { AgentInfo, Api, Run } from "./api";
import { Compose } from "./Compose";
import { useDecide } from "./Decision";
import { AgentMark, IconPlus } from "./icons";
import { Moon, PHASE_FILL, isDone, runPhase, type Phase } from "./moon";
import { ErrorBox, Spinner } from "./ui";
import { adapterName, fmtDuration, isActive, relTime, runElapsed, suggestWinner, testSummary, useNow, winnerReason, type User } from "./util";

const EXAMPLES = [
  "어제 배포 이후로 parseDuration 테스트 7개 다 깨짐. 1h30m 같은 거 못 읽는 듯",
  "settle_daily 중복 제거 로직 세 군데 복붙돼있어요 하나로 합쳐주세요 동작은 그대로",
  "README 옵션이 예전꺼라 신입분들이 계속 물어봐요. 지금 CLI 기준으로 고쳐주실 수 있나요?",
];

const title = (r: Run) => r.triage?.title ?? r.title;
const doneAt = (r: Run) => r.review.at ?? r.createdAt;

export function Turn({ api, user, agents, runs, error, reload, go, onNew, me }: { api: Api; user: User; agents: AgentInfo[] | null; runs: Run[] | null; error: string | null; reload: () => void; go: (p: string) => void; onNew: () => void; me?: ReactNode }) {
  const now = useNow(1000, !!runs?.some((r) => r.agents.some(isActive)));
  const [example, setExample] = useState("");
  const rows = useMemo(() => (runs ?? []).map((r) => ({ run: r, ...runPhase(r, now) })), [runs, now]);
  const turn = rows.filter((x) => x.phase === "turn").sort((a, b) => b.run.createdAt - a.run.createdAt);
  const rising = rows.filter((x) => !isDone(x.phase) && x.phase !== "turn");
  const done = rows.filter((x) => isDone(x.phase)).sort((a, b) => doneAt(b.run) - doneAt(a.run));
  const fullest: Phase = rising.reduce<Phase>((best, x) => (PHASE_FILL[x.phase] > PHASE_FILL[best] ? x.phase : best), "new");

  return (
    <div className="turn-page">
      <div className="turn-col">
        <div className="turn-head">
          <h1>
            내 차례 {turn.length ? <span className="mono n">{turn.length}</span> : null}
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

        {runs && !runs.length ? (
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

        {runs?.length && !turn.length ? (
          <section className="turn-empty">
            <Moon phase={fullest} size={64} />
            <p>보름달이 뜨면 여기로 올라와요</p>
            <button className="btn" onClick={onNew}>
              <IconPlus size={15} /> 맡기기
            </button>
          </section>
        ) : null}

        {turn.length ? (
          <div className="mcards">
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
            {winner.diff.testsTouched?.length ? <span className="warn-chip">테스트 파일 고침</span> : null}
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
