/**
 * 팀 채널. 커뮤니티 채팅처럼 읽힌다: 왼쪽 채널 목록(묶음, 안 읽음 점, 나를 부른 수), 가운데 메시지(작성자별 묶음, 날짜 줄,
 * 새 메시지 줄, 반응, 호버 동작 줄), 오른쪽은 스레드 또는 멤버.
 * @willnew 로 맡기면 요청이 생기고, 요청에 대한 말은 전부 그 카드의 스레드에 산다. 채널에는 요청한 메시지, 카드(embed),
 * 그 아래 "답글 n개, 마지막 3분 전" 한 줄만 남는다. 스레드 칸에는 자기 입력칸이 있고 "채널에도 보내기" 를 고를 수 있다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type ReactNode, type RefObject } from "react";
import type { Api, Channel, ChatMessage, Member, Request, Run, ThreadSummary } from "./api";
import { ReviewActions } from "./Decision";
import { useLiveRequest, useLiveRun } from "./flow";
import { AgentMark, IconChevron, IconExternal, IconLink, IconList, IconMore, IconPlus, IconSend, IconSmile, IconThread, IconUsers, IconX, Logo } from "./icons";
import { DEMO_DESIGN_REQUEST, DEMO_REQUEST } from "./demo";
import { RequestEmbed, RequestView, reqHeadline, runProgress, PhaseTrack } from "./Request";
import { Moon, runPhase } from "./moon";
import { groupOrder, nameColor, roleFamily } from "./people";
import { ShipRow } from "./Ship";
import { mentionsOf } from "../../src/server/threads";
import { Avatar, ErrorBox, LinkChip, Spinner, Tag, agentState, useOutside, useToast } from "./ui";
import { clockTime, fmtCost, fmtDuration, isActive, relTime, useMedia, useNow, type User } from "./util";

const EXAMPLES = ["@willnew 버그 수정: duration 테스트 실패", "@willnew 테스트 작성: 환불 API 경계값", "@willnew 리팩터링: 날짜 포맷 함수 통합"];
/** 반응은 사용자 콘텐츠다. UI 글자에는 이모지를 쓰지 않는다 */
const REACTIONS = ["👍", "✅", "👀"];
const GROUP_MS = 5 * 60_000;
const OPENED = Date.now();
/** 처음 보는 채널과 스레드는 최근 20분을 새 메시지로 본다 */
const DEFAULT_SEEN = OPENED - 20 * 60_000;

/** 스레드 칸에 여는 것: 뿌리 메시지 id. 요청 카드면 요청, 바로 맡긴 일의 카드면 run 도 같이 */
type Thread = { id: string; request?: string; run?: string };
type Mode = "request" | "direct";
/** 요청 카드의 스레드 id 는 req-<요청 id> */
const targetOf = (id: string, run?: string): Thread => (id.startsWith("req-") ? { id, request: id.slice(4) } : { id, run });

// ---------------------------------------------------------------------------------------------- seen / unread

const SEEN_KEY = "willnew.seen";
const THREAD_SEEN_KEY = "willnew.seen.threads";
const CATS_KEY = "willnew.cats.closed";
const MEMBERS_KEY = "willnew.members";
function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}
const seenOf = (ch: string) => readJson<Record<string, number>>(SEEN_KEY, {})[ch] ?? DEFAULT_SEEN;
const markSeen = (ch: string, ts = Date.now()) => writeJson(SEEN_KEY, { ...readJson<Record<string, number>>(SEEN_KEY, {}), [ch]: ts });

const textOf = (m: ChatMessage, user: User) => (m.bodies ? (user.role === "requester" ? m.bodies.forRequester : m.bodies.forDeveloper) : m.text);
const mentionsMe = (m: ChatMessage, user: User) => m.user !== user.name && textOf(m, user).includes(`@${user.name}`);

/** 스레드마다 읽은 시각. 열어 둔 동안은 읽은 것으로 */
function useThreadSeen() {
  const [seen, setSeen] = useState<Record<string, number>>(() => readJson(THREAD_SEEN_KEY, {}));
  const mark = useCallback((id: string) => {
    setSeen((cur) => {
      const next = { ...cur, [id]: Date.now() };
      writeJson(THREAD_SEEN_KEY, next);
      return next;
    });
  }, []);
  return { seen, mark };
}

/** 한 스레드에서 나에게 새로 온 답글 수와 나를 부른 수 */
function threadUnread(sum: ThreadSummary | undefined, seen: number | undefined, me: string) {
  if (!sum) return { n: 0, mentions: 0 };
  const fresh = sum.replies.filter((r) => r.ts > (seen ?? DEFAULT_SEEN) && r.user !== me);
  return { n: fresh.length, mentions: fresh.filter((r) => r.mentions.includes(me)).length };
}

/** 지금 보고 있지 않은 채널마다: 새 메시지 수와 나를 부른 수 (스레드에서 부른 것도 센다) */
function useUnread(api: Api, channels: Channel[], current: string, user: User) {
  const [state, setState] = useState<Record<string, { n: number; mentions: number }>>({});
  useEffect(() => {
    if (!channels.length) return;
    let alive = true;
    const run = async () => {
      const out: Record<string, { n: number; mentions: number }> = {};
      await Promise.all(
        channels
          .filter((c) => c.id !== current)
          .map(async (c) => {
            const [list, threads] = await Promise.all([api.messages(c.id).catch(() => [] as ChatMessage[]), api.threads(c.id).catch(() => [] as ThreadSummary[])]);
            const since = seenOf(c.id);
            const fresh = list.filter((m) => m.ts > since && m.user !== user.name);
            const inThreads = threads.reduce((s, t) => s + t.replies.filter((r) => r.ts > since && r.user !== user.name && r.mentions.includes(user.name)).length, 0);
            out[c.id] = { n: fresh.length, mentions: fresh.filter((m) => mentionsMe(m, user)).length + inThreads };
          }),
      );
      if (alive) setState(out);
    };
    void run();
    const t = setInterval(run, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, channels, current, user]);
  return state;
}

function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const t = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(t) - day(d)) / 86_400_000);
  if (diff === 0) return "오늘";
  if (diff === 1) return "어제";
  return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}

/** 스레드 요약에 답글 하나를 더한다 (채널 스트림으로 온 답글) */
function addReply(cur: ThreadSummary | undefined, m: ChatMessage): ThreadSummary {
  const mentions = mentionsOf(m);
  const name = m.bot ? "willnew" : m.user;
  const replies = cur?.replies.some((r) => r.ts === m.ts && r.user === name) ? cur.replies : [...(cur?.replies ?? []), { ts: m.ts, user: name, mentions }];
  const users = [{ name, avatar: m.bot ? undefined : m.userAvatar, bot: m.bot || undefined }, ...(cur?.users ?? []).filter((u) => u.name !== name)].slice(0, 3);
  return { id: m.threadId!, count: replies.length, lastTs: Math.max(cur?.lastTs ?? 0, m.ts), users, replies };
}

// ---------------------------------------------------------------------------------------------- the channel

export function Chat({ api, user, channelId, focus, runs, requests, go, deployTracked, onCompose, me }: {
  api: Api;
  user: User;
  channelId: string;
  focus?: string;
  runs: Run[] | null;
  requests?: Request[] | null;
  go: (p: string) => void;
  deployTracked?: boolean;
  onCompose?: (mode: Mode) => void;
  me?: ReactNode;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadSummary>>({});
  const [local, setLocal] = useState<ChatMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [busyReqs, setBusyReqs] = useState<string[]>([]);
  const onWorking = useCallback((id: string, on: boolean) => setBusyReqs((cur) => (on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id))), []);
  const phone = !useMedia("(min-width: 768px)");
  // 넓은 화면에서는 멤버 칸이 기본으로 열려 있다. 좁으면 덮는 칸이라 닫아 둔다
  const [membersOpen, setMembersOpen] = useState(() => window.innerWidth >= 1180 && readJson<boolean>(MEMBERS_KEY, true));
  const [drawer, setDrawer] = useState(false);
  const [since] = useState(() => seenOf(channelId));
  const { seen: threadSeen, mark: markThread } = useThreadSeen();
  const toast = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(!focus);
  const lastTop = useRef(0);
  const channel = channels.find((c) => c.id === channelId);
  const unread = useUnread(api, channels, channelId, user);
  const now = useNow(30_000);

  useEffect(() => {
    api.channels().then(setChannels).catch((e: Error) => toast(e.message, "err"));
  }, [api, toast]);

  const load = useCallback(() => {
    setLoadError(null);
    api.messages(channelId).then(setMessages).catch((e: Error) => setLoadError(e.message));
    api.threads(channelId).then((list) => setThreads(Object.fromEntries(list.map((t) => [t.id, t])))).catch(() => undefined);
  }, [api, channelId]);

  useEffect(() => {
    load();
    const upsert = (m: ChatMessage) =>
      setMessages((list) => {
        const cur = list ?? [];
        const i = cur.findIndex((x) => x.id === m.id);
        if (i >= 0) {
          const next = cur.slice();
          next[i] = m;
          return next;
        }
        return [...cur, m];
      });
    return api.subscribeChannel(channelId, (m) => {
      // 스레드 답글은 뿌리 아래 한 줄(요약)만 바뀐다. 채널에도 보낸 답글은 채널에도 보인다
      if (m.threadId) setThreads((cur) => ({ ...cur, [m.threadId!]: addReply(cur[m.threadId!], m) }));
      if (!m.threadId || m.broadcast) upsert(m);
    });
  }, [api, channelId, load]);

  // 보고 있는 동안은 읽은 것으로
  useEffect(() => {
    if (messages) markSeen(channelId);
    return () => markSeen(channelId);
  }, [messages, channelId]);

  const sorted = useMemo(() => [...(messages ?? []), ...local].sort((a, b) => a.ts - b.ts), [messages, local]);
  /** 바로 맡긴 run 의 카드는 그 run 을 처음 말한 봇 메시지 아래 한 번만 */
  const cardFor = useMemo(() => {
    const seen = new Set<string>();
    const out = new Set<string>();
    for (const m of sorted)
      if (m.runId && m.bot && !m.requestId && !m.threadId && !seen.has(m.runId)) {
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

  // 링크로 들어온 메시지로 이동
  useEffect(() => {
    if (!focus || !messages) return;
    const el = document.getElementById(`m-${focus}`);
    el?.scrollIntoView({ block: "center" });
  }, [focus, messages === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const react = async (m: ChatMessage, emoji: string) => {
    try {
      const next = await api.react(channelId, m.id, emoji, user.name);
      setMessages((list) => (list ?? []).map((x) => (x.id === next.id ? next : x)));
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  /** /상태: 이 채널의 열린 요청을 나에게만 보여 준다 */
  const status = () => {
    const open = (requests ?? []).filter((r) => r.channel === channelId && !["merged", "deployed", "closed", "declined", "cancelled"].includes(r.status));
    const mine = open.filter((r) => r.requester === user.name || (user.role !== "requester" && (r.reviewer === user.name || !r.reviewer)));
    const text = mine.length ? `열린 요청 ${mine.length}개\n${mine.map((r) => `- ${r.title}: ${reqHeadline(r, user)}`).join("\n")}` : "이 채널에 열린 요청이 없어요";
    setLocal((l) => [...l, { id: `local-${Date.now()}`, channel: channelId, ts: Date.now(), user: "willnew", bot: true, text, kind: "result" }]);
    stick.current = true;
  };

  const byCat = useMemo(() => {
    const out = new Map<string, Channel[]>();
    for (const c of channels) out.set(c.category ?? "채널", [...(out.get(c.category ?? "채널") ?? []), c]);
    return [...out];
  }, [channels]);

  // AI가 정리하는 중이면 입력칸 위에 한 줄
  const typing = busyReqs.length > 0 || (runs ?? []).some((r) => r.channel === channelId && ["new", "plan"].includes(runPhase(r).phase));

  const right = thread ? "thread" : membersOpen ? "members" : null;
  const toggleMembers = () => {
    const next = !!thread || !membersOpen;
    setThread(null);
    setMembersOpen(next);
    if (!phone) writeJson(MEMBERS_KEY, next);
  };
  const openThread = useCallback((t: Thread) => {
    setThread(t);
    markThread(t.id);
  }, [markThread]);

  // 날짜 줄, 새 메시지 줄, 작성자 묶음
  const rows: ReactNode[] = [];
  let lastDay = "";
  let newShown = false;
  sorted.forEach((m, i) => {
    const prev = sorted[i - 1];
    const day = dayLabel(m.ts);
    let broke = false;
    if (day !== lastDay) {
      rows.push(
        <div key={`d-${m.id}`} className="divider" role="separator">
          <span>{day}</span>
        </div>,
      );
      lastDay = day;
      broke = true;
    }
    if (!newShown && m.ts > since && m.user !== user.name && !m.id.startsWith("local-") && i > 0) {
      rows.push(
        <div key="new" className="divider new" role="separator">
          <span>새 메시지</span>
        </div>,
      );
      newShown = true;
      broke = true;
    }
    const card = m.kind === "request" && !!m.requestId;
    const prevCard = prev?.kind === "request" && !!prev?.requestId;
    // 답글이 달린 메시지 다음 줄은 묶지 않는다 (요약 줄이 사이에 있다)
    const prevThreaded = !!prev && !!threads[prev.id];
    const grouped = !broke && !!prev && !card && !prevCard && !prevThreaded && !m.broadcast && prev.user === m.user && prev.bot === m.bot && m.ts - prev.ts < GROUP_MS && !cardFor.has(m.id);
    const sum = threads[m.id];
    rows.push(
      <Message
        key={m.id}
        m={m}
        grouped={grouped}
        cardHost={cardFor.has(m.id)}
        api={api}
        user={user}
        channelId={channelId}
        go={go}
        focus={focus === m.id}
        deployTracked={deployTracked}
        onThread={openThread}
        onReact={react}
        onWorking={onWorking}
        ephemeral={m.id.startsWith("local-")}
        footer={sum ? <ThreadFooter sum={sum} unread={threadUnread(sum, threadSeen[sum.id], user.name)} now={now} open={thread?.id === sum.id} onOpen={() => openThread(targetOf(m.id, cardFor.has(m.id) ? m.runId : undefined))} /> : null}
      />,
    );
  });

  const nav = (
    <nav className={`chat-nav ${drawer ? "open" : ""}`} aria-label="채널">
      <div className="nav-head">
        <span className="t-title">채널</span>
        {phone ? (
          <button className="ib sm" aria-label="닫기" onClick={() => setDrawer(false)}>
            <IconX size={16} />
          </button>
        ) : null}
      </div>
      <Categories byCat={byCat} current={channelId} unread={unread} onPick={() => setDrawer(false)} />
      <div className="cat">
        <span className="cat-h static">연결</span>
        <span className="ch dim" title="Slack 앱 연동은 준비 중이에요">
          <IconLink size={14} /> Slack 연결 준비 중
        </span>
      </div>
    </nav>
  );

  return (
    <div className={`chat ${right ? `with-${right}` : ""} ${user.role === "requester" ? "reader" : ""}`}>
      {nav}
      {drawer ? <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden /> : null}

      <section className="room">
        <header className="chat-head">
          <button className="ib only-phone" aria-label="채널 목록" onClick={() => setDrawer(true)}>
            <IconList size={18} />
          </button>
          <h1>
            <span className="hash">#</span>
            {channel?.name ?? channelId}
          </h1>
          {channel ? <span className="chat-topic">{channel.topic}</span> : null}
          <span className="grow" />
          <button className="ib" aria-pressed={right === "members"} aria-label="멤버" title="멤버" onClick={toggleMembers}>
            <IconUsers size={18} />
          </button>
          {me ? <span className="only-phone">{me}</span> : null}
        </header>
        <div
          className="stream"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 맨 아래 근처면 따라가고, 사람이 위로 올렸을 때만 멈춘다 (스크롤 앵커링이 내리는 건 무시)
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (near) stick.current = true;
            else if (el.scrollTop < lastTop.current - 1) stick.current = false;
            lastTop.current = el.scrollTop;
          }}
        >
          <div className="stream-inner" ref={inner}>
            {!messages && loadError ? <ErrorBox error={`불러오기 실패 · ${loadError}`} onRetry={load} /> : null}
            {!messages && !loadError ? (
              <div className="msg-skel" aria-busy>
                <div className="skel" />
                <div className="skel" />
                <div className="skel" />
              </div>
            ) : null}
            {messages && !sorted.length ? (
              <div className="room-empty">
                <b className="t-title"># {channel?.name ?? channelId} 의 첫 메시지</b>
                <p>@willnew 로 한 줄 남기면 AI가 정리해서 개발자에게 넘겨요</p>
              </div>
            ) : null}
            {rows}
          </div>
        </div>
        <Composer api={api} user={user} channelId={channelId} channel={channel} typing={typing} onCompose={onCompose} onStatus={status} onSent={(m) => { setMessages((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list)); stick.current = true; }} />
      </section>

      {thread ? (
        <ThreadPanel
          key={thread.id}
          api={api}
          channelId={channelId}
          channel={channel}
          target={thread}
          user={user}
          root={sorted.find((m) => m.id === thread.id)}
          channelMessages={sorted}
          deployTracked={deployTracked}
          go={go}
          onClose={() => setThread(null)}
          onThread={openThread}
          onSeen={() => markThread(thread.id)}
        />
      ) : membersOpen ? (
        <MemberPanel api={api} channelId={channelId} user={user} requests={requests} runs={runs} onClose={toggleMembers} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- sidebar

function Categories({ byCat, current, unread, onPick }: { byCat: [string, Channel[]][]; current: string; unread: Record<string, { n: number; mentions: number }>; onPick: () => void }) {
  const [closed, setClosed] = useState<string[]>(() => readJson<string[]>(CATS_KEY, []));
  const toggle = (c: string) =>
    setClosed((cur) => {
      const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c];
      writeJson(CATS_KEY, next);
      return next;
    });
  return (
    <>
      {byCat.map(([cat, list]) => {
        const shut = closed.includes(cat);
        // 접힌 묶음에서도 지금 채널과 안 읽은 채널은 보인다
        const shown = shut ? list.filter((c) => c.id === current || unread[c.id]?.n || unread[c.id]?.mentions) : list;
        return (
          <div key={cat} className="cat">
            <button className="cat-h" aria-expanded={!shut} onClick={() => toggle(cat)}>
              <IconChevron size={12} />
              {cat}
            </button>
            {shown.map((c) => {
              const u = unread[c.id];
              const on = c.id === current;
              return (
                <a key={c.id} href={`#/chat/${c.id}`} onClick={onPick} className={`ch ${on ? "on" : ""} ${!on && (u?.n || u?.mentions) ? "unread" : ""}`} aria-current={on ? "page" : undefined}>
                  <span className="hash" aria-hidden>
                    #
                  </span>
                  <span className="ch-name">{c.name}</span>
                  {!on && u?.mentions ? (
                    <span className="ch-badge mono" aria-label={`나를 부른 메시지 ${u.mentions}개`}>
                      {u.mentions}
                    </span>
                  ) : !on && u?.n ? (
                    <span className="sr">새 메시지 {u.n}개</span>
                  ) : null}
                </a>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- thread footer

/** 뿌리 메시지 아래 한 줄: 아바타 셋, 답글 n개, 마지막 답글 시각. 새 답글은 굵게, 나를 부른 답글이 있으면 액센트 배지 */
function ThreadFooter({ sum, unread, now, open, onOpen }: { sum: ThreadSummary; unread: { n: number; mentions: number }; now: number; open?: boolean; onOpen: () => void }) {
  return (
    <button className={`tfoot ${unread.n ? "fresh" : ""} ${open ? "on" : ""}`} onClick={onOpen} aria-label={`스레드 열기, 답글 ${sum.count}개${unread.n ? `, 새 답글 ${unread.n}개` : ""}${unread.mentions ? `, 나를 부른 답글 ${unread.mentions}개` : ""}`}>
      <span className="tfoot-av" aria-hidden>
        {sum.users.map((u) =>
          u.bot ? (
            <span key={u.name} className="avatar bot" style={{ width: 20, height: 20 }}>
              <Logo size={12} />
            </span>
          ) : (
            <Avatar key={u.name} name={u.name} size={20} src={u.avatar} />
          ),
        )}
      </span>
      <span className="tfoot-n">답글 {sum.count}개</span>
      {unread.n ? <span className="tfoot-new">새 답글 {unread.n}</span> : null}
      <span className="t-meta">마지막 {relTime(sum.lastTs, now)}</span>
      {unread.mentions ? (
        <span className="ch-badge mono tfoot-badge" aria-hidden>
          @{unread.mentions}
        </span>
      ) : null}
      <span className="tfoot-go t-meta" aria-hidden>
        스레드 보기 <IconChevron size={12} />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------- one message

function Message({ m, grouped, cardHost, api, user, channelId, go, focus, deployTracked, onThread, onReact, onWorking, ephemeral, footer }: {
  m: ChatMessage;
  grouped: boolean;
  cardHost: boolean;
  api: Api;
  user: User;
  channelId: string;
  go: (p: string) => void;
  focus?: boolean;
  deployTracked?: boolean;
  onThread: (t: Thread) => void;
  onReact: (m: ChatMessage, emoji: string) => void;
  onWorking?: (id: string, on: boolean) => void;
  ephemeral?: boolean;
  footer?: ReactNode;
}) {
  const toast = useToast();
  const [menu, setMenu] = useState<"react" | "more" | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenu(null), []);
  useOutside(box, !!menu, close);
  // 봇 메시지는 보는 사람 역할에 맞는 본문으로
  const text = textOf(m, user);
  const toMe = mentionsMe(m, user);
  const card = m.kind === "request" && !!m.requestId;
  // 채널에도 보낸 답글은 그 뿌리의 스레드를, 나머지는 자기 스레드를 연다
  const thread: Thread = m.threadId ? targetOf(m.threadId) : card ? { id: m.id, request: m.requestId } : targetOf(m.id, cardHost ? m.runId : undefined);
  const urls = card ? [] : [...new Set(text.match(/https?:\/\/[^\s)]+/g) ?? [])];
  const reactions = Object.entries(m.reactions ?? {}).filter(([, who]) => who.length);
  const copyLink = async () => {
    const url = `${location.origin}${location.pathname}${location.search}#/chat/${channelId}/m/${m.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("링크를 복사했어요", "ok");
    } catch {
      toast(url);
    }
  };
  return (
    <div id={`m-${m.id}`} className={`msg ${grouped ? "grouped" : ""} ${toMe ? "to-me" : ""} ${focus ? "flash" : ""} ${menu ? "pinned" : ""}`}>
      <div className="msg-gutter">
        {grouped ? (
          <time className="msg-hover-time">{clockTime(m.ts).replace(/^(오전|오후) /, "")}</time>
        ) : m.bot ? (
          <span className="avatar bot" style={{ width: 40, height: 40 }} aria-hidden>
            <Logo size={22} />
          </span>
        ) : (
          <Avatar name={m.user} size={40} src={m.userAvatar} />
        )}
      </div>
      <div className="msg-body">
        {!grouped ? (
          <div className="msg-head">
            <b className="msg-name" style={{ color: nameColor(m.userTitle, m.bot) }}>
              {m.bot ? "willnew" : m.user}
            </b>
            {m.bot ? <span className="title-chip">봇</span> : m.userTitle ? <span className="title-chip">{m.userTitle}</span> : null}
            {m.via ? <span className="via-tag">willnew로 보냄</span> : null}
            {ephemeral ? <span className="via-tag">나만 보여요</span> : null}
            <time className="t-meta">{clockTime(m.ts)}</time>
          </div>
        ) : null}
        {m.broadcast ? (
          <button className="msg-link reply-of" onClick={() => onThread(thread)}>
            스레드에 남긴 답글 <IconChevron size={12} />
          </button>
        ) : null}
        {card ? <RequestEmbed api={api} id={m.requestId!} user={user} deployTracked={deployTracked} onThread={() => onThread(thread)} onWorking={onWorking} threaded={!!footer} /> : <div className="msg-text">{highlight(text, user.name)}</div>}
        {urls.length ? (
          <div className="msg-previews">
            {urls.map((u) => (
              <LinkChip key={u} url={u} />
            ))}
          </div>
        ) : null}
        {cardHost && m.runId ? <RunCard api={api} id={m.runId} user={user} go={go} /> : null}
        {reactions.length ? (
          <div className="reacts">
            {reactions.map(([e, who]) => {
              const mine = who.includes(user.name);
              return (
                <button key={e} className={`react ${mine ? "mine" : ""}`} aria-pressed={mine} title={who.join(", ")} onClick={() => onReact(m, e)}>
                  <span className="react-e">{e}</span>
                  <span className="mono">{who.length}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {footer}
      </div>
      {ephemeral ? null : (
        <div className="msg-actions" role="toolbar" aria-label="메시지 동작" ref={box}>
          <button className="ib sm" title="스레드에서 답하기" aria-label="스레드에서 답하기" onClick={() => onThread(thread)}>
            <IconThread size={16} />
          </button>
          <button className="ib sm" title="반응" aria-label="반응" aria-expanded={menu === "react"} onClick={() => setMenu(menu === "react" ? null : "react")}>
            <IconSmile size={16} />
          </button>
          <button className="ib sm" title="링크 복사" aria-label="링크 복사" onClick={copyLink}>
            <IconLink size={16} />
          </button>
          <button className="ib sm" title="더 보기" aria-label="더 보기" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}>
            <IconMore size={16} />
          </button>
          {menu === "react" ? (
            <div className="react-pick" role="menu">
              {REACTIONS.map((e) => (
                <button key={e} role="menuitem" aria-label={`${e} 반응`} onClick={() => { onReact(m, e); setMenu(null); }}>
                  {e}
                </button>
              ))}
            </div>
          ) : null}
          {menu === "more" ? (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(text); toast("글을 복사했어요", "ok"); setMenu(null); }}>
                글 복사
              </button>
              {m.requestId ? (
                <button role="menuitem" onClick={() => go(`/requests/${m.requestId}`)}>
                  요청 화면에서 보기
                </button>
              ) : null}
              {m.runId && user.role !== "requester" ? (
                <button role="menuitem" onClick={() => go(`/runs/${m.runId}`)}>
                  작업 공간에서 보기
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** @willnew 와 내 이름 멘션은 눈에 띄게, 다른 사람 멘션은 은은하게 */
function highlight(text: string, me: string) {
  return text.split("\n").map((line, li) => (
    <span key={li} className="msg-line">
      {line.split(/(@[\p{L}\p{N}_]+|`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/gu).map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <b key={i}>{p.slice(2, -2)}</b>
        ) : p.length > 1 && p.startsWith("@") ? (
          <span key={i} className={`mention ${p === `@${me}` ? "me" : ""}`}>
            {p}
          </span>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i}>{p.slice(1, -1)}</code>
        ) : /^https?:\/\//.test(p) ? (
          <a key={i} className="msg-url" href={p} target="_blank" rel="noreferrer">
            {p.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          p
        ),
      )}
    </span>
  ));
}

// ---------------------------------------------------------------------------------------------- @ 이름 고르기

/** 입력칸에서 @ 뒤에 글자를 치면 채널 멤버 이름을 고를 수 있다. ↑↓ 로 고르고 ↵ 나 Tab 으로 넣는다. */
function useMentionPick(api: Api, channelId: string, text: string, setText: (t: string) => void, area: RefObject<HTMLTextAreaElement | null>) {
  const [members, setMembers] = useState<Member[]>([]);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [shut, setShut] = useState(false);
  useEffect(() => {
    api.members(channelId).then(setMembers).catch(() => undefined);
  }, [api, channelId]);
  const m = /(^|\s)@([\p{L}\p{N}_]*)$/u.exec(text.slice(0, caret));
  const q = m?.[2];
  const list = q === undefined || shut ? [] : members.filter((x) => x.name.startsWith(q) && x.name !== q).slice(0, 6);
  const pick = (name: string) => {
    const head = text.slice(0, caret - (q?.length ?? 0));
    const next = `${head}${name} ${text.slice(caret)}`;
    setText(next);
    const at = head.length + name.length + 1;
    setCaret(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };
  /** true = the key was used by the list */
  const onKey = (e: RKeyboardEvent): boolean => {
    if (!list.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(list[Math.min(sel, list.length - 1)].name);
      return true;
    }
    if (e.key === "Escape") {
      setShut(true);
      return true;
    }
    return false;
  };
  const track = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? el.value.length);
    setSel(0);
    setShut(false);
  };
  const menu = list.length ? (
    <div className="slash mention-pick" role="listbox" aria-label="이름">
      {list.map((x, i) => (
        <button key={x.name} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); pick(x.name); }}>
          {x.bot ? (
            <span className="avatar bot" style={{ width: 20, height: 20 }} aria-hidden>
              <Logo size={12} />
            </span>
          ) : (
            <Avatar name={x.name} size={20} src={x.avatar} />
          )}
          <b style={{ color: nameColor(x.title, x.bot) }}>{x.name}</b>
          <span>{x.bot ? "봇" : x.title ?? ""}</span>
        </button>
      ))}
    </div>
  ) : null;
  return { menu, onKey, track };
}

// ---------------------------------------------------------------------------------------------- composer

const COMMANDS: { cmd: string; desc: string; devOnly?: boolean; run: "request" | "direct" | "status" }[] = [
  { cmd: "/요청", desc: "요청 양식을 열어요. AI가 정리하고 개발자가 확인해요", run: "request" },
  { cmd: "/바로맡기기", desc: "명세와 제안 없이 바로 에이전트에게 맡겨요", devOnly: true, run: "direct" },
  { cmd: "/상태", desc: "이 채널의 열린 요청을 나에게만 보여 줘요", run: "status" },
];

function Composer({ api, user, channelId, channel, typing, onCompose, onStatus, onSent }: { api: Api; user: User; channelId: string; channel?: Channel; typing: boolean; onCompose?: (m: Mode) => void; onStatus: () => void; onSent: (m: ChatMessage) => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [plus, setPlus] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useOutside(box, plus, useCallback(() => setPlus(false), []));
  const mention = useMentionPick(api, channelId, text, setText, area);
  const cmds = COMMANDS.filter((c) => !c.devOnly || user.role !== "requester");
  const slash = /^\/\S*$/.test(text);
  const shown = plus ? cmds : slash ? cmds.filter((c) => c.cmd.startsWith(text)) : [];
  const run = (c: (typeof COMMANDS)[number]) => {
    setText("");
    setPlus(false);
    if (c.run === "status") onStatus();
    else onCompose?.(c.run);
  };
  const send = async () => {
    const v = text.trim();
    if (!v || sending) return;
    const exact = cmds.find((c) => c.cmd === v);
    if (exact) return run(exact);
    setSending(true);
    try {
      const { message } = await api.postMessage(channelId, user.name, v, user.team, undefined, user.title || undefined, user.avatar);
      onSent(message);
      setText("");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSending(false);
    }
  };
  const examples = channelId === "cs" ? [DEMO_REQUEST] : channelId === "design" ? [DEMO_DESIGN_REQUEST] : EXAMPLES;
  return (
    <div className="composer-wrap" ref={box}>
      {shown.length ? (
        <div className="slash" role="listbox" aria-label="명령">
          {shown.map((c, i) => (
            <button key={c.cmd} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <b>{c.cmd}</b>
              <span>{c.desc}</span>
            </button>
          ))}
        </div>
      ) : (
        mention.menu
      )}
      {typing ? (
        <div className="typing" role="status">
          <b>willnew</b>가 정리하는 중
          <span className="typing-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </div>
      ) : !text ? (
        <div className="examples">
          {examples.map((e) => (
            <button key={e} className="chip" onClick={() => { setText(e); area.current?.focus(); }}>
              {e}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <button type="button" className="ib sm" aria-label="더하기: 요청 양식, 바로 맡기기, 상태" aria-expanded={plus} onClick={() => { setPlus((p) => !p); setSel(0); }}>
          <IconPlus size={18} />
        </button>
        <label htmlFor="msg" className="sr">
          메시지
        </label>
        <textarea
          id="msg"
          ref={area}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            setSel(0);
            mention.track(e.target);
          }}
          onSelect={(e) => mention.track(e.currentTarget)}
          onKeyDown={(e) => {
            if (!shown.length && mention.onKey(e)) return;
            if (shown.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setSel((s) => (s + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
            } else if (shown.length && e.key === "Escape") {
              setPlus(false);
              setText("");
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (shown.length && (slash || plus)) run(shown[Math.min(sel, shown.length - 1)]);
              else void send();
            }
          }}
          placeholder={`#${channel?.name ?? channelId} 에 메시지, / 로 명령`}
        />
        <button className="ib" type="submit" disabled={!text.trim() || sending} aria-label="보내기">
          {sending ? <Spinner size={14} /> : <IconSend size={17} />}
        </button>
      </form>
    </div>
  );
}

/** 스레드 입력칸: 답글은 스레드에만, "채널에도 보내기" 를 고르면 채널에도 보인다. @ 이름 고르기는 채널과 같다 */
function ThreadComposer({ api, user, channelId, threadId, onSent }: { api: Api; user: User; channelId: string; threadId: string; onSent: (m: ChatMessage) => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [also, setAlso] = useState(false);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionPick(api, channelId, text, setText, area);
  const send = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try {
      const { message } = await api.reply(channelId, threadId, { user: user.name, text: v, userTitle: user.title || undefined, userAvatar: user.avatar, broadcast: also });
      onSent(message);
      setText("");
      setAlso(false);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="composer-wrap thread-composer">
      {mention.menu}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label htmlFor={`reply-${threadId}`} className="sr">
          답글
        </label>
        <textarea
          id={`reply-${threadId}`}
          ref={area}
          value={text}
          rows={1}
          placeholder="답글 남기기, @ 로 부르기"
          onChange={(e) => {
            setText(e.target.value);
            mention.track(e.target);
          }}
          onSelect={(e) => mention.track(e.currentTarget)}
          onKeyDown={(e) => {
            if (mention.onKey(e)) return;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="ib" type="submit" disabled={!text.trim() || sending} aria-label="답글 보내기">
          {sending ? <Spinner size={14} /> : <IconSend size={17} />}
        </button>
      </form>
      <label className="also">
        <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} />
        채널에도 보내기
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- thread panel

function ThreadPanel({ api, channelId, channel, target, user, root, channelMessages, deployTracked, go, onClose, onThread, onSeen }: {
  api: Api;
  channelId: string;
  channel?: Channel;
  target: Thread;
  user: User;
  root?: ChatMessage;
  channelMessages: ChatMessage[];
  deployTracked?: boolean;
  go: (p: string) => void;
  onClose: () => void;
  onThread: (t: Thread) => void;
  onSeen: () => void;
}) {
  const [replies, setReplies] = useState<ChatMessage[] | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea, .anno") && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  useEffect(() => {
    let alive = true;
    api.threadMessages(channelId, target.id).then((list) => alive && setReplies(list)).catch(() => alive && setReplies([]));
    const off = api.subscribeThread(channelId, target.id, (m) =>
      setReplies((cur) => {
        const list = cur ?? [];
        const i = list.findIndex((x) => x.id === m.id);
        if (i < 0) return [...list, m];
        const next = list.slice();
        next[i] = m;
        return next;
      }),
    );
    return () => {
      alive = false;
      off();
    };
  }, [api, channelId, target.id]);
  // 열어 둔 동안 새 답글은 읽은 것으로, 그리고 맨 아래를 따라간다
  useEffect(() => {
    if (!replies) return;
    onSeen();
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [replies?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = (m: ChatMessage) => setReplies((cur) => (cur && !cur.some((x) => x.id === m.id) ? [...cur, m] : cur));
  // 바로 맡긴 일: 그 run 의 채널 메시지도 같이 (예전처럼)
  const runLines = target.run ? channelMessages.filter((m) => m.runId === target.run && m.id !== target.id) : [];
  const sorted = (replies ?? []).slice().sort((a, b) => a.ts - b.ts);
  return (
    <aside className="side-panel thread-panel" aria-label="스레드">
      <header className="panel-top">
        <span className="t-title">스레드</span>
        {channel ? <span className="t-meta"># {channel.name}</span> : null}
        <span className="grow" />
        <button className="ib sm" aria-label="스레드 닫기" onClick={onClose}>
          <IconX size={16} />
        </button>
      </header>
      <div
        className="panel-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {target.request ? (
          <RequestRoot api={api} id={target.request} user={user} deployTracked={deployTracked} />
        ) : target.run ? (
          <RunRoot api={api} id={target.run} user={user} go={go} onThread={onThread} />
        ) : root ? (
          <TMsg m={root} user={user} />
        ) : null}
        {runLines.length ? <ThreadMessages list={runLines} user={user} title="작업 소식" /> : null}
        {!replies ? <div className="skel" style={{ height: 64 }} /> : <ThreadMessages list={sorted} user={user} title={sorted.length ? `답글 ${sorted.length}` : "아직 답글이 없어요"} />}
      </div>
      <ThreadComposer api={api} user={user} channelId={channelId} threadId={target.id} onSent={add} />
    </aside>
  );
}

function TMsg({ m, user }: { m: ChatMessage; user: User }) {
  return (
    <div className={`tmsg ${mentionsMe(m, user) ? "to-me" : ""}`}>
      {m.bot ? (
        <span className="avatar bot" style={{ width: 28, height: 28 }} aria-hidden>
          <Logo size={16} />
        </span>
      ) : (
        <Avatar name={m.user} size={28} src={m.userAvatar} />
      )}
      <div className="tmsg-main">
        <p className="tmsg-head">
          <b style={{ color: nameColor(m.userTitle, m.bot) }}>{m.bot ? "willnew" : m.user}</b>
          {m.via ? <span className="via-tag">willnew로 보냄</span> : null}
          {m.broadcast ? <span className="via-tag">채널에도 보냄</span> : null}
          <time className="t-meta">{clockTime(m.ts)}</time>
        </p>
        <div className="msg-text">{highlight(textOf(m, user), user.name)}</div>
      </div>
    </div>
  );
}

function ThreadMessages({ list, user, title }: { list: ChatMessage[]; user: User; title: string }) {
  return (
    <section className="thread-msgs" aria-label="스레드 메시지">
      <h3 className="sec-t thread-div">{title}</h3>
      {list.map((m) => (
        <TMsg key={m.id} m={m} user={user} />
      ))}
    </section>
  );
}

function RequestRoot({ api, id, user, deployTracked }: { api: Api; id: string; user: User; deployTracked?: boolean }) {
  const { req, error, reload } = useLiveRequest(api, id);
  if (error && !req) return <ErrorBox error={error} onRetry={reload} />;
  if (!req) return <div className="skel card-skel" />;
  return (
    <div className="thread-root">
      <RequestView api={api} req={req} user={user} deployTracked={deployTracked} timeline={user.role !== "requester"} />
      <a className="msg-link" href={`#/requests/${req.id}`}>
        요청 화면에서 보기 <IconChevron size={12} />
      </a>
    </div>
  );
}

function RunRoot({ api, id, user, go, onThread }: { api: Api; id: string; user: User; go: (p: string) => void; onThread: (t: Thread) => void }) {
  const { run } = useLiveRun(api, id);
  useEffect(() => {
    if (run?.requestId) onThread({ id: `req-${run.requestId}`, request: run.requestId });
  }, [run?.requestId, onThread]);
  if (!run) return <div className="skel card-skel" />;
  return <RunCardBody api={api} run={run} user={user} go={go} now={Date.now()} />;
}

// ---------------------------------------------------------------------------------------------- members

function MemberPanel({ api, channelId, user, requests, runs, onClose }: { api: Api; channelId: string; user: User; requests?: Request[] | null; runs: Run[] | null; onClose: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [pop, setPop] = useState<{ name: string; top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useOutside(box, !!pop, useCallback(() => setPop(null), []));
  const open = (name: string, el: HTMLElement) => {
    if (pop?.name === name) return setPop(null);
    const r = el.getBoundingClientRect();
    const wideEnough = window.innerWidth >= 768;
    setPop({ name, top: Math.min(r.top, window.innerHeight - 240), left: wideEnough ? r.left - 256 - 8 : 16 });
  };
  useEffect(() => {
    setMembers(null);
    api.members(channelId).then(setMembers).catch(() => setMembers([]));
  }, [api, channelId]);
  const groups = useMemo(() => {
    const out = new Map<string, Member[]>();
    for (const m of members ?? []) out.set(m.group, [...(out.get(m.group) ?? []), m]);
    return [...out].sort((a, b) => groupOrder(a[0]) - groupOrder(b[0]) || a[0].localeCompare(b[0], "ko"));
  }, [members]);
  const asked = (name: string) => (requests ?? []).filter((r) => r.requester === name).length + (runs ?? []).filter((r) => r.requester === name && !r.requestId).length;
  return (
    <aside className="side-panel members" aria-label="멤버" ref={box}>
      <header className="panel-top">
        <span className="t-title">멤버 {members ? <span className="t-meta mono">{members.length}</span> : null}</span>
        <span className="grow" />
        <button className="ib sm" aria-label="멤버 닫기" onClick={onClose}>
          <IconX size={16} />
        </button>
      </header>
      <div className="panel-body">
        {!members ? <div className="skel" style={{ height: 160 }} /> : null}
        {groups.map(([g, list]) => (
          <section key={g} className="mem-group">
            <h3 className="sec-t">
              {g} <span className="mono">{list.length}</span>
            </h3>
            {list.map((m) => {
              const fam = roleFamily(m.title, m.bot);
              return (
                <div key={m.name} className="mem-wrap">
                  <button className={`mem ${m.presence === "away" ? "away" : ""}`} aria-expanded={pop?.name === m.name} onClick={(e) => open(m.name, e.currentTarget)}>
                    <span className="mem-av">
                      {m.bot ? (
                        <span className="avatar bot" style={{ width: 32, height: 32 }} aria-hidden>
                          <Logo size={18} />
                        </span>
                      ) : (
                        <Avatar name={m.name} size={32} src={m.avatar} />
                      )}
                      {m.presence ? <i className={`pres ${m.presence}`} aria-hidden /> : null}
                    </span>
                    <span className="mem-main">
                      <b style={{ color: nameColor(m.title, m.bot) }}>{m.name}</b>
                      {m.presence ? <span className="t-meta">{m.presence === "online" ? "온라인" : "자리 비움"}</span> : null}
                    </span>
                  </button>
                  {pop?.name === m.name ? (
                    <div className="mem-pop" role="dialog" aria-label={`${m.name} 프로필`} style={{ top: pop.top, left: pop.left }}>
                      <div className="mem-pop-top">
                        {m.bot ? (
                          <span className="avatar bot" style={{ width: 40, height: 40 }} aria-hidden>
                            <Logo size={22} />
                          </span>
                        ) : (
                          <Avatar name={m.name} size={40} src={m.avatar} />
                        )}
                        <div>
                          <b className="t-title" style={{ color: nameColor(m.title, m.bot) }}>
                            {m.name}
                          </b>
                          {m.presence ? <span className={`st ${m.presence === "online" ? "ok" : "warn"}`}>{m.presence === "online" ? "온라인" : "자리 비움"}</span> : null}
                        </div>
                      </div>
                      <dl className="ctx-dl">
                        <dt>역할</dt>
                        <dd>{fam === "bot" ? "봇" : fam === "dev" ? "개발자" : fam === "req" ? "요청자" : "멤버"}</dd>
                        {m.title ? (
                          <>
                            <dt>직함</dt>
                            <dd>{m.title}</dd>
                          </>
                        ) : null}
                        {!m.bot ? (
                          <>
                            <dt>맡긴 요청</dt>
                            <dd className="mono">{asked(m.name)}</dd>
                          </>
                        ) : null}
                      </dl>
                      {m.name === user.name ? <p className="t-meta">나예요</p> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------- run card (바로 맡긴 일)

function RunCard({ api, id, user, go }: { api: Api; id: string; user: User; go: (p: string) => void }) {
  const { run } = useLiveRun(api, id);
  const active = !!run?.agents.some(isActive);
  const now = useNow(1000, active);
  if (!run) return <div className="embed skel" aria-busy style={{ height: 96 }} />;
  // 요청에 딸린 run 은 요청 embed 가 검토 버튼까지 맡는다. 카드는 하나만
  if (run.requestId) return null;
  return <RunCardBody api={api} run={run} user={user} go={go} now={now} />;
}

function RunCardBody({ api, run, user, go, now }: { api: Api; run: Run; user: User; go: (p: string) => void; now: number }) {
  const phase = runPhase(run, now);
  const p = runProgress(run, now);
  return (
    <article className="embed run-embed slide-in">
      <div className="embed-head">
        <Moon phase={phase.phase} size={16} />
        <b className="t-title">{run.triage?.title ?? run.title}</b>
      </div>
      <PhaseTrack p={p} />
      <div className="rc-agents">
        {run.agents.map((a) => {
          const st = agentState(a, run.maxAttempts);
          return (
            <div key={a.id} className="rc-agent">
              <AgentMark adapter={a.adapter} size={20} />
              {a.label}
              {run.agents.length > 1 && a.id === run.review.agentId ? <Tag tone="now">고름</Tag> : null}
              <span className={`st rc-res ${st.tone === "ok" ? "ok" : st.tone === "bad" ? "bad" : st.tone === "now" ? "now" : ""}`}>
                {st.text}
                {a.durationMs && !isActive(a) ? `, ${fmtDuration(a.durationMs)}` : ""}
                {a.usage.costUsd != null && !isActive(a) ? `, ${fmtCost(a.usage.costUsd)}` : ""}
              </span>
            </div>
          );
        })}
      </div>
      {run.ship ? <ShipRow ship={run.ship} base={run.baseBranch} /> : null}
      {run.review.status === "pending" ? (
        <ReviewActions api={api} run={run} user={user} />
      ) : (
        <div className="embed-foot">
          <button className="msg-link" onClick={() => go(`/runs/${run.id}`)}>
            작업 공간에서 보기 <IconExternal size={12} />
          </button>
        </div>
      )}
    </article>
  );
}
