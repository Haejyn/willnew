/**
 * Before the SQLite store, every request was ~/.willnew/requests/<id>.json. On the first start with the store they are
 * copied in once, oldest first so the keys follow creation order (T-1 is the oldest). The JSON files stay where they
 * are; requests/.migrated marks the folder as done so a later start does not copy them again.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Request } from "../types.js";
import type { TicketStore } from "./ticket-store.js";

export const MIGRATED_MARK = ".migrated";

export interface LegacyMigration {
  /** false when there was nothing to do (no folder, or already migrated) */
  ran: boolean;
  moved: number;
  /** already in the store (same id), left alone */
  skipped: number;
  /** files that did not parse */
  broken: string[];
}

export function migrateLegacyRequests(store: TicketStore, dir: string, now = Date.now()): LegacyMigration {
  const out: LegacyMigration = { ran: false, moved: 0, skipped: 0, broken: [] };
  if (!existsSync(dir) || existsSync(join(dir, MIGRATED_MARK))) return out;
  const found: Request[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Request;
      if (!r || typeof r.id !== "string" || typeof r.status !== "string") throw new Error("not a request");
      found.push(r);
    } catch {
      out.broken.push(f);
    }
  }
  found.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
  store.transaction(() => {
    for (const r of found) {
      if (store.get(r.id)) {
        out.skipped++;
        continue;
      }
      r.key = store.nextKey();
      r.decisions ??= [];
      r.runIds ??= [];
      r.questions ??= [];
      store.put(r);
      for (const d of r.decisions) store.appendDecision(r.id, d);
      out.moved++;
    }
  });
  out.ran = true;
  writeFileSync(join(dir, MIGRATED_MARK), JSON.stringify({ at: new Date(now).toISOString(), moved: out.moved, skipped: out.skipped, broken: out.broken }, null, 2));
  return out;
}
