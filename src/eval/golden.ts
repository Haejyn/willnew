/**
 * 골든 세트 (ticket-plan.md F12, m1-contract.md 7절). `tests/golden/*.json` 한 건이 문의 하나.
 *
 *   text 또는 textFile   문의 원문. textFile 은 저장소 기준 경로 (examples/shop/inquiries/ 를 그대로 참조)
 *   source              "examples/shop" 또는 "synthetic" (직접 만든 것). 출처마다 점수를 따로 낸다
 *   category            정답 분류
 *   injection           인젝션 표시가 떠야 하는지
 *   fields              정답 칸: 채워져야 할 필수 칸마다 핵심 낱말(하나라도 들어 있으면 맞음),
 *                       CS 가 아는 답(answer) 또는 고객에게 물으면 받는 답(customer). 둘 다 없으면 CS 는 "모름"
 *   reviewAnswer        대리 검토 첫 질문에 CS 가 하는 답 (없으면 모름)
 *   fake                --ai fake 가 돌려줄 정해진 응답. extract 의 from 은 근거 말의 일부 글귀로 적고 실행할 때 번호로 바꾼다
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RequiredField } from "../server/tickets/fields.js";

export interface GoldenField {
  keywords: string[];
  answer?: string;
  customer?: string;
}

export interface GoldenSlot {
  value: unknown;
  /** 근거가 된 말의 일부 글귀. 실행할 때 utterance 번호로 바꾼다 */
  from: string[];
  confidence: "low" | "medium" | "high";
}

export interface GoldenCase {
  id: string;
  source: "examples/shop" | "synthetic";
  note: string;
  text?: string;
  textFile?: string;
  category: "question" | "known" | "new_bug" | "new_request";
  injection: boolean;
  fields: Partial<Record<RequiredField, GoldenField>>;
  reviewAnswer?: string;
  fake: {
    extract: Partial<Record<RequiredField, GoldenSlot | null>>;
    draft: Record<string, unknown>;
    review: { questions: string[] };
  };
}

/** 원문 (textFile 이면 읽는다) */
export function caseText(c: GoldenCase, root: string): string {
  if (c.text !== undefined) return c.text;
  if (!c.textFile) throw new Error(`${c.id}: text 나 textFile 이 필요해요`);
  return readFileSync(resolve(root, c.textFile), "utf8");
}

export function loadGolden(dir: string): GoldenCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as GoldenCase;
    if (!c.id || !c.category || !c.fields || !c.fake) throw new Error(`${f}: id, category, fields, fake 가 필요해요`);
    if (c.source !== "synthetic" && c.source !== "examples/shop") throw new Error(`${f}: source 는 examples/shop 이나 synthetic 이에요`);
    return c;
  });
}
