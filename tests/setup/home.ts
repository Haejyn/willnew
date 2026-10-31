/**
 * Runs in every test worker before the test file is imported: willnew's home is a fresh temp dir, so nothing a test
 * loads (runs, requests, chat, members, Slack threads, worktrees) can land in the real ~/.willnew. A test that wants
 * its own home still sets WILLNEW_HOME itself, also to a temp dir. tests/setup/guard.ts checks the real home after the
 * whole run.
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll } from "vitest";

const real = resolve(join(homedir(), ".willnew")).toLowerCase();
process.env.WILLNEW_HOME = mkdtempSync(join(tmpdir(), "willnew-test-home-"));
// a stray API key from the shell must not change how the code under test plans
delete process.env.ANTHROPIC_API_KEY;
// local AI calls go to fake Ollama servers on 127.0.0.1: no resting and no nvidia-smi. Pacing tests inject their own.
process.env.WILLNEW_AI_PACE = "fast";

const check = () => {
  const h = process.env.WILLNEW_HOME;
  if (!h || resolve(h).toLowerCase().startsWith(real)) throw new Error(`테스트의 WILLNEW_HOME 이 실제 홈이에요: ${h ?? "(없음)"}`);
};
beforeAll(check);
afterAll(check);
