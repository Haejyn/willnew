/**
 * git 에서 티켓 키 찾기와 GitHub 웹훅 서명 (m1-contract.md 3절 상태와 git).
 * 키는 브랜치 `t-42-...`, PR 제목이나 본문의 `T-42`, 커밋 꼬리말 `Ticket: T-42` 에서 찾는다.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const BRANCH = /^(?:refs\/heads\/)?t-(\d+)(?:-|$)/i;
const TRAILER = /^\s*Ticket:\s*T-(\d+)\b/im;
const KEY = /(?<![\w-])T-(\d+)(?![\w])/;

/** 처음 찾은 키 ("T-42"). 브랜치 → 꼬리말 → 제목 → 본문 순 */
export function findTicketKey(p: { branch?: string; title?: string; body?: string; message?: string }): string | undefined {
  const b = p.branch ? BRANCH.exec(p.branch.trim()) : null;
  if (b) return `T-${Number(b[1])}`;
  for (const text of [p.message, p.body]) {
    const m = text ? TRAILER.exec(text) : null;
    if (m) return `T-${Number(m[1])}`;
  }
  for (const text of [p.title, p.body, p.message]) {
    const m = text ? KEY.exec(text) : null;
    if (m) return `T-${Number(m[1])}`;
  }
  return undefined;
}

/** X-Hub-Signature-256 (`sha256=<hex>`) 이 raw 본문의 HMAC 과 같은지. 길이가 달라도 시간 차이를 덜 내게 비교한다 */
export function verifyGithubSignature(secret: string, raw: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = createHmac("sha256", secret).update(raw, "utf8").digest();
  const got = Buffer.from(header.slice(7).trim(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export const githubSignature = (secret: string, raw: string) => `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
