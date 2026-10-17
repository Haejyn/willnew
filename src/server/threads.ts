/** Thread helpers with no node imports: the server chat, the web app and the demo use the same rules. */
import type { ChatMessage, ThreadSummary } from "./types.js";

const MENTION = /@([\p{L}\p{N}_]+)/gu;

/** Names mentioned with @ in any body of the message. */
export function mentionsOf(m: Pick<ChatMessage, "text" | "bodies">): string[] {
  const all = [m.text, m.bodies?.forRequester ?? "", m.bodies?.forDeveloper ?? ""].join("\n");
  return [...new Set([...all.matchAll(MENTION)].map((x) => x[1]))];
}

/** Shown in the channel stream: everything that is not a thread reply, plus replies also sent to the channel. */
export const inChannel = (m: ChatMessage) => !m.threadId || !!m.broadcast;

/** The thread a Request's messages live in: its card. */
export const requestThreadId = (requestId: string) => `req-${requestId}`;

/** One summary per thread: count, last reply, the last three distinct repliers, and each reply's mentions. */
export function threadSummaries(messages: ChatMessage[]): ThreadSummary[] {
  const by = new Map<string, ChatMessage[]>();
  for (const m of messages) if (m.threadId) by.set(m.threadId, [...(by.get(m.threadId) ?? []), m]);
  return [...by].map(([id, list]) => {
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    const users: ThreadSummary["users"] = [];
    for (const m of [...sorted].reverse()) {
      const name = m.bot ? "willnew" : m.user;
      if (users.length < 3 && !users.some((u) => u.name === name)) users.push({ name, avatar: m.bot ? undefined : m.userAvatar, bot: m.bot || undefined });
    }
    return { id, count: sorted.length, lastTs: sorted.at(-1)!.ts, users, replies: sorted.map((m) => ({ ts: m.ts, user: m.bot ? "willnew" : m.user, mentions: mentionsOf(m) })) };
  });
}
