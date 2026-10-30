/**
 * Where requests (tickets) live. The default is SQLite in ~/.willnew/willnew.sqlite (store/sqlite.ts). Jira and Linear
 * are not stores: they sit next to it as an ExternalTracker the ticket is mirrored to (M4).
 */
import type { DecisionEntry, Request, RequestStatus } from "../types.js";

export interface RequestFilter {
  status?: RequestStatus | RequestStatus[];
  requester?: string;
  /** null = nobody assigned */
  assignee?: string | null;
  /** newest first (by createdAt). Default: all */
  limit?: number;
}

/** One line of a request's history. Decision log entries are kept here too, so they can be counted without reading every ticket. */
export interface TicketEvent {
  seq: number;
  requestId: string;
  at: number;
  who?: string;
  kind: string;
  data?: unknown;
}

export interface TicketStore {
  /** by id or by key ("T-42") */
  get(idOrKey: string): Request | undefined;
  list(filter?: RequestFilter): Request[];
  /** insert or replace the whole request */
  put(req: Request): void;
  /** the next ticket key, "T-1", "T-2", … Never handed out twice, even across connections */
  nextKey(): string;
  appendEvent(requestId: string, e: { at: number; who?: string; kind: string; data?: unknown }): void;
  /** the decision log entries go in as kind = entry.what */
  appendDecision(requestId: string, e: DecisionEntry): void;
  events(requestId: string): TicketEvent[];
  /** runs fn in one write transaction. Nested calls join the outer one */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * A ticket system the team already uses (Jira, Linear). Not implemented yet: the ticket stays in the TicketStore and
 * is mirrored out, and status changes made over there come back through pull. Rate limits differ a lot (Jira points
 * for OAuth apps since 2026-03, Linear GraphQL), so an adapter decides how often it may call.
 */
export interface ExternalTracker {
  readonly system: "jira" | "linear";
  /** create or update the issue for this request. Returns what goes into request.external */
  push(req: Request): Promise<{ id: string; url: string }>;
  /** the issue's status mapped to ours, or null when it has no counterpart (the caller keeps its own status) */
  pullStatus(externalId: string): Promise<{ status: RequestStatus | null; raw: string; updatedAt: number }>;
}
