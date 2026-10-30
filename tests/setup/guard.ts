/**
 * Global setup: a snapshot of the real ~/.willnew before the run, compared after it. Any file a test created, changed
 * or removed there fails the run. (A willnew you are running yourself at the same time would trip it too.)
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL = join(homedir(), ".willnew");

/** path → size:mtime, three levels deep (runs/*.json, requests/*.json, worktrees/<run>/<agent>). */
function snapshot(dir = REAL, depth = 3, out = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    out.set(p, st.isDirectory() ? "dir" : `${st.size}:${st.mtimeMs}`);
    if (st.isDirectory() && depth > 1) snapshot(p, depth - 1, out);
  }
  return out;
}

export default function setup() {
  const before = snapshot();
  const existed = existsSync(REAL);
  return () => {
    const after = snapshot();
    const changed: string[] = [];
    if (!existed && existsSync(REAL)) changed.push(REAL);
    for (const [p, v] of after) if (before.get(p) !== v && v !== "dir") changed.push(p);
    for (const [p, v] of before) if (!after.has(p)) changed.push(`${p} (지워짐)`);
    for (const [p, v] of after) if (v === "dir" && !before.has(p)) changed.push(p);
    if (changed.length) throw new Error(`테스트가 실제 ${REAL} 를 건드렸어요:\n${changed.slice(0, 20).join("\n")}`);
  };
}
