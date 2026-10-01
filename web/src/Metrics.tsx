import { AgentMark } from "./icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdapterMetrics, Api, Metrics as M } from "./api";
import { AdapterBadge, CheckBadge, Empty, ErrorBox, Spinner } from "./ui";
import { TEAM_KO, adapterName, fmtCost, fmtDuration, fmtPct, fmtTokens, relTime } from "./util";

type Key = "passRate" | "medianDurationMs" | "avgCost" | "avgTokens" | "avgFilesChanged";

const METRICS: { key: Key; label: string; fmt: (n: number | null) => string; better: "high" | "low" }[] = [
  { key: "passRate", label: "검증 통과율", fmt: fmtPct, better: "high" },
  { key: "medianDurationMs", label: "중앙 시간", fmt: fmtDuration, better: "low" },
  { key: "avgCost", label: "평균 비용", fmt: fmtCost, better: "low" },
  { key: "avgTokens", label: "평균 토큰", fmt: fmtTokens, better: "low" },
  { key: "avgFilesChanged", label: "변경 파일", fmt: (n) => (n == null ? "—" : n.toFixed(1)), better: "low" },
];

function value(m: AdapterMetrics, key: Key): number | null {
  switch (key) {
    case "avgCost":
      return m.agents && m.totalCostUsd > 0 ? m.totalCostUsd / m.agents : null;
    case "avgTokens":
      return m.agents ? (m.totalInputTokens + m.totalOutputTokens) / m.agents : null;
    case "medianDurationMs":
      return m.medianDurationMs;
    default:
      return m[key];
  }
}

export function Metrics({ api }: { api: Api }) {
  const [data, setData] = useState<M | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<Key>("passRate");

  const load = useCallback(() => {
    api
      .metrics()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  const entries = data ? Object.entries(data.byAdapter).sort((a, b) => b[1].agents - a[1].agents) : [];
  const t = data?.totals;
  const decided = t ? t.approved + t.rejected : 0;

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>지표</h1>
      </div>

      {error && !data ? <ErrorBox error={`불러오기 실패 · ${error}`} onRetry={load} /> : null}
      {!data && !error ? (
        <div className="loading">
          <Spinner size={16} /> 불러오는 중
        </div>
      ) : null}
      {data && t && t.requests === 0 ? <Empty title="데이터 없음" /> : null}

      {data && t && t.requests > 0 ? (
        <>
          <div className="kpis five">
            <Kpi label="요청" value={String(t.requests)} />
            <Kpi label="자동 해결률" value={fmtPct(t.autoResolved / t.requests)} />
            <Kpi label="승인율" value={decided ? fmtPct(t.approved / decided) : "—"} />
            <Kpi label="절약 시간" value={`${t.estHoursSaved.toFixed(1)}h`} est />
            <Kpi label="비용" value={fmtCost(t.costUsd)} />
          </div>

          <div className="two-col">
            <section className="panel">
              <div className="panel-head">
                <h2>팀별</h2>
              </div>
              <div className="table-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>팀</th>
                      <th className="num">요청</th>
                      <th className="num">자동 해결</th>
                      <th className="num">승인</th>
                      <th className="num">리드타임</th>
                      <th>예산 사용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.byTeam)
                      .sort((a, b) => b[1].requests - a[1].requests)
                      .map(([id, m]) => {
                        const used = m.budgetUsd ? m.costUsd / m.budgetUsd : 0;
                        return (
                          <tr key={id}>
                            <td className="strong">{TEAM_KO[id] ?? id}</td>
                            <td className="num mono">{m.requests}</td>
                            <td className="num mono">{m.requests ? fmtPct(m.autoResolved / m.requests) : "—"}</td>
                            <td className="num mono">{m.approved + m.rejected ? fmtPct(m.approved / (m.approved + m.rejected)) : "—"}</td>
                            <td className="num mono">{fmtDuration(m.medianLeadMs)}</td>
                            <td className="budget-cell">
                              <span className={`budget ${used > 0.9 ? "hot" : ""}`}>
                                <i style={{ width: `${Math.min(100, used * 100)}%` }} />
                              </span>
                              <span className="mono small">
                                {fmtCost(m.costUsd)} / {fmtCost(m.budgetUsd)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>일의 종류별</h2>
              </div>
              <div className="table-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>템플릿</th>
                      <th className="num">요청</th>
                      <th>자동 해결률</th>
                      <th className="num">승인율</th>
                      <th className="num">평균 비용</th>
                      <th className="num">절약(추정)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.byTemplate)
                      .sort((a, b) => b[1].requests - a[1].requests)
                      .map(([id, m]) => (
                        <tr key={id}>
                          <td className="strong">{m.name}</td>
                          <td className="num mono">{m.requests}</td>
                          <td className="rate-cell">
                            <span className="rate">
                              <i style={{ width: `${Math.round(m.autoResolvedRate * 100)}%` }} />
                            </span>
                            <span className="mono small">{fmtPct(m.autoResolvedRate)}</span>
                          </td>
                          <td className="num mono">{fmtPct(m.approvalRate)}</td>
                          <td className="num mono">{m.avgCostUsd == null ? <span className="dim">n/a</span> : fmtCost(m.avgCostUsd)}</td>
                          <td className="num mono">{m.estHoursSaved.toFixed(1)}h</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="panel">
            <div className="panel-head wrap">
              <h2>에이전트 비교</h2>
              <div className="seg" role="tablist">
                {METRICS.map((mm) => (
                  <button key={mm.key} role="tab" aria-selected={key === mm.key} className={key === mm.key ? "on" : ""} onClick={() => setKey(mm.key)}>
                    {mm.label}
                  </button>
                ))}
              </div>
            </div>
            <BarChart entries={entries} metric={METRICS.find((x) => x.key === key)!} />
            <div className="adapter-cards inpanel">
              {entries.map(([id, m]) => (
                <AdapterCard key={id} id={id} m={m} />
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>최근 에이전트 실행</h2>
            </div>
            <div className="table-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>언제</th>
                    <th>요청</th>
                    <th>에이전트</th>
                    <th className="num">시간</th>
                    <th className="num">토큰</th>
                    <th className="num">비용</th>
                    <th>검증</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.timeline]
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .slice(0, 30)
                    .map((row, i) => (
                      <tr key={`${row.runId}-${row.label}-${i}`}>
                        <td className="dim nowrap">{relTime(row.createdAt)}</td>
                        <td>
                          <a className="mono link" href={`#/requests/${row.runId}`}>
                            {row.runId}
                          </a>
                        </td>
                        <td className="nowrap">
                          <span className="strong">{row.label}</span> <span className="dim">{adapterName(row.adapter)}</span>
                        </td>
                        <td className="num mono">{fmtDuration(row.durationMs)}</td>
                        <td className="num mono">{fmtTokens(row.tokens)}</td>
                        <td className="num mono">{row.costUsd == null ? <span className="dim">n/a</span> : fmtCost(row.costUsd)}</td>
                        <td>
                          <CheckBadge status={row.checkStatus} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, sub, est }: { label: string; value: string; sub?: string; est?: boolean }) {
  return (
    <div className="kpi">
      <div className="kpi-l">
        {label}
        {est ? <span className="est">추정</span> : null}
      </div>
      <div className="kpi-v mono">{value}</div>
      {sub ? <div className="kpi-s">{sub}</div> : null}
    </div>
  );
}

function AdapterCard({ id, m }: { id: string; m: AdapterMetrics }) {
  const avgCost = value(m, "avgCost");
  return (
    <div className={`acard ad-${id}`}>
      <div className="acard-head">
        <AdapterBadge adapter={id} />
        <span className="dim small mono">{m.agents}회 실행</span>
      </div>
      <div className="acard-hero">
        <span className="acard-big mono">{fmtPct(m.passRate)}</span>
        <span className="dim small">검증 통과</span>
      </div>
      <div className="meter" aria-hidden>
        <span style={{ width: `${Math.round((m.passRate || 0) * 100)}%` }} />
      </div>
      <dl className="acard-grid">
        <div>
          <dt>중앙 시간</dt>
          <dd className="mono">{fmtDuration(m.medianDurationMs)}</dd>
        </div>
        <div>
          <dt>평균 비용</dt>
          <dd className="mono">{avgCost == null ? <span className="dim">n/a</span> : fmtCost(avgCost)}</dd>
        </div>
        <div>
          <dt>토큰 입력 / 출력</dt>
          <dd className="mono">
            {fmtTokens(m.totalInputTokens)} / {fmtTokens(m.totalOutputTokens)}
          </dd>
        </div>
        <div>
          <dt>평균 변경 파일</dt>
          <dd className="mono">{m.avgFilesChanged.toFixed(1)}</dd>
        </div>
      </dl>
    </div>
  );
}

function BarChart({ entries, metric }: { entries: [string, AdapterMetrics][]; metric: (typeof METRICS)[number] }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rows = entries.map(([id, m]) => ({ id, v: value(m, metric.key) }));
  const max = Math.max(...rows.map((r) => r.v ?? 0), metric.key === "passRate" ? 1 : 0) || 1;
  const valid = rows.filter((r) => r.v != null) as { id: string; v: number }[];
  const best = valid.length > 1 ? valid.reduce((a, b) => ((metric.better === "high" ? b.v > a.v : b.v < a.v) ? b : a)).id : null;

  const narrow = W < 480;
  const rowH = 30;
  const gap = 12;
  const labelW = narrow ? 92 : 120;
  const valueW = narrow ? 64 : 84;
  const plotW = W - labelW - valueW;
  const H = rows.length * (rowH + gap) - gap + 24;
  const ticks = metric.key === "passRate" ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1].map((t) => t * max);

  return (
    <div className="chart" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`에이전트별 ${metric.label}`}>
        {ticks.map((t, i) => {
          const x = labelW + (t / max) * plotW;
          if (narrow && i > 0 && i < ticks.length - 1 && ticks.length > 3 && i % 2 === 1) return null;
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={0} y2={H - 20} className="grid" />
              <text x={x} y={H - 4} className="tick" textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>
                {metric.fmt(t)}
              </text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          const y = i * (rowH + gap);
          const w = r.v == null ? 0 : Math.max(4, (r.v / max) * plotW);
          const isBest = r.id === best;
          return (
            <g key={r.id} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} className={hover === i ? "hov" : ""}>
              <rect x={0} y={y - gap / 2} width={W} height={rowH + gap} fill="transparent" />
              <foreignObject x={0} y={y + rowH / 2 - 10} width={labelW - 8} height={20}>
                <div className={`blabel-row ad-${r.id}`}>
                  <AgentMark adapter={r.id} size={18} />
                  <span>{adapterName(r.id)}</span>
                </div>
              </foreignObject>
              {r.v == null ? (
                <text x={labelW + 6} y={y + rowH / 2 + 4} className="bna">
                  보고 안 함
                </text>
              ) : (
                <path d={barPath(labelW, y + 6, w, rowH - 12, 4)} className={`bar ad-${r.id} ${isBest ? "best" : ""}`} />
              )}
              <text x={W} y={y + rowH / 2 + 4} className="bval" textAnchor="end">
                {metric.fmt(r.v)}
              </text>
              <title>{`${adapterName(r.id)} · ${metric.label}: ${metric.fmt(r.v)}${isBest ? " (가장 좋음)" : ""}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Bar anchored square at the baseline, 4px-rounded at the data end. */
function barPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
}
