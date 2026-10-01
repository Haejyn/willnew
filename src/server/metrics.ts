import type { Run } from "./types.js";

export interface AdapterMetrics {
  agents: number;
  done: number;
  checkPassed: number;
  passRate: number;          // passed checks / finished agents (failed runs count as not passed)
  medianDurationMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgFilesChanged: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Usage metrics across runs, per agent CLI — which agent is worth running for this repo? */
export function computeMetrics(runs: Run[]) {
  const by: Record<string, { agents: number; done: number; passed: number; finished: number; durations: number[];
    inTok: number; outTok: number; cost: number; files: number[] }> = {};
  const timeline: { runId: string; createdAt: number; adapter: string; label: string; durationMs: number | null;
    checkStatus: string; costUsd: number | null; tokens: number }[] = [];
  for (const run of runs) {
    for (const a of run.agents) {
      const m = (by[a.adapter] ??= { agents: 0, done: 0, passed: 0, finished: 0, durations: [], inTok: 0, outTok: 0, cost: 0, files: [] });
      m.agents += 1;
      if (a.status === "done") m.done += 1;
      if (a.status === "done" || a.status === "failed") {
        m.finished += 1;
        if (a.check.status === "passed" || (a.status === "done" && a.check.status === "skipped")) m.passed += 1;
        if (a.durationMs) m.durations.push(a.durationMs);
        m.files.push(a.diff.files);
      }
      m.inTok += a.usage.inputTokens + a.usage.cachedTokens;
      m.outTok += a.usage.outputTokens;
      m.cost += a.usage.costUsd ?? 0;
      timeline.push({ runId: run.id, createdAt: run.createdAt, adapter: a.adapter, label: a.label, durationMs: a.durationMs ?? null,
        checkStatus: a.status === "done" ? a.check.status : a.status, costUsd: a.usage.costUsd,
        tokens: a.usage.inputTokens + a.usage.cachedTokens + a.usage.outputTokens });
    }
  }
  const byAdapter: Record<string, AdapterMetrics> = {};
  for (const [k, m] of Object.entries(by)) {
    byAdapter[k] = {
      agents: m.agents, done: m.done, checkPassed: m.passed,
      passRate: m.finished ? m.passed / m.finished : 0,
      medianDurationMs: median(m.durations),
      totalInputTokens: m.inTok, totalOutputTokens: m.outTok, totalCostUsd: m.cost,
      avgFilesChanged: m.files.length ? m.files.reduce((a, b) => a + b, 0) / m.files.length : 0,
    };
  }
  timeline.sort((a, b) => b.createdAt - a.createdAt);
  return { runs: runs.length, byAdapter, timeline: timeline.slice(0, 50) };
}

/** Team-level view: who uses willnew, for what, how often it resolves the request, and what it costs. */
export function computeTeamMetrics(runs: Run[], teams: { id: string; name: string; budgetUsd: number }[],
  templates: { id: string; name: string; estMinutes: number }[]) {
  const finished = (r: Run) => r.agents.every((a) => a.status === "done" || a.status === "failed" || a.status === "cancelled");
  const resolved = (r: Run) => r.agents.some((a) => a.status === "done" && a.check.status !== "failed" && a.diff.files > 0);
  const cost = (r: Run) => r.agents.reduce((s, a) => s + (a.usage.costUsd ?? 0), 0) + (r.triage?.costUsd ?? 0);
  const est = (r: Run) => templates.find((t) => t.id === r.template)?.estMinutes ?? 0;
  const totals = { requests: runs.length, autoResolved: 0, approved: 0, rejected: 0, pendingReview: 0, estHoursSaved: 0, costUsd: 0 };
  const byTeam: Record<string, { name: string; requests: number; autoResolved: number; approved: number; rejected: number;
    costUsd: number; budgetUsd: number; leads: number[]; medianLeadMs: number | null }> = {};
  const byTemplate: Record<string, { name: string; requests: number; resolved: number; approved: number; reviewed: number;
    costs: number[]; estHoursSaved: number; autoResolvedRate: number; approvalRate: number; avgCostUsd: number | null }> = {};
  for (const t of teams) byTeam[t.id] = { name: t.name, requests: 0, autoResolved: 0, approved: 0, rejected: 0, costUsd: 0,
    budgetUsd: t.budgetUsd, leads: [], medianLeadMs: null };
  for (const r of runs) {
    const tm = (byTeam[r.team] ??= { name: r.team, requests: 0, autoResolved: 0, approved: 0, rejected: 0, costUsd: 0, budgetUsd: 0, leads: [], medianLeadMs: null });
    const tp = (byTemplate[r.template] ??= { name: templates.find((t) => t.id === r.template)?.name ?? r.template, requests: 0,
      resolved: 0, approved: 0, reviewed: 0, costs: [], estHoursSaved: 0, autoResolvedRate: 0, approvalRate: 0, avgCostUsd: null });
    const c = cost(r);
    tm.requests += 1; tp.requests += 1; tm.costUsd += c; totals.costUsd += c;
    if (finished(r)) tp.costs.push(c);
    if (resolved(r)) { tm.autoResolved += 1; tp.resolved += 1; totals.autoResolved += 1; }
    if (r.review.status === "pending") totals.pendingReview += 1;
    if (r.review.status === "approved") {
      tm.approved += 1; tp.approved += 1; tp.reviewed += 1; totals.approved += 1;
      const h = est(r) / 60; tp.estHoursSaved += h; totals.estHoursSaved += h;
      if (r.review.at) tm.leads.push(r.review.at - r.createdAt);
    }
    if (r.review.status === "rejected") { tm.rejected += 1; tp.reviewed += 1; totals.rejected += 1; }
  }
  for (const tm of Object.values(byTeam)) tm.medianLeadMs = median(tm.leads);
  for (const tp of Object.values(byTemplate)) {
    tp.autoResolvedRate = tp.requests ? tp.resolved / tp.requests : 0;
    tp.approvalRate = tp.reviewed ? tp.approved / tp.reviewed : 0;
    tp.avgCostUsd = tp.costs.length ? tp.costs.reduce((a, b) => a + b, 0) / tp.costs.length : null;
  }
  const strip = <T extends object>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  return {
    totals,
    byTeam: Object.fromEntries(Object.entries(byTeam).map(([k, v]) => [k, strip(v, ["leads"])])),
    byTemplate: Object.fromEntries(Object.entries(byTemplate).map(([k, v]) => [k, strip(v, ["costs", "resolved", "reviewed"])])),
  };
}
