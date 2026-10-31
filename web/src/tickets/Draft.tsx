/**
 * 초안 확인 (CS). 대리 개발자 검토 질문이 있으면 그것부터. 칸마다 출처와 확신도, "추정" 칸은 하나씩 확인해야 보내기가 켜진다.
 * 고객 원문은 접혀 있고 언제든 펼친다. 보내기가 409 면 서버가 말한 사유와 남은 칸을 그대로 보여 준다.
 */
import { useState } from "react";
import { IconCheck, IconSend } from "../icons";
import { AiText, Spinner, useToast } from "../ui";
import type { User } from "../util";
import { fieldLabel, TicketError, unconfirmedOf, type AnswerKind, type FieldName, type Ticket } from "./api";
import { CustomerAsks, QuestionCard } from "./NewTicket";
import { FieldList, Original, useAct, useTicketApi } from "./parts";

export function DraftReview({ ticket: t, setTicket, user, go, delta }: { ticket: Ticket; setTicket: (t: Ticket) => void; user: User; go: (p: string) => void; delta: string }) {
  const tapi = useTicketApi();
  const toast = useToast();
  const { busy, run } = useAct();
  const [refused, setRefused] = useState<{ error: string; unconfirmed?: string[]; reviewQuestions?: string[] } | null>(null);
  const key = t.key ?? t.id;
  const mine = t.requester === user.name;
  const left = unconfirmedOf(t);
  const review = [...new Set([...(t.reviewQuestions ?? []), ...(refused?.reviewQuestions ?? [])])];
  const spec = t.spec;

  const confirm = (f: FieldName) =>
    run(`confirm-${f}`, () => tapi.editField(key, { field: f, confirm: true })).then((n) => {
      if (n) {
        setTicket(n);
        setRefused(null);
      }
    });
  const edit = (f: FieldName, value: unknown) =>
    run(`edit-${f}`, () => tapi.editField(key, { field: f, value }), `${fieldLabel(f)} 칸을 고쳤어요`).then((n) => n && setTicket(n));
  const answer = async (kind: AnswerKind, text?: string) => {
    if (!t.next) return;
    const n = await run("answer", () => tapi.message(key, { questionId: t.next!.id, kind, text }));
    if (n) setTicket(n);
  };
  const send = async () => {
    setRefused(null);
    try {
      const n = await tapi.send(key);
      setTicket(n);
      toast(`${n.key ?? key} 보냈어요. 개발팀 티켓함에 올라갔어요`, "ok");
      go(`/tickets/${encodeURIComponent(n.key ?? key)}`);
    } catch (e) {
      if (e instanceof TicketError && e.status === 409) setRefused({ error: e.message, unconfirmed: e.body.unconfirmed, reviewQuestions: e.body.reviewQuestions });
      else toast((e as Error).message, "err");
    }
  };
  const sending = busy === "send";

  return (
    <div className="turn-page">
      <div className="rq-layout tk-review">
        <div className="rq-main">
          <div className="tk-head">
            <span className="mono t-meta">{t.key}</span>
            <h1 className="t-page">{spec?.title || t.title}</h1>
            <p className="t-meta">초안 확인. 보내기 전에는 개발자에게 보이지 않아요</p>
          </div>

          {t.next ? (
            mine ? (
              <QuestionCard t={t} q={t.next} onAnswer={answer} busy={busy === "answer"} note="대리 개발자 검토. 이 티켓을 받은 개발자가 처음 물을 만한 질문이에요" />
            ) : (
              <p className="t-meta">{t.requester}님 답 기다리는 중</p>
            )
          ) : delta ? (
            <p className="tk-delta cq">
              {delta}
              <span className="tk-caret" aria-hidden />
            </p>
          ) : null}

          {review.length ? (
            <section className="rq-sec" aria-label="대리 개발자 검토">
              <h2 className="sec-t">대리 개발자 검토</h2>
              <ul className="rq-list">
                {review.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
              <p className="t-meta">{t.next ? "위 질문에 답하면 초안에 들어가요" : "이 질문들은 초안에 반영했어요"}</p>
            </section>
          ) : null}

          {spec?.summary?.forRequester ? (
            <section className="rq-sec">
              <h2 className="sec-t">이렇게 정리했어요</h2>
              <AiText read>{spec.summary.forRequester}</AiText>
            </section>
          ) : null}

          <section className="rq-sec" aria-label="칸">
            <div className="card-head">
              <h2 className="sec-t">칸별 내용</h2>
              {left.length ? <span className="warn-chip">확인할 칸 {left.length}</span> : <span className="st ok">모두 확인</span>}
            </div>
            <FieldList t={t} mode="review" onConfirm={mine ? confirm : undefined} onEdit={mine ? edit : undefined} busy={busy} />
          </section>

          {spec?.acceptanceCriteria?.length ? (
            <section className="rq-sec">
              <h2 className="sec-t">수용 기준</h2>
              <ul className="rq-check">
                {spec.acceptanceCriteria.map((c) => (
                  <li key={c}>
                    <span className="box" aria-hidden />
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

          <Original text={t.text} />

          {refused ? (
            <div className="errbox tk-refused" role="alert">
              <div>
                <p>{refused.error}</p>
                {refused.unconfirmed?.length ? <p className="t-meta">확인할 칸: {refused.unconfirmed.map(fieldLabel).join(", ")}</p> : null}
              </div>
            </div>
          ) : null}

          {mine ? (
            <div className="tk-sendbar">
              <span className="t-meta">{t.next ? "질문에 먼저 답해 주세요" : left.length ? `추정 칸 ${left.length}개를 확인하면 보낼 수 있어요` : "개발팀 티켓함으로 보내요"}</span>
              <button className="btn m" disabled={!!t.next || left.length > 0 || sending || t.status !== "spec_ready"} onClick={() => void run("send", send)}>
                {sending ? <Spinner size={12} /> : <IconSend size={16} />}이대로 보내기
              </button>
            </div>
          ) : null}
        </div>

        <aside className="rq-ctx">
          <section>
            <h3 className="sec-t">확인 순서</h3>
            <ol className="tk-todo">
              <li className={review.length && !t.next ? "done" : t.next ? "now" : "done"}>
                {review.length && !t.next ? <IconCheck size={12} /> : null}대리 검토 질문
              </li>
              <li className={left.length ? (t.next ? "" : "now") : "done"}>
                {left.length ? null : <IconCheck size={12} />}추정 칸 확인 {left.length ? <span className="mono">{left.length}</span> : null}
              </li>
              <li className={!left.length && !t.next ? "now" : ""}>이대로 보내기</li>
            </ol>
          </section>
          <CustomerAsks t={t} onChange={setTicket} />
        </aside>
      </div>
    </div>
  );
}
