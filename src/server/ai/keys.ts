/**
 * Keys and local AI settings: `~/.willnew/keys.env` (outside the repo), with the environment winning over the file.
 * Values are only returned to the caller. Nothing here logs them, and AiStatus never carries them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { willnewHome } from "./config.js";

/** Names read from the environment even when keys.env does not mention them. */
export const KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OLLAMA_HOST", "WILLNEW_LOCAL_MODEL", "WILLNEW_LOCAL_EMBED_MODEL"] as const;

export const keysPath = (home = willnewHome()) => join(home, "keys.env");

/** `NAME=value` lines. `#` comments, blank lines, `export ` and surrounding quotes are allowed. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** keys.env merged with the environment (the environment wins). Empty values count as unset. */
export function loadKeys(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): Record<string, string> {
  const env = opts.env ?? process.env;
  const file = keysPath(opts.home);
  let fromFile: Record<string, string> = {};
  if (existsSync(file)) {
    try {
      fromFile = parseEnv(readFileSync(file, "utf8"));
    } catch { /* unreadable: environment only */ }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fromFile)) if (v) out[k] = v;
  for (const k of new Set([...Object.keys(fromFile), ...KEY_NAMES])) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}
