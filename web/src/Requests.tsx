import { useCallback, useEffect, useState } from "react";
import type { Api, Run } from "./api";
import { IconChevron } from "./icons";
import { Empty, ErrorBox, Spinner, StatusDot } from "./ui";
import { RUN_STATE_KO, TEAM_KO, TEMPLATE_KO, fmtCost, isActive, relTime, runCounts, runState, useNow, type RunState, type User } from "./util";

const ORDER: RunState[] = ["pending", "active", "approved", "rejected", "failed"];

export function Requests({ api, go, user }: { api: Api; go: (p: string) => void; user: User }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(false);

  const load = useCallback(() => {
    api
      .runs()
      .then((r) => {
        setRuns(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);
  const anyActive = !!runs?.some((r) => r.agents.some(isActive) || r.review?.status === "none");
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [anyActive, load]);
  const now = useNow(30_000);

  const shown = (runs ?? []).filter((r) => !mine || r.requester === user.name);
  const groups = ORDER.map((st) => ({ st, items: shown.filter((r) => runState(r) === st) })).filter((g) => g.items.length);

  return (
    <div className="page">
      <div className="page-head row">
        <h1>요청</h1>
        <div className="seg">
          <button className={!mine ? "on" : ""} onClick={() => setMine(false)}>
            전체
          </button>
          <button className={mine ? "on" : ""} onClick={() => setMine(true)}>
            내 요청
          </button>
        </div>
      </div>
      {error && !runs ? <ErrorBox error={`서버 연결 실패 · ${error}`} onRetry={load} /> : null}
      {!runs && !error ? (
        <div className="loading">
          <Spinner size={16} /> 불러오는 중
        </div>
      ) : null}
      {runs && !shown.length ? (
        <Empty title="요청 없음">@willnew 로 시작</Empty>
      ) : null}
      {groups.map((g) => (
        <section key={g.st} className="req-group">
          <h2 className={`req-h s-${g.st}`}>
            <span className="req-dot" />
            {RUN_STATE_KO[g.st]}
            <span className="req-n">{g.items.length}</span>
          </h2>
          <div className="reqs">
            {g.items.map((r) => (
              <ReqRow key={r.id} run={r} now={now} onOpen={() => go(`/requests/${r.id}`)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ReqRow({ run, now, onOpen }: { run: Run; now: number; onOpen: () => void }) {
  const c = runCounts(run);
  const cost = run.agents.reduce((s, a) => s + (a.usage?.costUsd ?? 0), 0) + (run.triage?.costUsd ?? 0);
  const retried = run.agents.filter((a) => (a.attempt ?? 1) > 1).length;
  return (
    <button className="req" onClick={onOpen}>
      <div className="req-main">
        <div className="req-title">{run.triage?.title ?? run.title}</div>
        <div className="req-meta">
          <span className="strong">{run.requester}</span>
          <span>{TEAM_KO[run.team] ?? run.team}</span>
          <span className="chip-soft">{TEMPLATE_KO[run.template] ?? run.template}</span>
          {run.channel ? <span>#{run.channel}</span> : null}
          <span className="dim">{relTime(run.createdAt, now)}</span>
        </div>
      </div>
      <div className="req-side">
        <span className="req-agents">
          {run.agents.map((a) => (
            <StatusDot key={a.id} status={a.status} check={a.check?.status} />
          ))}
        </span>
        <span className="req-result mono">
          <span className={c.passed ? "ok-t" : "dim"}>
            통과 {c.passed}/{c.total}
          </span>
          {retried ? <span className="accent-t">자가 수정 {retried}</span> : null}
          {cost > 0 ? <span className="dim">{fmtCost(cost)}</span> : null}
        </span>
        <IconChevron size={14} className="req-chev" />
      </div>
      {run.review?.comment ? <div className="req-comment">“{run.review.comment}” — {run.review.reviewer}</div> : null}
    </button>
  );
}
