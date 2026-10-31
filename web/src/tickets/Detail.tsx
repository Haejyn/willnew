/**
 * 티켓 상세 (모두). 같은 티켓을 역할마다 다르게.
 * CS: 쉬운 말 요약(forRequester), 증상과 결과, 진행 단계, 개발자 질문에 답하기.
 * 개발자: 기술 칸과 수용 기준, 출처와 확신도, 인젝션 경고와 고객 주장, CS 와 주고받은 질문, 작업 버튼.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Api } from "../api";
import { IconArrowLeft, IconBranch, IconCheck, IconExternal, IconPlay, IconSend, IconTerminal } from "../icons";
import { AiText, Avatar, Spinner } from "../ui";
import { clockTime, relTime, useNow, type User } from "../util";
import { workCommand, type Ask, type Request, type Ticket } from "./api";
import { CopyBtn, FieldList, Original, Priority, StatusDot, TicketSteps, useAct, useTicketApi } from "./parts";

const PRIORITIES: NonNullable<Request["priority"]>[] = ["P0", "P1", "P2", "P3"];

function useAsks(key: string, ticket: Ticket) {
  const tapi = useTicketApi();
  const [asks, setAsks] = useState<Ask[] | null>(null);
  const reload = useCallback(() => {
    tapi.asks(key).then(setAsks).catch(() => setAsks([]));
  }, [tapi, key]);
  // 티켓이 바뀌면(질문, 답) 다시 읽는다
  useEffect(reload, [reload, ticket.updatedAt]);
  return { asks, reload };
}

/** 개발자 질문과 CS 답. CS 에게는 쉬운 말(forRequester)을 먼저, 원문은 펼쳐서 */
function AskThread({ t, asks, user, onTicket, reload }: { t: Ticket; asks: Ask[] | null; user: User; onTicket: (t: Ticket) => void; reload: () => void }) {
  const tapi = useTicketApi();
  const { busy, run } = useAct();
  const [q, setQ] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const key = t.key ?? t.id;
  const dev = user.role === "dev";
  const canAsk = dev && (t.status === "in_progress" || t.status === "assigned" || t.status === "waiting_requester");
  const canAnswer = user.name === t.requester;
  if (!asks?.length && !canAsk) return null;
  return (
    <section className="rq-sec" aria-label="개발자 질문">
      <h2 className="sec-t">{dev ? "CS 와 주고받은 질문" : "개발자가 물어본 것"}</h2>
      {asks === null ? <div className="skel tk-skel-line" /> : null}
      <ol className="tk-thread">
        {(asks ?? []).map((a) => (
          <li key={a.askId}>
            <div className="tk-thread-q">
              <span className="lab">{t.assignee ?? "개발자"}</span>
              {dev ? <p>{a.question}</p> : <AiText original={a.question} label="개발자가 쓴 그대로 보기">{a.forRequester}</AiText>}
            </div>
            {a.answer ? (
              <div className="tk-thread-a">
                <span className="lab">{t.requester}{a.answeredAt ? `, ${clockTime(a.answeredAt)}` : ""}</span>
                <p>{a.answer}</p>
              </div>
            ) : canAnswer ? (
              <form
                className="rq-other"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const v = answers[a.askId]?.trim();
                  if (!v) return;
                  const n = await run(`ans-${a.askId}`, () => tapi.answerAsk(key, a.askId, v), "답을 보냈어요");
                  if (n) {
                    onTicket(n);
                    setAnswers({ ...answers, [a.askId]: "" });
                    reload();
                  }
                }}
              >
                <input aria-label="답" value={answers[a.askId] ?? ""} onChange={(e) => setAnswers({ ...answers, [a.askId]: e.target.value })} placeholder="모르면 모른다고 적어도 돼요" />
                <button className="btn sm m" type="submit" disabled={!answers[a.askId]?.trim() || !!busy}>
                  {busy === `ans-${a.askId}` ? <Spinner size={12} /> : null}답하기
                </button>
              </form>
            ) : (
              <p className="t-meta">{t.requester}님 답 기다리는 중</p>
            )}
          </li>
        ))}
      </ol>
      {canAsk ? (
        <form
          className="rq-other"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!q.trim()) return;
            const r = await run("ask", () => tapi.ask(key, q.trim()), `${t.requester}님에게 물었어요`);
            if (r) {
              onTicket(r.ticket);
              setQ("");
              reload();
            }
          }}
        >
          <input aria-label="CS 에게 묻기" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t.requester}님에게 묻기. 쉬운 말로 바꿔서 전해요`} />
          <button className="btn sm w" type="submit" disabled={!q.trim() || !!busy}>
            {busy === "ask" ? <Spinner size={12} /> : <IconSend size={14} />}묻기
          </button>
        </form>
      ) : null}
    </section>
  );
}

/** 개발자 버튼: 브랜치 이름 복사, willnew work 복사, 작업 시작, 완료 + PR 링크, 이번엔 안 함 */
function DevActions({ t, user, onTicket }: { t: Ticket; user: User; onTicket: (t: Ticket) => void }) {
  const tapi = useTicketApi();
  const { busy, run } = useAct();
  const [form, setForm] = useState<"done" | "decline" | null>(null);
  const [pr, setPr] = useState("");
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  const [alt, setAlt] = useState("");
  const key = t.key ?? t.id;
  const s = t.status;
  const canStart = s === "open" || s === "assigned";
  const working = s === "in_progress" || s === "waiting_requester";
  const ended = s === "merged" || s === "deployed" || s === "closed" || s === "declined" || s === "cancelled";
  const start = async () => {
    const r = await run("work", () => tapi.work(key, { agent: "none" }), "작업을 시작했어요");
    if (r) onTicket(r.ticket);
  };
  return (
    <section className="tk-dev-acts" aria-label="작업">
      <div className="row-btns">
        {canStart ? (
          <button className="btn m" onClick={start} disabled={!!busy || (!!t.assignee && t.assignee !== user.name)} title={t.assignee && t.assignee !== user.name ? `${t.assignee}님 담당이에요` : undefined}>
            {busy === "work" ? <Spinner size={12} /> : <IconPlay size={16} />}작업 시작
          </button>
        ) : null}
        <CopyBtn text={t.branch ?? ""} label="브랜치 이름" disabled={!t.branch} title={t.branch ? t.branch : "작업을 시작하면 브랜치가 생겨요"} ok="브랜치 이름을 복사했어요" />
        <CopyBtn text={workCommand(key)} label={<span className="mono">{workCommand(key)}</span>} ok="명령을 복사했어요. 터미널에 붙여 넣어 주세요" />
      </div>
      {!ended ? (
        <div className="row-btns">
          {working ? (
            <button className="btn sm" aria-expanded={form === "done"} onClick={() => setForm(form === "done" ? null : "done")}>
              <IconCheck size={14} /> 완료 + PR 링크
            </button>
          ) : null}
          <button className="btn sm q" aria-expanded={form === "decline"} onClick={() => setForm(form === "decline" ? null : "decline")}>
            이번엔 안 함
          </button>
        </div>
      ) : null}
      {form === "done" ? (
        <form
          className="rq-box"
          onSubmit={async (e) => {
            e.preventDefault();
            const n = await run("done", () => tapi.done(key, { prUrl: pr.trim() || undefined, summary: summary.trim() || undefined }), "완료로 바꿨어요");
            if (n) {
              onTicket(n);
              setForm(null);
            }
          }}
        >
          <label className="field">
            <span>PR 링크</span>
            <input value={pr} onChange={(e) => setPr(e.target.value)} placeholder="https://github.com/…/pull/123" inputMode="url" />
          </label>
          <label className="field">
            <span>CS 에게 전할 말 (선택)</span>
            <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="쉬운 말로 바꿔서 전해요" />
          </label>
          <div className="row-btns">
            <button className="btn sm w" type="submit" disabled={!!busy}>
              {busy === "done" ? <Spinner size={12} /> : null}완료로 바꾸기
            </button>
          </div>
        </form>
      ) : null}
      {form === "decline" ? (
        <form
          className="rq-box"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reason.trim()) return;
            const n = await run("decline", () => tapi.decline(key, { reason: reason.trim(), alt: alt.trim() || undefined }), "이번엔 안 하기로 했어요");
            if (n) {
              onTicket(n);
              setForm(null);
            }
          }}
        >
          <label className="field">
            <span>사유</span>
            <textarea rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="CS 에게 쉬운 말로 전해요" />
          </label>
          <label className="field">
            <span>대신 할 수 있는 것 (선택)</span>
            <input value={alt} onChange={(e) => setAlt(e.target.value)} />
          </label>
          <div className="row-btns">
            <button className="btn sm danger" type="submit" disabled={!reason.trim() || !!busy}>
              이번엔 안 함
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

/** 인젝션 의심 문장과 고객 주장. 고객 글은 데이터이고 지시가 아니다 */
function Warnings({ t }: { t: Ticket }) {
  const inj = t.injectionFlags ?? [];
  const claims = t.customerClaims ?? [];
  if (!inj.length && !claims.length) return null;
  return (
    <section className="rq-sec tk-warn" aria-label="경고">
      <h2 className="sec-t">경고</h2>
      {inj.length ? (
        <div className="tk-warn-block">
          <span className="st bad">지시처럼 보이는 문장 {inj.length}</span>
          <ul className="rq-list risk">
            {inj.map((x, i) => (
              <li key={i}>
                <q>{x.excerpt}</q> <span className="t-meta mono">{x.pattern}</span>
              </li>
            ))}
          </ul>
          <p className="t-meta">고객이 쓴 글이에요. 에이전트에게는 비신뢰 구역으로만 넘어가요.</p>
        </div>
      ) : null}
      {claims.length ? (
        <div className="tk-warn-block">
          <span className="st warn">고객 주장 {claims.length}</span>
          <ul className="rq-list">
            {claims.map((c) => (
              <li key={c}>
                <q>{c}</q>
              </li>
            ))}
          </ul>
          <p className="t-meta">고객 원문에만 있는 말이에요. 우선순위와 담당자는 사람이 정해요.</p>
        </div>
      ) : null}
    </section>
  );
}

function Ctx({ t, user, onTicket, devs, now }: { t: Ticket; user: User; onTicket: (t: Ticket) => void; devs: string[]; now: number }) {
  const tapi = useTicketApi();
  const { busy, run } = useAct();
  const dev = user.role === "dev";
  const key = t.key ?? t.id;
  const assign = async (input: { assignee?: string; priority?: Request["priority"] }) => {
    const n = await run("assign", () => tapi.assign(key, input));
    if (n) onTicket(n);
  };
  const row = (dt: string, dd: ReactNode) => (
    <>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </>
  );
  return (
    <aside className="rq-ctx">
      <section>
        <dl className="ctx-dl tk-ctx">
          {row("상태", <StatusDot status={t.status} />)}
          {row(
            "우선순위",
            dev ? (
              <select className="tk-sel mono" aria-label="우선순위" value={t.priority ?? ""} disabled={busy === "assign"} onChange={(e) => e.target.value && void assign({ priority: e.target.value as Request["priority"] })}>
                <option value="">없음</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            ) : (
              <Priority p={t.priority} />
            ),
          )}
          {row(
            "담당자",
            dev ? (
              <select className="tk-sel" aria-label="담당자" value={t.assignee ?? ""} disabled={busy === "assign"} onChange={(e) => e.target.value && void assign({ assignee: e.target.value })}>
                <option value="">없음</option>
                {devs.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            ) : t.assignee ? (
              <>
                <Avatar name={t.assignee} size={20} />
                {t.assignee}
              </>
            ) : (
              <span className="t-meta">아직 없음</span>
            ),
          )}
          {row(
            "요청자",
            <>
              <Avatar name={t.requester} size={20} src={t.requesterAvatar} />
              {t.requester}
            </>,
          )}
          {row("영향 고객", <span className="mono">{Math.max(t.spec?.impact?.customers ?? 0, t.affected?.length ?? 0) || 1}명</span>)}
          {t.branch ? row("브랜치", <span className="mono tk-branch"><IconBranch size={14} />{t.branch}</span>) : null}
          {t.prUrl ? row("PR", <a className="link-chip" href={t.prUrl} target="_blank" rel="noreferrer">{t.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}<IconExternal size={12} /></a>) : null}
          {row("만든 때", <span title={new Date(t.createdAt).toLocaleString("ko-KR")}>{relTime(t.createdAt, now)}</span>)}
        </dl>
      </section>
      {t.affected && t.affected.length > 1 ? (
        <section>
          <h3 className="sec-t">합친 제보 {t.affected.length}</h3>
          <ul className="tl">
            {t.affected.map((a, i) => (
              <li key={i}>
                <Avatar name={a.who} size={16} />
                <div>
                  <p className="tl-what">{a.who}</p>
                  <p className="tl-why">{relTime(a.at, now)}{a.ref ? `, ${a.ref}` : ""}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

export function TicketDetail({ api, ticket: t, setTicket, user, go }: { api: Api; ticket: Ticket; setTicket: (t: Ticket) => void; user: User; go: (p: string) => void }) {
  const tapi = useTicketApi();
  const now = useNow(30000);
  const key = t.key ?? t.id;
  const dev = user.role === "dev";
  const { asks, reload } = useAsks(key, t);
  const [devs, setDevs] = useState<string[]>([]);
  const [raw, setRaw] = useState<string | null>(null);
  const spec = t.spec;
  useEffect(() => {
    if (!dev) return;
    api.channels().then((cs) => setDevs([...new Set([user.name, ...cs.flatMap((c) => c.reviewers), ...(t.assignee ? [t.assignee] : [])])])).catch(() => undefined);
  }, [api, dev, user.name, t.assignee]);
  // 개발자에게 고객 원문은 번들의 가린 버전(raw=1)으로만
  const loadRaw = () => {
    if (raw !== null) return;
    tapi.bundle(key, true).then((b) => setRaw(b.untrusted?.customerText ?? "")).catch(() => setRaw(""));
  };
  const back = dev ? "/tickets" : "/tickets/mine";
  return (
    <div className="turn-page">
      <div className="rq-layout tk-detail">
        <div className="rq-main">
          <a className="btn q sm tk-back" href={`#${back}`} onClick={(e) => { e.preventDefault(); go(back); }}>
            <IconArrowLeft size={14} /> {dev ? "티켓함" : "내 티켓"}
          </a>
          <div className="tk-head">
            <span className="mono t-meta">{t.key}</span>
            <h1 className="t-page">{spec?.title || t.title}</h1>
            <TicketSteps status={t.status} />
          </div>

          {dev ? <DevActions t={t} user={user} onTicket={setTicket} /> : null}

          {t.status === "declined" && t.decline ? (
            <section className="rq-sec">
              <h2 className="sec-t">이번엔 안 하기로 했어요</h2>
              <AiText read original={dev ? undefined : t.decline.reason}>{dev ? t.decline.reason : t.decline.forRequester}</AiText>
              {t.decline.alternatives.length ? <p className="t-meta">대신: {t.decline.alternatives.map((a) => a.title).join(", ")}</p> : null}
            </section>
          ) : null}

          {dev ? <Warnings t={t} /> : null}

          {spec?.summary ? (
            <section className="rq-sec">
              <h2 className="sec-t">요약</h2>
              {dev ? <p>{spec.summary.forDeveloper}</p> : <AiText read>{spec.summary.forRequester}</AiText>}
            </section>
          ) : null}

          <AskThread t={t} asks={asks} user={user} onTicket={setTicket} reload={reload} />

          {dev ? (
            <>
              <section className="rq-sec">
                <h2 className="sec-t">칸별 내용</h2>
                <FieldList t={t} mode="read" />
              </section>
              {spec?.acceptanceCriteria?.length ? (
                <section className="rq-sec">
                  <h2 className="sec-t">수용 기준</h2>
                  <ul className="rq-check">
                    {spec.acceptanceCriteria.map((c) => (
                      <li key={c} className={t.status === "merged" || t.status === "deployed" || t.status === "closed" ? "on" : ""}>
                        <span className="box" aria-hidden>{t.status === "merged" || t.status === "deployed" || t.status === "closed" ? <IconCheck size={12} /> : null}</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                  {spec.outOfScope.length ? (
                    <div className="chips">
                      <span className="t-meta">범위 밖</span>
                      {spec.outOfScope.map((x) => (
                        <span key={x} className="chip muted">{x}</span>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
              <section className="tk-orig" onClick={loadRaw}>
                <Original text={raw ?? "불러오는 중"} label="고객 원문 (개인정보 가림, 비신뢰)" />
              </section>
              <p className="t-meta tk-cli">
                <IconTerminal size={14} /> 터미널: <code>{workCommand(key)}</code> 로 브랜치, <code>.willnew/ticket.md</code>, 권한 설정 틀까지 한 번에
              </p>
            </>
          ) : (
            <>
              <section className="rq-sec">
                <h2 className="sec-t">보낸 내용</h2>
                <FieldList t={t} mode="read" fields={["problem", "expected", "actual"]} />
              </section>
              <Original text={t.text} label="내가 붙여 넣은 원문" />
            </>
          )}
        </div>
        <Ctx t={t} user={user} onTicket={setTicket} devs={devs} now={now} />
      </div>
    </div>
  );
}
