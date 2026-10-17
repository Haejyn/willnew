/**
 * After the proposal pass: which acceptance criteria name code that nobody has seen?
 *
 * The planner writes the spec before anyone reads the repository, so a criterion like "PayButton 의 padding 16px" may
 * name a component that does not exist. Every code-like name in a criterion must come from the requester (the message
 * or a clarify answer), from the proposal's files list, or from a search of the repository at HEAD. Anything else is
 * flagged and shown to the developer as "확인 필요" instead of being kept silently.
 */
import { git } from "./git.js";
import type { ClarifyQuestion, Proposal, SpecFlag, WorkSpec } from "./types.js";

/** Words that look like identifiers but are product or format names, not code in the repo. */
const NOT_CODE = new Set(["figma", "slack", "github", "chrome", "safari", "firefox", "edge", "android", "ios", "iphone", "ipad", "macos", "windows", "excel", "csv", "pdf", "png", "jpg", "svg", "url", "api", "kst", "utc", "pr", "ci", "qa", "ui", "ux", "px", "rem", "em", "vw", "vh", "ok", "id"]);

/**
 * Code-like names in one criterion: CSS custom properties, file paths, camelCase, PascalCase and snake_case words.
 * Plain English words in lower case ("padding", "lg") and Korean text are not names.
 */
export function codeNames(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.replace(/[.,;:)]+$/, "");
    if (t.length > 1 && !NOT_CODE.has(t.toLowerCase())) out.add(t);
  };
  for (const m of text.matchAll(/--[a-zA-Z][\w-]*/g)) add(m[0]);
  for (const m of text.matchAll(/(?:[\w-]+\/)*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|less|py|go|rs|java|kt|swift|rb|php|vue|svelte|html|json|ya?ml|sql|md)\b/g)) add(m[0]);
  // strip what was matched so a path does not also yield its parts
  const rest = text.replace(/--[a-zA-Z][\w-]*/g, " ").replace(/(?:[\w-]+\/)*[\w-]+\.[a-z]{1,6}\b/g, " ");
  for (const m of rest.matchAll(/\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g)) add(m[0]); // camelCase
  for (const m of rest.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)*\b/g)) add(m[0]); // PascalCase, Button
  for (const m of rest.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) add(m[0]); // snake_case
  return [...out];
}

/** Lower-case text the requester wrote: the message and every clarify question and answer. */
function requesterWords(text: string, questions: ClarifyQuestion[]): string {
  return [text, ...questions.flatMap((q) => [q.question, q.answer ?? "", ...q.choices])].join("\n").toLowerCase();
}

/** Does the name appear in the proposal's files list (path or file name without extension)? */
function inFiles(name: string, files: Proposal["files"]): boolean {
  const n = name.toLowerCase();
  return files.some((f) => {
    const p = f.path.toLowerCase();
    const base = p.split("/").pop()!.replace(/\.[^.]+$/, "");
    return p === n || p.endsWith(`/${n}`) || base === n;
  });
}

/** Is the name in any tracked file at HEAD? A missing repo or a git error counts as "not found". */
export async function inRepo(repo: string, name: string): Promise<boolean> {
  try {
    await git(repo, "grep", "-q", "-F", "-e", name, "HEAD", "--");
    return true;
  } catch {
    return false;
  }
}

/**
 * The criteria to show as "확인 필요", each with the names that could not be traced. Criteria the planner already
 * wrote as "[확인 필요: …]" are left alone (they are visibly unknown already).
 */
export async function flagUnverified(
  spec: Pick<WorkSpec, "acceptanceCriteria">,
  source: { text: string; questions: ClarifyQuestion[] },
  proposal: Pick<Proposal, "files"> | undefined,
  repo: string,
  search: (name: string) => Promise<boolean> = (n) => inRepo(repo, n),
): Promise<SpecFlag[]> {
  const said = requesterWords(source.text, source.questions);
  const files = proposal?.files ?? [];
  const known = new Map<string, boolean>();
  const flags: SpecFlag[] = [];
  for (const criterion of spec.acceptanceCriteria) {
    if (/\[확인 필요/.test(criterion)) continue;
    const missing: string[] = [];
    for (const name of codeNames(criterion)) {
      if (said.includes(name.toLowerCase()) || inFiles(name, files)) continue;
      if (!known.has(name)) known.set(name, await search(name));
      if (!known.get(name)) missing.push(name);
    }
    if (missing.length) flags.push({ criterion, names: missing });
  }
  return flags;
}
