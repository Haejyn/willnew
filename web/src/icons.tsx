import type { SVGProps } from "react";
import { icons } from "@theme/icons";

type P = SVGProps<SVGSVGElement> & { size?: number; filled?: boolean };

// 아이콘 경로는 테마가 준다(@theme/icons). 채운 변형은 filled 로.
function themed(name: string) {
  return ({ size = 16, filled, ...rest }: P) => (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}
      dangerouslySetInnerHTML={{ __html: icons[name][filled ? "filled" : "outlined"] }}
    />
  );
}

export const Logo = ({ size = 22, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...rest}>
    <path d="M7.875 4A9 9 0 1 1 7.875 20A8 8 0 1 0 7.875 4Z" fill="var(--accent)" />
  </svg>
);


/** 에이전트 마크 — 각 회사의 색과 결만 따른 단순한 도형. Claude: 코랄색 방사형 별. Codex: 파랑에서 보라로 가는 바탕의 터미널 프롬프트. */
export function AgentMark({ adapter, size = 20 }: { adapter: string; size?: number }) {
  if (adapter === "claude-code") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="amark amark-claude">
        <rect width="24" height="24" rx="7" fill="#D97757" />
        <g stroke="#FFF4EA" strokeWidth="2.1" strokeLinecap="round"><line x1="12.00" y1="9.40" x2="12.00" y2="2.60" /><line x1="13.30" y1="9.75" x2="15.60" y2="5.76" /><line x1="14.25" y1="10.70" x2="20.14" y2="7.30" /><line x1="14.60" y1="12.00" x2="19.20" y2="12.00" /><line x1="14.25" y1="13.30" x2="20.14" y2="16.70" /><line x1="13.30" y1="14.25" x2="15.60" y2="18.24" /><line x1="12.00" y1="14.60" x2="12.00" y2="21.40" /><line x1="10.70" y1="14.25" x2="8.40" y2="18.24" /><line x1="9.75" y1="13.30" x2="3.86" y2="16.70" /><line x1="9.40" y1="12.00" x2="4.80" y2="12.00" /><line x1="9.75" y1="10.70" x2="3.86" y2="7.30" /><line x1="10.70" y1="9.75" x2="8.40" y2="5.76" /></g>
      </svg>
    );
  }
  if (adapter === "codex") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="amark amark-codex">
        <defs>
          <linearGradient id="cx-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6C8CFF" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>
        <rect width="24" height="24" rx="7" fill="url(#cx-grad)" />
        <path d="M7 8.5 L11.2 12 L7 15.5" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13 16 H17.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="amark amark-script">
      <rect width="24" height="24" rx="7" fill="rgba(255,255,255,.14)" />
      <path d="M8 9 L5.5 12 L8 15 M16 9 L18.5 12 L16 15 M13.2 8 L10.8 16" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const IconRuns = themed("list");
export const IconPlus = themed("plus");
export const IconChart = themed("bar-chart");
export const IconCheck = themed("check");
export const IconX = themed("close");
export const IconStop = themed("stop");
export const IconChevron = themed("chevron-right");
export const IconClock = themed("clock");
export const IconTrash = themed("trash");
export const IconFolder = themed("folder");
export const IconTerminal = themed("terminal");
export const IconSpark = themed("sparkles");
export const IconTrophy = themed("trophy");
export const IconArrowLeft = themed("arrow-left");
export const IconBolt = themed("bolt");
export const IconFile = themed("file-text");
export const IconSend = themed("send");
export const IconChat = themed("chat");
export const IconInbox = themed("tray");

// git 그림 — 24 격자, 1.8 선
const gitBase = ({ size = 16, filled: _f, ...rest }: P) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...rest,
});
export const IconMerge = (p: P) => (
  <svg {...gitBase(p)}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="12" r="2" />
    <path d="M6 7v10M6 8c0 3 3 4 10 4" />
  </svg>
);
export const IconBranch = (p: P) => (
  <svg {...gitBase(p)}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="7" r="2" />
    <path d="M6 7v10M18 9c0 5-7 4-11 8" />
  </svg>
);
