#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const cmd = argv[0] ?? "serve";
// team mode people: members.json (src/server/members-cli.ts)
if (cmd === "invite" || cmd === "runner-token") {
  const { membersCli } = await import("./members-cli.js");
  process.exit(membersCli(cmd, argv.slice(1)));
}
if (cmd !== "serve") {
  console.log(`usage: willnew serve [--repo <path>] [--check "<cmd>"] [--preview "<dev server cmd, {port}>"] [--preview-base-url "http://my-host:{port}"] [--reviewers "name,name"] [--ship merge|pr] [--deploy-check "<cmd with {sha}>"] [--deploy-env production] [--port 7777] [--host 127.0.0.1] [--slack --slack-channel C0123:backend --slack-members people.json --slack-web-url http://my-host:7777]`);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}

const repo = resolve(flag("repo", process.cwd())!);
const check = flag("check", "")!;
const preview = flag("preview");
// where other people open a preview; the default only works on this machine
const previewBaseUrl = flag("preview-base-url");
if (previewBaseUrl && !previewBaseUrl.includes("{port}")) {
  console.error("--preview-base-url 에는 {port} 가 들어가야 해요. 예: http://my-host:{port}");
  process.exit(1);
}
const reviewers = (flag("reviewers", "") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const ship = flag("ship", "merge");
if (ship !== "merge" && ship !== "pr") {
  console.error("--ship 은 merge 또는 pr 이에요");
  process.exit(1);
}
const deployCheck = flag("deploy-check");
const deployEnv = flag("deploy-env", "production");
const port = Number(flag("port", "7777"));
const host = flag("host", "127.0.0.1")!;
// Anything beyond localhost (e.g. your phone on the LAN) needs a token: agents can edit code on this machine.
const token = host === "127.0.0.1" || host === "localhost" ? flag("token") : flag("token", randomBytes(12).toString("hex"));

const { app, injectWebSocket, requests, runs, chat } = createApp({ repo, check, token, preview, previewBaseUrl, reviewers, ship, deployCheck, deployEnv });
const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${token ? `/?token=${token}` : ""}`;
  console.log(`willnew · repo ${repo}${check ? ` · check "${check}"` : ""}${preview ? ` · preview "${preview}"` : ""}`);
  console.log(`open ${url}`);
});
injectWebSocket(server);

// Slack app (Socket Mode). Loaded only with --slack. Tokens come from the environment, never from flags
if (argv.includes("--slack")) {
  const { startSlack, loadSlackPeople } = await import("./slack/index.js");
  const channelMap: Record<string, string> = {};
  argv.forEach((a, i) => {
    if (a !== "--slack-channel" || !argv[i + 1]) return;
    const [id, name] = argv[i + 1].split(":");
    channelMap[id.trim()] = name?.trim() || chat.channels[0].id;
  });
  if (!Object.keys(channelMap).length) {
    console.error("--slack 에는 --slack-channel <Slack 채널 ID>:<willnew 채널> 이 하나 이상 필요해요. 예: --slack-channel C0123:backend");
    process.exit(1);
  }
  const membersFile = flag("slack-members");
  const people = membersFile ? loadSlackPeople(resolve(membersFile)) : { resolveSlackUser: () => null, slackIdOf: () => null };
  if (!membersFile) console.warn("--slack-members 가 없어서 Slack 에서 아무도 요청하거나 승인할 수 없어요");
  try {
    await startSlack({
      requests, runs, ...people, channelMap, channels: chat.channels, repo, check,
      botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, webBaseUrl: flag("slack-web-url"),
    });
    console.log(`slack · Socket Mode · 채널 ${Object.entries(channelMap).map(([id, name]) => `${id} → ${name}`).join(", ")}`);
  } catch (e) {
    console.error(`Slack 을 켜지 못했어요: ${(e as Error).message}`);
    process.exitCode = 1;
    server.close();
  }
}
