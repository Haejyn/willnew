/**
 * Copies of the store. `willnew backup` writes ~/.willnew/backups/willnew-<date>.sqlite with VACUUM INTO (a consistent
 * snapshot even while the server writes) and keeps the newest 7. `serve` makes one a day. export writes plain JSON,
 * restore takes either and backs up the current store first.
 */
import { copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HOME } from "../home.js";
import { SqliteTicketStore, type StoreDump } from "./sqlite.js";

export const KEEP_BACKUPS = 7;
export const backupDir = (home = HOME) => join(home, "backups");

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d: Date) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const OURS = /^willnew-\d{4}-\d{2}-\d{2}(-\d{6})?(-\d+)?\.sqlite$/;

/** Newest first. Only files this module named; anything else in the folder is left alone. */
export function listBackups(dir = backupDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => OURS.test(f)).sort().reverse().map((f) => join(dir, f));
}

function prune(dir: string, keep = KEEP_BACKUPS): string[] {
  const gone = listBackups(dir).slice(keep);
  for (const f of gone) unlinkSync(f);
  return gone;
}

/**
 * One snapshot. With `out` it goes exactly there and nothing is pruned. Without it: willnew-<date>.sqlite in the
 * backups folder (willnew-<date>-<time>.sqlite when today's already exists), then only the newest 7 are kept.
 */
export function backup(store: SqliteTicketStore, opts: { out?: string; dir?: string; now?: Date } = {}): { file: string; pruned: string[] } {
  const now = opts.now ?? new Date();
  if (opts.out) {
    const file = resolve(opts.out);
    if (existsSync(file)) throw new Error(`이미 있는 파일이에요: ${file}`);
    store.vacuumInto(file);
    return { file, pruned: [] };
  }
  const dir = opts.dir ?? backupDir();
  let file = join(dir, `willnew-${day(now)}.sqlite`);
  if (existsSync(file)) file = join(dir, `willnew-${day(now)}-${clock(now)}.sqlite`);
  for (let i = 2; existsSync(file); i++) file = join(dir, `willnew-${day(now)}-${clock(now)}-${i}.sqlite`);
  store.vacuumInto(file);
  return { file, pruned: prune(dir) };
}

/** The daily one: nothing to do when a backup from today is already there. */
export function dailyBackup(store: SqliteTicketStore, opts: { dir?: string; now?: Date } = {}): { file: string; pruned: string[] } | null {
  const now = opts.now ?? new Date();
  const dir = opts.dir ?? backupDir();
  if (listBackups(dir).some((f) => basename(f).startsWith(`willnew-${day(now)}`))) return null;
  return backup(store, { dir, now });
}

/** Checks once an hour (the timer does not keep the process alive); the first check runs right away. */
export function scheduleDailyBackup(store: SqliteTicketStore, opts: { dir?: string; onDone?: (file: string) => void; onError?: (e: Error) => void } = {}): () => void {
  const tick = () => {
    try {
      const r = dailyBackup(store, { dir: opts.dir });
      if (r) opts.onDone?.(r.file);
    } catch (e) {
      opts.onError?.(e as Error);
    }
  };
  tick();
  const t = setInterval(tick, 60 * 60 * 1000);
  t.unref();
  return () => clearInterval(t);
}

export function exportJson(store: SqliteTicketStore, out: string): { file: string; requests: number } {
  const d = store.dump();
  const file = resolve(out);
  writeFileSync(file, JSON.stringify(d, null, 2));
  return { file, requests: d.requests.length };
}

const isSqliteFile = (file: string) => {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    return head.toString("latin1") === "SQLite format 3\u0000";
  } finally {
    closeSync(fd);
  }
};

/** What a backup or export file holds, read without touching it (a .sqlite one is copied first and opened there). */
export function readDump(file: string): StoreDump {
  const src = resolve(file);
  if (!existsSync(src)) throw new Error(`파일이 없어요: ${src}`);
  if (!isSqliteFile(src)) {
    const d = JSON.parse(readFileSync(src, "utf8")) as StoreDump;
    if (d?.format !== "willnew-export") throw new Error("willnew 내보내기 파일이나 백업 파일이 아니에요");
    return d;
  }
  const tmp = mkdtempSync(join(tmpdir(), "willnew-restore-"));
  const copy = join(tmp, "in.sqlite");
  copyFileSync(src, copy);
  for (const ext of ["-wal", "-shm"]) if (existsSync(src + ext)) copyFileSync(src + ext, copy + ext);
  const s = new SqliteTicketStore(copy);
  try {
    return s.dump();
  } finally {
    s.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Replaces the store with the file's contents (a backup .sqlite or an export .json). The current store is backed up
 * first, into the backups folder next to it. Run it with the server stopped: a running server keeps its own copy in memory.
 */
export function restore(store: SqliteTicketStore, file: string, opts: { dir?: string; now?: Date } = {}): { before: string; requests: number } {
  const d = readDump(file);
  const dir = opts.dir ?? join(dirname(store.file), "backups");
  const before = backup(store, { dir, now: opts.now }).file;
  store.replaceAll(d);
  return { before, requests: d.requests.length };
}
