/**
 * Team mode people: members.json on the hub. Tokens are never stored, only their sha256 hex hash; a lookup hashes the
 * presented token and compares with timingSafeEqual. A person token (invite link) names who is using the web UI; a
 * runner token ties a runner to its owner. A lookup that misses re-reads the file when it changed on disk, so a new
 * invite works without restarting the hub.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type MemberRole = "developer" | "requester";

export interface Member {
  name: string;
  title: string;
  role: MemberRole;
  avatar?: string;
  slackId?: string;
  /** sha256 hex of the person token */
  tokenHash: string;
  /** sha256 hex of each runner token this person owns */
  runnerTokenHashes?: string[];
}

/** `~/.willnew/members.json` (follows WILLNEW_HOME). Read when called, so importing this module does not fix HOME. */
export const defaultMembersPath = () => join(process.env.WILLNEW_HOME ?? join(homedir(), ".willnew"), "members.json");

export const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
export const newToken = () => randomBytes(24).toString("base64url");

const HEX64 = /^[0-9a-f]{64}$/;

/** Same hash, compared in constant time. Both sides are 32 bytes once decoded. */
function sameHash(hash: Buffer, storedHex: string): boolean {
  if (!HEX64.test(storedHex)) return false;
  return timingSafeEqual(hash, Buffer.from(storedHex, "hex"));
}

function parseMember(x: any): Member | null {
  if (!x || typeof x.name !== "string" || !x.name.trim() || typeof x.tokenHash !== "string") return null;
  const m: Member = {
    name: x.name.trim(),
    title: typeof x.title === "string" ? x.title : "",
    role: x.role === "developer" ? "developer" : "requester",
    tokenHash: x.tokenHash.toLowerCase(),
  };
  if (typeof x.avatar === "string" && x.avatar) m.avatar = x.avatar;
  if (typeof x.slackId === "string" && x.slackId) m.slackId = x.slackId;
  if (Array.isArray(x.runnerTokenHashes)) m.runnerTokenHashes = x.runnerTokenHashes.filter((h: unknown): h is string => typeof h === "string").map((h: string) => h.toLowerCase());
  return m;
}

export class Members {
  private list: Member[] = [];
  private mtime = 0;

  private constructor(readonly path: string) {}

  /** Reads `path`. A missing file is an empty team (invite creates it). */
  static load(path: string = defaultMembersPath()): Members {
    const m = new Members(path);
    m.reload();
    return m;
  }

  /** Re-reads the file. Throws when the file exists but is not a JSON array of members. */
  reload(): this {
    if (!existsSync(this.path)) {
      this.list = [];
      this.mtime = 0;
      return this;
    }
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(raw)) throw new Error(`${this.path} 는 사람 목록(JSON 배열)이어야 해요`);
    this.list = raw.map(parseMember).filter((m): m is Member => !!m);
    this.mtime = statSync(this.path).mtimeMs;
    return this;
  }

  /** reload() when the file changed since the last read. Errors keep the list we have. */
  private refresh(): boolean {
    try {
      const now = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
      if (now === this.mtime) return false;
      this.reload();
      return true;
    } catch {
      return false;
    }
  }

  private find(test: (m: Member) => boolean): Member | null {
    const hit = this.list.find(test);
    if (hit) return hit;
    return this.refresh() ? (this.list.find(test) ?? null) : null;
  }

  byToken(token: string | null | undefined): Member | null {
    if (!token) return null;
    const h = Buffer.from(hashToken(token), "hex");
    return this.find((m) => sameHash(h, m.tokenHash));
  }

  byRunnerToken(token: string | null | undefined): Member | null {
    if (!token) return null;
    const h = Buffer.from(hashToken(token), "hex");
    return this.find((m) => (m.runnerTokenHashes ?? []).some((x) => sameHash(h, x)));
  }

  bySlackId(id: string | null | undefined): Member | null {
    if (!id) return null;
    return this.find((m) => m.slackId === id);
  }

  get(name: string): Member | null {
    return this.find((m) => m.name === name);
  }

  all(): Member[] {
    this.refresh();
    return [...this.list];
  }

  /**
   * Adds a person, or gives an existing one a new person token (the old invite link stops working).
   * Returns the token; only its hash is written.
   */
  invite(name: string, opts: { role?: MemberRole; title?: string; slackId?: string; avatar?: string } = {}): { token: string; member: Member } {
    const n = name.trim();
    if (!n) throw new Error("이름을 적어 주세요");
    this.reload();
    const token = newToken();
    const cur = this.list.find((m) => m.name === n);
    const member: Member = cur ?? { name: n, title: "", role: "requester", tokenHash: "" };
    member.tokenHash = hashToken(token);
    if (opts.role) member.role = opts.role;
    if (opts.title !== undefined) member.title = opts.title;
    if (opts.slackId) member.slackId = opts.slackId;
    if (opts.avatar) member.avatar = opts.avatar;
    if (!cur) this.list.push(member);
    this.save();
    return { token, member };
  }

  /** A new runner token for an existing person. Earlier runner tokens keep working. */
  addRunnerToken(name: string): { token: string; member: Member } {
    this.reload();
    const member = this.list.find((m) => m.name === name.trim());
    if (!member) throw new Error(`아직 초대하지 않은 사람이에요: ${name}. 먼저 willnew invite 로 넣어 주세요`);
    const token = newToken();
    member.runnerTokenHashes = [...(member.runnerTokenHashes ?? []), hashToken(token)];
    this.save();
    return { token, member };
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.list, null, 2)}\n`);
    renameSync(tmp, this.path);
    this.mtime = statSync(this.path).mtimeMs;
  }
}
