/**
 * Block Kit for the request thread. Pure: no Slack calls, no node imports.
 *
 * Everyone in a channel sees the same message, so each message carries the requester's body as its main text and the
 * developer's technical line in a small context block under it. The full spec and proposal open as an ephemeral
 * message from the "개발자용 보기" button.
 */
import { cardBodies, TYPE_KO } from "../request-state.js";
import type { AgentRun, Request, RequesterCheck, Run } from "../types.js";
import type { Block, SlackMessage } from "./client.js";

export const MODAL = "wn_modal";
export type ModalKind = "changes" | "decline" | "recheck" | "skip" | "reject";
/** what a modal is about, carried in private_metadata */
export interface ModalMeta {
  k: ModalKind;
  r: string;
  ch: string;
  th: string;
  run?: string;
  a?: string;
}

/** @이름 → <@U…> when the Slack id is known */
export type At = (name: string) => string;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Slack mrkdwn needs &, <, > escaped in anything a person or the planner wrote. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Escape, then turn @이름 into Slack mentions. */
export const mentionify = (s: string, at: At) => esc(s).replace(/@([\p{L}\p{N}_]+)/gu, (_, name: string) => (name === "willnew" ? "@willnew" : at(name)));

/** Slack's text format → what the request keeps: <@U…> → @이름 (the bot → @willnew), <url|label> → url, entities decoded. */
export function fromSlack(text: string, botUserId: string | undefined, nameOf: (id: string) => string | undefined): string {
  return text
    .replace(/<@([A-Z0-9_]+)(?:\|[^>]*)?>/g, (_, id: string) => (id === botUserId ? "@willnew" : `@${nameOf(id) ?? id}`))
    .replace(/<#[A-Z0-9_]+\|([^>]*)>/g, "#$1")
    .replace(/<((?:https?|mailto):[^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

const plain = (text: string) => ({ type: "plain_text", text: cut(text, 75), emoji: false });
const md = (text: string) => ({ type: "mrkdwn", text: cut(text, 2900) });
export const section = (text: string): Block => ({ type: "section", text: md(text) });
export const context = (...texts: (string | undefined | false)[]): Block => ({ type: "context", elements: texts.filter((t): t is string => !!t).map(md) });
const button = (text: string, action_id: string, value: unknown, style?: "primary" | "danger"): Block =>
  ({ type: "button", text: plain(text), action_id, value: JSON.stringify(value), ...(style ? { style } : {}) });
const link = (text: string, url: string, action_id: string): Block => ({ type: "button", text: plain(text), url, action_id });
const actions = (block_id: string, elements: Block[]): Block => ({ type: "actions", block_id, elements });
const dev = (text: string) => `개발자용: ${text}`;

/** The web page of the request card, when the hub has a URL people can open. */
export const requestLink = (base: string | undefined, req: Pick<Request, "id" | "channel">) =>
  base ? `${base.replace(/\/+$/, "")}/#/chat/${encodeURIComponent(req.channel)}/m/req-${req.id}` : undefined;

/** The live card: requester body on top, the developer's line folded under it, the original message stays the thread root. */
export function cardMessage(req: Request, webBaseUrl?: string): SlackMessage {
  const b = cardBodies(req);
  const url = requestLink(webBaseUrl, req);
  const meta = [req.type ? TYPE_KO[req.type] : undefined, `요청 ${req.requester}`].filter(Boolean).join(", ");
  return {
    text: `${req.title}: ${b.forRequester}`,
    blocks: [
      section(`*${esc(req.title)}*\n${esc(b.forRequester)}`),
      context(esc(dev(b.forDeveloper)), esc(meta)),
      actions("wn_card", [button("개발자용 보기", "wn_details", { r: req.id }), ...(url ? [link("웹에서 보기", url, "wn_link_card")] : [])]),
    ],
  };
}

/** One clarify question: choices as buttons, 직접 쓰기 = a reply in the thread. After the answer the buttons go away. */
export function questionMessage(req: Request, index: number, at: At): SlackMessage {
  const q = req.questions[index];
  const head = index === 0 ? `${at(req.requester)} 확인할 게 ${req.questions.length}개 있어요\n` : "";
  const num = req.questions.length > 1 ? `(${index + 1}/${req.questions.length}) ` : "";
  if (q.answer)
    return { text: `${q.question}: ${q.answer}`, blocks: [section(`${num}${esc(q.question)}\n답: *${esc(q.answer)}* (${esc(q.answeredBy ?? req.requester)})`)] };
  return {
    text: `${q.question} (${q.choices.join(", ")})`,
    blocks: [
      section(`${head}${num}*${esc(q.question)}*`),
      ...(q.why ? [context(esc(dev(q.why)))] : []),
      actions(`wn_q_${q.id}`, [
        ...q.choices.slice(0, 4).map((c, i) => button(c, `wn_answer_${i}`, { r: req.id, q: q.id, i })),
        button("직접 쓸게요", "wn_write", { r: req.id, q: q.id }),
      ]),
    ],
  };
}

/** "이렇게 개발할까요?": the requester reads the plain summary, the developer the proposal line and the four buttons. */
export function proposalMessage(req: Request, at: At, outcome?: string): SlackMessage {
  const p = req.proposal;
  const who = req.reviewer ? at(req.reviewer) : "개발자님,";
  const forRequester = req.spec?.summary.forRequester ?? req.understood?.forRequester ?? req.title;
  const facts = p ? `바꿀 파일 ${p.files.length}개, 예상 ${p.estimate.minutes}분${p.risks.length ? `, 위험 ${p.risks.length}개` : ""}` : "";
  const blocks: Block[] = [
    section(`${who} 확인할 제안이 있어요\n${esc(forRequester)}`),
    context(esc(dev(`${p?.summary ?? req.title}${facts ? ` (${facts})` : ""}`))),
  ];
  if (outcome) blocks.push(context(esc(outcome)));
  else blocks.push(actions("wn_decide", [
    button("진행", "wn_decide_proceed", { r: req.id, d: "proceed" }, "primary"),
    button("고쳐서 진행", "wn_decide_changes", { r: req.id, d: "proceed_with_changes" }),
    button("직접 할게", "wn_decide_take", { r: req.id, d: "take_over" }),
    button("거절", "wn_decide_decline", { r: req.id, d: "decline" }, "danger"),
    button("개발자용 보기", "wn_details", { r: req.id }),
  ]));
  return { text: `${who} 확인할 제안이 있어요. ${esc(p?.summary ?? req.title)}`, blocks };
}

/** 요청자 확인: the requester looks at the screen; the developer can skip it with a reason. */
export function checkMessage(req: Request, c: RequesterCheck, at: At, outcome?: string): SlackMessage {
  const again = c.round > 1 ? "다시 고친 결과예요. " : "";
  const links: Block[] = [];
  if (c.previewUrl) links.push(link("미리보기 열기", c.previewUrl, "wn_link_after"));
  if (c.baseUrl) links.push(link("지금 화면 열기", c.baseUrl, "wn_link_before"));
  const notes = [
    c.capture === "running" ? "전후 화면을 찍는 중이에요" : undefined,
    c.localOnly && (c.previewUrl || c.baseUrl) ? "미리보기 링크는 willnew 를 띄운 PC 에서만 열려요" : undefined,
    c.note,
  ].filter(Boolean).join(". ");
  const blocks: Block[] = [
    section(`${at(req.requester)} ${again}화면을 보고 의도대로인지 알려 주세요`),
    context(esc(dev(`요청자 확인 차례예요 (${c.round}차)`)), notes && esc(notes)),
  ];
  if (!outcome) blocks.push(actions(`wn_check_${c.round}`, [
    button("의도대로예요", "wn_check_ok", { r: req.id, v: "ok", n: c.round }, "primary"),
    button("다시 봐 주세요", "wn_check_changes", { r: req.id, v: "changes", n: c.round }),
    button("개발자용 건너뛰기", "wn_check_skip", { r: req.id, v: "skip", n: c.round }),
    ...links,
  ]));
  else {
    blocks.push(context(esc(outcome)));
    if (links.length) blocks.push(actions(`wn_check_${c.round}`, links));
  }
  return { text: `${at(req.requester)} ${again}화면을 보고 의도대로인지 알려 주세요`, blocks };
}

/** `@이해준 검토 차례예요. 테스트 7개 통과, main과 충돌 없음` with 승인 and 반려. */
export function reviewBlocks(req: Request, run: Run, agent: AgentRun | undefined, line: string, at: At, webBaseUrl?: string, outcome?: string): SlackMessage {
  const d = agent?.diff;
  const facts = d ? `파일 ${d.files}개, +${d.insertions} -${d.deletions}${agent?.attempt && agent.attempt > 1 ? `, 재시도 ${agent.attempt - 1}회` : ""}` : "";
  const url = requestLink(webBaseUrl, req);
  const blocks: Block[] = [
    section(mentionify(line, at)),
    context("요청자에게: 개발자가 결과를 보고 있어요", facts && esc(dev(facts))),
  ];
  const value = { r: req.id, run: run.id, a: agent?.id };
  if (outcome) blocks.push(context(esc(outcome)));
  else blocks.push(actions("wn_review", [
    button("승인", "wn_review_approve", { ...value, d: "approve" }, "primary"),
    button("반려", "wn_review_reject", { ...value, d: "reject" }, "danger"),
    button("개발자용 보기", "wn_details", { r: req.id }),
    ...(url ? [link("웹에서 diff 보기", url, "wn_link_review")] : []),
  ]));
  return { text: mentionify(line, at), blocks };
}

/** 반영 단계 줄 (PR, CI, 병합, 배포), edited in place as the stages come in. */
export function shipMessage(lines: string[]): SlackMessage {
  return { text: lines.at(-1) ?? "반영 중", blocks: [section(`*반영*\n${lines.join("\n")}`)] };
}

/** A line for both: plain words on top, the developer's version folded under it. */
export function both(forRequester: string, forDeveloper: string | undefined, at: At): SlackMessage {
  return { text: mentionify(forRequester, at), blocks: [section(mentionify(forRequester, at)), ...(forDeveloper ? [context(mentionify(dev(forDeveloper), at))] : [])] };
}

/** The approver's answer to the requester, sent by the bot on their behalf. */
export function replyFrom(who: string, text: string, at: At): SlackMessage {
  return { text: mentionify(text, at), blocks: [section(mentionify(text, at)), context(`${esc(who)}님이 willnew 로 보낸 답장이에요`)] };
}

const list = (xs: string[]) => xs.map((x) => `• ${esc(x)}`).join("\n");

/** "개발자용 보기": the spec, the proposal and the latest result, as an ephemeral message. */
export function detailsMessage(req: Request, run?: Run): SlackMessage {
  const s = req.spec;
  const p = req.proposal;
  const parts: string[] = [`*${esc(req.title)}* (${req.status}${req.type ? `, ${TYPE_KO[req.type]}` : ""})`];
  if (s) {
    parts.push(`*문제*\n${esc(s.problem)}\n*기대 결과*\n${esc(s.expected)}`);
    parts.push(`*수용 기준*\n${list(s.acceptanceCriteria)}`);
    if (s.outOfScope.length) parts.push(`*범위 밖*\n${list(s.outOfScope)}`);
    if (s.constraints.length) parts.push(`*개발자 조건*\n${list(s.constraints)}`);
    if (s.needsCheck?.length) parts.push(`*확인 필요 (저장소에 없는 이름)*\n${list(s.needsCheck.map((f) => `${f.names.join(", ")}: ${f.criterion}`))}`);
  } else if (req.understood) parts.push(esc(req.understood.forDeveloper));
  if (p) {
    parts.push(`*제안*\n${esc(p.summary)}${p.approach.length ? `\n${list(p.approach)}` : ""}`);
    if (p.files.length) parts.push(`*바꿀 파일*\n${list(p.files.map((f) => `${f.path}: ${f.why}`))}`);
    if (p.risks.length) parts.push(`*위험*\n${list(p.risks)}`);
    if (p.testsToAdd.length) parts.push(`*추가할 테스트*\n${list(p.testsToAdd)}`);
    parts.push(`예상 ${p.estimate.minutes}분${p.estimate.costUsd != null ? `, $${p.estimate.costUsd.toFixed(2)}` : ""}, 확신 ${p.confidence}`);
  }
  for (const a of run?.agents ?? [])
    parts.push(`*결과 ${esc(a.label)}*: ${a.status}, 검증 ${a.check.status}, 파일 ${a.diff.files}개 +${a.diff.insertions} -${a.diff.deletions}${a.summary ? `\n${esc(cut(a.summary, 400))}` : ""}`);
  return { text: `개발자용: ${req.title}`, blocks: parts.map((t) => section(t)).slice(0, 45) };
}

const MODAL_TEXT: Record<ModalKind, { title: string; label: string; submit: string }> = {
  changes: { title: "고쳐서 진행", label: "무엇을 고칠지", submit: "진행" },
  decline: { title: "거절", label: "거절 사유 (요청자에게 쉬운 말로 풀어 전해요)", submit: "거절" },
  recheck: { title: "다시 봐 주세요", label: "어디가 다른지 한 줄로", submit: "보내기" },
  skip: { title: "요청자 확인 건너뛰기", label: "건너뛰는 이유", submit: "건너뛰기" },
  reject: { title: "결과 반려", label: "반려 사유", submit: "반려" },
};

export function modalView(meta: ModalMeta, webBaseUrl?: string, req?: Pick<Request, "id" | "channel">): Block {
  const t = MODAL_TEXT[meta.k];
  const url = meta.k === "recheck" && req ? requestLink(webBaseUrl, req) : undefined;
  return {
    type: "modal", callback_id: MODAL, private_metadata: JSON.stringify(meta),
    title: plain(cut(t.title, 24)), submit: plain(t.submit), close: plain("닫기"),
    blocks: [
      { type: "input", block_id: "text", label: plain(t.label), element: { type: "plain_text_input", action_id: "v", multiline: meta.k !== "recheck", max_length: meta.k === "recheck" ? 200 : 300 } },
      ...(meta.k === "recheck" ? [context(url ? `화면 위에 상자를 그려 표시하려면 <${url}|웹에서 열어> 주세요` : "화면 위에 상자를 그려 표시하는 건 willnew 웹에서 할 수 있어요")] : []),
    ],
  };
}
