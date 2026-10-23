/**
 * Slack ⇄ Request. One Slack thread is one Request: `@willnew …` creates it, the card is the first bot message in the
 * thread and is edited as the request moves, and every question, proposal, check, review and ship line lands in the
 * same thread. Only RequestManager's public methods and bus events (and RunManager's review and bus) are used; the web
 * chat keeps working on the same requests.
 *
 * Inbound handlers take plain objects so they do not depend on Bolt. Buttons are acknowledged by the caller first
 * (index.ts) and handled here afterwards.
 */
import { deployedReply, mergedReply, pickReviewer, rejectedReply, reviewMessage } from "../handoff.js";
import type { RequestManager } from "../requests.js";
import { selfApproval } from "../team-auth.js";
import { suggestWinner, type RunManager } from "../runs.js";
import type { ShipEvent } from "../ship.js";
import type { ClarifyQuestion, HeldWork, Request, RequesterCheck, Run } from "../types.js";
import { both, cardMessage, checkMessage, detailsMessage, fromSlack, mentionify, modalView, proposalMessage, questionMessage, replyFrom, reviewBlocks, shipMessage, type At, type ModalKind, type ModalMeta } from "./blocks.js";
import type { SlackClient, SlackFile, SlackMessage } from "./client.js";
import type { ThreadRecord, ThreadStore } from "./store.js";

export interface SlackUser {
  name: string;
  role: "developer" | "requester";
  title?: string;
  avatar?: string;
}

export type SlackRequests = Pick<RequestManager, "bus" | "create" | "get" | "answer" | "decide" | "requesterCheck" | "shotFile">;
export type SlackRuns = Pick<RunManager, "bus" | "get" | "review"> & Partial<Pick<RunManager, "preflight">>;

/** What a willnew channel needs for a new request. */
export interface SlackChannelInfo {
  id: string;
  repo: string;
  team: string;
  reviewers: string[];
}

export interface BridgeOptions {
  requests: SlackRequests;
  /** for 승인 and 반려 and the ship lines; without it the thread says to review on the web */
  runs?: SlackRuns;
  resolveSlackUser: (slackUserId: string) => SlackUser | null;
  /** 이름 → Slack id, for real mentions. Without it names stay as plain @이름 */
  slackIdOf?: (name: string) => string | null | undefined;
  /** Slack channel id → willnew channel name */
  channelMap: Record<string, string>;
  /** willnew channels (repo, team, reviewers). A mapped name that is not here uses `repo` and the name as the team */
  channels?: SlackChannelInfo[];
  repo?: string;
  check?: string;
  /** where people open the web app (deep links, 상자 그리기) */
  webBaseUrl?: string;
  /** 승인 refuses your own request or a result you are assigned to (same rule as the web, --no-self-approve) */
  noSelfApprove?: boolean;
  client: SlackClient;
  store: ThreadStore;
  log?: (msg: string) => void;
}

export interface SlackEvent {
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

export interface ActionInput {
  actionId: string;
  value?: string;
  user: string;
  triggerId?: string;
}

export interface ViewInput {
  privateMetadata: string;
  text: string;
  user: string;
}

const UNKNOWN = "willnew 에 등록되지 않은 Slack 계정이에요. 허브를 띄운 사람에게 Slack ID 를 알려 주세요";
const NOT_LINKED = "이 채널은 willnew 에 연결돼 있지 않아요. 허브를 띄울 때 --slack-channel 로 연결해 주세요";
const DEV_ONLY = { decide: "제안 확인은 개발자만 할 수 있어요", skip: "요청자 확인 건너뛰기는 개발자만 할 수 있어요", review: "결과 승인과 반려는 개발자만 할 수 있어요" };
const requesterOnly = (req: Request, what: string) => `요청한 ${req.requester}님만 ${what} 수 있어요`;

export class SlackBridge {
  private chain = new Map<string, Promise<void>>();
  private cardQueued = new Set<string>();
  /** 직접 쓸게요: the next thread reply from the requester answers this question */
  private armed = new Map<string, string>();
  private seen: string[] = [];
  private off: (() => void)[] = [];

  constructor(private o: BridgeOptions) {
    const rq = o.requests.bus;
    this.on(rq, "changed", (req: Request) => this.onChanged(req));
    this.on(rq, "answered", (req: Request, q: ClarifyQuestion) => this.onAnswered(req, q));
    this.on(rq, "proposed", (req: Request) => this.onProposed(req));
    this.on(rq, "run_started", (req: Request) => this.proposalOutcome(req, this.decisionLine(req)));
    this.on(rq, "taken_over", (req: Request, by: string) => this.onTakenOver(req, by));
    this.on(rq, "declined", (req: Request, by: string) => this.onDeclined(req, by));
    this.on(rq, "preview", (req: Request, c: RequesterCheck) => this.onPreview(req, c));
    this.on(rq, "captured", (req: Request, c: RequesterCheck) => this.onCaptured(req, c));
    this.on(rq, "preview_ok", (req: Request, c: RequesterCheck, by: string) => this.checkOutcome(req, c, `${by}님이 의도대로라고 했어요`));
    this.on(rq, "preview_changes", (req: Request, c: RequesterCheck, by: string) => this.onPreviewChanges(req, c, by));
    this.on(rq, "preview_skip", (req: Request, c: RequesterCheck, by: string) => this.checkOutcome(req, c, `${by}님이 요청자 확인을 건너뛰었어요. 이유: ${c.reason ?? ""}`));
    this.on(rq, "claimed", (req: Request, by: string) => this.onClaimed(req, by));
    if (o.runs) {
      this.on(o.runs.bus, "held", (run: Run, item: HeldWork, owner: string) => this.onHeld(run, item, owner));
      this.on(o.runs.bus, "released", (run: Run, by: string) => this.onReleased(run, by));
      this.on(o.runs.bus, "reviewed", (run: Run) => this.onReviewed(run));
      this.on(o.runs.bus, "ship", (run: Run, e: ShipEvent) => this.onShip(run, e));
    }
  }

  /** Stop listening (the Slack app is stopping). */
  close() {
    for (const f of this.off) f();
    this.off = [];
  }

  /** Resolves once every queued Slack call has finished (tests). */
  async idle() {
    for (;;) {
      const snap = new Map(this.chain);
      await Promise.all(snap.values());
      if ([...this.chain].every(([k, p]) => snap.get(k) === p)) return;
    }
  }

  private on(bus: import("node:events").EventEmitter, ev: string, fn: (...a: any[]) => void) {
    bus.on(ev, fn);
    this.off.push(() => bus.off(ev, fn));
  }

  private log(msg: string) {
    (this.o.log ?? ((m: string) => console.error(m)))(`slack: ${msg}`);
  }

  /** Calls for one request run one after another, so the card exists before anything edits it. */
  private enqueue(requestId: string, fn: () => Promise<void>) {
    const next = (this.chain.get(requestId) ?? Promise.resolve()).then(fn).catch((e: Error) => this.log(e.message));
    this.chain.set(requestId, next);
    return next;
  }

  private at: At = (name) => {
    const id = this.o.slackIdOf?.(name);
    return id ? `<@${id}>` : `@${name}`;
  };

  private nameOf = (id: string) => this.o.resolveSlackUser(id)?.name;

  private tell(channel: string, user: string, thread_ts: string | undefined, text: string) {
    return this.o.client.ephemeral({ channel, user, thread_ts, text }).catch((e: Error) => this.log(e.message));
  }

  /** Slack retries events it thinks were missed; the same message must not become two requests or two answers. */
  private once(key: string): boolean {
    if (this.seen.includes(key)) return false;
    this.seen.push(key);
    if (this.seen.length > 500) this.seen.shift();
    return true;
  }

  private post(rec: ThreadRecord, m: SlackMessage) {
    return this.o.client.post({ channel: rec.channel, thread_ts: rec.threadTs, ...m });
  }

  private update(rec: ThreadRecord, ts: string, m: SlackMessage) {
    return this.o.client.update({ channel: rec.channel, ts, ...m });
  }

  // ------------------------------------------------------------------------------------------ inbound

  /** `@willnew …`: a new request, or a reply in a request's thread. */
  async mention(ev: SlackEvent, botUserId?: string) {
    if (!ev.user || !this.once(`${ev.channel}:${ev.ts}`)) return;
    const threadTs = ev.thread_ts ?? ev.ts;
    const existing = this.o.store.byThread(ev.channel, threadTs);
    if (existing) return this.threadReply(existing, ev, botUserId);
    const name = this.o.channelMap[ev.channel];
    if (!name) return void (await this.tell(ev.channel, ev.user, ev.thread_ts, NOT_LINKED));
    const who = this.o.resolveSlackUser(ev.user);
    if (!who) return void (await this.tell(ev.channel, ev.user, ev.thread_ts, UNKNOWN));
    const ch = this.o.channels?.find((c) => c.id === name);
    const repo = ch?.repo ?? this.o.repo;
    if (!repo) return void (await this.tell(ev.channel, ev.user, ev.thread_ts, "이 채널에 연결된 저장소가 없어요"));
    const text = fromSlack(ev.text ?? "", botUserId, this.nameOf);
    let req: Request;
    try {
      req = this.o.requests.create({
        channel: name, repo, check: this.o.check ?? "", team: ch?.team ?? name, requester: who.name, requesterTitle: who.title, requesterAvatar: who.avatar,
        text, reviewer: pickReviewer({ reviewers: ch?.reviewers ?? this.o.channels?.[0]?.reviewers ?? [] }, who.name),
      });
    } catch (e) {
      return void (await this.tell(ev.channel, ev.user, threadTs, (e as Error).message));
    }
    const rec = this.o.store.bind(req.id, ev.channel, threadTs);
    rec.status = req.status;
    this.o.store.save();
    this.renderCard(req.id);
  }

  /** A plain message. Only thread replies in a request's thread matter (직접 쓰기 answers). */
  async message(ev: SlackEvent, botUserId?: string) {
    if (!ev.thread_ts || ev.thread_ts === ev.ts || ev.subtype || ev.bot_id || !ev.user) return;
    if (botUserId && ev.text?.includes(`<@${botUserId}>`)) return;   // app_mention handles it
    const rec = this.o.store.byThread(ev.channel, ev.thread_ts);
    if (!rec || !this.once(`${ev.channel}:${ev.ts}`)) return;
    await this.threadReply(rec, ev, botUserId);
  }

  /** While clarifying, the requester's reply answers the question they chose 직접 쓸게요 on, else the first open one. */
  private async threadReply(rec: ThreadRecord, ev: SlackEvent, botUserId?: string) {
    const req = this.o.requests.get(rec.requestId);
    if (!req || req.status !== "clarifying" || !ev.user) return;
    const who = this.o.resolveSlackUser(ev.user);
    if (!who || who.name !== req.requester) return;
    const armed = this.armed.get(req.id);
    const q = req.questions.find((x) => x.id === armed && !x.answer) ?? req.questions.find((x) => !x.answer);
    const text = fromSlack(ev.text ?? "", botUserId, this.nameOf).replace(/@willnew\b/gi, "").trim();
    if (!q || !text) return;
    this.armed.delete(req.id);
    await this.o.requests.answer(req.id, { questionId: q.id, answer: text, by: who.name }).catch((e: Error) => this.tell(rec.channel, ev.user!, rec.threadTs, e.message));
  }

  /** A button. The caller has already acknowledged it. */
  async action(a: ActionInput) {
    if (a.actionId.startsWith("wn_link")) return;
    let v: { r?: string; q?: string; i?: number; d?: string; v?: string; n?: number; run?: string; a?: string };
    try {
      v = JSON.parse(a.value ?? "{}");
    } catch {
      return;
    }
    const req = v.r ? this.o.requests.get(v.r) : undefined;
    const rec = v.r ? this.o.store.get(v.r) : undefined;
    if (!req || !rec) return;
    const deny = (text: string) => this.tell(rec.channel, a.user, rec.threadTs, text);
    const who = this.o.resolveSlackUser(a.user);
    if (!who) return void (await deny(UNKNOWN));
    const dev = who.role === "developer";
    const modal = (k: ModalKind, extra: Partial<ModalMeta> = {}) =>
      a.triggerId ? this.o.client.openModal(a.triggerId, modalView({ k, r: req.id, ch: rec.channel, th: rec.threadTs, ...extra }, this.o.webBaseUrl, req)) : Promise.resolve();
    const tryIt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        await deny((e as Error).message);
      }
    };
    const id = a.actionId;

    if (id === "wn_details") {
      const run = req.runIds.length ? this.o.runs?.get(req.runIds.at(-1)!) : undefined;
      return void (await this.o.client.ephemeral({ channel: rec.channel, user: a.user, thread_ts: rec.threadTs, ...detailsMessage(req, run) }).catch((e: Error) => this.log(e.message)));
    }
    if (id.startsWith("wn_answer_") || id === "wn_write") {
      if (who.name !== req.requester) return void (await deny(requesterOnly(req, "답할")));
      const q = req.questions.find((x) => x.id === v.q);
      if (!q) return;
      if (id === "wn_write") {
        this.armed.set(req.id, q.id);
        return void (await deny("이 스레드에 답을 적어 주세요. 다음 답글을 이 질문의 답으로 받을게요"));
      }
      const choice = q.choices[Number(v.i)];
      if (choice == null) return;
      return tryIt(() => this.o.requests.answer(req.id, { questionId: q.id, answer: choice, by: who.name }));
    }
    if (id.startsWith("wn_decide_")) {
      if (!dev) return void (await deny(DEV_ONLY.decide));
      if (v.d === "proceed_with_changes") return tryIt(() => modal("changes"));
      if (v.d === "decline") return tryIt(() => modal("decline"));
      if (v.d === "proceed" || v.d === "take_over") return tryIt(() => this.o.requests.decide(req.id, { decision: v.d as "proceed" | "take_over", by: who.name }));
      return;
    }
    if (id.startsWith("wn_check_")) {
      if (v.v === "skip") return dev ? tryIt(() => modal("skip")) : void (await deny(DEV_ONLY.skip));
      if (who.name !== req.requester) return void (await deny(requesterOnly(req, "확인할")));
      if (v.v === "ok") return tryIt(async () => this.o.requests.requesterCheck(req.id, { verdict: "ok", by: who.name }));
      if (v.v === "changes") return tryIt(() => modal("recheck"));
      return;
    }
    if (id.startsWith("wn_review_")) {
      if (!dev) return void (await deny(DEV_ONLY.review));
      const runs = this.o.runs;
      if (!runs || !v.run) return void (await deny("이 허브에서는 Slack 에서 승인할 수 없어요. willnew 웹에서 승인해 주세요"));
      if (v.d === "reject") return tryIt(() => modal("reject", { run: v.run, a: v.a }));
      if (v.d === "approve")
        return tryIt(async () => {
          if (this.o.requests.get(req.id)?.status === "preview") throw new Error("요청자 확인이 먼저예요. 건너뛰려면 개발자용 건너뛰기를 눌러 이유를 적어 주세요");
          const self = this.o.noSelfApprove ? selfApproval(who.name, runs.get(v.run!), this.o.requests.get(req.id)) : null;
          if (self) throw new Error(self);
          await runs.review(v.run!, { decision: "approve", agentId: v.a, reviewer: who.name });
        });
    }
  }

  /** Synchronous check before the modal closes: an empty line keeps it open with a message under the field. */
  validate(input: ViewInput): Record<string, string> | null {
    return input.text.trim() ? null : { text: "한 줄 적어 주세요" };
  }

  /** A submitted modal. The caller has already acknowledged it. */
  async submit(input: ViewInput) {
    let meta: ModalMeta;
    try {
      meta = JSON.parse(input.privateMetadata);
    } catch {
      return;
    }
    const req = this.o.requests.get(meta.r);
    if (!req) return;
    const deny = (text: string) => this.tell(meta.ch, input.user, meta.th, text);
    const who = this.o.resolveSlackUser(input.user);
    if (!who) return void (await deny(UNKNOWN));
    const dev = who.role === "developer";
    const text = input.text.trim();
    try {
      switch (meta.k) {
        case "changes":
        case "decline":
          if (!dev) return void (await deny(DEV_ONLY.decide));
          await this.o.requests.decide(req.id, { decision: meta.k === "changes" ? "proceed_with_changes" : "decline", by: who.name, text });
          return;
        case "recheck":
          if (who.name !== req.requester) return void (await deny(requesterOnly(req, "확인할")));
          this.o.requests.requesterCheck(req.id, { verdict: "changes", by: who.name, note: text });
          return;
        case "skip":
          if (!dev) return void (await deny(DEV_ONLY.skip));
          this.o.requests.requesterCheck(req.id, { verdict: "skip", by: who.name, reason: text });
          return;
        case "reject":
          if (!dev) return void (await deny(DEV_ONLY.review));
          if (!this.o.runs || !meta.run) return;
          await this.o.runs.review(meta.run, { decision: "reject", agentId: meta.a, reviewer: who.name, comment: text });
          return;
      }
    } catch (e) {
      await deny((e as Error).message);
    }
  }

  // ------------------------------------------------------------------------------------------ outbound

  /** Edits are coalesced: one queued render reads the latest state when it runs. */
  private renderCard(requestId: string) {
    if (this.cardQueued.has(requestId)) return;
    this.cardQueued.add(requestId);
    void this.enqueue(requestId, async () => {
      this.cardQueued.delete(requestId);
      const req = this.o.requests.get(requestId);
      const rec = this.o.store.get(requestId);
      if (!req || !rec) return;
      const m = cardMessage(req, this.o.webBaseUrl);
      if (rec.cardTs) await this.update(rec, rec.cardTs, m);
      else {
        rec.cardTs = (await this.post(rec, m)).ts;
        this.o.store.save();
      }
    });
  }

  private onChanged(req: Request) {
    const rec = this.o.store.get(req.id);
    if (!rec) return;
    this.renderCard(req.id);
    if (rec.status === req.status) return;
    rec.status = req.status;
    this.o.store.save();
    if (req.status === "clarifying") this.postQuestions(req.id);
    if (req.status === "code_review") this.postReview(req.id);
  }

  private postQuestions(requestId: string) {
    void this.enqueue(requestId, async () => {
      const req = this.o.requests.get(requestId);
      const rec = this.o.store.get(requestId);
      if (!req || !rec) return;
      for (let i = 0; i < req.questions.length; i++) {
        const q = req.questions[i];
        if (rec.questions[q.id]) continue;
        rec.questions[q.id] = (await this.post(rec, questionMessage(req, i, this.at))).ts;
        this.o.store.save();
      }
    });
  }

  private onAnswered(req: Request, q: ClarifyQuestion) {
    const rec = this.o.store.get(req.id);
    if (!rec) return;
    void this.enqueue(req.id, async () => {
      const ts = rec.questions[q.id];
      const i = req.questions.findIndex((x) => x.id === q.id);
      if (ts && i >= 0) await this.update(rec, ts, questionMessage(req, i, this.at));
    });
  }

  private onProposed(req: Request) {
    const rec = this.o.store.get(req.id);
    if (!rec) return;
    void this.enqueue(req.id, async () => {
      const m = proposalMessage(req, this.at);
      if (rec.proposalTs) await this.update(rec, rec.proposalTs, m);
      else rec.proposalTs = (await this.post(rec, m)).ts;
      this.o.store.save();
    });
  }

  /** "이해준님이 진행했어요" or "…고쳐서 진행했어요: …" from the last decision. */
  private decisionLine(req: Request): string {
    const d = [...req.decisions].reverse().find((x) => x.what === "proceed" || x.what === "proceed_with_changes");
    if (!d) return "작업을 시작했어요";
    return d.what === "proceed" ? `${d.who}님이 진행했어요` : `${d.who}님이 고쳐서 진행했어요: ${d.why ?? ""}`;
  }

  private proposalOutcome(req: Request, line: string) {
    const rec = this.o.store.get(req.id);
    if (!rec?.proposalTs) return;
    void this.enqueue(req.id, async () => this.update(rec, rec.proposalTs!, proposalMessage(req, this.at, line)));
  }

  /** Team mode: someone pressed 내가 맡을게요 on the web. */
  private onClaimed(req: Request, by: string) {
    const rec = this.o.store.get(req.id);
    if (!rec) return;
    void this.enqueue(req.id, async () => void (await this.post(rec, both(`${by}님이 맡았어요`, `${by} 담당, ${by}의 러너에서 정리하고 작업해요`, this.at))));
  }

  /** Team mode, subscription runner: a follow-up from someone else waits for the runner owner. */
  private onHeld(run: Run, item: HeldWork, owner: string) {
    const rec = run.requestId ? this.o.store.get(run.requestId) : undefined;
    if (!rec) return;
    const what = item.kind === "changes" ? "다시 봐 주세요" : item.kind === "comments" ? "줄 댓글" : "이어서 지시";
    void this.enqueue(rec.requestId, async () => void (await this.post(rec, both(`${owner}님 확인 뒤에 이어서 작업해요`, `@${owner} ${item.by}님 ${what} 대기 중이에요. 웹에서 이어서 실행을 눌러 주세요`, this.at))));
  }

  private onReleased(run: Run, by: string) {
    const rec = run.requestId ? this.o.store.get(run.requestId) : undefined;
    if (!rec) return;
    void this.enqueue(rec.requestId, async () => void (await this.post(rec, both("이어서 작업해요", `${by}님이 이어서 실행했어요`, this.at))));
  }

  private onTakenOver(req: Request, by: string) {
    const rec = this.o.store.get(req.id);
    if (!rec) return;
    this.proposalOutcome(req, `${by}님이 직접 맡았어요`);
    void this.enqueue(req.id, async () => void (await this.post(rec, both(`${by}님이 직접 맡았어요`, `${by} 직접 작업, AI 흐름에서 빠짐`, this.at))));
  }

  /** The planner's explanation for the requester, with the alternatives; the developer's own reason folded under it. */
  private onDeclined(req: Request, by: string) {
    const rec = this.o.store.get(req.id);
    const d = req.decline;
    if (!rec || !d) return;
    this.proposalOutcome(req, `${by}님이 거절했어요`);
    const alts = d.alternatives.map((a) => `- ${a.title} (${a.effort})`).join("\n");
    void this.enqueue(req.id, async () => void (await this.post(rec,
      both(`@${req.requester} ${d.forRequester}${alts ? `\n이렇게는 할 수 있어요\n${alts}` : ""}`, `${by}님이 거절했어요. 사유: ${d.reason}`, this.at))));
  }

  private onPreview(req: Request, c: RequesterCheck) {
    const rec = this.o.store.get(req.id);
    if (!rec) return;
    void this.enqueue(req.id, async () => {
      if (rec.checks[c.round]) return;
      rec.checks[c.round] = (await this.post(rec, checkMessage(req, c, this.at))).ts;
      this.o.store.save();
    });
  }

  /** The preview links and notes go on the check message; the before/after pairs are uploaded into the thread. */
  private onCaptured(req: Request, c: RequesterCheck) {
    const rec = this.o.store.get(req.id);
    if (!rec) return;
    void this.enqueue(req.id, async () => {
      const ts = rec.checks[c.round];
      if (ts && c.status === "waiting") await this.update(rec, ts, checkMessage(req, c, this.at));
      if (rec.shots.includes(c.round)) return;
      const files: SlackFile[] = [];
      for (const s of c.shots)
        for (const side of ["before", "after"] as const) {
          const url = s[side];
          if (!url) continue;
          const name = decodeURIComponent(url.split("/").pop() ?? "");
          const path = this.o.requests.shotFile(req.id, String(c.round), name);
          if (path) files.push({ path, filename: name, title: `${s.screen} ${s.viewport === "mobile" ? "모바일" : "데스크톱"} ${side === "before" ? "전" : "후"}` });
        }
      rec.shots.push(c.round);
      this.o.store.save();
      // files.uploadV2 takes a handful per call; pairs stay together (전, 후 for each screen)
      for (let i = 0; i < files.length; i += 10)
        await this.o.client.upload({ channel: rec.channel, thread_ts: rec.threadTs, files: files.slice(i, i + 10), comment: i === 0 ? `${c.round}차 전후 화면이에요. 화면마다 전, 후 순서예요` : undefined });
    });
  }

  private checkOutcome(req: Request, c: RequesterCheck, line: string) {
    const rec = this.o.store.get(req.id);
    const ts = rec?.checks[c.round];
    if (!rec || !ts) return;
    void this.enqueue(req.id, async () => this.update(rec, ts, checkMessage(req, c, this.at, line)));
  }

  private onPreviewChanges(req: Request, c: RequesterCheck, by: string) {
    this.checkOutcome(req, c, `${by}님이 다시 봐 달라고 했어요`);
    const rec = this.o.store.get(req.id);
    if (!rec) return;
    const what = [...req.decisions].reverse().find((d) => d.what === "preview_changes")?.why;
    const dev = req.reviewer ? `@${req.reviewer} ` : "";
    void this.enqueue(req.id, async () => void (await this.post(rec, both(
      "적어 주신 걸 넘겼어요. 고쳐서 다시 보여 드릴게요",
      `${dev}${by}님이 다시 봐 달래요${what ? `: ${what}` : ""}. 같은 브랜치에서 ${c.round + 1}번째 시도를 시작했어요`, this.at))));
  }

  /** `@이해준 검토 차례예요. …` with 승인 and 반려, once the result is ready for the code review. */
  private postReview(requestId: string) {
    void this.enqueue(requestId, async () => {
      const req = this.o.requests.get(requestId);
      const rec = this.o.store.get(requestId);
      const runs = this.o.runs;
      const run = req?.runIds.length ? runs?.get(req.runIds.at(-1)!) : undefined;
      if (!req || !rec || !run) {
        if (req && rec && !runs) await this.post(rec, both("개발자가 결과를 보고 있어요", "검토 차례예요. 승인은 willnew 웹에서 해요", this.at));
        return;
      }
      if (run.review.status === "approved") return;
      const agent = run.agents.find((a) => a.id === run.review.agentId) ?? suggestWinner(run);
      const conflicts = agent && runs?.preflight ? await runs.preflight(run.id, agent.id).then((p) => p.conflicts).catch(() => null) : null;
      let line = reviewMessage(req.reviewer ?? "", agent, run.baseBranch, conflicts);
      if (!req.reviewer) line = line.replace(/^@ /, "");
      rec.reviewTs = (await this.post(rec, reviewBlocks(req, run, agent, line, this.at, this.o.webBaseUrl))).ts;
      this.o.store.save();
    });
  }

  private onReviewed(run: Run) {
    const rec = run.requestId ? this.o.store.get(run.requestId) : undefined;
    const req = run.requestId ? this.o.requests.get(run.requestId) : undefined;
    const r = run.review;
    if (!rec || !req || (r.status !== "approved" && r.status !== "rejected")) return;
    const who = r.reviewer ?? "개발자";
    const agent = run.agents.find((a) => a.id === r.agentId);
    const pr = run.ship?.mode === "pr";
    void this.enqueue(req.id, async () => {
      const outcome = r.status === "approved" ? `${who}님이 승인했어요` : `${who}님이 반려했어요. 사유: ${r.comment ?? ""}`;
      if (rec.reviewTs) await this.update(rec, rec.reviewTs, reviewBlocks(req, run, agent, reviewMessage(req.reviewer ?? who, agent, run.baseBranch, null), this.at, this.o.webBaseUrl, outcome));
      if (r.status === "rejected") await this.post(rec, replyFrom(who, rejectedReply(run, r.comment), this.at));
      else if (pr) await this.shipLine(rec, `${who}님이 승인해서 PR을 올려요`);
      else await this.post(rec, replyFrom(who, mergedReply(run, agent?.userNote), this.at));
    });
  }

  private async shipLine(rec: ThreadRecord, line: string) {
    rec.shipLines = [...(rec.shipLines ?? []), line];
    const m = shipMessage(rec.shipLines.map((l) => mentionify(l, this.at)));
    if (rec.shipTs) await this.update(rec, rec.shipTs, m);
    else rec.shipTs = (await this.post(rec, m)).ts;
    this.o.store.save();
  }

  /** 반영 단계 줄 in one message, then the approver's answer to the requester at the last stage. */
  private onShip(run: Run, e: ShipEvent) {
    const rec = run.requestId ? this.o.store.get(run.requestId) : undefined;
    const s = run.ship;
    if (!rec || !s) return;
    const who = run.review.reviewer ?? "개발자";
    const note = run.agents.find((a) => a.id === run.review.agentId)?.userNote;
    const env = s.env ?? "production";
    const failed = (s.checks ?? []).filter((c) => c.state === "fail").map((c) => c.name);
    const line =
      e === "pr" ? `PR #${s.prNumber}${s.prUrl ? ` ${s.prUrl}` : ""} 올렸어요`
      : e === "ci_passed" ? `CI ${s.checks?.length ?? 0}개 통과`
      : e === "ci_failed" ? (/^(git|gh) /.test(failed[0] ?? "") ? `PR을 올리지 못했어요: ${failed[0]}` : `CI 실패: ${failed.join(", ") || "시간 초과"}. 자동으로 다시 돌리지 않았어요`)
      : e === "merged" ? `${run.baseBranch}에 병합했어요`
      : e === "deployed" ? `${env} 배포 끝났어요`
      : `${env} 배포가 확인되지 않았어요. 정해 둔 시간 안에 끝나지 않았어요`;
    void this.enqueue(rec.requestId, async () => {
      await this.shipLine(rec, line);
      if (e === "merged" && !s.env) await this.post(rec, replyFrom(who, mergedReply(run, note), this.at));
      if (e === "deployed") await this.post(rec, replyFrom(who, deployedReply(run, note), this.at));
    });
  }
}
