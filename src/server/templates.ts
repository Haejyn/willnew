import type { AgentSpec, Channel, Template } from "./types.js";

/** One agent by default. Racing a second one doubles the tokens, so it is opt-in. */
const SONNET: AgentSpec = { adapter: "claude-code", model: "sonnet", label: "claude-sonnet" };
export const RACE_AGENT: AgentSpec = { adapter: "codex", label: "codex" };

/** "겨뤄", "둘 다" in a chat message asks for two agents. */
export const wantsRace = (text: string) => /겨뤄|둘 다/.test(text);

/** The agent list plus the second racer (once). */
export const withRace = (agents: AgentSpec[]): AgentSpec[] =>
  agents.some((a) => a.label === RACE_AGENT.label) ? agents : [...agents, RACE_AGENT];

/** Work types willnew takes on. estMinutes is an assumption used only for the "time saved (estimate)" metric. */
export const TEMPLATES: Template[] = [
  {
    id: "bugfix", name: "버그 수정", keywords: ["버그", "고쳐", "깨져", "실패", "에러", "fix", "bug", "fail", "broken"],
    instruction: "Fix the bug described below. Find the root cause, change production code only (do not weaken or edit tests), and run the test command to confirm.",
    check: "npm test", estMinutes: 60,
    agents: [SONNET],
  },
  {
    id: "tests", name: "테스트 작성", keywords: ["테스트 작성", "테스트 추가", "커버리지", "test coverage", "add tests"],
    instruction: "Add focused unit tests for the code described below. Cover edge cases. Do not change production behaviour. Run the test command to confirm they pass.",
    check: "npm test", estMinutes: 45,
    agents: [SONNET],
  },
  {
    id: "feature", name: "기능 구현", keywords: ["구현", "추가해", "만들어", "지원", "implement", "feature", "support"],
    instruction: "Implement the change described below with minimal, idiomatic code. Keep existing tests passing and add tests for the new behaviour.",
    check: "npm test", estMinutes: 120,
    agents: [SONNET],
  },
  {
    id: "refactor", name: "리팩터링", keywords: ["리팩터", "정리", "중복", "refactor", "cleanup", "clean up"],
    instruction: "Refactor as described below without changing behaviour. All tests must still pass.",
    check: "npm test", estMinutes: 90,
    agents: [SONNET],
  },
  {
    id: "docs", name: "문서화", keywords: ["문서", "주석", "readme", "docs", "document"],
    instruction: "Write or update documentation as described below (README / JSDoc). Do not change code behaviour.",
    check: "", estMinutes: 30,
    agents: [SONNET],
  },
];

export const TEAMS = [
  { id: "platform", name: "플랫폼", budgetUsd: 50 },
  { id: "data", name: "데이터", budgetUsd: 30 },
  { id: "content-ops", name: "콘텐츠 운영", budgetUsd: 20 },
];

export function defaultChannels(repo: string, reviewers: string[] = []): Channel[] {
  return [
    { id: "backend", name: "backend", team: "platform", repo, reviewers, topic: "서비스 백엔드 · @willnew 에게 버그·테스트·리팩터링을 맡겨 보세요", category: "개발" },
    { id: "data", name: "data", team: "data", repo, reviewers, topic: "데이터 파이프라인 · 지표", category: "개발" },
    { id: "content-ops", name: "content-ops", team: "content-ops", repo, reviewers, topic: "콘텐츠 운영 도구", category: "운영" },
  ];
}

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];

/** Keyword routing — the fallback when the LLM planner is unavailable. */
export function routeByRules(text: string): Template {
  const t = text.toLowerCase();
  let best = TEMPLATES[0], score = 0;
  for (const tpl of TEMPLATES) {
    const s = tpl.keywords.filter((k) => t.includes(k.toLowerCase())).length;
    if (s > score) { best = tpl; score = s; }
  }
  return best;
}
