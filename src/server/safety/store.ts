/**
 * 가린 값의 원본 보관. 요청마다 파일 하나 `~/.willnew/redactions/<requestId>.json`(WILLNEW_HOME 을 따른다).
 * 폴더 0700, 파일 0600. Windows 는 권한 비트를 쓰지 않아 사용자 프로필 폴더의 기본 권한을 따른다.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { PiiKind, Redaction } from "./redact.js";

const KINDS: PiiKind[] = ["rrn", "card", "phone", "email", "account", "name"];

/** 부를 때 읽는다. 모듈을 불러온 순간의 HOME 에 묶이지 않게 */
export const redactionsDir = () => join(process.env.WILLNEW_HOME ?? join(homedir(), ".willnew"), "redactions");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fileFor(requestId: string): string {
  if (!SAFE_ID.test(requestId) || requestId.includes("..")) throw new Error(`요청 id 로 쓸 수 없는 값이에요: ${requestId}`);
  return join(redactionsDir(), `${requestId}.json`);
}

function parseItem(x: any): Redaction | null {
  if (!x || typeof x !== "object") return null;
  if (typeof x.token !== "string" || typeof x.value !== "string" || !KINDS.includes(x.kind)) return null;
  if (!Number.isInteger(x.start) || !Number.isInteger(x.end)) return null;
  return { token: x.token, kind: x.kind, value: x.value, start: x.start, end: x.end };
}

/** 원래 값을 요청별 파일에 쓴다. 돌려주는 값 = redactionsRef(파일 경로) */
export function saveRedactions(requestId: string, items: Redaction[]): string {
  const file = fileFor(requestId);
  const dir = redactionsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, requestId, items }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
    chmodSync(file, 0o600);
  }
  return file;
}

/** ref 는 saveRedactions 가 돌려준 경로, 또는 요청 id. 파일이 없으면 빈 목록 */
export function loadRedactions(ref: string): Redaction[] {
  const file = isAbsolute(ref) ? ref : fileFor(ref.replace(/\.json$/, ""));
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf8"));
  const raw: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return raw.map(parseItem).filter((x): x is Redaction => x !== null);
}
