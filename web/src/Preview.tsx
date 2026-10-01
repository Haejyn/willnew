/** A dev server started in the agent's worktree, shown inline. */
import { useState } from "react";
import type { AgentRun, Api, Run } from "./api";
import { isDemo } from "./api";
import { IconExternal, IconPlay, IconRefresh, IconStop } from "./icons";
import { Spinner, Tag, useToast } from "./ui";

export function PreviewView({ api, run, agent, command }: { api: Api; run: Run; agent: AgentRun; command: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const p = agent.preview;
  const live = p && (p.status === "ready" || p.status === "starting");

  if (!command && !isDemo())
    return (
      <div className="pane-empty">
        <b>미리보기 명령이 없어요</b>
        <span>
          서버를 <code>willnew serve --preview "npm run dev -- --port {"{port}"}"</code> 처럼 띄우면 에이전트마다 자기 워크트리에서 개발 서버를 열어 여기서 바로 눌러 볼 수 있어요.
        </span>
      </div>
    );

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.startPreview(run.id, agent.id);
      if (r.status === "failed") toast("미리보기가 뜨지 않았어요 — 로그를 확인해 주세요", "err");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  const stop = () => api.stopPreview(run.id, agent.id).catch((e: Error) => toast(e.message, "err"));
  const url = p ? api.previewUrl(p.port) : "";

  return (
    <div className="preview">
      <div className="preview-bar">
        {p ? (
          <Tag tone={p.status === "ready" ? "ok" : p.status === "failed" ? "bad" : p.status === "starting" ? "now" : "dim"}>
            {p.status === "ready" ? "실행 중" : p.status === "starting" ? "띄우는 중" : p.status === "failed" ? "실패" : "멈춤"}
          </Tag>
        ) : null}
        <span className="preview-url mono">{p ? (url || `localhost:${p.port}`) : command || "npm run dev"}</span>
        <span className="grow" />
        {p?.log ? (
          <button className="btn q sm" onClick={() => setShowLog((s) => !s)}>
            로그
          </button>
        ) : null}
        {live ? (
          <>
            <button className="ib sm" aria-label="새로고침" onClick={() => setNonce((n) => n + 1)}>
              <IconRefresh size={14} />
            </button>
            {url ? (
              <a className="ib sm" aria-label="새 탭에서 열기" href={url} target="_blank" rel="noreferrer">
                <IconExternal size={14} />
              </a>
            ) : null}
            <button className="ib sm" aria-label="미리보기 멈추기" onClick={stop}>
              <IconStop size={14} />
            </button>
          </>
        ) : (
          <button className="btn w sm" onClick={start} disabled={busy}>
            {busy ? <Spinner size={12} /> : <IconPlay size={13} />}
            {p ? "다시 띄우기" : "이 결과로 띄우기"}
          </button>
        )}
      </div>
      {showLog && p ? <pre className="preview-log mono">{p.log}</pre> : null}
      <div className="preview-frame">
        {p?.status === "ready" ? (
          url ? (
            <iframe key={nonce} title={`${agent.label} 미리보기`} src={url} />
          ) : (
            <iframe key={nonce} title={`${agent.label} 미리보기`} srcDoc={demoPage(agent.label)} />
          )
        ) : p?.status === "starting" ? (
          <div className="pane-empty">
            <Spinner size={16} />
            <span>워크트리에서 개발 서버를 띄우는 중이에요</span>
          </div>
        ) : (
          <div className="pane-empty">
            <span>이 에이전트의 워크트리로 개발 서버를 띄워 결과를 직접 눌러 봐요. 다른 에이전트와 포트가 겹치지 않아요.</span>
          </div>
        )}
      </div>
    </div>
  );
}

const demoPage = (label: string) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px/1.6 system-ui,sans-serif;background:#f7f7f8;color:#111;padding:28px}
h1{font-size:20px;margin:0 0 12px}table{border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
td,th{padding:10px 16px;text-align:left;border-bottom:1px solid #eee}th{font-size:12px;color:#666}code{background:#f0f0f2;padding:2px 6px;border-radius:5px}
.ok{color:#178a3d;font-weight:600}</style>
<h1>재생 시간 표시 · billing-api <small style="color:#888;font-weight:400">${label}</small></h1>
<table><tr><th>입력</th><th>parseDuration</th><th>formatDuration</th></tr>
<tr><td><code>1h30m</code></td><td>5400</td><td class="ok">1h30m</td></tr>
<tr><td><code>2d3h15m</code></td><td>184500</td><td class="ok">2d3h15m</td></tr>
<tr><td><code>45s</code></td><td>45</td><td class="ok">45s</td></tr>
<tr><td><code>0</code></td><td>0</td><td class="ok">0s</td></tr>
<tr><td><code>5x</code></td><td>NaN</td><td>—</td></tr></table>`;
