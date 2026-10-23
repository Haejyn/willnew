/**
 * `willnew hub` and `willnew runner` (team mode, docs/design/hub-runner.md "팀 모드 결정 > 실행 방식").
 * main() resolves with the exit code once the process should stop. cli.ts has already pointed WILLNEW_HOME at
 * ~/.willnew/hub or ~/.willnew/runner before this file is imported.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createHub } from "./hub.js";
import { HOME } from "./home.js";
import { Members } from "./members.js";
import { planRunner, Runner } from "./runner.js";

const HUB_USAGE = `usage: willnew hub --repo-remote github.com/org/app [--members ~/.willnew/members.json] [--no-self-approve] [--base main] [--check "<cmd>"] [--reviewers "name,name"] [--deploy-check "<cmd with {sha}>"] [--deploy-env production] [--port 7777] [--host 127.0.0.1]
                  [--slack --slack-channel C0123:backend --slack-web-url http://my-host:7777]
  사람과 러너 토큰: willnew invite <이름> [--role developer], willnew runner-token <이름>
  ANTHROPIC_API_KEY 가 있으면 맡기 전 계획(되묻기, 명세, 제안)을 허브가 만들어요. 없으면 맡은 개발자의 러너가 만들어요`;
const RUNNER_USAGE = `usage: willnew runner --hub ws://host:7777/runner --token <러너 토큰> --repo <로컬 clone> [--claim manual|auto] [--slots 1] [--preview "<cmd, {port}>"] [--preview-base-url "http://my-host:{port}"] [--allow-codex] [--id <러너 이름>]
  --token 대신 WILLNEW_RUNNER_TOKEN 환경 변수도 돼요`;

export async function main(cmd: "hub" | "runner", argv: string[], o: { membersPath: string }): Promise<number> {
  const flag = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  if (has("help")) {
    console.log(cmd === "hub" ? HUB_USAGE : RUNNER_USAGE);
    return 0;
  }
  return cmd === "hub" ? hub(flag, has, argv, o.membersPath) : runner(flag, has);
}

type Flag = (name: string, fallback?: string) => string | undefined;

async function hub(flag: Flag, has: (n: string) => boolean, argv: string[], defaultMembers: string): Promise<number> {
  const remote = flag("repo-remote");
  if (!remote) {
    console.error(HUB_USAGE);
    return 1;
  }
  const membersPath = resolve(flag("members") ?? defaultMembers);
  let members: Members;
  try {
    members = Members.load(membersPath);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  if (!existsSync(membersPath) || !members.all().length) console.log(`${membersPath} 에 아무도 없어요. willnew invite <이름> --role developer 로 사람부터 넣어 주세요`);
  else if (!members.all().some((m) => m.runnerTokenHashes?.length)) console.log("러너 토큰이 아직 없어요. willnew runner-token <이름> 으로 만들어 주세요");
  // the hub holds no AI login: without a company API key, planning waits for the claim and runs on that runner
  const planOnHub = !!process.env.ANTHROPIC_API_KEY?.trim();
  const port = Number(flag("port", "7777"));
  const host = flag("host", "127.0.0.1")!;
  const noSelfApprove = has("no-self-approve");
  let app: ReturnType<typeof createHub>;
  try {
    app = createHub({
      remote, members, noSelfApprove, planOnHub, baseBranch: flag("base", "main"), check: flag("check", ""),
      reviewers: (flag("reviewers", "") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      deployCheck: flag("deploy-check"), deployEnv: flag("deploy-env", "production"),
    });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const server = serve({ fetch: app.app.fetch, port, hostname: host }, () => {
    const shown = host === "0.0.0.0" ? "localhost" : host;
    console.log(`willnew 허브 · ${remote} · ${planOnHub ? "맡기 전 계획은 허브의 API 키로" : "맡기 전 계획은 맡은 사람의 러너에서"}${noSelfApprove ? " · 자기 승인 막음" : ""}`);
    console.log(`사람 ${membersPath} · 기록 ${HOME}`);
    console.log(`웹 http://${shown}:${port} (초대 링크로 들어와요)`);
    console.log(`러너 ws://${shown}:${port}/runner`);
  });
  app.injectWebSocket(server);
  if (has("slack")) {
    const { slackFromArgs } = await import("./slack/cli.js");
    try {
      console.log(await slackFromArgs({ argv, requests: app.requests, runs: app.runs, channels: app.chat.channels, repo: remote, check: flag("check", "") ?? "", members, noSelfApprove, webBaseUrl: flag("slack-web-url") }));
    } catch (e) {
      console.error(`Slack 을 켜지 못했어요: ${(e as Error).message}`);
      server.close();
      return 1;
    }
  }
  return new Promise((done) => {
    const stop = () => {
      server.close(() => done(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function runner(flag: Flag, has: (n: string) => boolean): Promise<number> {
  const hubUrl = flag("hub");
  const token = flag("token") ?? process.env.WILLNEW_RUNNER_TOKEN;
  if (!hubUrl || !token) {
    console.error(RUNNER_USAGE);
    return 1;
  }
  if (typeof WebSocket === "undefined") {
    console.error("러너는 Node 22 이상에서 돌아요 (WebSocket 이 필요해요)");
    return 1;
  }
  const slots = flag("slots");
  const previewBaseUrl = flag("preview-base-url");
  if (previewBaseUrl && !previewBaseUrl.includes("{port}")) {
    console.error("--preview-base-url 에는 {port} 가 들어가야 해요. 예: http://my-host:{port}");
    return 1;
  }
  let plan;
  try {
    plan = planRunner({ env: process.env, claim: flag("claim", "manual"), slots: slots == null ? undefined : Number(slots), allowCodex: has("allow-codex") });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  return new Promise<number>((done) => {
    const r = new Runner({ ...plan, hub: hubUrl, token, repo: resolve(flag("repo", process.cwd())!), runnerId: flag("id"),
      preview: flag("preview"), previewBaseUrl, onFatal: () => done(1) });
    r.start().then(() => {
      console.log(`willnew 러너 ${r.id} · ${plan.auth === "api" ? "사용량 과금" : "개인 구독"} · ${plan.claim === "auto" ? "자동으로 가져가요" : "맡은 일만 해요"} · 슬롯 ${plan.slots} · 기록 ${HOME}`);
    }, (e: Error) => {
      console.error(e.message);
      done(1);
    });
    const stop = () => {
      r.stop();
      done(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
