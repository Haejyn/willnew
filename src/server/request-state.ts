/**
 * Request state machine and the pure helpers around it. No node imports: the web app and the demo use this file too.
 *
 *   draft → clarifying → spec_ready → proposed → approved → building → verifying → code_review → merged → deployed → closed
 *   (any open state → declined | cancelled)
 */
import type { Bodies, Request, RequestAttachment, RequestStatus, RequestType, Run, WorkSpec } from "./types.js";

/** Allowed moves. Run-driven moves (building ⇄ verifying, code_review → building on a follow-up) are listed too. */
const NEXT: Record<RequestStatus, RequestStatus[]> = {
  draft: ["clarifying", "spec_ready"],
  clarifying: ["spec_ready"],
  spec_ready: ["proposed"],
  proposed: ["approved"],
  // approved → closed: 직접 할게 (the developer finished it outside the AI flow)
  approved: ["building", "closed"],
  building: ["verifying", "code_review"],
  verifying: ["building", "code_review"],
  // B2: verifying → preview (요청자 확인) → code_review. Until then verifying goes straight to code_review.
  code_review: ["building", "merged"],
  merged: ["deployed", "closed"],
  deployed: ["closed"],
  closed: [],
  declined: [],
  cancelled: [],
};

const ENDED = new Set<RequestStatus>(["merged", "deployed", "closed", "declined", "cancelled"]);

/** Open = still something to decide or build. Declined and cancelled are reachable from any open state. */
export const isOpenRequest = (s: RequestStatus) => !ENDED.has(s);

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  if (to === "declined" || to === "cancelled") return isOpenRequest(from);
  return NEXT[from].includes(to);
}

/** Moves the request or throws. Records where a stopped request was. */
export function transition(req: Request, to: RequestStatus, now = Date.now()): Request {
  if (!canTransition(req.status, to)) throw new Error(`요청 상태를 ${req.status} 에서 ${to} 로 바꿀 수 없어요`);
  if (to === "declined" || to === "cancelled") req.stoppedFrom = req.status;
  req.status = to;
  req.updatedAt = now;
  return req;
}

/** Where the linked run says the request is. null = nothing to change (e.g. no passing result yet). */
export function statusFromRun(run: Run): RequestStatus | null {
  const a = run.agents;
  if (!a.length) return "building";
  if (a.some((x) => x.status === "running" || x.status === "retrying" || x.status === "queued")) return "building";
  if (a.some((x) => x.status === "checking")) return "verifying";
  const r = run.review.status;
  if (r === "pending") return "code_review";
  if (r === "rejected") return "declined";
  if (r === "approved") {
    const st = run.ship?.stage;
    if (!st) return "merged";   // merge mode: approval merges right away
    if (st === "merged" || st === "deploying" || st === "deploy_failed") return "merged";
    if (st === "deployed") return "deployed";
    return "code_review";        // pr, ci, ci_failed: approved but not merged yet
  }
  return null;
}

const ORDER: RequestStatus[] = ["draft", "clarifying", "spec_ready", "proposed", "approved", "building", "verifying", "code_review", "merged", "deployed", "closed"];

/** Walk forward to `to` through allowed steps (code_review → merged → deployed in one go). */
export function moveTo(req: Request, to: RequestStatus, now = Date.now()): boolean {
  if (req.status === to) return false;
  if (canTransition(req.status, to)) {
    transition(req, to, now);
    return true;
  }
  let moved = false;
  for (let guard = 0; guard < ORDER.length && req.status !== to; guard++) {
    const step = NEXT[req.status].find((s) => ORDER.indexOf(s) > ORDER.indexOf(req.status) && ORDER.indexOf(s) <= ORDER.indexOf(to));
    if (!step) break;
    transition(req, step, now);
    moved = true;
  }
  return moved;
}

/** Which work template a request type starts from. */
export const TEMPLATE_FOR_TYPE: Record<RequestType, string> = { bug: "bugfix", ui: "feature", copy: "feature", data: "bugfix", other: "feature" };

export const TYPE_KO: Record<RequestType, string> = { bug: "버그", ui: "화면 수정", copy: "문구", data: "데이터", other: "기타" };

/** Image URLs, Figma links and other links in the message. Figma stays a plain URL for now (B4 reads it). */
export function parseAttachments(text: string): RequestAttachment[] {
  const out: RequestAttachment[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)>"']+/g)) {
    const url = m[0].replace(/[.,]+$/, "");
    if (out.some((x) => x.url === url)) continue;
    const kind = /(^https?:\/\/)?([\w-]+\.)?figma\.com\//i.test(url) ? "figma" : /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url) ? "image" : "link";
    out.push({ kind, url });
  }
  return out;
}

/** The developer's 고쳐서 진행 text becomes a constraint on the spec. */
export function withConstraint(spec: WorkSpec, text: string): WorkSpec {
  const t = text.trim();
  return t ? { ...spec, constraints: [...spec.constraints, t] } : spec;
}

/** What the worker agent is asked to do once the developer says go. */
export function buildRunTask(req: Pick<Request, "spec" | "text" | "proposal">, instruction: string): string {
  const s = req.spec;
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const parts = [instruction.trim()];
  if (!s) parts.push(`Request: ${req.text}`);
  else {
    parts.push(`Work spec (agreed with the requester, confirmed by a developer):\nTitle: ${s.title}\nProblem: ${s.problem}\nExpected: ${s.expected}`);
    parts.push(`Acceptance criteria:\n${list(s.acceptanceCriteria)}`);
    if (s.outOfScope.length) parts.push(`Out of scope (do not change):\n${list(s.outOfScope)}`);
    if (s.constraints.length) parts.push(`Developer constraints (these override the proposal):\n${list(s.constraints)}`);
    if (s.needsCheck?.length)
      parts.push(`Names in the criteria that were not found in the repository (do not create them; meet the criterion by its observable behaviour unless a developer constraint says otherwise):\n${list(s.needsCheck.map((f) => `${f.names.join(", ")} (in: ${f.criterion})`))}`);
    if (s.references.length) parts.push(`References:\n${list(s.references)}`);
  }
  if (req.proposal?.approach.length) parts.push(`Proposed approach:\n${list(req.proposal.approach)}`);
  parts.push(`Original message from the requester:\n"""${req.text}"""`);
  parts.push("First write tests that check each acceptance criterion, then change the code until they pass. Do not edit or weaken existing tests that are unrelated to this request.");
  return parts.join("\n\n");
}

/** The one-line status on the live request card, per role. */
export function cardBodies(req: Request): Bodies {
  const dev = req.reviewer ?? "개발자";
  const t = req.title;
  switch (req.status) {
    case "draft":
      return { forRequester: "받았어요. 정리하는 중", forDeveloper: "받았어요. 정리하는 중" };
    case "clarifying": {
      const left = req.questions.filter((q) => !q.answer).length;
      return { forRequester: `${req.understood?.forRequester ?? t} 확인할 게 ${left}개 있어요`, forDeveloper: `되묻는 중 · ${left}/${req.questions.length} 남음 · ${t}` };
    }
    case "spec_ready":
      return { forRequester: "정리했어요. 어떻게 만들지 살펴보는 중", forDeveloper: `명세 완료 · 저장소를 읽고 제안 만드는 중 · ${t}` };
    case "proposed":
      return { forRequester: `개발자가 제안을 보고 있어요 (${dev})`, forDeveloper: `제안: ${req.proposal?.summary ?? t}` };
    case "approved":
      return req.assignee
        ? { forRequester: `${req.assignee}님이 직접 맡았어요`, forDeveloper: `${req.assignee} 직접 작업 · AI 흐름 밖` }
        : { forRequester: "개발자가 확인했어요. 작업 시작해요", forDeveloper: "확인됨 · 작업 시작" };
    case "building":
      return { forRequester: "만드는 중", forDeveloper: `작업 중 · ${t}` };
    case "verifying":
      return { forRequester: "테스트로 확인하는 중", forDeveloper: "검증 중" };
    case "code_review":
      return { forRequester: `개발자가 결과를 보고 있어요 (${dev})`, forDeveloper: "검토 차례" };
    case "merged":
      return { forRequester: "반영했어요", forDeveloper: "병합됨" };
    case "deployed":
      return { forRequester: "배포까지 끝났어요", forDeveloper: "배포됨" };
    case "closed":
      return { forRequester: "끝났어요", forDeveloper: "닫힘" };
    case "declined":
      return { forRequester: req.decline?.forRequester ?? "이번엔 진행하지 않기로 했어요", forDeveloper: `거절 · ${req.decline?.reason ?? ""}`.trim() };
    case "cancelled":
      return { forRequester: "요청을 취소했어요", forDeveloper: "취소됨" };
  }
}
