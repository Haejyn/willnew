import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanner } from "../src/server/brief.js";
import { RequestManager } from "../src/server/requests.js";
import { backup, dailyBackup, exportJson, KEEP_BACKUPS, listBackups, readDump, restore } from "../src/server/store/backup.js";
import { MIGRATED_MARK, migrateLegacyRequests } from "../src/server/store/legacy-json.js";
import { SCHEMA_VERSION, SqliteTicketStore } from "../src/server/store/sqlite.js";
import type { Request } from "../src/server/types.js";

const tmp = (p = "willnew-store-") => mkdtempSync(join(tmpdir(), p));

function req(id: string, over: Partial<Request> = {}): Request {
  return {
    id, threadId: `req-${id}`, channel: "backend", repo: "/nowhere", check: "", team: "platform", requester: "한지우", text: "쿠폰이 안 돼요", attachments: [],
    status: "clarifying", title: "쿠폰", questions: [], decisions: [], runIds: [], createdAt: 1, updatedAt: 1, ...over,
  };
}

describe("SqliteTicketStore", () => {
  it("keeps requests across a close and a new connection", () => {
    const file = join(tmp(), "willnew.sqlite");
    const a = new SqliteTicketStore(file);
    a.put(req("q1", { createdAt: 10, assignee: "이해준", status: "in_progress" }));
    a.put(req("q2", { createdAt: 20 }));
    a.close();
    const b = new SqliteTicketStore(file);
    expect(b.get("q1")).toMatchObject({ id: "q1", key: "T-1", assignee: "이해준", status: "in_progress" });
    expect(b.get("t-2")?.id).toBe("q2");
    expect(b.list().map((r) => r.id)).toEqual(["q2", "q1"]);
    expect(b.list({ status: "in_progress" }).map((r) => r.id)).toEqual(["q1"]);
    expect(b.list({ status: ["clarifying", "in_progress"], requester: "한지우" })).toHaveLength(2);
    expect(b.list({ assignee: null }).map((r) => r.id)).toEqual(["q2"]);
    expect(b.list({ assignee: "이해준" }).map((r) => r.id)).toEqual(["q1"]);
    expect(b.list({ limit: 1 }).map((r) => r.id)).toEqual(["q2"]);
    expect(b.list({ status: [] })).toEqual([]);
    b.put({ ...b.get("q2")!, status: "spec_ready", updatedAt: 30 });
    expect(b.get("q2")).toMatchObject({ key: "T-2", status: "spec_ready" });
    expect(b.list({ status: "clarifying" })).toEqual([]);
    b.close();
  });

  it("runs in WAL mode with a busy timeout and records its schema version", () => {
    const dir = tmp();
    const s = new SqliteTicketStore(join(dir, "willnew.sqlite"));
    s.put(req("q1"));
    expect(String(s.pragma("journal_mode")).toLowerCase()).toBe("wal");
    expect(Number(s.pragma("busy_timeout"))).toBeGreaterThan(0);
    expect(existsSync(join(dir, "willnew.sqlite-wal"))).toBe(true);
    expect(s.schemaVersion()).toBe(SCHEMA_VERSION);
    s.close();
    // opening again does not apply anything twice
    const again = new SqliteTicketStore(join(dir, "willnew.sqlite"));
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    again.close();
  });

  it("refuses a file from a newer willnew", () => {
    const file = join(tmp(), "willnew.sqlite");
    const s = new SqliteTicketStore(file);
    (s as unknown as { db: { exec(sql: string): void } }).db.exec(`INSERT INTO schema_version(version, applied_at) VALUES (${SCHEMA_VERSION + 1}, 0)`);
    s.close();
    expect(() => new SqliteTicketStore(file)).toThrow(/더 새 willnew/);
  });

  it("hands out keys one by one, also from two connections", () => {
    const file = join(tmp(), "willnew.sqlite");
    const a = new SqliteTicketStore(file);
    const b = new SqliteTicketStore(file);
    const keys: string[] = [];
    for (let i = 0; i < 10; i++) keys.push((i % 2 ? b : a).nextKey());
    expect(keys).toEqual(Array.from({ length: 10 }, (_, i) => `T-${i + 1}`));
    a.put(req("qa"));
    expect(a.get("qa")!.key).toBe("T-11");
    a.close();
    b.close();
  });

  it("two connections write to the same file, and a writer waits for the other's transaction", () => {
    const file = join(tmp(), "willnew.sqlite");
    const a = new SqliteTicketStore(file);
    const b = new SqliteTicketStore(file, { busyTimeoutMs: 50 });
    for (let i = 0; i < 20; i++) (i % 2 ? b : a).put(req(`q${i}`, { createdAt: i }));
    expect(a.list()).toHaveLength(20);
    expect(b.list()).toHaveLength(20);
    expect(new Set(a.list().map((r) => r.key)).size).toBe(20);

    a.transaction(() => {
      a.put(req("inside", { createdAt: 100 }));
      // WAL: the other connection still reads, it sees the state before this transaction
      expect(b.get("inside")).toBeUndefined();
      expect(b.list()).toHaveLength(20);
      // and it cannot write until this one ends
      expect(() => b.put(req("blocked"))).toThrow(/locked|busy/i);
    });
    expect(b.get("inside")?.id).toBe("inside");
    b.put(req("after", { createdAt: 101 }));
    expect(a.get("after")?.id).toBe("after");
    a.close();
    b.close();
  });

  it("rolls a failed transaction back", () => {
    const s = new SqliteTicketStore(join(tmp(), "willnew.sqlite"));
    expect(() =>
      s.transaction(() => {
        s.put(req("q1"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.get("q1")).toBeUndefined();
    expect(s.nextKey()).toBe("T-1");
    s.close();
  });

  it("keeps events in order", () => {
    const s = new SqliteTicketStore(join(tmp(), "willnew.sqlite"));
    s.appendDecision("q1", { who: "이해준", when: 5, what: "take_over" });
    s.appendDecision("q1", { who: "한지우", when: 6, what: "reopen", why: "closed → open" });
    s.appendEvent("q2", { at: 7, kind: "note", data: { text: "x" } });
    expect(s.events("q1")).toEqual([
      { seq: 1, requestId: "q1", at: 5, who: "이해준", kind: "take_over" },
      { seq: 2, requestId: "q1", at: 6, who: "한지우", kind: "reopen", data: { why: "closed → open" } },
    ]);
    expect(s.events("q2")[0].data).toEqual({ text: "x" });
    s.close();
  });
});

describe("requests/*.json → SQLite", () => {
  function legacyHome() {
    const home = tmp("willnew-legacy-");
    const dir = join(home, "requests");
    mkdirSync(dir, { recursive: true });
    const w = (r: Request) => writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r));
    w(req("q-new", { createdAt: 300 }));
    w(req("q-old", { createdAt: 100, decisions: [{ who: "이해준", when: 101, what: "take_over" }, { who: "이해준", when: 102, what: "close", why: "끝" }], status: "closed" }));
    w(req("q-mid", { createdAt: 200 }));
    writeFileSync(join(dir, "broken.json"), "{not json");
    return { home, dir };
  }

  it("copies them once, oldest first, and leaves the files", () => {
    const { home, dir } = legacyHome();
    const before = readdirSync(dir).sort();
    const s = new SqliteTicketStore(join(home, "willnew.sqlite"));
    const r = migrateLegacyRequests(s, dir);
    expect(r).toEqual({ ran: true, moved: 3, skipped: 0, broken: ["broken.json"] });
    expect(["q-old", "q-mid", "q-new"].map((id) => s.get(id)?.key)).toEqual(["T-1", "T-2", "T-3"]);
    expect(s.events("q-old").map((e) => e.kind)).toEqual(["take_over", "close"]);
    expect(readdirSync(dir).sort()).toEqual([...before, MIGRATED_MARK].sort());
    expect(JSON.parse(readFileSync(join(dir, MIGRATED_MARK), "utf8"))).toMatchObject({ moved: 3 });

    // a second start, even with a new file in the folder, does nothing
    writeFileSync(join(dir, "q-late.json"), JSON.stringify(req("q-late", { createdAt: 400 })));
    expect(migrateLegacyRequests(s, dir)).toMatchObject({ ran: false, moved: 0 });
    expect(s.get("q-late")).toBeUndefined();
    expect(s.list()).toHaveLength(3);
    s.close();
  });

  it("does nothing without the folder", () => {
    const home = tmp();
    const s = new SqliteTicketStore(join(home, "willnew.sqlite"));
    expect(migrateLegacyRequests(s, join(home, "requests")).ran).toBe(false);
    expect(existsSync(join(home, "requests"))).toBe(false);
    s.close();
  });

  it("RequestManager migrates on start, gives new requests the next key and logs decisions as events", async () => {
    const { home, dir } = legacyHome();
    const store = new SqliteTicketStore(join(home, "willnew.sqlite"));
    const runs = { bus: new EventEmitter(), create: async () => { throw new Error("no runs here"); }, get: () => undefined };
    const deps = { planner: createPlanner(() => null), proposer: null, visual: null, store, legacyDir: dir };
    const m = new RequestManager(runs as never, deps);
    expect(m.list().map((r) => r.key)).toEqual(["T-3", "T-2", "T-1"]);
    expect(existsSync(join(dir, MIGRATED_MARK))).toBe(true);

    const fresh = m.create({ channel: "backend", repo: "/nowhere", check: "", team: "platform", requester: "한지우", text: "@willnew 장바구니 버튼 문구" });
    expect(fresh.key).toBe("T-4");
    expect(store.get("T-4")?.id).toBe(fresh.id);
    m.cancel(fresh.id, "한지우", "잘못 보냄");
    m.reopen(fresh.id, "한지우", "다시 볼게요");
    expect(store.events(fresh.id).map((e) => e.kind)).toEqual(["cancel", "reopen"]);
    m.reopen("q-old", "한지우");
    expect(store.get("q-old")).toMatchObject({ status: "open" });
    expect(store.events("q-old").map((e) => e.kind)).toEqual(["take_over", "close", "reopen"]);

    // a restart reads the same requests back, and the old events are not written twice
    const again = new RequestManager(runs as never, deps);
    expect(again.get("q-old")?.status).toBe("open");
    expect(again.get(fresh.id)?.key).toBe("T-4");
    again.cancel("q-old", "이해준");
    expect(store.events("q-old").map((e) => e.kind)).toEqual(["take_over", "close", "reopen", "cancel"]);
    await new Promise((r) => setTimeout(r, 20));
    store.close();
  });
});

describe("backup, export, restore", () => {
  it("names backups by day and keeps the newest 7", () => {
    const home = tmp();
    const s = new SqliteTicketStore(join(home, "willnew.sqlite"));
    s.put(req("q1"));
    const dir = join(home, "backups");
    const first = backup(s, { dir, now: new Date(2026, 9, 30, 9, 0, 0) });
    expect(basename(first.file)).toBe("willnew-2026-10-30.sqlite");
    const second = backup(s, { dir, now: new Date(2026, 9, 30, 9, 30, 5) });
    expect(basename(second.file)).toBe("willnew-2026-10-30-093005.sqlite");
    for (let d = 1; d <= 8; d++) backup(s, { dir, now: new Date(2026, 10, d) });
    const kept = listBackups(dir).map((f) => basename(f));
    expect(kept).toHaveLength(KEEP_BACKUPS);
    expect(kept[0]).toBe("willnew-2026-11-08.sqlite");
    expect(kept.at(-1)).toBe("willnew-2026-11-02.sqlite");
    // a file someone else put there is not ours to delete
    writeFileSync(join(dir, "notes.txt"), "x");
    backup(s, { dir, now: new Date(2026, 10, 9) });
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    s.close();
  });

  it("makes the daily one only once a day", () => {
    const home = tmp();
    const s = new SqliteTicketStore(join(home, "willnew.sqlite"));
    const dir = join(home, "backups");
    const now = new Date(2026, 9, 30, 8);
    expect(dailyBackup(s, { dir, now })).not.toBeNull();
    expect(dailyBackup(s, { dir, now: new Date(2026, 9, 30, 20) })).toBeNull();
    expect(dailyBackup(s, { dir, now: new Date(2026, 9, 31, 0, 5) })).not.toBeNull();
    expect(listBackups(dir)).toHaveLength(2);
    s.close();
  });

  it("a backup is a working store; --out goes exactly there", () => {
    const home = tmp();
    const s = new SqliteTicketStore(join(home, "willnew.sqlite"));
    s.put(req("q1"));
    const out = join(home, "elsewhere", "copy.sqlite");
    expect(backup(s, { out }).file).toBe(resolve(out));
    expect(() => backup(s, { out })).toThrow(/이미 있는/);
    const copy = new SqliteTicketStore(out);
    expect(copy.get("q1")?.key).toBe("T-1");
    copy.close();
    s.close();
  });

  it("export → restore round-trips requests, events and the key counter", () => {
    const home = tmp();
    const s = new SqliteTicketStore(join(home, "willnew.sqlite"));
    s.put(req("q1", { createdAt: 1 }));
    s.put(req("q2", { createdAt: 2 }));
    s.appendDecision("q1", { who: "이해준", when: 3, what: "take_over" });
    const file = join(home, "export.json");
    expect(exportJson(s, file).requests).toBe(2);
    expect(readDump(file)).toMatchObject({ format: "willnew-export", schema: SCHEMA_VERSION, ticketCounter: 2 });

    const other = tmp();
    const t = new SqliteTicketStore(join(other, "willnew.sqlite"));
    t.put(req("stray"));
    const r = restore(t, file);
    expect(r.requests).toBe(2);
    expect(t.list().map((x) => x.id)).toEqual(["q2", "q1"]);
    expect(t.events("q1").map((e) => e.kind)).toEqual(["take_over"]);
    expect(t.nextKey()).toBe("T-3");
    // what was there before is in a backup
    const before = new SqliteTicketStore(r.before);
    expect(before.get("stray")).toBeDefined();
    before.close();
    expect(r.before.startsWith(join(other, "backups"))).toBe(true);
    t.close();
    s.close();
  });

  it("restores from a .sqlite backup without changing the backup", () => {
    const home = tmp();
    const s = new SqliteTicketStore(join(home, "willnew.sqlite"));
    s.put(req("q1", { title: "처음" }));
    const snap = backup(s, { dir: join(home, "backups"), now: new Date(2026, 9, 1) }).file;
    const bytes = readFileSync(snap);
    s.put({ ...s.get("q1")!, title: "바뀜" });
    s.put(req("q2"));
    restore(s, snap, { now: new Date(2026, 9, 2) });
    expect(s.get("q1")?.title).toBe("처음");
    expect(s.get("q2")).toBeUndefined();
    expect(readFileSync(snap).equals(bytes)).toBe(true);
    expect(() => restore(s, join(home, "nope.sqlite"))).toThrow(/없어요/);
    writeFileSync(join(home, "junk.json"), JSON.stringify({ hello: 1 }));
    expect(() => restore(s, join(home, "junk.json"))).toThrow(/아니에요/);
    s.close();
  });

  it("CLI: backup, export, restore in WILLNEW_HOME, without the sqlite warning", () => {
    const home = tmp("willnew-cli-");
    const s = new SqliteTicketStore(join(home, "willnew.sqlite"));
    s.put(req("q1"));
    s.close();
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", resolve("src/server/cli.ts"), ...args], { env: { ...process.env, WILLNEW_HOME: home }, encoding: "utf8", timeout: 60_000 });
    const b = cli("backup");
    expect(b.status, b.stderr).toBe(0);
    expect(b.stderr).not.toMatch(/ExperimentalWarning/);
    expect(listBackups(join(home, "backups"))).toHaveLength(1);
    const out = join(home, "all.json");
    expect(cli("export", "--out", out).status).toBe(0);
    expect(readDump(out).requests.map((r) => r.id)).toEqual(["q1"]);
    const r = cli("restore", out);
    expect(r.status, r.stderr).toBe(0);
    expect(cli("export").status).toBe(1);
  }, 120_000);
});
