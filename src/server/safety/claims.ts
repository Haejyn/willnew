/**
 * 고객 글에서 우선순위, 담당, 일정을 정하라는 지시성 문장 (research/tech.md 5.2-4). 우선순위와 담당은 사람이 정한다.
 * 이 문장들은 "고객 주장" 으로 표시만 하고 티켓 칸에 옮기지 않는다.
 * "오늘 안에 사야 되는데 언제 고쳐져요?" 처럼 사정을 말하거나 묻는 문장은 지시가 아니라서 잡지 않는다.
 */
import { sentences } from "./text.js";

const PRIORITY = [
  /(?<![\w])P[0-4](?![\w])/i,
  /우선\s*순위|최우선|우선\s*(?:으로|적으로)?\s*처리|긴급(?:으로|하게|히|건|처리)|급하게\s*(?:처리|고쳐|수정|해결|봐)|급히\s*(?:처리|고쳐|수정|해결)|심각도|블로커/,
  /\b(?:urgent(?:ly)?|asap|high\s+priority|top\s+priority|critical|blocker|severity)\b/i,
];

const ASSIGN = [
  /(?:에게|한테|께)\s*(?:배정|할당|맡겨|넘겨|토스)/,
  /(?:배정|할당)(?:해|하세요|해\s*주|하라|해라)/,
  /담당(?:자)?(?:를|을|로)?\s*(?:바꿔|변경|지정|정해)/,
  /\b(?:assign(?:ed)?\s+(?:it\s+|this\s+)?to|escalate)\b/i,
];

const WHEN = /오늘\s*(?:안에|안으로|중에?|중으로|내로|까지)|내일\s*(?:까지|안에|중으로|오전|오후)?|모레|이번\s*주\s*(?:안에|중에?|중으로|까지|내로)|[월화수목금토일]요일\s*(?:까지|안에|전에)|\d+\s*(?:시간|일|분)\s*(?:안에|이내|내로|내에)|당장|지금\s*바로|즉시|\b(?:by\s+(?:today|tomorrow|eod|end\s+of\s+day|monday|tuesday|wednesday|thursday|friday)|within\s+\d+\s+(?:hours?|days?)|right\s+now|immediately)\b/i;
/** 고쳐 달라는 말. "고쳐져요" 처럼 묻거나 사정을 말하는 꼴은 뺀다 */
const DO = /(?:고쳐|수정해|처리해|해결해|반영해|배포해|바꿔|해)\s*(?:주세요|줘요?|주십시오|주시기|주셔야|달라|놔|라|야\s*(?:해요?|합니다|돼요?|됩니다))|(?:고쳐|수정해|처리해|해결해|반영해|배포해|바꿔)\s*(?:$|[.!])|\b(?:fix|ship|deploy|resolve|do)\s+(?:it|this)\b/i;

export function customerClaims(text: string): string[] {
  const out: string[] = [];
  for (const { text: s } of sentences(text)) {
    const hit = PRIORITY.some((re) => re.test(s)) || ASSIGN.some((re) => re.test(s)) || (WHEN.test(s) && DO.test(s));
    if (hit && !out.includes(s)) out.push(s);
  }
  return out;
}
