/** Words the bot says around a review: who is asked, what the requester hears back, and the requester's plain-language note. */
import type { AgentRun, Channel, Run } from "./types.js";

/** First channel reviewer who is not the requester; undefined when there is none. */
export function pickReviewer(channel: Pick<Channel, "reviewers"> | undefined, requester: string): string | undefined {
  return channel?.reviewers?.find((r) => r && r !== requester);
}

/** "7" from the check output of the common test runners (node:test, vitest/jest, pytest); null when it can't be read. */
export function passedTests(output: string): number | null {
  let m;
  if ((m = /^\s*[ℹ#] pass (\d+)/m.exec(output))) return Number(m[1]);
  if ((m = /Tests\s+(?:\d+ failed \| )?(\d+) passed/.exec(output))) return Number(m[1]);
  if ((m = /Tests:\s+(?:\d+ failed, )?(\d+) passed/.exec(output))) return Number(m[1]);
  if ((m = /(\d+) passed/.exec(output))) return Number(m[1]);
  return null;
}

/** `@이해준 검토 차례예요. 테스트 7개 통과, main과 충돌 없음`. Parts that are unknown are left out. */
export function reviewMessage(reviewer: string, agent: AgentRun | undefined, baseBranch: string, conflicts: boolean | null): string {
  const parts: string[] = [];
  if (agent?.check.status === "passed") {
    const n = passedTests(agent.check.output);
    parts.push(n == null ? "테스트 통과" : `테스트 ${n}개 통과`);
  }
  if (conflicts === false) parts.push(`${baseBranch}과 충돌 없음`);
  else if (conflicts === true) parts.push(`${baseBranch}과 충돌해요`);
  return `@${reviewer} 검토 차례예요.${parts.length ? ` ${parts.join(", ")}` : ""}`;
}

/** Reply to the requester after the merge. It says the change is in the branch, never that it is live. */
export function mergedReply(run: Pick<Run, "requester">, note: string | undefined, reviewer: string | undefined): string {
  return `@${run.requester} 반영했어요.${note ? ` ${note}` : ""}${reviewer ? ` (승인: ${reviewer})` : ""}`;
}

export function rejectedReply(run: Pick<Run, "requester">, comment: string | undefined): string {
  return `@${run.requester} 이번엔 반영하지 않았어요.${comment ? ` 사유: ${comment}` : ""}`;
}

const NOTE_LINE = /^[ \t>*_-]*요청자에게[ \t]*\**[ \t]*[:：][ \t]*\**[ \t]*/gm;

/** Split the agent's final message into its summary and the `요청자에게: …` line (the last one wins). */
export function parseUserNote(text: string): { summary: string; userNote?: string } {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(NOTE_LINE)) last = m as RegExpExecArray;
  if (!last) return { summary: text };
  const note = text.slice(last.index + last[0].length).replace(/\s+/g, " ").replace(/\*+$/, "").trim().slice(0, 400);
  const summary = text.slice(0, last.index).trim();
  return note ? { summary, userNote: note } : { summary: text };
}

/** Appended to every task prompt so the agent ends with a line a non-developer can read. */
export const USER_NOTE_RULE =
  "End your final message with exactly one line that starts with `요청자에게:` followed by one or two plain Korean sentences for the non-developer who reported this. " +
  "Say what changes for the customer and anything that is not covered. No code, file names or jargon.";
