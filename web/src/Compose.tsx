/** 새로 맡기기 (⌘K · ⌘N) — 쓰면 계획 에이전트가 미리 읽은 것을 보여 주고, 바꿀 수 있다. 보내면 팀 채널에 남는다. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, AgentSpec, Api, Channel, Run, Template, Triage } from "./api";
import { AgentMark, IconHistory, IconSend, IconSpark, IconTerminal } from "./icons";
import { Kbd, Spinner, useToast } from "./ui";
import { TEAM_KO, adapterName, relTime, type User } from "./util";

export function Compose({ api, user, agents, runs, onClose, go, initialChannel }: {
  api: Api;
  user: User;
  agents: AgentInfo[] | null;
  runs: Run[] | null;
  onClose: () => void;
  go: (p: string) => void;
  initialChannel?: string;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<Triage | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState(initialChannel ?? "");
  const [template, setTemplate] = useState<string | null>(null);
  const [picked, setPicked] = useState<AgentSpec[] | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => undefined);
    api.channels().then((c) => {
      setChannels(c);
      setChannel((cur) => cur || c.find((x) => x.team === user.team)?.id || c[0]?.id || "");
    }).catch(() => undefined);
    area.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, user.team, onClose]);

  // instant preview from keyword rules while typing; the planner agent decides for real on send
  useEffect(() => {
    if (!text.trim()) return setPlan(null);
    const t = setTimeout(() => api.plan(text).then(setPlan).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [api, text]);

  const tplId = template ?? plan?.template ?? "bugfix";
  const tpl = templates.find((t) => t.id === tplId);
  const chosen = picked ?? tpl?.agents ?? plan?.agents ?? [];
  const checkCmd = check ?? (tpl?.check || plan?.check || "");
  const options = useMemo(() => {
    const out: AgentSpec[] = [];
    const add = (s: AgentSpec) => !out.some((o) => o.label === s.label) && out.push(s);
    for (const t of templates) t.agents.forEach(add);
    for (const a of agents ?? []) if (a.installed && !out.some((o) => o.adapter === a.id)) add({ adapter: a.id, label: a.id });
    return out;
  }, [templates, agents]);
  const installed = new Set((agents ?? []).filter((a) => a.installed).map((a) => a.id));

  const toggle = (s: AgentSpec) => {
    const cur = chosen;
    const has = cur.some((c) => c.label === s.label);
    setPicked(has ? cur.filter((c) => c.label !== s.label) : [...cur, s]);
  };

  const send = async (alsoGo = true) => {
    const body = text.trim();
    if (!body || busy || !channel) return;
    if (!chosen.length) return toast("에이전트를 하나 이상 고르세요", "err");
    setBusy(true);
    const t0 = Date.now();
    try {
      await api.postMessage(channel, user.name, /@willnew/i.test(body) ? body : `@willnew ${body}`, user.team, {
        template: tplId,
        agents: chosen,
        check: checkCmd,
      });
      toast("맡겼어요 — 계획 에이전트가 읽고 바로 시작해요", "ok");
      onClose();
      if (!alsoGo) return go(`/chat/${channel}`);
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

  const recent = (runs ?? []).slice(0, 3);
  return (
    <div className="modal-back compose-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="compose" role="dialog" aria-modal aria-label="새로 맡기기">
        <div className="compose-top">
          <label htmlFor="ask" className="lab">
            무엇을 맡길까요
          </label>
          <textarea
            id="ask"
            ref={area}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(!(e.metaKey || e.ctrlKey));
              }
            }}
            placeholder={'예: duration 테스트 7개가 다 깨졌어. "2d3h15m" 같은 복합 시간 파싱 고쳐줘'}
          />
        </div>

        <div className="compose-plan">
          <div className="plan-note">
            <IconSpark size={14} /> {plan ? "계획 에이전트가 미리 읽은 것 · 바꿀 수 있어요" : "쓰기 시작하면 유형 · 에이전트 · 검증을 미리 골라 둬요"}
          </div>
          <div className="plan-grid">
            <span className="k">유형</span>
            <span className="chips">
              {templates.map((t) => (
                <button key={t.id} className={`chip ${t.id === tplId ? "on" : ""}`} aria-pressed={t.id === tplId} onClick={() => { setTemplate(t.id); setPicked(null); setCheck(null); }}>
                  {t.name}
                </button>
              ))}
            </span>
            <span className="k">채널</span>
            <span className="chips">
              {channels.map((c) => (
                <button key={c.id} className={`chip ${c.id === channel ? "on" : ""}`} aria-pressed={c.id === channel} onClick={() => setChannel(c.id)}>
                  #{c.name} <span className="dim">{TEAM_KO[c.team] ?? c.team}</span>
                </button>
              ))}
            </span>
            <span className="k">에이전트</span>
            <span className="chips">
              {options.map((s) => {
                const on = chosen.some((c) => c.label === s.label);
                const off = agents && !installed.has(s.adapter);
                return (
                  <button key={s.label} className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(s)} title={off ? `${adapterName(s.adapter)} 가 이 PC 에 없어요` : undefined}>
                    <AgentMark adapter={s.adapter} size={16} />
                    {s.label}
                    {off ? <span className="dim">· 없음</span> : null}
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
        </div>

        <div className="compose-foot">
          <span className="hints">
            <Kbd>↵</Kbd> 맡기고 따라가기 <Kbd>⌘↵</Kbd> 맡기고 채널로 <Kbd>esc</Kbd> 닫기
          </span>
          <span className="grow" />
          <button className="btn m" onClick={() => send()} disabled={!text.trim() || busy || !chosen.length}>
            {busy ? <Spinner size={12} /> : <IconSend size={15} />} 맡기기
          </button>
        </div>

        {recent.length ? (
          <div className="compose-recent">
            <span className="lab">최근 맡긴 일</span>
            {recent.map((r) => (
              <button key={r.id} onClick={() => setText(r.task.replace(/^.*?Request:\s*/s, ""))}>
                <IconHistory size={14} /> {r.triage?.title ?? r.title}
                <span className="dim small">
                  {r.channel ? `#${r.channel} · ` : ""}
                  {relTime(r.createdAt)} · 다시 쓰기
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
