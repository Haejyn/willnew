/**
 * `?demo` — a self-contained fake backend, written the way a small team actually uses willnew: five people with
 * their own way of typing, requests in every state (waiting for me, planning, running, verifying, retrying after a
 * line comment, merged, rejected), agent logs / test output / diffs in the formats the real CLIs print, and team
 * metrics computed from those same runs. A few runs are deliberately long-lived so a screenshot taken a minute
 * after opening still shows them mid-flight. No server needed.
 *
 * The cast (all made up):
 *   이해준 platform 리드 · 짧게 쓴다      정하늘 platform 백엔드 · 맥락을 길게
 *   박서윤 data · 숫자와 로그를 붙인다     최민재 platform 프론트 · 반말 섞임
 *   김도윤 content-ops PM · 공손, 결과 위주
 *   윤서아 cs 요청자 · 고객 문의를 옮겨 온다 (개발자는 아니다)
 *
 * 에이전트는 기본 하나(claude-sonnet). 겨루기(둘)는 고르면 되고, 지난 기록 몇 개와 살아 있는 요약 건이 겨루기다.
 * `?demo&as=윤서아` 처럼 열면 그 사람으로 본다. 설정의 "보는 사람" 으로도 바꿀 수 있다(데모 상태는 새로고침하면 사라진다).
 */
import type {
  AgentEvent,
  AgentRun,
  AgentSpec,
  Api,
  Channel,
  ChatMessage,
  Metrics,
  Preflight,
  ReviewComment,
  Run,
  RunUpdate,
  Ship,
  Team,
  Template,
  Triage,
} from "./api";
import { applyUpdate } from "./api";
import { deployedReply, pickReviewer, rejectedReply, reviewMessage } from "../../src/server/handoff";
import { saveUser, suggestWinner as pickWinner, type User } from "./util";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.now();
const sec = (x: number) => Math.round(x * SEC);
const REPO = "~/work/billing-api";

const CHANNELS: Channel[] = [
  { id: "backend", name: "backend", team: "platform", repo: REPO, reviewers: ["이해준", "정하늘"], topic: "결제·청구 서버 · 버그와 리팩터링은 @willnew 에게" },
  { id: "cs", name: "cs-문의", team: "cs", repo: REPO, reviewers: ["이해준"], topic: "고객 문의 중 개발 확인이 필요한 것. @willnew 로 맡기면 백엔드가 검토" },
  { id: "web", name: "web", team: "platform", repo: "~/work/billing-web", reviewers: ["이해준"], topic: "청구 웹 프론트" },
  { id: "data", name: "data", team: "data", repo: "~/work/settlement-batch", reviewers: ["이해준", "박서윤"], topic: "정산 배치 · 데이터 파이프라인" },
  { id: "content-ops", name: "content-ops", team: "content-ops", repo: "~/work/content-tools", reviewers: ["이해준"], topic: "콘텐츠 운영 도구" },
];

const TEAMS: Team[] = [
  { id: "platform", name: "플랫폼", budgetUsd: 50 },
  { id: "data", name: "데이터", budgetUsd: 30 },
  { id: "content-ops", name: "콘텐츠 운영", budgetUsd: 20 },
  { id: "cs", name: "CS", budgetUsd: 10 },
];

const SONNET_SPEC: AgentSpec = { adapter: "claude-code", model: "sonnet", label: "claude-sonnet" };
const CODEX_SPEC: AgentSpec = { adapter: "codex", label: "codex" };
const tpl = (id: string, name: string, keywords: string[], check: string, estMinutes: number): Template => ({ id, name, keywords, instruction: "", check, estMinutes, agents: [SONNET_SPEC] });
const TEMPLATES: Template[] = [
  tpl("bugfix", "버그 수정", ["버그", "고쳐", "깨져", "깨짐", "실패", "에러", "안 돼", "500", "잡혀", "확인 부탁"], "npm test", 60),
  tpl("tests", "테스트 작성", ["테스트 작성", "테스트 추가", "커버리지"], "npm test", 45),
  tpl("feature", "기능 구현", ["구현", "추가해", "추가하", "만들어", "내려주"], "npm test", 120),
  tpl("refactor", "리팩터링", ["리팩터", "정리", "중복", "합쳐", "빼주"], "npm test", 90),
  tpl("docs", "문서화", ["문서", "주석", "readme"], "", 30),
];

/** 데모에 나오는 사람들. 역할은 스스로 고른 값이고 권한을 막지는 않는다. */
const PEOPLE: Record<string, User> = {
  이해준: { name: "이해준", team: "platform", role: "dev", title: "백엔드", avatar: "/demo/avatars/dev.png" },
  정하늘: { name: "정하늘", team: "platform", role: "dev", title: "백엔드" },
  박서윤: { name: "박서윤", team: "data", role: "dev", title: "데이터" },
  최민재: { name: "최민재", team: "platform", role: "dev", title: "프론트" },
  김도윤: { name: "김도윤", team: "content-ops", role: "requester", title: "PM" },
  윤서아: { name: "윤서아", team: "cs", role: "requester", title: "CS", avatar: "/demo/avatars/cs.png" },
};
/** 설정에서 바꿔 볼 수 있는 두 사람 */
export const DEMO_CAST: Record<string, User> = { 윤서아: PEOPLE.윤서아, 이해준: PEOPLE.이해준 };
const titleOf = (name: string) => PEOPLE[name]?.title;
const avatarOf = (name: string) => PEOPLE[name]?.avatar;

/** `?demo&as=윤서아`: 그 사람으로 시작하고 이 브라우저에 저장한다. 저장된 사람이 없으면 이해준. */
export function demoStartUser(): User | null {
  const as = new URLSearchParams(window.location.search).get("as");
  if (as && PEOPLE[as]) {
    saveUser(PEOPLE[as]);
    return PEOPLE[as];
  }
  try {
    if (!localStorage.getItem("willnew.user")) return PEOPLE.이해준;
  } catch {
    return PEOPLE.이해준;
  }
  return null; // App falls back to the stored user
}

/** 고객 문의를 옮겨 온 요청. 합성 예시이고 실제 고객 정보는 없다. */
export const DEMO_REQUEST = "@willnew 고객 문의 들어왔어요. 1/31에 가입한 고객 다음 결제일이 3/3으로 잡혀 있대요. 2월은 말일(2/28)에 나가고 3월엔 다시 31일이어야 하는 거 맞죠? 확인 부탁드려요 #431";

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

const planLine = (name: string, agents: AgentSpec[], check: string) =>
  `계획: ${name} · ${agents.length > 1 ? `겨루기 ${agents.length}개 (${agents.map((a) => a.label?.replace("claude-", "")).join(", ")})` : `에이전트 1개 (${agents[0]?.label?.replace("claude-", "")})`}${check ? ` · ${check}` : ""}`;
const REVIEW_STEP_PLAN = "통과한 결과 중 하나를 골라 요청자 검토를 받는다";
const REVIEW_STEP_SOLO = "통과하면 담당 개발자의 검토를 받는다";

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

const PKG_HUNK = `diff --git a/package.json b/package.json
index 41c09d2..7e83a55 100644
--- a/package.json
+++ b/package.json
@@ -14,4 +14,5 @@
   "dependencies": {
     "date-fns": "^3.6.0",
+    "date-fns-tz": "^3.1.3",
     "express": "^4.19.1",
`;

const PATCH_RENEWAL_S = `diff --git a/src/billing/renewal.js b/src/billing/renewal.js
index 8a41c07..2fd93be 100644
--- a/src/billing/renewal.js
+++ b/src/billing/renewal.js
@@ -1,9 +1,12 @@
-/** 다음 결제일: 직전 결제일에 한 달을 더한다 */
-export function nextBillingDate(sub) {
-  const d = new Date(sub.currentPeriodEnd);
-  d.setMonth(d.getMonth() + 1);
-  return d;
-}
+import { addMonths } from "date-fns";
+import { fromZonedTime, toZonedTime } from "date-fns-tz";
+import { BILLING_TZ } from "../config.js"; // "Asia/Seoul"
+
+/** 다음 결제일: 가입 시점(anchorAt)에서 n개월 뒤. 짧은 달은 말일, 그다음 달은 다시 가입일 */
+export function nextBillingDate(sub) {
+  const anchor = toZonedTime(sub.anchorAt, BILLING_TZ);
+  return fromZonedTime(addMonths(anchor, sub.periodsBilled + 1), BILLING_TZ);
+}

 /** 체험 종료일: 가입 후 14일 */
 export function trialEnd(sub) {
${PKG_HUNK}`;

/** sonnet after the line comment: uses lib/time.js instead of date-fns-tz, package.json untouched. */
const PATCH_RENEWAL_S2 = `diff --git a/src/billing/renewal.js b/src/billing/renewal.js
index 8a41c07..5d70e1b 100644
--- a/src/billing/renewal.js
+++ b/src/billing/renewal.js
@@ -1,9 +1,10 @@
-/** 다음 결제일: 직전 결제일에 한 달을 더한다 */
-export function nextBillingDate(sub) {
-  const d = new Date(sub.currentPeriodEnd);
-  d.setMonth(d.getMonth() + 1);
-  return d;
-}
+import { addMonths } from "date-fns";
+import { fromKst, toKst } from "../lib/time.js";
+
+/** 다음 결제일: 가입 시점(anchorAt)에서 n개월 뒤. 짧은 달은 말일, 그다음 달은 다시 가입일 */
+export function nextBillingDate(sub) {
+  return fromKst(addMonths(toKst(sub.anchorAt), sub.periodsBilled + 1));
+}

 /** 체험 종료일: 가입 후 14일 */
 export function trialEnd(sub) {
`;

/** codex, first attempt: adds one month to the previous period end and clamps by hand, so it sticks to the 28th after February. */
const PATCH_RENEWAL_C1 = `diff --git a/src/billing/renewal.js b/src/billing/renewal.js
index 8a41c07..b3e5d60 100644
--- a/src/billing/renewal.js
+++ b/src/billing/renewal.js
@@ -1,9 +1,11 @@
-/** 다음 결제일: 직전 결제일에 한 달을 더한다 */
-export function nextBillingDate(sub) {
-  const d = new Date(sub.currentPeriodEnd);
-  d.setMonth(d.getMonth() + 1);
-  return d;
-}
+/** 다음 결제일: 직전 결제일 + 1개월, 짧은 달은 말일로 */
+export function nextBillingDate(sub) {
+  const cur = new Date(sub.currentPeriodEnd);
+  const last = new Date(cur.getFullYear(), cur.getMonth() + 2, 0).getDate();
+  const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1, cur.getHours(), cur.getMinutes());
+  next.setDate(Math.min(cur.getDate(), last));
+  return next;
+}

 /** 체험 종료일: 가입 후 14일 */
 export function trialEnd(sub) {
`;

const PATCH_RENEWAL_C = `diff --git a/src/billing/renewal.js b/src/billing/renewal.js
index 8a41c07..c19a7f4 100644
--- a/src/billing/renewal.js
+++ b/src/billing/renewal.js
@@ -1,9 +1,12 @@
-/** 다음 결제일: 직전 결제일에 한 달을 더한다 */
-export function nextBillingDate(sub) {
-  const d = new Date(sub.currentPeriodEnd);
-  d.setMonth(d.getMonth() + 1);
-  return d;
-}
+import { addMonths } from "date-fns";
+import { fromZonedTime, toZonedTime } from "date-fns-tz";
+import { BILLING_TZ } from "../config.js";
+
+/** 다음 결제일: 가입 시점 anchorAt 기준 n개월 뒤 (BILLING_TZ) */
+export function nextBillingDate(sub) {
+  const base = toZonedTime(sub.anchorAt, BILLING_TZ);
+  return fromZonedTime(addMonths(base, sub.periodsBilled + 1), BILLING_TZ);
+}

 /** 체험 종료일: 가입 후 14일 */
 export function trialEnd(sub) {
${PKG_HUNK}`;

/** settlement-batch: dedupe in three places → one helper. The tests imported a private helper, so the agent edited a test. */
const PATCH_SETTLE_S = `diff --git a/settle/dedupe.py b/settle/dedupe.py
new file mode 100644
index 0000000..2f6c1d4
--- /dev/null
+++ b/settle/dedupe.py
@@ -0,0 +1,9 @@
+from typing import Callable, Iterable
+
+
+def dedupe(rows: Iterable[dict], key: Callable[[dict], tuple] = lambda r: (r["order_id"], r["line"])) -> list[dict]:
+    """같은 주문 줄이 여러 번 들어오면 마지막 것만 남긴다."""
+    seen: dict[tuple, dict] = {}
+    for r in rows:
+        seen[key(r)] = r
+    return list(seen.values())
diff --git a/settle/settle_daily.py b/settle/settle_daily.py
index 4b8e1f2..a03c9d7 100644
--- a/settle/settle_daily.py
+++ b/settle/settle_daily.py
@@ -1,5 +1,6 @@
 from .io import load_rows, write_rows
+from .dedupe import dedupe
 from .totals import sum_by_merchant
@@ -12,10 +13,7 @@ def settle_daily(day):
     rows = load_rows(day)
-    seen = {}
-    for r in rows:
-        seen[(r["order_id"], r["line"])] = r
-    rows = list(seen.values())
+    rows = dedupe(rows)
     totals = sum_by_merchant(rows)
     write_rows(day, totals)
diff --git a/settle/settle_weekly.py b/settle/settle_weekly.py
index 8d21c07..1be45a9 100644
--- a/settle/settle_weekly.py
+++ b/settle/settle_weekly.py
@@ -1,13 +1,8 @@
 from .io import load_range, write_rows
+from .dedupe import dedupe
 from .totals import sum_by_merchant
-
-
-def _dedupe_rows(rows):
-    seen = {}
-    for r in rows:
-        seen[(r["order_id"], r["line"])] = r
-    return list(seen.values())
@@ -22,5 +17,5 @@ def settle_weekly(start, end):
-    rows = _dedupe_rows(load_range(start, end))
+    rows = dedupe(load_range(start, end))
     write_rows(start, sum_by_merchant(rows))
diff --git a/settle/reprocess.py b/settle/reprocess.py
index c7f3a21..60d9e8b 100644
--- a/settle/reprocess.py
+++ b/settle/reprocess.py
@@ -9,9 +9,6 @@ def reprocess(day, order_ids):
     rows = [r for r in load_rows(day) if r["order_id"] in order_ids]
-    seen = {}
-    for r in rows:
-        seen[(r["order_id"], r["line"])] = r
-    rows = list(seen.values())
+    rows = dedupe(rows)
     return rows
diff --git a/tests/test_settle.py b/tests/test_settle.py
index e19a4d0..37c8b5f 100644
--- a/tests/test_settle.py
+++ b/tests/test_settle.py
@@ -82,7 +82,7 @@ def test_weekly_rollup_dedupe():
     rows = [make_row("A1", 1), make_row("A1", 1), make_row("A2", 1)]
-    from settle.settle_weekly import _dedupe_rows
+    from settle.dedupe import dedupe
-    assert len(_dedupe_rows(rows)) == 2
+    assert len(dedupe(rows)) == 2
`;

const PATCH_SETTLE_C = `diff --git a/settle/dedupe.py b/settle/dedupe.py
new file mode 100644
index 0000000..9a1e7b3
--- /dev/null
+++ b/settle/dedupe.py
@@ -0,0 +1,7 @@
+def dedupe(rows):
+    """order_id 기준으로 마지막 행만 남긴다."""
+    seen = {}
+    for r in rows:
+        seen[r["order_id"]] = r
+    return list(seen.values())
diff --git a/settle/settle_daily.py b/settle/settle_daily.py
index 4b8e1f2..c52d0e8 100644
--- a/settle/settle_daily.py
+++ b/settle/settle_daily.py
@@ -12,10 +12,7 @@ def settle_daily(day):
     rows = load_rows(day)
-    seen = {}
-    for r in rows:
-        seen[(r["order_id"], r["line"])] = r
-    rows = list(seen.values())
+    rows = dedupe(rows)
     totals = sum_by_merchant(rows)
     write_rows(day, totals)
diff --git a/settle/settle_weekly.py b/settle/settle_weekly.py
index 8d21c07..f04a6d2 100644
--- a/settle/settle_weekly.py
+++ b/settle/settle_weekly.py
@@ -4,10 +4,6 @@ from .totals import sum_by_merchant
-def _dedupe_rows(rows):
-    seen = {}
-    for r in rows:
-        seen[(r["order_id"], r["line"])] = r
-    return list(seen.values())


 def settle_weekly(start, end):
-    rows = _dedupe_rows(load_range(start, end))
+    rows = dedupe(load_range(start, end))
`;

/** billing-web: the infinite list requested page 2 twice (StrictMode double effect + observer callback). Both attempts missed. */
const PATCH_SCROLL_S = `diff --git a/src/hooks/useInfiniteList.ts b/src/hooks/useInfiniteList.ts
index 3f0a8c1..b6d92e4 100644
--- a/src/hooks/useInfiniteList.ts
+++ b/src/hooks/useInfiniteList.ts
@@ -14,14 +14,19 @@ export function useInfiniteList<T>(fetchPage: (page: number) => Promise<T[]>) {
   const [items, setItems] = useState<T[]>([]);
   const [page, setPage] = useState(1);
-  const [loading, setLoading] = useState(false);
+  const loading = useRef(false);
   const sentinel = useRef<HTMLDivElement | null>(null);

   const loadMore = useCallback(async () => {
-    if (loading) return;
-    setLoading(true);
-    const next = await fetchPage(page);
-    setItems((prev) => [...prev, ...next]);
-    setPage((p) => p + 1);
-    setLoading(false);
-  }, [fetchPage, page, loading]);
+    if (loading.current) return;
+    loading.current = true;
+    try {
+      const next = await fetchPage(page);
+      setItems((prev) => [...prev, ...next]);
+      setPage((p) => p + 1);
+    } finally {
+      loading.current = false;
+    }
+  }, [fetchPage, page]);
`;

const PATCH_SCROLL_C = `diff --git a/src/hooks/useInfiniteList.ts b/src/hooks/useInfiniteList.ts
index 3f0a8c1..0d7e5a2 100644
--- a/src/hooks/useInfiniteList.ts
+++ b/src/hooks/useInfiniteList.ts
@@ -12,6 +12,7 @@ export function useInfiniteList<T>(fetchPage: (page: number) => Promise<T[]>) {
 export function useInfiniteList<T>(fetchPage: (page: number) => Promise<T[]>) {
   const [items, setItems] = useState<T[]>([]);
   const [page, setPage] = useState(1);
+  const requested = useRef(new Set<number>());
   const [loading, setLoading] = useState(false);
@@ -18,6 +19,8 @@ export function useInfiniteList<T>(fetchPage: (page: number) => Promise<T[]>) {
   const loadMore = useCallback(async () => {
     if (loading) return;
+    if (requested.current.has(page)) return;
+    requested.current.add(page);
     setLoading(true);
     const next = await fetchPage(page);
`;

/** billing-api webhook: unique key on processed events + INSERT first. */
const PATCH_WEBHOOK_S = `diff --git a/migrations/0014_processed_events_unique.sql b/migrations/0014_processed_events_unique.sql
new file mode 100644
index 0000000..a41c9f0
--- /dev/null
+++ b/migrations/0014_processed_events_unique.sql
@@ -0,0 +1,3 @@
+ALTER TABLE processed_events
+  ADD CONSTRAINT processed_events_event_id_key UNIQUE (event_id);
diff --git a/src/payments/webhook.js b/src/payments/webhook.js
index 6e2b7d3..f9a01c5 100644
--- a/src/payments/webhook.js
+++ b/src/payments/webhook.js
@@ -28,16 +28,19 @@ export async function handleWebhook(req, res) {
   const event = verifySignature(req);
-  const seen = await db.get("SELECT 1 FROM processed_events WHERE event_id = ?", [event.id]);
-  if (seen) return res.status(200).json({ duplicate: true });
-
-  await dispatch(event);
-  await db.run("INSERT INTO processed_events (event_id, received_at) VALUES (?, ?)", [event.id, Date.now()]);
+  const claimed = await db.run(
+    "INSERT INTO processed_events (event_id, received_at) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING",
+    [event.id, Date.now()],
+  );
+  if (claimed.changes === 0) return res.status(200).json({ duplicate: true });
+
+  try {
+    await dispatch(event);
+  } catch (err) {
+    await db.run("DELETE FROM processed_events WHERE event_id = ?", [event.id]);
+    throw err;
+  }
   return res.status(200).json({ ok: true });
 }
`;

const PATCH_WEBHOOK_C = `diff --git a/src/payments/webhook.js b/src/payments/webhook.js
index 6e2b7d3..2c8d1ba 100644
--- a/src/payments/webhook.js
+++ b/src/payments/webhook.js
@@ -1,5 +1,6 @@
 import { db } from "../db.js";
 import { dispatch } from "./dispatch.js";
+import { withEventLock } from "./locks.js";
 import { verifySignature } from "./signature.js";
@@ -28,10 +29,12 @@ export async function handleWebhook(req, res) {
   const event = verifySignature(req);
-  const seen = await db.get("SELECT 1 FROM processed_events WHERE event_id = ?", [event.id]);
-  if (seen) return res.status(200).json({ duplicate: true });
-
-  await dispatch(event);
-  await db.run("INSERT INTO processed_events (event_id, received_at) VALUES (?, ?)", [event.id, Date.now()]);
-  return res.status(200).json({ ok: true });
+  return withEventLock(event.id, async () => {
+    const seen = await db.get("SELECT 1 FROM processed_events WHERE event_id = ?", [event.id]);
+    if (seen) return res.status(200).json({ duplicate: true });
+    await dispatch(event);
+    await db.run("INSERT INTO processed_events (event_id, received_at) VALUES (?, ?)", [event.id, Date.now()]);
+    return res.status(200).json({ ok: true });
+  });
 }
diff --git a/src/payments/locks.js b/src/payments/locks.js
new file mode 100644
index 0000000..d03f7a1
--- /dev/null
+++ b/src/payments/locks.js
@@ -0,0 +1,10 @@
+const tails = new Map();
+
+/** 같은 key 의 작업을 한 줄로 세운다 (프로세스 안에서만). */
+export function withEventLock(key, fn) {
+  const prev = tails.get(key) ?? Promise.resolve();
+  const run = prev.then(fn, fn);
+  tails.set(key, run.finally(() => tails.get(key) === run && tails.delete(key)));
+  return run;
+}
`;

/** content-tools: CSV export read publishAt, the v2 API renamed it scheduledAt. */
const PATCH_CSV_S = `diff --git a/src/export/csv.js b/src/export/csv.js
index b2a7e90..4d1f6c3 100644
--- a/src/export/csv.js
+++ b/src/export/csv.js
@@ -9,7 +9,7 @@ const COLUMNS = [
   { header: "제목", get: (p) => p.title },
   { header: "담당자", get: (p) => p.owner?.name ?? "" },
-  { header: "게시 예정일", get: (p) => formatDate(p.publishAt) },
+  { header: "게시 예정일", get: (p) => formatDate(p.scheduledAt) },
   { header: "상태", get: (p) => STATUS_KO[p.status] ?? p.status },
 ];
`;

const PATCH_CSV_C = `diff --git a/src/export/csv.js b/src/export/csv.js
index b2a7e90..e8c40a5 100644
--- a/src/export/csv.js
+++ b/src/export/csv.js
@@ -9,7 +9,7 @@ const COLUMNS = [
   { header: "제목", get: (p) => p.title },
   { header: "담당자", get: (p) => p.owner?.name ?? "" },
-  { header: "게시 예정일", get: (p) => formatDate(p.publishAt) },
+  { header: "게시 예정일", get: (p) => formatDate(p.scheduledAt ?? p.publishAt) },
   { header: "상태", get: (p) => STATUS_KO[p.status] ?? p.status },
 ];
diff --git a/src/export/format.js b/src/export/format.js
index 91c07d2..5fa3be1 100644
--- a/src/export/format.js
+++ b/src/export/format.js
@@ -2,5 +2,6 @@
 export function formatDate(value) {
+  if (value == null || value === "") return "";
   const d = new Date(value);
   return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
 }
`;

/** billing-api: /invoices/summary grows maxAmount and avgAmount. First pass crashed on an empty list; reviewer commented on line 24. */
const PATCH_SUMMARY_1 = `diff --git a/src/invoices/summary.js b/src/invoices/summary.js
index 91be0c3..d52a7f0 100644
--- a/src/invoices/summary.js
+++ b/src/invoices/summary.js
@@ -21,5 +21,9 @@ import { sumBy } from "../lib/math.js";
 export function summarize(items) {
   const total = sumBy(items, (it) => it.amount);
-  return { total, count: items.length };
+  // 고객별 최대/평균
+  const maxAmount = items.reduce((m, it) => (it.amount > m.amount ? it : m)).amount;
+  const avgAmount = Math.round(total / items.length);
+  return { total, count: items.length, maxAmount, avgAmount };
 }
`;

const PATCH_SUMMARY_2 = `diff --git a/src/invoices/summary.js b/src/invoices/summary.js
index 91be0c3..7a4e2f8 100644
--- a/src/invoices/summary.js
+++ b/src/invoices/summary.js
@@ -21,5 +21,10 @@ import { sumBy } from "../lib/math.js";
 export function summarize(items) {
   const total = sumBy(items, (it) => it.amount);
-  return { total, count: items.length };
+  if (items.length === 0) return { total: 0, count: 0, maxAmount: 0, avgAmount: 0 };
+  // 고객별 최대/평균
+  const maxAmount = items.reduce((m, it) => Math.max(m, it.amount), 0);
+  const avgAmount = Math.round(total / items.length);
+  return { total, count: items.length, maxAmount, avgAmount };
 }
`;

const PATCH_SUMMARY_C = `diff --git a/src/invoices/summary.js b/src/invoices/summary.js
index 91be0c3..c1d0b46 100644
--- a/src/invoices/summary.js
+++ b/src/invoices/summary.js
@@ -21,5 +21,8 @@ import { sumBy } from "../lib/math.js";
 export function summarize(items) {
   const total = sumBy(items, (it) => it.amount);
-  return { total, count: items.length };
+  const amounts = items.map((it) => it.amount);
+  const maxAmount = amounts.length ? Math.max(...amounts) : 0;
+  const avgAmount = amounts.length ? Math.round(total / amounts.length) : 0;
+  return { total, count: items.length, maxAmount, avgAmount };
 }
`;

const PATCH_ORDERS_S = `diff --git a/src/orders/list.js b/src/orders/list.js
index 7a3d9e1..c40b2f8 100644
--- a/src/orders/list.js
+++ b/src/orders/list.js
@@ -9,12 +9,13 @@ const MAX_LIMIT = 100;
 export async function listOrders(db, { page = 1, limit = 20 } = {}) {
-  const size = Math.min(limit, MAX_LIMIT);
-  const offset = (page - 1) * size;
+  const size = Math.min(Math.max(Number(limit) || 0, 1), MAX_LIMIT);
+  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
   const rows = await db.all("SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?", [size, offset]);
-  const total = rows[0].total;
+  const [{ total }] = await db.all("SELECT COUNT(*) AS total FROM orders");
   return {
     items: rows,
     page,
-    lastPage: Math.ceil(total / size),
+    lastPage: Math.max(Math.ceil(total / size), 1),
   };
 }
`;

const PATCH_ORDERS_C = `diff --git a/src/orders/list.js b/src/orders/list.js
index 7a3d9e1..58be0d4 100644
--- a/src/orders/list.js
+++ b/src/orders/list.js
@@ -9,12 +9,14 @@ const MAX_LIMIT = 100;
 export async function listOrders(db, { page = 1, limit = 20 } = {}) {
-  const size = Math.min(limit, MAX_LIMIT);
+  const size = Math.min(limit > 0 ? limit : 20, MAX_LIMIT);
   const offset = (page - 1) * size;
   const rows = await db.all("SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?", [size, offset]);
-  const total = rows[0].total;
+  const row = await db.get("SELECT COUNT(*) AS total FROM orders");
+  const total = row ? row.total : 0;
   return {
     items: rows,
     page,
-    lastPage: Math.ceil(total / size),
+    lastPage: Math.max(1, Math.ceil(total / size)),
   };
 }
`;

const PATCH_README = `diff --git a/README.md b/README.md
index 0c91ae4..b7d3f26 100644
--- a/README.md
+++ b/README.md
@@ -18,13 +18,15 @@ pip install -e .
 ## 사용법

-    metacollect --src ./data --out ./out --fmt json
+    metacollect run ./data --output ./out --format json

 | 옵션 | 설명 | 기본값 |
 | --- | --- | --- |
-| --src | 수집할 폴더 | . |
-| --out | 결과 폴더 | ./out |
-| --fmt | json 또는 csv | json |
-| --workers | 병렬 개수 | 4 |
+| --output, -o | 결과 폴더 | ./out |
+| --format, -f | json, csv, parquet 중 하나 | json |
+| --jobs, -j | 병렬 개수 (0 이면 CPU 코어 수) | 0 |
+| --since | 이 날짜 이후 수정된 파일만 (YYYY-MM-DD) | 없음 |
+| --dry-run | 파일을 쓰지 않고 대상 목록만 출력 | 꺼짐 |
`;

const PATCH_BUTTON = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index e4a09b7..2d6f1c8 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,12 +1,14 @@
 import type { ButtonHTMLAttributes } from "react";

+export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
+
 interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
-  variant?: string;
+  variant?: ButtonVariant;
 }

-export function Button({ variant = "primary", ...rest }: Props) {
+export function Button({ variant = "primary", className = "", ...rest }: Props) {
-  return <button className={"btn btn-" + variant} {...rest} />;
+  return <button className={"btn btn-" + variant + " " + className} {...rest} />;
 }
diff --git a/src/pages/InvoiceDetail.tsx b/src/pages/InvoiceDetail.tsx
index 5b3c8e0..a90d1f4 100644
--- a/src/pages/InvoiceDetail.tsx
+++ b/src/pages/InvoiceDetail.tsx
@@ -41,7 +41,7 @@ export function InvoiceDetail({ invoice }: Props) {
-      <Button variant="danger-outline" onClick={onVoid}>
+      <Button variant="danger" onClick={onVoid}>
         청구 취소
       </Button>
`;

const PATCH_SESSION = `diff --git a/src/auth/session.js b/src/auth/session.js
index 2b6e4d9..f31a7c0 100644
--- a/src/auth/session.js
+++ b/src/auth/session.js
@@ -17,7 +17,8 @@ export function createSession(userId, now = new Date()) {
   const ttlMs = SESSION_TTL_HOURS * 3600 * 1000;
-  const expiresAt = new Date(now.getTime() + ttlMs);
+  // 서버 시간대 차이만큼 보정
+  const expiresAt = new Date(now.getTime() + ttlMs + 9 * 3600 * 1000);
   return { id: randomId(), userId, expiresAt: expiresAt.toISOString() };
 }
`;

const PATCH_SESSION_C = `diff --git a/src/auth/session.js b/src/auth/session.js
index 2b6e4d9..8e0c5a3 100644
--- a/src/auth/session.js
+++ b/src/auth/session.js
@@ -17,7 +17,7 @@ export function createSession(userId, now = new Date()) {
   const ttlMs = SESSION_TTL_HOURS * 3600 * 1000;
-  const expiresAt = new Date(now.getTime() + ttlMs);
+  const expiresAt = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()) + ttlMs);
   return { id: randomId(), userId, expiresAt: expiresAt.toISOString() };
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

// ---------------------------------------------------------------------------------------------- check output (npm / node --test / vitest / pytest)

/** `node --test` as npm prints it. */
function nodeOut(pkg: string, tests: [string, string][], fail?: { i: number; at: string; err: string[] }, ms = "58.4"): string {
  const n = tests.length;
  const lines = tests.map(([name, t], i) => `${fail?.i === i ? "✖" : "✔"} ${name} (${t}ms)`);
  const tail = [`ℹ tests ${n}`, "ℹ suites 0", `ℹ pass ${n - (fail ? 1 : 0)}`, `ℹ fail ${fail ? 1 : 0}`, "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", `ℹ duration_ms ${ms}`];
  const f = fail ? ["", "✖ failing tests:", "", `test at ${fail.at}`, `✖ ${tests[fail.i][0]} (${tests[fail.i][1]}ms)`, ...fail.err.map((l) => `  ${l}`)] : [];
  return [`> ${pkg} test`, "> node --test", "", ...lines, ...tail, ...f].join("\n");
}
const ms = (i: number) => (((i * 7919) % 900) / 100 + 0.1).toFixed(2);
const names = (xs: string[]): [string, string][] => xs.map((x, i) => [x, ms(i + 3)]);

const DURATION_TESTS = names(["hours", "combined", "seconds and minutes", "any order + spaces", "invalid", "format", "round trip"]);
const CHECK_OK = nodeOut("billing-api@2.3.0", DURATION_TESTS, undefined, "52.7");
const CHECK_FAIL = nodeOut(
  "billing-api@2.3.0",
  DURATION_TESTS,
  { i: 4, at: "duration.test.js:12:1", err: ["AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "", "5 !== NaN", "", "    at TestContext.<anonymous> (file:///./duration.test.js:13:10)", "    at Test.runInAsyncScope (node:async_hooks:206:9)"] },
  "61.3",
);

const RENEWAL_TESTS = names(["3/15 → 4/15", "1/31 → 2/28", "윤년 1/31 → 2/29", "2월 다음 3/31 복귀", "12/31 → 1/31", "KST 자정 직후 가입", "체험 14일 뒤 첫 결제"]);
const CHECK_RENEWAL_OK = nodeOut("billing-api@2.3.0", RENEWAL_TESTS, undefined, "46.1");
const CHECK_RENEWAL_FAIL = nodeOut(
  "billing-api@2.3.0",
  RENEWAL_TESTS,
  { i: 3, at: "src/billing/renewal.test.js:31:1", err: ["AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "", "'2027-03-28' !== '2027-03-31'", "", "    at TestContext.<anonymous> (file:///./src/billing/renewal.test.js:36:10)", "    at Test.runInAsyncScope (node:async_hooks:206:9)"] },
  "53.8",
);

const WEBHOOK_TESTS = names(["verifies signature", "rejects a bad signature", "handles invoice.paid", "handles invoice.payment_failed", "ignores unknown event types", "skips an already processed event", "processes concurrent duplicates once", "returns 200 on duplicate", "stores the event payload", "rolls back the claim when dispatch throws", "logs the event id", "refund.created", "refund.created twice", "health check"]);
const CHECK_WEBHOOK = nodeOut("billing-api@2.3.0", WEBHOOK_TESTS, undefined, "81937.2");
const SUMMARY_TESTS = names(["summarize total", "summarize count", "summary route", "maxAmount", "avgAmount rounds", "route keeps old fields", "empty list", "single item", "negative credit note", "customer filter", "month filter", "csv header"]);
const CHECK_SUMMARY = nodeOut("billing-api@2.3.0", SUMMARY_TESTS, undefined, "148.9");
const ORDERS_TESTS = names(["list default", "list page 2", "limit capped at 100", "limit=0", "empty table", "last page", "page beyond last", "sort order", "total count"]);
const CHECK_ORDERS = nodeOut("billing-api@2.3.0", ORDERS_TESTS, undefined, "73.1");
const SESSION_TESTS = names(["create returns id", "expires after ttl", "expires in utc", "refresh extends", "refresh after expiry fails", "logout deletes", "cookie flags"]);
const CHECK_SESSION_OK = nodeOut("billing-api@2.3.0", SESSION_TESTS, undefined, "47.6");
const CHECK_SESSION_FAIL = nodeOut("billing-api@2.3.0", SESSION_TESTS, { i: 2, at: "test/session.test.js:31:1", err: ["AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "", "'2026-10-04T23:00:00.000Z' !== '2026-10-05T08:00:00.000Z'", "", "    at TestContext.<anonymous> (file:///./test/session.test.js:35:12)"] }, "55.2");
const CSV_TESTS = names(["header row", "owner column", "scheduled date column", "empty schedule", "status labels", "escapes commas", "escapes quotes", "bom for excel"]);
const CHECK_CSV = nodeOut("content-tools@1.8.2", CSV_TESTS, undefined, "39.8");

const vitest = (pkg: string, files: [string, number, string][], extra: string[], tests: string, filesLine: string, dur: string) =>
  [`> ${pkg} test`, "> vitest run", "", " RUN  v2.1.4 .", "", ...files.map(([f, n, t]) => ` ✓ ${f} (${n} tests) ${t}ms`), ...extra, "", ` Test Files  ${filesLine}`, `      Tests  ${tests}`, "   Start at  14:21:07", `   Duration  ${dur}`].join("\n");
const WEB_FILES: [string, number, string][] = [
  ["src/lib/format.test.ts", 9, "6"],
  ["src/components/InvoiceRow.test.tsx", 4, "38"],
];
const CHECK_SCROLL_FAIL_1 = vitest(
  "billing-web@0.9.4",
  WEB_FILES,
  [
    " ❯ src/hooks/useInfiniteList.test.tsx (6 tests | 1 failed) 61ms",
    "   × useInfiniteList > requests each page only once under StrictMode 14ms",
    '     → expected "spy" to be called 1 times, but got 2 times',
    "",
    " FAIL  src/hooks/useInfiniteList.test.tsx > useInfiniteList > requests each page only once under StrictMode",
    'AssertionError: expected "spy" to be called 1 times, but got 2 times',
    " ❯ src/hooks/useInfiniteList.test.tsx:58:30",
    "     56|     await waitFor(() => expect(result.current.items).toHaveLength(40));",
    "     57|     // page=2 must not be fetched twice",
    "     58|     expect(fetchPage).toHaveBeenCalledTimes(1);",
    "       |                      ^",
  ],
  "1 failed | 18 passed (19)",
  "1 failed | 2 passed (3)",
  "1.84s (transform 142ms, setup 0ms, collect 1.21s, tests 105ms, environment 1.76s, prepare 301ms)",
);
const CHECK_SCROLL_FAIL_2 = vitest(
  "billing-web@0.9.4",
  WEB_FILES,
  [
    " ❯ src/hooks/useInfiniteList.test.tsx (6 tests | 1 failed) 77ms",
    "   × useInfiniteList > appends page 2 after scrolling to the end 21ms",
    "     → expected [ 'a1', 'a2', 'a3' ] to have a length of 40 but got 20",
    "",
    " FAIL  src/hooks/useInfiniteList.test.tsx > useInfiniteList > appends page 2 after scrolling to the end",
    "AssertionError: expected [ 'a1', 'a2', 'a3' ] to have a length of 40 but got 20",
    " ❯ src/hooks/useInfiniteList.test.tsx:44:36",
    "     42|     act(() => observer.trigger());",
    "     43|     await waitFor(() => expect(fetchPage).toHaveBeenCalledWith(2));",
    "     44|     expect(result.current.items).toHaveLength(40);",
    "       |                                  ^",
  ],
  "1 failed | 18 passed (19)",
  "1 failed | 2 passed (3)",
  "1.91s (transform 150ms, setup 0ms, collect 1.28s, tests 118ms, environment 1.80s, prepare 322ms)",
);
const CHECK_BUTTON = vitest(
  "billing-web@0.9.4",
  [...WEB_FILES, ["src/components/Button.test.tsx", 6, "21"], ["src/pages/InvoiceDetail.test.tsx", 7, "55"]],
  [],
  "26 passed (26)",
  "4 passed (4)",
  "1.62s (transform 118ms, setup 0ms, collect 1.02s, tests 120ms, environment 1.55s, prepare 276ms)",
);

const PYTEST_OK = "......................................                                   [100%]\n38 passed in 2.41s";
const PYTEST_FAIL_S1 = [
  ".....................................F                                   [100%]",
  "=================================== FAILURES ===================================",
  "___________________________ test_weekly_rollup_dedupe ___________________________",
  "",
  "    def test_weekly_rollup_dedupe():",
  ">       from settle.settle_weekly import _dedupe_rows",
  "E       ImportError: cannot import name '_dedupe_rows' from 'settle.settle_weekly' (./settle/settle_weekly.py)",
  "",
  "tests/test_settle.py:84: ImportError",
  "=========================== short test summary info ============================",
  "FAILED tests/test_settle.py::test_weekly_rollup_dedupe - ImportError: cannot import name '_dedupe_rows' from 'settle.settle_weekly' (./settle/settle_w...",
  "1 failed, 37 passed in 2.38s",
].join("\n");
const PYTEST_FAIL_C2 = PYTEST_FAIL_S1;

// ---------------------------------------------------------------------------------------------- live script helpers

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
  /** chat text decided when the step fires (needs the run as it is by then) */
  late?: (live: Live) => string;
}
type Tokens = [number, number, number];

const SONNET = 0;
const CODEX = 1;
const LABEL = ["claude-sonnet", "codex"];
const wt = (id: string, agent: number) => `~/.willnew/worktrees/${id}/${LABEL[agent]}`;
const bot = (at: number, kind: NonNullable<ChatMessage["kind"]>, text: string, run?: Partial<Run>): Step => ({ at: sec(at), run, chat: { user: "willnew", bot: true, kind, text } });
const ev = (at: number, agent: number, kind: Kind, text: string, tokens?: Tokens, extra: Partial<Step> = {}): Step => ({ at: sec(at), agent, ev: [kind, text], ...(tokens ? { tokens } : {}), ...extra });
const begin = (at: number, agent: number, id: string): Step => ev(at, agent, "status", `작업 시작 · ${wt(id, agent)}`, undefined, { patch: { status: "running" } });
const checkStart = (at: number, agent: number, cmd: string, patch: string, attempt?: number): Step =>
  ev(at, agent, "check", `$ ${cmd}`, undefined, { attempt, patch: { status: "checking", diff: diffOf(patch) } });
const checkPass = (at: number, agent: number, secs: string, output: string, attempt?: number): Step =>
  ev(at, agent, "check", `검증 통과 (exit 0, ${secs} s)`, undefined, { attempt, patch: { status: "done", check: { status: "passed", exitCode: 0, output, durationMs: Math.round(parseFloat(secs) * SEC) } } });
const checkFail = (at: number, agent: number, secs: string, output: string, retry: boolean, attempt?: number): Step =>
  ev(at, agent, "check", `검증 실패 (exit 1, ${secs} s)`, undefined, { attempt, patch: { status: retry ? "retrying" : "done", check: { status: "failed", exitCode: 1, output, durationMs: Math.round(parseFloat(secs) * SEC) } } });
const retryNote = (at: number, agent: number, n: number): Step =>
  ev(at, agent, "plan", `검증 실패 → 실패 로그를 돌려주고 다시 시도 (${n}/2)`, undefined, { attempt: n, patch: { attempt: n, status: "running" } });
const cat = (rows: string[]) => rows.map((r, i) => `${String(i + 1).padStart(6)}\t${r}`).join("\n");

const SONNET_SUMMARY =
  "원인은 `parseDuration` 이 `h` 단위만 처리하던 것이었어요. 공백을 걷어 낸 뒤 `(\\d+[hms])+` 전체를 검증하고 단위별로 합산하도록 고쳤고, `formatDuration` 은 0인 단위를 빼고 이어 붙입니다. 테스트는 건드리지 않았고 7개 모두 통과해요.";
const CODEX_SUMMARY_1 = "parseDuration 과 formatDuration 을 구현했습니다. 단위별 합산, 0 단위 생략.";
const CODEX_SUMMARY_2 =
  "1차 시도에서 `\"5x\"` 가 5로 파싱되던 문제를 고쳤습니다. 입력 전체를 앵커 정규식으로 먼저 검증하고, 통과한 경우에만 단위를 합산합니다. 7개 테스트 모두 통과.";

// ---------------------------------------------------------------------------------------------- scenarios

interface Scenario {
  channel: string;
  requester: string;
  team: string;
  text: string;
  /** how long ago the request was made; steps with `at` before that are fast-forwarded */
  ago: number;
  title?: string;
  /** 요청자가 스스로 붙인 직함. 없으면 데모 인물 표에서 찾는다 */
  requesterTitle?: string;
  template?: string;
  check?: string;
  agents?: AgentSpec[];
  plan?: string[];
  task?: string;
  reason?: string;
  triageMs?: number;
  steps: (id: string, requester: string) => Step[];
  /** a run that already has history (agents, comments) when the demo opens */
  prebuilt?: (id: string, createdAt: number) => Run;
}

/** The scripted race: two agents on the duration bug, one self-corrects, both pass. ~31 s end to end. */
function durationSteps(id: string): Step[] {
  return [
    bot(0.7, "ack", "받았어요. 계획 세우는 중"),
    { ...bot(3.1, "triage", "계획: 버그 수정 · sonnet, codex 둘이 겨뤄요 · npm test"), run: {} }, // filled in by launch(): triage + agents
    begin(3.8, SONNET, id),
    begin(3.9, CODEX, id),
    ev(5.1, SONNET, "text", "duration.js 와 테스트부터 볼게요.", [3100, 120, 9000]),
    ev(5.4, CODEX, "text", "테스트가 기대하는 형식부터 확인하겠습니다.", [5200, 90, 4000]),
    ev(6.1, SONNET, "tool", 'Read {"file_path":"./duration.test.js"}', [1800, 60, 12000]),
    ev(6.6, CODEX, "tool", "shell cat duration.test.js duration.js", [2400, 70, 6000]),
    ev(6.8, SONNET, "tool_result", cat(['import test from "node:test";', 'import assert from "node:assert/strict";', 'import { parseDuration, formatDuration } from "./duration.js";', "", 'test("hours", () => {'])),
    ev(7.1, CODEX, "tool_result", 'exit 0 import test from "node:test";\nimport assert from "node:assert/strict";\nimport { parseDuration, formatDuration } from "./duration.js";\n'),
    ev(8.2, SONNET, "tool", 'Read {"file_path":"./duration.js"}', [1500, 50, 14000]),
    ev(8.8, SONNET, "tool_result", cat(["/**", ' * Parse a human duration like "1h30m" into seconds.', " * Supports h, m, s units, combined in any order. Returns NaN for invalid input.", " */", "export function parseDuration(text) {"])),
    ev(10.2, CODEX, "text", "정규식으로 단위를 뽑아 합산하도록 구현합니다.", [3800, 260, 8000]),
    ev(11.0, SONNET, "text", "원인 찾았어요: parseDuration 이 `h` 단위만 처리해요. 단위별 합산으로 고칠게요.", [2600, 310, 15000]),
    ev(13.0, CODEX, "tool", "edit duration.js", [2100, 540, 6000]),
    ev(13.6, SONNET, "tool", 'Edit {"file_path":"./duration.js","old_string":"const m = /^(\\\\d+)h$/.exec(text.trim());","new_string":"const s = text.replace(/\\\\s+/g, \\"\\");"}', [2200, 620, 16000]),
    ev(14.3, SONNET, "tool_result", "The file ./duration.js has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n     5\texport function parseDuration(text) {\n     6\t  const s = text.replace(/\\s+/g, \"\");"),
    ev(15.3, CODEX, "text", CODEX_SUMMARY_1, [1900, 180, 5000], { patch: { summary: CODEX_SUMMARY_1, turns: 1 } }),
    checkStart(15.8, CODEX, "npm test", PATCH_CODEX),
    ev(16.3, SONNET, "tool", 'Bash {"command":"node --test"}', [1600, 40, 17000]),
    checkFail(17.5, CODEX, "1.0", CHECK_FAIL, true),
    retryNote(17.9, CODEX, 2),
    ev(18.0, SONNET, "tool_result", CHECK_OK.split("\n").slice(3).join("\n")),
    ev(19.3, SONNET, "text", SONNET_SUMMARY, [2400, 480, 18000], { patch: { summary: SONNET_SUMMARY, turns: 6 } }),
    ev(19.5, CODEX, "text", "'5x' 같은 입력을 거르지 못했어요. 입력 전체를 먼저 앵커로 검증하도록 고칩니다.", [6400, 280, 9000], { attempt: 2 }),
    checkStart(19.7, SONNET, "npm test", PATCH_SONNET),
    checkPass(21.4, SONNET, "0.4", CHECK_OK),
    ev(22.1, CODEX, "tool", "edit duration.js", [2300, 610, 7000], { attempt: 2 }),
    ev(24.0, CODEX, "tool", "shell node --test", [1200, 30, 4000], { attempt: 2 }),
    ev(26.5, CODEX, "tool_result", `exit 0 ${CHECK_OK.split("\n").slice(3, 6).join("\n")}`, undefined, { attempt: 2 }),
    ev(27.6, CODEX, "text", CODEX_SUMMARY_2, [1700, 350, 5000], { attempt: 2, patch: { summary: CODEX_SUMMARY_2, turns: 2 } }),
    checkStart(28.0, CODEX, "npm test", PATCH_CODEX, 2),
    checkPass(29.9, CODEX, "0.5", CHECK_OK, 2),
    bot(31.0, "review", "둘 다 통과. sonnet 이 8초 빠르고 변경도 작아서 이걸로 추천해요", { review: { status: "pending" } }),
  ];
}

function durationScenario(channel: string, requester: string, team: string, text: string, ago: number): Scenario {
  return {
    channel,
    requester,
    team,
    text,
    ago,
    title: /parseDuration/.test(text) ? "parseDuration 이 1h30m 같은 입력을 못 읽음" : undefined,
    triageMs: 2400,
    plan: [
      "실패하는 테스트를 돌려 증상을 재현한다",
      "duration.js 에서 원인을 찾는다 (테스트는 수정 금지)",
      "parseDuration · formatDuration 을 고친다",
      "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다",
      "통과한 결과 중 하나를 골라 요청자 검토를 받는다",
    ],
    task: "Find the root cause in duration.js and fix it. Do not modify duration.test.js. Run `npm test` to confirm.",
    reason: "테스트 실패를 고치는 요청이라 버그 수정 템플릿. 테스트가 판정할 수 있어 에이전트 하나로 시작하고 자기 수정 1회를 허용.",
    steps: durationSteps,
  };
}

const RENEWAL_NOTE = "1/31에 가입한 분은 이제 2/28에 결제되고, 3월부터는 다시 31일에 결제돼요. 이미 3/3으로 잡힌 구독은 따로 바로잡아야 해요.";
const RENEWAL_SONNET_SUMMARY_1 = "직전 결제일에 한 달을 더하고, 말일을 넘으면 말일로 맞췄어요.";
const RENEWAL_SONNET_SUMMARY =
  "1차 시도는 직전 결제일(2/28)에 한 달을 더해서 3월에도 28일로 나갔고, '2월 다음 3/31 복귀' 테스트에서 걸렸어요. 원인은 직전 결제일 기준으로 계산하는 것이에요. 가입 시점(anchorAt)을 서울 시간대로 바꿔 addMonths 로 n개월 뒤를 구하게 했고, 짧은 달은 date-fns 가 말일로 맞춰서 3월에는 다시 31일이 됩니다. KST 변환용으로 date-fns-tz 를 package.json 에 추가했어요. 테스트는 그대로, 7개 통과.";
const RENEWAL_SONNET_SUMMARY_2 =
  "date-fns-tz 를 빼고 lib/time.js 의 toKst / fromKst 로 바꿨어요. package.json 은 원래대로 돌렸고, 계산 기준은 그대로 가입 시점(anchorAt) 이에요. 7개 통과.";
const RENEWAL_CODEX_SUMMARY_1 = "직전 결제일에 한 달을 더하고, 말일을 넘으면 말일로 맞췄습니다.";
const RENEWAL_CODEX_SUMMARY_2 =
  "1차 시도는 직전 결제일(2/28) 기준이라 3월에도 28일로 나갔습니다. 기준을 가입 시점 anchorAt 으로 바꾸고, 서울 시간대에서 n개월 뒤를 구하게 했습니다. 7개 테스트 통과.";
const withNote = (summary: string) => `${summary}\n\n요청자에게: ${RENEWAL_NOTE}`;

/** codex's side of the race: same script as before, only used when the person turns 겨루기 on. */
function renewalCodexSteps(id: string): Step[] {
  return [
    begin(3.9, CODEX, id),
    ev(5.4, CODEX, "text", "결제일 계산 함수와 테스트를 먼저 확인하겠습니다.", [5200, 90, 4000]),
    ev(6.6, CODEX, "tool", "shell cat src/billing/renewal.test.js src/billing/renewal.js", [2400, 70, 6000]),
    ev(7.1, CODEX, "tool_result", 'exit 0 import test from "node:test";\nimport assert from "node:assert/strict";\nimport { nextBillingDate } from "./renewal.js";\n'),
    ev(10.2, CODEX, "text", "직전 결제일에 한 달을 더하고, 말일을 넘지 않게 맞추겠습니다.", [3800, 260, 8000]),
    ev(13.0, CODEX, "tool", "edit src/billing/renewal.js", [2100, 540, 6000]),
    ev(15.3, CODEX, "text", RENEWAL_CODEX_SUMMARY_1, [1900, 180, 5000], { patch: { summary: RENEWAL_CODEX_SUMMARY_1, turns: 1 } }),
    checkStart(15.8, CODEX, "npm test", PATCH_RENEWAL_C1),
    checkFail(17.5, CODEX, "1.0", CHECK_RENEWAL_FAIL, true),
    retryNote(17.9, CODEX, 2),
    ev(19.5, CODEX, "text", "2/28 에서 한 달을 더하면 3/28 이에요. 직전 결제일이 아니라 anchorAt 에서 n개월 뒤를 구하도록 바꿀게요. 날짜 계산은 BILLING_TZ 기준으로 합니다.", [6400, 280, 9000], { attempt: 2 }),
    ev(22.1, CODEX, "tool", "edit src/billing/renewal.js package.json", [2300, 610, 7000], { attempt: 2 }),
    ev(24.0, CODEX, "tool", "shell node --test", [1200, 30, 4000], { attempt: 2 }),
    ev(26.5, CODEX, "tool_result", `exit 0 ${CHECK_RENEWAL_OK.split("\n").slice(3, 6).join("\n")}`, undefined, { attempt: 2 }),
    ev(27.6, CODEX, "text", withNote(RENEWAL_CODEX_SUMMARY_2), [1700, 350, 5000], { attempt: 2, patch: { summary: RENEWAL_CODEX_SUMMARY_2, userNote: RENEWAL_NOTE, turns: 2 } }),
    checkStart(28.0, CODEX, "npm test", PATCH_RENEWAL_C, 2),
    checkPass(29.9, CODEX, "0.5", CHECK_RENEWAL_OK, 2),
  ];
}

/**
 * The composer scenario: a subscription renewal date rolls over after a short month. One agent (claude-sonnet) first
 * adds a month to the previous period end, fails "2월 다음 3/31 복귀", reads the log and counts from the sign-up anchor. ~31 s.
 */
function renewalSteps(id: string, race: boolean): Step[] {
  return [
    bot(0.7, "ack", "받았어요. 계획 세우는 중"),
    { ...bot(3.1, "triage", planLine("버그 수정", race ? [SONNET_SPEC, CODEX_SPEC] : [SONNET_SPEC], "npm test")), run: {} },
    begin(3.8, SONNET, id),
    ev(5.1, SONNET, "text", "renewal.test.js 와 renewal.js 부터 볼게요.", [3100, 120, 9000]),
    ev(6.1, SONNET, "tool", 'Read {"file_path":"./src/billing/renewal.test.js"}', [1800, 60, 12000]),
    ev(6.8, SONNET, "tool_result", cat(['import test from "node:test";', 'import assert from "node:assert/strict";', 'import { nextBillingDate } from "./renewal.js";', "", 'test("1/31 → 2/28", () => {'])),
    ev(8.2, SONNET, "tool", 'Read {"file_path":"./src/billing/renewal.js"}', [1500, 50, 14000]),
    ev(8.8, SONNET, "tool_result", cat(["/** 다음 결제일: 직전 결제일에 한 달을 더한다 */", "export function nextBillingDate(sub) {", "  const d = new Date(sub.currentPeriodEnd);", "  d.setMonth(d.getMonth() + 1);", "  return d;"])),
    ev(11.0, SONNET, "text", "currentPeriodEnd 에 setMonth(+1) 을 하면 1/31 이 2/31 이 되고 JS 가 3/3 으로 넘겨요. 직전 결제일에 한 달을 더하고 말일을 넘으면 말일로 맞출게요.", [2600, 310, 15000]),
    ev(13.0, SONNET, "tool", 'Edit {"file_path":"./src/billing/renewal.js","old_string":"d.setMonth(d.getMonth() + 1);","new_string":"next.setDate(Math.min(cur.getDate(), last));"}', [2200, 620, 16000]),
    ev(14.3, SONNET, "tool_result", "The file ./src/billing/renewal.js has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n     6\texport function nextBillingDate(sub) {\n     7\t  const cur = new Date(sub.currentPeriodEnd);"),
    ev(15.3, SONNET, "text", RENEWAL_SONNET_SUMMARY_1, [1900, 180, 5000], { patch: { summary: RENEWAL_SONNET_SUMMARY_1, turns: 3 } }),
    checkStart(15.8, SONNET, "npm test", PATCH_RENEWAL_C1),
    checkFail(17.5, SONNET, "1.0", CHECK_RENEWAL_FAIL, true),
    retryNote(17.9, SONNET, 2),
    ev(19.5, SONNET, "text", "2/28 에서 한 달을 더하면 3/28 이에요. 직전 결제일이 아니라 가입 시점 anchorAt 에서 n개월 뒤를 구하도록 바꿀게요. 날짜 계산은 BILLING_TZ 기준으로 합니다.", [6400, 280, 9000], { attempt: 2 }),
    ev(22.1, SONNET, "tool", 'Edit {"file_path":"./src/billing/renewal.js","old_string":"const cur = new Date(sub.currentPeriodEnd);","new_string":"const anchor = toZonedTime(sub.anchorAt, BILLING_TZ);"}', [2300, 610, 16500], { attempt: 2 }),
    ev(22.8, SONNET, "tool_result", "The file ./src/billing/renewal.js has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n     6\texport function nextBillingDate(sub) {\n     7\t  const anchor = toZonedTime(sub.anchorAt, BILLING_TZ);", undefined, { attempt: 2 }),
    ev(23.4, SONNET, "tool", 'Edit {"file_path":"./package.json","old_string":"\\"date-fns\\": \\"^3.6.0\\",","new_string":"\\"date-fns\\": \\"^3.6.0\\",\\n    \\"date-fns-tz\\": \\"^3.1.3\\","}', [1400, 90, 17000], { attempt: 2 }),
    ev(24.4, SONNET, "tool", 'Bash {"command":"node --test"}', [1600, 40, 17500], { attempt: 2 }),
    ev(26.5, SONNET, "tool_result", CHECK_RENEWAL_OK.split("\n").slice(3, 9).join("\n"), undefined, { attempt: 2 }),
    ev(27.6, SONNET, "text", withNote(RENEWAL_SONNET_SUMMARY), [2400, 480, 18000], { attempt: 2, patch: { summary: RENEWAL_SONNET_SUMMARY, userNote: RENEWAL_NOTE, turns: 7 } }),
    checkStart(28.0, SONNET, "npm test", PATCH_RENEWAL_S, 2),
    { ...checkPass(29.9, SONNET, "0.5", CHECK_RENEWAL_OK, 2), run: { review: { status: "pending" as const } } },
    ...(race ? renewalCodexSteps(id) : []),
    bot(
      race ? 30.2 : 30.6,
      "review",
      race
        ? "둘 다 통과. 둘 다 1차 검증에서 실패했다가 스스로 고쳤어요. sonnet 이 변경이 작아서 이걸로 추천해요"
        : "sonnet 통과. 1차 검증에서 '2월 다음 3/31 복귀' 가 실패했고, 로그를 보고 스스로 고쳐서 7개 모두 통과했어요",
    ),
  ].sort((a, b) => a.at - b.at);
}

function renewalScenario(channel: string, requester: string, team: string, text: string, ago: number, race: boolean): Scenario {
  return {
    channel,
    requester,
    team,
    text,
    ago,
    title: "1/31 가입자 다음 결제일이 3/3 으로 잡힘",
    triageMs: 2400,
    agents: race ? [SONNET_SPEC, CODEX_SPEC] : [SONNET_SPEC],
    plan: [
      "1/31 가입자의 다음 결제일을 재현한다",
      "결제일 계산이 직전 결제일 기준인지 가입 시점 기준인지 확인한다 (테스트는 수정 금지)",
      "가입 시점(anchorAt)에서 n개월 뒤를 서울 시간대로 구하게 고친다",
      "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다",
      race ? REVIEW_STEP_PLAN : REVIEW_STEP_SOLO,
    ],
    task: "Fix nextBillingDate in src/billing/renewal.js (#431): a Jan 31 subscriber's next billing date comes out as Mar 3. Count n months from the subscription anchor (anchorAt) in the billing time zone instead of adding one month to the previous period end. Short months clamp to the last day and the month after returns to the 31st. Do not modify renewal.test.js. Run `npm test` to confirm.",
    reason: race
      ? "결제일이 잘못 나오는 버그라 버그 수정 템플릿. 겨루기를 켜서 에이전트 둘이 따로 풀고, 자기 수정 1회를 허용."
      : "결제일이 잘못 나오는 버그라 버그 수정 템플릿. 테스트가 판정할 수 있어 에이전트 하나로 시작하고 자기 수정 1회를 허용.",
    steps: (id) => renewalSteps(id, race),
  };
}

/** 최민재 · #web — runs for minutes, then both agents fail twice: ends as "결과 없음". */
const SCROLL_TEXT = "@willnew 모바일에서 청구서 목록 스크롤 내리면 같은 페이지를 두 번 불러옴 ㅋㅋ 네트워크탭에 page=2 가 두 줄 찍힘. IntersectionObserver 쪽인듯 #412";
function scrollSteps(id: string): Step[] {
  const hook = ["import { useCallback, useEffect, useRef, useState } from \"react\";", "", "export function useInfiniteList<T>(fetchPage: (page: number) => Promise<T[]>) {", "  const [items, setItems] = useState<T[]>([]);"];
  return [
    bot(0.8, "ack", "받았어요. 계획 세우는 중"),
    { ...bot(22.5, "triage", "계획: 버그 수정 · sonnet, codex 둘이 겨뤄요 · npm test"), run: {} },
    begin(23.4, SONNET, id),
    begin(23.6, CODEX, id),
    ev(25.0, SONNET, "text", "목록 쪽 훅부터 볼게요. useInfiniteList 가 있는 것 같네요.", [3300, 110, 8000]),
    ev(25.8, CODEX, "tool", 'shell rg -n "IntersectionObserver|useInfiniteList" src', [4100, 80, 3000]),
    ev(26.4, SONNET, "tool", 'Grep {"pattern":"useInfiniteList","path":"./src"}', [1700, 55, 10000]),
    ev(26.9, CODEX, "tool_result", "exit 0 src/hooks/useInfiniteList.ts:11:export function useInfiniteList<T>(\nsrc/hooks/useInfiniteList.test.tsx:7:import { useInfiniteList } from \"./useInfiniteList\";\nsrc/pages/InvoiceList.tsx:19:  const { items, sentinel } = useInfiniteList(fetchInvoices);"),
    ev(27.4, SONNET, "tool_result", "src/hooks/useInfiniteList.ts\nsrc/hooks/useInfiniteList.test.tsx\nsrc/pages/InvoiceList.tsx"),
    ev(29.5, SONNET, "tool", 'Read {"file_path":"./src/hooks/useInfiniteList.ts"}', [1900, 60, 13000]),
    ev(30.1, SONNET, "tool_result", cat(hook)),
    ev(33.0, CODEX, "tool", "shell sed -n 1,80p src/hooks/useInfiniteList.ts", [2100, 60, 5000]),
    ev(34.0, CODEX, "tool_result", `exit 0 ${hook.join("\n")}`),
    ev(36.5, SONNET, "text", "loading 이 state 라서 observer 콜백이 렌더 사이에 옛날 값을 잡고 있어요. StrictMode 에서 effect 가 두 번 도는 것까지 겹치면 page=2 가 두 번 나가는 게 맞아 보여요.", [2500, 340, 15000]),
    ev(40.5, CODEX, "text", "loading 상태를 클로저로 읽고 있어서 observer 가 연속으로 호출되면 중복 요청이 나갑니다. 요청한 페이지를 기억해 두는 방식으로 막겠습니다.", [3900, 270, 8000]),
    // ---- from here on it is still ahead when the demo opens (about 40 s in)
    ev(52, SONNET, "tool", 'Read {"file_path":"./src/hooks/useInfiniteList.test.tsx"}', [1600, 50, 17000]),
    ev(53, SONNET, "tool_result", cat(['import { renderHook, waitFor } from "@testing-library/react";', 'import { StrictMode } from "react";', 'import { useInfiniteList } from "./useInfiniteList";'])),
    ev(64, CODEX, "tool", "edit src/hooks/useInfiniteList.ts", [2300, 520, 7000]),
    ev(71, SONNET, "tool", 'Edit {"file_path":"./src/hooks/useInfiniteList.ts","old_string":"const [loading, setLoading] = useState(false);","new_string":"const loading = useRef(false);"}', [2300, 610, 19000]),
    ev(72, SONNET, "tool_result", "The file ./src/hooks/useInfiniteList.ts has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    15\t  const loading = useRef(false);"),
    ev(88, SONNET, "tool", 'Bash {"command":"npx vitest run src/hooks"}', [1500, 40, 21000]),
    ev(95, SONNET, "tool_result", CHECK_SCROLL_FAIL_1.split("\n").slice(3, 14).join("\n")),
    ev(104, SONNET, "text", "ref 로 바꿔도 StrictMode 테스트는 아직 2번이에요. 요청 중인 page 번호를 따로 기록해야 할 것 같아요.", [2700, 300, 22000]),
    ev(121, CODEX, "tool", "shell npx vitest run src/hooks", [1300, 30, 6000]),
    ev(130, CODEX, "tool_result", "exit 1 × useInfiniteList > requests each page only once under StrictMode 14ms\n  → expected \"spy\" to be called 1 times, but got 2 times"),
    ev(142, SONNET, "tool", 'Edit {"file_path":"./src/hooks/useInfiniteList.ts","old_string":"if (loading.current) return;","new_string":"if (loading.current || fetched.current.has(page)) return;"}', [2400, 590, 24000]),
    ev(151, SONNET, "tool_result", "The file ./src/hooks/useInfiniteList.ts has been updated."),
    ev(158, CODEX, "text", "테스트를 돌려 보니 StrictMode 에서 한 번 더 호출됩니다. requested set 을 effect 밖으로 빼겠습니다.", [3600, 250, 9000]),
    ev(171, SONNET, "text", "수정 끝났어요. 검증 돌려 볼게요.", [2100, 150, 25000], { patch: { summary: "loading 을 ref 로 바꿔 observer 중복 호출을 막았지만 StrictMode 이중 effect 는 다 못 막았어요.", turns: 7 } }),
    checkStart(176, SONNET, "npm test", PATCH_SCROLL_S),
    checkFail(184.2, SONNET, "7.9", CHECK_SCROLL_FAIL_1, true),
    retryNote(184.6, SONNET, 2),
    ev(200, CODEX, "text", "requested set 으로 막았습니다. 검증을 실행합니다.", [2800, 200, 9500], { patch: { summary: "요청한 페이지 번호를 Set 으로 기억해 중복 요청을 건너뜁니다.", turns: 3 } }),
    checkStart(204, CODEX, "npm test", PATCH_SCROLL_C),
    checkFail(211.6, CODEX, "7.4", CHECK_SCROLL_FAIL_2, true),
    retryNote(212, CODEX, 2),
    ev(215, SONNET, "text", "fetched ref 를 effect cleanup 에서 지우도록 고칠게요.", [2600, 280, 26000], { attempt: 2 }),
    ev(224, SONNET, "tool", 'Edit {"file_path":"./src/hooks/useInfiniteList.ts"}', [2200, 540, 27000], { attempt: 2 }),
    ev(239, CODEX, "text", "Set 을 비우는 시점만 조정했습니다.", [2400, 190, 10500], { attempt: 2 }),
    checkStart(243, SONNET, "npm test", PATCH_SCROLL_S, 2),
    checkFail(251.1, SONNET, "7.6", CHECK_SCROLL_FAIL_2, false, 2),
    checkStart(256, CODEX, "npm test", PATCH_SCROLL_C, 2),
    checkFail(263.8, CODEX, "7.5", CHECK_SCROLL_FAIL_2, false, 2),
    bot(264.5, "result", "통과한 결과가 없어요. 둘 다 2차 시도까지 실패했어요"),
  ];
}

/** 정하늘 · #backend — both agents are in the verifier for ~80 s, then hand over a pair of passes. */
const WEBHOOK_TEXT =
  "@willnew 결제 웹훅이 가끔 같은 이벤트를 두 번 처리해서 중복 청구 문의가 하나 들어왔어요 (#388). 로그 보면 evt_ id 는 똑같은데 handleWebhook 이 두 번 도는 것 같고, 재시도 헤더 때문이거나 처리 중에 락이 없어서일 수도 있어요. 멱등키 처리 쪽 한번 봐주실 수 있을까요? 동작은 그대로 두고 중복만 막으면 돼요";
function webhookSteps(id: string): Step[] {
  const sonnetSum = "evt_ id 를 SELECT 로 확인하고 처리 뒤에 INSERT 하던 순서가 원인이에요. 동시에 온 같은 이벤트가 둘 다 SELECT 를 통과했어요. processed_events 에 유니크 키를 걸고, 처리 전에 INSERT ... ON CONFLICT DO NOTHING 으로 먼저 선점하도록 바꿨어요. dispatch 가 던지면 선점을 되돌려서 재시도는 그대로 받아요.";
  const codexSum = "프로세스 안에서 event id 별로 순서를 세우는 락(withEventLock)을 추가했습니다. 같은 이벤트가 동시에 오면 두 번째는 duplicate 로 응답합니다.";
  return [
    bot(0.8, "ack", "받았어요. 계획 세우는 중"),
    { ...bot(19.2, "triage", "계획: 버그 수정 · sonnet, codex 둘이 겨뤄요 · npm test"), run: {} },
    begin(19.9, SONNET, id),
    begin(20.1, CODEX, id),
    ev(21.5, SONNET, "text", "webhook 핸들러부터 볼게요. 이벤트 id 로 중복을 걸러 내는 부분이 있는지 확인할게요.", [3200, 130, 9000]),
    ev(22.0, CODEX, "tool", 'shell rg -n "processed_events|handleWebhook" src migrations', [4300, 90, 3500]),
    ev(22.8, SONNET, "tool", 'Grep {"pattern":"handleWebhook","path":"./src"}', [1700, 55, 11000]),
    ev(23.3, CODEX, "tool_result", "exit 0 src/payments/webhook.js:27:export async function handleWebhook(req, res) {\nsrc/payments/webhook.js:31:  const seen = await db.get(\"SELECT 1 FROM processed_events WHERE event_id = ?\", [event.id]);\nmigrations/0009_processed_events.sql:1:CREATE TABLE processed_events ("),
    ev(23.5, SONNET, "tool_result", "src/payments/webhook.js:27:export async function handleWebhook(req, res) {\nsrc/payments/webhook.test.js:9:import { handleWebhook } from \"./webhook.js\";"),
    ev(25.5, SONNET, "tool", 'Read {"file_path":"./src/payments/webhook.js"}', [2100, 60, 14000]),
    ev(26.2, SONNET, "tool_result", cat(["import { db } from \"../db.js\";", "import { dispatch } from \"./dispatch.js\";", "import { verifySignature } from \"./signature.js\";", "", "export async function handleWebhook(req, res) {"])),
    ev(27.5, CODEX, "text", "SELECT 로 확인한 뒤 처리하고 나중에 INSERT 하는 구조라 동시 요청 두 개가 둘 다 통과합니다. 같은 event id 를 한 줄로 세우겠습니다.", [3400, 240, 6000]),
    ev(29.0, SONNET, "text", "찾았어요. 확인(SELECT)과 기록(INSERT)이 처리 앞뒤로 나뉘어 있어서 같은 이벤트가 동시에 오면 둘 다 SELECT 를 통과해요. 유니크 키를 걸고 INSERT 를 먼저 하는 쪽으로 바꿀게요.", [2800, 360, 16000]),
    ev(31.0, SONNET, "tool", 'Glob {"pattern":"migrations/*.sql"}', [1400, 40, 17000]),
    ev(31.4, SONNET, "tool_result", "migrations/0009_processed_events.sql\nmigrations/0011_refunds.sql\nmigrations/0013_invoice_notes.sql"),
    ev(33.5, CODEX, "tool", "edit src/payments/webhook.js, src/payments/locks.js", [2200, 700, 7000]),
    ev(35.0, SONNET, "tool", 'Write {"file_path":"./migrations/0014_processed_events_unique.sql","content":"ALTER TABLE processed_events\\n  ADD CONSTRAINT processed_events_event_id_key UNIQUE (event_id);\\n"}', [1900, 160, 18000]),
    ev(35.5, SONNET, "tool_result", "File created successfully at: ./migrations/0014_processed_events_unique.sql"),
    ev(38.0, SONNET, "tool", 'Edit {"file_path":"./src/payments/webhook.js","old_string":"const seen = await db.get(","new_string":"const claimed = await db.run("}', [2400, 640, 19000]),
    ev(38.6, SONNET, "tool_result", "The file ./src/payments/webhook.js has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    28\t  const event = verifySignature(req);\n    29\t  const claimed = await db.run("),
    ev(41.5, CODEX, "text", codexSum, [1800, 210, 7500], { patch: { summary: codexSum, turns: 2 } }),
    ev(43.0, SONNET, "tool", 'Bash {"command":"npx eslint src/payments migrations"}', [1300, 40, 20000]),
    ev(46.0, SONNET, "tool_result", "(no output)"),
    ev(47.2, SONNET, "text", sonnetSum, [2200, 430, 21000], { patch: { summary: sonnetSum, turns: 7 } }),
    checkStart(48.0, SONNET, "npm test", PATCH_WEBHOOK_S),
    checkStart(55.0, CODEX, "npm test", PATCH_WEBHOOK_C),
    // ---- both verifiers are still running when the demo opens (about 65 s in)
    checkPass(130.0, SONNET, "81.9", CHECK_WEBHOOK),
    checkPass(142.0, CODEX, "86.7", CHECK_WEBHOOK.replace("81937.2", "86654.8")),
    bot(142.8, "review", "둘 다 통과. sonnet 이 12초 빠르고 변경도 작아서 이걸로 추천해요", { review: { status: "pending" } }),
  ];
}

/** 김도윤 · #content-ops — the planner is still reading for ~20 s, then the agents wait for a free slot for two minutes. */
const CSV_TEXT = "@willnew 안녕하세요, 콘텐츠 일정 내보내기(CSV)에서 '게시 예정일' 열이 계속 비어서 나온다는 제보가 있어서요. 엑셀로 열어도 빈칸이에요. 확인하고 고쳐주실 수 있을까요? 감사합니다.";
function csvSteps(id: string): Step[] {
  const sonnetSum = "API v2 에서 필드 이름이 publishAt 에서 scheduledAt 으로 바뀌었는데 내보내기는 옛 이름을 읽고 있었어요. scheduledAt 을 읽도록 고쳤고 테스트는 그대로 8개 모두 통과해요.";
  const codexSum = "게시 예정일이 scheduledAt 으로 내려오는데 내보내기가 publishAt 을 읽고 있었습니다. 새 이름을 먼저 읽고 없으면 옛 이름을 쓰도록 했고, 빈 값은 빈 칸으로 처리합니다.";
  return [
    bot(0.8, "ack", "받았어요. 계획 세우는 중"),
    { ...bot(26.0, "triage", "계획: 버그 수정 · sonnet, codex 둘이 겨뤄요 · npm test"), run: {} },
    bot(26.8, "progress", "에이전트 자리가 날 때까지 기다려요 (동시 실행 2/2)"),
    begin(150.0, SONNET, id),
    begin(150.3, CODEX, id),
    ev(152.0, SONNET, "text", "내보내기 코드부터 볼게요.", [3000, 90, 8000]),
    ev(152.6, CODEX, "tool", 'shell rg -n "게시 예정일|publishAt" src', [3900, 70, 3000]),
    ev(153.1, SONNET, "tool", 'Grep {"pattern":"publishAt","path":"./src"}', [1600, 50, 10000]),
    ev(153.4, CODEX, "tool_result", "exit 0 src/export/csv.js:11:  { header: \"게시 예정일\", get: (p) => formatDate(p.publishAt) },\nsrc/api/types.js:23:  scheduledAt: string | null, // v2 (was publishAt)"),
    ev(153.7, SONNET, "tool_result", "src/export/csv.js:11:  { header: \"게시 예정일\", get: (p) => formatDate(p.publishAt) },"),
    ev(156.0, SONNET, "tool", 'Read {"file_path":"./src/api/types.js"}', [1800, 55, 12000]),
    ev(156.6, SONNET, "tool_result", cat(["// API v2 응답 형태", "export type Post = {", "  id: string, title: string,", "  scheduledAt: string | null, // v2 (was publishAt)"])),
    ev(158.5, SONNET, "text", "v2 로 바뀌면서 publishAt 이 scheduledAt 으로 이름이 바뀌었는데 csv 는 옛 이름을 읽고 있어요. 이름만 맞추면 될 것 같아요.", [2400, 300, 14000]),
    ev(162.0, CODEX, "text", "응답 타입에 scheduledAt 이 있는데 내보내기는 publishAt 을 읽습니다. 새 이름을 우선하고 옛 이름은 fallback 으로 두겠습니다.", [3300, 230, 6500]),
    ev(165.0, SONNET, "tool", 'Edit {"file_path":"./src/export/csv.js","old_string":"formatDate(p.publishAt)","new_string":"formatDate(p.scheduledAt)"}', [2000, 380, 15000]),
    ev(165.6, SONNET, "tool_result", "The file ./src/export/csv.js has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    11\t  { header: \"게시 예정일\", get: (p) => formatDate(p.scheduledAt) },"),
    ev(168.0, CODEX, "tool", "edit src/export/csv.js, src/export/format.js", [2100, 410, 7000]),
    ev(171.0, SONNET, "tool", 'Bash {"command":"node --test"}', [1500, 40, 16000]),
    ev(174.0, SONNET, "tool_result", CHECK_CSV.split("\n").slice(3).join("\n")),
    ev(176.0, SONNET, "text", sonnetSum, [1900, 260, 16500], { patch: { summary: sonnetSum, turns: 5 } }),
    checkStart(176.5, SONNET, "npm test", PATCH_CSV_S),
    checkPass(178.6, SONNET, "1.9", CHECK_CSV),
    ev(181.0, CODEX, "text", codexSum, [1700, 190, 7500], { patch: { summary: codexSum, turns: 2 } }),
    checkStart(181.5, CODEX, "npm test", PATCH_CSV_C),
    checkPass(183.8, CODEX, "2.1", CHECK_CSV),
    bot(184.6, "review", "둘 다 통과. sonnet 이 변경이 더 작아서 이걸로 추천해요", { review: { status: "pending" } }),
  ];
}

/** 정하늘 · #backend — the reviewer left a line comment, the agent is working it again (attempt 2). */
const SUMMARY_TEXT =
  "@willnew 월 청구서 요약 API(/invoices/summary) 에 고객별 최대 청구액이랑 평균을 같이 내려주고 싶어요. 지금은 합계랑 건수만 나가는데 CS 쪽에서 어느 달이 제일 컸는지 자꾸 물어봐서요. 응답은 기존 필드 그대로 두고 maxAmount, avgAmount 만 추가하면 될 것 같아요";
const SUMMARY_AGO = 9 * MIN;
const SUMMARY_COMMENT = "여기 items 비면 터질 것 같아요";
function summaryPrebuilt(id: string, createdAt: number): Run {
  const at = (s: number) => createdAt + sec(s);
  const sentAt = at(495);
  const s1: AgentRun = pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", at(3), {
    beats: [
      [1.4, "text", "summarize() 와 /invoices/summary 라우트를 볼게요."],
      [2.2, "tool", 'Read {"file_path":"./src/invoices/summary.js"}'],
      [2.8, "tool_result", cat(["import { sumBy } from \"../lib/math.js\";", "", "export function summarize(items) {", "  const total = sumBy(items, (it) => it.amount);", "  return { total, count: items.length };", "}"])],
      [9.5, "tool", 'Edit {"file_path":"./src/invoices/summary.js","old_string":"return { total, count: items.length };","new_string":"const maxAmount = items.reduce("}'],
      [10.1, "tool_result", "The file ./src/invoices/summary.js has been updated."],
      [18.0, "tool", 'Bash {"command":"node --test"}'],
      [21.5, "tool_result", CHECK_SUMMARY.split("\n").slice(3, 9).join("\n")],
      [24.0, "check", "$ npm test"],
      [26.1, "check", "검증 통과 (exit 0, 2.1 s)"],
    ],
    ms: 26 * SEC,
    attempt: 1,
    ok: true,
    out: CHECK_SUMMARY,
    checkMs: 2100,
    cost: 0.11,
    tokens: 100_000,
    summary: "응답에 maxAmount, avgAmount 를 추가했어요. 기존 필드는 그대로이고 테스트 12개 모두 통과해요.",
    patch: PATCH_SUMMARY_1,
    turns: 5,
  });
  const c1: AgentRun = pastAgent(id, 1, "codex", "codex", undefined, at(3.2), {
    beats: [
      [1.8, "tool", "shell rg -n \"summarize\" src"],
      [2.4, "tool_result", "exit 0 src/invoices/summary.js:21:export function summarize(items) {\nsrc/routes/invoices.js:48:  res.json(summarize(items));"],
      [11.0, "tool", "edit src/invoices/summary.js"],
      [19.0, "text", "maxAmount 와 avgAmount 를 추가했습니다. 빈 배열이면 0 으로 내려갑니다."],
      [22.0, "check", "$ npm test"],
      [24.3, "check", "검증 통과 (exit 0, 2.3 s)"],
    ],
    ms: 31 * SEC,
    attempt: 1,
    ok: true,
    out: CHECK_SUMMARY,
    checkMs: 2300,
    cost: null,
    tokens: 143_000,
    summary: "maxAmount 와 avgAmount 를 추가했습니다. 빈 배열이면 0 으로 내려갑니다.",
    patch: PATCH_SUMMARY_C,
    turns: 3,
  });
  // the sonnet agent was handed the comment and is running again
  const comment = `src/invoices/summary.js:24 — ${SUMMARY_COMMENT}`;
  s1.events.push(
    { ts: sentAt, kind: "steer", text: `이해준: Review comments:\n${comment}`, attempt: 1 },
    { ts: sentAt + 100, kind: "plan", text: "추가 지시를 반영해 이어서 작업", attempt: 2 },
  );
  Object.assign(s1, {
    status: "running",
    attempt: 2,
    startedAt: sentAt - (s1.durationMs ?? 0),
    endedAt: undefined,
    durationMs: undefined,
    steers: [{ text: `Review comments:\n${comment}`, by: "이해준", at: sentAt }],
  } satisfies Partial<AgentRun>);
  const reviewComment: ReviewComment = { id: "c1k2m9", agentId: s1.id, file: "src/invoices/summary.js", line: 24, text: SUMMARY_COMMENT, by: "이해준", at: at(470), sentAt };
  return {
    id,
    title: "고객별 청구 요약에 최대·평균 금액 추가",
    task: SUMMARY_TEXT.replace(/@willnew\s*/, ""),
    repo: REPO,
    baseRef: "4d9d4a5",
    baseBranch: "main",
    checkCmd: "npm test",
    createdAt,
    requester: "정하늘",
    team: "platform",
    template: "feature",
    channel: "backend",
    triage: summaryTriage(),
    review: { status: "none" },
    maxAttempts: 2,
    agents: [s1, c1],
    comments: [reviewComment],
  };
}
function summaryTriage(): Triage {
  return {
    by: "llm",
    template: "feature",
    title: "고객별 청구 요약에 최대·평균 금액 추가",
    task: "Add maxAmount and avgAmount to the /invoices/summary response without changing the existing fields. Do not modify tests. Run `npm test` to confirm.",
    plan: ["summarize() 와 /invoices/summary 라우트를 읽는다", "maxAmount, avgAmount 를 계산해 응답에 추가한다 (기존 필드 유지)", "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", "통과한 결과 중 하나를 골라 요청자 검토를 받는다"],
    agents: [{ adapter: "claude-code", model: "sonnet", label: "claude-sonnet" }, { adapter: "codex", label: "codex" }],
    check: "npm test",
    reason: "응답 필드를 늘리는 기능 요청. 테스트가 판정할 수 있어 두 에이전트를 겨루게 했어요.",
    durationMs: 21400,
    costUsd: 0.02,
  };
}
function summarySteps(_id: string): Step[] {
  const a = SUMMARY_AGO / SEC; // seconds since creation when the demo opens
  const sum = "빈 목록이면 reduce 가 TypeError 를 던지던 걸 고쳤어요. items 가 비면 maxAmount, avgAmount 를 0 으로 내려주고, 최대값은 Math.max 에 초기값 0 을 줘서 계산해요. 기존 필드는 그대로예요.";
  return [
    ev(a + 3, SONNET, "text", "빈 배열이면 reduce 에 초기값이 없어서 TypeError 가 나겠네요. 맞는 지적이에요. 빈 목록은 먼저 걸러서 0 으로 내려줄게요.", [3100, 180, 12000], { attempt: 2 }),
    ev(a + 9, SONNET, "tool", 'Read {"file_path":"./src/routes/invoices.js"}', [1900, 60, 15000], { attempt: 2 }),
    ev(a + 9.7, SONNET, "tool_result", cat(["router.get(\"/invoices/summary\", async (req, res) => {", "  const items = await listInvoices(req.query);", "  res.json(summarize(items));", "});"]), undefined, { attempt: 2 }),
    ev(a + 22, SONNET, "tool", 'Edit {"file_path":"./src/invoices/summary.js","old_string":"const total = sumBy(items, (it) => it.amount);","new_string":"const total = sumBy(items, (it) => it.amount);\\n  if (items.length === 0) return { total: 0, count: 0, maxAmount: 0, avgAmount: 0 };"}', [2500, 610, 17000], { attempt: 2 }),
    ev(a + 22.6, SONNET, "tool_result", "The file ./src/invoices/summary.js has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    22\t  const total = sumBy(items, (it) => it.amount);\n    23\t  if (items.length === 0) return { total: 0, count: 0, maxAmount: 0, avgAmount: 0 };", undefined, { attempt: 2 }),
    ev(a + 34, SONNET, "tool", 'Edit {"file_path":"./src/invoices/summary.js","old_string":"items.reduce((m, it) => (it.amount > m.amount ? it : m)).amount","new_string":"items.reduce((m, it) => Math.max(m, it.amount), 0)"}', [2300, 450, 18500], { attempt: 2 }),
    ev(a + 34.5, SONNET, "tool_result", "The file ./src/invoices/summary.js has been updated.", undefined, { attempt: 2 }),
    ev(a + 47, SONNET, "tool", 'Bash {"command":"node --test"}', [1500, 40, 19500], { attempt: 2 }),
    ev(a + 52, SONNET, "tool_result", CHECK_SUMMARY.split("\n").slice(3, 9).join("\n"), undefined, { attempt: 2 }),
    ev(a + 58, SONNET, "text", sum, [2100, 360, 20000], { attempt: 2, patch: { summary: sum, turns: 9 } }),
    checkStart(a + 62, SONNET, "npm test", PATCH_SUMMARY_2, 2),
    checkPass(a + 64.3, SONNET, "2.3", CHECK_SUMMARY, 2),
    bot(a + 65, "review", "둘 다 통과. codex 가 빠르고 변경도 작아서 이걸로 추천해요. sonnet 은 줄 댓글을 반영했어요", { review: { status: "pending" } }),
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
  if (!m.bot && !m.userTitle) m.userTitle = titleOf(m.user);
  if (!m.bot && !m.userAvatar) m.userAvatar = avatarOf(m.user);
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
        runPatch.title = live.triage.title;
        runPatch.template = live.triage.template;
        runPatch.agents = live.agentSpecs.map((a) => ({ ...a, startedAt: ts + 300 }));
      }
      if (s.run.review) runPatch.review = { ...live.run.review, ...s.run.review };
      emit(live, { runId: live.run.id, run: runPatch });
    }
    if (s.agent != null) {
      const a = live.run.agents[s.agent];
      if (!a || a.status === "cancelled") continue;
      const patch: Partial<AgentRun> = { ...(s.patch ?? {}) };
      if (patch.status === "running" && a.status === "queued") patch.startedAt = ts;
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
    if (s.chat) pushChat({ ...s.chat, text: s.late ? s.late(live) : s.chat.text, id: `m${++msgSeq}`, channel: live.channel, ts, runId: live.run.id });
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

/** 에이전트 하나만 도는 판: codex 줄을 빼고, 끝나는 시각과 안내 문구를 sonnet 에 맞춘다. */
const SOLO_TEXT: [string | RegExp, string][] = [
  [/계획: (.+) · sonnet, codex 둘이 겨뤄요/, "계획: $1 · 에이전트 1개 (sonnet)"],
  ["둘 다 통과. sonnet 이 8초 빠르고 변경도 작아서 이걸로 추천해요", "sonnet 통과. 테스트 7개 모두 통과했어요"],
  ["둘 다 통과. sonnet 이 12초 빠르고 변경도 작아서 이걸로 추천해요", "sonnet 통과. 테스트 14개 모두 통과했어요"],
  ["둘 다 통과. sonnet 이 변경이 더 작아서 이걸로 추천해요", "sonnet 통과. 테스트 8개 모두 통과했어요"],
  ["통과한 결과가 없어요. 둘 다 2차 시도까지 실패했어요", "통과한 결과가 없어요. 2차 시도까지 실패했어요"],
];
function soloSteps(steps: Step[]): Step[] {
  const mine = steps.filter((s) => s.agent !== CODEX);
  const lastSonnet = Math.max(...mine.filter((s) => s.agent === SONNET).map((s) => s.at));
  return mine
    .map((s) => {
      if (!s.chat) return s;
      let text = s.chat.text;
      for (const [from, to] of SOLO_TEXT) text = text.replace(from, to);
      const late = s.agent == null && s.at > lastSonnet && (s.chat.kind === "review" || s.chat.kind === "result");
      return { ...s, at: late ? lastSonnet : s.at, chat: { ...s.chat, text } };
    })
    .sort((a, b) => a.at - b.at);
}

/** 내 차례가 되면 채널 검토자(요청자가 아닌 첫 사람)에게 멘션을 건다. 서버 chat.ts 와 같은 문장이다. */
function withMentions(steps: Step[], channel: string, requester: string): Step[] {
  const reviewer = pickReviewer(CHANNELS.find((c) => c.id === channel), requester);
  if (!reviewer) return steps;
  const out: Step[] = [];
  for (const s of steps) {
    out.push(s);
    if (s.chat?.kind === "review")
      out.push({
        at: s.at + 400,
        chat: { user: "willnew", bot: true, kind: "review", text: "" },
        late: (live) => {
          const id = pickWinner(live.run);
          return reviewMessage(reviewer, live.run.agents.find((a) => a.id === id) ?? live.run.agents[0], live.run.baseBranch, false);
        },
      });
  }
  return out;
}

const BASE_REFS: Record<string, string> = { backend: "4d9d4a5", cs: "4d9d4a5", web: "e71b0c8", data: "9f23a6d", "content-ops": "30c8b1e" };
let runSeq = 0;
function launch(sc: Scenario): Run {
  const createdAt = Date.now() - sc.ago;
  const id = `r-${(createdAt % 1e6).toString(36)}${++runSeq}`;
  const channel = CHANNELS.find((c) => c.id === sc.channel);
  const tpl = sc.template ? TEMPLATES.find((t) => t.id === sc.template)! : routeTemplate(sc.text);
  const clean = sc.text.replace(/@willnew\s*/g, "").trim();
  const agents = sc.agents ?? [SONNET_SPEC];
  const check = sc.check ?? "npm test";
  const race = agents.length > 1;
  const triage: Triage = {
    by: "llm",
    template: tpl.id,
    title: sc.title ?? clean.slice(0, 60),
    task: `${clean}\n\n${sc.task ?? "Find the root cause and fix it. Do not modify tests. Run `npm test` to confirm."}`,
    plan: (sc.plan ?? ["관련 코드를 읽고 원인을 찾는다", "고친다 (테스트는 수정 금지)", `${check} 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다`, REVIEW_STEP_PLAN]).map((l) => (!race && l === REVIEW_STEP_PLAN ? REVIEW_STEP_SOLO : l)),
    agents,
    check,
    reason: sc.reason ?? `${tpl.name} 요청이에요. 테스트가 판정할 수 있어 ${race ? "두 에이전트를 겨루게 하고" : "에이전트 하나로 시작하고"} 자기 수정 1회를 허용.`,
    durationMs: sc.triageMs ?? 21400,
    costUsd: 0.02,
  };
  const run: Run =
    sc.prebuilt?.(id, createdAt) ?? {
      id,
      title: clean.slice(0, 60),
      task: clean,
      repo: channel?.repo ?? REPO,
      baseRef: BASE_REFS[sc.channel] ?? "4d9d4a5",
      baseBranch: "main",
      checkCmd: check,
      createdAt,
      requester: sc.requester,
      requesterTitle: sc.requesterTitle ?? titleOf(sc.requester),
      requesterAvatar: avatarOf(sc.requester),
      team: sc.team,
      template: tpl.id,
      channel: sc.channel,
      review: { status: "none" },
      maxAttempts: 2,
      agents: [],
    };
  const agentSpecs = agents.map((a, i) => blank(id, i, a.adapter, a.label ?? a.adapter, a.model, createdAt));
  const steps = withMentions(race ? sc.steps(id, sc.requester) : soloSteps(sc.steps(id, sc.requester)), sc.channel, sc.requester);
  const live: Live = { run, channel: sc.channel, steps, cursor: 0, triage, agentSpecs };
  lives.set(id, live);
  pushChat({ id: `m${++msgSeq}`, channel: sc.channel, ts: createdAt, user: sc.requester, userTitle: sc.requesterTitle ?? titleOf(sc.requester), bot: false, text: sc.text });
  tickOne(live, Date.now()); // fast-forward steps that are already in the past
  ensureTicker();
  return run;
}

/** A request typed into the demo composer: the scripted renewal-date race, whatever the text says. */
function spawn(channel: string, requester: string, team: string, text: string, race: boolean, title?: string, ago = 0): Run {
  return launch({ ...renewalScenario(channel, requester, team, text, ago, race), requesterTitle: title });
}

// ---------------------------------------------------------------------------------------------- history

interface PastAgentOpts {
  /** [seconds after the agent started, kind, text] — attempt number is inferred from "자가 수정" / 재시도 plan lines */
  beats: [number, Kind, string][];
  ms: number;
  attempt: number;
  ok: boolean;
  out: string;
  checkMs: number;
  cost: number | null;
  tokens: number;
  summary: string;
  patch: string;
  turns: number;
  /** first attempt failed with this output before the final one */
  firstFail?: string;
}

function pastAgent(runId: string, i: number, label: string, adapter: string, model: string | undefined, start: number, o: PastAgentOpts): AgentRun {
  let attempt = 1;
  const events: AgentEvent[] = [{ ts: start, kind: "status", text: `작업 시작 · ~/.willnew/worktrees/${runId}/${label}`, attempt: 1 }];
  for (const [at, kind, text] of o.beats) {
    if (kind === "plan" && /다시 시도/.test(text)) attempt++;
    events.push({ ts: start + sec(at), kind, text, attempt });
  }
  return {
    id: `${runId}-a${i}`,
    adapter,
    label,
    model,
    branch: `willnew/${runId}/${label}`,
    worktree: "",
    status: "done",
    attempt: o.attempt,
    startedAt: start,
    endedAt: start + o.ms,
    durationMs: o.ms,
    turns: o.turns,
    usage: { inputTokens: Math.round(o.tokens * 0.2), outputTokens: Math.round(o.tokens * 0.02), cachedTokens: Math.round(o.tokens * 0.78), costUsd: o.cost },
    summary: o.summary,
    check: o.out ? { status: o.ok ? "passed" : "failed", exitCode: o.ok ? 0 : 1, output: o.out, durationMs: o.checkMs } : { status: "skipped", exitCode: null, output: "" },
    diff: diffOf(o.patch),
    merged: false,
    events,
  };
}

const CHECK_FAIL_LINE = (secs: string) => `검증 실패 (exit 1, ${secs} s)`;
const RETRY_LINE = "검증 실패 → 실패 로그를 돌려주고 다시 시도 (2/2)";

interface Past {
  id: string;
  /** 에이전트 하나만 돈 기록(기본). 겨루기 기록은 비워 둔다 */
  single?: boolean;
  /** 승인 뒤 CI 에서 lint 가 빨개서 멈춘 기록 */
  ciFail?: boolean;
  /** 승인된 결과의 "요청자에게" 한 줄 */
  note?: string;
  ago: number;
  channel: string;
  requester: string;
  team: string;
  template: string;
  title: string;
  text: string;
  check: string;
  plan: string[];
  review: Run["review"];
  agents: (start: number, id: string) => AgentRun[];
}

const PATCH_RECEIPT = `diff --git a/src/mail/receipt.js b/src/mail/receipt.js
index 5b1c9a3..e24d70f 100644
--- a/src/mail/receipt.js
+++ b/src/mail/receipt.js
@@ -14,6 +14,7 @@ export function receiptLines(order) {
   const lines = order.items.map((it) => ({ label: it.name, amount: it.price * it.qty }));
-  const refunded = order.refunds.reduce((s, r) => s + r.amount + r.fee, 0);
-  lines.push({ label: "환불", amount: -refunded });
-  lines.push({ label: "환불 수수료", amount: order.refunds.reduce((s, r) => s + r.fee, 0) });
+  const refunded = order.refunds.reduce((s, r) => s + r.amount, 0);
+  const fee = order.refunds.reduce((s, r) => s + r.fee, 0);
+  lines.push({ label: "환불", amount: -refunded });
+  if (fee) lines.push({ label: "환불 수수료", amount: fee });
   return lines;
 }
`;
const RECEIPT_TESTS = names(["items only", "partial refund", "full refund", "refund fee shown once", "no fee hides the line", "two refunds"]);
const CHECK_RECEIPT = nodeOut("billing-api@2.3.0", RECEIPT_TESTS, undefined, "41.2");

const PAST: Past[] = [
  // 정하늘 · 병합 — 짧은 승인 코멘트
  {
    id: "r-8c1",
    single: true,
    note: "주문 목록 API 가 빈 페이지나 limit=0 요청에도 에러 대신 정상으로 응답해요.",
    ago: 3.4 * HOUR,
    channel: "backend",
    requester: "정하늘",
    team: "platform",
    template: "bugfix",
    title: "주문 목록 API 에서 limit=0, 빈 페이지일 때 500",
    text: "@willnew 주문 목록 API 에서 limit=0 으로 부르면 500 나요. 로그: TypeError: Cannot read properties of undefined (reading 'total') at listOrders (src/orders/list.js:12). 빈 페이지일 때도 같은 에러라 rows[0].total 쓰는 쪽이 문제인 듯해요 (#377)",
    check: "npm test",
    plan: ["limit=0 과 빈 페이지로 500 을 재현한다", "src/orders/list.js 에서 total 을 구하는 방식을 고친다 (테스트는 수정 금지)", "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", "통과한 결과 중 하나를 골라 요청자 검토를 받는다"],
    review: { status: "approved", reviewer: "이해준", agentId: "r-8c1-a0", at: 0, comment: "ㅇㅋ 반영" },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, {
        beats: [
          [1.3, "text", "listOrders 에서 `rows[0].total` 을 읽는데 결과가 비면 undefined 라 터져요. 건수는 따로 COUNT 로 구할게요."],
          [2.1, "tool", 'Read {"file_path":"./src/orders/list.js"}'],
          [2.7, "tool_result", cat(["const MAX_LIMIT = 100;", "", "export async function listOrders(db, { page = 1, limit = 20 } = {}) {", "  const size = Math.min(limit, MAX_LIMIT);", "  const offset = (page - 1) * size;"])],
          [6.5, "tool", 'Edit {"file_path":"./src/orders/list.js","old_string":"const total = rows[0].total;","new_string":"const [{ total }] = await db.all(\\"SELECT COUNT(*) AS total FROM orders\\");"}'],
          [7.1, "tool_result", "The file ./src/orders/list.js has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    13\t  const [{ total }] = await db.all(\"SELECT COUNT(*) AS total FROM orders\");"],
          [11.0, "tool", 'Bash {"command":"node --test"}'],
          [13.8, "tool_result", CHECK_ORDERS.split("\n").slice(3, 8).join("\n")],
          [15.5, "text", "total 을 COUNT 로 따로 구하고 limit 은 1 이상으로 맞췄어요. 빈 페이지도 lastPage 1 로 나가요. 9개 테스트 모두 통과해요."],
          [16.0, "check", "$ npm test"],
          [17.4, "check", "검증 통과 (exit 0, 1.4 s)"],
        ],
        ms: 18 * SEC,
        attempt: 1,
        ok: true,
        out: CHECK_ORDERS,
        checkMs: 1400,
        cost: 0.1,
        tokens: 121_000,
        summary: "total 을 COUNT 로 따로 구하고 limit 은 1 이상으로 맞췄어요. 빈 페이지도 lastPage 1 로 나가요. 9개 테스트 모두 통과해요.",
        patch: PATCH_ORDERS_S,
        turns: 5,
      }),
      pastAgent(id, 1, "codex", "codex", undefined, s, {
        beats: [
          [1.6, "tool", 'shell rg -n "total" src/orders'],
          [2.3, "tool_result", "exit 0 src/orders/list.js:12:  const total = rows[0].total;"],
          [9.0, "tool", "edit src/orders/list.js"],
          [22.0, "tool", "shell node --test"],
          [26.5, "tool_result", "exit 0 ℹ tests 9\nℹ pass 9\nℹ fail 0"],
          [28.0, "text", "빈 결과에서 rows[0] 을 읽지 않도록 total 을 COUNT 쿼리로 바꿨습니다. limit 이 0 이하면 20 으로 대체합니다."],
          [29.0, "check", "$ npm test"],
          [30.6, "check", "검증 통과 (exit 0, 1.5 s)"],
        ],
        ms: 31 * SEC,
        attempt: 1,
        ok: true,
        out: CHECK_ORDERS,
        checkMs: 1500,
        cost: null,
        tokens: 177_000,
        summary: "빈 결과에서 rows[0] 을 읽지 않도록 total 을 COUNT 쿼리로 바꿨습니다. limit 이 0 이하면 20 으로 대체합니다.",
        patch: PATCH_ORDERS_C,
        turns: 3,
      }),
    ],
  },
  // 박서윤 · 내 차례 — sonnet 은 자기 수정 후 통과하면서 테스트 파일을 고쳤다, codex 는 둘 다 실패
  {
    id: "r-7f4",
    ago: 38 * MIN,
    channel: "data",
    requester: "박서윤",
    team: "data",
    template: "refactor",
    title: "settle_daily 중복 제거 로직 하나로 합치기",
    text: "@willnew settle_daily 중복 제거 로직 세 군데 복붙돼있어요 하나로 합쳐주세요 동작은 그대로. pytest 38개 지금 다 통과 상태고 끝나도 38개여야 해요",
    check: "pytest -q",
    plan: ["중복 제거가 있는 세 곳(settle_daily, settle_weekly, reprocess)을 찾는다", "settle/dedupe.py 하나로 합치고 호출부를 바꾼다 (동작은 그대로)", "pytest -q 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", "통과한 결과 중 하나를 골라 요청자 검토를 받는다"],
    review: { status: "pending" },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, {
        beats: [
          [1.5, "text", "중복 제거가 settle_daily, settle_weekly, reprocess 세 군데에 있네요. 공통 함수로 뽑을게요."],
          [2.3, "tool", 'Grep {"pattern":"seen\\\\[","path":"./settle"}'],
          [2.9, "tool_result", "settle/settle_daily.py:15:        seen[(r[\"order_id\"], r[\"line\"])] = r\nsettle/settle_weekly.py:9:        seen[(r[\"order_id\"], r[\"line\"])] = r\nsettle/reprocess.py:11:        seen[(r[\"order_id\"], r[\"line\"])] = r"],
          [12.0, "tool", 'Write {"file_path":"./settle/dedupe.py"}'],
          [12.5, "tool_result", "File created successfully at: ./settle/dedupe.py"],
          [26.0, "tool", 'Edit {"file_path":"./settle/settle_weekly.py","old_string":"def _dedupe_rows(rows):","new_string":""}'],
          [26.6, "tool_result", "The file ./settle/settle_weekly.py has been updated."],
          [64.0, "text", "세 곳 모두 dedupe() 를 쓰도록 바꿨어요. 검증 돌릴게요."],
          [68.0, "check", "$ pytest -q"],
          [70.4, "check", CHECK_FAIL_LINE("2.4")],
          [70.8, "plan", RETRY_LINE],
          [73.0, "text", "테스트가 settle_weekly 의 비공개 헬퍼 _dedupe_rows 를 직접 import 하고 있었네요. 헬퍼를 없앴으니 테스트도 새 함수를 쓰도록 import 만 바꿀게요."],
          [76.0, "tool", 'Edit {"file_path":"./tests/test_settle.py","old_string":"from settle.settle_weekly import _dedupe_rows","new_string":"from settle.dedupe import dedupe"}'],
          [76.6, "tool_result", "The file ./tests/test_settle.py has been updated."],
          [100.0, "tool", 'Bash {"command":"pytest -q"}'],
          [103.0, "tool_result", PYTEST_OK],
          [108.0, "text", "중복 제거를 settle/dedupe.py 하나로 합쳤어요. 테스트 하나가 비공개 헬퍼를 직접 import 해서 그 import 한 줄을 바꿨고, 38개 모두 통과해요."],
          [109.0, "check", "$ pytest -q"],
          [111.4, "check", "검증 통과 (exit 0, 2.4 s)"],
        ],
        ms: 112 * SEC,
        attempt: 2,
        ok: true,
        out: PYTEST_OK,
        checkMs: 2400,
        cost: 0.17,
        tokens: 252_000,
        summary: "중복 제거를 settle/dedupe.py 하나로 합쳤어요. 테스트 하나가 비공개 헬퍼를 직접 import 해서 그 import 한 줄을 바꿨고, 38개 모두 통과해요.",
        patch: PATCH_SETTLE_S,
        turns: 11,
      }),
      pastAgent(id, 1, "codex", "codex", undefined, s, {
        beats: [
          [2.0, "tool", 'shell rg -n "seen\\[" settle'],
          [2.7, "tool_result", "exit 0 settle/settle_daily.py:15:        seen[(r[\"order_id\"], r[\"line\"])] = r\nsettle/settle_weekly.py:9:        seen[(r[\"order_id\"], r[\"line\"])] = r"],
          [14.0, "tool", "edit settle/dedupe.py, settle/settle_daily.py, settle/settle_weekly.py"],
          [60.0, "text", "settle_daily 와 settle_weekly 를 dedupe() 로 바꿨습니다."],
          [63.0, "check", "$ pytest -q"],
          [65.4, "check", CHECK_FAIL_LINE("2.4")],
          [65.8, "plan", RETRY_LINE],
          [90.0, "tool", "edit settle/dedupe.py"],
          [101.0, "tool", "shell pytest -q"],
          [105.0, "tool_result", "exit 1 1 failed, 37 passed in 2.51s"],
          [111.0, "check", "$ pytest -q"],
          [113.5, "check", CHECK_FAIL_LINE("2.5")],
        ],
        ms: 114 * SEC,
        attempt: 2,
        ok: false,
        out: PYTEST_FAIL_C2,
        checkMs: 2500,
        cost: null,
        tokens: 301_000,
        summary: "dedupe 키를 order_id 로만 잡아서 같은 주문의 여러 줄이 합쳐졌습니다. 고치려 했지만 기존 테스트의 import 와 맞지 않아 검증을 통과하지 못했습니다.",
        patch: PATCH_SETTLE_C,
        turns: 6,
      }),
    ],
  },
  // 김도윤 · 병합
  {
    id: "r-6a2",
    note: "수집기 README 가 지금 CLI 옵션 기준으로 바뀌었어요.",
    ago: 5.5 * HOUR,
    channel: "content-ops",
    requester: "김도윤",
    team: "content-ops",
    template: "docs",
    title: "메타데이터 수집기 README 를 지금 CLI 옵션으로 고침",
    text: "@willnew 메타데이터 수집기 README 옵션이 예전꺼라 신입분들이 계속 물어봐요ㅠ 지금 CLI 기준으로 고쳐주실 수 있나요?",
    check: "",
    plan: ["metacollect --help 와 cli.py 의 옵션을 읽는다", "README 의 사용법과 옵션 표를 현재 옵션으로 고친다", "변경 내용을 요약한다"],
    review: { status: "approved", reviewer: "김도윤", agentId: "r-6a2-a0", at: 0, comment: "확인했습니다 감사합니다" },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, {
        beats: [
          [1.4, "text", "CLI 정의부터 확인할게요."],
          [2.0, "tool", 'Read {"file_path":"./metacollect/cli.py"}'],
          [2.6, "tool_result", cat(["import argparse", "", "def build_parser():", "    p = argparse.ArgumentParser(prog=\"metacollect\")", "    sub = p.add_subparsers(dest=\"cmd\", required=True)"])],
          [5.5, "tool", 'Bash {"command":"python -m metacollect run --help"}'],
          [6.8, "tool_result", "usage: metacollect run [-h] [--output OUTPUT] [--format {json,csv,parquet}] [--jobs JOBS] [--since SINCE] [--dry-run] src"],
          [10.0, "tool", 'Read {"file_path":"./README.md"}'],
          [10.6, "tool_result", cat(["# metacollect", "", "폴더 안 파일의 메타데이터(크기, 수정일, 해시)를 모아 JSON 이나 CSV 로 내보냅니다."])],
          [21.0, "tool", 'Edit {"file_path":"./README.md","old_string":"metacollect --src ./data --out ./out --fmt json","new_string":"metacollect run ./data --output ./out --format json"}'],
          [21.6, "tool_result", "The file ./README.md has been updated."],
          [29.0, "text", "README 의 사용법 예시와 옵션 표를 현재 CLI 기준으로 고쳤어요. --src/--out/--fmt/--workers 는 각각 인자, --output, --format, --jobs 로 바뀌었고, --since 와 --dry-run 은 표에 새로 넣었어요."],
        ],
        ms: 32 * SEC,
        attempt: 1,
        ok: true,
        out: "",
        checkMs: 0,
        cost: 0.08,
        tokens: 89_000,
        summary: "README 의 사용법 예시와 옵션 표를 현재 CLI 기준으로 고쳤어요. --src/--out/--fmt/--workers 는 각각 인자, --output, --format, --jobs 로 바뀌었고, --since 와 --dry-run 은 표에 새로 넣었어요.",
        patch: PATCH_README,
        turns: 5,
      }),
    ],
  },
  // 최민재 · 병합
  {
    id: "r-4e7",
    single: true,
    ciFail: true,
    note: "화면에서 보이는 변화는 없어요. 버튼 종류를 잘못 적으면 개발 중에 바로 알려줘요.",
    ago: 1.1 * DAY,
    channel: "web",
    requester: "최민재",
    team: "platform",
    template: "refactor",
    title: "Button variant 문자열을 유니온 타입으로",
    text: "@willnew Button variant 문자열 여기저기 하드코딩돼있음.. 유니온 타입으로 빼주라. 동작은 그대로",
    check: "npm test",
    plan: ["Button 과 variant 를 쓰는 곳을 찾는다", "ButtonVariant 유니온 타입을 만들고 쓰는 곳을 맞춘다 (동작은 그대로)", "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", "통과한 결과 중 하나를 골라 요청자 검토를 받는다"],
    review: { status: "approved", reviewer: "이해준", agentId: "r-4e7-a0", at: 0, comment: "굿" },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, {
        beats: [
          [1.2, "text", "variant 를 쓰는 곳부터 찾아볼게요."],
          [1.8, "tool", 'Grep {"pattern":"variant=","path":"./src"}'],
          [2.4, "tool_result", "src/pages/InvoiceDetail.tsx:41:      <Button variant=\"danger-outline\" onClick={onVoid}>\nsrc/pages/InvoiceList.tsx:57:      <Button variant=\"secondary\" onClick={reload}>\nsrc/pages/Settings.tsx:88:      <Button variant=\"primary\" type=\"submit\">"],
          [8.0, "tool", 'Edit {"file_path":"./src/components/Button.tsx","old_string":"variant?: string;","new_string":"variant?: ButtonVariant;"}'],
          [8.6, "tool_result", "The file ./src/components/Button.tsx has been updated."],
          [15.0, "tool", 'Edit {"file_path":"./src/pages/InvoiceDetail.tsx","old_string":"variant=\\"danger-outline\\"","new_string":"variant=\\"danger\\""}'],
          [15.6, "tool_result", "The file ./src/pages/InvoiceDetail.tsx has been updated."],
          [22.0, "tool", 'Bash {"command":"npx tsc --noEmit && npx vitest run"}'],
          [26.8, "tool_result", CHECK_BUTTON.split("\n").slice(3, 12).join("\n")],
          [31.0, "text", "ButtonVariant 유니온(primary, secondary, ghost, danger)을 만들고 쓰는 곳을 맞췄어요. 타입에 없던 danger-outline 하나는 danger 로 바꿨어요. 테스트 26개 통과해요."],
          [32.0, "check", "$ npm test"],
          [34.1, "check", "검증 통과 (exit 0, 2.1 s)"],
        ],
        ms: 35 * SEC,
        attempt: 1,
        ok: true,
        out: CHECK_BUTTON,
        checkMs: 2100,
        cost: 0.13,
        tokens: 156_000,
        summary: "ButtonVariant 유니온(primary, secondary, ghost, danger)을 만들고 쓰는 곳을 맞췄어요. 타입에 없던 danger-outline 하나는 danger 로 바꿨어요. 테스트 26개 통과해요.",
        patch: PATCH_BUTTON,
        turns: 6,
      }),
      pastAgent(id, 1, "codex", "codex", undefined, s, {
        beats: [
          [2.0, "tool", 'shell rg -n "variant" src'],
          [2.8, "tool_result", "exit 0 src/components/Button.tsx:4:  variant?: string;\nsrc/pages/InvoiceDetail.tsx:41:      <Button variant=\"danger-outline\" onClick={onVoid}>"],
          [14.0, "tool", "edit src/components/Button.tsx, src/pages/InvoiceDetail.tsx"],
          [38.0, "tool", "shell npm test"],
          [43.0, "tool_result", "exit 0 Test Files  4 passed (4)\n      Tests  26 passed (26)"],
          [46.0, "text", "variant 타입을 유니온으로 바꾸고 호출부를 맞췄습니다."],
          [47.0, "check", "$ npm test"],
          [49.6, "check", "검증 통과 (exit 0, 2.2 s)"],
        ],
        ms: 51 * SEC,
        attempt: 1,
        ok: true,
        out: CHECK_BUTTON,
        checkMs: 2200,
        cost: null,
        tokens: 204_000,
        summary: "variant 타입을 유니온으로 바꾸고 호출부를 맞췄습니다.",
        patch: PATCH_BUTTON,
        turns: 3,
      }),
    ],
  },
  // 정하늘 · 반려
  {
    id: "r-5d9",
    single: true,
    ago: 1.6 * DAY,
    channel: "backend",
    requester: "정하늘",
    team: "platform",
    template: "bugfix",
    title: "로그인 세션 만료 시간이 9시간 어긋남",
    text: "@willnew 로그인 세션 만료 시간이 9시간씩 어긋나요. 어제 배포 이후부터 고객 문의 3건 들어옴. createSession 에서 expiresAt 계산하는 쪽 같은데 시간은 다 UTC 로 맞춰놨다고 알고 있어서 원인은 잘 모르겠어요",
    check: "npm test",
    plan: ["createSession 의 expiresAt 계산과 테스트를 읽는다", "9시간 어긋나는 원인을 찾아 고친다 (테스트는 수정 금지)", "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", "통과한 결과 중 하나를 골라 요청자 검토를 받는다"],
    review: { status: "rejected", reviewer: "정하늘", comment: "증상만 가렸어요. 서버 TZ 설정 문제라 제가 직접 볼게요", at: 0 },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, {
        beats: [
          [1.4, "text", "createSession 부터 볼게요."],
          [2.0, "tool", 'Read {"file_path":"./src/auth/session.js"}'],
          [2.6, "tool_result", cat(["export function createSession(userId, now = new Date()) {", "  const ttlMs = SESSION_TTL_HOURS * 3600 * 1000;", "  const expiresAt = new Date(now.getTime() + ttlMs);"])],
          [9.0, "text", "코드상 계산은 맞는데 9시간 차이가 나면 KST 오프셋 같아요. 만료 시각에 오프셋만큼 보정을 넣을게요."],
          [14.0, "tool", 'Edit {"file_path":"./src/auth/session.js","old_string":"new Date(now.getTime() + ttlMs)","new_string":"new Date(now.getTime() + ttlMs + 9 * 3600 * 1000)"}'],
          [14.6, "tool_result", "The file ./src/auth/session.js has been updated."],
          [30.0, "tool", 'Bash {"command":"node --test"}'],
          [33.5, "tool_result", CHECK_SESSION_OK.split("\n").slice(3, 8).join("\n")],
          [50.0, "text", "만료 시각에 9시간 보정을 넣었어요. 기존 테스트 7개 모두 통과해요."],
          [51.0, "check", "$ npm test"],
          [52.9, "check", "검증 통과 (exit 0, 1.9 s)"],
        ],
        ms: 54 * SEC,
        attempt: 1,
        ok: true,
        out: CHECK_SESSION_OK,
        checkMs: 1900,
        cost: 0.12,
        tokens: 140_000,
        summary: "만료 시각에 9시간 보정을 넣었어요. 기존 테스트 7개 모두 통과해요.",
        patch: PATCH_SESSION,
        turns: 4,
      }),
      pastAgent(id, 1, "codex", "codex", undefined, s, {
        beats: [
          [1.8, "tool", 'shell rg -n "expiresAt" src test'],
          [2.5, "tool_result", "exit 0 src/auth/session.js:19:  const expiresAt = new Date(now.getTime() + ttlMs);\ntest/session.test.js:35:  assert.equal(s.expiresAt, '2026-10-05T08:00:00.000Z');"],
          [20.0, "tool", "edit src/auth/session.js"],
          [66.0, "text", "만료 시각을 UTC 기준 시각으로 계산하도록 바꿨습니다."],
          [67.0, "check", "$ npm test"],
          [68.8, "check", CHECK_FAIL_LINE("1.8")],
          [69.2, "plan", RETRY_LINE],
          [95.0, "tool", "edit src/auth/session.js"],
          [112.0, "text", "시각 계산을 다시 고쳤습니다."],
          [113.0, "check", "$ npm test"],
          [114.9, "check", CHECK_FAIL_LINE("1.9")],
        ],
        ms: 116 * SEC,
        attempt: 2,
        ok: false,
        out: CHECK_SESSION_FAIL,
        checkMs: 1900,
        cost: null,
        tokens: 331_000,
        summary: "시각 계산을 다시 고쳤지만 expires in utc 테스트를 통과하지 못했습니다.",
        patch: PATCH_SESSION_C,
        turns: 5,
      }),
    ],
  },
  // 윤서아 · #cs — 하루쯤 전에 맡겨 이미 반영된 것
  {
    id: "r-cs1",
    single: true,
    note: "부분 환불한 고객 영수증 메일에 환불 수수료가 한 번만 나와요. 이미 나간 메일은 그대로예요.",
    ago: 5.2 * HOUR,
    channel: "cs",
    requester: "윤서아",
    team: "cs",
    template: "bugfix",
    title: "부분 환불 영수증에 환불 수수료가 두 번 나옴",
    text: "@willnew 부분 환불한 고객 영수증 메일에 환불 수수료가 두 번 찍혀서 나간대요. 고객이 금액이 이상하다고 문의 주셨어요 #418",
    check: "npm test",
    plan: ["부분 환불 주문으로 영수증 줄을 재현한다", "src/mail/receipt.js 에서 수수료가 두 번 들어가는 곳을 고친다 (테스트는 수정 금지)", "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", REVIEW_STEP_PLAN],
    review: { status: "approved", reviewer: "이해준", agentId: "r-cs1-a0", at: 0, comment: "확인했어요" },
    agents: (s, id) => [
      pastAgent(id, 0, "claude-sonnet", "claude-code", "sonnet", s, {
        beats: [
          [1.2, "text", "receiptLines 에서 환불 금액에 수수료를 더하고, 수수료 줄을 또 넣고 있어요. 수수료는 한 줄로만 나오게 할게요."],
          [2.0, "tool", 'Read {"file_path":"./src/mail/receipt.js"}'],
          [2.6, "tool_result", cat(["export function receiptLines(order) {", "  const lines = order.items.map((it) => ({ label: it.name, amount: it.price * it.qty }));", "  const refunded = order.refunds.reduce((s, r) => s + r.amount + r.fee, 0);"])],
          [6.0, "tool", 'Edit {"file_path":"./src/mail/receipt.js","old_string":"s + r.amount + r.fee","new_string":"s + r.amount"}'],
          [6.6, "tool_result", "The file ./src/mail/receipt.js has been updated."],
          [9.5, "tool", 'Bash {"command":"node --test"}'],
          [11.8, "tool_result", CHECK_RECEIPT.split("\n").slice(3, 8).join("\n")],
          [13.0, "text", "환불 금액과 수수료를 따로 계산하고, 수수료가 0이면 줄을 빼요. 테스트 6개 모두 통과해요."],
          [13.4, "check", "$ npm test"],
          [14.6, "check", "검증 통과 (exit 0, 1.2 s)"],
        ],
        ms: 15 * SEC,
        attempt: 1,
        ok: true,
        out: CHECK_RECEIPT,
        checkMs: 1200,
        cost: 0.08,
        tokens: 94_000,
        summary: "환불 금액과 수수료를 따로 계산하고, 수수료가 0이면 줄을 빼요. 테스트 6개 모두 통과해요.",
        patch: PATCH_RECEIPT,
        turns: 4,
      }),
    ],
  },
];

const PR_NO: Record<string, number> = { "r-8c1": 497, "r-6a2": 503, "r-4e7": 506, "r-cs1": 509 };
const CHECK_NAMES = ["test (node 20)", "lint", "build"];
const prUrl = (n: number) => `https://github.com/acme/billing-api/pull/${n}`;
/** 지난 기록의 배포 줄: 대부분 배포까지 갔고, 하나는 lint 때문에 CI 에서 멈췄다. */
function pastShip(p: Past, run: Run): Ship {
  const prNumber = PR_NO[p.id] ?? 500;
  const at = (run.review.at ?? run.createdAt) + 4 * MIN;
  if (p.ciFail) return { mode: "pr", stage: "ci_failed", prNumber, prUrl: prUrl(prNumber), checks: CHECK_NAMES.map((name) => ({ name, state: name === "lint" ? "fail" : "pass" })), env: "production", at };
  return { mode: "pr", stage: "deployed", prNumber, prUrl: prUrl(prNumber), checks: CHECK_NAMES.map((name) => ({ name, state: "pass" as const })), env: "production", at };
}

function buildPast(p: Past): Run {
  const createdAt = T0 - p.ago;
  const agents = p.single ? p.agents(createdAt + 2 * SEC, p.id).slice(0, 1) : p.agents(createdAt + 2 * SEC, p.id);
  const noted = agents.find((x) => x.id === p.review.agentId) ?? agents[0];
  if (p.note && noted) noted.userNote = p.note;
  const end = Math.max(...agents.map((a) => a.endedAt ?? 0));
  const tpl = TEMPLATES.find((t) => t.id === p.template)!;
  const approved = p.review.status === "approved";
  if (approved && !p.ciFail) {
    const a = agents.find((x) => x.id === p.review.agentId);
    if (a) a.merged = true;
  }
  const built: Run = {
    id: p.id,
    title: p.title,
    task: p.text.replace(/@willnew\s*/, ""),
    repo: CHANNELS.find((c) => c.id === p.channel)!.repo,
    baseRef: BASE_REFS[p.channel],
    baseBranch: "main",
    checkCmd: p.check,
    createdAt,
    requester: p.requester,
    requesterTitle: titleOf(p.requester),
    requesterAvatar: avatarOf(p.requester),
    team: p.team,
    template: p.template,
    channel: p.channel,
    triage: {
      by: p.template === "docs" ? "rules" : "llm",
      template: p.template,
      title: p.title,
      task: `${p.text.replace(/@willnew\s*/, "")}\n\nDo not modify tests.${p.check ? ` Run \`${p.check}\` to confirm.` : ""}`,
      plan: p.single ? p.plan.map((l) => (l === REVIEW_STEP_PLAN ? REVIEW_STEP_SOLO : l)) : p.plan,
      agents: agents.map((a) => ({ adapter: a.adapter, model: a.model, label: a.label })),
      check: p.check,
      reason: `${tpl.name} 요청이에요.`,
      durationMs: p.template === "docs" ? 12 : p.id === "r-8c1" ? 17900 : 23100,
      costUsd: p.template === "docs" ? 0 : 0.02,
    },
    review: p.review.status === "pending" ? p.review : { ...p.review, at: end + (p.id === "r-8c1" ? 11 : p.id === "r-6a2" ? 26 : p.id === "r-4e7" ? 140 : p.id === "r-cs1" ? 14 : 95) * MIN },
    maxAttempts: 2,
    agents,
  };
  if (approved) built.ship = pastShip(p, built);
  return built;
}

const PAST_RUNS = PAST.map(buildPast);

function seedChat() {
  const add = (channel: string, ts: number, user: string, text: string, extra: Partial<ChatMessage> = {}) =>
    pushChat({ id: `m${++msgSeq}`, channel, ts, user, bot: user === "willnew", text, ...extra });
  const [orders, settle, readme, button, session, receipt] = PAST_RUNS;
  const approve = (channel: string, r: Run) => {
    const who = r.review.reviewer ?? "이해준";
    const t = r.review.at!;
    const n = PR_NO[r.id];
    add(channel, t, "willnew", `승인 · ${who} · claude-sonnet 결과로 PR 을 올려요`, { runId: r.id, kind: "result" });
    add(channel, t + 20 * SEC, "willnew", `PR #${n} 올렸어요`, { runId: r.id, kind: "result" });
    if (r.ship?.stage === "ci_failed") {
      add(channel, t + 3 * MIN, "willnew", "CI 실패: lint. 자동으로 다시 돌리지 않았어요", { runId: r.id, kind: "result" });
      return;
    }
    add(channel, t + 3 * MIN, "willnew", "CI 3개 통과", { runId: r.id, kind: "result" });
    add(channel, t + 3 * MIN + 10 * SEC, "willnew", "main에 병합했어요", { runId: r.id, kind: "result" });
    add(channel, t + 5 * MIN, "willnew", "production 배포 끝났어요", { runId: r.id, kind: "result" });
    add(channel, t + 5 * MIN + SEC, who, deployedReply(r, r.agents.find((a) => a.id === r.review.agentId)?.userNote), { runId: r.id, kind: "result", via: "willnew" });
  };
  const bySum = (r: Run) => r.review.at!;

  // #backend
  add("backend", session.createdAt - 4 * MIN, "정하늘", "어제 배포하고 나서부터 세션이 이상하게 빨리 끊긴다는 문의가 들어오고 있어요. 지금까지 3건이에요");
  add("backend", session.createdAt, "정하늘", PAST[4].text);
  add("backend", session.createdAt + 2 * SEC, "willnew", "받았어요. 계획 세우는 중", { runId: session.id, kind: "ack" });
  add("backend", session.createdAt + 24 * SEC, "willnew", "계획: 버그 수정 · 에이전트 1개 (sonnet) · npm test", { runId: session.id, kind: "triage" });
  add("backend", session.createdAt + 2 * MIN + 10 * SEC, "willnew", "sonnet 통과. 시각 계산을 고쳤다고 해요. 정하늘님, 검토해 주세요", { runId: session.id, kind: "review" });
  add("backend", bySum(session) - 6 * MIN, "정하늘", "diff 봤는데 +9h 를 그냥 더했네요. 이건 아닌 듯");
  add("backend", bySum(session), "willnew", "정하늘님이 반려했어요. “증상만 가렸어요. 서버 TZ 설정 문제라 제가 직접 볼게요”", { runId: session.id, kind: "result" });
  add("backend", bySum(session) + 3 * MIN, "이해준", "TZ 는 어제 인프라에서 컨테이너 이미지 바꾸면서 풀린 거 같음. 하늘님 확인하면 알려줘요");
  add("backend", orders.createdAt - 6 * MIN, "정하늘", "주문 목록 API 500 나는 거 로그 잡았어요. limit=0 이랑 빈 페이지 둘 다 같은 줄에서 터져요");
  add("backend", orders.createdAt, "정하늘", PAST[0].text);
  add("backend", orders.createdAt + 2 * SEC, "willnew", "받았어요. 계획 세우는 중", { runId: orders.id, kind: "ack" });
  add("backend", orders.createdAt + 20 * SEC, "willnew", "계획: 버그 수정 · 에이전트 1개 (sonnet) · npm test", { runId: orders.id, kind: "triage" });
  add("backend", orders.createdAt + 56 * SEC, "willnew", "sonnet 통과. 테스트 9개 모두 통과했어요", { runId: orders.id, kind: "review" });
  add("backend", orders.createdAt + 57 * SEC, "willnew", reviewMessage("이해준", orders.agents[0], "main", false), { runId: orders.id, kind: "review" });
  approve("backend", orders);
  add("backend", T0 - 9 * MIN, "이해준", "어제 배포 후로 duration 테스트가 전부 빨간불이네요");
  add("backend", T0 - 8 * MIN, "정하늘", "저도 봤어요. parseDuration 이 h 말고 m 이 섞이면 NaN 이 나오는 것 같던데 원인까진 못 봤어요");

  // #web
  add("web", button.createdAt - 2 * MIN, "최민재", "Button 쓰는 데마다 variant 오타가 하나씩 있네 ㅋㅋ");
  add("web", button.createdAt, "최민재", PAST[3].text);
  add("web", button.createdAt + 2 * SEC, "willnew", "받았어요. 계획 세우는 중", { runId: button.id, kind: "ack" });
  add("web", button.createdAt + 22 * SEC, "willnew", "계획: 리팩터링 · 에이전트 1개 (sonnet) · npm test", { runId: button.id, kind: "triage" });
  add("web", button.createdAt + 70 * SEC, "willnew", "sonnet 통과. 테스트 26개 모두 통과했어요", { runId: button.id, kind: "review" });
  add("web", button.createdAt + 71 * SEC, "willnew", reviewMessage("이해준", button.agents[0], "main", false), { runId: button.id, kind: "review" });
  approve("web", button);
  add("web", bySum(button) + 8 * MIN, "최민재", "lint 에서 걸렸네. 따로 고쳐서 다시 올릴게");

  // #data
  add("data", settle.createdAt - 3 * MIN, "박서윤", "어제 정산 로그 기준 중복 행 412/18,730 (2.2%). 근데 중복 제거가 settle_daily, weekly, reprocess 세 군데에 복붙돼있어요");
  add("data", settle.createdAt, "박서윤", PAST[1].text);
  add("data", settle.createdAt + 2 * SEC, "willnew", "받았어요. 계획 세우는 중", { runId: settle.id, kind: "ack" });
  add("data", settle.createdAt + 22 * SEC, "willnew", "계획: 리팩터링 · 겨루기 2개 (sonnet, codex) · pytest -q", { runId: settle.id, kind: "triage" });
  add("data", settle.createdAt + 2 * MIN + 5 * SEC, "willnew", "sonnet 만 통과했어요. 1차 검증 실패 후 스스로 고쳤고 테스트 파일을 건드렸어요", { runId: settle.id, kind: "review" });
  add("data", settle.createdAt + 2 * MIN + 6 * SEC, "willnew", reviewMessage("이해준", settle.agents[0], "main", false), { runId: settle.id, kind: "review" });
  add("data", settle.createdAt + 6 * MIN, "이해준", "test_settle.py 건드린 거 import 한 줄이면 괜찮은데 diff 보고 올릴게요");

  // #content-ops
  add("content-ops", readme.createdAt - MIN, "김도윤", "신입분들이 수집기 쓰는 법을 또 물어보셨어요. README 가 예전 기준이라 헷갈려 하세요");
  add("content-ops", readme.createdAt, "김도윤", PAST[2].text);
  add("content-ops", readme.createdAt + 2 * SEC, "willnew", "받았어요. 계획 세우는 중", { runId: readme.id, kind: "ack" });
  add("content-ops", readme.createdAt + 3 * SEC, "willnew", "계획: 문서화 · sonnet 이 맡아요", { runId: readme.id, kind: "triage" });
  add("content-ops", readme.createdAt + 36 * SEC, "willnew", "sonnet 이 끝냈어요. 김도윤님, 검토해 주세요", { runId: readme.id, kind: "review" });
  approve("content-ops", readme);

  // #cs
  add("cs", receipt.createdAt - 14 * MIN, "윤서아", "부분 환불한 고객 영수증이 이상하다는 문의가 또 왔어요 ㅠ");
  add("cs", receipt.createdAt - 9 * MIN, "이해준", "수수료 줄이 두 번 나가는 거면 메일 쪽일 거예요. 주문번호 있으면 같이 적어줘요");
  add("cs", receipt.createdAt, "윤서아", PAST[5].text, { userTitle: "CS" });
  add("cs", receipt.createdAt + 2 * SEC, "willnew", "받았어요. 계획 세우는 중", { runId: receipt.id, kind: "ack" });
  add("cs", receipt.createdAt + 19 * SEC, "willnew", "계획: 버그 수정 · 에이전트 1개 (sonnet) · npm test", { runId: receipt.id, kind: "triage" });
  add("cs", receipt.createdAt + 36 * SEC, "willnew", "sonnet 통과. 테스트 6개 모두 통과했어요", { runId: receipt.id, kind: "review" });
  add("cs", receipt.createdAt + 37 * SEC, "willnew", reviewMessage("이해준", receipt.agents[0], "main", false), { runId: receipt.id, kind: "review" });
  approve("cs", receipt);
  add("cs", bySum(receipt) + 4 * MIN, "윤서아", "넵 고객님께 안내드릴게요 감사합니다");
  add("cs", T0 - 52 * MIN, "윤서아", "오늘 환불 문의는 이걸로 끝인 듯해요");
  add("cs", T0 - 7 * MIN, "윤서아", "구독 갱신일 문의가 오늘만 3건째네요. 1/31에 가입한 분들이 많아요");
  add("cs", T0 - 6 * MIN, "이해준", "월말 가입자면 날짜 계산 쪽일 수 있어요. 케이스 하나 정확히 적어서 willnew한테 넘겨봐요");
}

function seedLiveChat(now: number) {
  const add = (channel: string, ts: number, user: string, text: string) => pushChat({ id: `m${++msgSeq}`, channel, ts, user, bot: false, text });
  const t = now - SUMMARY_AGO;
  const bots: [number, NonNullable<ChatMessage["kind"]>, string][] = [
    [2, "ack", "받았어요. 계획 세우는 중"],
    [24, "triage", "계획: 기능 구현 · 겨루기 2개 (sonnet, codex) · npm test"],
    [78, "review", "둘 다 통과. sonnet 이 5초 빠르고 변경도 작아서 이걸로 추천해요"],
  ];
  const runId = [...lives.values()].find((l) => l.run.template === "feature")?.run.id;
  for (const [s, kind, text] of bots) pushChat({ id: `m${++msgSeq}`, channel: "backend", ts: t + s * SEC, user: "willnew", bot: true, text, runId, kind });
  add("backend", now - SUMMARY_AGO + 5 * MIN, "정하늘", "맞아요 월 중간에 해지한 고객은 items 가 비어서 올 수 있어요. 기다릴게요");
  add("web", now - 3 * MIN, "최민재", "모바일 사파리에서만 재현됨. 크롬은 한 번만 불러옴");
}

let seeded = false;
function ensureSeed() {
  if (seeded) return;
  seeded = true;
  seedChat();
  const now = Date.now();
  // oldest first, so the chat reads in order. The long-lived ones are still mid-flight a minute after opening.
  launch({
    channel: "backend", requester: "정하늘", team: "platform", text: SUMMARY_TEXT, ago: SUMMARY_AGO,
    template: "feature", title: "고객별 청구 요약에 최대·평균 금액 추가", triageMs: 21400, steps: summarySteps, prebuilt: summaryPrebuilt,
    agents: summaryTriage().agents,
  });
  seedLiveChat(now);
  launch({
    channel: "web", requester: "최민재", team: "platform", text: SCROLL_TEXT, ago: 40 * SEC, template: "bugfix",
    title: "청구서 목록 무한스크롤이 같은 페이지를 두 번 불러옴", task: "Find why page=2 is requested twice on the invoice list and fix it. Do not modify tests. Run `npm test` to confirm.",
    plan: ["스크롤 훅과 목록 화면, 테스트를 읽는다", "page=2 요청이 두 번 나가는 경로를 찾는다 (테스트는 수정 금지)", "중복 요청을 막도록 고친다", "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", "통과한 결과 중 하나를 골라 요청자 검토를 받는다"],
    triageMs: 21700, steps: scrollSteps,
  });
  launch({
    channel: "backend", requester: "정하늘", team: "platform", text: WEBHOOK_TEXT, ago: 65 * SEC, template: "bugfix",
    title: "결제 웹훅 같은 이벤트가 두 번 처리됨", task: "Make handleWebhook idempotent per event id (#388). Keep behaviour otherwise. Do not modify tests. Run `npm test` to confirm.",
    plan: ["handleWebhook 과 processed_events 를 읽는다", "같은 event id 가 동시에 와도 한 번만 처리되게 한다 (동작은 그대로)", "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", "통과한 결과 중 하나를 골라 요청자 검토를 받는다"],
    triageMs: 19100, steps: webhookSteps,
  });
  launch({
    channel: "content-ops", requester: "김도윤", team: "content-ops", text: CSV_TEXT, ago: 5 * SEC, template: "bugfix", check: "npm test",
    title: "일정 내보내기 CSV 의 게시 예정일 열이 비어 있음", task: "The CSV export shows an empty '게시 예정일' column. Find why and fix it. Do not modify tests. Run `npm test` to confirm.",
    plan: ["내보내기 코드와 API 응답 타입을 읽는다", "게시 예정일이 비는 원인을 찾아 고친다 (테스트는 수정 금지)", "npm test 로 검증하고, 실패하면 로그를 붙여 한 번 더 시도한다", "통과한 결과 중 하나를 골라 요청자 검토를 받는다"],
    triageMs: 25100, steps: csvSteps,
  });
  // the scripted race, started a few seconds ago so the first screen can still show it running
  launch(durationScenario("backend", "이해준", "platform", "@willnew 어제 배포 이후로 parseDuration 테스트 7개 다 깨짐. 1h30m 같은 거 못 읽는 듯", 4 * SEC));
}

// ---------------------------------------------------------------------------------------------- metrics

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Same definitions as the server's metrics.ts, computed from the runs the demo is actually showing. */
function computeMetrics(runs: Run[]): Metrics {
  const resolved = (r: Run) => r.agents.some((a) => a.status === "done" && a.check.status !== "failed" && a.diff.files > 0);
  const finished = (r: Run) => r.agents.length > 0 && r.agents.every((a) => ["done", "failed", "cancelled"].includes(a.status));
  const cost = (r: Run) => r.agents.reduce((s, a) => s + (a.usage.costUsd ?? 0), 0) + (r.triage?.costUsd ?? 0);
  const totals = { requests: runs.length, autoResolved: 0, approved: 0, rejected: 0, pendingReview: 0, estHoursSaved: 0, costUsd: 0 };
  const byTeam: Metrics["byTeam"] = {};
  const leads: Record<string, number[]> = {};
  for (const t of TEAMS) {
    byTeam[t.id] = { requests: 0, autoResolved: 0, approved: 0, rejected: 0, costUsd: 0, budgetUsd: t.budgetUsd, medianLeadMs: null };
    leads[t.id] = [];
  }
  const tp: Record<string, { name: string; requests: number; resolved: number; approved: number; reviewed: number; costs: number[]; hours: number }> = {};
  for (const r of runs) {
    const tm = byTeam[r.team];
    const t = (tp[r.template] ??= { name: TEMPLATES.find((x) => x.id === r.template)?.name ?? r.template, requests: 0, resolved: 0, approved: 0, reviewed: 0, costs: [], hours: 0 });
    const c = cost(r);
    tm.requests++; t.requests++; tm.costUsd += c; totals.costUsd += c;
    if (finished(r)) t.costs.push(c);
    if (resolved(r)) { tm.autoResolved++; t.resolved++; totals.autoResolved++; }
    if (r.review.status === "pending") totals.pendingReview++;
    if (r.review.status === "approved") {
      tm.approved++; t.approved++; t.reviewed++; totals.approved++;
      const h = (TEMPLATES.find((x) => x.id === r.template)?.estMinutes ?? 0) / 60;
      t.hours += h; totals.estHoursSaved += h;
      if (r.review.at) leads[r.team].push(r.review.at - r.createdAt);
    }
    if (r.review.status === "rejected") { tm.rejected++; t.reviewed++; totals.rejected++; }
  }
  for (const id of Object.keys(byTeam)) byTeam[id].medianLeadMs = median(leads[id]);
  const byTemplate: Metrics["byTemplate"] = {};
  for (const [id, t] of Object.entries(tp))
    byTemplate[id] = { name: t.name, requests: t.requests, autoResolvedRate: t.requests ? t.resolved / t.requests : 0, approvalRate: t.reviewed ? t.approved / t.reviewed : 0, avgCostUsd: t.costs.length ? t.costs.reduce((a, b) => a + b, 0) / t.costs.length : null, estHoursSaved: t.hours };

  const by: Record<string, { agents: number; done: number; passed: number; fin: number; durations: number[]; inTok: number; outTok: number; cost: number; files: number[] }> = {};
  const timeline: Metrics["timeline"] = [];
  for (const run of runs)
    for (const a of run.agents) {
      const m = (by[a.adapter] ??= { agents: 0, done: 0, passed: 0, fin: 0, durations: [], inTok: 0, outTok: 0, cost: 0, files: [] });
      m.agents++;
      if (a.status === "done") m.done++;
      if (a.status === "done" || a.status === "failed") {
        m.fin++;
        if (a.check.status === "passed" || (a.status === "done" && a.check.status === "skipped")) m.passed++;
        if (a.durationMs) m.durations.push(a.durationMs);
        m.files.push(a.diff.files);
      }
      m.inTok += a.usage.inputTokens + a.usage.cachedTokens;
      m.outTok += a.usage.outputTokens;
      m.cost += a.usage.costUsd ?? 0;
      timeline.push({ runId: run.id, createdAt: run.createdAt, adapter: a.adapter, label: a.label, durationMs: a.durationMs ?? null, checkStatus: a.status === "done" ? a.check.status : a.status, costUsd: a.usage.costUsd, tokens: a.usage.inputTokens + a.usage.cachedTokens + a.usage.outputTokens });
    }
  const byAdapter: Metrics["byAdapter"] = {};
  for (const [k, m] of Object.entries(by))
    byAdapter[k] = { agents: m.agents, done: m.done, checkPassed: m.passed, passRate: m.fin ? m.passed / m.fin : 0, medianDurationMs: median(m.durations), totalInputTokens: m.inTok, totalOutputTokens: m.outTok, totalCostUsd: m.cost, avgFilesChanged: m.files.length ? m.files.reduce((a, b) => a + b, 0) / m.files.length : 0 };
  timeline.sort((a, b) => b.createdAt - a.createdAt);
  return { runs: runs.length, totals, byTeam, byTemplate, byAdapter, timeline: timeline.slice(0, 50) };
}

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
  const file = a.diff.fileStats?.[0]?.path ?? "./src/index.js";
  const cmd = run.checkCmd || "npm test";
  if (a.diff.fileStats?.some((x) => x.path === "src/billing/renewal.js") && a.label === "claude-sonnet") {
    // the renewal demo: the reviewer asks for lib/time.js instead of a new dependency
    const say2 = (ms: number, kind: AgentEvent["kind"], t: string, patch?: Partial<AgentRun>, runPatch?: Partial<Run>) =>
      setTimeout(() => {
        emitAny(runId, { runId, agentId, event: { ts: Date.now(), kind, text: t, attempt: a.attempt }, agent: patch });
        if (runPatch) emitAny(runId, { runId, run: runPatch });
      }, ms);
    emitAny(runId, { runId, agentId, event: { ts: Date.now(), kind: "plan", text: "추가 지시를 반영해 이어서 작업" }, agent: { status: "running" } });
    emitAny(runId, { runId, run: { review: { status: "none" } } });
    say2(1200, "text", "lib/time.js 의 toKst / fromKst 로 바꿀게요. date-fns-tz 는 빼고 package.json 도 원래대로 돌립니다.");
    say2(2200, "tool", 'Edit {"file_path":"./src/billing/renewal.js"}');
    say2(2600, "tool_result", "The file ./src/billing/renewal.js has been updated.");
    say2(3000, "tool", 'Edit {"file_path":"./package.json"}');
    say2(3300, "tool_result", "The file ./package.json has been updated.");
    say2(3700, "check", `$ ${cmd}`, { status: "checking", diff: diffOf(PATCH_RENEWAL_S2) });
    say2(5100, "check", "검증 통과 (exit 0, 0.5 s)", { status: "done", endedAt: Date.now() + 5100, durationMs: (a.durationMs ?? 0) + 5100, summary: RENEWAL_SONNET_SUMMARY_2, check: { status: "passed", exitCode: 0, output: CHECK_RENEWAL_OK, durationMs: 500 } }, { review: { status: "pending" } });
    return;
  }
  const say = (ms: number, kind: AgentEvent["kind"], t: string, patch?: Partial<AgentRun>, runPatch?: Partial<Run>) =>
    setTimeout(() => {
      emitAny(runId, { runId, agentId, event: { ts: Date.now(), kind, text: t, attempt: a.attempt }, agent: patch });
      if (runPatch) emitAny(runId, { runId, run: runPatch });
    }, ms);
  const startedAt = Date.now() - (a.durationMs ?? 0);
  emitAny(runId, { runId, agentId, event: { ts: Date.now(), kind: "plan", text: "추가 지시를 반영해 이어서 작업" }, agent: { status: "running", startedAt } });
  emitAny(runId, { runId, run: { review: { status: "none" } } });
  say(1200, "text", `반영할게요: ${text.split("\n").slice(-1)[0].slice(0, 80)}`);
  say(2200, "tool", `Edit {"file_path":"./${file}"}`);
  say(2600, "tool_result", `The file ./${file} has been updated.`);
  say(3200, "check", `$ ${cmd}`, { status: "checking" });
  say(4400, "check", "검증 통과 (exit 0, 1.2 s)", { status: "done", endedAt: Date.now() + 4400, durationMs: (a.durationMs ?? 0) + 4400, summary: `추가 지시를 반영했어요: ${text.split("\n").slice(-1)[0].slice(0, 120)}` }, { review: { status: "pending" } });
}

// ---------------------------------------------------------------------------------------------- ship (pr mode, simulated)

let prSeq = 511;
const botSay = (run: Run, text: string) => run.channel && pushChat({ id: `m${++msgSeq}`, channel: run.channel, ts: Date.now(), user: "willnew", bot: true, text, kind: "result" });

/** 승인 뒤: PR 번호가 붙고, CI 세 개가 6초쯤에 걸쳐 초록이 되고, 병합, 배포 4초. 실제 gh 는 부르지 않는다. */
function simulateShip(runId: string, agentId: string | undefined, reviewer: string) {
  const first = findRun(runId);
  if (!first) return;
  const n = ++prSeq;
  const env = "production";
  const set = (patch: Partial<Ship>) => {
    const cur = findRun(runId)?.ship;
    emitAny(runId, { runId, run: { ship: { ...(cur ?? { mode: "pr" as const, stage: "pr" as const }), ...patch, at: Date.now() } as Ship } });
  };
  const setCheck = (name: string) => {
    const cur = findRun(runId)?.ship?.checks ?? [];
    set({ checks: cur.map((c) => (c.name === name ? { ...c, state: "pass" as const } : c)) });
  };
  const at = (ms: number, fn: () => void) => setTimeout(fn, ms);
  at(900, () => {
    set({ stage: "ci", prNumber: n, prUrl: prUrl(n), checks: CHECK_NAMES.map((name) => ({ name, state: "pending" as const })) });
    botSay(findRun(runId)!, `PR #${n} 올렸어요`);
  });
  at(2600, () => setCheck("test (node 20)"));
  at(4300, () => setCheck("lint"));
  at(6200, () => {
    setCheck("build");
    botSay(findRun(runId)!, "CI 3개 통과");
  });
  at(6900, () => {
    const run = findRun(runId)!;
    set({ stage: "merged" });
    if (agentId) emitAny(runId, { runId, agentId, event: { ts: Date.now(), kind: "status", text: `${run.baseBranch}에 반영됨 (PR 병합)` }, agent: { merged: true } });
    botSay(run, `${run.baseBranch}에 병합했어요`);
  });
  at(7400, () => set({ stage: "deploying" }));
  at(11400, () => {
    const run = findRun(runId)!;
    set({ stage: "deployed" });
    botSay(run, `${env} 배포 끝났어요`);
    const note = run.agents.find((a) => a.id === agentId)?.userNote;
    if (run.channel) pushChat({ id: `m${++msgSeq}`, channel: run.channel, ts: Date.now() + 1, user: reviewer, bot: false, via: "willnew", text: deployedReply(run, note), runId, kind: "result" });
  });
}

// ---------------------------------------------------------------------------------------------- api

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const later = <T,>(v: T, ms = 90) => new Promise<T>((res) => setTimeout(() => res(v), ms));
const allRuns = () => [...[...lives.values()].map((l) => l.run), ...PAST_RUNS].sort((a, b) => b.createdAt - a.createdAt);

export const demoApi: Api = {
  config: () => later({ repo: REPO, check: "npm test", preview: "npm run dev -- --port {port}", ship: "pr" as const, deploy: true, deployEnv: "production" }),
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
  async postMessage(ch, user, text, _team, overrides, userTitle) {
    ensureSeed();
    const team = CHANNELS.find((c) => c.id === ch)?.team ?? "platform";
    if (/@willnew/i.test(text)) {
      // 겨루기: 토글을 켰거나 "겨뤄" / "둘 다" 라고 쓴 경우
      const race = (overrides?.agents?.length ?? 0) > 1 || (!overrides?.agents && /겨뤄|둘 다/.test(text));
      spawn(ch, user, team, text, race, userTitle);
      const list = chat.get(ch)!;
      return { message: clone(list[list.length - 1]) };
    }
    const message: ChatMessage = { id: `m${++msgSeq}`, channel: ch, ts: Date.now(), user, userTitle, bot: false, text };
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
    const run = findRun(runId);
    if (!run) return { ok: false, message: "요청을 찾을 수 없어요" };
    const approve = input.decision === "approve";
    const review = { status: approve ? "approved" : "rejected", reviewer: input.reviewer, comment: input.comment, agentId: input.agentId, at: Date.now() } as Run["review"];
    const agent = run.agents.find((a) => a.id === input.agentId);
    // pr 모드: 승인은 바로 기록하고, 병합은 CI 가 끝난 뒤
    if (approve) emitAny(runId, { runId, run: { ship: { mode: "pr", stage: "pr", env: "production", at: Date.now() } } });
    emitAny(runId, { runId, run: { review } });
    const why = input.comment ? ` · “${input.comment}”` : "";
    botSay(run, approve ? `승인 · ${input.reviewer} · ${agent?.label ?? "결과"} 결과로 PR 을 올려요${why}` : `반려 · ${input.reviewer}${why}`);
    if (approve) simulateShip(runId, input.agentId, input.reviewer);
    else if (run.channel)
      pushChat({ id: `m${++msgSeq}`, channel: run.channel, ts: Date.now() + 1, user: input.reviewer, bot: false, via: "willnew", text: rejectedReply(run, input.comment), runId, kind: "result" });
    await later(null, 300);
    return { ok: true, message: approve ? "승인했어요. PR 을 올리고 CI 를 기다려요" : "반려했어요" };
  },
  async cancel(runId, agentId) {
    const live = lives.get(runId);
    if (!live) return;
    emit(live, { runId, agentId, event: { ts: Date.now(), kind: "status", text: "취소됨" }, agent: { status: "cancelled", endedAt: Date.now() } });
  },
  metrics: () => {
    ensureSeed();
    return later(computeMetrics(clone(allRuns())));
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
