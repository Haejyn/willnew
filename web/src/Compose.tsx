/** 새로 맡기기 (⌘K · ⌘N) — 한 줄을 쓰면 계획이 한 줄로 뜨고(눌러서 고친다), 이미 맡긴 일도 같이 찾아 준다. 보내면 팀 채널에 남는다. */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AgentInfo, AgentSpec, Api, Channel, Run, Template, Triage } from "./api";
import { isDemo } from "./api";
import { DEMO_REQUEST } from "./demo";
import { AgentMark, IconChevron, IconSend, IconSpark, IconTerminal } from "./icons";
import { Moon, runPhase } from "./moon";
import { Kbd, Spinner, useOutside, useToast } from "./ui";
import { TEAM_KO, type User } from "./util";

const RACER: AgentSpec = { adapter: "codex", label: "codex" };

export function Compose({ api, user, agents, runs, onClose, go, initialChannel, inline, initialText }: {
  api: Api;
  user: User;
  agents: AgentInfo[] | null;
  runs: Run[] | null;
  onClose: () => void;
  go: (p: string) => void;
  initialChannel?: string;
  /** 시트 대신 화면 안에 그대로 놓는다(첫 실행) */
  inline?: boolean;
  initialText?: string;
}) {
  const toast = useToast();
  const [text, setText] = useState(initialText ?? "");
  const [plan, setPlan] = useState<Triage | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState(initialChannel ?? "");
  const [template, setTemplate] = useState<string | null>(null);
  const [picked, setPicked] = useState<AgentSpec[] | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false); // 계획 줄을 눌러 펼친 고치는 칸
  const [chOpen, setChOpen] = useState(false);
  const [sel, setSel] = useState(-1); // 찾은 일 중 고른 것
  const area = useRef<HTMLTextAreaElement>(null);
  const chBox = useRef<HTMLDivElement>(null);
  const chOpenRef = useRef(false);
  chOpenRef.current = chOpen;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useOutside(chBox, chOpen, useCallback(() => setChOpen(false), []));

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => undefined);
    api.channels().then((c) => {
      setChannels(c);
      setChannel((cur) => cur || c.find((x) => x.team === user.team)?.id || c[0]?.id || "");
    }).catch(() => undefined);
    area.current?.focus();
    if (inline) return;
    // 채널 메뉴가 열려 있으면 Esc 는 메뉴만 닫는다
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !chOpenRef.current && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, user.team, inline]);

  // 입력 높이는 글에 맞춘다
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    setSel(-1);
  }, [text]);

  // instant preview from keyword rules while typing; the planner agent decides for real on send
  useEffect(() => {
    if (!text.trim()) return setPlan(null);
    const t = setTimeout(() => api.plan(text).then(setPlan).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [api, text]);

  const tplId = template ?? plan?.template ?? "bugfix";
  const tpl = templates.find((t) => t.id === tplId);
  const checkCmd = check ?? (tpl?.check || plan?.check || "");
  const options = useMemo(() => {
    const out: AgentSpec[] = [];
    const add = (s: AgentSpec) => !out.some((o) => o.label === s.label) && out.push(s);
    for (const t of templates) t.agents.forEach(add);
    for (const a of agents ?? []) if (a.installed && !out.some((o) => o.adapter === a.id)) add({ adapter: a.id, label: a.id });
    return out;
  }, [templates, agents]);
  const installed = new Set((agents ?? []).filter((a) => a.installed).map((a) => a.id));
  const noAgent = !!agents && !installed.size;
  // 기본으로 고르는 에이전트는 이 PC 에 있는 것만
  const base = tpl?.agents ?? plan?.agents ?? [];
  const chosen = picked ?? (agents ? base.filter((s) => installed.has(s.adapter)) : base);
  // 겨루기: 두 번째 에이전트(codex)를 붙인다. 끄면 하나만 남는다
  const race = chosen.some((c) => c.adapter === RACER.adapter);
  const racerHere = !agents || installed.has(RACER.adapter);
  const setRace = (on: boolean) => setPicked(on ? [...chosen.filter((c) => c.adapter !== RACER.adapter), RACER] : chosen.filter((c) => c.adapter !== RACER.adapter));

  // ⌘K 는 검색도 겸한다 — 쓴 글이 이미 맡긴 일 제목에 들어 있으면 최대 3개
  const q = text.trim().toLowerCase();
  const found = useMemo(() => (inline || !q ? [] : (runs ?? []).filter((r) => `${r.triage?.title ?? ""} ${r.title}`.toLowerCase().includes(q)).slice(0, 3)), [inline, q, runs]);
  const goRun = (id: string) => {
    onClose();
    go(`/runs/${id}`);
  };

  const toggle = (s: AgentSpec) => {
    const cur = chosen;
    const has = cur.some((c) => c.label === s.label);
    setPicked(has ? cur.filter((c) => c.label !== s.label) : [...cur, s]);
  };

  const send = async (alsoGo = true) => {
    const body = text.trim();
    if (!body || busy || !channel) return;
    if (!chosen.length) return toast("에이전트를 하나 이상 골라 주세요", "err");
    setBusy(true);
    const t0 = Date.now();
    try {
      await api.postMessage(channel, user.name, /@willnew/i.test(body) ? body : `@willnew ${body}`, user.team, {
        template: tplId,
        agents: chosen,
        check: checkCmd,
      }, user.title || undefined, user.avatar);
      toast("맡겼어요 · 계획 에이전트가 읽고 바로 시작해요", "ok");
      onClose();
      if (!alsoGo) return go(`/chat/${channel}`);
      if (user.role === "requester") return go("/mine"); // 요청자는 작업 공간 대신 내 요청으로
      // the run is created after planning; follow it as soon as it exists
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const list = await api.runs().catch(() => [] as Run[]);
        const mine = list.find((r) => r.createdAt >= t0 - 2000 && r.requester === user.name);
        if (mine) return go(`/runs/${mine.id}`);
      }
      go(`/chat/${channel}`);
    } catch (e) {
      toast((e as Error).message, "err");
      setBusy(false);
    }
  };

  const askId = useId();
  const chName = channels.find((c) => c.id === channel)?.name;
  const who = chosen.map((c) => c.label).join(", ");
  return (
    <div className={inline ? "compose-inline" : "modal-back compose-back"} onMouseDown={(e) => !inline && e.target === e.currentTarget && onClose()}>
      <div className="compose" role={inline ? undefined : "dialog"} aria-modal={inline ? undefined : true} aria-label="새로 맡기기">
        <div className="compose-top">
          <label htmlFor={askId} className="sr">
            무엇을 맡길까요
          </label>
          <textarea
            id={askId}
            ref={area}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (found.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setSel((i) => Math.max(-1, Math.min(found.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
              } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (sel >= 0 && found[sel]) goRun(found[sel].id);
                else send(!(e.metaKey || e.ctrlKey));
              }
            }}
            placeholder="무엇을 맡길까요"
          />
        </div>

        {isDemo() && !text ? (
          <div className="examples compose-example">
            <button className="chip" onClick={() => setText(DEMO_REQUEST)}>
              {DEMO_REQUEST}
            </button>
          </div>
        ) : null}

        {noAgent ? (
          <p className="compose-note">
            이 PC 에 쓸 수 있는 에이전트가 없어요 · Claude Code 나 Codex 를 설치해 주세요{" "}
            <a href="https://github.com/Haejyn/willnew#실행" target="_blank" rel="noreferrer">
              설치 안내
            </a>
          </p>
        ) : null}

        {text.trim() ? (
          <button className="compose-plan" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <IconSpark size={14} />
            <span className="plan-text">
              {tpl?.name ?? "계획"} · {chosen.length ? (chosen.length > 1 ? `겨루기 ${chosen.length}개 (${who})` : `에이전트 1개 (${who})`) : "에이전트를 골라 주세요"} ·{" "}
              {checkCmd ? <span className="mono">{checkCmd} 로 확인</span> : <span className="warn-chip">검증 없이 사람이 판단</span>}
            </span>
            <IconChevron size={13} />
          </button>
        ) : null}

        {open ? (
          <div className="plan-grid">
            <span className="k">유형</span>
            <span className="chips">
              {templates.map((t) => (
                <button key={t.id} className={`chip ${t.id === tplId ? "on" : ""}`} aria-pressed={t.id === tplId} onClick={() => { setTemplate(t.id); setPicked(race ? [...t.agents, RACER] : null); setCheck(null); }}>
                  {t.name}
                </button>
              ))}
            </span>
            <span className="k">에이전트</span>
            <span className="chips">
              {options.map((s) => {
                const on = chosen.some((c) => c.label === s.label);
                const off = !!agents && !installed.has(s.adapter);
                return (
                  <button key={s.label} className={`chip ${on ? "on" : ""} ${off ? "off" : ""}`} aria-pressed={on} disabled={off && !on} onClick={() => toggle(s)} title={off ? "이 PC 에 없어요" : undefined}>
                    <AgentMark adapter={s.adapter} size={16} />
                    {s.label}
                  </button>
                );
              })}
            </span>
            <span className="k">검증</span>
            <span className="chips">
              <label className="chip input mono">
                <IconTerminal size={13} />
                <input aria-label="검증 명령" value={checkCmd} placeholder="없음" onChange={(e) => setCheck(e.target.value)} />
              </label>
              <span className="dim small">실패하면 로그를 붙여 1번 더 · 통과한 결과만 올라와요</span>
            </span>
          </div>
        ) : null}

        {found.length ? (
          <div className="compose-found" role="listbox" aria-label="이미 맡긴 일">
            <span className="lab">이미 맡긴 일</span>
            {found.map((r, i) => (
              <button key={r.id} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onClick={() => goRun(r.id)}>
                <Moon phase={runPhase(r).phase} size={14} />
                <span className="fname">{r.triage?.title ?? r.title}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="compose-foot">
          <div className="menu-wrap" ref={chBox}>
            <button className="btn sm" aria-haspopup="menu" aria-expanded={chOpen} disabled={!channels.length} onClick={() => setChOpen((o) => !o)}>
              {chName ? `#${chName}` : "채널"} <IconChevron size={12} />
            </button>
            {chOpen ? (
              <div className="menu up" role="menu">
                {channels.map((c) => (
                  <button key={c.id} role="menuitemradio" aria-checked={c.id === channel} onClick={() => { setChannel(c.id); setChOpen(false); }}>
                    #{c.name} <span className="dim">{TEAM_KO[c.team] ?? c.team}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button className={`chip race ${race ? "on" : ""}`} aria-pressed={race} disabled={!racerHere || noAgent} onClick={() => setRace(!race)} title={racerHere ? "같은 일을 에이전트 둘이 따로 풀고, 통과한 쪽을 골라요" : "Codex 가 이 PC 에 없어요"}>
            겨루기
          </button>
          {race ? <span className="dim small race-note">에이전트 2개, 비용도 약 2배</span> : null}
          <span className="hints">
            <Kbd>↵</Kbd> 맡기고 따라가기 <Kbd>⌘↵</Kbd> 채널로 {found.length ? <><Kbd>↑↓</Kbd> 이동</> : null} {inline ? null : <><Kbd>esc</Kbd> 닫기</>}
          </span>
          <span className="grow" />
          <button className="btn w" onClick={() => send()} disabled={!text.trim() || busy || !chosen.length || noAgent}>
            {busy ? <Spinner size={12} /> : <IconSend size={15} />} 맡기기
          </button>
        </div>
      </div>
    </div>
  );
}
