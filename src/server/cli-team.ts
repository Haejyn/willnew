/**
 * `willnew hub` and `willnew runner` (team mode, docs/design/hub-runner.md "팀 모드 결정 > 실행 방식").
 * main() resolves with the exit code once the process should stop.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createHub, type ResolveRunner } from "./hub.js";
import { planRunner, Runner } from "./runner.js";

const HUB_USAGE = `usage: willnew hub --repo-remote github.com/org/app [--base main] [--check "<cmd>"] [--reviewers "name,name"] [--deploy-check "<cmd with {sha}>"] [--deploy-env production] [--port 7777] [--host 127.0.0.1] [--token <web token>]
  러너 토큰: WILLNEW_RUNNER_TOKENS="이름:토큰,이름:토큰"`;
const RUNNER_USAGE = `usage: willnew runner --hub ws://host:7777/runner --token <러너 토큰> --repo <로컬 clone> [--claim manual|auto] [--slots 1] [--preview "<cmd, {port}>"] [--preview-base-url "http://my-host:{port}"] [--allow-codex] [--id <러너 이름>]
  --token 대신 WILLNEW_RUNNER_TOKEN 환경 변수도 돼요`;

/**
 * Temporary runner check until members.ts lands: `WILLNEW_RUNNER_TOKENS="이름:토큰,이름:토큰"`.
 * Integration replaces this with members.byRunnerToken.
 */
export function runnerTokensFromEnv(value: string | undefined): ResolveRunner {
  const map = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim(), token = pair.slice(i + 1).trim();
    if (name && token) map.set(token, name);
  }
  return (token) => {
    const name = map.get(token);
    return name ? { name } : null;
  };
}

export async function main(cmd: "hub" | "runner", argv: string[]): Promise<number> {
  const flag = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  if (has("help")) {
    console.log(cmd === "hub" ? HUB_USAGE : RUNNER_USAGE);
    return 0;
  }
  return cmd === "hub" ? hub(flag, has) : runner(flag, has);
}

type Flag = (name: string, fallback?: string) => string | undefined;

async function hub(flag: Flag, has: (n: string) => boolean): Promise<number> {
  const remote = flag("repo-remote");
  if (!remote) {
    console.error(HUB_USAGE);
    return 1;
  }
  if (has("members")) console.log("--members 는 사람과 권한 작업이 합쳐진 뒤에 써요. 지금은 러너만 WILLNEW_RUNNER_TOKENS 로 확인해요");
  if (has("slack")) console.log("--slack 은 Slack 작업이 합쳐진 뒤에 써요");
  // the hub holds no AI login: without a company API key, planning before someone takes the work uses keyword rules
  if (!process.env.ANTHROPIC_API_KEY) process.env.WILLNEW_TRIAGE = "rules";
  const tokens = process.env.WILLNEW_RUNNER_TOKENS;
  if (!tokens?.trim()) console.log("WILLNEW_RUNNER_TOKENS 가 비어 있어서 어떤 러너도 붙을 수 없어요");
  const port = Number(flag("port", "7777"));
  const host = flag("host", "127.0.0.1")!;
  const token = host === "127.0.0.1" || host === "localhost" ? flag("token") : flag("token", randomBytes(12).toString("hex"));
  let app;
  try {
    app = createHub({
      remote, baseBranch: flag("base", "main"), check: flag("check", ""), token,
      reviewers: (flag("reviewers", "") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      resolveRunner: runnerTokensFromEnv(tokens), deployCheck: flag("deploy-check"), deployEnv: flag("deploy-env", "production"),
    });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const server = serve({ fetch: app.app.fetch, port, hostname: host }, () => {
    const shown = host === "0.0.0.0" ? "localhost" : host;
    console.log(`willnew 허브 · ${remote}${process.env.ANTHROPIC_API_KEY ? " · 계획은 허브의 API 키로" : ""}`);
    console.log(`웹 http://${shown}:${port}${token ? `/?token=${token}` : ""}`);
    console.log(`러너 ws://${shown}:${port}/runner`);
  });
  app.injectWebSocket(server);
  return new Promise((done) => {
    process.once("SIGINT", () => server.close(() => done(0)));
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
      console.log(`willnew 러너 ${r.id} · ${plan.auth === "api" ? "사용량 과금" : "개인 구독"} · ${plan.claim === "auto" ? "자동으로 가져가요" : "맡긴 일만 해요"} · 슬롯 ${plan.slots}`);
    }, (e: Error) => {
      console.error(e.message);
      done(1);
    });
    process.once("SIGINT", () => {
      r.stop();
      done(0);
    });
  });
}
