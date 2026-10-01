import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRun, Api, Channel, ChatMessage } from "./api";
import { ReviewBox, TriageBlock, useLiveRun } from "./flow";
import { toolParts } from "./RunView";
import { IconChevron, IconSend, IconTrophy } from "./icons";
import { CheckBadge, Spinner, StatusPill } from "./ui";
import {
  RUN_STATE_KO,
  agentElapsed,
  clockTime,
  fmtClock,
  fmtCost,
  fmtTokens,
  isActive,
  runState,
  shortenPaths,
  suggestWinner,
  totalTokens,
  useNow,
  type User,
} from "./util";

const EXAMPLES = [
  "@willnew 버그 수정: duration 테스트 실패",
  "@willnew 테스트 작성: 환불 API 경계값",
  "@willnew 리팩터링: 날짜 포맷 함수 통합",
];

export function Chat({ api, user, channelId, go }: { api: Api; user: User; channelId: string; go: (p: string) => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const channel = channels.find((c) => c.id === channelId);

  useEffect(() => {
    api.channels().then(setChannels).catch((e: Error) => setError(e.message));
  }, [api]);

  useEffect(() => {
    setMessages(null);
    api
      .messages(channelId)
      .then(setMessages)
      .catch((e: Error) => setError(e.message));
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
  }, [api, channelId]);

  const sorted = useMemo(() => (messages ?? []).slice().sort((a, b) => a.ts - b.ts), [messages]);
  // The first willnew message about a run carries the live card; later ones are plain updates in the thread.
  const cardFor = useMemo(() => {
    const seen = new Set<string>();
    const out = new Set<string>();
    for (const m of sorted) if (m.runId && m.bot && !seen.has(m.runId)) {
      seen.add(m.runId);
      out.add(m.id);
    }
    return out;
  }, [sorted]);

  // Stay pinned to the newest message while run cards load and grow, unless the reader scrolled up.
  const stick = useRef(true);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stick.current = true;
  }, [channelId]);
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
  }, [channelId, messages === null]);

  const send = async (value = text) => {
    const v = value.trim();
    if (!v || sending) return;
    setSending(true);
    setError(null);
    try {
      const { message, reply } = await api.postMessage(channelId, user.name, v, user.team);
      setMessages((list) => {
        let cur = list ?? [];
        for (const m of [message, reply]) if (m && !cur.some((x) => x.id === m.id)) cur = [...cur, m];
        return cur;
      });
      setText("");
      stick.current = true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat">
      <aside className="channels">
        <div className="channels-h">채널</div>
        {channels.map((c) => (
          <a key={c.id} href={`#/chat/${c.id}`} className={`ch ${c.id === channelId ? "on" : ""}`}>
            <span className="ch-hash">#</span>
            <span>{c.name}</span>
          </a>
        ))}
      </aside>

      <section className="thread">
        <header className="thread-head">
          <div className="thread-title">
            <span className="ch-hash">#</span>
            {channel?.name ?? channelId}
          </div>
          <div className="ch-switch">
            {channels.map((c) => (
              <a key={c.id} href={`#/chat/${c.id}`} className={c.id === channelId ? "on" : ""}>
                #{c.name}
              </a>
            ))}
          </div>
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
            const grouped = prev && prev.user === m.user && m.ts - prev.ts < 5 * 60_000 && !cardFor.has(m.id);
            return <Message key={m.id} m={m} grouped={!!grouped} withCard={cardFor.has(m.id)} api={api} user={user} go={go} />;
          })}
          </div>
        </div>

        <div className="composer-wrap">
          {error ? <div className="composer-err">{error}</div> : null}
          {!text ? (
            <div className="examples">
              {EXAMPLES.map((e) => (
                <button key={e} className="example" onClick={() => setText(e)}>
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
            <textarea
              value={text}
              rows={1}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="@willnew 요청"
            />
            <button className="send" type="submit" disabled={!text.trim() || sending} aria-label="보내기">
              {sending ? <Spinner size={14} /> : <IconSend size={17} />}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function Avatar({ name, bot }: { name: string; bot: boolean }) {
  if (bot)
    return (
      <span className="avatar bot" aria-hidden>
        <BotMark />
      </span>
    );
  const hue = [...name].reduce((s, c) => s + c.charCodeAt(0), 0) % 5;
  return <span className={`avatar h${hue}`}>{name.slice(-2)}</span>;
}

export function BotMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="7" cy="9" r="2.6" fill="currentColor" />
      <circle cx="17" cy="9" r="2.6" fill="currentColor" opacity=".7" />
      <circle cx="12" cy="15.5" r="2.6" fill="currentColor" opacity=".85" />
      <path d="M7 9 12 15.5 17 9" stroke="currentColor" strokeWidth="1.4" opacity=".5" />
    </svg>
  );
}

function Message({ m, grouped, withCard, api, user, go }: { m: ChatMessage; grouped: boolean; withCard: boolean; api: Api; user: User; go: (p: string) => void }) {
  const html = useMemo(() => highlight(m.text), [m.text]);
  return (
    <div className={`msg ${grouped ? "grouped" : ""} ${m.bot ? "is-bot" : ""} ${m.kind ? `k-${m.kind}` : ""}`}>
      <div className="msg-gutter">{grouped ? <span className="msg-time-s">{clockTime(m.ts)}</span> : <Avatar name={m.user} bot={m.bot} />}</div>
      <div className="msg-body">
        {!grouped ? (
          <div className="msg-head">
            <span className="msg-user">{m.bot ? "willnew" : m.user}</span>
            {m.bot ? <span className="bot-tag">AI</span> : null}
            <span className="msg-time">{clockTime(m.ts)}</span>
          </div>
        ) : null}
        <div className="msg-text">{html}</div>
        {withCard && m.runId ? <RunCard api={api} id={m.runId} user={user} go={go} /> : null}
        {!withCard && m.runId && m.bot ? (
          <button className="msg-link" onClick={() => go(`/requests/${m.runId}`)}>
            요청 {m.runId} 보기 <IconChevron size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function highlight(text: string) {
  return text.split(/(@willnew|`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) =>
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
  );
}

// ---------------------------------------------------------------------------------------------- run card

function RunCard({ api, id, user, go }: { api: Api; id: string; user: User; go: (p: string) => void }) {
  const { run, setRun, error } = useLiveRun(api, id);
  const active = !!run?.agents.some(isActive);
  const now = useNow(1000, active);
  if (error && !run) return <div className="card-err">불러오기 실패 · {error}</div>;
  if (!run)
    return (
      <div className="runcard-chat loading-card">
        <Spinner size={12} />
      </div>
    );
  const state = runState(run);
  const winner = suggestWinner(run);
  return (
    <div className={`runcard-chat st-${state}`}>
      <div className="rc-head">
        <div className="rc-title">{run.triage?.title ?? run.title}</div>
        <span className={`state-pill s-${state}`}>
          {state === "active" ? <Spinner size={10} /> : null}
          {RUN_STATE_KO[state]}
        </span>
      </div>
      <TriageBlock run={run} compact />
      {run.agents.length ? (
        <div className="minilanes">
          {run.agents.map((a) => (
            <MiniLane key={a.id} a={a} now={now} maxAttempts={run.maxAttempts} winner={a.id === winner} />
          ))}
        </div>
      ) : null}
      <ReviewBox api={api} run={run} user={user} onChange={setRun} />
      <button className="rc-more" onClick={() => go(`/requests/${run.id}`)}>
        실행 기록 · 변경 내용 보기 <IconChevron size={12} />
      </button>
    </div>
  );
}

function lastEvent(a: AgentRun) {
  const ev = [...(a.events ?? [])].reverse().find((e) => e.kind !== "status");
  if (!ev) return "";
  const t = shortenPaths(ev.text, a.worktree).replace(/\s+/g, " ").replace(/`/g, "");
  if (ev.kind === "tool") {
    const { name, arg } = toolParts(t);
    return `${name} ${arg}`;
  }
  return t;
}

function MiniLane({ a, now, maxAttempts, winner }: { a: AgentRun; now: number; maxAttempts: number; winner: boolean }) {
  const active = isActive(a);
  const selfFix = a.status === "retrying" || (a.attempt > 1 && active);
  return (
    <div className={`mini ${winner ? "win" : ""} ${selfFix ? "selffix" : ""}`}>
      <div className="mini-top">
        <span className="mini-label">{a.label}</span>
        {winner ? (
          <span className="tag-win">
            <IconTrophy size={11} /> 추천
          </span>
        ) : null}
        <span className={`attempt ${a.attempt > 1 ? "second" : ""}`}>
          시도 {a.attempt ?? 1}/{maxAttempts}
        </span>
        <span className="grow" />
        {!active && a.status === "done" ? <CheckBadge status={a.check?.status ?? "skipped"} /> : <StatusPill status={a.status} check={a.check?.status} />}
      </div>
      <div className="mini-stats mono">
        <span>{fmtClock(agentElapsed(a, now))}</span>
        {totalTokens(a) > 0 ? <span>{fmtTokens(totalTokens(a))} tok</span> : null}
        {a.usage?.costUsd != null ? <span>{fmtCost(a.usage.costUsd)}</span> : !active ? <span>비용 n/a</span> : null}
        {a.diff?.files ? (
          <span>
            <span className="add">+{a.diff.insertions}</span> <span className="del">−{a.diff.deletions}</span>
          </span>
        ) : null}
      </div>
      {active || selfFix ? <div className={`mini-last ${a.status === "retrying" ? "fixing" : ""}`}>{selfFix && a.status === "retrying" ? "검증 실패 — 로그를 읽고 스스로 고치는 중" : lastEvent(a)}</div> : null}
    </div>
  );
}
