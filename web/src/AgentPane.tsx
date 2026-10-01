/** One agent: what it is doing (진행), a shell in its worktree (터미널), its changes (변경), its running app (미리보기). */
import { memo, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentRun, Api, Run } from "./api";
import { DiffAll } from "./Diff";
import { AgentMark, IconCheckCircle, IconEdit, IconFile, IconHistory, IconSend, IconSpark, IconStop, IconTerminal, IconXCircle, Star } from "./icons";
import { PreviewView } from "./Preview";
import { TerminalView } from "./Terminal";
import { Spinner, Tag, agentState, useToast } from "./ui";
import { agentElapsed, fmtClock, fmtCost, fmtTokens, isActive, shortenPaths, totalTokens, type User } from "./util";

export type PaneTab = "log" | "term" | "diff" | "preview";
export const TABS: { id: PaneTab; label: string }[] = [
  { id: "log", label: "진행" },
  { id: "term", label: "터미널" },
  { id: "diff", label: "변경" },
  { id: "preview", label: "미리보기" },
];

export function AgentPane({
  api,
  run,
  agent: a,
  now,
  user,
  tab,
  onTab,
  focused,
  onFocus,
  previewCommand,
  inputRef,
}: {
  api: Api;
  run: Run;
  agent: AgentRun;
  now: number;
  user: User;
  tab: PaneTab;
  onTab: (t: PaneTab) => void;
  focused: boolean;
  onFocus: () => void;
  previewCommand: string;
  inputRef?: (el: HTMLTextAreaElement | null) => void;
}) {
  const toast = useToast();
  const st = agentState(a, run.maxAttempts);
  const active = isActive(a);
  const cost = a.usage.costUsd;
  const holds = active; // this agent holds the turn right now

  return (
    <section className={`pane ${holds ? "holds" : ""} ${focused ? "focused" : ""}`} aria-label={a.label} onMouseDown={onFocus}>
      <header className="pane-head">
        <AgentMark adapter={a.adapter} size={20} />
        <b className="pane-name">{a.label}</b>
        <Tag>시도 {a.attempt}</Tag>
        <Tag tone={st.tone}>{st.text}</Tag>
        <span className="grow" />
        <span className="pane-meter mono">
          {fmtClock(agentElapsed(a, now))}
          {totalTokens(a) ? ` · ${fmtTokens(totalTokens(a))}` : ""}
          {cost != null ? ` · ${fmtCost(cost)}` : ""}
        </span>
        {active ? (
          <button
            className="ib sm"
            aria-label={`${a.label} 중지`}
            title="이 에이전트만 멈춰요"
            onClick={() => api.cancel(run.id, a.id).catch((e: Error) => toast(e.message, "err"))}
          >
            <IconStop size={14} />
          </button>
        ) : null}
      </header>
      <div className="pane-tabs" role="tablist" aria-label={`${a.label} 보기`}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => onTab(t.id)}>
            {t.label}
            {t.id === "diff" && a.diff.files ? <span className="tab-count">{a.diff.files}</span> : null}
            {t.id === "preview" && a.preview?.status === "ready" ? <span className="tab-live" /> : null}
          </button>
        ))}
      </div>
      <div className="pane-body">
        {tab === "log" ? <Transcript a={a} active={active} /> : null}
        {tab === "term" ? <TerminalView api={api} run={run} agent={a} /> : null}
        {tab === "diff" ? <DiffAll patch={a.diff.patch} /> : null}
        {tab === "preview" ? <PreviewView api={api} run={run} agent={a} command={previewCommand} /> : null}
      </div>
      <Steer api={api} run={run} a={a} user={user} inputRef={inputRef} />
    </section>
  );
}

function Steer({ api, run, a, user, inputRef }: { api: Api; run: Run; a: AgentRun; user: User; inputRef?: (el: HTMLTextAreaElement | null) => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const closed = run.review.status === "approved";
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.steer(run.id, a.id, t, user.name);
      setText("");
      toast(
        isActive(a)
          ? a.status === "checking"
            ? "검증이 끝나면 바로 이어서 반영해요"
            : `${a.label} 이 지금 턴을 멈추고 이어서 반영해요`
          : `${a.label} 이 다시 작업해요 — 끝나면 검증 관문을 다시 지나요`,
        "ok",
      );
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  const id = `steer-${a.id}`;
  return (
    <form
      className="steer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor={id} className="sr">
        {a.label} 에게 지시
      </label>
      <textarea
        id={id}
        ref={inputRef}
        rows={1}
        value={text}
        disabled={closed}
        placeholder={closed ? "병합된 요청이에요" : `${a.label} 에게 이어서 지시…`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <span className="steer-hint mono">↵</span>
      <button className="ib sm" type="submit" aria-label="보내기" disabled={!text.trim() || busy || closed}>
        {busy ? <Spinner size={12} /> : <IconSend size={15} />}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------- transcript

const PRIMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description"];

export function toolParts(text: string): { name: string; arg: string } {
  const t = text.trim();
  const sp = t.indexOf(" ");
  const name = sp < 0 ? t : t.slice(0, sp);
  const rest = sp < 0 ? "" : t.slice(sp + 1).trim();
  if (rest.startsWith("{")) {
    try {
      const j = JSON.parse(rest.replace(/ …$/, ""));
      for (const k of PRIMARY_KEYS) if (typeof j[k] === "string") return { name, arg: j[k] };
      return { name, arg: "" };
    } catch {
      const m = /"(?:command|file_path|path|pattern)"\s*:\s*"([^"]*)/.exec(rest);
      return { name, arg: m ? m[1] : "" };
    }
  }
  return { name, arg: rest };
}

function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (/read|glob|grep|ls|view/.test(n)) return <IconFile size={14} />;
  if (/edit|write|patch|change/.test(n)) return <IconEdit size={14} />;
  if (/bash|shell|exec|command/.test(n)) return <IconTerminal size={14} />;
  return <IconSpark size={14} />;
}

const Line = memo(function Line({ e, startedAt, worktree }: { e: AgentEvent; startedAt?: number; worktree?: string }) {
  const t = startedAt ? fmtClock(Math.max(0, e.ts - startedAt)) : "";
  const text = shortenPaths(e.text, worktree);
  if (e.kind === "text")
    return (
      <div className="ln say">
        <span className="ln-t">{t}</span>
        <span className="ln-i" />
        <span className="ln-x">{text.replace(/^💭\s*/, "")}</span>
      </div>
    );
  if (e.kind === "tool") {
    const { name, arg } = toolParts(text);
    return (
      <div className="ln tool">
        <span className="ln-t">{t}</span>
        <span className="ln-i">{toolIcon(name)}</span>
        <span className="ln-x">
          <b>{name}</b> {arg}
        </span>
      </div>
    );
  }
  if (e.kind === "check") {
    const ok = /통과|passed/.test(text);
    const bad = /실패|failed/.test(text);
    return (
      <div className={`ln check ${ok ? "ok" : bad ? "bad" : ""}`}>
        <span className="ln-t">{t}</span>
        <span className="ln-i">{ok ? <IconCheckCircle size={14} /> : bad ? <IconXCircle size={14} /> : <IconTerminal size={14} />}</span>
        <span className="ln-x">{text.startsWith("$") ? text : `검증 관문 · ${text}`}</span>
      </div>
    );
  }
  if (e.kind === "steer")
    return (
      <div className="ln steer-ln">
        <span className="ln-t">{t}</span>
        <span className="ln-i">
          <Star size={12} />
        </span>
        <span className="ln-x">{text}</span>
      </div>
    );
  return (
    <div className={`ln ${e.kind === "error" ? "bad" : "dim"}`}>
      <span className="ln-t">{t}</span>
      <span className="ln-i">{e.kind === "plan" ? <IconHistory size={14} /> : e.kind === "error" ? <IconXCircle size={14} /> : null}</span>
      <span className="ln-x">{text}</span>
    </div>
  );
});

function Transcript({ a, active }: { a: AgentRun; active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const events = a.events ?? [];
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <div
      className="log mono"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {!events.length ? <div className="pane-empty">{active ? "워크트리를 준비하는 중이에요" : "기록이 없어요"}</div> : null}
      {events.map((e, i) => (
        <Line key={i} e={e} startedAt={a.startedAt} worktree={a.worktree} />
      ))}
      {active ? (
        <div className="ln dim">
          <span className="ln-t" />
          <span className="ln-i" />
          <span className="ln-x">
            <span className="caret" />
          </span>
        </div>
      ) : null}
      {!active && a.summary ? (
        <div className="summary">
          <span className="lab">마지막 보고</span>
          <p>{a.summary}</p>
        </div>
      ) : null}
    </div>
  );
}
