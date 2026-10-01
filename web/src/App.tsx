import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo, Api, Run, ServerConfig, Team } from "./api";
import { httpApi, isDemo } from "./api";
import type { PaneTab } from "./AgentPane";
import { Chat } from "./Chat";
import { Compose } from "./Compose";
import { DEMO_CHANNEL, demoApi } from "./demo";
import { useRuns, useWatch } from "./flow";
import { AgentMark, IconBell, IconBranch, IconChart, IconChat, IconGear, IconInbox, IconPlus, IconSearch, IconTerminal, Logo } from "./icons";
import { Metrics } from "./Metrics";
import { Review } from "./Review";
import { Avatar, Empty, Kbd, MiniRail, ToastProvider } from "./ui";
import { TEAM_KO, adapterName, isActive, loadUser, relTime, saveUser, type User } from "./util";
import { Workspace } from "./Workspace";

function readPath() {
  const h = window.location.hash.replace(/^#/, "");
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
  | { page: "run"; id: string; agent?: string; tab?: PaneTab }
  | { page: "review"; id: string; agent?: string }
  | { page: "chat"; channel: string }
  | { page: "metrics" }
  | { page: "inbox" };

function parse(path: string): Route {
  let m;
  if ((m = /^\/runs\/([^/]+)\/review(?:\/agent\/([^/]+))?/.exec(path))) return { page: "review", id: decodeURIComponent(m[1]), agent: m[2] };
  if ((m = /^\/runs\/([^/]+)(?:\/agent\/([^/]+)(?:\/(log|term|diff|preview))?)?/.exec(path)))
    return { page: "run", id: decodeURIComponent(m[1]), agent: m[2], tab: m[3] as PaneTab | undefined };
  if ((m = /^\/chat\/([^/]+)/.exec(path))) return { page: "chat", channel: decodeURIComponent(m[1]) };
  if (path.startsWith("/chat")) return { page: "chat", channel: DEMO_CHANNEL };
  if (path.startsWith("/metrics")) return { page: "metrics" };
  if (path.startsWith("/inbox")) return { page: "inbox" };
  return { page: "home" };
}

export function App() {
  const demo = useMemo(isDemo, []);
  const api: Api = demo ? demoApi : httpApi;
  const [path, go] = useHashRoute();
  const route = parse(path);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [offline, setOffline] = useState(false);
  const [user, setUser] = useState<User>(loadUser);
  const [compose, setCompose] = useState(false);
  const { runs } = useRuns(api);
  const { watched, toggle } = useWatch(runs);

  useEffect(() => {
    api.agents().then((a) => { setAgents(a.filter((x) => x.id !== "script")); setOffline(false); }).catch(() => setOffline(true));
    api.teams().then(setTeams).catch(() => undefined);
    api.config().then(setConfig).catch(() => undefined);
  }, [api]);

  // home = the run that needs you most: your turn first, then whatever is running, then the latest
  const home = useMemo(() => runs?.find((r) => r.review.status === "pending") ?? runs?.find((r) => r.agents.some(isActive)) ?? runs?.[0], [runs]);
  const currentRunId = route.page === "run" || route.page === "review" ? route.id : route.page === "home" ? home?.id : undefined;

  useEffect(() => {
    const run = runs?.find((r) => r.id === currentRunId);
    const t = route.page === "metrics" ? "지표" : route.page === "chat" ? `#${route.channel}` : route.page === "inbox" ? "내 차례" : run ? (run.triage?.title ?? run.title) : "작업 공간";
    const pending = runs?.filter((r) => r.review.status === "pending").length ?? 0;
    document.title = `${pending ? `(${pending}) ` : ""}${t} · willnew`;
  }, [route.page, currentRunId, runs, route]);

  // ⌘K / ⌘N anywhere: hand over a new piece of work
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "n")) {
        e.preventDefault();
        setCompose(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const changeUser = (u: User) => {
    setUser(u);
    saveUser(u);
  };

  let page;
  if (route.page === "metrics") page = <Metrics api={api} />;
  else if (route.page === "chat") page = <Chat api={api} user={user} channelId={route.channel} runs={runs} go={go} />;
  else if (route.page === "review") page = <Review key={route.id} api={api} id={route.id} user={user} go={go} initialAgent={route.agent} />;
  else if (route.page === "inbox") page = <Inbox runs={runs} onNew={() => setCompose(true)} />;
  else if (currentRunId)
    page = (
      <Workspace
        key={currentRunId}
        api={api}
        id={currentRunId}
        user={user}
        go={go}
        previewCommand={config?.preview ?? ""}
        watched={watched.has(currentRunId)}
        onWatch={() => toggle(currentRunId)}
        initialAgent={route.page === "run" ? route.agent : undefined}
        initialTab={route.page === "run" ? route.tab : undefined}
      />
    );
  else
    page = (
      <div className="page">
        <Empty title={runs ? "아직 맡긴 일이 없어요" : "불러오는 중"} action={runs ? <button className="btn w" onClick={() => setCompose(true)}><IconPlus size={15} /> 새로 맡기기</button> : null}>
          {runs ? "⌘K 로 일을 맡기거나, 팀 채널에서 @willnew 로 부르세요." : null}
        </Empty>
      </div>
    );

  const withList = route.page === "home" || route.page === "run";
  const pending = runs?.filter((r) => r.review.status === "pending") ?? [];
  const live = runs?.flatMap((r) => r.agents.filter(isActive)).length ?? 0;

  return (
    <ToastProvider>
      <div className={`app p-${route.page} ${withList ? "with-list" : ""}`}>
        <div className="sky" aria-hidden />
        <header className="top">
          <a className="brand" href="#/">
            <Logo size={22} />
            <span className="wordmark">willnew</span>
            {demo ? <span className="tag">데모</span> : null}
          </a>
          <span className="repo mono">
            <IconBranch size={13} /> {config?.repo ? config.repo.split(/[\\/]/).pop() : "…"}
          </span>
          <button className="cmdk" onClick={() => setCompose(true)}>
            <IconSearch size={15} />
            <span>새로 맡기기 · 요청 검색</span>
            <Kbd>⌘K</Kbd>
          </button>
          <nav className="top-nav" aria-label="화면">
            <a href="#/" className={withList || route.page === "review" ? "on" : ""}>
              <IconInbox size={16} /> 작업
            </a>
            <a href={`#/chat/${DEMO_CHANNEL}`} className={route.page === "chat" ? "on" : ""}>
              <IconChat size={16} /> 채널
            </a>
            <a href="#/metrics" className={route.page === "metrics" ? "on" : ""}>
              <IconChart size={16} /> 지표
            </a>
          </nav>
          <span className="agents">
            {offline ? <span className="dim small">서버 연결 안 됨</span> : null}
            {agents?.map((a) => (
              <span key={a.id} className="agent-chip" title={a.installed ? `${adapterName(a.id)} 사용 가능` : `${adapterName(a.id)} 가 이 PC 에 없어요`}>
                <AgentMark adapter={a.id} size={18} />
                <span className="agent-chip-name">{adapterName(a.id)}</span>
                <span className={`live-dot ${a.installed ? "on" : ""}`} />
              </span>
            ))}
          </span>
          <a className="ib bell" href="#/inbox" aria-label={`내 차례 ${pending.length}개`}>
            <IconBell size={17} />
            {pending.length ? <span className="badge">{pending.length}</span> : null}
          </a>
          <UserSwitch user={user} teams={teams} onChange={changeUser} />
        </header>

        {withList ? <RunList runs={runs} current={currentRunId} onNew={() => setCompose(true)} /> : null}
        <main className="main">{page}</main>

        <footer className="status">
          <span>
            <IconBranch size={13} /> 워크트리 {runs?.reduce((s, r) => s + r.agents.length, 0) ?? 0}
          </span>
          <span>
            <IconTerminal size={13} /> 작업 중 에이전트 {live}
          </span>
          {config?.check ? <span className="mono">검증 {config.check}</span> : null}
          <span className="grow" />
          <span className="keys">
            <Kbd>⌘K</Kbd> 맡기기 <Kbd>⌘1</Kbd>
            <Kbd>⌘2</Kbd> 칸 이동 <Kbd>↵</Kbd> 지시 보내기
          </span>
        </footer>

        <nav className="tabbar" aria-label="화면">
          <a href="#/inbox" className={route.page === "inbox" || withList || route.page === "review" ? "on" : ""}>
            <IconInbox size={22} />
            <span>맡긴 일</span>
            {pending.length ? <span className="badge">{pending.length}</span> : null}
          </a>
          <a href={`#/chat/${DEMO_CHANNEL}`} className={route.page === "chat" ? "on" : ""}>
            <IconChat size={22} />
            <span>채널</span>
          </a>
          <a href="#/metrics" className={route.page === "metrics" ? "on" : ""}>
            <IconChart size={22} />
            <span>지표</span>
          </a>
          <button onClick={() => setCompose(true)} className="fab" aria-label="새로 맡기기">
            <IconPlus size={22} />
          </button>
        </nav>

        {compose ? <Compose api={api} user={user} agents={agents} runs={runs} onClose={() => setCompose(false)} go={go} initialChannel={route.page === "chat" ? route.channel : undefined} /> : null}
      </div>
    </ToastProvider>
  );
}

function groups(runs: Run[] | null) {
  const list = runs ?? [];
  return {
    turn: list.filter((r) => r.review.status === "pending"),
    active: list.filter((r) => r.agents.some(isActive) || (!r.agents.length && r.review.status === "none")),
    done: list.filter((r) => r.review.status !== "pending" && !r.agents.some(isActive) && r.agents.length > 0),
  };
}

function runMeta(r: Run): string {
  const a = r.agents;
  if (r.review.status === "pending") return `승인 · ${a.filter((x) => x.check.status === "passed").length}/${a.length} 통과`;
  if (!a.length) return "계획 중";
  const live = a.filter(isActive);
  if (live.some((x) => x.status === "checking")) return `검증 · ${r.checkCmd}`;
  if (live.some((x) => x.attempt > 1)) return `실행 · ${live.find((x) => x.attempt > 1)!.label} ${live.find((x) => x.attempt > 1)!.attempt}차 시도`;
  if (live.length) return `실행 · 에이전트 ${live.length}`;
  if (r.review.status === "approved") return `병합 · ${relTime(r.review.at ?? r.createdAt)}`;
  if (r.review.status === "rejected") return `반려 · ${relTime(r.review.at ?? r.createdAt)}`;
  return "반영할 결과 없음";
}

function RunList({ runs, current, onNew }: { runs: Run[] | null; current?: string; onNew: () => void }) {
  const g = groups(runs);
  const item = (r: Run, turn = false) => (
    <a key={r.id} className={`row ${r.id === current ? "on" : ""} ${turn ? "turn" : ""}`} href={`#/runs/${r.id}`} aria-current={r.id === current ? "page" : undefined}>
      <span className="row-title">{r.triage?.title ?? r.title}</span>
      <span className="row-meta">
        <MiniRail run={r} />
        {runMeta(r)}
      </span>
    </a>
  );
  return (
    <nav className="list" aria-label="맡긴 일">
      <button className="btn w new" onClick={onNew}>
        <IconPlus size={15} /> 새로 맡기기 <Kbd>⌘N</Kbd>
      </button>
      <section>
        <div className="sec-head">
          <span className="lab">내 차례</span>
          {g.turn.length ? <span className="count turn mono">{g.turn.length}</span> : null}
        </div>
        {g.turn.map((r) => item(r, true))}
        {!g.turn.length ? <span className="none">검토할 일이 없어요</span> : null}
      </section>
      <section>
        <div className="sec-head">
          <span className="lab">진행 중</span>
          {g.active.length ? <span className="count mono">{g.active.length}</span> : null}
        </div>
        {g.active.map((r) => item(r))}
        {!g.active.length ? <span className="none">도는 일이 없어요</span> : null}
      </section>
      <section>
        <div className="sec-head">
          <span className="lab">끝남</span>
        </div>
        {g.done.slice(0, 8).map((r) => (
          <a key={r.id} className={`row compact ${r.id === current ? "on" : ""}`} href={`#/runs/${r.id}`}>
            <span className="row-title">{r.triage?.title ?? r.title}</span>
            <span className="row-meta">{runMeta(r)}</span>
          </a>
        ))}
      </section>
      <div className="list-foot">
        <a className="row compact" href={`#/chat/${DEMO_CHANNEL}`}>
          <IconChat size={15} /> 채널
        </a>
        <a className="row compact" href="#/metrics">
          <IconChart size={15} /> 지표
        </a>
      </div>
    </nav>
  );
}

/** Phone home: what needs you, then what is running. */
function Inbox({ runs, onNew }: { runs: Run[] | null; onNew: () => void }) {
  const [tab, setTab] = useState<"turn" | "active" | "done">("turn");
  const g = groups(runs);
  const list = g[tab];
  return (
    <div className="inbox">
      <div className="inbox-head">
        <Logo size={26} />
        <h1>내 차례</h1>
        <span className="mono turn-n">{g.turn.length}</span>
      </div>
      <div className="seg wide" role="tablist">
        {(["turn", "active", "done"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "turn" ? "내 차례" : t === "active" ? `진행 중 ${g.active.length}` : "끝남"}
          </button>
        ))}
      </div>
      <div className="inbox-list">
        {list.map((r) => (
          <a key={r.id} className={`icard ${tab === "turn" ? "turn" : ""}`} href={tab === "turn" ? `#/runs/${r.id}/review` : `#/runs/${r.id}`}>
            <span className="icard-meta">
              {r.channel ? `#${r.channel}` : ""} · {relTime(r.createdAt)}
            </span>
            <b>{r.triage?.title ?? r.title}</b>
            <MiniRail run={r} />
            <span className="icard-agents">
              {r.agents.map((a) => (
                <AgentMark key={a.id} adapter={a.adapter} size={18} />
              ))}
              <span className="dim small">{runMeta(r)}</span>
            </span>
          </a>
        ))}
        {!list.length ? (
          <Empty title={tab === "turn" ? "검토할 일이 없어요" : "비어 있어요"} action={<button className="btn w" onClick={onNew}><IconPlus size={15} /> 새로 맡기기</button>} />
        ) : null}
      </div>
    </div>
  );
}

function UserSwitch({ user, teams, onChange }: { user: User; teams: Team[]; onChange: (u: User) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const list = teams.length ? teams : Object.entries(TEAM_KO).map(([id, n]) => ({ id, name: n, budgetUsd: 0 }));
  return (
    <div className="me">
      <button className="me-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="사용자 바꾸기">
        <Avatar name={user.name} size={30} />
      </button>
      {open ? (
        <form
          className="menu me-menu"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onChange({ ...user, name: name.trim() });
            setOpen(false);
          }}
        >
          <label className="field">
            <span>이름</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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
            <IconGear size={14} /> 저장
          </button>
        </form>
      ) : null}
    </div>
  );
}
