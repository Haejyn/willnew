/**
 * 티켓 칸 (m1-contract.md 3절 표). 필수 칸의 순서, 양식 모드 질문, 답을 칸 값으로 바꾸는 규칙, 말한 사람 나누기.
 * LLM 을 부르지 않는다.
 */
import type { Source, Utterance, WorkSpec } from "../types.js";

/** 필수 칸. 다음 질문은 이 순서로 고른다 */
export const REQUIRED = ["problem", "reproSteps", "expected", "actual", "environment", "impact", "alreadyRuledOut"] as const;
export type RequiredField = (typeof REQUIRED)[number];

/** CS 가 고칠 수 있는 칸: 필수 칸과 초안 칸 */
export const EDITABLE = [...REQUIRED, "title", "acceptanceCriteria", "outOfScope"] as const;
export type EditableField = (typeof EDITABLE)[number];

export const isRequired = (f: string): f is RequiredField => (REQUIRED as readonly string[]).includes(f);
export const isEditable = (f: string): f is EditableField => (EDITABLE as readonly string[]).includes(f);

export const FIELD_KO: Record<EditableField, string> = {
  problem: "증상", reproSteps: "재현 단계", expected: "기대 결과", actual: "실제 결과", environment: "환경", impact: "영향 범위",
  alreadyRuledOut: "이미 해 본 것", title: "제목", acceptanceCriteria: "수용 기준", outOfScope: "범위 밖",
};

/** 양식 모드 질문 (계약 표 그대로). 화면에 나오는 질문이라 질문형이다 */
export const DEFAULT_QUESTION: Record<RequiredField, string> = {
  problem: "고객이 겪은 문제를 한 줄로 적어 주세요",
  reproSteps: "어떤 순서로 하다가 생겼나요",
  expected: "원래는 어떻게 돼야 하나요",
  actual: "실제로는 어떻게 됐나요",
  environment: "앱인가요 웹인가요, 브라우저나 기기는요",
  impact: "몇 명이 겪었나요, 한 명인가요",
  alreadyRuledOut: "고객이 이미 해 본 게 있나요 (새로고침, 다른 기기)",
};

/** 양식 모드 선택지. 화면이 "기타" 를 늘 더한다 */
export const DEFAULT_CHOICES: Record<RequiredField, string[]> = {
  problem: ["화면이 안 열려요", "금액이나 숫자가 이상해요", "버튼이 안 눌려요"],
  reproSteps: ["상품을 담고 결제하다가", "로그인하다가", "주문 내역을 보다가"],
  expected: ["맞는 금액이 나와야 해요", "다음 화면으로 넘어가야 해요"],
  actual: ["아무 변화가 없었어요", "오류 문구가 떴어요", "금액이 그대로였어요"],
  environment: ["PC 웹", "모바일 웹", "앱"],
  impact: ["한 명", "여러 명 (2~10명)", "더 많아요"],
  alreadyRuledOut: ["새로고침", "다른 브라우저", "다른 기기", "아무것도 안 해 봤어요"],
};

/** CS 가 고객에게 그대로 보낼 수 있는 문장 (고객에게 물을 것) */
export const CUSTOMER_QUESTION: Record<RequiredField, string> = {
  problem: "어떤 문제가 있으셨는지 한 번 더 자세히 알려 주실 수 있을까요?",
  reproSteps: "어떤 순서로 이용하시다가 문제가 생겼는지 알려 주실 수 있을까요?",
  expected: "원래 어떻게 되기를 기대하셨는지 알려 주실 수 있을까요?",
  actual: "실제로 화면에 어떻게 보였는지 알려 주실 수 있을까요?",
  environment: "앱과 웹 중 어디에서 이용하셨는지, 쓰신 브라우저나 기기를 알려 주실 수 있을까요?",
  impact: "같은 문제가 다른 분께도 있었는지 아시면 알려 주실 수 있을까요?",
  alreadyRuledOut: "새로고침이나 다른 기기에서 다시 해 보셨는지 알려 주실 수 있을까요?",
};

// ---------------------------------------------------------------------------------------------- 말한 사람

const TIME_HEAD = /^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:：\n]{1,30}?)\s*[:：]\s*(.*)$/;
const ROLE_HEAD = /^\s*(고객님?|손님|customer|user|상담원|상담사|CS|agent|직원|매니저)\s*[:：]\s*(.*)$/i;
const AGENT_WHO = /상담원|상담사|상담|매니저|직원|운영자|\bCS\b|agent|support/i;

/**
 * 대화 기록이면 줄 머리(`[14:03] 홍길동:`, `고객:`, `상담원:`)로 말한 사람을 나눈다. 시각 머리가 있는 기록은 시각 붙은 줄만
 * 말로 보고(그 앞의 머리말은 뺀다), 머리 없는 줄은 앞 말에 붙인다. 말이 둘 이상 안 나오면 전부 고객 말 하나.
 */
export function splitSpeakers(text: string): Utterance[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const timed = lines.filter((l) => TIME_HEAD.test(l)).length >= 2;
  const out: Utterance[] = [];
  let started = false;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    let u: Utterance | null = null;
    if (timed && (m = TIME_HEAD.exec(line))) u = { speaker: AGENT_WHO.test(m[2]) ? "agent" : "customer", text: m[3].trim() };
    else if (!timed && (m = ROLE_HEAD.exec(line))) u = { speaker: AGENT_WHO.test(m[1]) ? "agent" : "customer", text: m[2].trim() };
    if (u) {
      started = true;
      out.push(u);
    } else if (started && line.trim()) out[out.length - 1].text = `${out[out.length - 1].text}\n${line.trim()}`.trim();
  }
  if (out.length >= 2) return out.filter((x) => x.text);
  return [{ speaker: "customer", text: text.trim() }];
}

// ---------------------------------------------------------------------------------------------- 칸 값

const list = (text: string) => text.split(/\r?\n|→|->|,|，/).map((x) => x.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);

const BROWSER = /(chrome|크롬|safari|사파리|edge|엣지|firefox|파이어폭스|whale|웨일|삼성\s*인터넷|samsung\s*internet|opera)(?:\s*[\d.]+)?/i;
const OS = /(windows|윈도우|mac\s*os|macos|맥|ios|아이폰|iphone|ipad|아이패드|android|안드로이드|갤럭시|galaxy)(?:\s*[\d.]+)?/i;
const APP = /앱\s*(?:버전)?\s*v?(\d+(?:\.\d+){1,3})|\bv(\d+(?:\.\d+){1,3})\b/i;

export function parseEnvironment(text: string): NonNullable<WorkSpec["environment"]> {
  const env: NonNullable<WorkSpec["environment"]> = {};
  const b = BROWSER.exec(text);
  const o = OS.exec(text);
  const a = APP.exec(text);
  if (b) env.browser = b[0].trim();
  if (o) env.os = o[0].trim();
  if (a) env.appVersion = a[1] ?? a[2];
  // 알아본 이름이 없으면 답 그대로 (웹, 앱 같은 말)
  if (!b && !o && !a && text.trim()) env.browser = text.trim().slice(0, 80);
  return env;
}

const KO_COUNT: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5 };

export function parseImpact(text: string): NonNullable<WorkSpec["impact"]> {
  const t = text.trim();
  const n = /(\d+)\s*(?:명|분|건)?/.exec(t);
  const ko = /(한|두|세|네|다섯)\s*(?:명|분)/.exec(t);
  const customers = n ? Number(n[1]) : ko ? KO_COUNT[ko[1]] : 1;
  return { customers, note: t.slice(0, 200) || undefined };
}

/** CS 나 고객의 답을 그 칸의 값으로 */
export function applyAnswer(spec: WorkSpec, field: EditableField, text: string): WorkSpec {
  const t = text.trim();
  switch (field) {
    case "problem":
    case "expected":
    case "actual":
    case "title":
      return { ...spec, [field]: t };
    case "reproSteps":
    case "alreadyRuledOut":
    case "acceptanceCriteria":
    case "outOfScope":
      return { ...spec, [field]: field === "reproSteps" || field === "acceptanceCriteria" ? t.split(/\r?\n|→|->/).map((x) => x.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean) : list(t) };
    case "environment":
      return { ...spec, environment: parseEnvironment(t) };
    case "impact":
      return { ...spec, impact: parseImpact(t) };
  }
}

/** 칸 값을 한 줄 글로 (고친 기록의 전후, 대리 검토 입력) */
export function fieldText(spec: WorkSpec, field: EditableField): string {
  switch (field) {
    case "problem":
    case "expected":
    case "title":
      return spec[field] ?? "";
    case "actual":
      return spec.actual ?? "";
    case "reproSteps":
    case "alreadyRuledOut":
      return (spec[field] ?? []).join("\n");
    case "acceptanceCriteria":
    case "outOfScope":
      return spec[field].join("\n");
    case "environment": {
      const e = spec.environment ?? {};
      return [e.browser, e.os, e.appVersion && `앱 ${e.appVersion}`, e.deployedSha].filter(Boolean).join(", ");
    }
    case "impact":
      return spec.impact ? `${spec.impact.customers}명${spec.impact.note ? ` (${spec.impact.note})` : ""}` : "";
  }
}

export const csSource = (index: number): Source => ({ kind: "utterance", index, speaker: "cs" });
export const customerSource = (index: number): Source => ({ kind: "utterance", index, speaker: "customer" });

/** 빈 명세. 칸은 접수, 대화, 초안에서 채운다 */
export function emptySpec(title: string): WorkSpec {
  return {
    title, problem: "", expected: "", acceptanceCriteria: [], outOfScope: [], references: [], constraints: [],
    summary: { forRequester: "", forDeveloper: "" }, reproSteps: [], actual: "", alreadyRuledOut: [], fields: {}, askCustomer: [],
  };
}

/** 보내기 전에 CS 가 하나씩 확인해야 하는 칸: 확신도가 낮거나 출처가 없는 칸 (모름으로 정한 칸은 빼고) */
export function unconfirmedFields(spec: WorkSpec | undefined): string[] {
  return Object.entries(spec?.fields ?? {})
    .filter(([, v]) => !v.confirmedBy && v.confidence !== "unknown" && (v.confidence === "low" || !v.sources.length))
    .map(([k]) => k);
}

/** 영문 요약을 브랜치 이름 꼬리로: 소문자 kebab, 단어 셋까지. 남는 게 없으면 "ticket" */
export function slugOf(s: string | undefined): string {
  const words = (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return words.length ? words.join("-") : "ticket";
}
