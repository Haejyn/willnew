import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentEvent, AgentRun, Api, Run } from "./api";
import { ReviewBox, Trace, TriageBlock, useLiveRun } from "./flow";
import { IconArrowLeft, IconBranch, IconChevron, IconFile, IconFolder, IconMerge, IconStop, IconTerminal, IconTrophy } from "./icons";
import { AdapterBadge, CheckBadge, ErrorBox, Modal, Spinner, StatusDot, StatusPill, useToast } from "./ui";
import {
  RUN_STATE_KO,
  STATUS_KO,
  TEAM_KO,
  TEMPLATE_KO,
  agentElapsed,
  fmtClock,
  fmtCost,
  fmtDuration,
  fmtTokens,
  isActive,
  parsePatch,
  relTime,
  runCounts,
  runElapsed,
  runState,
  shortenPaths,
  suggestWinner,
  tokenBreakdown,
  totalTokens,
  useNow,
  type User,
} from "./util";

export function RunView({ api, id, go, user }: { api: Api; id: string; go: (path: string) => void; user: User }) {
  const { run, setRun, error, live, reload } = useLiveRun(api, id);
  const [confirm, setConfirm] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const anyActive = !!run?.agents.some(isActive);
  const now = useNow(1000, anyActive || run?.review?.status === "pending");
  const winner = useMemo(() => (run ? suggestWinner(run) : null), [run]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [id]);

  if (error && !run) return <ErrorBox error={`불러오기 실패 · ${error}`} onRetry={reload} />;
  if (!run)
    return (
      <div className="loading">
        <Spinner size={16} /> 불러오는 중
      </div>
    );

  const counts = runCounts(run);
  const state = runState(run);
  const retried = run.agents.filter((a) => (a.attempt ?? 1) > 1).length;

  const doCancel = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api.cancel(run.id, confirm.id);
      toast(`${confirm.label} 를 멈췄어요`, "info");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="runview">
      <header className="run-head">
        <div className="run-head-top">
          <button className="crumb" onClick={() => go("/requests")}>
            <IconArrowLeft size={14} /> 요청
          </button>
          <span className="run-id mono">{run.id}</span>
          <span className="grow" />
          {anyActive ? (
            <span className={`live ${live ? "on" : ""}`}>
              <span className="live-dot" />
              {live ? "실시간" : "다시 연결 중"}
            </span>
          ) : null}
          <span className={`state-pill s-${state}`}>{RUN_STATE_KO[state]}</span>
        </div>
        <h1 className="task open">{run.triage?.title ?? run.title}</h1>
        <div className="run-meta">
          <span className="meta">
            <b>{run.requester}</b>
            <span className="dim">· {TEAM_KO[run.team] ?? run.team}</span>
          </span>
          <span className="chip-soft">{TEMPLATE_KO[run.template] ?? run.template}</span>
          {run.channel ? (
            <a className="meta link" href={`#/chat/${run.channel}`}>
              #{run.channel}
            </a>
          ) : null}
          <span className="meta">
            <IconFolder size={13} />
            <span className="mono">{run.repo}</span>
          </span>
          <span className="meta">
            <IconBranch size={13} />
            <span className="mono">{run.baseBranch}</span>
            {run.baseRef ? <span className="mono dim">@{run.baseRef.slice(0, 7)}</span> : null}
          </span>
          {run.checkCmd ? (
            <span className="meta">
              <IconTerminal size={13} />
              <span className="mono">{run.checkCmd}</span>
            </span>
          ) : null}
          <span className="meta dim">{relTime(run.createdAt, now)}</span>
        </div>
        <div className="run-summary">
          <Stat label="소요" value={fmtClock(runElapsed(run, now))} accent={anyActive} />
          <Stat label="검증 통과" value={`${counts.passed}/${counts.total}`} tone={counts.passed ? "ok" : undefined} />
          <Stat label="자가 수정" value={`${retried}건`} />
          <Stat label="토큰" value={fmtTokens(run.agents.reduce((s, a) => s + totalTokens(a), 0))} />
          <Stat label="비용" value={fmtCost(sumCost(run) ?? null)} />
        </div>
      </header>

      <div className="detail-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>계획</h2>
          </div>
          <TriageBlock run={run} />
        </section>
        <section className="panel">
          <div className="panel-head wrap">
            <h2>실행 기록</h2>
            <span className="legend">
              <i className="lg-triage" />계획 <i className="lg-work" />작업 <i className="lg-ok" />검증 통과 <i className="lg-fail" />검증 실패 <i className="lg-review" />사람
            </span>
          </div>
          <Trace run={run} now={now} />
          <ReviewBox api={api} run={run} user={user} onChange={setRun} />
        </section>
      </div>

      <div className="lanes">
        {run.agents.map((a) => (
          <Lane key={a.id} agent={a} now={now} suggested={a.id === winner} maxAttempts={run.maxAttempts} onCancel={() => setConfirm(a)} />
        ))}
      </div>

      {run.agents.length > 1 ? <Scoreboard run={run} now={now} winner={winner} /> : null}

      {confirm ? (
        <Modal title={`${confirm.label} 를 멈출까요?`} confirmLabel="멈추기" danger busy={busy} onConfirm={doCancel} onClose={() => setConfirm(null)}>
          <p>에이전트 프로세스를 끝내요. 작업 공간과 지금까지의 변경은 남아 있어요.</p>
        </Modal>
      ) : null}
    </div>
  );
}

const sumCost = (run: Run) => {
  const known = run.agents.filter((a) => a.usage?.costUsd != null);
  const triage = run.triage?.costUsd ?? 0;
  return known.length || triage ? known.reduce((s, a) => s + (a.usage.costUsd ?? 0), 0) + triage : null;
};

function Stat({ label, value, tone, accent }: { label: string; value: string; tone?: "ok"; accent?: boolean }) {
  return (
    <div className={`stat ${tone === "ok" ? "ok" : ""} ${accent ? "accent" : ""}`}>
      <div className="stat-v mono">{value}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- lane

const Lane = memo(function Lane({
  agent: a,
  now,
  suggested,
  maxAttempts,
  onCancel,
}: {
  agent: AgentRun;
  now: number;
  suggested: boolean;
  maxAttempts: number;
  onCancel: () => void;
}) {
  const active = isActive(a);
  const elapsed = agentElapsed(a, now);
  const [diffOpen, setDiffOpen] = useState(false);
  const cls = ["lane", `ad-${a.adapter}`, `lane-${a.status}`, suggested ? "suggested" : "", a.merged ? "merged" : "", diffOpen ? "wide" : ""].filter(Boolean).join(" ");

  return (
    <article className={cls}>
      <div className="lane-head">
        <div className="lane-title">
          <span className="lane-label">{a.label}</span>
          {suggested ? (
            <span className="tag-suggested" title="검증을 통과한 결과 중 가장 빠른 것 (비슷하면 더 저렴한 것)">
              <IconTrophy size={12} /> 추천
            </span>
          ) : null}
          {a.merged ? (
            <span className="tag-merged">
              <IconMerge size={12} /> 반영됨
            </span>
          ) : null}
        </div>
        <StatusPill status={a.status} check={a.check?.status} />
      </div>
      <div className="lane-sub">
        <AdapterBadge adapter={a.adapter} model={a.model} />
        <span className={`attempt ${(a.attempt ?? 1) > 1 ? "second" : ""}`}>
          시도 {a.attempt ?? 1}/{maxAttempts}
        </span>
      </div>

      <div className="lane-stats">
        <div className="ls">
          <span className="ls-l">시간</span>
          <span className={`ls-v mono ${active ? "ticking" : ""}`}>{fmtClock(elapsed)}</span>
        </div>
        <div className="ls">
          <span className="ls-l">토큰</span>
          <span className="ls-v mono" title={tokenBreakdown(a)}>
            {active && totalTokens(a) === 0 ? <span className="dim">—</span> : fmtTokens(totalTokens(a))}
          </span>
        </div>
        <div className="ls">
          <span className="ls-l">비용</span>
          <span className="ls-v mono" title={a.usage?.costUsd == null ? "이 CLI 는 비용을 알려 주지 않아요" : undefined}>
            {a.usage?.costUsd == null ? <span className="dim">{active ? "—" : "n/a"}</span> : fmtCost(a.usage.costUsd)}
          </span>
        </div>
        <div className="ls">
          <span className="ls-l">턴</span>
          <span className="ls-v mono">{a.turns || 0}</span>
        </div>
      </div>

      <EventLog events={a.events ?? []} startedAt={a.startedAt} active={active} worktree={a.worktree} />

      {a.summary && !active ? (
        <div className="lane-summary">
          <div className="section-l">마지막 메시지</div>
          <Clamp text={a.summary} />
        </div>
      ) : null}

      <div className="lane-results">
        <CheckRow agent={a} />
        <DiffRow agent={a} open={diffOpen} setOpen={setDiffOpen} />
      </div>

      {active ? (
        <div className="lane-actions">
          <button className="btn ghost sm" onClick={onCancel}>
            <IconStop size={13} /> 멈추기
          </button>
        </div>
      ) : (
        <div className="lane-pad" />
      )}
    </article>
  );
});

function Clamp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 170;
  return (
    <p className={long && !open ? "clamp" : ""} onClick={() => long && setOpen((o) => !o)} title={long && !open ? "전체 보기" : undefined}>
      {renderInlineCode(tidyMd(text))}
    </p>
  );
}

/** Agents answer in Markdown; keep inline code, drop bold markers and link targets. */
function tidyMd(s: string) {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function renderInlineCode(s: string) {
  const parts = s.split(/(`[^`]+`)/g);
  return parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : p));
}

// ---------------------------------------------------------------------------------------------- event log

function EventLog({ events, startedAt, active, worktree }: { events: AgentEvent[]; startedAt?: number; active: boolean; worktree?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [events.length]);

  // Web fonts and late layout can grow the log after the first scroll; keep it pinned while sticky.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const pin = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(pin);
    for (const c of Array.from(el.children)) ro.observe(c);
    ro.observe(el);
    document.fonts?.ready.then(pin);
    return () => ro.disconnect();
  }, [events.length]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (stick.current) setUnseen(false);
  };

  const jump = () => {
    const el = box.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stick.current = true;
    setUnseen(false);
  };

  return (
    <div className="log-wrap">
      <div className="log" ref={box} onScroll={onScroll} role="log" aria-live="off">
        {events.length === 0 ? (
          <div className="log-empty">{active ? "첫 이벤트를 기다리는 중…" : "기록된 이벤트가 없어요."}</div>
        ) : (
          events.map((e, i) => {
            const newAttempt = i > 0 && (e.attempt ?? 1) > (events[i - 1].attempt ?? 1);
            return (
              <div key={i}>
                {newAttempt ? <div className="ev-divider">시도 {e.attempt} · 자가 수정</div> : null}
                <EventLine e={e} startedAt={startedAt} worktree={worktree} />
              </div>
            );
          })
        )}
        {active ? (
          <div className="log-cursor">
            <span className="caret" />
          </div>
        ) : null}
      </div>
      {unseen ? (
        <button className="log-jump" onClick={jump}>
          새 이벤트 ↓
        </button>
      ) : null}
    </div>
  );
}

const PRIMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description"];

export function toolParts(text: string): { name: string; arg: string } {
  const sp = text.indexOf(" ");
  if (sp < 0) return { name: text, arg: "" };
  const name = text.slice(0, sp);
  let arg = text.slice(sp + 1).trim();
  // Codex on Windows wraps every command as `"...powershell.exe" -Command '<cmd>'` — show just <cmd>.
  const ps = /^"?[^"\s]*powershell(?:\.exe)?"?\s+-Command\s+(['"])([\s\S]*?)\1?$/i.exec(arg);
  if (ps) arg = ps[2].replace(/'$/, "");
  if (arg.startsWith("{")) {
    try {
      const obj = JSON.parse(arg) as Record<string, unknown>;
      const k = PRIMARY_KEYS.find((key) => typeof obj[key] === "string");
      if (k) {
        const rest = Object.keys(obj).filter((x) => x !== k);
        arg = String(obj[k]) + (rest.length ? `  (${rest.join(", ")})` : "");
      }
    } catch {
      // Input was clipped mid-JSON: still pull out the most useful field if it made it through.
      for (const key of PRIMARY_KEYS) {
        const m = new RegExp(String.raw`"${key}"\s*:\s*"((?:[^"\\]|\\.)*)"?`).exec(arg);
        if (m) {
          arg = m[1].replace(/\\\\/g, "\\");
          break;
        }
      }
    }
  }
  return { name, arg };
}

const EventLine = memo(function EventLine({ e: raw, startedAt, worktree }: { e: AgentEvent; startedAt?: number; worktree?: string }) {
  const e = worktree ? { ...raw, text: shortenPaths(raw.text, worktree) } : raw;
  const t = startedAt ? fmtClock(Math.max(0, e.ts - startedAt)) : "";
  let body: ReactNode;
  let cls = `ev ev-${e.kind}`;
  switch (e.kind) {
    case "tool": {
      const { name, arg } = toolParts(e.text);
      body = (
        <>
          <span className="tool-name">{name}</span>
          <span className="tool-arg">{arg}</span>
        </>
      );
      break;
    }
    case "text": {
      const thinking = e.text.startsWith("💭");
      if (thinking) cls += " thinking";
      body = renderInlineCode(tidyMd(thinking ? e.text.replace(/^💭\s*/, "") : e.text));
      break;
    }
    case "check": {
      const tone = /\bpassed\b/i.test(e.text) ? " pass" : /\bfailed\b/i.test(e.text) ? " fail" : "";
      cls += tone;
      body = (
        <>
          <IconTerminal size={12} />
          <span>{e.text}</span>
        </>
      );
      break;
    }
    default:
      body = e.text;
  }
  return (
    <div className={cls}>
      <span className="ev-t mono">{t}</span>
      <span className="ev-b">{body}</span>
    </div>
  );
});

// ---------------------------------------------------------------------------------------------- check / diff

function CheckRow({ agent: a }: { agent: AgentRun }) {
  const [open, setOpen] = useState(false);
  if (a.status === "checking")
    return (
      <div className="res-row">
        <span className="cbadge cb-running">
          <Spinner size={10} /> 검증 중…
        </span>
      </div>
    );
  if (!a.check || isActive(a)) return null;
  const hasOut = !!a.check.output;
  return (
    <div className="res">
      <button className="res-row" onClick={() => hasOut && setOpen((o) => !o)} disabled={!hasOut} aria-expanded={open}>
        <CheckBadge status={a.check.status} />
        {a.check.exitCode != null ? <span className="dim mono small">exit {a.check.exitCode}</span> : null}
        {a.check.durationMs != null ? <span className="dim mono small">{fmtDuration(a.check.durationMs)}</span> : null}
        <span className="grow" />
        {hasOut ? (
          <span className="res-toggle">
            출력 <IconChevron size={12} className={open ? "rot" : ""} />
          </span>
        ) : null}
      </button>
      {open ? <pre className={`check-out ${a.check.status === "failed" ? "failed" : ""}`}>{a.check.output}</pre> : null}
    </div>
  );
}

function DiffRow({ agent: a, open, setOpen }: { agent: AgentRun; open: boolean; setOpen: (fn: (o: boolean) => boolean) => void }) {
  const d = a.diff;
  if (!d || (isActive(a) && d.files === 0)) return null;
  if (d.files === 0)
    return (
      <div className="res-row static">
        <span className="dim small">변경 없음</span>
      </div>
    );
  const total = d.insertions + d.deletions || 1;
  const blocks = 5;
  const addBlocks = Math.round((d.insertions / total) * blocks);
  return (
    <div className="res">
      <button className="res-row" onClick={() => d.patch && setOpen((o) => !o)} disabled={!d.patch} aria-expanded={open}>
        <span className="diffstat mono">
          <IconFile size={13} />
          <span>파일 {d.files}개</span>
          <span className="add">+{d.insertions}</span>
          <span className="del">−{d.deletions}</span>
          <span className="blocks">
            {Array.from({ length: blocks }, (_, i) => (
              <i key={i} className={i < addBlocks ? "b-add" : "b-del"} />
            ))}
          </span>
        </span>
        <span className="grow" />
        {d.patch ? (
          <span className="res-toggle">
            변경 <IconChevron size={12} className={open ? "rot" : ""} />
          </span>
        ) : null}
      </button>
      {open ? <DiffView patch={d.patch} /> : null}
    </div>
  );
}

function DiffView({ patch }: { patch: string }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  return (
    <div className="diff">
      {files.map((f, i) => (
        <DiffFile key={i} f={f} />
      ))}
    </div>
  );
}

function DiffFile({ f }: { f: ReturnType<typeof parsePatch>[number] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="diff-file">
      <button className="diff-file-head" onClick={() => setOpen((o) => !o)}>
        <IconChevron size={12} className={open ? "rot" : ""} />
        <span className="mono path">{f.path}</span>
        <span className="grow" />
        <span className="add mono">+{f.add}</span>
        <span className="del mono">−{f.del}</span>
      </button>
      {open ? (
        <pre className="diff-body">
          {f.lines.map((l, i) => {
            const c = l.startsWith("@@") ? "dl-hunk" : l.startsWith("+") ? "dl-add" : l.startsWith("-") ? "dl-del" : "dl-ctx";
            return (
              <span key={i} className={`dl ${c}`}>
                {l || " "}
                {"\n"}
              </span>
            );
          })}
        </pre>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- scoreboard

function Scoreboard({ run, now, winner }: { run: Run; now: number; winner: string | null }) {
  return (
    <section className="panel scoreboard">
      <div className="panel-head">
        <h2>비교</h2>
        <span className="dim small hide-sm">같은 요청 · 같은 기준 커밋</span>
      </div>
      <div className="table-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>에이전트</th>
              <th>상태</th>
              <th className="num">시간</th>
              <th className="num">토큰</th>
              <th className="num">비용</th>
              <th className="num">변경</th>
              <th>검증</th>
            </tr>
          </thead>
          <tbody>
            {run.agents.map((a) => (
              <tr key={a.id} className={a.id === winner ? "win" : ""}>
                <td>
                  <span className="cell-agent">
                    <StatusDot status={a.status} check={a.check?.status} />
                    <span className="strong">{a.label}</span>
                    {a.id === winner ? <IconTrophy size={12} className="accent-ic" /> : null}
                  </span>
                </td>
                <td className="dim">{STATUS_KO[a.status] ?? a.status} · 시도 {a.attempt ?? 1}</td>
                <td className="num mono">{fmtDuration(agentElapsed(a, now))}</td>
                <td className="num mono">{fmtTokens(totalTokens(a))}</td>
                <td className="num mono">{a.usage?.costUsd == null ? <span className="dim">n/a</span> : fmtCost(a.usage.costUsd)}</td>
                <td className="num mono">
                  {a.diff?.files ? (
                    <>
                      <span className="add">+{a.diff.insertions}</span> <span className="del">−{a.diff.deletions}</span>
                    </>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td>{isActive(a) ? <span className="dim small">대기</span> : <CheckBadge status={a.check?.status ?? "skipped"} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
