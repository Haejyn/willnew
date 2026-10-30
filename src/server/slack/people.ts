/**
 * Slack id ↔ willnew person, for `willnew serve --slack` before the hub's members.json exists. The file uses the same
 * fields as members.json (`name`, `role`, `title`, `avatar`, `slackId`), so the hub can pass Members.bySlackId instead.
 */
import { readFileSync } from "node:fs";
import type { SlackUser } from "./bridge.js";

export interface SlackPerson extends SlackUser {
  slackId?: string;
}

export function slackPeople(list: SlackPerson[]) {
  const people = list.filter((p) => p && p.name && p.slackId);
  return {
    resolveSlackUser: (id: string): SlackUser | null => {
      const p = people.find((x) => x.slackId === id);
      return p ? { name: p.name, role: p.role === "developer" ? "developer" : "requester", title: p.title, avatar: p.avatar } : null;
    },
    slackIdOf: (name: string) => people.find((x) => x.name === name)?.slackId ?? null,
  };
}

export function loadSlackPeople(file: string) {
  const list = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${file} 은 사람 목록(배열)이어야 해요`);
  return slackPeople(list);
}
