/**
 * TicketStore on Node's built-in SQLite (node:sqlite, Node 22.13+). One file, WAL, so the server and a CLI command can
 * read while the other writes.
 *
 *   requests(id, key, status, requester, assignee, created_at, updated_at, data)   data = the whole Request as JSON
 *   events(seq, request_id, at, who, kind, data)                                   decision log and history
 *   counters(name, value)                                                          "ticket" → last T-<n>
 *   schema_version(version, applied_at)                                            one row per applied migration
 *
 * The columns next to data are copies for filtering. data wins when they disagree; put() writes both.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as Db, SQLInputValue } from "node:sqlite";
import { HOME } from "../home.js";
import type { DecisionEntry, Request } from "../types.js";
import type { RequestFilter, TicketEvent, TicketStore } from "./ticket-store.js";

export const dbFile = (home = HOME) => join(home, "willnew.sqlite");

let sqlite: typeof import("node:sqlite") | undefined;

/**
 * Loads node:sqlite once. Node prints an ExperimentalWarning for it on every start; that one warning is dropped while
 * the module loads, every other warning goes through as before.
 */
function loadSqlite(): typeof import("node:sqlite") {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const text = typeof warning === "string" ? warning : warning?.message;
    if ((type === "ExperimentalWarning" || (warning as Error)?.name === "ExperimentalWarning") && /sqlite/i.test(text ?? "")) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  } catch (e) {
    throw new Error(`node:sqlite 를 불러오지 못했어요. Node 22.13 이상이 필요해요 (지금 ${process.version}): ${(e as Error).message}`);
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

/** Schema changes, oldest first. Never edit one that shipped; add the next version. */
export const MIGRATIONS: { version: number; up: (db: Db) => void }[] = [
  {
    version: 1,
    up: (db) =>
      db.exec(`
        CREATE TABLE requests (
          id TEXT PRIMARY KEY,
          key TEXT UNIQUE,
          status TEXT NOT NULL,
          requester TEXT,
          assignee TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX requests_status ON requests(status);
        CREATE INDEX requests_requester ON requests(requester);
        CREATE INDEX requests_assignee ON requests(assignee);
        CREATE INDEX requests_updated ON requests(updated_at);
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          who TEXT,
          kind TEXT NOT NULL,
          data TEXT
        );
        CREATE INDEX events_request ON events(request_id, seq);
        CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT INTO counters(name, value) VALUES ('ticket', 0);
      `),
  },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

/** Brings the file up to SCHEMA_VERSION. Safe when two connections open a new file at once (the second sees the first's rows). */
export function migrate(db: Db): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const current = () => Number((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }).v ?? 0);
  if (current() > SCHEMA_VERSION) throw new Error(`이 저장소(${current()})는 더 새 willnew 가 만들었어요. 이 버전은 ${SCHEMA_VERSION} 까지 읽어요`);
  for (const m of MIGRATIONS) {
    if (m.version <= current()) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (m.version > current()) {
        m.up(db);
        db.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return current();
}

/** Everything in the store, for export and restore. */
export interface StoreDump {
  format: "willnew-export";
  schema: number;
  exportedAt: number;
  ticketCounter: number;
  requests: Request[];
  events: Omit<TicketEvent, "seq">[];
}

type Row = Record<string, unknown>;
const KEY = /^T-\d+$/i;

export class SqliteTicketStore implements TicketStore {
  readonly file: string;
  private db: Db;
  private depth = 0;
  private closed = false;

  constructor(file: string, opts: { busyTimeoutMs?: number } = {}) {
    this.file = file === ":memory:" ? file : resolve(file);
    if (this.file !== ":memory:") mkdirSync(dirname(this.file), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    migrate(this.db);
  }

  /** for tests and diagnostics */
  pragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Row | undefined;
    return row ? Object.values(row)[0] : undefined;
  }

  schemaVersion(): number {
    return Number((this.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as Row).v ?? 0);
  }

  get(idOrKey: string): Request | undefined {
    const row = KEY.test(idOrKey)
      ? this.db.prepare("SELECT data FROM requests WHERE key = ?").get(idOrKey.toUpperCase())
      : this.db.prepare("SELECT data FROM requests WHERE id = ?").get(idOrKey);
    return row ? (JSON.parse(String((row as Row).data)) as Request) : undefined;
  }

  list(filter: RequestFilter = {}): Request[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.status !== undefined) {
      const xs = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (!xs.length) return [];
      where.push(`status IN (${xs.map(() => "?").join(", ")})`);
      args.push(...xs);
    }
    if (filter.requester !== undefined) {
      where.push("requester = ?");
      args.push(filter.requester);
    }
    if (filter.assignee === null) where.push("assignee IS NULL");
    else if (filter.assignee !== undefined) {
      where.push("assignee = ?");
      args.push(filter.assignee);
    }
    let sql = `SELECT data FROM requests${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`;
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      args.push(Math.max(0, Math.floor(filter.limit)));
    }
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => JSON.parse(String(r.data)) as Request);
  }

  /** Inserts or replaces. A request without a key gets the next one. */
  put(req: Request): void {
    this.transaction(() => {
      if (!req.key) req.key = this.nextKey();
      this.db
        .prepare(
          `INSERT INTO requests(id, key, status, requester, assignee, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET key = excluded.key, status = excluded.status, requester = excluded.requester,
             assignee = excluded.assignee, created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data`,
        )
        .run(req.id, req.key, req.status, req.requester ?? null, req.assignee ?? null, req.createdAt ?? Date.now(), req.updatedAt ?? Date.now(), JSON.stringify(req));
    });
  }

  nextKey(): string {
    const row = this.db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'ticket' RETURNING value").get() as Row;
    return `T-${Number(row.value)}`;
  }

  appendEvent(requestId: string, e: { at: number; who?: string; kind: string; data?: unknown }): void {
    this.db
      .prepare("INSERT INTO events(request_id, at, who, kind, data) VALUES (?, ?, ?, ?, ?)")
      .run(requestId, e.at, e.who ?? null, e.kind, e.data === undefined ? null : JSON.stringify(e.data));
  }

  appendDecision(requestId: string, e: DecisionEntry): void {
    this.appendEvent(requestId, { at: e.when, who: e.who, kind: e.what, data: e.why === undefined ? undefined : { why: e.why } });
  }

  events(requestId: string): TicketEvent[] {
    return (this.db.prepare("SELECT seq, request_id, at, who, kind, data FROM events WHERE request_id = ? ORDER BY seq").all(requestId) as Row[]).map(toEvent);
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch { /* already rolled back */ }
      throw e;
    } finally {
      this.depth--;
    }
  }

  /** A consistent copy of the whole file at `out` (which must not exist yet). Works while others read and write. */
  vacuumInto(out: string): void {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    this.db.prepare("VACUUM INTO ?").run(resolve(out));
  }

  dump(): StoreDump {
    const counter = this.db.prepare("SELECT value FROM counters WHERE name = 'ticket'").get() as Row | undefined;
    const events = (this.db.prepare("SELECT seq, request_id, at, who, kind, data FROM events ORDER BY seq").all() as Row[]).map(toEvent).map(({ seq: _seq, ...e }) => e);
    const requests = (this.db.prepare("SELECT data FROM requests ORDER BY created_at, id").all() as Row[]).map((r) => JSON.parse(String(r.data)) as Request);
    return { format: "willnew-export", schema: this.schemaVersion(), exportedAt: Date.now(), ticketCounter: Number(counter?.value ?? 0), requests, events };
  }

  /** Replaces every request, event and the key counter with the dump's. One transaction: all or nothing. */
  replaceAll(d: StoreDump): void {
    if (d.format !== "willnew-export" || !Array.isArray(d.requests) || !Array.isArray(d.events)) throw new Error("willnew 내보내기 파일이 아니에요");
    this.transaction(() => {
      this.db.exec("DELETE FROM requests; DELETE FROM events;");
      let top = Number(d.ticketCounter) || 0;
      for (const r of d.requests) {
        const n = Number(/^T-(\d+)$/i.exec(r.key ?? "")?.[1] ?? 0);
        if (n > top) top = n;
      }
      this.db.prepare("UPDATE counters SET value = ? WHERE name = 'ticket'").run(top);
      for (const r of d.requests) this.put(r);
      for (const e of d.events) this.appendEvent(e.requestId, e);
    });
  }

  close(): void {
    if (!this.closed) this.db.close();
    this.closed = true;
    for (const [k, v] of opened) if (v === this) opened.delete(k);
  }
}

function toEvent(r: Row): TicketEvent {
  const e: TicketEvent = { seq: Number(r.seq), requestId: String(r.request_id), at: Number(r.at), kind: String(r.kind) };
  if (r.who !== null && r.who !== undefined) e.who = String(r.who);
  if (r.data !== null && r.data !== undefined) e.data = JSON.parse(String(r.data));
  return e;
}

const opened = new Map<string, SqliteTicketStore>();

/** The shared store for a file (default ~/.willnew/willnew.sqlite). Everything in one process uses one connection. */
export function openTicketStore(file = dbFile()): SqliteTicketStore {
  const k = process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file);
  let s = opened.get(k);
  if (!s) opened.set(k, (s = new SqliteTicketStore(file)));
  return s;
}
