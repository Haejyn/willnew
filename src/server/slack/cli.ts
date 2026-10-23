/**
 * `--slack` for `willnew serve` and `willnew hub`: Slack channel ids from `--slack-channel C0123:backend`, people from
 * members.json (Slack id → name and role, name → Slack id for real mentions). Tokens come from the environment only.
 */
import type { Members } from "../members.js";
import type { Channel } from "../types.js";
import type { SlackRequests, SlackRuns, SlackUser } from "./bridge.js";
import { startSlack } from "./index.js";

/** members.json as the bridge sees people. */
export function slackPeopleFrom(members: Members) {
  return {
    resolveSlackUser: (id: string): SlackUser | null => {
      const m = members.bySlackId(id);
      return m ? { name: m.name, role: m.role, title: m.title || undefined, avatar: m.avatar } : null;
    },
    slackIdOf: (name: string) => members.get(name)?.slackId ?? null,
  };
}

/** `--slack-channel C0123:backend` (repeatable) → { C0123: "backend" }. A missing name maps to the first willnew channel. */
export function slackChannelMap(argv: string[], fallback: string): Record<string, string> {
  const map: Record<string, string> = {};
  argv.forEach((a, i) => {
    if (a !== "--slack-channel" || !argv[i + 1]) return;
    const [id, name] = argv[i + 1].split(":");
    if (id?.trim()) map[id.trim()] = name?.trim() || fallback;
  });
  return map;
}

export interface SlackFromArgs {
  argv: string[];
  requests: SlackRequests;
  runs: SlackRuns;
  channels: Channel[];
  repo: string;
  check: string;
  members: Members;
  noSelfApprove?: boolean;
  webBaseUrl?: string;
}

/** Starts the Slack app or throws with a message for the person at the terminal. Returns the channel summary line. */
export async function slackFromArgs(o: SlackFromArgs): Promise<string> {
  const channelMap = slackChannelMap(o.argv, o.channels[0]?.id ?? "backend");
  if (!Object.keys(channelMap).length) throw new Error("--slack 에는 --slack-channel <Slack 채널 ID>:<willnew 채널> 이 하나 이상 필요해요. 예: --slack-channel C0123:backend");
  if (!o.members.all().some((m) => m.slackId)) console.warn(`${o.members.path} 에 Slack ID 가 있는 사람이 없어서 Slack 에서 아무도 요청하거나 승인할 수 없어요. willnew invite <이름> --slack-id U123 으로 넣어 주세요`);
  await startSlack({
    requests: o.requests, runs: o.runs, ...slackPeopleFrom(o.members), channelMap, channels: o.channels, repo: o.repo, check: o.check,
    noSelfApprove: o.noSelfApprove, botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, webBaseUrl: o.webBaseUrl,
  });
  return `slack · Socket Mode · 채널 ${Object.entries(channelMap).map(([id, name]) => `${id} → ${name}`).join(", ")}`;
}
