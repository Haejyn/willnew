/** 작업 공간 — 한 요청의 에이전트들을 나란히(또는 하나씩) 보고, 오른쪽에서 결정한다. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Api, Preflight, Run } from "./api";
import { AgentPane, type PaneTab } from "./AgentPane";
import { useLiveRun } from "./flow";
import { AgentMark, IconBell, IconBranch, IconCheck, IconCheckCircle, IconHistory, IconMore, IconStop, IconTrash, IconXCircle, Star } from "./icons";
import { Avatar, Empty, ErrorBox, Kbd, Modal, Rail, Spinner, Tag, agentState, useToast } from "./ui";
import { TEMPLATE_KO, fmtCost, fmtDuration, isActive, relTime, runElapsed, suggestWinner, useNow, winnerReason, type User } from "./util";

export function Workspace({
  api,
  id,
  user,
  go,
  previewCommand,
  watched,
  onWatch,
  initialAgent,
  initialTab,
}: {
  api: Api;
  id: string;
  user: User;
  go: (p: string) => void;
  previewCommand: string;
  watched: boolean;
  onWatch: () => void;
  initialAgent?: string;
  initialTab?: PaneTab;
}) {
  const { run, error, reload } = useLiveRun(api, id);
  const active = !!run?.agents.some(isActive);
  const now = useNow(1000, active);
  const [view, setView] = useState<"split" | "single">(() => (window.innerWidth < 1100 ? "single" : "split"));
  const [focus, setFocus] = useState(0);
  const [tabs, setTabs] = useState<Record<string, PaneTab>>({});
  const inputs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useEffect(() => {
    if (!run || !initialAgent) return;
    const i = run.agents.findIndex((a) => a.id === initialAgent);
    if (i >= 0) {
      setFocus(i);
      if (initialTab) setTabs((t) => ({ ...t, [initialAgent]: initialTab }));
    }
  }, [run?.id, initialAgent, initialTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘1 · ⌘2 … move between agents; ⌘↵ in the steer box is handled by the box itself
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !/^[1-9]$/.test(e.key) || !run) return;
      const i = Number(e.key) - 1;
      if (i >= run.agents.length) return;
      e.preventDefault();
      setFocus(i);
      setTimeout(() => inputs.current[i]?.focus(), 0);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [run]);

  if (error && !run) return <div className="page"><ErrorBox error={`불러오기 실패 · ${error}`} onRetry={reload} /></div>;
  if (!run)
    return (
      <div className="page loading">
        <Spinner size={16} /> 불러오는 중
      </div>
    );

  const shown = view === "single" ? run.agents.filter((_, i) => i === Math.min(focus, run.agents.length - 1)) : run.agents;

  return (
    <div className="ws">
      <main className="ws-main">
        <RunHeader api={api} run={run} now={now} view={view} setView={setView} go={go} />
        {view === "single" && run.agents.length > 1 ? (
          <div className="agent-switch" role="tablist" aria-label="에이전트">
            {run.agents.map((a, i) => {
              const st = agentState(a, run.maxAttempts);
              return (
                <button key={a.id} role="tab" aria-selected={i === focus} className={i === focus ? "on" : ""} onClick={() => setFocus(i)}>
                  <AgentMark adapter={a.adapter} size={16} />
                  {a.label}
                  <Tag tone={st.tone}>{st.text}</Tag>
                  <Kbd>⌘{i + 1}</Kbd>
                </button>
              );
            })}
          </div>
        ) : null}
        {!run.agents.length ? (
          <div className="panes">
            <Empty title={run.triage ? "에이전트를 준비하는 중이에요" : "계획 에이전트가 요청을 읽는 중이에요"}>
              <Spinner size={14} />
            </Empty>
          </div>
        ) : (
          <div className={`panes n${shown.length}`}>
            {shown.map((a) => {
              const i = run.agents.indexOf(a);
              return (
                <AgentPane
                  key={a.id}
                  api={api}
                  run={run}
                  agent={a}
                  now={now}
                  user={user}
                  tab={tabs[a.id] ?? "log"}
                  onTab={(t) => setTabs((s) => ({ ...s, [a.id]: t }))}
                  focused={i === focus}
                  onFocus={() => setFocus(i)}
                  previewCommand={previewCommand}
                  inputRef={(el) => (inputs.current[i] = el)}
                />
              );
            })}
          </div>
        )}
      </main>
      <Decision api={api} run={run} go={go} watched={watched} onWatch={onWatch} />
    </div>
  );
}

function RunHeader({ api, run, now, view, setView, go }: { api: Api; run: Run; now: number; view: "split" | "single"; setView: (v: "split" | "single") => void; go: (p: string) => void }) {
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const active = run.agents.filter(isActive);
  const cost = run.agents.reduce((s, a) => s + (a.usage.costUsd ?? 0), 0) + (run.triage?.costUsd ?? 0);
  return (
    <header className="ws-head">
      <div className="ws-head-row">
        <div className="ws-title">
          <div className="ws-meta">
            {run.channel ? <a href={`#/chat/${run.channel}`}>#{run.channel}</a> : null}
            <span>·</span>
            <Avatar name={run.requester} size={18} />
            <span>
              {run.requester} 요청 · {relTime(run.createdAt, now)}
            </span>
          </div>
          <h1>{run.triage?.title ?? run.title}</h1>
          <div className="tags">
            <Tag>{TEMPLATE_KO[run.template] ?? run.template}</Tag>
            <Tag mono>
              <IconBranch size={13} />
              {run.baseBranch} @{run.baseRef.slice(0, 7)}
            </Tag>
            {run.checkCmd ? <Tag mono>{run.checkCmd}</Tag> : null}
            <Tag mono>
              {fmtDuration(runElapsed(run, now))} · {fmtCost(cost)}
            </Tag>
          </div>
        </div>
        <div className="ws-tools">
          <div className="seg" role="tablist" aria-label="보기">
            <button role="tab" aria-selected={view === "split"} className={view === "split" ? "on" : ""} onClick={() => setView("split")}>
              나란히
            </button>
            <button role="tab" aria-selected={view === "single"} className={view === "single" ? "on" : ""} onClick={() => setView("single")}>
              하나씩
            </button>
          </div>
          {active.length ? (
            <button className="ib" aria-label="모두 중지" title="모두 중지" onClick={() => setConfirmStop(true)}>
              <IconStop size={16} />
            </button>
          ) : null}
          <div className="menu-wrap">
            <button className="ib" aria-label="더 보기" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <IconMore size={16} />
            </button>
            {menu ? (
              <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <button role="menuitem" onClick={() => go(`/runs/${run.id}/review`)}>
                  <IconCheck size={14} /> 검토 화면
                </button>
                <button role="menuitem" className="danger" onClick={async () => {
                  setMenu(false);
                  if (!confirm("이 요청과 워크트리를 지울까요? 병합된 변경은 그대로 남아요.")) return;
                  try {
                    await api.remove(run.id);
                    go("/");
                  } catch (e) {
                    toast((e as Error).message, "err");
                  }
                }}>
                  <IconTrash size={14} /> 요청 지우기
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <Rail run={run} now={now} />
      {confirmStop ? (
        <Modal title="모두 중지할까요?" confirmLabel={`${active.length}개 중지`} danger onClose={() => setConfirmStop(false)} onConfirm={async () => {
          setConfirmStop(false);
          for (const a of active) await api.cancel(run.id, a.id).catch(() => undefined);
        }}>
          지금 작업 중인 에이전트를 멈춰요. 워크트리와 지금까지의 변경은 남아요.
        </Modal>
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------------------------------------- decision panel

function Decision({ api, run, go, watched, onWatch }: { api: Api; run: Run; go: (p: string) => void; watched: boolean; onWatch: () => void }) {
  const finished = run.agents.length > 0 && !run.agents.some(isActive);
  const winnerId = suggestWinner(run);
  const winner = run.agents.find((a) => a.id === winnerId);
  const [pf, setPf] = useState<Preflight | null>(null);
  useEffect(() => {
    setPf(null);
    if (!winnerId || !finished) return;
    api.preflight(run.id, winnerId).then(setPf).catch(() => undefined);
  }, [api, run.id, winnerId, finished, winner?.diff.patch]);
  const steps = run.triage?.plan ?? [];
  const progress = useMemo(() => {
    if (!steps.length) return 0;
    if (finished) return steps.length;
    const a = run.agents;
    if (a.some((x) => x.status === "checking" || x.check.status !== "skipped")) return Math.max(1, steps.length - 1);
    if (a.some((x) => (x.events?.length ?? 0) > 2)) return Math.min(steps.length - 1, 2);
    return 1;
  }, [run, steps.length, finished]);

  return (
    <aside className="decide" aria-label="결정">
      <section className="card">
        <div className="card-head">
          <h2>검증 관문</h2>
          {run.checkCmd ? <Tag mono>{run.checkCmd}</Tag> : <Tag tone="dim">검증 없음</Tag>}
        </div>
        {run.agents.map((a) => {
          const st = agentState(a, run.maxAttempts);
          return (
            <div key={a.id} className={`gate-row g-${st.tone ?? "none"}`}>
              <AgentMark adapter={a.adapter} size={20} />
              <span className="gate-name">{a.label}</span>
              <span className="gate-res mono">
                {st.tone === "ok" ? <IconCheckCircle size={14} /> : st.tone === "bad" ? <IconXCircle size={14} /> : st.tone === "now" ? <Star size={11} /> : null}
                {st.text}
              </span>
            </div>
          );
        })}
        {winner ? (
          <div className="gate-checks">
            <Check loading={false} ok={!winner.diff.testsTouched?.length} text={winner.diff.testsTouched?.length ? `테스트 파일을 고쳤어요 · ${winner.diff.testsTouched.join(", ")}` : "테스트 파일은 그대로"} />
            <Check loading={!pf} ok={pf ? (pf.conflicts === null ? null : !pf.conflicts) : null} text={!pf ? "충돌 확인 중" : pf.conflicts ? `${run.baseBranch} 과 충돌` : pf?.conflicts === null ? "충돌 여부를 알 수 없어요" : `${run.baseBranch} 과 충돌 없음`} />
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>{finished ? "추천" : "지금까지 추천"}</h2>
          {!finished ? <span className="dim small">아직 도는 에이전트가 있어요</span> : null}
        </div>
        {winner ? (
          <>
            <div className="win">
              <AgentMark adapter={winner.adapter} size={26} />
              <div>
                <b>{winner.label}</b>
                <span className="mono dim small">
                  {fmtDuration(winner.durationMs)} · {fmtCost(winner.usage.costUsd)} · +{winner.diff.insertions} −{winner.diff.deletions}
                </span>
              </div>
            </div>
            <p className="reason">{winnerReason(run, winner.id)}</p>
          </>
        ) : (
          <p className="reason">{finished ? "검증을 통과한 결과가 없어요. 지시를 더해 다시 맡기거나 반려하세요." : "검증 관문을 통과하는 결과가 나오면 여기 올라와요."}</p>
        )}
        <div className="row-btns">
          {run.review.status === "pending" ? (
            <a className="btn m grow" href={`#/runs/${run.id}/review`}>
              <Star size={13} /> 검토하고 승인
            </a>
          ) : winner && run.review.status === "none" ? (
            <a className="btn w grow" href={`#/runs/${run.id}/review`}>
              지금 검토하기
            </a>
          ) : (
            <button className="btn grow" onClick={() => go(`/runs/${run.id}/review`)}>
              변경 보기
            </button>
          )}
          {!finished ? (
            <button className={`btn ${watched ? "on" : ""}`} aria-pressed={watched} onClick={onWatch} title="검토할 차례가 되면 브라우저 알림">
              <IconBell size={14} />
              {watched ? "알림 켜짐" : "끝나면"}
            </button>
          ) : null}
        </div>
        {run.review.status === "approved" || run.review.status === "rejected" ? (
          <div className={`verdict v-${run.review.status}`}>
            {run.review.status === "approved" ? "병합됨" : "반려됨"} · {run.review.reviewer}
            {run.review.comment ? <span> — “{run.review.comment}”</span> : null}
          </div>
        ) : null}
      </section>

      {steps.length ? (
        <details className="plan" open>
          <summary>
            <span className="lab">
              계획 · {progress}/{steps.length}
            </span>
            <span className="dim small">{run.triage?.by === "llm" ? "계획 에이전트" : "키워드 규칙"}</span>
          </summary>
          <ol>
            {steps.map((s, i) => (
              <li key={i} className={i < progress ? "done" : i === progress ? "now" : ""}>
                <span className="plan-i">{i < progress ? <IconCheck size={13} /> : i === progress ? <Star size={11} /> : <span className="dot" />}</span>
                {s}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {run.agents.some((a) => a.steers?.length) ? (
        <section className="steers">
          <span className="lab">
            <IconHistory size={13} /> 사람이 더한 지시
          </span>
          {run.agents.flatMap((a) => (a.steers ?? []).map((s) => ({ ...s, a: a.label }))).sort((x, y) => y.at - x.at).slice(0, 4).map((s, i) => (
            <div key={i} className="steer-item">
              <b>{s.by}</b> → {s.a}
              <p>{s.text}</p>
            </div>
          ))}
        </section>
      ) : null}
    </aside>
  );
}

function Check({ ok, text, loading }: { ok: boolean | null; text: string; loading: boolean }) {
  return (
    <span className={`chk ${ok === true ? "ok" : ok === false ? "bad" : "dim"}`}>
      {loading ? <Spinner size={10} /> : ok === true ? <IconCheck size={14} /> : ok === false ? <IconXCircle size={14} /> : <IconHistory size={14} />}
      {text}
    </span>
  );
}
