/**
 * Agent adapters: how to launch each coding-agent CLI headless, and how to turn its JSONL stream into
 * normalised events + usage. Adding an agent = adding one entry here.
 */
import { execFileSync } from "node:child_process";
import type { AgentEvent, Usage } from "./types.js";

export interface ParsedLine {
  events: AgentEvent[];
  usage?: Partial<Usage>;
  turns?: number;
  summary?: string;
  done?: boolean;
  failed?: boolean;
}

export interface Adapter {
  id: string;
  name: string;
  /** executable + args; the prompt is passed as the last argument, cwd = the agent's worktree */
  command(prompt: string, opts: { model?: string; cwd: string }): { cmd: string; args: string[] };
  parse(line: string): ParsedLine;
  binary: string;
  /** send the prompt on stdin instead of as an argument (safer for long prompts and variadic flags) */
  stdinPrompt?: boolean;
}

const now = () => Date.now();
const ev = (kind: AgentEvent["kind"], text: string): AgentEvent => ({ ts: now(), kind, text });
const clip = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + " …" : s);

function safeJson(line: string): any | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Claude Code: `claude -p --output-format stream-json --verbose` */
export const claudeCode: Adapter = {
  id: "claude-code",
  name: "Claude Code",
  binary: "claude",
  stdinPrompt: true,
  command(_prompt, { model }) {
    const args = ["-p", "--output-format", "stream-json", "--verbose",
      "--permission-mode", process.env.WILLNEW_CLAUDE_PERMISSION ?? "acceptEdits",
      "--allowedTools", "Bash(npm test*),Bash(npm run *),Bash(node *),Bash(pnpm *),Bash(git diff*),Bash(git status*)"];
    if (model) args.push("--model", model);
    return { cmd: "claude", args };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return { events: [] };
    if (j.type === "assistant" && j.message?.content) {
      const events: AgentEvent[] = [];
      for (const c of j.message.content) {
        if (c.type === "text" && c.text?.trim()) events.push(ev("text", clip(c.text)));
        if (c.type === "tool_use") events.push(ev("tool", `${c.name} ${clip(JSON.stringify(c.input ?? {}), 300)}`));
      }
      return { events };
    }
    if (j.type === "user" && Array.isArray(j.message?.content)) {
      const r = j.message.content.find((c: any) => c.type === "tool_result");
      if (r) {
        const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
        return { events: [ev("tool_result", clip(text, 300))] };
      }
    }
    if (j.type === "result") {
      const u = j.usage ?? {};
      return {
        events: [ev("status", `finished · ${j.num_turns ?? "?"} turns`)],
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          cachedTokens: u.cache_read_input_tokens ?? 0,
          costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null,
        },
        turns: j.num_turns,
        summary: typeof j.result === "string" ? j.result : "",
        done: true,
        failed: j.is_error === true || j.subtype !== "success",
      };
    }
    return { events: [] };
  },
};

/** Codex CLI: `codex exec --json` */
export const codex: Adapter = {
  id: "codex",
  name: "Codex",
  binary: "codex",
  command(prompt, { model, cwd }) {
    // Codex's workspace-write sandbox hangs shell commands on some Windows setups; the worktree is the isolation
    // boundary there, so default to full access on Windows (override with WILLNEW_CODEX_SANDBOX).
    const sandbox = process.env.WILLNEW_CODEX_SANDBOX ?? (process.platform === "win32" ? "danger-full-access" : "workspace-write");
    const args = ["exec", "--json", "--skip-git-repo-check", "-s", sandbox, "-C", cwd];
    if (model) args.push("-m", model);
    args.push(prompt);
    return { cmd: "codex", args };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return { events: [] };
    const type: string = j.type ?? j.msg?.type ?? "";
    const item = j.item ?? j.msg ?? {};
    if (type === "item.completed" || type === "item.started") {
      const it = item;
      if (it.type === "agent_message" && it.text) return { events: [ev("text", clip(it.text))], summary: it.text };
      if (it.type === "command_execution" && type === "item.started") return { events: [ev("tool", `shell ${clip(it.command ?? "", 300)}`)] };
      if (it.type === "command_execution" && type === "item.completed")
        return { events: [ev("tool_result", `exit ${it.exit_code ?? "?"} ${clip(it.aggregated_output ?? "", 300)}`)] };
      if (it.type === "file_change" && type === "item.completed")
        return { events: [ev("tool", `edit ${(it.changes ?? []).map((c: any) => c.path).join(", ")}`)] };
      if (it.type === "reasoning" && it.text) return { events: [ev("text", clip(`💭 ${it.text}`, 300))] };
      return { events: [] };
    }
    if (type === "turn.completed") {
      const u = j.usage ?? {};
      return {
        events: [ev("status", "turn completed")],
        usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cachedTokens: u.cached_input_tokens ?? 0, costUsd: null },
        turns: 1,
      };
    }
    if (type === "turn.failed" || type === "error")
      return { events: [ev("error", clip(j.error?.message ?? j.message ?? JSON.stringify(j), 400))], failed: true };
    return { events: [] };
  },
};

/**
 * Scripted agent for demos and tests without API usage: runs `node <script>` inside the worktree.
 * The script prints JSONL like {"type":"text","text":"..."} and edits files itself.
 */
export const script: Adapter = {
  id: "script",
  name: "Script (offline)",
  binary: "node",
  command(prompt, { model }) {
    return { cmd: "node", args: [model ?? "agent.mjs", prompt] };
  },
  parse(line) {
    const j = safeJson(line);
    if (!j) return line.trim() ? { events: [ev("text", clip(line.trim()))] } : { events: [] };
    if (j.type === "result")
      return { events: [ev("status", "finished")], summary: j.text ?? "", done: true, turns: j.turns ?? 1,
        usage: { inputTokens: j.inputTokens ?? 0, outputTokens: j.outputTokens ?? 0, cachedTokens: 0, costUsd: j.costUsd ?? 0 } };
    return { events: [ev(j.type === "tool" ? "tool" : "text", clip(String(j.text ?? "")))] };
  },
};

export const ADAPTERS: Record<string, Adapter> = { [claudeCode.id]: claudeCode, [codex.id]: codex, [script.id]: script };

export function installed(a: Adapter): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [a.binary], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
