/**
 * 개인정보 가리기 (m1-contract.md 2절). 정규식과 체크섬만 쓰고 LLM 은 부르지 않는다.
 * 찾는 것: 주민등록번호(체크섬), 카드번호(Luhn), 전화, 이메일, 은행 계좌, 이름(팀 사전과 규칙).
 * 주문번호(ORD-20261028-0003), 날짜, 금액(30,000원), 수량은 그대로 둔다.
 */

export type PiiKind = "rrn" | "card" | "phone" | "email" | "account" | "name";
export interface Redaction { token: string; kind: PiiKind; value: string; start: number; end: number }

interface Hit { kind: PiiKind; start: number; end: number; value: string }

const LABEL: Record<PiiKind, string> = { rrn: "RRN", card: "CARD", phone: "PHONE", email: "EMAIL", account: "ACCOUNT", name: "NAME" };
/** 겹치면 앞의 것이 이긴다 */
const ORDER: PiiKind[] = ["email", "rrn", "card", "phone", "account", "name"];

const digits = (s: string) => s.replace(/\D/g, "");

// 숫자 덩어리의 앞뒤 경계. 영문, 숫자, 하이픈에 붙어 있으면 다른 번호(주문번호, 상담 ID)의 일부로 본다
const B = String.raw`(?<![\w-])`;
const E = String.raw`(?![\w])(?!-\d)`;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const RRN = new RegExp(`${B}(\\d{6})\\s?-?\\s?([1-8]\\d{6})${E}`, "g");
const CARD = new RegExp(`${B}(?:\\d{4}([ -])\\d{4}\\1\\d{4}\\1\\d{1,7}|\\d{4}([ -])\\d{6}\\2\\d{4,5}|\\d{13,19})${E}`, "g");
const PHONE_PARTS = [
  String.raw`\+82[ -]?(?:0?1[016789]|0?2|0?[3-6][1-5])[ .-]?\d{3,4}[ .-]?\d{4}`,
  `${B}01[016789][ .-]?\\d{3,4}[ .-]?\\d{4}`,
  `${B}02[ .-]?\\d{3,4}[ .-]?\\d{4}`,
  `${B}0(?:3[1-3]|4[1-4]|5[1-5]|6[1-4])[ .-]?\\d{3,4}[ .-]?\\d{4}`,
  `${B}0(?:70|50[2-8])[ .-]?\\d{3,4}[ .-]?\\d{4}`,
  // 대표번호(1588, 1577, 1600, 1800 ...)는 8자리 숫자와 헷갈리지 않게 구분자가 있을 때만
  `${B}1(?:5[0-9]|6[0-9]|8[0-9])\\d[ .-]\\d{4}`,
];
const PHONE = new RegExp(`(?:${PHONE_PARTS.join("|")})${E}`, "g");
const ACCOUNT_DASHED = new RegExp(`${B}\\d{2,7}(?:-\\d{2,7}){1,3}${E}`, "g");
const BANKS = "국민|신한|우리|하나|농협|기업|카카오뱅크|카카오|토스뱅크|토스|케이뱅크|우체국|새마을|신협|수협|SC제일|씨티|부산|대구|경남|광주|전북|제주|산업";
const ACCOUNT_PLAIN = new RegExp(`(?:계좌|입금|예금주|환불\\s*받을|${BANKS})[^\\d\\n]{0,12}${B}(\\d{10,14})${E}`, "g");
const ORDER_CONTEXT = /(?:주문|송장|운송장|접수|예약|order|invoice|tracking)\s*(?:번호|no\.?|#)?\s*[:：]?\s*$/i;
const CODE_CONTEXT = /(?:상품\s*코드|코드|바코드|품번|모델명|ISBN|EAN|SKU|송장|운송장|주문)\s*(?:번호|no\.?|#)?\s*[:：]?\s*$/i;

/** 주민등록번호 앞 6자리가 날짜 꼴인지 */
function birthOk(ymd: string): boolean {
  const m = Number(ymd.slice(2, 4));
  const d = Number(ymd.slice(4, 6));
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** 13자리이고 앞 6자리가 생년월일 꼴, 성별 자리가 1~8 (외국인등록번호 5~8 포함) */
function rrnShapeOk(n: string): boolean {
  const g = Number(n[6]);
  return n.length === 13 && birthOk(n) && g >= 1 && g <= 8;
}

/** 주민등록번호 체크섬. 내국인 공식 또는 옛 외국인 공식(성별 자리 5~8). 2020-10 이후 번호는 맞지 않을 수 있다 */
export function rrnChecksumOk(raw: string): boolean {
  const n = digits(raw);
  if (!rrnShapeOk(n)) return false;
  const g = Number(n[6]);
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = w.reduce((s, x, i) => s + x * Number(n[i]), 0);
  const last = Number(n[12]);
  if ((11 - (sum % 11)) % 10 === last) return true;
  return g >= 5 && (13 - (sum % 11)) % 10 === last;
}

/**
 * 주민등록번호로 잡을지. 하이픈이나 공백으로 나뉜 6-7 꼴은 생년월일과 성별 자리만 본다(2020-10 이후 번호는 끝자리가
 * 체크섬이 아니라서). 붙여 쓴 13자리는 바코드, 상품코드와 겹치므로 체크섬까지 맞아야 한다
 */
export function isRrn(raw: string): boolean {
  const n = digits(raw);
  if (!rrnShapeOk(n)) return false;
  return /\D/.test(raw.trim()) || rrnChecksumOk(n);
}

export function luhnValid(raw: string): boolean {
  const n = digits(raw);
  if (n.length < 13 || n.length > 19 || /^(\d)\1+$/.test(n)) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 하이픈 계좌 꼴이 날짜, 주민번호 꼴, 주문번호가 아닌지 */
function accountShapeOk(value: string, before: string): boolean {
  const n = digits(value);
  if (n.length < 10 || n.length > 14) return false;
  const groups = value.split("-");
  if (groups[0].length < 3) return false;
  if (/^\d{6}-\d{7}$/.test(value)) return false;   // 주민번호 꼴(생년월일이 안 맞아도 계좌로 잡지 않는다)
  if (/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-/.test(value)) return false;   // 2026-10-27-...
  if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(groups[0])) return false;   // 20261028-0003
  return !ORDER_CONTEXT.test(before);
}

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) yield m;
}

// 이름 규칙 ---------------------------------------------------------------

/** "OOO님" 앞에 와도 이름이 아닌 말 */
const NOT_NAMES = new Set(
  (
    "고객 회원 손님 선생 사장 부장 차장 과장 대리 주임 팀장 실장 원장 이사 대표 상무 전무 본부장 센터장 점장 매니저 " +
    "기사 배송기사 택배기사 상담원 상담사 담당 담당자 관리자 운영자 판매자 구매자 주문자 수령자 셀러 작가 교수 박사 " +
    "형 언니 누나 오빠 아버 어머 아버지 어머니 부모 할머 할아버 사모 따 아드 하느 하나 여러 " +
    "기존 신규 해당 우수 모든 많은 다른 일반 단골 개인 법인 이번 저희 우리 여러분 첫 문의 주문 그분 이분 저분 " +
    "님 귀하 각 VIP 고객센터 개발자 디자이너 엔지니어 크리에이터 스트리머 유튜버 회장 총장 소장 국장 반장 조장 의원 장관"
  ).split(/\s+/),
);

/** "OOO 고객님", "OOO님" (앞에 한글이 붙지 않은 두세 글자) */
const NIM = /(?<![가-힣])([가-힣]{2,3})\s?(?:고객님|회원님|님)/g;
/** "고객: 홍길동", "예금주: 홍길동" 처럼 이름 칸 머리말 뒤 두세 글자(줄 끝이나 괄호, 쉼표가 바로 뒤에 올 때만) */
const LABELED = /(?:^|[\s(\[])(?:고객명?|이름|성명|예금주|수령인|수취인|받는\s?분|보내는\s?분|주문자|구매자)\s*[:：]\s*([가-힣]{2,3})(?=\s*(?:$|[(\[,/|<]))/gm;
const NOT_NAME_END = /[요다까죠니네]$/;

function ruleNames(text: string): string[] {
  const found = new Set<string>();
  for (const m of matches(NIM, text)) {
    if (!NOT_NAMES.has(m[1])) found.add(m[1]);
  }
  for (const m of matches(LABELED, text)) {
    const name = m[1];
    if (!NOT_NAMES.has(name) && !NOT_NAME_END.test(name)) found.add(name);
  }
  return [...found];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 이름 바로 뒤에 붙어도 되는 조사와 호칭. 그 밖의 한글이 붙으면("지우개") 다른 낱말로 본다 */
const NAME_TAIL = "(?=[^가-힣]|$|님|씨|고객|은|는|이|가|을|를|에게|께|의|도|랑|과|와)";

/** 사전과 규칙으로 찾은 이름을 글 안의 모든 자리에서 찾는다 */
function nameHits(text: string, names: Iterable<string>): Hit[] {
  const list = [...new Set([...names].map((n) => n.trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  const hits: Hit[] = [];
  for (const name of list) {
    const ascii = /^[\x00-\x7f]+$/.test(name);
    const re = new RegExp(ascii ? `(?<![\\w])${escapeRe(name)}(?![\\w])` : `(?<![가-힣])${escapeRe(name)}${NAME_TAIL}`, ascii ? "gi" : "g");
    for (const m of matches(re, text)) hits.push({ kind: "name", start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  return hits;
}

/** 모든 후보. 겹침은 아직 풀지 않는다 */
function candidates(text: string, names: Iterable<string>): Hit[] {
  const out: Hit[] = [];
  const add = (kind: PiiKind, start: number, value: string) => out.push({ kind, start, end: start + value.length, value });
  for (const m of matches(EMAIL, text)) add("email", m.index, m[0]);
  const before = (at: number) => text.slice(Math.max(0, at - 16), at);
  // 구분자 없는 13자리 이상은 바코드, 상품코드와 겹친다. 그런 말 바로 뒤면 건너뛴다
  const codeLike = (m: RegExpExecArray) => /^\d+$/.test(m[0]) && CODE_CONTEXT.test(before(m.index));
  for (const m of matches(RRN, text)) if (isRrn(m[0]) && !codeLike(m)) add("rrn", m.index, m[0]);
  for (const m of matches(CARD, text)) if (luhnValid(m[0]) && !codeLike(m)) add("card", m.index, m[0]);
  for (const m of matches(PHONE, text)) add("phone", m.index, m[0]);
  for (const m of matches(ACCOUNT_DASHED, text)) {
    if (accountShapeOk(m[0], before(m.index))) add("account", m.index, m[0]);
  }
  for (const m of matches(ACCOUNT_PLAIN, text)) {
    const v = m[1];
    const at = m.index + m[0].length - v.length;
    if (!/^(?:19|20)\d{6}/.test(v) || v.length > 12) add("account", at, v);
  }
  out.push(...nameHits(text, [...names, ...ruleNames(text)]));
  return out;
}

/** 겹치는 후보는 ORDER 순서, 같은 종류면 먼저 나오고 긴 것 */
function pick(hits: Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.start - b.start || b.end - a.end);
  const taken: Hit[] = [];
  for (const h of sorted) if (!taken.some((t) => h.start < t.end && t.start < h.end)) taken.push(h);
  return taken.sort((a, b) => a.start - b.start);
}

/** 같은 값인지 볼 때 쓰는 열쇠. 숫자는 구분자를 빼고, 이메일은 소문자로 */
function keyOf(kind: PiiKind, value: string): string {
  if (kind === "email") return `email:${value.toLowerCase()}`;
  if (kind === "name") return `name:${value.trim()}`;
  return `${kind}:${digits(value)}`;
}

const TOKEN = /\[(RRN|CARD|PHONE|EMAIL|ACCOUNT|NAME)_(\d+)\]/;

/** 개인정보를 [PHONE_1] 같은 표시로 바꾼다. 같은 값은 같은 표시. names 는 팀 사전(고객 이름 목록) */
export function redact(text: string, opts: { names?: string[]; prev?: Redaction[] } = {}): { text: string; items: Redaction[] } {
  const prev = opts.prev ?? [];
  const tokens = new Map<string, string>();
  const count: Record<PiiKind, number> = { rrn: 0, card: 0, phone: 0, email: 0, account: 0, name: 0 };
  for (const p of prev) {
    tokens.set(keyOf(p.kind, p.value), p.token);
    const n = Number(TOKEN.exec(p.token)?.[2] ?? 0);
    if (n > count[p.kind]) count[p.kind] = n;
  }
  const names = [...(opts.names ?? []), ...prev.filter((p) => p.kind === "name").map((p) => p.value)];
  const items: Redaction[] = [];
  let out = "";
  let at = 0;
  for (const h of pick(candidates(text, names))) {
    const key = keyOf(h.kind, h.value);
    let token = tokens.get(key);
    if (!token) {
      token = `[${LABEL[h.kind]}_${++count[h.kind]}]`;
      tokens.set(key, token);
    }
    items.push({ token, kind: h.kind, value: h.value, start: h.start, end: h.end });
    out += text.slice(at, h.start) + token;
    at = h.end;
  }
  return { text: out + text.slice(at), items };
}

/** 표시를 원래 값으로. 같은 표시가 여러 번 나오면 처음 기록된 값을 쓴다 */
export function restore(text: string, items: Redaction[]): string {
  const byToken = new Map<string, string>();
  for (const it of items) if (!byToken.has(it.token)) byToken.set(it.token, it.value);
  return text.replace(/\[(?:RRN|CARD|PHONE|EMAIL|ACCOUNT|NAME)_\d+\]/g, (t) => byToken.get(t) ?? t);
}

/** 가린 결과에 아직 남은 것 (클라우드 직전 이중 검사). 팀 사전 없이 규칙만 본다 */
export function residualPii(text: string): { kind: PiiKind; excerpt: string }[] {
  return pick(candidates(text, [])).map((h) => ({ kind: h.kind, excerpt: h.value }));
}
