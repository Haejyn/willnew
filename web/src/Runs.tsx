/** 작업 목록 — 왼쪽 320px. 달 하나 + 제목 + `#채널 · 단계`. */
import { useMemo, useState } from "react";
import type { Run } from "./api";
import { Moon, isDone, runPhase, type Phase } from "./moon";

type Filter = "all" | "open" | "done";
const FILTERS: [Filter, string][] = [
  ["all", "전체"],
  ["open", "진행 중"],
  ["done", "끝남"],
];
const RANK: Partial<Record<Phase, number>> = { turn: 0 };

export function RunList({ runs, current }: { runs: Run[] | null; current?: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(() => {
    const all = (runs ?? []).map((run) => ({ run, ...runPhase(run) }));
    const list = all.filter((x) => filter === "all" || (filter === "done") === isDone(x.phase));
    // 내 차례를 맨 위로, 나머지는 받은 순서(최신 먼저)
    return list.map((x, i) => ({ x, i })).sort((a, b) => (RANK[a.x.phase] ?? 1) - (RANK[b.x.phase] ?? 1) || a.i - b.i).map((o) => o.x);
  }, [runs, filter]);
  return (
    <nav className="rlist" aria-label="맡긴 일">
      <div className="seg wide" role="tablist" aria-label="거르기">
        {FILTERS.map(([id, name]) => (
          <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>
            {name}
          </button>
        ))}
      </div>
      <div className="rlist-rows">
        {!runs ? [0, 1, 2, 3].map((i) => <div key={i} className="skel rr-skel" />) : null}
        {rows.map(({ run, phase, label }) => (
          <a key={run.id} className={`rr ${run.id === current ? "on" : ""}`} href={`#/runs/${run.id}`} aria-current={run.id === current ? "page" : undefined}>
            <Moon phase={phase} size={16} />
            <span className="rr-main">
              <span className="rr-title">{run.triage?.title ?? run.title}</span>
              <span className="rr-meta">
                {run.channel ? `#${run.channel} · ` : ""}
                {label}
              </span>
            </span>
          </a>
        ))}
        {runs && !rows.length ? <span className="rlist-none">{filter === "all" ? "아직 맡긴 일이 없어요" : "해당하는 일이 없어요"}</span> : null}
      </div>
    </nav>
  );
}
