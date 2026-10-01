/** 팀 채널 — @willnew 로 맡기면 진행 카드가 스레드에 붙고, 거기서 바로 승인한다. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Api, Channel, ChatMessage, Run } from "./api";
import { useLiveRun } from "./flow";
import { AgentMark, IconChevron, IconLink, IconSend, Logo } from "./icons";
import { Avatar, MiniRail, Modal, Rail, Spinner, Tag, agentState, useToast } from "./ui";
import { clockTime, fmtCost, fmtDuration, isActive, suggestWinner, useNow, type User } from "./util";

const EXAMPLES = ["@willnew 버그 수정: duration 테스트 실패", "@willnew 테스트 작성: 환불 API 경계값", "@willnew 리팩터링: 날짜 포맷 함수 통합"];

export function Chat({ api, user, channelId, runs, go }: { api: Api; user: User; channelId: string; runs: Run[] | null; go: (p: string) => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const channel = channels.find((c) => c.id === channelId);

  useEffect(() => {
    api.channels().then(setChannels).catch((e: Error) => toast(e.message, "err"));
  }, [api, toast]);

  useEffect(() => {
    setMessages(null);
    stick.current = true;
    api.messages(channelId).then(setMessages).catch((e: Error) => toast(e.message, "err"));
    return api.subscribeChannel(channelId, (m) =>
      setMessages((list) => {
        const cur = list ?? [];
        const i = cur.findIndex((x) => x.id === m.id);
        if (i >= 0) {
          const next = cur.slice();
          next[i] = m;
          return next;
        }
        return [...cur, m];
      }),
    );
  }, [api, channelId, toast]);

  const sorted = useMemo(() => (messages ?? []).slice().sort((a, b) => a.ts - b.ts), [messages]);
  const cardFor = useMemo(() => {
    const seen = new Set<string>();
    const out = new Set<string>();
    for (const m of sorted)
      if (m.runId && m.bot && !seen.has(m.runId)) {
        seen.add(m.runId);
        out.add(m.id);
      }
    return out;
  }, [sorted]);

  useEffect(() => {
    const el = scroller.current;
    const content = inner.current;
    if (!el || !content) return;
    const pin = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(pin);
    ro.observe(content);
    pin();
    return () => ro.disconnect();
  }, [channelId, messages === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (value = text) => {
    const v = value.trim();
    if (!v || sending) return;
    setSending(true);
    try {
      const { message } = await api.postMessage(channelId, user.name, v, user.team);
      setMessages((list) => (list && !list.some((x) => x.id === message.id) ? [...list, message] : list));
      setText("");
      stick.current = true;
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSending(false);
    }
  };

  const mine = (runs ?? []).filter((r) => r.channel === channelId);
  const week = mine.filter((r) => r.createdAt > Date.now() - 7 * 86400_000);
  const resolved = week.filter((r) => r.agents.some((a) => a.status === "done" && a.check.status !== "failed")).length;
  const cost = week.reduce((s, r) => s + r.agents.reduce((x, a) => x + (a.usage.costUsd ?? 0), 0), 0);

  return (
    <div className="chat">
      <nav className="chat-nav" aria-label="채널">
        <span className="lab">채널</span>
        {channels.map((c) => (
          <a key={c.id} href={`#/chat/${c.id}`} className={`ch ${c.id === channelId ? "on" : ""}`} aria-current={c.id === channelId ? "page" : undefined}>
            <span className="hash">#</span>
            {c.name}
            {(runs ?? []).some((r) => r.channel === c.id && r.review.status === "pending") ? <span className="ch-dot" title="검토 차례" /> : null}
          </a>
        ))}
        <span className="lab" style={{ marginTop: 18 }}>
          연결
        </span>
        <span className="ch dim" title="Slack 앱 연동은 준비 중이에요">
          <IconLink size={14} /> Slack 연결 · 준비 중
        </span>
      </nav>

      <section className="thread">
        <header className="thread-head">
          <h1># {channel?.name ?? channelId}</h1>
          {channel ? <span className="dim small">{channel.topic}</span> : null}
        </header>
        <div
          className="stream"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="stream-inner" ref={inner}>
            {!messages ? (
              <div className="loading">
                <Spinner size={14} /> 불러오는 중
              </div>
            ) : null}
            {sorted.map((m, i) => {
              const prev = sorted[i - 1];
              const grouped = !!prev && prev.user === m.user && m.ts - prev.ts < 5 * 60_000 && !cardFor.has(m.id);
              return <Message key={m.id} m={m} grouped={grouped} withCard={cardFor.has(m.id)} api={api} user={user} go={go} />;
            })}
          </div>
        </div>
        <div className="composer-wrap">
          {!text ? (
            <div className="examples">
              {EXAMPLES.map((e) => (
                <button key={e} className="chip" onClick={() => setText(e)}>
                  {e}
                </button>
              ))}
            </div>
          ) : null}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label htmlFor="msg" className="sr">
              메시지
            </label>
            <textarea
              id="msg"
              value={text}
              rows={1}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="@willnew 로 시작하면 맡겨져요"
            />
            <button className="ib" type="submit" disabled={!text.trim() || sending} aria-label="보내기">
              {sending ? <Spinner size={14} /> : <IconSend size={17} />}
            </button>
          </form>
        </div>
      </section>

      <aside className="chat-side" aria-label="이 채널에서 맡긴 일">
        <span className="lab">이 채널에서 맡긴 일</span>
        <div className="side-list">
          {mine.slice(0, 6).map((r) => (
            <a key={r.id} className={`row ${r.review.status === "pending" ? "turn" : ""}`} href={`#/runs/${r.id}`}>
              <span className="row-title">{r.triage?.title ?? r.title}</span>
              <span className="row-meta">
                <MiniRail run={r} />
                {r.review.status === "pending" ? "내 차례" : r.review.status === "approved" ? "병합됨" : r.review.status === "rejected" ? "반려" : r.agents.some(isActive) ? "진행 중" : "끝남"}
              </span>
            </a>
          ))}
          {!mine.length ? <span className="dim small">아직 없어요</span> : null}
        </div>
        <span className="lab" style={{ marginTop: 20 }}>
          이번 주 #{channel?.name ?? channelId}
        </span>
        <div className="tiles">
          <div className="tile">
            <b className="mono">{week.length}</b>
            <span>맡긴 일</span>
          </div>
          <div className="tile">
            <b className="mono">{week.length ? `${Math.round((resolved / week.length) * 100)}%` : "—"}</b>
            <span>자동 해결</span>
          </div>
          <div className="tile">
            <b className="mono">{fmtCost(cost)}</b>
            <span>비용</span>
          </div>
          <div className="tile">
            <b className="mono">{week.filter((r) => r.review.status === "approved").length}</b>
            <span>병합</span>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Message({ m, grouped, withCard, api, user, go }: { m: ChatMessage; grouped: boolean; withCard: boolean; api: Api; user: User; go: (p: string) => void }) {
  return (
    <div className={`msg ${grouped ? "grouped" : ""} ${m.bot ? "bot" : ""}`}>
      <div className="msg-gutter">
        {grouped ? null : m.bot ? (
          <span className="avatar bot" aria-hidden>
            <Logo size={20} />
          </span>
        ) : (
          <Avatar name={m.user} size={36} />
        )}
      </div>
      <div className="msg-body">
        {!grouped ? (
          <div className="msg-head">
            <b>{m.bot ? "willnew" : m.user}</b>
            <span className="dim small">{clockTime(m.ts)}</span>
          </div>
        ) : null}
        <div className="msg-text">{highlight(m.text)}</div>
        {withCard && m.runId ? <RunCard api={api} id={m.runId} user={user} go={go} /> : null}
        {!withCard && m.runId && m.bot ? (
          <a className="msg-link" href={`#/runs/${m.runId}`}>
            작업 공간에서 보기 <IconChevron size={12} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function highlight(text: string) {
  return text.split("\n").map((line, li) => (
    <span key={li} className="msg-line">
      {line.split(/(@willnew|`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <b key={i}>{p.slice(2, -2)}</b>
        ) : p === "@willnew" ? (
          <span key={i} className="mention">
            @willnew
          </span>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i}>{p.slice(1, -1)}</code>
        ) : (
          p
        ),
      )}
    </span>
  ));
}

function RunCard({ api, id, user, go }: { api: Api; id: string; user: User; go: (p: string) => void }) {
  const { run } = useLiveRun(api, id);
  const toast = useToast();
  const active = !!run?.agents.some(isActive);
  const now = useNow(1000, active);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!run)
    return (
      <div className="runcard loading">
        <Spinner size={12} />
      </div>
    );
  const winner = suggestWinner(run);
  const cost = run.agents.reduce((s, a) => s + (a.usage.costUsd ?? 0), 0) + (run.triage?.costUsd ?? 0);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const r = await api.review(run.id, { decision, agentId: decision === "approve" ? winner ?? undefined : undefined, reviewer: user.name, comment: decision === "reject" ? reason.trim() : undefined });
      toast(r.message, "ok");
      setRejecting(false);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`runcard ${run.review.status === "pending" ? "turn" : ""}`}>
      <div className="rc-head">
        <b>{run.triage?.title ?? run.title}</b>
        <span className="mono dim small">
          {fmtDuration(run.agents.length ? Math.max(...run.agents.map((a) => (a.endedAt ?? now) - (a.startedAt ?? run.createdAt))) : 0)} · {fmtCost(cost)}
        </span>
      </div>
      <Rail run={run} now={now} />
      <div className="rc-agents">
        {run.agents.map((a) => {
          const st = agentState(a, run.maxAttempts);
          return (
            <div key={a.id} className="rc-agent">
              <AgentMark adapter={a.adapter} size={20} />
              {a.label}
              {a.id === winner ? <Tag tone="now">추천</Tag> : null}
              <span className={`mono small rc-res ${st.tone ?? ""}`}>
                {st.text}
                {a.durationMs && !isActive(a) ? ` · ${fmtDuration(a.durationMs)}` : ""}
                {a.usage.costUsd != null && !isActive(a) ? ` · ${fmtCost(a.usage.costUsd)}` : ""}
              </span>
            </div>
          );
        })}
      </div>
      <div className="row-btns">
        {run.review.status === "pending" ? (
          <>
            <button className="btn m" disabled={busy} onClick={() => decide("approve")}>
              승인하고 병합
            </button>
            <button className="btn" onClick={() => go(`/runs/${run.id}/review`)}>
              변경 보기
            </button>
            <button className="btn q" onClick={() => setRejecting(true)}>
              반려
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => go(`/runs/${run.id}`)}>
            작업 공간에서 보기
          </button>
        )}
      </div>
      {rejecting ? (
        <Modal title="반려할까요?" confirmLabel="반려" danger busy={busy} disabled={!reason.trim()} onClose={() => setRejecting(false)} onConfirm={() => decide("reject")}>
          <label className="field">
            <span>사유 — 이 채널에 그대로 남아요</span>
            <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
