/** 내 티켓 (CS). 개발자가 물어봤어요(그 자리에서 답하기), 고객 답 기다림, 작성 중, 보낸 티켓의 진행. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IconPlus } from "../icons";
import { AiText, Empty, ErrorBox, Spinner } from "../ui";
import { relTime, useNow, type User } from "../util";
import { customerMessage, heldFields, isIntake, type Ask, type Ticket, type TicketSummary } from "./api";
import { CopyBtn, Priority, StatusDot, TicketSteps, useAct, useTicketApi, useTicketList } from "./parts";

/** 답을 기다리는 질문들 (waiting_requester 티켓마다) */
function usePendingAsks(list: TicketSummary[] | null) {
  const tapi = useTicketApi();
  const [asks, setAsks] = useState<Record<string, Ask[]>>({});
  const keys = (list ?? []).filter((t) => t.status === "waiting_requester").map((t) => `${t.key}@${t.updatedAt}`).join(",");
  useEffect(() => {
    for (const k of keys.split(",").filter(Boolean)) {
      const key = k.split("@")[0];
      tapi.asks(key).then((a) => setAsks((cur) => ({ ...cur, [key]: a }))).catch(() => undefined);
    }
  }, [tapi, keys]);
  return [asks, setAsks] as const;
}

/** 고객 답 기다리는 티켓의 보류 칸 */
function useHeld(list: TicketSummary[] | null) {
  const tapi = useTicketApi();
  const [full, setFull] = useState<Record<string, Ticket>>({});
  const keys = (list ?? []).filter((t) => t.status === "waiting_customer").map((t) => `${t.key}@${t.updatedAt}`).join(",");
  useEffect(() => {
    for (const k of keys.split(",").filter(Boolean)) {
      const key = k.split("@")[0];
      tapi.get(key).then((t) => setFull((cur) => ({ ...cur, [key]: t }))).catch(() => undefined);
    }
  }, [tapi, keys]);
  return full;
}

function Head({ t, now, right }: { t: TicketSummary; now: number; right?: ReactNode }) {
  return (
    <div className="mine-top">
      <a href={`#/tickets/${encodeURIComponent(t.key)}`} className="tk-card-title">
        <span className="mono t-meta">{t.key}</span>
        <h2>{t.title}</h2>
      </a>
      {right ?? <span className="t-meta">{relTime(t.updatedAt, now)}</span>}
    </div>
  );
}

function AskCard({ t, asks, now, onAnswered }: { t: TicketSummary; asks?: Ask[]; now: number; onAnswered: () => void }) {
  const tapi = useTicketApi();
  const { busy, run } = useAct();
  const [text, setText] = useState<Record<string, string>>({});
  const open = (asks ?? []).filter((a) => !a.answer);
  return (
    <article className="mine-card tk-mine-ask">
      <Head t={t} now={now} right={<span className="t-meta">{t.assignee ?? "개발자"}</span>} />
      {asks === undefined ? <div className="skel tk-skel-line" /> : null}
      {open.map((a) => (
        <div key={a.askId} className="tk-mine-q">
          <AiText read original={a.question} label="개발자가 쓴 그대로 보기">{a.forRequester}</AiText>
          <form
            className="rq-other"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = text[a.askId]?.trim();
              if (!v) return;
              const ok = await run(a.askId, () => tapi.answerAsk(t.key, a.askId, v), "답을 보냈어요. 개발자에게 바로 가요");
              if (ok) onAnswered();
            }}
          >
            <input aria-label="답" value={text[a.askId] ?? ""} onChange={(e) => setText({ ...text, [a.askId]: e.target.value })} placeholder="답 적기. 모르면 모른다고 적어도 돼요" />
            <button className="btn sm m" type="submit" disabled={!text[a.askId]?.trim() || !!busy}>
              {busy === a.askId ? <Spinner size={12} /> : null}답하기
            </button>
          </form>
        </div>
      ))}
    </article>
  );
}

function HeldCard({ t, full, now }: { t: TicketSummary; full?: Ticket; now: number }) {
  const held = full ? heldFields(full) : [];
  return (
    <article className="mine-card">
      <Head t={t} now={now} />
      {full ? (
        <>
          <ul className="rq-list">
            {held.map((a) => (
              <li key={a.field}>{a.question}</li>
            ))}
          </ul>
          <div className="row-btns">
            {held.length ? <CopyBtn text={customerMessage(held)} label="고객에게 보낼 문구 복사" ok="복사했어요. 상담 창에 붙여 넣어 주세요" /> : null}
            <a className="btn sm q" href={`#/tickets/${encodeURIComponent(t.key)}`}>고객 답 붙이기</a>
          </div>
        </>
      ) : (
        <div className="skel tk-skel-line" />
      )}
    </article>
  );
}

export function TicketMine({ go, me }: { user: User; go: (p: string) => void; me?: ReactNode }) {
  const { list, error, reload } = useTicketList({ mine: true });
  const [asks] = usePendingAsks(list);
  const full = useHeld(list);
  const now = useNow(30000);
  const groups = useMemo(() => {
    const l = (list ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      ask: l.filter((t) => t.status === "waiting_requester"),
      held: l.filter((t) => t.status === "waiting_customer"),
      draft: l.filter((t) => isIntake(t.status) && t.status !== "waiting_customer"),
      sent: l.filter((t) => !isIntake(t.status) && t.status !== "waiting_requester"),
    };
  }, [list]);
  return (
    <div className="turn-page">
      <div className="turn-col tk-mine">
        <div className="turn-head">
          <h1>내 티켓 {list?.length ? <span className="mono n">{list.length}</span> : null}</h1>
          <span className="grow" />
          <a className="btn m tk-new-btn" href="#/tickets/new" onClick={(e) => { e.preventDefault(); go("/tickets/new"); }}>
            <IconPlus size={16} /> 새 문의
          </a>
          <span className="only-phone">{me}</span>
        </div>
        {error && !list ? <ErrorBox error={`불러오기 실패. ${error}`} onRetry={reload} /> : null}
        {!list && !error ? (
          <div className="mcards" aria-busy>
            <div className="skel card-skel" />
            <div className="skel card-skel" />
          </div>
        ) : null}
        {list && !list.length ? (
          <Empty title="아직 보낸 티켓이 없어요" action={<a className="btn m" href="#/tickets/new"><IconPlus size={16} /> 새 문의</a>} />
        ) : null}

        {groups.ask.length ? (
          <section className="tk-group" aria-label="개발자가 물어봤어요">
            <h2 className="sec-h">개발자가 물어봤어요 <span className="mono">{groups.ask.length}</span></h2>
            <div className="mcards">
              {groups.ask.map((t) => (
                <AskCard key={t.id} t={t} asks={asks[t.key]} now={now} onAnswered={reload} />
              ))}
            </div>
          </section>
        ) : null}

        {groups.held.length ? (
          <section className="tk-group" aria-label="고객 답 기다림">
            <h2 className="sec-h">고객 답 기다림 <span className="mono">{groups.held.length}</span></h2>
            <div className="mcards">
              {groups.held.map((t) => (
                <HeldCard key={t.id} t={t} full={full[t.key]} now={now} />
              ))}
            </div>
          </section>
        ) : null}

        {groups.draft.length ? (
          <section className="tk-group" aria-label="작성 중">
            <h2 className="sec-h">작성 중</h2>
            <div className="rows">
              {groups.draft.map((t) => (
                <a key={t.id} className="trow" href={`#/tickets/${encodeURIComponent(t.key)}`}>
                  <span className="mono t-meta">{t.key}</span>
                  <span className="trow-title">{t.title}</span>
                  <StatusDot status={t.status} />
                </a>
              ))}
            </div>
          </section>
        ) : null}

        {groups.sent.length ? (
          <section className="tk-group" aria-label="보낸 티켓">
            <h2 className="sec-h">보낸 티켓</h2>
            <div className="mcards">
              {groups.sent.map((t) => (
                <article key={t.id} className="mine-card tk-sent">
                  <Head t={t} now={now} />
                  <div className="tk-sent-row">
                    <TicketSteps status={t.status} />
                    <span className="t-meta tk-sent-who">
                      {t.assignee ? `${t.assignee} 담당` : "담당자 정하는 중"}
                      {t.priority ? <> <Priority p={t.priority} /></> : null}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
