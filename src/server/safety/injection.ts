/**
 * 고객 글 속 프롬프트 인젝션 의심 문장 (ticket-plan.md F10, research/tech.md 5절). 경고만 하고 막지 않는다.
 * 보안 경계는 이 탐지가 아니라 에이전트 권한 설정이다. 오탐으로 경고에 무뎌지지 않게 평범한 문의에서 자주 나오는
 * 말("이전 주문 무시", "비밀번호를 잊었어요")은 잡지 않는다.
 */
import { lineAround } from "./text.js";

const RULES: { pattern: string; re: RegExp }[] = [
  // 이전 지시 무시
  { pattern: "ignore_instructions", re: /\b(?:ignore|disregard|forget|override|bypass)\b[^\n.]{0,30}?\b(?:previous|prior|above|earlier|all|any|your|the)\b[^\n.]{0,20}?\b(?:instructions?|prompts?|rules|directions|guidelines|context)\b/gi },
  { pattern: "ignore_instructions", re: /(?:이전|앞|위|기존|지금까지|여태|모든|원래)(?:의|에서|에)?\s*(?:모든\s*)?(?:지시|지침|명령|규칙|프롬프트)(?:사항|문|들)?(?:은|는|을|를|도|이|가)?\s*(?:모두\s*|전부\s*|다\s*)?(?:무시|잊어|잊고|따르지\s*마|취소)/g },
  { pattern: "ignore_instructions", re: /(?:지시|지침|명령|규칙|프롬프트)(?:은|는|을|를)?\s*(?:모두\s*|전부\s*|다\s*)?무시(?:하고|해|하세요|하라|하십시오)/g },
  // 시스템 프롬프트
  { pattern: "system_prompt", re: /\b(?:system|hidden|initial|developer)\s+(?:prompt|message|instructions?)\b/gi },
  { pattern: "system_prompt", re: /\b(?:reveal|print|show|repeat|output|leak)\b[^\n.]{0,20}\b(?:your|the)\s+(?:prompt|instructions)\b/gi },
  { pattern: "system_prompt", re: /시스템\s*(?:프롬프트|메시지|지시)|(?:숨겨진|원래|초기)\s*(?:지시|프롬프트)|프롬프트(?:를|을)?\s*(?:알려|보여|출력|공개|말해)/g },
  // 역할 바꾸기
  { pattern: "role_change", re: /\b(?:you\s+are\s+now|from\s+now\s+on,?\s+you|pretend\s+(?:to\s+be|you\s+are)|roleplay\s+as|act\s+as\s+(?:an?\s+)?(?:admin|administrator|developer|system|root|unrestricted))\b|\b(?:developer|god|jailbreak|DAN)\s+mode\b/gi },
  { pattern: "role_change", re: /(?<![가-힣])(?:너|넌|당신|니가|네가)(?:는|은)?\s*이제(?:부터)?|지금부터\s*(?:너|넌|당신)(?:는|은)?|(?:관리자|개발자|운영자|탈옥|제한\s*없는)\s*모드|역할(?:을|를)?\s*(?:바꿔|바꾸|맡아|맡으)/g },
  // 셸 명령
  { pattern: "shell_command", re: /\b(?:curl|wget)\s+(?:-{1,2}\w+\s+)*['"]?(?:https?:\/\/|\S+\.\S+)|\brm\s+-(?:rf|fr|r|f)\b|\|\s*(?:ba|z)?sh\b|\bsudo\s+\S|\bchmod\s+(?:[0-7]{3,4}|\+x)\b|\b(?:Invoke-WebRequest|iwr|Invoke-Expression|iex)\b|\bnc\s+-e\b|\bbase64\s+(?:-d|--decode)\b/g },
  // 비밀 경로와 토큰
  { pattern: "secret_path", re: /(?<![\w.])\.env(?:\.\w+)?\b|~\/\.ssh\b|\.ssh\/|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials|\/etc\/(?:passwd|shadow)\b|\.git-credentials|\.npmrc\b|keys\.env\b|credentials\.json\b/g },
  { pattern: "secret_path", re: /\b(?:print|show|send|cat|read|reveal|leak|dump|exfiltrate|upload|post)\b[^\n.]{0,30}\b(?:tokens?|api[\s_-]?keys?|secrets?|passwords?|credentials|private\s+keys?)\b/gi },
  { pattern: "secret_path", re: /(?:토큰|API\s*키|api\s*키|비밀\s*키|시크릿|환경\s*변수|인증\s*정보|개인\s*키)\s*(?:을|를|값을|값)?\s*(?:모두\s*|전부\s*)?(?:알려|보내|출력|보여|읽어|올려|적어|붙여)/g },
  // 가짜 역할 태그와 비신뢰 구역 닫기
  { pattern: "fake_tag", re: /<\/?\s*(?:system|assistant|developer|instructions?)\s*>|\[\/?(?:SYSTEM|INST)\]|<\/\s*untrusted_customer_text\s*>|^#{1,3}\s*(?:system|instructions?)\b/gim },
  // 글을 읽는 AI 에게 말 걸기
  { pattern: "address_ai", re: /이\s*(?:글|문의|메시지|티켓)(?:을|를)?\s*(?:읽는|보는|처리하는)\s*(?:AI|에이전트|챗봇|모델|어시스턴트)|\b(?:to|for)\s+(?:the|any)\s+(?:AI|LLM|assistant|agent)\s+(?:reading|processing)\b|\bAI\s+(?:agents?|assistants?)\s*:/gi },
];

export function detectInjection(text: string): { pattern: string; excerpt: string }[] {
  const out: { pattern: string; excerpt: string }[] = [];
  const seen = new Set<string>();
  for (const { pattern, re } of RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const excerpt = lineAround(text, m.index, m.index + m[0].length);
      const key = `${pattern}\n${excerpt}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ pattern, excerpt });
      }
    }
  }
  return out;
}
