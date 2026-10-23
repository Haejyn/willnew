/**
 * Which Slack thread belongs to which Request, and the bot messages in it that get edited later (card, questions,
 * proposal, checks, review, ship). Kept in one JSON file under HOME so a restarted server keeps editing the same messages.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME } from "../home.js";
import type { RequestStatus } from "../types.js";

export interface ThreadRecord {
  requestId: string;
  channel: string;
  /** the thread = the mention message (or the thread it was written in) */
  threadTs: string;
  /** the live request card, the first bot message in the thread */
  cardTs?: string;
  /** question id → message ts */
  questions: Record<string, string>;
  proposalTs?: string;
  /** 요청자 확인 round → message ts */
  checks: Record<string, string>;
  /** rounds whose screenshots are already in the thread */
  shots: number[];
  reviewTs?: string;
  shipTs?: string;
  shipLines?: string[];
  /** the last status the thread has reacted to, so a restart does not post twice */
  status?: RequestStatus;
}

export const DEFAULT_STORE = join(HOME, "slack", "threads.json");

export class ThreadStore {
  private recs = new Map<string, ThreadRecord>();

  constructor(private file = DEFAULT_STORE) {
    if (!existsSync(file)) return;
    try {
      const list: ThreadRecord[] = JSON.parse(readFileSync(file, "utf8"));
      for (const r of list) this.recs.set(r.requestId, r);
    } catch { /* corrupt file: start empty */ }
  }

  get(requestId: string): ThreadRecord | undefined {
    return this.recs.get(requestId);
  }

  byThread(channel: string, threadTs: string): ThreadRecord | undefined {
    for (const r of this.recs.values()) if (r.channel === channel && r.threadTs === threadTs) return r;
    return undefined;
  }

  bind(requestId: string, channel: string, threadTs: string): ThreadRecord {
    const r: ThreadRecord = { requestId, channel, threadTs, questions: {}, checks: {}, shots: [] };
    this.recs.set(requestId, r);
    this.save();
    return r;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.recs.values()]));
  }
}
