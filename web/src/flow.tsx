/** Pieces shared by the chat run card and the request detail: live run hook, triage, review, trace. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentRun, Api, Run } from "./api";
import { applyUpdate } from "./api";
import { IconCheck, IconMerge, IconX } from "./icons";
import { Spinner, useToast } from "./ui";
import { TEMPLATE_KO, fmtCost, fmtDuration, isActive, suggestWinner, type User } from "./util";

export function useLiveRun(api: Api, id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .run(id)
      .then(setRun)
      .catch((e: Error) => setError(e.message));
  }, [api, id]);

  useEffect(() => {
    load();
    let refetching = false;
    return api.subscribe(
      id,
      (u) =>
        setRun((r) => {
          if (!r) return r;
          const next = applyUpdate(r, u);
          if (next) return next;
          if (!refetching) {
            refetching = true;
            api.run(id).then((fresh) => {
              refetching = false;
              setRun(fresh);
            });
          }
          return r;
        }),
      setLive,
    );
  }, [api, id, load]);

  return { run, setRun, error, live, reload: load };
}

// ---------------------------------------------------------------------------------------------- triage

/** How far along the plan is, derived from what the agents have done so far. */
function planProgress(run: Run): number {
  const steps = run.triage?.plan.length ?? 0;
  if (!steps) return 0;
  const a = run.agents;
  let phase = 0; // 0..4
  if (a.some((x) => (x.events?.length ?? 0) > 1 || x.status !== "queued")) phase = 1;
  if (a.some((x) => x.status === "checking" || x.status === "retrying" || x.check?.status !== "skipped")) phase = 2;
  if (a.length && !a.some(isActive)) phase = 3;
  if (run.review?.status === "approved" || run.review?.status === "rejected") phase = 4;
  return Math.round((phase / 4) * steps);
}

export function TriageBlock({ run, compact }: { run: Run; compact?: boolean }) {
  const t = run.triage;
  if (!t)
    return (
      <div className="triage pending">
        <Spinner size={12} /> 요청을 읽고 계획을 세우는 중
      </div>
    );
  const done = planProgress(run);
  const active = run.agents.some(isActive);
  return (
    <div className="triage">
      <div className="triage-head">
        <span className="tag-plan">계획</span>
        <span className="chip-soft">{TEMPLATE_KO[t.template] ?? t.template}</span>
        <span className="meta-s">
          {t.by === "llm" ? "LLM 플래너" : "규칙 라우팅"} · {fmtDuration(t.durationMs ?? null)}
          {t.costUsd ? ` · ${fmtCost(t.costUsd)}` : ""}
        </span>
      </div>
      <ol className="plan">
        {t.plan.map((step, i) => {
          const st = i < done ? "done" : i === done && active ? "now" : "todo";
          return (
            <li key={i} className={`plan-step ${st}`}>
              <span className="plan-mark">{st === "done" ? <IconCheck size={12} /> : st === "now" ? <Spinner size={10} /> : i + 1}</span>
              <span>{step}</span>
            </li>
          );
        })}
      </ol>
      {!compact ? (
        <div className="triage-foot">
          <span>
            맡긴 에이전트 <b>{t.agents.map((a) => a.label ?? a.adapter).join(" · ")}</b>
          </span>
          <span>
            검증 <code>{t.check || "없음"}</code>
          </span>
          <span>
            자가 수정 <b>최대 {run.maxAttempts}회 시도</b>
          </span>
        </div>
      ) : null}
      {!compact && t.reason ? <div className="triage-reason">“{t.reason}”</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- review

export function ReviewBox({ api, run, user, onChange }: { api: Api; run: Run; user: User; onChange: (r: Run) => void }) {
  const winner = useMemo(() => suggestWinner(run), [run]);
  const candidates = run.agents.filter((a) => a.status === "done" && a.check?.status !== "failed" && a.diff?.files !== 0);
  const [pick, setPick] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const chosen = pick ?? winner ?? candidates[0]?.id ?? null;
  const r = run.review;

  if (r?.status === "approved" || r?.status === "rejected") {
    const who = run.agents.find((a) => a.id === r.agentId);
    return (
      <div className={`review done ${r.status}`}>
        <span className="review-icon">{r.status === "approved" ? <IconMerge size={14} /> : <IconX size={14} />}</span>
        <span>
          {r.status === "approved" ? "승인" : "반려"} · <b>{r.reviewer}</b>{r.status === "approved" ? ` · ${who?.label ?? "결과"} 반영` : ""}
          {r.comment ? <span className="review-comment"> — “{r.comment}”</span> : null}
        </span>
      </div>
    );
  }
  if (run.agents.some(isActive) || !run.agents.length) return null;
  if (!candidates.length)
    return <div className="review done rejected">검증을 통과한 결과가 없어요. 요청을 다듬어 다시 맡겨 보세요.</div>;

  const send = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const res = await api.review(run.id, { decision, agentId: decision === "approve" ? chosen ?? undefined : undefined, reviewer: user.name, comment: comment.trim() || undefined });
      // the server's message can be raw git output — keep the toast human
      toast(res.ok ? (decision === "approve" ? `승인 · ${run.baseBranch} 반영` : "반려") : res.message, res.ok ? "ok" : "err");
      if (res.ok) {
        const fresh = await api.run(run.id);
        onChange(fresh);
      }
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review">
      <div className="review-title">검토 요청 · {run.requester}님 또는 팀 리뷰어</div>
      <div className="review-picks">
        {candidates.map((a) => (
          <button key={a.id} className={`pick ${chosen === a.id ? "on" : ""}`} onClick={() => setPick(a.id)}>
            {a.label}
            {a.id === winner ? <span className="pick-tag">추천</span> : null}
            <span className="pick-meta">
              {fmtDuration(a.durationMs ?? null)} · +{a.diff.insertions} −{a.diff.deletions}
            </span>
          </button>
        ))}
      </div>
      {rejecting ? (
        <input className="review-input" autoFocus value={comment} onChange={(e) => setComment(e.target.value)} placeholder="반려 사유" />
      ) : null}
      <div className="review-actions">
        <button className="btn primary" disabled={busy || !chosen} onClick={() => send("approve")}>
          {busy ? <Spinner size={12} /> : <IconMerge size={14} />} 승인·반영
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => (rejecting ? send("reject") : setRejecting(true))}>
          {rejecting ? "반려 보내기" : "반려"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- trace

interface Span {
  lane: string;
  kind: "triage" | "work" | "check-ok" | "check-fail" | "check" | "review";
  start: number;
  end: number;
  label: string;
}

/** Turn event timestamps into spans: triage → attempt n work → attempt n check … → review. */
export function buildTrace(run: Run, now: number): { spans: Span[]; t0: number; t1: number; lanes: string[] } {
  const spans: Span[] = [];
  // The planner may run before the run record exists (real server) or after it (demo): end triage no later than the first agent start.
  const triageMs = run.triage?.durationMs ?? 0;
  const firstStart = Math.min(...run.agents.map((a) => a.startedAt ?? Infinity));
  const triageEnd = run.triage ? Math.min(run.createdAt + triageMs, Number.isFinite(firstStart) ? firstStart : Infinity) : now;
  const t0 = Math.min(run.createdAt, triageEnd - triageMs);
  spans.push({ lane: "willnew", kind: "triage", start: t0, end: Math.max(triageEnd, t0 + 1), label: run.triage ? "계획" : "계획 중" });
  for (const a of run.agents) spans.push(...agentSpans(a, now));
  let t1 = Math.max(now, ...spans.map((s) => s.end));
  if (!run.agents.some(isActive)) t1 = Math.max(...spans.map((s) => s.end));
  if (run.review?.at && (run.review.status === "approved" || run.review.status === "rejected")) {
    const last = Math.max(...spans.map((s) => s.end));
    spans.push({ lane: "사람", kind: "review", start: last, end: run.review.at, label: run.review.status === "approved" ? "승인" : "반려" });
    t1 = Math.max(t1, run.review.at);
  } else if (run.review?.status === "pending") {
    const last = Math.max(...spans.map((s) => s.end));
    spans.push({ lane: "사람", kind: "review", start: last, end: Math.max(now, last + 1), label: "검토 대기" });
    t1 = Math.max(t1, now);
  }
  const lanes = ["willnew", ...run.agents.map((a) => a.label), ...(spans.some((s) => s.lane === "사람") ? ["사람"] : [])];
  return { spans, t0, t1: Math.max(t1, t0 + 1000), lanes };
}

function agentSpans(a: AgentRun, now: number): Span[] {
  const out: Span[] = [];
  const events = a.events ?? [];
  const attempts = Math.max(1, a.attempt ?? 1, ...events.map((e) => e.attempt ?? 1));
  for (let n = 1; n <= attempts; n++) {
    const evs = events.filter((e) => (e.attempt ?? 1) === n);
    if (!evs.length) continue;
    const start = n === 1 ? a.startedAt ?? evs[0].ts : evs[0].ts;
    const checkStart = evs.find((e) => e.kind === "check")?.ts;
    const lastTs = evs[evs.length - 1].ts;
    const isLast = n === attempts;
    const stillGoing = isLast && isActive(a);
    const workEnd = checkStart ?? (stillGoing ? now : lastTs);
    out.push({ lane: a.label, kind: "work", start, end: Math.max(workEnd, start + 1), label: `시도 ${n}` });
    if (checkStart) {
      const verdict = evs.filter((e) => e.kind === "check").pop()!;
      const checking = stillGoing && a.status === "checking";
      const passed = /통과|passed/i.test(verdict.text) && verdict.ts > checkStart;
      const failed = /실패|failed/i.test(verdict.text) && verdict.ts > checkStart;
      const end = checking ? now : isLast && a.endedAt ? Math.max(verdict.ts, a.endedAt) : verdict.ts;
      out.push({ lane: a.label, kind: passed ? "check-ok" : failed ? "check-fail" : "check", start: checkStart, end: Math.max(end, checkStart + 1), label: passed ? "검증 ✓" : failed ? "검증 ✗" : "검증" });
    }
  }
  return out;
}

export function Trace({ run, now }: { run: Run; now: number }) {
  const { spans, t0, t1, lanes } = buildTrace(run, now);
  const W = t1 - t0;
  const pct = (t: number) => `${(((t - t0) / W) * 100).toFixed(3)}%`;
  const width = (s: Span) => `${Math.max(0.6, ((s.end - s.start) / W) * 100).toFixed(3)}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="trace">
      <div className="trace-axis">
        <span />
        <div className="trace-ticks">
          {ticks.map((f) => (
            <span key={f} style={{ left: `${f * 100}%` }}>
              {f === 0 ? "0" : fmtDuration(f * W)}
            </span>
          ))}
        </div>
      </div>
      {lanes.map((lane) => (
        <div className="trace-row" key={lane}>
          <span className="trace-lane">{lane}</span>
          <div className="trace-track">
            {spans
              .filter((s) => s.lane === lane)
              .map((s, i) => (
                <span key={i} className={`span sp-${s.kind}`} style={{ left: pct(s.start), width: width(s) }} title={`${s.label} · ${fmtDuration(s.end - s.start)}`}>
                  <em>{s.label}</em>
                </span>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
