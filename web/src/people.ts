/** 채널의 사람들: 이름 색(역할 계열), 멤버 칸의 묶음, 메시지에서 멤버 목록 뽑기. */
import type { Channel, ChatMessage } from "./api";

export interface Member {
  name: string;
  title?: string;
  avatar?: string;
  /** 멤버 칸의 묶음 이름: "디자인", "CS", "개발", "봇" */
  group: string;
  bot?: boolean;
  /** 데모에만 있다. 서버에는 접속 상태가 없다 */
  presence?: "online" | "away";
}

/** 개발 쪽 직함. 나머지 직함(CS, 디자인, PM 등)은 요청자 계열로 본다 */
const DEV_TITLE = /백엔드|프론트|데이터|개발|인프라|엔지니어|리드|dev|backend|frontend|engineer|infra/i;

export type RoleFamily = "bot" | "dev" | "req" | "none";
export function roleFamily(title: string | undefined, bot?: boolean): RoleFamily {
  if (bot) return "bot";
  if (!title) return "none";
  return DEV_TITLE.test(title) ? "dev" : "req";
}

const shade = (s: string) => ([...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 3) + 1;

/** 이름 색: 요청자 계열 한 색조, 개발 계열 한 색조, 봇은 액센트. 같은 직함은 같은 색. */
export function nameColor(title: string | undefined, bot?: boolean): string | undefined {
  const f = roleFamily(title, bot);
  if (f === "bot") return "var(--role-bot)";
  if (f === "none") return undefined;
  return `var(--role-${f}-${shade(title!)})`;
}

export function groupOf(title: string | undefined, bot?: boolean): string {
  const f = roleFamily(title, bot);
  return f === "bot" ? "봇" : f === "dev" ? "개발" : f === "req" ? title! : "멤버";
}

/** 묶음 순서: 요청자 쪽 직함들 → 개발 → 직함 없음 → 봇 */
export function groupOrder(g: string): number {
  return g === "봇" ? 3 : g === "멤버" ? 2 : g === "개발" ? 1 : 0;
}

/** 메시지 작성자와 채널 검토자로 멤버 목록을 만든다. 직함은 그 사람의 가장 최근 메시지에서. */
export function membersFrom(messages: ChatMessage[], channel?: Channel): Member[] {
  const by = new Map<string, Member>();
  for (const m of messages.slice().sort((a, b) => a.ts - b.ts)) {
    if (m.bot) {
      by.set("willnew", { name: "willnew", group: "봇", bot: true });
      continue;
    }
    const cur = by.get(m.user);
    const title = m.userTitle ?? cur?.title;
    by.set(m.user, { name: m.user, title, avatar: m.userAvatar ?? cur?.avatar, group: groupOf(title) });
  }
  for (const r of channel?.reviewers ?? []) if (!by.has(r)) by.set(r, { name: r, title: "개발", group: "개발" });
  if (!by.has("willnew")) by.set("willnew", { name: "willnew", group: "봇", bot: true });
  return [...by.values()];
}
