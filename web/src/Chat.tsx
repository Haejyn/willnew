/**
 * 팀 채널. 커뮤니티 채팅처럼 읽힌다: 왼쪽 채널 목록(묶음, 안 읽음 점, 나를 부른 수), 가운데 메시지(작성자별 묶음, 날짜 줄,
 * 새 메시지 줄, 반응, 호버 동작 줄), 오른쪽은 스레드 또는 멤버.
 * @willnew 로 맡기면 요청이 생기고, 요청은 스레드에 산다. 채널 본문에는 짧은 embed 만 남고 전체 카드는 스레드에서 연다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Api, Channel, ChatMessage, Member, Request, Run } from "./api";
import { ReviewActions } from "./Decision";
import { useLiveRequest, useLiveRun } from "./flow";
import { AgentMark, IconChevron, IconExternal, IconLink, IconList, IconMore, IconPlus, IconSend, IconSmile, IconThread, IconUsers, IconX, Logo } from "./icons";
import { DEMO_DESIGN_REQUEST, DEMO_REQUEST } from "./demo";
import { RequestEmbed, RequestView, phaseBar, reqHeadline, runProgress, PhaseTrack } from "./Request";
import { Moon, runPhase } from "./moon";
import { groupOrder, nameColor, roleFamily } from "./people";
import { ShipRow } from "./Ship";
import { Avatar, ErrorBox, LinkChip, Spinner, Tag, agentState, useOutside, useToast } from "./ui";
import { clockTime, fmtCost, fmtDuration, isActive, useMedia, useNow, type User } from "./util";

const EXAMPLES = ["@willnew 버그 수정: duration 테스트 실패", "@willnew 테스트 작성: 환불 API 경계값", "@willnew 리팩터링: 날짜 포맷 함수 통합"];
/** 반응은 사용자 콘텐츠다. UI 글자에는 이모지를 쓰지 않는다 */
const REACTIONS = ["👍", "✅", "👀"];
const GROUP_MS = 5 * 60_000;
const OPENED = Date.now();
/** 처음 보는 채널은 최근 20분을 새 메시지로 본다 */
const DEFAULT_SEEN = OPENED - 20 * 60_000;

type Thread = { request: string } | { run: string };
type Mode = "request" | "direct";

// ---------------------------------------------------------------------------------------------- seen / unread

const SEEN_KEY = "willnew.seen";
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

/** 지금 보고 있지 않은 채널마다: 새 메시지 수와 나를 부른 수 */
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
            const list = await api.messages(c.id).catch(() => [] as ChatMessage[]);
            const fresh = list.filter((m) => m.ts > seenOf(c.id) && m.user !== user.name);
            out[c.id] = { n: fresh.length, mentions: fresh.filter((m) => mentionsMe(m, user)).length };
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
  const toast = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(!focus);
  const lastTop = useRef(0);
  const channel = channels.find((c) => c.id === channelId);
  const unread = useUnread(api, channels, channelId, user);

  useEffect(() => {
    api.channels().then(setChannels).catch((e: Error) => toast(e.message, "err"));
  }, [api, toast]);

  const load = useCallback(() => {
    setLoadError(null);
    api.messages(channelId).then(setMessages).catch((e: Error) => setLoadError(e.message));
  }, [api, channelId]);

  useEffect(() => {
    load();
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
      if (m.runId && m.bot && !m.requestId && !seen.has(m.runId)) {
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
    const grouped = !broke && !!prev && !card && !prevCard && prev.user === m.user && prev.bot === m.bot && m.ts - prev.ts < GROUP_MS && !cardFor.has(m.id);
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
        onThread={setThread}
        onReact={react}
        onWorking={onWorking}
        ephemeral={m.id.startsWith("local-")}
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
        <ThreadPanel api={api} target={thread} user={user} messages={sorted} deployTracked={deployTracked} go={go} onClose={() => setThread(null)} onThread={setThread} />
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
        const shown = shut ? list.filter((c) => c.id === current || unread[c.id]?.n) : list;
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
                <a key={c.id} href={`#/chat/${c.id}`} onClick={onPick} className={`ch ${on ? "on" : ""} ${!on && u?.n ? "unread" : ""}`} aria-current={on ? "page" : undefined}>
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

// ---------------------------------------------------------------------------------------------- one message

function Message({ m, grouped, cardHost, api, user, channelId, go, focus, deployTracked, onThread, onReact, onWorking, ephemeral }: {
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
  const thread: Thread | null = m.requestId ? { request: m.requestId } : m.runId ? { run: m.runId } : null;
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
        {card ? <RequestEmbed api={api} id={m.requestId!} user={user} deployTracked={deployTracked} onThread={() => onThread({ request: m.requestId! })} onWorking={onWorking} /> : <div className="msg-text">{highlight(text, user.name)}</div>}
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
      </div>
      {ephemeral ? null : (
        <div className="msg-actions" role="toolbar" aria-label="메시지 동작" ref={box}>
          {thread ? (
            <button className="ib sm" title="스레드에서 보기" aria-label="스레드에서 보기" onClick={() => onThread(thread)}>
              <IconThread size={16} />
            </button>
          ) : null}
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
      ) : null}
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
          }}
          onKeyDown={(e) => {
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

// ---------------------------------------------------------------------------------------------- thread panel

function ThreadPanel({ api, target, user, messages, deployTracked, go, onClose, onThread }: { api: Api; target: Thread; user: User; messages: ChatMessage[]; deployTracked?: boolean; go: (p: string) => void; onClose: () => void; onThread: (t: Thread) => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <aside className="side-panel thread-panel" aria-label="스레드">
      <header className="panel-top">
        <span className="t-title">스레드</span>
        <span className="grow" />
        <button className="ib sm" aria-label="스레드 닫기" onClick={onClose}>
          <IconX size={16} />
        </button>
      </header>
      <div className="panel-body">
        {"request" in target ? (
          <RequestThread api={api} id={target.request} user={user} messages={messages} deployTracked={deployTracked} />
        ) : (
          <RunThread api={api} id={target.run} user={user} messages={messages} go={go} onThread={onThread} />
        )}
      </div>
    </aside>
  );
}

function ThreadMessages({ list, user }: { list: ChatMessage[]; user: User }) {
  if (!list.length) return null;
  return (
    <section className="thread-msgs" aria-label="스레드 메시지">
      <h3 className="sec-t">답글 {list.length}</h3>
      {list.map((m) => (
        <div key={m.id} className="tmsg">
          {m.bot ? (
            <span className="avatar bot" style={{ width: 24, height: 24 }} aria-hidden>
              <Logo size={14} />
            </span>
          ) : (
            <Avatar name={m.user} size={24} src={m.userAvatar} />
          )}
          <div>
            <p className="tmsg-head">
              <b style={{ color: nameColor(m.userTitle, m.bot) }}>{m.bot ? "willnew" : m.user}</b> <time className="t-meta">{clockTime(m.ts)}</time>
            </p>
            <div className="msg-text">{highlight(textOf(m, user), user.name)}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

function RequestThread({ api, id, user, messages, deployTracked }: { api: Api; id: string; user: User; messages: ChatMessage[]; deployTracked?: boolean }) {
  const { req, error, reload } = useLiveRequest(api, id);
  if (error && !req) return <ErrorBox error={error} onRetry={reload} />;
  if (!req) return <div className="skel card-skel" />;
  const related = messages.filter((m) => !(m.kind === "request") && (m.requestId === id || (m.runId && req.runIds.includes(m.runId))));
  return (
    <>
      <RequestView api={api} req={req} user={user} deployTracked={deployTracked} timeline={user.role !== "requester"} />
      <ThreadMessages list={related} user={user} />
      <a className="msg-link" href={`#/requests/${req.id}`}>
        요청 화면에서 보기 <IconChevron size={12} />
      </a>
    </>
  );
}

function RunThread({ api, id, user, messages, go, onThread }: { api: Api; id: string; user: User; messages: ChatMessage[]; go: (p: string) => void; onThread: (t: Thread) => void }) {
  const { run } = useLiveRun(api, id);
  useEffect(() => {
    if (run?.requestId) onThread({ request: run.requestId });
  }, [run?.requestId, onThread]);
  if (!run) return <div className="skel card-skel" />;
  return (
    <>
      <RunCardBody api={api} run={run} user={user} go={go} now={Date.now()} />
      <ThreadMessages list={messages.filter((m) => m.runId === id)} user={user} />
    </>
  );
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
    <article className="embed run-embed slide-in" style={phaseBar({ ...p, mine: run.review.status === "pending" && user.role !== "requester" })}>
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
