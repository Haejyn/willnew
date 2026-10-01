/**
 * Triage (planner) agent: reads a chat request and decides what kind of work it is, rewrites it into a precise
 * instruction for the worker agents, lays out a short plan, and picks the verification command.
 * Uses a small, fast model through Claude Code headless (`claude -p --model haiku`); falls back to keyword rules.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { ADAPTERS, installed } from "./adapters.js";
import { routeByRules, TEMPLATES, templateById } from "./templates.js";
import type { Triage } from "./types.js";

const TRIAGE_TIMEOUT_MS = 60_000;

function repoListing(repo: string): string {
  try {
    return readdirSync(repo).filter((f) => !f.startsWith(".") && f !== "node_modules").slice(0, 40).join(", ");
  } catch {
    return "";
  }
}

export function rulesTriage(text: string, defaultCheck: string): Triage {
  const tpl = routeByRules(text);
  const body = text.replace(/@willnew/gi, "").trim();
  return {
    by: "rules", template: tpl.id, title: body.split(/[.\n]/)[0].slice(0, 60),
    task: `${tpl.instruction}\n\nRequest: ${body}`,
    plan: ["요청 유형 분류 (키워드)", "워크트리에서 에이전트 실행", `검증: ${tpl.check || defaultCheck || "없음"}`, "담당자 승인 후 반영"],
    agents: tpl.agents, check: tpl.check || defaultCheck, reason: `키워드로 '${tpl.name}' 분류`,
  };
}

const PROMPT = (text: string, files: string, check: string) => `You are the triage agent of willnew, a team AI engineering platform.
A colleague posted this request in team chat:
"""${text}"""
Repository files: ${files}
Default verification command: ${check || "(none)"}
Work templates: ${TEMPLATES.map((t) => `${t.id} (${t.name})`).join(", ")}

Decide how willnew should handle it. Reply with ONLY a JSON object, no prose:
{"template": one of [${TEMPLATES.map((t) => `"${t.id}"`).join(",")}],
 "title": short Korean title (<= 30 chars),
 "task": precise English instruction for coding agents (what to change, constraints, how to verify),
 "plan": 3-5 short Korean steps,
 "check": shell command that verifies the result ("" if none),
 "agents": number of parallel agents — 2 for ordinary code changes (so results can be compared), 3 for larger features or risky changes, 1 only for docs,
 "reason": one short Korean sentence why}`;

export async function triage(text: string, repo: string, defaultCheck: string): Promise<Triage> {
  const t0 = Date.now();
  if (process.env.WILLNEW_TRIAGE === "rules" || !installed(ADAPTERS["claude-code"])) return rulesTriage(text, defaultCheck);
  try {
    let envelope: { result?: string; total_cost_usd?: number } = {};
    let j: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !j; attempt++) {
      try {
        envelope = JSON.parse(await runClaude(PROMPT(text, repoListing(repo), defaultCheck), repo));
        const raw = envelope.result ?? "";
        j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    if (!j) throw new Error("no plan");
    const tpl = templateById(String(j.template));
    const n = Math.max(1, Math.min(3, Number(j.agents) || tpl.agents.length));
    const pool = [...tpl.agents, ...TEMPLATES.find((x) => x.id === "feature")!.agents]
      .filter((a, i, arr) => arr.findIndex((b) => b.label === a.label) === i);
    return {
      by: "llm", template: tpl.id, title: String(j.title ?? "").slice(0, 60) || rulesTriage(text, defaultCheck).title,
      task: `${tpl.instruction}\n\n${String(j.task ?? text)}`,
      plan: Array.isArray(j.plan) ? j.plan.map((x: unknown) => String(x).replace(/^\s*\d+[.)]\s*/, "")).slice(0, 6) : [],
      agents: pool.slice(0, n), check: typeof j.check === "string" ? j.check : defaultCheck,
      reason: String(j.reason ?? ""), durationMs: Date.now() - t0,
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    };
  } catch {
    return { ...rulesTriage(text, defaultCheck), durationMs: Date.now() - t0, reason: "LLM 분류 실패 → 키워드 규칙으로 대체" };
  }
}

function runClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--model", process.env.WILLNEW_TRIAGE_MODEL ?? "haiku",
      "--max-turns", "1", "--tools", ""], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const timer = setTimeout(() => { child.kill(); reject(new Error("triage timeout")); }, TRIAGE_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}`)); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.end(prompt);
  });
}
