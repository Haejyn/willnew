/**
 * Pull the JSON value out of a model reply. Small models wrap it in a code fence, put a sentence around it, or start
 * with a <think> block. brief.ts has a simpler extractJson for the Claude planner; this one also takes arrays and
 * skips braces inside strings and in the text before the value.
 */

/** Drop <think>...</think> blocks (thinking models put them before the answer). */
export const stripThink = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "");

/** The end index (exclusive) of the balanced object or array starting at `start`, or -1. Brackets in strings are skipped. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/** The first JSON object or array in `text` that parses. Throws when there is none (the message goes back to the model). */
export function extractJson(text: string): unknown {
  const body = stripThink(text).trim();
  try {
    return JSON.parse(body);
  } catch { /* not bare JSON: look inside */ }
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(body);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch { /* a broken fence: scan the whole reply */ }
  }
  let lastError = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{" && body[i] !== "[") continue;
    const end = balancedEnd(body, i);
    if (end < 0) continue;
    try {
      return JSON.parse(body.slice(i, end));
    } catch (e) {
      lastError = (e as Error).message;
      i = end - 1; // a piece inside a broken value is not the answer
    }
  }
  throw new Error(lastError ? `invalid JSON: ${lastError}` : "no JSON object in the reply");
}
