/**
 * 비신뢰 글 감싸기 (Spotlighting 의 데이터마킹). 고정 태그 안에 넣고 줄마다 "^ " 를 붙인다.
 * 글 안에 같은 태그가 있으면 꺾쇠를 전각(＜ ＞)으로 바꿔 구역을 닫거나 새로 열지 못하게 한다.
 */

export const UNTRUSTED_TAG = "untrusted_customer_text";
const TAG_IN_TEXT = /<(\s*\/?\s*untrusted_customer_text\b[^<>\n]*)>/gi;

export function datamark(text: string): string {
  const safe = text.replace(/\r\n?/g, "\n").replace(TAG_IN_TEXT, "＜$1＞").replace(/\n+$/, "");
  const lines = safe.split("\n").map((l) => `^ ${l}`);
  return `<${UNTRUSTED_TAG}>\n${lines.join("\n")}\n</${UNTRUSTED_TAG}>`;
}
