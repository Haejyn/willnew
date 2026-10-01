/** Changes, unified or side by side, with optional line comments that can be handed back to the agent. */
import { Fragment, useMemo, useState } from "react";
import type { ReviewComment } from "./api";
import { IconPlus, IconTrash } from "./icons";
import { Avatar } from "./ui";
import { parsePatch, relTime, type FileDiff } from "./util";

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "hunk" | "note";
  old?: number;
  new?: number;
  text: string;
}

export function diffLines(f: FileDiff): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const l of f.lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ kind: "hunk", text: l });
    } else if (l.startsWith("+")) out.push({ kind: "add", new: n++, text: l.slice(1) });
    else if (l.startsWith("-")) out.push({ kind: "del", old: o++, text: l.slice(1) });
    else if (l.startsWith("\\")) out.push({ kind: "note", text: l });
    else out.push({ kind: "ctx", old: o++, new: n++, text: l.slice(1) });
  }
  return out;
}

const KW = /\b(export|function|const|let|var|return|if|else|for|of|in|while|import|from|class|new|async|await|throw|try|catch|def|fn|pub|type|interface)\b/g;
function Code({ text }: { text: string }) {
  // a light touch — keywords and strings; real highlighting is the editor's job
  const parts = useMemo(() => {
    const out: { t: string; c?: string }[] = [];
    let i = 0;
    const re = new RegExp(`${KW.source}|("[^"]*"|'[^']*'|\`[^\`]*\`)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > i) out.push({ t: text.slice(i, m.index) });
      out.push({ t: m[0], c: m[2] ? "str" : "kw" });
      i = m.index + m[0].length;
    }
    if (i < text.length) out.push({ t: text.slice(i) });
    return out;
  }, [text]);
  return (
    <>
      {parts.map((p, k) => (
        <span key={k} className={p.c}>
          {p.t}
        </span>
      ))}
    </>
  );
}

export interface CommentProps {
  comments: ReviewComment[];
  /** decided runs keep their comments visible but take no new ones */
  readOnly?: boolean;
  onAdd: (file: string, line: number, text: string) => Promise<void> | void;
  onDelete: (id: string) => void;
}

export function DiffFileView({ file, mode = "unified", commenting, openLine, setOpenLine }: {
  file: FileDiff;
  mode?: "unified" | "split";
  commenting?: CommentProps;
  openLine?: number | null;
  setOpenLine?: (n: number | null) => void;
}) {
  const lines = useMemo(() => diffLines(file), [file]);
  const byLine = useMemo(() => {
    const m = new Map<number, ReviewComment[]>();
    for (const c of commenting?.comments ?? []) if (c.file === file.path) m.set(c.line, [...(m.get(c.line) ?? []), c]);
    return m;
  }, [commenting?.comments, file.path]);

  const thread = (line: number) => {
    const list = byLine.get(line) ?? [];
    const open = openLine === line;
    if (!list.length && !open) return null;
    return (
      <div className="dl-thread">
        {list.map((c) => (
          <div key={c.id} className="cmt">
            <Avatar name={c.by} size={22} />
            <div className="cmt-body">
              <div className="cmt-head">
                <b>{c.by}</b> <span>{relTime(c.at)}</span>
                {c.sentAt ? <span className="cmt-sent">에이전트에게 보냄</span> : null}
              </div>
              <p>{c.text}</p>
            </div>
            {!c.sentAt && !commenting?.readOnly ? (
              <button className="ib sm" aria-label="댓글 지우기" onClick={() => commenting?.onDelete(c.id)}>
                <IconTrash size={14} />
              </button>
            ) : null}
          </div>
        ))}
        {open ? <CommentBox onCancel={() => setOpenLine?.(null)} onSave={async (t) => { await commenting?.onAdd(file.path, line, t); setOpenLine?.(null); }} /> : null}
      </div>
    );
  };

  const gutterBtn = (line?: number) =>
    commenting && !commenting.readOnly && line ? (
      <button className="dl-add" aria-label={`${line}행에 댓글`} onClick={() => setOpenLine?.(openLine === line ? null : line)}>
        <IconPlus size={12} />
      </button>
    ) : null;

  if (mode === "split") {
    // pair deletions with the additions that follow them
    const rows: { l?: DiffLine; r?: DiffLine; hunk?: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const x = lines[i];
      if (x.kind === "hunk" || x.kind === "note") rows.push({ hunk: x.text });
      else if (x.kind === "ctx") rows.push({ l: x, r: x });
      else if (x.kind === "del") {
        const dels: DiffLine[] = [];
        while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
        const adds: DiffLine[] = [];
        while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
        i--;
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ l: dels[k], r: adds[k] });
      } else rows.push({ r: x });
    }
    return (
      <div className="diff split">
        {rows.map((row, k) =>
          row.hunk ? (
            <div key={k} className="dl hunk">
              <span className="dl-code">{row.hunk}</span>
            </div>
          ) : (
            <Fragment key={k}>
              <div className="dl-split">
                <div className={`dl ${row.l?.kind === "del" ? "del" : ""} ${row.l ? "" : "empty"}`}>
                  <span className="dl-n">{row.l?.old ?? ""}</span>
                  <span className="dl-s">{row.l?.kind === "del" ? "−" : ""}</span>
                  <span className="dl-code">{row.l ? <Code text={row.l.text} /> : null}</span>
                </div>
                <div className={`dl ${row.r?.kind === "add" ? "add" : ""} ${row.r ? "" : "empty"}`}>
                  {gutterBtn(row.r?.new)}
                  <span className="dl-n">{row.r?.new ?? ""}</span>
                  <span className="dl-s">{row.r?.kind === "add" ? "+" : ""}</span>
                  <span className="dl-code">{row.r ? <Code text={row.r.text} /> : null}</span>
                </div>
              </div>
              {row.r?.new ? thread(row.r.new) : null}
            </Fragment>
          ),
        )}
      </div>
    );
  }

  return (
    <div className="diff">
      {lines.map((x, k) =>
        x.kind === "hunk" || x.kind === "note" ? (
          <div key={k} className="dl hunk">
            <span className="dl-code">{x.text}</span>
          </div>
        ) : (
          <Fragment key={k}>
            <div className={`dl ${x.kind}`}>
              {gutterBtn(x.new)}
              <span className="dl-n">{x.old ?? ""}</span>
              <span className="dl-n">{x.new ?? ""}</span>
              <span className="dl-s">{x.kind === "add" ? "+" : x.kind === "del" ? "−" : ""}</span>
              <span className="dl-code">
                <Code text={x.text} />
              </span>
            </div>
            {x.new ? thread(x.new) : null}
          </Fragment>
        ),
      )}
    </div>
  );
}

function CommentBox({ onSave, onCancel }: { onSave: (t: string) => Promise<void> | void; onCancel: () => void }) {
  const [t, setT] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!t.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(t.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cmt-box">
      <textarea
        autoFocus
        rows={2}
        value={t}
        placeholder="이 줄에 대한 의견 — 모아서 에이전트에게 다시 맡길 수 있어요"
        aria-label="댓글"
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="cmt-actions">
        <button className="btn q sm" onClick={onCancel}>
          취소
        </button>
        <button className="btn w sm" onClick={save} disabled={!t.trim() || busy}>
          댓글 남기기
        </button>
      </div>
    </div>
  );
}

/** Read-only changes for the agent pane. */
export function DiffAll({ patch }: { patch: string }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  if (!files.length) return <div className="pane-empty">아직 바뀐 파일이 없어요.</div>;
  return (
    <div className="diff-all">
      {files.map((f) => (
        <section key={f.path} className="diff-file">
          <header className="diff-file-head mono">
            {f.path}
            <span>
              <span className="add">+{f.add}</span> <span className="del">−{f.del}</span>
            </span>
          </header>
          <DiffFileView file={f} />
        </section>
      ))}
    </div>
  );
}
