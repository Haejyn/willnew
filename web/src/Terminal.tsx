/** A real shell in the agent's worktree (xterm.js over a websocket). In demo mode, a small scripted stand-in. */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { AgentRun, Api, Run } from "./api";

function themeFromCss() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f;
  return {
    background: "rgba(0,0,0,0)",
    foreground: v("--text2", "#c9d1d9"),
    cursor: v("--accent", "#58a6ff"),
    cursorAccent: v("--bg", "#0d1117"),
    selectionBackground: "rgba(255,255,255,0.2)",
    black: "#21262d",
    brightBlack: v("--text4", "#7d8590"),
    green: v("--ok", "#3fb950"),
    brightGreen: v("--ok", "#3fb950"),
    red: v("--danger", "#f85149"),
    brightRed: v("--danger", "#f85149"),
    yellow: v("--accent", "#58a6ff"),
    brightYellow: v("--accent", "#58a6ff"),
  };
}

export function TerminalView({ api, run, agent }: { api: Api; run: Run; agent: AgentRun }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const term = new XTerm({
      fontFamily: css.getPropertyValue("--code").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowTransparency: true,
      theme: themeFromCss(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    const url = api.terminalUrl(run.id, agent.id, term.cols, term.rows);
    let ws: WebSocket | null = null;
    let disposeInput: { dispose(): void } | null = null;

    if (url) {
      ws = new WebSocket(url);
      ws.onopen = () => setState("open");
      ws.onclose = () => setState("closed");
      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
      disposeInput = term.onData((d) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "input", data: d })));
    } else {
      setState("open");
      disposeInput = demoShell(term, run, agent);
    }

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      } catch {
        /* hidden tab */
      }
    });
    ro.observe(el);
    term.focus();
    return () => {
      ro.disconnect();
      disposeInput?.dispose();
      ws?.close();
      term.dispose();
    };
  }, [api, run.id, agent.id]);

  return (
    <div className="term-wrap">
      <div className="term-bar mono">
        <span className={`dot ${state}`} />
        <span>{agent.worktree ? shortPath(agent.worktree) : agent.branch}</span>
        <span className="term-branch">{agent.branch}</span>
        {state === "closed" ? <span className="term-closed">연결이 끊겼어요 — 탭을 다시 열면 이어서 붙어요</span> : null}
      </div>
      <div className="term" ref={host} />
    </div>
  );
}

const shortPath = (p: string) => p.replace(/^.*?([^/\\]+[/\\][^/\\]+)$/, "…/$1");

/** Demo: a believable shell without a server. */
function demoShell(term: XTerm, run: Run, agent: AgentRun) {
  const prompt = () => term.write(`\r\n\x1b[2m${agent.branch}\x1b[0m \x1b[33m$\x1b[0m `);
  term.write(`\x1b[2mdemo shell — on a real server this is a live shell in the agent worktree\x1b[0m`);
  prompt();
  let line = "";
  const out: Record<string, string> = {
    "npm test": agent.check.output || "ℹ tests 0",
    "git status": `On branch ${agent.branch}\nnothing to commit, working tree clean`,
    "git log --oneline -3": `a91c2fd willnew: ${agent.label} (attempt ${agent.attempt})\n${run.baseRef.slice(0, 7)} duration: failing tests`,
    ls: "README.md  duration.js  duration.test.js  package.json",
    pwd: agent.worktree || "~",
  };
  return term.onData((d) => {
    if (d === "\r") {
      const cmd = line.trim();
      line = "";
      if (cmd) term.write(`\r\n${(out[cmd] ?? `${cmd}: demo shell knows npm test, git status, ls`).replace(/\n/g, "\r\n")}`);
      prompt();
    } else if (d === "\u007f") {
      if (line) {
        line = line.slice(0, -1);
        term.write("\b \b");
      }
    } else if (d >= " ") {
      line += d;
      term.write(d);
    }
  });
}
