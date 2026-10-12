/** 검토 · 승인 — 파일을 하나씩 확인하고, 줄에 의견을 남겨 다시 맡기거나, 근거를 보고 병합한다. */
import { useEffect, useMemo, useState } from "react";
import type { AgentRun, Api } from "./api";
import { DecisionBar } from "./Decision";
import { DiffFileView } from "./Diff";
import { useLiveRun } from "./flow";
import { AgentMark, IconArrowLeft, IconBranch, IconCheck, IconCheckCircle, IconColumns, IconEye, IconFile, IconFileCode, IconHistory, IconSend, IconTerminal, IconXCircle } from "./icons";
import { RunHead } from "./moon";
import { ErrorBox, Modal, Tag, agentState, useToast } from "./ui";
import { fmtCost, fmtDuration, fmtTokens, isActive, parsePatch, suggestWinner, totalTokens, useMedia, useNow, winnerReason, type User } from "./util";

export function Review({ api, id, user, go, initialAgent, watched, onWatch }: { api: Api; id: string; user: User; go: (p: string) => void; initialAgent?: string; watched: boolean; onWatch: () => void }) {
  const { run, error, reload } = useLiveRun(api, id);
  const toast = useToast();
  const [agentId, setAgentId] = useState<string | null>(initialAgent ?? null);
  const [compare, setCompare] = useState(false);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [fileIdx, setFileIdx] = useState(0);
  const [openLine, setOpenLine] = useState<number | null>(null);
  const [log, setLog] = useState(false);
  const phone = !useMedia("(min-width: 768px)");
  const now = useNow(1000, !!run?.agents.some(isActive));

  const winnerId = run ? suggestWinner(run) : null;
  const candidates = useMemo(() => run?.agents.filter((a) => a.diff.files > 0 || a.status === "done") ?? [], [run]);
  const agent: AgentRun | undefined = run?.agents.find((a) => a.id === (agentId ?? winnerId)) ?? candidates[0];
  const files = useMemo(() => (agent ? parsePatch(agent.diff.patch) : []), [agent?.diff.patch]); // eslint-disable-line react-hooks/exhaustive-deps
  const file = files[Math.min(fileIdx, Math.max(0, files.length - 1))];
  const reviewed = new Set((agent && run?.reviewed?.[agent.id]) ?? []);
  const comments = (run?.comments ?? []).filter((c) => c.agentId === agent?.id);
  const unsent = comments.filter((c) => !c.sentAt);
  const decided = run?.review.status === "approved" || run?.review.status === "rejected";

  useEffect(() => {
    setFileIdx(0);
    setOpenLine(null);
  }, [agent?.id]);
  const toggleReviewed = (path: string) => {
    if (!run || !agent) return;
    api.setReviewed(run.id, agent.id, path, !reviewed.has(path)).catch((e: Error) => toast(e.message, "err"));
  };

  // J/K files · C comment (⌘↵ 승인 · R 반려 는 결정 바가 받는다)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("textarea, input") || e.metaKey || e.ctrlKey) return;
      if (e.key === "j") setFileIdx((i) => Math.min(files.length - 1, i + 1));
      else if (e.key === "k") setFileIdx((i) => Math.max(0, i - 1));
      else if (e.key === "c" && file) {
        const first = file.lines.findIndex((l) => l.startsWith("+") && !l.startsWith("+++"));
        if (first >= 0) {
          const h = file.lines.slice(0, first).reverse().find((l) => l.startsWith("@@"));
          const start = h ? Number(/\+(\d+)/.exec(h)?.[1] ?? 1) : 1;
          const ctx = file.lines.slice(file.lines.indexOf(h ?? ""), first).filter((l) => !l.startsWith("-") && !l.startsWith("@@")).length;
          setOpenLine(start + ctx);
        }
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [files.length, file]);

  if (error && !run) return <div className="page"><ErrorBox error={`불러오기 실패 · ${error}`} onRetry={reload} /></div>;
  if (!run)
    return (
      <div className="page" aria-busy>
        <div className="skel" style={{ height: 56, width: "50%", marginBottom: 16 }} />
        <div className="skel" style={{ height: 320 }} />
      </div>
    );

  const sendBack = async () => {
    if (!agent) return;
    try {
      await api.sendComments(run.id, agent.id, user.name);
      toast(`댓글 ${unsent.length}개를 ${agent.label} 에게 보냈어요 — 고친 뒤 검증 관문을 다시 지나요`, "ok");
      go(`/runs/${run.id}/agent/${agent.id}/log`);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const agentLink = (tab: string) => (agent ? `#/runs/${run.id}/agent/${agent.id}/${tab}` : `#/runs/${run.id}`);
  const doneFiles = files.filter((f) => reviewed.has(f.path)).length;

  return (
    <div className="rv">
      <RunHead
        run={run}
        now={now}
        lead={
          <a className="ib" href={`#/runs/${run.id}`} aria-label="작업 공간" title="작업 공간">
            <IconArrowLeft size={18} />
          </a>
        }
      />
      <nav className="rv-nav" aria-label="바뀐 파일">
        <section>
          <div className="sec-head">
            <span className="lab">바뀐 파일</span>
            <span className="mono dim small">
              검토 {doneFiles}/{files.length}
            </span>
          </div>
          <div className="meter">
            <i style={{ width: files.length ? `${(doneFiles / files.length) * 100}%` : 0 }} />
          </div>
          <ul className="files">
            {files.map((f, i) => (
              <li key={f.path} className={i === fileIdx ? "on" : ""}>
                <input type="checkbox" checked={reviewed.has(f.path)} aria-label={`${f.path} 검토함`} onChange={() => toggleReviewed(f.path)} />
                <button className="mono" onClick={() => setFileIdx(i)}>
                  {/\.(md|txt)$/.test(f.path) ? <IconFile size={14} /> : <IconFileCode size={14} />}
                  <span className="fname">{f.path}</span>
                  <span className="fstat">
                    <span className="add">+{f.add}</span> {f.del ? <span className="del">−{f.del}</span> : null}
                  </span>
                </button>
              </li>
            ))}
            {!files.length ? <li className="dim small">바뀐 파일이 없어요</li> : null}
          </ul>
        </section>
        <section className="links">
          <span className="lab">살펴보기</span>
          <button onClick={() => setLog(true)}>
            <IconTerminal size={15} /> 검증 로그
          </button>
          <a href={agentLink("preview")}>
            <IconEye size={15} /> 미리보기
          </a>
          <a href={agentLink("log")}>
            <IconHistory size={15} /> 대화 전체 · {agent?.turns ?? 0}턴
          </a>
          <a href={agentLink("term")}>
            <IconTerminal size={15} /> 워크트리 터미널
          </a>
          {agent?.worktree ? (
            <a href={`vscode://file/${agent.worktree.replace(/\\/g, "/")}`}>
              <IconFileCode size={15} /> VS Code 에서 열기
            </a>
          ) : null}
        </section>
      </nav>

      <main className="rv-main">
        <div className="rv-bar">
          <div className="seg" role="tablist" aria-label="결과 고르기">
            {candidates.map((a) => {
              const st = agentState(a, run.maxAttempts);
              return (
                <button key={a.id} role="tab" aria-selected={!compare && a.id === agent?.id} className={!compare && a.id === agent?.id ? "on" : ""} onClick={() => { setCompare(false); setAgentId(a.id); }}>
                  <AgentMark adapter={a.adapter} size={16} />
                  {a.label}
                  {st.tone === "ok" ? <IconCheck size={12} className="ok" /> : st.tone === "bad" ? <IconXCircle size={12} className="bad" /> : null}
                </button>
              );
            })}
            {candidates.length > 1 ? (
              <button role="tab" aria-selected={compare} className={compare ? "on" : ""} onClick={() => setCompare(true)}>
                <IconColumns size={14} /> 둘 비교
              </button>
            ) : null}
          </div>
          <span className="mono dim small branch">
            <IconBranch size={13} /> {agent?.branch} ← {run.baseBranch}
          </span>
          <span className="grow" />
          {!compare ? (
            <div className="seg" role="tablist" aria-label="보기 방식">
              <button role="tab" aria-selected={mode === "unified"} className={mode === "unified" ? "on" : ""} onClick={() => setMode("unified")}>
                한 줄
              </button>
              <button role="tab" aria-selected={mode === "split"} className={mode === "split" ? "on" : ""} onClick={() => setMode("split")}>
                나란히
              </button>
            </div>
          ) : null}
        </div>

        <div className="rv-diff mono">
          {compare ? (
            <div className="compare">
              {candidates.slice(0, 2).map((a) => {
                const f = parsePatch(a.diff.patch).find((x) => x.path === file?.path) ?? parsePatch(a.diff.patch)[0];
                return (
                  <section key={a.id}>
                    <header className="diff-file-head">
                      <AgentMark adapter={a.adapter} size={16} /> {a.label} <span className="dim">{f?.path}</span>
                    </header>
                    {f ? <DiffFileView file={f} /> : <div className="pane-empty">이 파일은 바꾸지 않았어요</div>}
                  </section>
                );
              })}
            </div>
          ) : file ? (
            <>
              <header className="diff-file-head">
                <IconFileCode size={14} /> {file.path}
                <span>
                  <span className="add">+{file.add}</span> <span className="del">−{file.del}</span>
                </span>
                <label className="reviewed">
                  <input type="checkbox" checked={reviewed.has(file.path)} onChange={() => toggleReviewed(file.path)} /> 검토함
                </label>
              </header>
              <DiffFileView
                file={file}
                mode={mode}
                openLine={openLine}
                setOpenLine={setOpenLine}
                commenting={
                  decided
                    ? { comments, readOnly: true, onAdd: () => undefined, onDelete: () => undefined }
                    : {
                        comments,
                        onAdd: async (path, line, text) => {
                          await api.addComment(run.id, { agentId: agent!.id, file: path, line, text, by: user.name });
                        },
                        onDelete: (cid) => api.deleteComment(run.id, cid).catch((e: Error) => toast(e.message, "err")),
                      }
                }
              />
            </>
          ) : (
            <div className="pane-empty">{agent ? "이 결과는 바꾼 파일이 없어요" : "검토할 결과가 없어요"}</div>
          )}
        </div>

        {unsent.length && !decided ? (
          <div className="sendback">
            <span>
              댓글 {unsent.length}개 · {agent?.label} 에게 다시 맡기면 고친 뒤 검증 관문부터 다시 지나요
            </span>
            <button className="btn w sm" onClick={sendBack}>
              <IconSend size={13} /> {agent?.label} 에게 다시 맡기기
            </button>
          </div>
        ) : null}

        <DecisionBar api={api} run={run} user={user} go={go} now={now} watched={watched} onWatch={onWatch} agentId={agent?.id} slide={phone} keys onRevise={() => (unsent.length ? sendBack() : go(agentLink("log").slice(1)))} />
      </main>

      <aside className="rv-side" aria-label="병합 전 확인">
        <section className="card">
          <h2>확인</h2>
          {agent ? (
            <>
              <Gate ok={agent.check.status === "passed" ? true : agent.check.status === "failed" ? false : null} title={agent.check.status === "passed" ? "검증 관문 통과" : agent.check.status === "failed" ? "검증 관문 실패" : "검증 없음"} sub={run.checkCmd ? `${run.checkCmd} · ${agent.check.durationMs ? fmtDuration(agent.check.durationMs) : ""}` : "검증 명령이 없는 요청"} />
              <Gate ok={files.length ? (doneFiles === files.length ? true : null) : null} title={`파일 검토 ${doneFiles}/${files.length}`} sub={doneFiles < files.length ? `${files.find((f) => !reviewed.has(f.path))?.path ?? ""} 남음` : "모두 봤어요"} />
            </>
          ) : null}
        </section>
        {run.agents.length > 1 ? (
          <section className="card">
            <div className="card-head">
              <h2>결과 비교</h2>
              {winnerId ? <Tag tone="now">추천</Tag> : null}
            </div>
            <div className="cmp" style={{ gridTemplateColumns: `52px repeat(${run.agents.length}, minmax(0, 1fr))` }}>
              <span />
              {run.agents.map((a) => (
                <span key={a.id} className="cmp-h">
                  <AgentMark adapter={a.adapter} size={16} /> {a.label}
                </span>
              ))}
              <Row label="검증" vals={run.agents.map((a) => { const st = agentState(a, run.maxAttempts); return <span className={st.tone === "ok" ? "ok" : st.tone === "bad" ? "bad" : ""}>{st.text}</span>; })} />
              <Row label="시간" vals={run.agents.map((a) => fmtDuration(a.durationMs))} />
              <Row label="비용" vals={run.agents.map((a) => (a.usage.costUsd == null ? <span className="dim">미보고</span> : fmtCost(a.usage.costUsd)))} />
              <Row label="변경" vals={run.agents.map((a) => <><span className="add">+{a.diff.insertions}</span> <span className="del">−{a.diff.deletions}</span></>)} />
              <Row label="토큰" vals={run.agents.map((a) => fmtTokens(totalTokens(a)))} />
            </div>
            <p className="reason">{winnerReason(run, winnerId)}</p>
          </section>
        ) : null}
        <section className="after">
          <span className="lab">병합하면</span>
          <ul>
            <li>
              <span className="mono">--no-ff</span> 로 {run.baseBranch} 에 반영
            </li>
            {run.channel ? <li>#{run.channel} 스레드에 결과 알림</li> : null}
            <li>지표에 기록 · 워크트리는 지울 때까지 남아요</li>
          </ul>
        </section>
      </aside>

      {log && agent ? (
        <Modal title={`${agent.label} 검증 로그`} confirmLabel="닫기" onClose={() => setLog(false)} onConfirm={() => setLog(false)}>
          <pre className="checklog mono">{agent.check.output || "출력이 없어요"}</pre>
        </Modal>
      ) : null}
    </div>
  );
}

function Gate({ ok, title, sub }: { ok: boolean | null; title: string; sub?: string }) {
  return (
    <div className={`gate ${ok === true ? "ok" : ok === false ? "bad" : "dim"}`}>
      <span className="gate-i">{ok === true ? <IconCheckCircle size={16} /> : ok === false ? <IconXCircle size={16} /> : <IconHistory size={16} />}</span>
      <span>
        <b>{title}</b>
        {sub ? <span className="sub">{sub}</span> : null}
      </span>
    </div>
  );
}

function Row({ label, vals }: { label: string; vals: React.ReactNode[] }) {
  return (
    <>
      <span className="cmp-l">{label}</span>
      {vals.map((v, i) => (
        <span key={i} className="cmp-v mono">
          {v}
        </span>
      ))}
    </>
  );
}
