/**
 * `~/.willnew/credentials.json` { server, token, name } (권한 0600). Follows WILLNEW_HOME like members.json.
 * Solo mode servers have no token: `token` is then an empty string.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Credentials {
  server: string;
  token: string;
  name: string;
}

export const defaultCredentialsPath = (env: NodeJS.ProcessEnv = process.env) => join(env.WILLNEW_HOME ?? join(homedir(), ".willnew"), "credentials.json");

export function loadCredentials(path: string): Credentials | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Partial<Credentials>;
    if (typeof c.server !== "string" || !c.server) return null;
    return { server: c.server, token: typeof c.token === "string" ? c.token : "", name: typeof c.name === "string" ? c.name : "" };
  } catch {
    return null;
  }
}

export function saveCredentials(path: string, c: Credentials) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync keeps the mode of a file that already exists
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: mode bits are mostly ignored */
  }
}

/**
 * What `login` was given: a server address, or an invite link (`http://hub:7777/?invite=abc`).
 * An invite link carries the token; the server is the link without its query.
 */
export function parseServer(input: string): { server: string; token?: string } {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  const token = u.searchParams.get("invite") ?? u.searchParams.get("token") ?? undefined;
  const path = u.pathname.replace(/\/+$/, "");
  return { server: `${u.protocol}//${u.host}${path}`, token: token || undefined };
}

/** A pasted answer to the token prompt: the token itself, or an invite link holding it. */
export function tokenFromPaste(input: string): string {
  const s = input.trim();
  const m = /[?&](?:invite|token)=([^&#\s]+)/.exec(s);
  return m ? decodeURIComponent(m[1]) : s;
}
