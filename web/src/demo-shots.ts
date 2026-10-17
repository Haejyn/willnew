/**
 * 데모의 전후 스크린샷. 가상의 결제 화면(Billo, 지어낸 서비스)을 SVG 로 그려 data URL 로 쓴다. 실제 서비스 화면이 아니다.
 *   before  지금 화면: 버튼 안쪽 여백 8px, 들쭉날쭉한 크기
 *   after1  첫 시도: 여백 16px 로 넓어졌지만, 휴대폰에서 결제 버튼 글자가 두 줄로 내려간다
 *   after2  다시 고친 시도: 휴대폰에서는 버튼을 한 줄에 하나씩, 폭을 꽉 채워 한 줄로
 */
import type { ShotPair } from "./api";

type Variant = "before" | "after1" | "after2";

const FONT = `font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif"`;
const BLUE = "#2f6bff";
const INK = "#16181d";
const SUB = "#5f6670";
const LINE = "#e4e7ec";

/** 대충의 글자 폭: 한글은 글자 크기만큼, 숫자와 쉼표는 0.6, 빈칸은 0.3 */
const textW = (s: string, fs: number) => [...s].reduce((w, c) => w + (/[가-힣]/.test(c) ? fs * 0.98 : c === " " ? fs * 0.3 : fs * 0.6), 0);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function text(x: number, y: number, s: string, o: { fs?: number; w?: number; fill?: string; anchor?: "start" | "middle" | "end" } = {}) {
  return `<text x="${x}" y="${y}" font-size="${o.fs ?? 15}" font-weight="${o.w ?? 400}" fill="${o.fill ?? INK}" text-anchor="${o.anchor ?? "start"}" ${FONT}>${esc(s)}</text>`;
}

/** 버튼 하나. lines 가 둘이면 글자가 두 줄로 내려간 모습 */
function button(x: number, y: number, label: string | string[], o: { pad: number; h: number; fs: number; primary?: boolean; w?: number }) {
  const lines = Array.isArray(label) ? label : [label];
  const w = o.w ?? Math.round(Math.max(...lines.map((l) => textW(l, o.fs))) + o.pad * 2);
  const fill = o.primary ? BLUE : "#ffffff";
  const stroke = o.primary ? BLUE : "#cfd5dd";
  const color = o.primary ? "#ffffff" : INK;
  const lh = o.fs * 1.35;
  const top = y + o.h / 2 - ((lines.length - 1) * lh) / 2 + o.fs * 0.35;
  return {
    w,
    svg: `<rect x="${x}" y="${y}" width="${w}" height="${o.h}" rx="8" fill="${fill}" stroke="${stroke}"/>` + lines.map((l, i) => text(x + w / 2, top + i * lh, l, { fs: o.fs, w: 600, fill: color, anchor: "middle" })).join(""),
  };
}

function field(x: number, y: number, w: number, label: string, value: string, fs = 15) {
  return text(x, y, label, { fs: 13, fill: SUB }) + `<rect x="${x}" y="${y + 8}" width="${w}" height="40" rx="8" fill="#ffffff" stroke="${LINE}"/>` + text(x + 12, y + 34, value, { fs, fill: value.startsWith("예:") ? "#9aa1ab" : INK });
}

function desktop(v: Variant): string {
  const pad = v === "before" ? 8 : 16;
  const h = v === "before" ? 34 : 40;
  const fs = 15;
  const parts: string[] = [];
  parts.push(`<rect width="1440" height="900" fill="#f4f5f7"/>`);
  parts.push(`<rect width="1440" height="64" fill="#ffffff"/><rect y="64" width="1440" height="1" fill="${LINE}"/>`);
  parts.push(text(48, 40, "Billo", { fs: 20, w: 800 }));
  parts.push(text(160, 39, "요금제", { fs: 14, fill: SUB }) + text(228, 39, "결제 내역", { fs: 14, fill: SUB }) + text(316, 39, "설정", { fs: 14, fill: SUB }));
  parts.push(`<circle cx="1392" cy="32" r="16" fill="#dfe4ea"/>`);
  parts.push(text(240, 128, "결제", { fs: 28, w: 700 }));
  // 카드 정보
  parts.push(`<rect x="240" y="160" width="560" height="440" rx="12" fill="#ffffff" stroke="${LINE}"/>`);
  parts.push(text(272, 200, "카드 정보", { fs: 17, w: 700 }));
  parts.push(field(272, 236, 496, "카드 번호", "1234 •••• •••• 5678"));
  parts.push(field(272, 306, 240, "유효기간", "08 / 28") + field(528, 306, 240, "CVC", "•••"));
  parts.push(field(272, 376, 360, "쿠폰 코드", "예: WELCOME10"));
  const coupon = button(644, 384 + (40 - h) / 2, "쿠폰 적용", { pad, h, fs });
  parts.push(coupon.svg);
  parts.push(`<rect x="272" y="452" width="496" height="1" fill="${LINE}"/>`);
  parts.push(text(272, 494, "결제 카드", { fs: 13, fill: SUB }) + text(272, 520, "현대카드 •••• 5678", { fs: 15 }));
  parts.push(button(272, 540, "카드 변경", { pad, h, fs }).svg);
  // 주문 요약
  parts.push(`<rect x="840" y="160" width="360" height="440" rx="12" fill="#ffffff" stroke="${LINE}"/>`);
  parts.push(text(872, 200, "주문 요약", { fs: 17, w: 700 }));
  parts.push(text(872, 244, "Pro 요금제 (월)", { fs: 15 }) + text(1168, 244, "19,800원", { fs: 15, anchor: "end" }));
  parts.push(text(872, 274, "부가세 포함", { fs: 13, fill: SUB }));
  parts.push(`<rect x="872" y="300" width="296" height="1" fill="${LINE}"/>`);
  parts.push(text(872, 340, "합계", { fs: 16, w: 700 }) + text(1168, 340, "19,800원", { fs: 20, w: 800, anchor: "end" }));
  parts.push(text(872, 372, "다음 결제일 11월 17일", { fs: 13, fill: SUB }));
  const back = button(872, 540 - (h - 34), "이전", { pad, h, fs });
  const pay = button(872 + back.w + 8, 540 - (h - 34), "결제하기 19,800원", { pad, h, fs, primary: true });
  parts.push(back.svg + pay.svg);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">${parts.join("")}</svg>`;
}

function mobile(v: Variant): string {
  const parts: string[] = [];
  parts.push(`<rect width="390" height="844" fill="#f4f5f7"/>`);
  parts.push(`<rect width="390" height="56" fill="#ffffff"/><rect y="56" width="390" height="1" fill="${LINE}"/>`);
  parts.push(text(16, 35, "Billo", { fs: 18, w: 800 }) + `<circle cx="360" cy="28" r="14" fill="#dfe4ea"/>`);
  parts.push(text(16, 98, "결제", { fs: 24, w: 700 }));
  // 주문 요약
  parts.push(`<rect x="16" y="116" width="358" height="150" rx="12" fill="#ffffff" stroke="${LINE}"/>`);
  parts.push(text(32, 148, "Pro 요금제 (월)", { fs: 15 }) + text(358, 148, "19,800원", { fs: 15, anchor: "end" }));
  parts.push(text(32, 174, "부가세 포함", { fs: 13, fill: SUB }));
  parts.push(`<rect x="32" y="192" width="326" height="1" fill="${LINE}"/>`);
  parts.push(text(32, 230, "합계", { fs: 16, w: 700 }) + text(358, 230, "19,800원", { fs: 20, w: 800, anchor: "end" }));
  parts.push(text(32, 252, "다음 결제일 11월 17일", { fs: 12, fill: SUB }));
  // 카드 정보
  parts.push(`<rect x="16" y="282" width="358" height="300" rx="12" fill="#ffffff" stroke="${LINE}"/>`);
  parts.push(text(32, 314, "카드 정보", { fs: 16, w: 700 }));
  parts.push(field(32, 340, 326, "카드 번호", "1234 •••• •••• 5678", 14));
  parts.push(field(32, 410, 214, "쿠폰 코드", "예: WELCOME10", 14));
  const pad = v === "before" ? 8 : 16;
  const h = v === "before" ? 34 : 40;
  const coupon = button(254, 418 + (40 - h) / 2, "쿠폰 적용", { pad, h, fs: 14, w: v === "before" ? undefined : 104 });
  parts.push(coupon.svg);
  parts.push(text(32, 508, "현대카드 •••• 5678", { fs: 14 }));
  parts.push(button(32, 524, "카드 변경", { pad, h, fs: 14 }).svg);
  // 아래 결제 막대
  if (v === "after2") {
    parts.push(`<rect y="700" width="390" height="144" fill="#ffffff"/><rect y="700" width="390" height="1" fill="${LINE}"/>`);
    parts.push(button(16, 716, "결제하기 19,800원", { pad, h: 48, fs: 16, primary: true, w: 358 }).svg);
    parts.push(button(16, 772, "이전", { pad, h: 44, fs: 15, w: 358 }).svg);
  } else {
    parts.push(`<rect y="748" width="390" height="96" fill="#ffffff"/><rect y="748" width="390" height="1" fill="${LINE}"/>`);
    if (v === "before") {
      const back = button(16, 772, "이전", { pad, h: 36, fs: 15 });
      parts.push(back.svg + button(16 + back.w + 8, 772, "결제하기 19,800원", { pad, h: 36, fs: 15, primary: true }).svg);
    } else {
      // 첫 시도: 여백은 넓어졌는데 두 버튼이 한 줄에 같은 폭으로 있어서 결제 버튼 글자가 두 줄로 내려간다
      parts.push(button(16, 762, "이전", { pad, h: 58, fs: 16, w: 175 }).svg);
      parts.push(button(199, 762, ["결제하기", "19,800원"], { pad, h: 58, fs: 16, primary: true, w: 175 }).svg);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">${parts.join("")}</svg>`;
}

const url = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** 결제 화면의 전후 쌍. round 1 은 첫 시도, 2 이상은 다시 고친 시도 */
export function checkoutPairs(round: number, screen = "결제 화면", path = "/checkout"): ShotPair[] {
  const after: Variant = round > 1 ? "after2" : "after1";
  return [
    { screen, path, viewport: "desktop", width: 1440, height: 900, before: url(desktop("before")), after: url(desktop(after)) },
    { screen, path, viewport: "mobile", width: 390, height: 844, before: url(mobile("before")), after: url(mobile(after)) },
  ];
}
