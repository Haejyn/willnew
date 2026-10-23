#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
// team mode: runs until the hub or runner stops, then exits (never falls through to serve).
// The hub and the runner keep their state apart (~/.willnew/hub, ~/.willnew/runner) so both can run on one PC.
// members.json stays in ~/.willnew, where `willnew invite` writes it. Nothing that reads the home is imported before this.
if (cmd === "hub" || cmd === "runner") {
  const base = process.env.WILLNEW_HOME ?? join(homedir(), ".willnew");
  process.env.WILLNEW_HOME = join(base, cmd);
  const { main } = await import("./cli-team.js");
  process.exit(await main(cmd, argv, { membersPath: join(base, "members.json") }));
}
if (cmd !== "serve") {
  console.log(`usage: willnew serve | hub | runner   (willnew hub --help, willnew runner --help)
       willnew serve [--repo <path>] [--check "<cmd>"] [--preview "<dev server cmd, {port}>"] [--preview-base-url "http://my-host:{port}"] [--reviewers "name,name"] [--ship merge|pr] [--deploy-check "<cmd with {sha}>"] [--deploy-env production] [--port 7777] [--host 127.0.0.1] [--slack --slack-channel C0123:backend --slack-web-url http://my-host:7777 [--members members.json] [--no-self-approve]]
       willnew invite <이름> [--role developer] · willnew runner-token <이름>`);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}

const { serve } = await import("@hono/node-server");
const { createApp } = await import("./app.js");

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

// Slack app (Socket Mode). Loaded only with --slack. Tokens come from the environment, never from flags.
// People (Slack id, name, role) come from members.json, the same file the hub uses.
if (argv.includes("--slack")) {
  const { Members, defaultMembersPath } = await import("./members.js");
  const { slackFromArgs } = await import("./slack/cli.js");
  try {
    const members = Members.load(resolve(flag("members") ?? defaultMembersPath()));
    console.log(await slackFromArgs({ argv, requests, runs, channels: chat.channels, repo, check, members, noSelfApprove: argv.includes("--no-self-approve"), webBaseUrl: flag("slack-web-url") }));
  } catch (e) {
    console.error(`Slack 을 켜지 못했어요: ${(e as Error).message}`);
    process.exitCode = 1;
    server.close();
  }
}
