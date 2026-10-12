/** 작업 — 한 요청의 달 머리, 접힌 계획 줄, 에이전트 칸, 맨 아래 결정 바. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Api, Run } from "./api";
import { AgentPane, AgentPill, type PaneTab } from "./AgentPane";
import { DecisionBar, StopModal } from "./Decision";
import { useLiveRun } from "./flow";
import { IconArrowLeft, IconBell, IconCheck, IconChevron, IconColumns, IconMore, IconStop, IconTrash } from "./icons";
import { Moon, runPhase } from "./moon";
import { Empty, ErrorBox, Spinner, useOutside, useToast } from "./ui";
import { TEMPLATE_KO, isActive, suggestWinner, useMedia, useNow, type User } from "./util";

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
  const wide = useMedia("(min-width: 1500px)");
  const [side, setSide] = useState(false); // 나란히 — 넓은 화면에서만, 기본은 하나씩
  const [focus, setFocus] = useState(0);
  const [tabs, setTabs] = useState<Record<string, PaneTab>>({});
  const [planOpen, setPlanOpen] = useState(false);
  const inputs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useEffect(() => {
    if (!run || !initialAgent) return;
    const i = run.agents.findIndex((a) => a.id === initialAgent);
    if (i >= 0) {
      setFocus(i);
      if (initialTab) setTabs((t) => ({ ...t, [initialAgent]: initialTab }));
    }
  }, [run?.id, initialAgent, initialTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const toInput = (i: number) => {
    setFocus(i);
    setTimeout(() => inputs.current[i]?.focus(), 0);
  };

  // ⌘1 · ⌘2 … move between agents; ↵ in the steer box is handled by the box itself
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !/^[1-9]$/.test(e.key) || !run) return;
      const i = Number(e.key) - 1;
      if (i >= run.agents.length) return;
      e.preventDefault();
      toInput(i);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [run]);

  if (error && !run)
    return (
      <div className="ws">
        <ErrorBox error={`불러오기 실패 · ${error}`} onRetry={reload} />
      </div>
    );
  if (!run)
    return (
      <div className="ws" aria-busy>
        <div className="ws-body">
          <div className="skel" style={{ height: 56, width: "60%" }} />
          <div className="skel" style={{ flex: 1 }} />
        </div>
      </div>
    );

  const split = wide && side && run.agents.length > 1;
  const at = Math.min(focus, run.agents.length - 1);
  const shown = split ? run.agents : run.agents.filter((_, i) => i === at);
  const winnerIdx = Math.max(0, run.agents.findIndex((a) => a.id === suggestWinner(run)));

  return (
    <div className="ws">
      <div className="ws-body">
        <RunHeader api={api} run={run} now={now} go={go} wide={wide && run.agents.length > 1} split={split} setSide={setSide} watched={watched} onWatch={onWatch} onPlan={() => setPlanOpen(true)} />
        <PlanLine run={run} open={planOpen} setOpen={setPlanOpen} />
        {!split && run.agents.length > 1 ? (
          <div className="apills" role="tablist" aria-label="에이전트">
            {run.agents.map((a, i) => (
              <AgentPill key={a.id} a={a} maxAttempts={run.maxAttempts} on={i === at} hint={`⌘${i + 1}`} onClick={() => setFocus(i)} />
            ))}
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
                  onFocus={() => setFocus(i)}
                  previewCommand={previewCommand}
                  inputRef={(el) => (inputs.current[i] = el)}
                  showName={split}
                />
              );
            })}
          </div>
        )}
      </div>
      <DecisionBar api={api} run={run} user={user} go={go} now={now} watched={watched} onWatch={onWatch} onRevise={() => toInput(winnerIdx)} />
    </div>
  );
}

function RunHeader({ api, run, now, go, wide, split, setSide, watched, onWatch, onPlan }: { api: Api; run: Run; now: number; go: (p: string) => void; wide: boolean; split: boolean; setSide: (v: boolean) => void; watched: boolean; onWatch: () => void; onPlan: () => void }) {
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const [stop, setStop] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useOutside(box, menu, () => setMenu(false));
  const { phase, label, detail } = runPhase(run, now);
  const live = run.agents.some(isActive);
  const pick = (fn: () => void) => () => {
    setMenu(false);
    fn();
  };
  return (
    <header className="ws-head">
      <a className="ib ws-back only-phone" href="#/runs" aria-label="작업 목록">
        <IconArrowLeft size={18} />
      </a>
      <Moon phase={phase} size={40} />
      <div className="ws-title">
        <div className="ws-phase">
          <b>{label}</b>
          {detail ? <span> · {detail}</span> : null}
        </div>
        <h1>{run.triage?.title ?? run.title}</h1>
        <div className="ws-meta">
          {run.channel ? <a href={`#/chat/${run.channel}`}>#{run.channel}</a> : null}
          <span>{run.requester}</span>
          <span>{TEMPLATE_KO[run.template] ?? run.template}</span>
          <span className="mono">
            {run.baseBranch} @{run.baseRef.slice(0, 7)}
          </span>
        </div>
      </div>
      <div className="ws-tools">
        {wide ? (
          <div className="seg icons" role="group" aria-label="보기">
            <button aria-pressed={!split} className={!split ? "on" : ""} aria-label="하나씩" title="하나씩" onClick={() => setSide(false)}>
              <IconStop size={15} />
            </button>
            <button aria-pressed={split} className={split ? "on" : ""} aria-label="나란히" title="나란히" onClick={() => setSide(true)}>
              <IconColumns size={15} />
            </button>
          </div>
        ) : null}
        <div className="menu-wrap" ref={box}>
          <button className="ib" aria-label="더 보기" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <IconMore size={18} />
          </button>
          {menu ? (
            <div className="menu" role="menu">
              {run.triage?.plan.length ? (
                <button role="menuitem" onClick={pick(onPlan)}>
                  <IconChevron size={14} /> 계획 보기
                </button>
              ) : null}
              <button role="menuitem" onClick={pick(() => go(`/runs/${run.id}/review`))}>
                <IconCheck size={14} /> 변경 검토 화면
              </button>
              {live ? (
                <button role="menuitem" onClick={pick(onWatch)}>
                  <IconBell size={14} filled={watched} /> 끝나면 알림 {watched ? "끄기" : "켜기"}
                </button>
              ) : null}
              {live ? (
                <button role="menuitem" onClick={pick(() => setStop(true))}>
                  <IconStop size={14} /> 취소
                </button>
              ) : null}
              <button
                role="menuitem"
                className="danger"
                onClick={pick(async () => {
                  if (!confirm("이 요청과 워크트리를 지울까요? 병합된 변경은 그대로 남아요.")) return;
                  try {
                    await api.remove(run.id);
                    go("/runs");
                  } catch (e) {
                    toast((e as Error).message, "err");
                  }
                })}
              >
                <IconTrash size={14} /> 워크트리 정리
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {stop ? <StopModal api={api} run={run} onClose={() => setStop(false)} /> : null}
    </header>
  );
}

/** 계획은 접힌 한 줄 — 펼치면 번호 목록 */
function PlanLine({ run, open, setOpen }: { run: Run; open: boolean; setOpen: (v: boolean) => void }) {
  const steps = run.triage?.plan ?? [];
  const finished = run.agents.length > 0 && !run.agents.some(isActive);
  const progress = useMemo(() => {
    if (!steps.length) return 0;
    if (finished) return steps.length;
    const a = run.agents;
    if (a.some((x) => x.status === "checking" || x.check.status !== "skipped")) return Math.max(1, steps.length - 1);
    if (a.some((x) => (x.events?.length ?? 0) > 2)) return Math.min(steps.length - 1, 2);
    return 1;
  }, [run, steps.length, finished]);
  if (!steps.length) return null;
  return (
    <details className="plan-line" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        계획 {steps.length}단계 <IconChevron size={13} />
      </summary>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={i < progress ? "done" : i === progress ? "now" : ""}>
            {s}
          </li>
        ))}
      </ol>
    </details>
  );
}
