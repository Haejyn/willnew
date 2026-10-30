import { describe, expect, it } from "vitest";
import { canReopen, canTransition, cardBodies, isOpenRequest, moveTo, reopen, REQUEST_STATUSES, STATUS_KO, transition } from "../src/server/request-state.js";
import type { Request, RequestStatus } from "../src/server/types.js";

/** ticket-plan.md 10절, written out by hand. declined and cancelled are checked separately. */
const EDGES: Record<RequestStatus, RequestStatus[]> = {
  draft: ["clarifying", "spec_ready"],
  clarifying: ["waiting_customer", "spec_ready"],
  waiting_customer: ["clarifying"],
  spec_ready: ["clarifying", "open", "proposed"],
  open: ["assigned"],
  assigned: ["in_progress", "proposed"],
  in_progress: ["waiting_requester", "preview", "code_review"],
  waiting_requester: ["in_progress"],
  proposed: ["approved"],
  approved: ["building", "closed"],
  building: ["verifying", "preview", "code_review"],
  verifying: ["building", "preview", "code_review"],
  preview: ["building", "in_progress", "code_review"],
  code_review: ["building", "merged"],
  merged: ["deployed", "closed"],
  deployed: ["closed"],
  closed: [],
  declined: [],
  cancelled: [],
};
const ENDED: RequestStatus[] = ["merged", "deployed", "closed", "declined", "cancelled"];

function req(status: RequestStatus, over: Partial<Request> = {}): Request {
  return {
    id: "q1", channel: "backend", repo: "/nowhere", check: "", team: "platform", requester: "한지우", text: "쿠폰이 안 돼요", attachments: [],
    status, title: "쿠폰", questions: [], decisions: [], runIds: [], createdAt: 1, updatedAt: 1, ...over,
  };
}

describe("request state table", () => {
  it("lists every status once", () => {
    expect(new Set(REQUEST_STATUSES).size).toBe(REQUEST_STATUSES.length);
    expect([...REQUEST_STATUSES].sort()).toEqual(Object.keys(EDGES).sort());
  });

  it("allows exactly the moves in the plan, for every pair", () => {
    const wrong: string[] = [];
    for (const from of REQUEST_STATUSES)
      for (const to of REQUEST_STATUSES) {
        const stop = to === "declined" || to === "cancelled";
        const want = stop ? !ENDED.includes(from) : EDGES[from].includes(to);
        if (canTransition(from, to) !== want) wrong.push(`${from} → ${to}: ${!want ? "열림" : "막힘"}`);
      }
    expect(wrong).toEqual([]);
  });

  it("open means not ended", () => {
    for (const s of REQUEST_STATUSES) expect(isOpenRequest(s)).toBe(!ENDED.includes(s));
  });

  it("records where a stopped request was", () => {
    const r = transition(req("waiting_requester"), "cancelled", 5);
    expect(r).toMatchObject({ status: "cancelled", stoppedFrom: "waiting_requester", updatedAt: 5 });
    expect(() => transition(req("open"), "in_progress")).toThrow();
  });

  it("has a Korean label and card text for every status", () => {
    for (const s of REQUEST_STATUSES) {
      expect(STATUS_KO[s]).toBeTruthy();
      const b = cardBodies(req(s, { assignee: "이해준" }));
      expect(b.forRequester).toBeTruthy();
      expect(b.forDeveloper).toBeTruthy();
    }
    expect(STATUS_KO).toMatchObject({ waiting_customer: "고객 답 기다림", open: "보냄", assigned: "담당자 정해짐", in_progress: "작업 중", waiting_requester: "CS 답 기다림" });
  });
});

describe("moveTo", () => {
  const path = (from: RequestStatus, to: RequestStatus) => {
    const r = req(from);
    const moved = moveTo(r, to);
    return { moved, at: r.status };
  };

  it("keeps the AI flow: spec_ready → building goes through proposed and approved", () => {
    const r = req("spec_ready");
    expect(moveTo(r, "building")).toBe(true);
    expect(r.status).toBe("building");
  });

  it("walks forward in one go and never backward", () => {
    expect(path("code_review", "deployed")).toEqual({ moved: true, at: "deployed" });
    expect(path("in_progress", "merged")).toEqual({ moved: true, at: "merged" });
    expect(path("assigned", "building")).toEqual({ moved: true, at: "building" });
    expect(path("approved", "preview")).toEqual({ moved: true, at: "preview" });
    expect(path("preview", "verifying")).toEqual({ moved: false, at: "preview" });
    expect(path("merged", "building")).toEqual({ moved: false, at: "merged" });
    expect(path("closed", "open")).toEqual({ moved: false, at: "closed" });
  });
});

describe("reopen", () => {
  it("only ended requests, and it is a decision entry", () => {
    for (const s of REQUEST_STATUSES) expect(canReopen(s)).toBe(ENDED.includes(s));
    expect(() => reopen(req("in_progress"), "한지우")).toThrow();
    const r = req("closed");
    const e = reopen(r, "한지우", "또 안 돼요", 9);
    expect(r).toMatchObject({ status: "open", updatedAt: 9 });
    expect(e).toEqual({ who: "한지우", when: 9, what: "reopen", why: "closed → open: 또 안 돼요" });
  });

  it("a request stopped before it was sent goes back to where it stopped", () => {
    const r = transition(req("waiting_customer"), "cancelled");
    reopen(r, "한지우");
    expect(r.status).toBe("waiting_customer");
    expect(r.stoppedFrom).toBeUndefined();
    const d = transition(req("proposed"), "declined");
    reopen(d, "이해준");
    expect(d.status).toBe("open");
  });
});
