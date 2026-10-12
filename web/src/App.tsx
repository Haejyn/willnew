import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { AgentInfo, Api, ServerConfig, Team } from "./api";
import { httpApi, isDemo } from "./api";
import type { PaneTab } from "./AgentPane";
import { Chat } from "./Chat";
import { Compose } from "./Compose";
import { DEMO_CHANNEL, demoApi } from "./demo";
import { useRuns, useWatch } from "./flow";
import { AgentMark, AppIcon, IconChart, IconChat, IconHelp, IconList, IconMoon, IconPlus } from "./icons";
import { Metrics } from "./Metrics";
import { Review } from "./Review";
import { RunList } from "./Runs";
import { Turn } from "./Turn";
import { Avatar, Empty, Kbd, ToastProvider, useOutside } from "./ui";
import { TEAM_KO, adapterName, isActive, loadUser, saveUser, useMedia, type User } from "./util";
import { Workspace } from "./Workspace";

function readPath() {
  const h = window.location.hash.replace(/^#/, "");
  if (h.startsWith("/inbox")) {
    // 옛 주소 — 내 차례가 첫 화면이 되었다
    window.history.replaceState(null, "", "#/");
    return "/";
  }
  return h.startsWith("/") ? h : "/";
}

function useHashRoute() {
  const [path, setPath] = useState(readPath);
  useEffect(() => {
    const on = () => setPath(readPath());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((p: string) => {
    if (window.location.hash !== `#${p}`) window.location.hash = p;
  }, []);
  return [path, go] as const;
}

type Route =
  | { page: "home" }
  | { page: "runs" }
  | { page: "run"; id: string; agent?: string; tab?: PaneTab }
  | { page: "review"; id: string; agent?: string }
  | { page: "chat"; channel: string }
  | { page: "metrics" };

function parse(path: string): Route {
  let m;
  if ((m = /^\/runs\/([^/]+)\/review(?:\/agent\/([^/]+))?/.exec(path))) return { page: "review", id: decodeURIComponent(m[1]), agent: m[2] };
  if ((m = /^\/runs\/([^/]+)(?:\/agent\/([^/]+)(?:\/(log|term|diff|preview))?)?/.exec(path)))
    return { page: "run", id: decodeURIComponent(m[1]), agent: m[2], tab: m[3] as PaneTab | undefined };
  if (path.startsWith("/runs")) return { page: "runs" };
  if ((m = /^\/chat\/([^/]+)/.exec(path))) return { page: "chat", channel: decodeURIComponent(m[1]) };
  if (path.startsWith("/chat")) return { page: "chat", channel: DEMO_CHANNEL };
  if (path.startsWith("/metrics")) return { page: "metrics" };
  return { page: "home" };
}

const SHORTCUTS: [string, string][] = [
  ["⌘K", "맡기기"],
  ["⌘1 · ⌘2", "칸 이동"],
  ["↵", "지시 보내기"],
  ["⌘↵", "승인 (검토 화면)"],
  ["?", "단축키"],
];

export function App() {
  const demo = useMemo(isDemo, []);
  const api: Api = demo ? demoApi : httpApi;
  const [path, go] = useHashRoute();
  const route = parse(path);
  const phone = !useMedia("(min-width: 768px)");
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentsDown, setAgentsDown] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [user, setUser] = useState<User>(loadUser);
  const [compose, setCompose] = useState(false);
  const [help, setHelp] = useState(false);
  const { runs, error: runsError, reload } = useRuns(api);
  const { watched, toggle } = useWatch(runs);
  const offline = !!runsError || agentsDown;

  useEffect(() => {
    api.agents().then((a) => { setAgents(a.filter((x) => x.id !== "script")); setAgentsDown(false); }).catch(() => setAgentsDown(true));
    api.teams().then(setTeams).catch(() => undefined);
    api.config().then(setConfig).catch(() => undefined);
  }, [api]);
  // 끊겼다 다시 이어지면 에이전트 목록도 다시 읽는다
  useEffect(() => {
    if (agentsDown && !runsError) api.agents().then((a) => { setAgents(a.filter((x) => x.id !== "script")); setAgentsDown(false); }).catch(() => undefined);
  }, [agentsDown, runsError, api]);

  // the run that needs you most: your turn first, then whatever is running, then the latest
  const home = useMemo(() => runs?.find((r) => r.review.status === "pending") ?? runs?.find((r) => r.agents.some(isActive)) ?? runs?.[0], [runs]);
  const openId = route.page === "run" || route.page === "review" ? route.id : route.page === "runs" && !phone ? home?.id : undefined;
  const pendingN = runs?.filter((r) => r.review.status === "pending").length ?? 0;

  useEffect(() => {
    const run = runs?.find((r) => r.id === openId);
    const t = route.page === "metrics" ? "지표" : route.page === "chat" ? `#${route.channel}` : route.page === "home" ? "내 차례" : run ? (run.triage?.title ?? run.title) : "작업";
    document.title = `${pendingN ? `(${pendingN}) ` : ""}${t} · willnew`;
  }, [route.page, openId, runs, route, pendingN]);

  // ⌘K / ⌘N anywhere: hand over a new piece of work · ? lists the keys
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "n")) {
        e.preventDefault();
        setCompose(true);
      } else if (e.key === "?" && !e.metaKey && !e.ctrlKey && !(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) {
        e.preventDefault();
        setHelp((h) => !h);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const changeUser = (u: User) => {
    setUser(u);
    saveUser(u);
  };
  const me = <Settings user={user} teams={teams} onChange={changeUser} config={config} agents={agents} demo={demo} onHelp={() => setHelp(true)} />;

  let page;
  if (route.page === "metrics") page = <Metrics api={api} />;
  else if (route.page === "chat") page = <Chat api={api} user={user} channelId={route.channel} runs={runs} go={go} />;
  else if (route.page === "review") page = <Review key={route.id} api={api} id={route.id} user={user} go={go} initialAgent={route.agent} />;
  else if (route.page === "home") page = <Turn api={api} user={user} agents={agents} runs={runs} error={runsError} reload={reload} go={go} onNew={() => setCompose(true)} me={me} />;
  else
    page = (
      <div className="runs-view">
        {!phone || route.page === "runs" ? <RunList runs={runs} current={openId} /> : null}
        {openId ? (
          <Workspace
            key={openId}
            api={api}
            id={openId}
            user={user}
            go={go}
            previewCommand={config?.preview ?? ""}
            watched={watched.has(openId)}
            onWatch={() => toggle(openId)}
            initialAgent={route.page === "run" ? route.agent : undefined}
            initialTab={route.page === "run" ? route.tab : undefined}
          />
        ) : !phone ? (
          <Empty title={runs ? "아직 맡긴 일이 없어요" : "불러오는 중"} action={runs ? <button className="btn" onClick={() => setCompose(true)}><IconPlus size={15} /> 맡기기</button> : null} />
        ) : null}
      </div>
    );

  const nav: { id: string; href: string; name: string; Icon: ComponentType<{ size?: number; filled?: boolean }>; on: boolean; badge?: number }[] = [
    { id: "turn", href: "#/", name: "내 차례", Icon: IconMoon, on: route.page === "home", badge: pendingN },
    { id: "runs", href: "#/runs", name: "작업", Icon: IconList, on: route.page === "runs" || route.page === "run" || route.page === "review" },
    { id: "chat", href: `#/chat/${DEMO_CHANNEL}`, name: "채널", Icon: IconChat, on: route.page === "chat" },
    { id: "metrics", href: "#/metrics", name: "지표", Icon: IconChart, on: route.page === "metrics" },
  ];
  const item = (n: (typeof nav)[number], size: number) => (
    <a key={n.id} href={n.href} className={`nav-i ${n.on ? "on" : ""}`} data-tip={n.name} aria-label={n.name} aria-current={n.on ? "page" : undefined}>
      <n.Icon size={size} filled={n.on} />
      <span className="nav-name">{n.name}</span>
      {n.badge ? <span className="badge mono">{n.badge}</span> : null}
    </a>
  );

  return (
    <ToastProvider>
      <div className={`app p-${route.page}`}>
        <div className="sky" aria-hidden />
        <aside className="side" aria-label="화면">
          <a className="side-logo" href="#/" aria-label="willnew">
            <AppIcon size={28} />
          </a>
          <nav className="side-nav">{nav.map((n) => item(n, 22))}</nav>
          <div className="side-foot">
            <button className="side-add" data-tip="맡기기 ⌘K" aria-label="새로 맡기기" onClick={() => setCompose(true)}>
              <IconPlus size={20} />
            </button>
            {me}
          </div>
        </aside>

        <main className="main">{page}</main>

        <nav className="tabbar" aria-label="화면">
          {nav.slice(0, 2).map((n) => item(n, 22))}
          <button className="fab" onClick={() => setCompose(true)} aria-label="새로 맡기기">
            <IconPlus size={24} />
          </button>
          {nav.slice(2).map((n) => item(n, 22))}
        </nav>

        {offline ? (
          <div className="offline" role="status">
            서버에 연결할 수 없어요 · 다시 연결 중
          </div>
        ) : null}
        {compose ? <Compose api={api} user={user} agents={agents} runs={runs} onClose={() => setCompose(false)} go={go} initialChannel={route.page === "chat" ? route.channel : undefined} /> : null}
        {help ? <Shortcuts onClose={() => setHelp(false)} /> : null}
      </div>
    </ToastProvider>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal keys" role="dialog" aria-modal aria-label="단축키">
        <h3>단축키</h3>
        <dl>
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** 아바타 팝오버 — 이름 · 팀, 저장소, 에이전트, 검증 명령. 위쪽 바에 있던 정보가 전부 여기로 왔다. */
function Settings({ user, teams, onChange, config, agents, demo, onHelp }: { user: User; teams: Team[]; onChange: (u: User) => void; config: ServerConfig | null; agents: AgentInfo[] | null; demo: boolean; onHelp: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(box, open, close);
  const list = teams.length ? teams : Object.entries(TEAM_KO).map(([id, n]) => ({ id, name: n, budgetUsd: 0 }));
  return (
    <div className="me" ref={box}>
      <button className="me-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="설정" data-tip={user.name}>
        <Avatar name={user.name} size={36} />
      </button>
      {open ? (
        <div className="pop" role="dialog" aria-label="설정">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) onChange({ ...user, name: name.trim() });
              setOpen(false);
            }}
          >
            <label className="field">
              <span>이름</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>팀</span>
              <select value={user.team} onChange={(e) => onChange({ ...user, team: e.target.value })}>
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn w sm" type="submit">
              저장
            </button>
          </form>
          <dl className="pop-info">
            <dt>저장소</dt>
            <dd className="mono">{config?.repo ? config.repo.split(/[\\/]/).pop() : "…"}</dd>
            <dt>에이전트</dt>
            <dd className="pop-agents">
              {agents?.map((a) => (
                <span key={a.id} title={a.installed ? `${adapterName(a.id)} 사용 가능` : `${adapterName(a.id)} 가 이 PC 에 없어요`}>
                  <AgentMark adapter={a.id} size={16} />
                  {adapterName(a.id)}
                  <i className={a.installed ? "on" : ""} />
                </span>
              )) ?? "…"}
            </dd>
            <dt>검증</dt>
            <dd className="mono">{config ? config.check || "없음" : "…"}</dd>
            {demo ? (
              <>
                <dt>데이터</dt>
                <dd>데모</dd>
              </>
            ) : null}
          </dl>
          <button className="btn q sm" onClick={() => { setOpen(false); onHelp(); }}>
            <IconHelp size={15} /> 단축키 <Kbd>?</Kbd>
          </button>
        </div>
      ) : null}
    </div>
  );
}
