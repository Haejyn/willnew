import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const NOTE = resolve("tests/fixtures/note-agent.mjs");
const FIX = resolve("tests/fixtures/fix-agent.mjs");
const BENDER = resolve("tests/fixtures/test-editor-agent.mjs");

let repo = "";
let RunManager: typeof import("../src/server/runs.js").RunManager;
let Terminals: typeof import("../src/server/terminal.js").Terminals;

function makeRepo() {
  const r = mkdtempSync(join(tmpdir(), "willnew-repo-"));
  git(r, "init", "-q", "-b", "main");
  writeFileSync(join(r, "math.js"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(r, "math.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  writeFileSync(join(r, "package.json"), '{ "type": "module", "scripts": { "test": "node --test" } }\n');
  git(r, "add", "-A");
  git(r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return r;
}

beforeAll(async () => {
  process.env.WILLNEW_HOME = mkdtempSync(join(tmpdir(), "willnew-home-"));
  repo = makeRepo();
  ({ RunManager } = await import("../src/server/runs.js"));
  ({ Terminals } = await import("../src/server/terminal.js"));
});

const FINISHED = ["done", "failed", "cancelled"];
async function until(fn: () => boolean, ms = 20_000) {
  for (let t = 0; t < ms; t += 100) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout");
}

describe("follow-up instructions (steer)", () => {
  it("reopens a finished agent in the same session, then re-verifies", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "fix add()", check: "node --test", agents: [{ adapter: "script", model: NOTE, label: "note" }] });
    await until(() => FINISHED.includes(m.get(run.id)!.agents[0].status));
    const a = m.get(run.id)!.agents[0];
    expect(a.sessionId).toBe("sess-1");
    expect(m.get(run.id)!.review.status).toBe("pending");

    m.steer(run.id, a.id, "also cover negative numbers", "lead");
    expect(m.get(run.id)!.review.status).toBe("none");   // back to work, not waiting on a human
    await until(() => a.status === "done" && a.events.some((e) => e.text.startsWith("검증 통과") && e.ts > a.steers![0].at));
    expect(readFileSync(join(a.worktree, "NOTES.md"), "utf8")).toContain("resumed sess-1: also cover negative numbers");
    expect(a.events.some((e) => e.kind === "steer" && e.text === "lead: also cover negative numbers")).toBe(true);
    expect(a.summary).toContain("followed up");
    expect(m.get(run.id)!.review.status).toBe("pending");
    await m.remove(run.id);
  }, 30_000);

  it("interrupts a working agent and continues with the new instruction", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "SLOW fix add()", check: "node --test", agents: [{ adapter: "script", model: NOTE, label: "note" }] });
    const a = run.agents[0];
    await until(() => a.status === "running" && a.sessionId === "sess-1");
    const t0 = Date.now();
    m.steer(run.id, a.id, "skip the slow part", "lead");
    await until(() => FINISHED.includes(a.status));
    expect(Date.now() - t0).toBeLessThan(7000);   // did not wait out the slow first turn
    expect(a.status).toBe("done");
    expect(a.events.some((e) => e.text === "추가 지시를 반영해 이어서 작업")).toBe(true);
    expect(readFileSync(join(a.worktree, "NOTES.md"), "utf8")).toContain("resumed sess-1: skip the slow part");
    await m.remove(run.id);
  }, 30_000);

  it("sends line comments back as one follow-up and marks them sent", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "fix add()", check: "node --test", agents: [{ adapter: "script", model: NOTE, label: "note" }] });
    const a = run.agents[0];
    await until(() => FINISHED.includes(a.status));
    m.addComment(run.id, { agentId: a.id, file: "math.js", line: 1, text: "name the params", by: "lead" });
    m.setReviewed(run.id, a.id, "math.js", true);
    expect(m.get(run.id)!.reviewed![a.id]).toEqual(["math.js"]);
    expect(m.sendComments(run.id, a.id, "lead")).toBe(1);
    expect(m.get(run.id)!.comments![0].sentAt).toBeGreaterThan(0);
    await until(() => a.status === "done" && readFileSync(join(a.worktree, "PROMPTS.log"), "utf8").includes("math.js:1 — name the params"));
    expect(() => m.sendComments(run.id, a.id, "lead")).toThrow();
    await m.remove(run.id);
  }, 30_000);
});

describe("merge gate", () => {
  it("flags results that edited tests and recommends the one that fixed the code", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "fix add()", check: "node --test",
      agents: [{ adapter: "script", model: BENDER, label: "bender" }, { adapter: "script", model: FIX, label: "fixer" }] });
    await until(() => run.agents.every((a) => FINISHED.includes(a.status)));
    const bender = run.agents.find((a) => a.label === "bender")!;
    const fixer = run.agents.find((a) => a.label === "fixer")!;
    expect(bender.check.status).toBe("passed");
    expect(bender.diff.testsTouched).toEqual(["math.test.js"]);
    expect(fixer.diff.testsTouched).toEqual([]);
    expect(m.get(run.id)!.review.agentId).toBe(fixer.id);
    const pf = await m.preflight(run.id, bender.id);
    expect(pf).toMatchObject({ checkPassed: true, testsTouched: ["math.test.js"], conflicts: false, files: ["math.test.js"] });
    await expect(m.review(run.id, { decision: "reject", reviewer: "lead" })).rejects.toThrow("사유");
    await m.remove(run.id);
  }, 30_000);

  it("sees a conflict when the base moved under the same line", async () => {
    const r = makeRepo();
    const m = new RunManager();
    const run = await m.create({ repo: r, task: "fix add()", check: "node --test", agents: [{ adapter: "script", model: FIX, label: "fixer" }] });
    await until(() => FINISHED.includes(run.agents[0].status));
    writeFileSync(join(r, "math.js"), "export const add = (a, b) => b + a + 0;\n");
    git(r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "someone else");
    expect((await m.preflight(run.id, run.agents[0].id)).conflicts).toBe(true);
    await m.remove(run.id);
  }, 30_000);
});

describe("preview and terminal", () => {
  it("starts the dev server in the agent worktree on a free port and stops it", async () => {
    const m = new RunManager({ preview: `node -e "require('http').createServer((q,r)=>r.end(require('fs').readFileSync('math.js','utf8'))).listen({port})"` });
    const run = await m.create({ repo, task: "fix add()", agents: [{ adapter: "script", model: FIX, label: "fixer" }] });
    const a = run.agents[0];
    await until(() => FINISHED.includes(a.status));
    const p = await m.startPreview(run.id, a.id);
    expect(p.status).toBe("ready");
    const body = await (await fetch(`http://127.0.0.1:${p.port}`)).text();
    expect(body).toContain("a + b");   // served from the agent's worktree, not the base checkout
    m.stopPreview(run.id, a.id);
    await until(() => a.preview!.status === "stopped");
    await m.remove(run.id);
  }, 30_000);

  it("refuses a preview when no command is configured", async () => {
    const m = new RunManager();
    const run = await m.create({ repo, task: "noop", agents: [{ adapter: "script", model: FIX }] });
    await until(() => FINISHED.includes(run.agents[0].status));
    await expect(m.startPreview(run.id, run.agents[0].id)).rejects.toThrow("미리보기 명령");
    await m.remove(run.id);
  }, 30_000);

  it("opens a shell in the worktree and keeps scrollback for the next viewer", async () => {
    const terms = new Terminals();
    const cwd = mkdtempSync(join(tmpdir(), "willnew-term-"));
    const t = await terms.get("a1", cwd);
    let out = "";
    const off = t.subscribe((d) => { out += d; }, () => undefined);
    t.backend.write(process.platform === "win32" ? "cd\r" : "pwd\r");
    await until(() => out.includes(cwd.split(/[\\/]/).pop()!), 10_000);
    off();
    expect((await terms.get("a1", cwd)).scrollback).toContain(cwd.split(/[\\/]/).pop()!);
    terms.closeAll();
  }, 20_000);
});

describe("http api", () => {
  it("serves steer, preflight and a live terminal over a websocket", async () => {
    const { serve } = await import("@hono/node-server");
    const { createApp } = await import("../src/server/app.js");
    const { app, injectWebSocket, runs, terminals } = createApp({ repo, check: "node --test" });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    injectWebSocket(server);
    await new Promise((r) => server.once("listening", r));
    const base = `127.0.0.1:${(server.address() as { port: number }).port}`;
    const created = await (await fetch(`http://${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "fix add()", agents: [{ adapter: "script", model: NOTE, label: "note" }] }) })).json();
    const run = runs.get(created.id)!;
    await until(() => FINISHED.includes(run.agents[0].status));
    const aid = run.agents[0].id;
    const pf = await (await fetch(`http://${base}/api/runs/${run.id}/agents/${aid}/preflight`)).json();
    expect(pf).toMatchObject({ checkPassed: true, testsTouched: [], conflicts: false });

    const ws = new WebSocket(`ws://${base}/api/runs/${run.id}/agents/${aid}/terminal`);
    let out = "";
    ws.onmessage = (e) => { out += String(e.data); };
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: "input", data: process.platform === "win32" ? "type math.js\r" : "cat math.js\r" }));
    await until(() => out.includes("a + b"), 10_000);   // the shell runs in the agent's worktree
    ws.close();

    const steer = await fetch(`http://${base}/api/runs/${run.id}/agents/${aid}/steer`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "one more thing", by: "lead" }) });
    expect(steer.ok).toBe(true);
    await until(() => run.agents[0].status === "done" && (run.agents[0].steers?.length ?? 0) === 1 && run.agents[0].summary.includes("one more thing"));
    terminals.closeAll();
    await runs.remove(run.id);
    server.close();
  }, 30_000);
});
