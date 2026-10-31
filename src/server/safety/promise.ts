/**
 * 고객 답장 초안의 근거 없는 약속 (ticket-plan.md F7). 날짜 표현("내일", "곧", "이번 주 안에")은 시스템이 아는 사실이
 * 아니라서 언제나 걸린다. 완료형은 facts 가 받쳐 줄 때만 허용한다: merged 면 "반영됐어요", deployed 면 "배포됐어요".
 */

const DATE_RULES: RegExp[] = [
  /(?<![가-힣])(?:내일|모레|금일|익일)(?:\s*(?:까지|중|중으로|안에|오전|오후))?/g,
  /(?<![가-힣])곧(?:바로)?(?![가-힣])|(?<![가-힣])곧바로|(?<![가-힣])(?:금방|조만간|머지않아|빠른\s*시일\s*(?:안|내)에?)/g,
  /(?<![가-힣])오늘\s*(?:중으로|중에|중|안에|안으로|내로|내|까지)/g,
  /(?<![가-힣])(?:이번|다음)\s*주(?!문|소|식|인|제|요|민|사|의)(?:\s*(?:안에|안으로|중으로|중에|중|내로|내|까지|에|초|말))?/g,
  /(?<![가-힣])(?:주말|월말|연말)(?:\s*(?:까지|안에|전에|중))?/g,
  /[월화수목금토일]요일\s*(?:까지|안에|전에|중|에)/g,
  /\d+\s*(?:분|시간|일|주)\s*(?:안에|안으로|이내|내로|내에|뒤에?|후에?)/g,
  /\d{1,2}\s*월\s*\d{1,2}\s*일(?:\s*(?:까지|에|중))?/g,
  /\b(?:tomorrow|soon|shortly|tonight|this\s+week|next\s+week|by\s+(?:monday|tuesday|wednesday|thursday|friday|eod|end\s+of\s+(?:day|week))|within\s+\d+\s+(?:hours?|days?))\b/gi,
];

/** 병합이 받쳐 줘야 하는 완료형. 뒤에 "는지", "을지" 가 오면 묻는 말이라 뺀다 */
const MERGED = /(?:반영|수정|해결)(?:\s*(?:완료|됐|되었|했|하였|해\s*드렸|해\s*놓았|해\s*두었))(?!는지|을지|나요|는지요)|고쳐\s*(?:졌|놨|놓았|드렸)(?!는지|을지|나요)|고쳤(?!는지|을지|나요)|\b(?:fixed|resolved|has\s+been\s+fixed)\b/gi;
/** 배포가 받쳐 줘야 하는 완료형 */
const DEPLOYED = /(?:배포|적용|출시|업데이트)(?:\s*(?:완료|됐|되었|했|하였))(?!는지|을지|나요|는지요)|이제\s*(?:정상적으로|문제\s*없이)?\s*(?:이용|사용|결제|주문)하실\s*수\s*있|\b(?:deployed|released|is\s+live|now\s+live)\b/gi;

export function checkPromises(text: string, facts: { merged?: boolean; deployed?: boolean }): { phrase: string; reason: string }[] {
  const out: { phrase: string; reason: string }[] = [];
  const add = (phrase: string, reason: string) => {
    const p = phrase.trim();
    if (!out.some((o) => o.phrase === p)) out.push({ phrase: p, reason });
  };
  const all = (re: RegExp) => {
    re.lastIndex = 0;
    return [...text.matchAll(re)].map((m) => m[0]);
  };
  for (const re of DATE_RULES) for (const p of all(re)) add(p, "날짜 약속이에요. 시스템에 기록된 일정이 없어요");
  if (!facts.deployed) {
    for (const p of all(DEPLOYED)) add(p, "배포 기록이 없어요");
    if (!facts.merged) for (const p of all(MERGED)) add(p, "병합 기록이 없어요");
  }
  return out;
}
