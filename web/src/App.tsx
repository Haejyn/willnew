import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo, Api, Team } from "./api";
import { httpApi, isDemo } from "./api";
import { Chat, BotMark } from "./Chat";
import { DEMO_CHANNEL, demoApi } from "./demo";
import { IconChart, IconChat, IconInbox, AgentMark } from "./icons";
import { Metrics } from "./Metrics";
import { Requests } from "./Requests";
import { RunView } from "./RunView";
import { ToastProvider } from "./ui";
import { TEAM_KO, adapterName, loadUser, saveUser, type User } from "./util";

function readPath(fallback: string) {
  const h = window.location.hash.replace(/^#/, "");
  return h.startsWith("/") ? h : fallback;
}

function useHashRoute(fallback: string) {
  const [path, setPath] = useState(() => readPath(fallback));
  useEffect(() => {
    const on = () => setPath(readPath(fallback));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [fallback]);
  const go = useCallback((p: string) => {
    if (window.location.hash !== `#${p}`) window.location.hash = p;
  }, []);
  return [path, go] as const;
}

const NAV = [
  { path: "/chat", label: "대화", icon: IconChat },
  { path: "/requests", label: "요청", icon: IconInbox },
  { path: "/metrics", label: "지표", icon: IconChart },
];

export function App() {
  const demo = useMemo(isDemo, []);
  const api: Api = demo ? demoApi : httpApi;
  const [path, go] = useHashRoute(`/chat/${DEMO_CHANNEL}`);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [offline, setOffline] = useState(false);
  const [user, setUser] = useState<User>(loadUser);

  useEffect(() => {
    api
      .agents()
      .then((a) => {
        setAgents(a.filter((x) => x.id !== "script"));
        setOffline(false);
      })
      .catch(() => setOffline(true));
    api.teams().then(setTeams).catch(() => undefined);
  }, [api]);

  const section = path.startsWith("/requests") ? "/requests" : path.startsWith("/metrics") ? "/metrics" : "/chat";
  const runId = /^\/requests\/([^/]+)/.exec(path)?.[1];
  const channel = /^\/chat\/([^/]+)/.exec(path)?.[1] ?? DEMO_CHANNEL;

  useEffect(() => {
    const titles: Record<string, string> = { "/chat": `#${channel}`, "/requests": runId ? `요청 ${runId}` : "요청", "/metrics": "지표" };
    document.title = `${titles[section]} · willnew`;
  }, [section, runId, channel]);

  const changeUser = (u: User) => {
    setUser(u);
    saveUser(u);
  };

  let page;
  if (section === "/metrics") page = <Metrics api={api} />;
  else if (section === "/requests") page = runId ? <RunView key={runId} api={api} id={decodeURIComponent(runId)} go={go} user={user} /> : <Requests api={api} go={go} user={user} />;
  else page = <Chat api={api} user={user} channelId={decodeURIComponent(channel)} go={go} />;

  return (
    <ToastProvider>
      <div className={`shell sec-${section.slice(1)}`}>
        <aside className="rail">
          <a className="brand" href="#/chat">
            <span className="brand-mark">
              <BotMark size={18} />
            </span>
            <span className="brand-name">
              will<b>new</b>
            </span>
            {demo ? <span className="demo-tag">demo</span> : null}
          </a>
          <nav className="nav">
            {NAV.map((n) => (
              <a key={n.path} href={`#${n.path}`} className={section === n.path ? "on" : ""} aria-current={section === n.path ? "page" : undefined}>
                <n.icon size={18} />
                {n.label}
              </a>
            ))}
          </nav>
          <span className="grow" />
          <AgentStatus agents={agents} offline={offline} />
          <UserSwitch user={user} teams={teams} onChange={changeUser} />
        </aside>

        <header className="topbar">
          <a className="brand" href="#/chat">
            <span className="brand-mark">
              <BotMark size={16} />
            </span>
            <span className="brand-name">
              will<b>new</b>
            </span>
          </a>
          <span className="grow" />
          <span className="me-chip">
            {user.name} · {TEAM_KO[user.team] ?? user.team}
          </span>
        </header>

        <main className="main">{page}</main>

        <nav className="tabbar">
          {NAV.map((n) => (
            <a key={n.path} href={`#${n.path}`} className={section === n.path ? "on" : ""}>
              <span className="tab-ic">
                <n.icon size={20} />
              </span>
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
      </div>
    </ToastProvider>
  );
}

function AgentStatus({ agents, offline }: { agents: AgentInfo[] | null; offline: boolean }) {
  return (
    <div className="agents-box">
      <div className="agents-h">에이전트</div>
      {offline ? <div className="agents-off">서버 연결 안 됨</div> : null}
      {agents?.map((a) => (
        <div key={a.id} className={`agent-line ad-${a.id}`}>
          <AgentMark adapter={a.id} size={18} />
          <span>{adapterName(a.id)}</span>
          <span className={`inst ${a.installed ? "yes" : "no"}`} title={a.installed ? "사용 가능" : "설치 안 됨"} />
          <span className="grow" />
        </div>
      ))}
    </div>
  );
}

function UserSwitch({ user, teams, onChange }: { user: User; teams: Team[]; onChange: (u: User) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const list = teams.length ? teams : Object.entries(TEAM_KO).map(([id, n]) => ({ id, name: n, budgetUsd: 0 }));
  return (
    <div className="me">
      {open ? (
        <form
          className="me-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onChange({ ...user, name: name.trim() });
            setOpen(false);
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="이름" autoFocus />
          <select value={user.team} onChange={(e) => onChange({ ...user, team: e.target.value })} aria-label="팀">
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn primary sm" type="submit">
            저장
          </button>
        </form>
      ) : (
        <button className="me-btn" onClick={() => setOpen(true)} title="사용자 바꾸기">
          <span className="avatar h2">{user.name.slice(-2)}</span>
          <span className="me-name">
            <b>{user.name}</b>
            <span>{TEAM_KO[user.team] ?? user.team}</span>
          </span>
        </button>
      )}
    </div>
  );
}
