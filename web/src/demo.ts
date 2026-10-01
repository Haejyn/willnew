/**
 * `?demo` — a self-contained fake backend with Korean content: channels with chat history, a live request that
 * willnew triages, works on with two agents (one self-corrects after a failed check), and hands to review;
 * finished requests for the inbox; and team metrics. No server needed.
 */
import type {
  AgentEvent,
  AgentRun,
  Api,
  Channel,
  ChatMessage,
  Metrics,
  Preflight,
  ReviewComment,
  Run,
  RunUpdate,
  Team,
  Template,
  Triage,
} from "./api";
import { applyUpdate } from "./api";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.now();
const REPO = "~/work/billing-api";

const CHANNELS: Channel[] = [
  { id: "backend", name: "backend", team: "platform", repo: REPO, topic: "서비스 백엔드 · 버그·테스트·리팩터링은 @willnew 에게" },
  { id: "data", name: "data", team: "data", repo: "~/work/settlement-batch", topic: "데이터 파이프라인 · 정산 배치" },
  { id: "content-ops", name: "content-ops", team: "content-ops", repo: "~/work/content-tools", topic: "콘텐츠 운영 도구" },
];

const TEAMS: Team[] = [
  { id: "platform", name: "플랫폼", budgetUsd: 50 },
  { id: "data", name: "데이터", budgetUsd: 30 },
  { id: "content-ops", name: "콘텐츠 운영", budgetUsd: 20 },
];

const TEMPLATES: Template[] = [
  { id: "bugfix", name: "버그 수정", keywords: ["버그", "고쳐", "깨져", "실패", "에러"], instruction: "", check: "npm test", estMinutes: 60, agents: [{ adapter: "claude-code", model: "sonnet", label: "claude-sonnet" }, { adapter: "codex", label: "codex" }] },
  { id: "tests", name: "테스트 작성", keywords: ["테스트 작성", "테스트 추가", "커버리지"], instruction: "", check: "npm test", estMinutes: 45, agents: [{ adapter: "claude-code", model: "sonnet", label: "claude-sonnet" }, { adapter: "codex", label: "codex" }] },
  { id: "feature", name: "기능 구현", keywords: ["구현", "추가해", "만들어"], instruction: "", check: "npm test", estMinutes: 120, agents: [{ adapter: "claude-code", model: "opus", label: "claude-opus" }, { adapter: "codex", label: "codex" }] },
  { id: "refactor", name: "리팩터링", keywords: ["리팩터", "정리", "중복"], instruction: "", check: "npm test", estMinutes: 90, agents: [{ adapter: "claude-code", model: "sonnet", label: "claude-sonnet" }, { adapter: "codex", label: "codex" }] },
  { id: "docs", name: "문서화", keywords: ["문서", "주석", "readme"], instruction: "", check: "", estMinutes: 30, agents: [{ adapter: "claude-code", model: "sonnet", label: "claude-sonnet" }] },
];

function routeTemplate(text: string): Template {
  const t = text.toLowerCase();
  let best = TEMPLATES[0];
  let score = 0;
  for (const tpl of TEMPLATES) {
    const s = tpl.keywords.filter((k) => t.includes(k)).length;
    if (s > score) {
      best = tpl;
      score = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------- patches

const PATCH_SONNET = `diff --git a/duration.js b/duration.js
index 5c2e1a0..b81f7d2 100644
--- a/duration.js
+++ b/duration.js
@@ -3,12 +3,24 @@
  * Supports h, m, s units, combined in any order. Returns NaN for invalid input.
  */
 export function parseDuration(text) {
-  const m = /^(\\d+)h$/.exec(text.trim());
-  if (m) return Number(m[1]) * 3600;
-  return NaN;
+  const s = text.replace(/\\s+/g, "");
+  if (!/^(\\d+[hms])+$/.test(s)) return NaN;
+  const unit = { h: 3600, m: 60, s: 1 };
+  let total = 0;
+  for (const [, n, u] of s.matchAll(/(\\d+)([hms])/g)) total += Number(n) * unit[u];
+  return total;
 }

 /** formatDuration(5400) → "1h30m" (omit zero parts, "0s" for zero) */
 export function formatDuration(seconds) {
-  return \`\${Math.floor(seconds / 3600)}h\`;
+  const h = Math.floor(seconds / 3600);
+  const m = Math.floor((seconds % 3600) / 60);
+  const sec = seconds % 60;
+  const out = (h ? \`\${h}h\` : "") + (m ? \`\${m}m\` : "") + (sec ? \`\${sec}s\` : "");
+  return out || "0s";
 }
`;

const PATCH_CODEX = `diff --git a/duration.js b/duration.js
index 5c2e1a0..e03c9a4 100644
--- a/duration.js
+++ b/duration.js
@@ -3,12 +3,27 @@
  * Supports h, m, s units, combined in any order. Returns NaN for invalid input.
  */
 export function parseDuration(text) {
-  const m = /^(\\d+)h$/.exec(text.trim());
-  if (m) return Number(m[1]) * 3600;
-  return NaN;
+  const input = String(text).trim();
+  if (!/^(?:\\d+\\s*[hms]\\s*)+$/.test(input)) return NaN;
+  const factor = { h: 3600, m: 60, s: 1 };
+  let seconds = 0;
+  for (const match of input.matchAll(/(\\d+)\\s*([hms])/g)) {
+    seconds += Number(match[1]) * factor[match[2]];
+  }
+  return seconds;
 }

 /** formatDuration(5400) → "1h30m" (omit zero parts, "0s" for zero) */
 export function formatDuration(seconds) {
-  return \`\${Math.floor(seconds / 3600)}h\`;
+  const parts = [
+    [Math.floor(seconds / 3600), "h"],
+    [Math.floor((seconds % 3600) / 60), "m"],
+    [seconds % 60, "s"],
+  ];
+  const text = parts.filter(([n]) => n > 0).map(([n, u]) => \`\${n}\${u}\`).join("");
+  return text || "0s";
 }
`;

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const diffOf = (patch: string) => {
  let insertions = 0;
  let deletions = 0;
  const fileStats: { path: string; insertions: number; deletions: number }[] = [];
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git")) fileStats.push({ path: /b\/(.+)$/.exec(l)?.[1] ?? "?", insertions: 0, deletions: 0 });
    else if (l.startsWith("+") && !l.startsWith("+++")) { insertions++; fileStats[fileStats.length - 1].insertions++; }
    else if (l.startsWith("-") && !l.startsWith("---")) { deletions++; fileStats[fileStats.length - 1].deletions++; }
  }
  return { files: fileStats.length, insertions, deletions, patch, fileStats, testsTouched: fileStats.map((f) => f.path).filter((p) => TEST_FILE.test(p)) };
};

const PATCH_SETTLE = `diff --git a/settle/dedupe.py b/settle/dedupe.py
new file mode 100644
--- /dev/null
+++ b/settle/dedupe.py
@@ -0,0 +1,9 @@
+def dedupe(rows, key=lambda r: (r["order_id"], r["line"])):
+    """같은 주문 줄이 여러 번 들어오면 마지막 것만 남긴다."""
+    seen = {}
+    for r in rows:
+        seen[key(r)] = r
+    return list(seen.values())
diff --git a/settle/settle_daily.py b/settle/settle_daily.py
--- a/settle/settle_daily.py
+++ b/settle/settle_daily.py
@@ -12,14 +12,7 @@ from .io import load_rows, write_rows
 def settle_daily(day):
     rows = load_rows(day)
-    seen = {}
-    for r in rows:
-        seen[(r["order_id"], r["line"])] = r
-    rows = list(seen.values())
+    rows = dedupe(rows)
     totals = sum_by_merchant(rows)
     write_rows(day, totals)
`;

const CHECK_OK = `> billing-api@2.3.0 test
> node --test

✔ hours (0.61ms)
✔ combined (0.13ms)
✔ seconds and minutes (0.08ms)
✔ any order + spaces (0.58ms)
✔ invalid (0.16ms)
✔ format (0.10ms)
✔ round trip (0.11ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0`;

const CHECK_FAIL = `> billing-api@2.3.0 test
> node --test

✔ hours (0.64ms)
✔ combined (0.14ms)
✔ seconds and minutes (0.09ms)
✔ any order + spaces (0.61ms)
✖ invalid (1.02ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  5 !== NaN
      at duration.test.js:12:34
✔ format (0.10ms)
✔ round trip (0.12ms)
ℹ tests 7
ℹ pass 6
ℹ fail 1`;

// ---------------------------------------------------------------------------------------------- live script

type Kind = AgentEvent["kind"];
interface Step {
  at: number; // ms after the request was created
  agent?: number; // index into run.agents; omitted = run-level step
  ev?: [Kind, string];
  attempt?: number;
  patch?: Partial<AgentRun>;
  tokens?: [number, number, number];
  run?: Partial<Run>;
  chat?: Omit<ChatMessage, "id" | "channel" | "ts" | "runId">;
}

const SONNET_SUMMARY =
  "원인은 `parseDuration` 이 `h` 단위만 처리하던 것이었어요. 공백을 걷어 낸 뒤 `(\\d+[hms])+` 전체를 검증하고 단위별로 합산하도록 고쳤고, `formatDuration` 은 0인 단위를 빼고 이어 붙입니다. 테스트는 건드리지 않았고 7개 모두 통과해요.";
const CODEX_SUMMARY_1 = "parseDuration 과 formatDuration 을 구현했습니다. 단위별 합산, 0 단위 생략.";
const CODEX_SUMMARY_2 =
  "1차 시도에서 `\"5x\"` 가 5로 파싱되던 문제를 고쳤습니다. 입력 전체를 앵커 정규식으로 먼저 검증하고, 통과한 경우에만 단위를 합산합니다. 7개 테스트 모두 통과.";

function liveScript(requester: string): Step[] {
  const S = 0;
  const C = 1;
  return [
    { at: 400, chat: { user: "willnew", bot: true, kind: "ack", text: "접수했어요. 요청을 읽고 계획을 세우는 중이에요." } },
    {
      at: 1800,
      run: {}, // filled in by spawn(): triage + agents
      chat: { user: "willnew", bot: true, kind: "triage", text: "계획을 세웠어요 — 버그 수정 템플릿으로 두 에이전트에게 나눠 맡길게요." },
    },
    { at: 2200, agent: S, ev: ["status", "작업 공간 준비 완료 · willnew/r/claude-sonnet"], patch: { status: "running" } },
    { at: 2300, agent: C, ev: ["status", "작업 공간 준비 완료 · willnew/r/codex"], patch: { status: "running" } },
    { at: 3000, agent: S, ev: ["text", "duration.js 와 테스트부터 볼게요."], tokens: [3100, 120, 9000] },
    { at: 3200, agent: C, ev: ["text", "테스트가 기대하는 형식을 먼저 확인하겠습니다."], tokens: [5200, 90, 4000] },
    { at: 3600, agent: S, ev: ["tool", 'Read {"file_path":"./duration.test.js"}'], tokens: [1800, 60, 12000] },
    { at: 3900, agent: C, ev: ["tool", "shell Get-Content duration.test.js; Get-Content duration.js"], tokens: [2400, 70, 6000] },
    { at: 4000, agent: S, ev: ["tool_result", 'test("hours") · test("combined") · test("invalid") … 7개'] },
    { at: 4200, agent: C, ev: ["tool_result", "exit 0 (2 files, 41 lines)"] },
    { at: 4800, agent: S, ev: ["tool", 'Read {"file_path":"./duration.js"}'], tokens: [1500, 50, 14000] },
    { at: 5200, agent: S, ev: ["tool_result", "18 lines · parseDuration 은 /^(\\d+)h$/ 만 처리"] },
    { at: 6000, agent: C, ev: ["text", "정규식으로 단위를 뽑아 합산하도록 구현합니다."], tokens: [3800, 260, 8000] },
    { at: 6500, agent: S, ev: ["text", "원인 찾았어요: parseDuration 이 `h` 단위만 처리해요. 단위별 합산으로 고칠게요."], tokens: [2600, 310, 15000] },
    { at: 7600, agent: C, ev: ["tool", "edit duration.js"], tokens: [2100, 540, 6000] },
    { at: 8000, agent: S, ev: ["tool", 'Edit {"file_path":"./duration.js"}'], tokens: [2200, 620, 16000] },
    { at: 8200, agent: C, ev: ["tool_result", "exit 0 · 1 file changed"] },
    { at: 8400, agent: S, ev: ["tool_result", "Applied 2 edits"] },
    { at: 9000, agent: C, ev: ["text", CODEX_SUMMARY_1], tokens: [1900, 180, 5000], patch: { summary: CODEX_SUMMARY_1, turns: 1 } },
    { at: 9300, agent: C, ev: ["check", "$ npm test"], patch: { status: "checking" } },
    { at: 9600, agent: S, ev: ["tool", 'Bash {"command":"node --test"}'], tokens: [1600, 40, 17000] },
    {
      at: 10300,
      agent: C,
      ev: ["check", "검증 실패 · 7개 중 1개 (invalid) · exit 1"],
      patch: { status: "retrying", check: { status: "failed", exitCode: 1, output: CHECK_FAIL, durationMs: 980 } },
    },
    { at: 10500, agent: C, attempt: 2, ev: ["plan", "자가 수정 2/2 — 실패한 검증 로그를 붙여 다시 시도"], patch: { attempt: 2, status: "running" } },
    { at: 10600, agent: S, ev: ["tool_result", "✔ 7 passed · 0 failed"] },
    { at: 11200, agent: S, ev: ["text", SONNET_SUMMARY], tokens: [2400, 480, 18000], patch: { summary: SONNET_SUMMARY, turns: 6 } },
    { at: 11500, agent: C, attempt: 2, ev: ["text", "'5x' 같은 입력을 거르지 못했어요. 입력 전체를 먼저 앵커로 검증하도록 고칩니다."], tokens: [6400, 280, 9000] },
    { at: 11600, agent: S, ev: ["check", "$ npm test"], patch: { status: "checking" } },
    {
      at: 12600,
      agent: S,
      ev: ["check", "검증 통과 · 7/7 · exit 0 · 0.4초"],
      patch: { status: "done", check: { status: "passed", exitCode: 0, output: CHECK_OK, durationMs: 420 }, diff: diffOf(PATCH_SONNET) },
    },
    { at: 13000, agent: C, attempt: 2, ev: ["tool", "edit duration.js"], tokens: [2300, 610, 7000] },
    { at: 13500, agent: C, attempt: 2, ev: ["tool_result", "exit 0 · 1 file changed"] },
    { at: 14500, agent: C, attempt: 2, ev: ["tool", "shell node --test"], tokens: [1200, 30, 4000] },
    { at: 15600, agent: C, attempt: 2, ev: ["tool_result", "exit 0 ✔ 7 passed"] },
    { at: 16200, agent: C, attempt: 2, ev: ["text", CODEX_SUMMARY_2], tokens: [1700, 350, 5000], patch: { summary: CODEX_SUMMARY_2, turns: 2 } },
    { at: 16500, agent: C, attempt: 2, ev: ["check", "$ npm test"], patch: { status: "checking" } },
    {
      at: 17700,
      agent: C,
      attempt: 2,
      ev: ["check", "검증 통과 · 7/7 · exit 0 · 0.5초"],
      patch: { status: "done", check: { status: "passed", exitCode: 0, output: CHECK_OK, durationMs: 460 }, diff: diffOf(PATCH_CODEX) },
    },
    {
      at: 18400,
      run: { review: { status: "pending" } },
      chat: {
        user: "willnew",
        bot: true,
        kind: "review",
        text: `두 에이전트 모두 검증을 통과했어요. codex 는 1차 검증 실패 후 스스로 고쳤어요. 더 빠르고 저렴한 claude-sonnet 을 추천해요 — ${requester}님, 검토해 주세요.`,
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------- live engine

interface Live {
  run: Run;
  channel: string;
  steps: Step[];
  cursor: number;
  triage: Triage;
  agentSpecs: AgentRun[];
}

const lives = new Map<string, Live>();
const runListeners = new Map<string, Set<(u: RunUpdate) => void>>();
const chatListeners = new Map<string, Set<(m: ChatMessage) => void>>();
const chat = new Map<string, ChatMessage[]>();
let msgSeq = 0;
let ticker: ReturnType<typeof setInterval> | null = null;

function pushChat(m: ChatMessage) {
  const list = chat.get(m.channel) ?? [];
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m;
  else list.push(m);
  chat.set(m.channel, list);
  for (const fn of chatListeners.get(m.channel) ?? []) fn(m);
}

function emit(live: Live, u: RunUpdate) {
  const next = applyUpdate(live.run, u);
  if (next) live.run = next;
  for (const fn of runListeners.get(live.run.id) ?? []) fn(u);
}

const RATES: Record<string, [number, number] | null> = { "claude-code": [3, 15], codex: null };

function blank(runId: string, i: number, adapter: string, label: string, model: string | undefined, startedAt: number): AgentRun {
  return {
    id: `${runId}-a${i}`,
    adapter,
    label,
    model,
    branch: `willnew/${runId}/${label}`,
    worktree: `~/.willnew/worktrees/${runId}/${label}`,
    status: "queued",
    attempt: 1,
    startedAt,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null },
    summary: "",
    check: { status: "skipped", exitCode: null, output: "" },
    diff: { files: 0, insertions: 0, deletions: 0, patch: "" },
    merged: false,
    events: [],
  };
}

function tickOne(live: Live, now: number) {
  const t = now - live.run.createdAt;
  while (live.cursor < live.steps.length && live.steps[live.cursor].at <= t) {
    const s = live.steps[live.cursor++];
    const ts = live.run.createdAt + s.at;
    if (s.run) {
      const runPatch: Partial<Run> = { ...s.run };
      if (!live.run.triage && s.chat?.kind === "triage") {
        runPatch.triage = live.triage;
        runPatch.agents = live.agentSpecs.map((a) => ({ ...a, startedAt: ts + 300 }));
      }
      if (s.run.review) runPatch.review = { ...live.run.review, ...s.run.review };
      emit(live, { runId: live.run.id, run: runPatch });
    }
    if (s.agent != null) {
      const a = live.run.agents[s.agent];
      if (!a || a.status === "cancelled") continue;
      const patch: Partial<AgentRun> = { ...(s.patch ?? {}) };
      if (s.tokens) {
        const rate = RATES[a.adapter] ?? null;
        const inputTokens = a.usage.inputTokens + s.tokens[0];
        const outputTokens = a.usage.outputTokens + s.tokens[1];
        const cachedTokens = a.usage.cachedTokens + s.tokens[2];
        patch.usage = { inputTokens, outputTokens, cachedTokens, costUsd: rate ? (inputTokens * rate[0] + outputTokens * rate[1] + cachedTokens * 0.3) / 1e6 : null };
        if (s.ev?.[0] === "tool") patch.turns = a.turns + 1;
      }
      if (patch.status === "done") {
        patch.endedAt = ts;
        patch.durationMs = ts - (a.startedAt ?? live.run.createdAt);
      }
      emit(live, {
        runId: live.run.id,
        agentId: a.id,
        event: s.ev ? { ts, kind: s.ev[0], text: s.ev[1], attempt: s.attempt ?? a.attempt ?? 1 } : undefined,
        agent: Object.keys(patch).length ? patch : undefined,
      });
    }
    if (s.chat) pushChat({ ...s.chat, id: `m${++msgSeq}`, channel: live.channel, ts, runId: live.run.id });
  }
}

function tick() {
  const now = Date.now();
  let pending = false;
  for (const live of lives.values()) {
    tickOne(live, now);
    if (live.cursor < live.steps.length) pending = true;
  }
  if (!pending && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function ensureTicker() {
  if (!ticker) ticker = setInterval(tick, 200);
}

let runSeq = 0;
function spawn(channel: string, requester: string, team: string, text: string, ago = 0): Run {
  const createdAt = Date.now() - ago;
  const id = `r-${(createdAt % 1e6).toString(36)}${++runSeq}`;
  const tpl = routeTemplate(text);
  const clean = text.replace(/@willnew\s*/g, "").trim();
  const title = clean.replace(/^[^:：]{1,12}[:：]\s*/, "").slice(0, 60) || clean.slice(0, 60);
  const plan = [
    "실패하는 테스트를 돌려 증상을 재현한다",
    "duration.js 에서 원인을 찾는다 (테스트는 수정 금지)",
    "parseDuration · formatDuration 을 고친다",
    "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다",
    "통과한 결과 중 하나를 골라 요청자 검토를 받는다",
  ];
  const triage: Triage = {
    by: "llm",
    template: tpl.id,
    title,
    task: `${clean}\n\nFind the root cause in duration.js and fix it. Do not modify duration.test.js. Run \`npm test\` to confirm.`,
    plan,
    agents: [
      { adapter: "claude-code", model: "sonnet", label: "claude-sonnet" },
      { adapter: "codex", label: "codex" },
    ],
    check: "npm test",
    reason: "테스트 실패를 고치는 요청 — 버그 수정 템플릿. 테스트가 판정할 수 있어 두 에이전트를 경쟁시키고 1회 자가 수정을 허용.",
    durationMs: 1300,
    costUsd: 0.004,
  };
  const run: Run = {
    id,
    title,
    task: clean,
    repo: CHANNELS.find((c) => c.id === channel)?.repo ?? REPO,
    baseRef: "4d9d4a5",
    baseBranch: "main",
    checkCmd: "npm test",
    createdAt,
    requester,
    team,
    template: tpl.id,
    channel,
    review: { status: "none" },
    maxAttempts: 2,
    agents: [],
  };
  const agentSpecs = [blank(id, 0, "claude-code", "claude-sonnet", "sonnet", createdAt), blank(id, 1, "codex", "codex", undefined, createdAt)];
  const live: Live = { run, channel, steps: liveScript(requester), cursor: 0, triage, agentSpecs };
  lives.set(id, live);
  pushChat({ id: `m${++msgSeq}`, channel, ts: createdAt, user: requester, bot: false, text });
  tickOne(live, Date.now()); // fast-forward steps that are already in the past
  ensureTicker();
  return run;
}

// ---------------------------------------------------------------------------------------------- history

function pastAgent(
  runId: string,
  i: number,
  label: string,
  adapter: string,
  model: string | undefined,
  start: number,
  attempts: { work: number; check: number; passed: boolean }[],
  cost: number | null,
  tokens: number,
  files = 2,
): AgentRun {
  const events: AgentEvent[] = [];
  let t = start;
  attempts.forEach((a, k) => {
    const attempt = k + 1;
    if (attempt > 1) events.push({ ts: t, kind: "plan", text: `자가 수정 ${attempt}/2 — 검증 로그를 붙여 다시 시도`, attempt });
    else events.push({ ts: t, kind: "status", text: "작업 공간 준비 완료", attempt });
    events.push({ ts: t + a.work * 0.3, kind: "tool", text: "Read ./src", attempt });
    events.push({ ts: t + a.work * 0.7, kind: "tool", text: "Edit ./src", attempt });
    t += a.work;
    events.push({ ts: t, kind: "check", text: "$ npm test", attempt });
    t += a.check;
    events.push({ ts: t, kind: "check", text: a.passed ? "검증 통과" : "검증 실패 · exit 1", attempt });
  });
  const last = attempts[attempts.length - 1];
  return {
    id: `${runId}-a${i}`,
    adapter,
    label,
    model,
    branch: `willnew/${runId}/${label}`,
    worktree: "",
    status: "done",
    attempt: attempts.length,
    startedAt: start,
    endedAt: t,
    durationMs: t - start,
    turns: 4 + attempts.length * 3,
    usage: { inputTokens: Math.round(tokens * 0.2), outputTokens: Math.round(tokens * 0.02), cachedTokens: Math.round(tokens * 0.78), costUsd: cost },
    summary: last.passed ? "요청한 변경을 반영했고 검증을 통과했어요." : "검증을 통과하지 못했어요.",
    check: { status: last.passed ? "passed" : "failed", exitCode: last.passed ? 0 : 1, output: last.passed ? CHECK_OK : CHECK_FAIL, durationMs: last.check },
    diff: diffOf(PATCH_SETTLE),
    merged: false,
    events,
  };
}

interface Past {
  id: string;
  ago: number;
  channel: string;
  requester: string;
  team: string;
  template: string;
  title: string;
  text: string;
  review: Run["review"];
  agents: (start: number, id: string) => AgentRun[];
}

const PAST: Past[] = [
  {
    id: "r-8c1",
    ago: 3.2 * HOUR,
    channel: "backend",
    requester: "김민지",
    team: "platform",
    template: "tests",
    title: "주문 API 페이지네이션 경계값 테스트 보강",
    text: "@willnew 테스트 작성: 주문 API 페이지네이션 경계값(빈 페이지, 마지막 페이지) 테스트 좀 보강해 주세요",
    review: { status: "approved", reviewer: "이해준", agentId: "r-8c1-a0", at: 0, comment: "좋아요, 반영합니다" },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, [{ work: 48 * SEC, check: 2 * SEC, passed: true }], 0.19, 210000, 1),
      pastAgent(id, 1, "codex", "codex", undefined, s, [{ work: 61 * SEC, check: 2 * SEC, passed: true }], null, 180000, 1),
    ],
  },
  {
    id: "r-7f4",
    ago: 1.3 * HOUR,
    channel: "data",
    requester: "박서준",
    team: "data",
    template: "refactor",
    title: "정산 배치 중복 제거 로직 정리",
    text: "@willnew 리팩터링: settle_daily 의 중복 제거 로직이 세 군데 복붙돼 있어요. 하나로 정리해 주세요",
    review: { status: "pending" },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, [{ work: 72 * SEC, check: 9 * SEC, passed: false }, { work: 41 * SEC, check: 9 * SEC, passed: true }], 0.41, 390000, 4),
      pastAgent(id, 1, "codex", "codex", undefined, s, [{ work: 95 * SEC, check: 9 * SEC, passed: true }], null, 300000, 3),
    ],
  },
  {
    id: "r-6a2",
    ago: 5.5 * HOUR,
    channel: "content-ops",
    requester: "최유나",
    team: "content-ops",
    template: "docs",
    title: "메타데이터 수집기 README 정리",
    text: "@willnew 문서화: 메타데이터 수집기 README 가 옛날 옵션 기준이에요. 지금 CLI 옵션으로 정리해 주세요",
    review: { status: "approved", reviewer: "최유나", agentId: "r-6a2-a0", at: 0 },
    agents: (s, id) => [pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, [{ work: 38 * SEC, check: 0, passed: true }], 0.08, 90000, 1)],
  },
  {
    id: "r-5d9",
    ago: 1.2 * DAY,
    channel: "backend",
    requester: "정하늘",
    team: "platform",
    template: "bugfix",
    title: "세션 만료 시간이 9시간 어긋나는 버그",
    text: "@willnew 버그 수정: 로그인 세션 만료 시간이 9시간씩 어긋나요",
    review: { status: "rejected", reviewer: "정하늘", comment: "증상만 가렸어요. 서버 타임존 설정이 원인이라 직접 고칠게요.", at: 0 },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, [{ work: 55 * SEC, check: 3 * SEC, passed: true }], 0.22, 240000, 2),
      pastAgent(id, 1, "codex", "codex", undefined, s, [{ work: 70 * SEC, check: 3 * SEC, passed: false }, { work: 52 * SEC, check: 3 * SEC, passed: false }], null, 350000, 2),
    ],
  },
];

function buildPast(p: Past): Run {
  const createdAt = T0 - p.ago;
  const agents = p.agents(createdAt + 2 * SEC, p.id);
  const end = Math.max(...agents.map((a) => a.endedAt ?? 0));
  const tpl = TEMPLATES.find((t) => t.id === p.template)!;
  return {
    id: p.id,
    title: p.title,
    task: p.text.replace(/@willnew\s*/, ""),
    repo: CHANNELS.find((c) => c.id === p.channel)!.repo,
    baseRef: "a1b2c3d",
    baseBranch: "main",
    checkCmd: tpl.check,
    createdAt,
    requester: p.requester,
    team: p.team,
    template: p.template,
    channel: p.channel,
    triage: {
      by: p.template === "docs" ? "rules" : "llm",
      template: p.template,
      title: p.title,
      task: p.text,
      plan: ["관련 코드를 읽고 범위를 정한다", "변경한다", tpl.check ? `${tpl.check} 로 검증한다` : "변경 내용을 요약한다", "요청자 검토를 받는다"],
      agents: tpl.agents,
      check: tpl.check,
      reason: `${tpl.name} 템플릿과 일치`,
      durationMs: p.template === "docs" ? 12 : 1400,
      costUsd: p.template === "docs" ? 0 : 0.004,
    },
    review: p.review.status === "pending" ? p.review : { ...p.review, at: end + 20 * MIN },
    maxAttempts: 2,
    agents,
  };
}

const PAST_RUNS = PAST.map(buildPast);

function seedChat() {
  const add = (channel: string, ts: number, user: string, text: string, extra: Partial<ChatMessage> = {}) =>
    pushChat({ id: `m${++msgSeq}`, channel, ts, user, bot: user === "willnew", text, ...extra });
  const [orders, settle, readme, session] = PAST_RUNS;

  add("backend", session.createdAt - 4 * MIN, "정하늘", "어제부터 세션이 이상하게 빨리 끊긴다는 문의가 들어와요");
  add("backend", session.createdAt, "정하늘", PAST[3].text);
  add("backend", session.createdAt + 2 * SEC, "willnew", "접수했어요. 버그 수정 템플릿으로 두 에이전트에게 맡길게요.", { runId: session.id, kind: "ack" });
  add("backend", session.review.at!, "willnew", "정하늘님이 반려했어요 — “증상만 가렸어요. 서버 타임존 설정이 원인이라 직접 고칠게요.”", { runId: session.id, kind: "result" });
  add("backend", orders.createdAt - 6 * MIN, "김민지", "주문 API 페이지네이션 PR 올리기 전에 테스트를 좀 더 두텁게 하고 싶어요");
  add("backend", orders.createdAt, "김민지", PAST[0].text);
  add("backend", orders.createdAt + 2 * SEC, "willnew", "접수했어요. 테스트 작성 템플릿으로 진행할게요.", { runId: orders.id, kind: "ack" });
  add("backend", orders.review.at!, "willnew", "이해준님이 claude-sonnet 결과를 승인했어요. main 에 반영했어요.", { runId: orders.id, kind: "result" });
  add("backend", T0 - 9 * MIN, "이해준", "배포 전에 duration 쪽 테스트가 계속 빨간색이네요");

  add("data", settle.createdAt - 3 * MIN, "박서준", "정산 배치 코드 보다가 같은 로직이 세 번 나와서요");
  add("data", settle.createdAt, "박서준", PAST[1].text);
  add("data", settle.createdAt + 2 * SEC, "willnew", "접수했어요. 리팩터링 템플릿 — 동작은 그대로, 테스트로 확인할게요.", { runId: settle.id, kind: "ack" });
  add("data", settle.createdAt + 4 * MIN, "willnew", "두 에이전트 모두 검증을 통과했어요(claude-sonnet 은 2차 시도에서). 박서준님, 검토해 주세요.", { runId: settle.id, kind: "review" });

  add("content-ops", readme.createdAt, "최유나", PAST[2].text);
  add("content-ops", readme.createdAt + 2 * SEC, "willnew", "접수했어요. 문서화 템플릿이라 claude-sonnet 한 명이 맡을게요.", { runId: readme.id, kind: "ack" });
  add("content-ops", readme.review.at!, "willnew", "최유나님이 승인했어요. 반영 완료.", { runId: readme.id, kind: "result" });
}

let seeded = false;
function ensureSeed() {
  if (seeded) return;
  seeded = true;
  seedChat();
  spawn("backend", "이해준", "platform", "@willnew 버그 수정: duration 테스트가 깨져요. parseDuration 이 1h30m 같은 입력을 못 읽어요. 고쳐주세요", 13.5 * SEC);
}

// ---------------------------------------------------------------------------------------------- metrics

// 데모 지표는 지어내지 않는다 — README 의 실측(2026-09-30, examples/duration, 요청 3건) 그대로
const METRICS: Metrics = {
  runs: 3,
  totals: { requests: 3, autoResolved: 2, approved: 2, rejected: 1, pendingReview: 0, estHoursSaved: 1.75, costUsd: 0.55 },
  byTeam: {
    platform: { requests: 1, autoResolved: 1, approved: 1, rejected: 0, costUsd: 0.12, budgetUsd: 50, medianLeadMs: 51 * SEC },
    data: { requests: 1, autoResolved: 1, approved: 1, rejected: 0, costUsd: 0.22, budgetUsd: 30, medianLeadMs: 45 * SEC },
    "content-ops": { requests: 1, autoResolved: 0, approved: 0, rejected: 1, costUsd: 0.21, budgetUsd: 20, medianLeadMs: null },
  },
  byTemplate: {
    bugfix: { name: "버그 수정", requests: 1, autoResolvedRate: 1, approvalRate: 1, avgCostUsd: 0.12, estHoursSaved: 1 },
    tests: { name: "테스트 작성", requests: 1, autoResolvedRate: 1, approvalRate: 1, avgCostUsd: 0.22, estHoursSaved: 0.75 },
    docs: { name: "문서화", requests: 1, autoResolvedRate: 0, approvalRate: 0, avgCostUsd: 0.21, estHoursSaved: 0 },
  },
  byAdapter: {
    "claude-code": { agents: 3, done: 3, checkPassed: 2, passRate: 2 / 3, medianDurationMs: 33 * SEC, totalInputTokens: 561_000, totalOutputTokens: 5_900, totalCostUsd: 0.49, avgFilesChanged: 1.3 },
    codex: { agents: 1, done: 1, checkPassed: 1, passRate: 1, medianDurationMs: 45 * SEC, totalInputTokens: 262_000, totalOutputTokens: 2_100, totalCostUsd: 0, avgFilesChanged: 1 },
  },
  timeline: [],
};

// ---------------------------------------------------------------------------------------------- follow-ups, comments, previews

function findRun(runId: string): Run | undefined {
  return lives.get(runId)?.run ?? PAST_RUNS.find((p) => p.id === runId);
}
/** Same as emit() but also for the finished, non-live history runs. */
function emitAny(runId: string, u: RunUpdate) {
  const live = lives.get(runId);
  if (live) return emit(live, u);
  const i = PAST_RUNS.findIndex((p) => p.id === runId);
  if (i < 0) return;
  const next = applyUpdate(PAST_RUNS[i], u);
  if (next) PAST_RUNS[i] = next;
  for (const fn of runListeners.get(runId) ?? []) fn(u);
}

function demoSteer(runId: string, agentId: string, text: string, by: string) {
  const run = findRun(runId);
  const a = run?.agents.find((x) => x.id === agentId);
  if (!run || !a) throw new Error("not found");
  const at = Date.now();
  const wasDone = !["queued", "running", "checking", "retrying"].includes(a.status);
  emitAny(runId, { runId, agentId, event: { ts: at, kind: "steer", text: `${by}: ${text}`, attempt: a.attempt }, agent: { steers: [...(a.steers ?? []), { text, by, at }] } });
  if (!wasDone) return;
  const say = (ms: number, kind: AgentEvent["kind"], t: string, patch?: Partial<AgentRun>, runPatch?: Partial<Run>) =>
    setTimeout(() => {
      emitAny(runId, { runId, agentId, event: { ts: Date.now(), kind, text: t, attempt: a.attempt }, agent: patch });
      if (runPatch) emitAny(runId, { runId, run: runPatch });
    }, ms);
  const startedAt = Date.now() - (a.durationMs ?? 0);
  emitAny(runId, { runId, agentId, event: { ts: Date.now(), kind: "plan", text: "추가 지시로 다시 작업" }, agent: { status: "running", startedAt } });
  emitAny(runId, { runId, run: { review: { status: "none" } } });
  say(1200, "text", `반영할게요 — ${text.split("\n")[0].slice(0, 80)}`);
  say(2200, "tool", 'Edit {"file_path":"./duration.js"}');
  say(2600, "tool_result", "Applied 1 edit");
  say(3200, "check", `$ ${run.checkCmd || "npm test"}`, { status: "checking" });
  say(4400, "check", "검증 통과 · 7/7 · exit 0 · 0.4초", { status: "done", endedAt: Date.now() + 4400, durationMs: (a.durationMs ?? 0) + 4400, summary: `추가 지시를 반영했어요: ${text.split("\n")[0]}` }, { review: { status: "pending" } });
}

// ---------------------------------------------------------------------------------------------- api

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const later = <T,>(v: T, ms = 90) => new Promise<T>((res) => setTimeout(() => res(v), ms));
const allRuns = () => [...[...lives.values()].map((l) => l.run), ...PAST_RUNS].sort((a, b) => b.createdAt - a.createdAt);

export const demoApi: Api = {
  config: () => later({ repo: REPO, check: "npm test", preview: "npm run dev -- --port {port}" }),
  plan: (text) => {
    const tpl = routeTemplate(text);
    return later({ by: "rules" as const, template: tpl.id, title: text.slice(0, 40), task: text, plan: [], agents: tpl.agents, check: tpl.check, reason: "" }, 60);
  },
  async remove(runId) {
    lives.delete(runId);
    const i = PAST_RUNS.findIndex((p) => p.id === runId);
    if (i >= 0) PAST_RUNS.splice(i, 1);
  },
  async steer(runId, agentId, text, by) {
    demoSteer(runId, agentId, text, by);
  },
  async preflight(runId, agentId): Promise<Preflight> {
    const run = findRun(runId);
    const a = run?.agents.find((x) => x.id === agentId);
    if (!run || !a) throw new Error("not found");
    return later({
      checkPassed: a.check.status === "passed",
      checkSkipped: a.check.status === "skipped",
      testsTouched: a.diff.testsTouched ?? [],
      conflicts: false,
      files: (a.diff.fileStats ?? []).map((f) => f.path),
      reviewed: run.reviewed?.[agentId] ?? [],
    }, 250);
  },
  async setReviewed(runId, agentId, file, reviewed) {
    const run = findRun(runId);
    if (!run) return;
    const cur = new Set(run.reviewed?.[agentId] ?? []);
    if (reviewed) cur.add(file);
    else cur.delete(file);
    emitAny(runId, { runId, run: { reviewed: { ...(run.reviewed ?? {}), [agentId]: [...cur] } } });
  },
  async addComment(runId, c) {
    const run = findRun(runId);
    if (!run) throw new Error("not found");
    const comment: ReviewComment = { ...c, id: `c${Date.now().toString(36)}`, at: Date.now() };
    emitAny(runId, { runId, run: { comments: [...(run.comments ?? []), comment] } });
    return comment;
  },
  async deleteComment(runId, cid) {
    const run = findRun(runId);
    if (run) emitAny(runId, { runId, run: { comments: (run.comments ?? []).filter((c) => c.id !== cid) } });
  },
  async sendComments(runId, agentId, by) {
    const run = findRun(runId);
    if (!run) throw new Error("not found");
    const open = (run.comments ?? []).filter((c) => c.agentId === agentId && !c.sentAt);
    if (!open.length) throw new Error("보낼 댓글이 없습니다");
    emitAny(runId, { runId, run: { comments: (run.comments ?? []).map((c) => (open.includes(c) ? { ...c, sentAt: Date.now() } : c)) } });
    demoSteer(runId, agentId, `Review comments:\n${open.map((c) => `${c.file}:${c.line} — ${c.text}`).join("\n")}`, by);
  },
  async startPreview(runId, agentId) {
    const run = findRun(runId);
    const a = run?.agents.find((x) => x.id === agentId);
    if (!run || !a) throw new Error("not found");
    const port = 5173 + run.agents.indexOf(a);
    const preview = { status: "starting" as const, port, log: `$ npm run dev -- --port ${port}\n\n  VITE v8.3.1  ready in 412 ms\n  ➜  Local:   http://localhost:${port}/\n`, startedAt: Date.now() };
    emitAny(runId, { runId, agentId, agent: { preview } });
    await later(null, 900);
    const ready = { ...preview, status: "ready" as const };
    emitAny(runId, { runId, agentId, agent: { preview: ready } });
    return ready;
  },
  async stopPreview(runId, agentId) {
    const a = findRun(runId)?.agents.find((x) => x.id === agentId);
    if (a?.preview) emitAny(runId, { runId, agentId, agent: { preview: { ...a.preview, status: "stopped" } } });
  },
  terminalUrl: () => null,
  previewUrl: () => "",
  agents: () =>
    later([
      { id: "claude-code", name: "Claude Code", installed: true },
      { id: "codex", name: "Codex", installed: true },
    ]),
  channels: () => later(clone(CHANNELS)),
  messages: (ch) => {
    ensureSeed();
    return later(clone((chat.get(ch) ?? []).slice().sort((a, b) => a.ts - b.ts)));
  },
  async postMessage(ch, user, text) {
    ensureSeed();
    const team = CHANNELS.find((c) => c.id === ch)?.team ?? "platform";
    if (/@willnew/i.test(text)) {
      spawn(ch, user, team, text);
      const list = chat.get(ch)!;
      return { message: clone(list[list.length - 1]) };
    }
    const message: ChatMessage = { id: `m${++msgSeq}`, channel: ch, ts: Date.now(), user, bot: false, text };
    pushChat(message);
    return { message: clone(message) };
  },
  subscribeChannel(ch, on) {
    ensureSeed();
    const set = chatListeners.get(ch) ?? new Set();
    set.add(on);
    chatListeners.set(ch, set);
    return () => set.delete(on);
  },
  templates: () => later(clone(TEMPLATES)),
  teams: () => later(clone(TEAMS)),
  runs: () => {
    ensureSeed();
    return later(clone(allRuns()));
  },
  run: (id) => {
    ensureSeed();
    const r = lives.get(id)?.run ?? PAST_RUNS.find((p) => p.id === id);
    return r ? later(clone(r)) : Promise.reject(new Error(`요청 ${id} 을 찾을 수 없어요`));
  },
  async review(runId, input) {
    const live = lives.get(runId);
    const run = live?.run ?? PAST_RUNS.find((p) => p.id === runId);
    if (!run) return { ok: false, message: "요청을 찾을 수 없어요" };
    const review = { status: input.decision === "approve" ? "approved" : "rejected", reviewer: input.reviewer, comment: input.comment, agentId: input.agentId, at: Date.now() } as Run["review"];
    const agent = run.agents.find((a) => a.id === input.agentId);
    if (live) {
      emit(live, { runId, run: { review } });
      if (agent && input.decision === "approve") emit(live, { runId, agentId: agent.id, agent: { merged: true } });
    } else {
      run.review = review;
      if (agent && input.decision === "approve") agent.merged = true;
    }
    const text =
      input.decision === "approve"
        ? `${input.reviewer}님이 ${agent?.label ?? "결과"} 를 승인했어요. ${run.baseBranch} 에 반영했어요.`
        : `${input.reviewer}님이 반려했어요${input.comment ? ` — “${input.comment}”` : ""}.`;
    if (run.channel) pushChat({ id: `m${++msgSeq}`, channel: run.channel, ts: Date.now(), user: "willnew", bot: true, text, runId, kind: "result" });
    await later(null, 300);
    return { ok: true, message: input.decision === "approve" ? "승인하고 반영했어요" : "반려했어요" };
  },
  async cancel(runId, agentId) {
    const live = lives.get(runId);
    if (!live) return;
    emit(live, { runId, agentId, event: { ts: Date.now(), kind: "status", text: "사용자가 취소했어요" }, agent: { status: "cancelled", endedAt: Date.now() } });
  },
  metrics: () => {
    ensureSeed();
    const m = clone(METRICS);
    // the four agent runs behind the README measurement (2026-09-30)
    const day = new Date("2026-09-30T06:00:00Z").getTime();
    m.timeline = [
      { runId: "20260930-pig0", createdAt: day, adapter: "claude-code", label: "claude-sonnet", durationMs: 19 * SEC, checkStatus: "passed", costUsd: 0.1, tokens: 133_000 },
      { runId: "20260930-pig0", createdAt: day, adapter: "codex", label: "codex", durationMs: 45 * SEC, checkStatus: "passed", costUsd: null, tokens: 264_000 },
      { runId: "20260930-t4kq", createdAt: day + 40 * MIN, adapter: "claude-code", label: "claude-sonnet", durationMs: 37 * SEC, checkStatus: "passed", costUsd: 0.2, tokens: 228_000 },
      { runId: "20260930-d7zx", createdAt: day + 80 * MIN, adapter: "claude-code", label: "claude-sonnet", durationMs: 33 * SEC, checkStatus: "failed", costUsd: 0.19, tokens: 206_000 },
    ];
    return later(m);
  },
  subscribe(runId, onUpdate, onState) {
    ensureSeed();
    const set = runListeners.get(runId) ?? new Set();
    set.add(onUpdate);
    runListeners.set(runId, set);
    setTimeout(() => onState?.(true), 0);
    return () => set.delete(onUpdate);
  },
};

export const DEMO_CHANNEL = "backend";
