/** safety 안에서 같이 쓰는 글 조각 도우미 */

/** 줄과 문장 끝(. ! ? 와 줄바꿈)으로 나눈다. 대화 기록의 "[14:03] " 시각 머리는 뗀다 */
export function sentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /[^\n.!?。]+[.!?。]*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const lead = /^\s*(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?/.exec(m[0])![0].length;
    const s = m[0].slice(lead).trim();
    if (s) out.push({ text: s, start: m.index + lead });
  }
  return out;
}

/** 찾은 자리가 들어 있는 줄. 길면 앞뒤를 자른다 */
export function lineAround(text: string, start: number, end: number, max = 120): string {
  const a = text.lastIndexOf("\n", start - 1) + 1;
  const bRaw = text.indexOf("\n", end);
  const b = bRaw === -1 ? text.length : bRaw;
  const line = text.slice(a, b).trim();
  if (line.length <= max) return line;
  const from = Math.max(a, start - Math.floor((max - (end - start)) / 2));
  const to = Math.min(b, from + max);
  return `${from > a ? "…" : ""}${text.slice(from, to).trim()}${to < b ? "…" : ""}`;
}
