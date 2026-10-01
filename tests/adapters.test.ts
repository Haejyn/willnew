import { describe, expect, it } from "vitest";
import { claudeCode, codex } from "../src/server/adapters.js";

describe("claude code stream-json", () => {
  it("turns assistant text and tool calls into events", () => {
    const p = claudeCode.parse(JSON.stringify({ type: "assistant", message: { content: [
      { type: "text", text: "Let me look." }, { type: "tool_use", name: "Edit", input: { file_path: "a.js" } }] } }));
    expect(p.events.map((e) => e.kind)).toEqual(["text", "tool"]);
    expect(p.events[1].text).toContain("Edit");
  });
  it("reads cost, tokens and turns from the result line", () => {
    const p = claudeCode.parse(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 4,
      result: "done", total_cost_usd: 0.031, usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 300 } }));
    expect(p).toMatchObject({ done: true, failed: false, turns: 4, summary: "done" });
    expect(p.usage).toEqual({ inputTokens: 210, outputTokens: 300, cachedTokens: 5000, costUsd: 0.031 });
  });
  it("ignores non-JSON noise", () => {
    expect(claudeCode.parse("warning: something").events).toEqual([]);
  });
});

describe("codex exec --json", () => {
  it("maps agent messages, shell commands and file changes", () => {
    expect(codex.parse(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "All tests pass." } })).summary)
      .toBe("All tests pass.");
    expect(codex.parse(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } })).events[0])
      .toMatchObject({ kind: "tool" });
    expect(codex.parse(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.js" }] } })).events[0].text)
      .toContain("a.js");
  });
  it("reads per-turn token usage", () => {
    const p = codex.parse(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } }));
    expect(p.usage).toMatchObject({ inputTokens: 1000, cachedTokens: 800, outputTokens: 50, costUsd: null });
  });
  it("flags failed turns", () => {
    expect(codex.parse(JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } })).failed).toBe(true);
  });
});
