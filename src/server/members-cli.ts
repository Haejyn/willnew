/**
 * `willnew invite <이름>` and `willnew runner-token <이름>`: write members.json and print the token once.
 * Only the hash stays on disk, so a lost link means a new invite.
 */
import { resolve } from "node:path";
import { defaultMembersPath, Members, type MemberRole } from "./members.js";

export const MEMBERS_USAGE = [
  `usage: willnew invite <이름> [--role developer|requester] [--title "직함"] [--slack-id U123] [--avatar <url>] [--url http://hub:7777] [--members <path>]`,
  `       willnew runner-token <이름> [--members <path>]`,
].join("\n");

/** Runs one command. Returns the exit code; output goes through `out` / `err`. */
export function membersCli(cmd: string, args: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // the name is the first word that is not a flag or a flag's value
  const name = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")))?.trim();
  if (!name) {
    err(MEMBERS_USAGE);
    return 1;
  }
  const path = resolve(flag("members") ?? defaultMembersPath());
  try {
    const members = Members.load(path);
    if (cmd === "invite") {
      const role = flag("role");
      if (role !== undefined && role !== "developer" && role !== "requester") {
        err("--role 은 developer 또는 requester 예요");
        return 1;
      }
      const { token, member } = members.invite(name, { role: role as MemberRole | undefined, title: flag("title"), slackId: flag("slack-id"), avatar: flag("avatar") });
      const base = (flag("url") ?? "http://127.0.0.1:7777").replace(/\/+$/, "");
      out(`넣었어요: ${member.name} (${member.role === "developer" ? "개발자" : "요청자"}), 파일 ${path}`);
      out(`초대 링크 (한 번만 보여요): ${base}/?invite=${token}`);
      return 0;
    }
    if (cmd === "runner-token") {
      const { token, member } = members.addRunnerToken(name);
      out(`러너 토큰 (${member.name}, 한 번만 보여요):`);
      out(token);
      return 0;
    }
    err(MEMBERS_USAGE);
    return 1;
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}
