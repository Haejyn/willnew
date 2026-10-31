/**
 * 새 문의 (CS). 붙여 넣기 → 한 번에 질문 하나 → 오른쪽 초안이 채워진다. 휴대폰에서는 초안이 아래 시트.
 * 질문이 만들어지는 동안은 대기열 위치와 흘러나오는 글자(SSE delta)를 보여 준다.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isDemo } from "../api";
import { DEMO_ONE_LINE, DEMO_TRANSCRIPT } from "../demo";
import { IconCheck, IconChevron, IconSend, Logo } from "../icons";
import { ErrorBox, Spinner, Working, useToast } from "../ui";
import { useMedia, type User } from "../util";
import { customerMessage, FIELDS, fieldMeta, heldFields, utterances, type AiStatus, type AnswerKind, type ClarifyQuestion, type Ticket } from "./api";
import { CopyBtn, FieldList, filledCount, useAct, useTicketApi } from "./parts";

const KIND_ANSWER: Record<Exclude<AnswerKind, "answer">, string> = { unknown: "모름", ask_customer: "고객에게 물을게요" };

function useAiStatus() {
  const tapi = useTicketApi();
  const [ai, setAi] = useState<AiStatus | null>(null);
  useEffect(() => {
    tapi.aiStatus().then(setAi).catch(() => undefined);
  }, [tapi]);
  return ai;
}

export function FormModeNote({ ai }: { ai: AiStatus | null }) {
  if (!ai || ai.enabled) return null;
  return <p className="tk-formmode st warn">AI 없음. 양식 질문으로 물어요. 설정에서 AI 상태를 볼 수 있어요</p>;
}

// ---------------------------------------------------------------------------------------------- intake

export function NewTicket({ go, me }: { user: User; go: (p: string) => void; me?: ReactNode }) {
  const tapi = useTicketApi();
  const ai = useAiStatus();
  const [mode, setMode] = useState<"line" | "log">("log");
  const [text, setText] = useState("");
  const { busy, run } = useAct();
  const demo = useMemo(isDemo, []);
  const submit = async () => {
    if (!text.trim() || busy) return;
    const t = await run("intake", () => tapi.intake({ text: text.trim(), channel: "cs" }));
    if (t) go(`/tickets/${encodeURIComponent(t.key ?? t.id)}`);
  };
  return (
    <div className="turn-page">
      <div className="turn-col tk-new">
        <div className="turn-head">
          <h1>새 문의</h1>
          <span className="only-phone">{me}</span>
        </div>
        <FormModeNote ai={ai} />
        <form
          className="tk-intake-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="seg" role="tablist" aria-label="붙여 넣는 방식">
            <button type="button" role="tab" aria-selected={mode === "log"} className={mode === "log" ? "on" : ""} onClick={() => setMode("log")}>
              대화 기록 붙여 넣기
            </button>
            <button type="button" role="tab" aria-selected={mode === "line"} className={mode === "line" ? "on" : ""} onClick={() => setMode("line")}>
              한 줄로 적기
            </button>
          </div>
          <p className="tk-privacy">전화번호, 카드 번호 같은 개인정보는 정리하기 전에 가려요. 대화에 이미 있는 내용은 다시 묻지 않아요.</p>
          <label className="field">
            <span className="sr">문의 내용</span>
            <textarea
              rows={mode === "log" ? 10 : 3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={mode === "log" ? "채널톡이나 메일 대화를 통째로 붙여 넣어 주세요\n고객: ...\n상담원: ..." : "고객이 겪은 일을 한 줄로 적어 주세요"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          {demo ? (
            <div className="examples tk-examples">
              <button type="button" className="chip" onClick={() => { setMode("log"); setText(DEMO_TRANSCRIPT); }}>
                예시: 쿠폰 상담 기록
              </button>
              <button type="button" className="chip" onClick={() => { setMode("line"); setText(DEMO_ONE_LINE); }}>
                예시: 한 줄 문의
              </button>
            </div>
          ) : null}
          <div className="row-btns">
            <button className="btn m" type="submit" disabled={!text.trim() || !!busy}>
              {busy ? <Spinner size={12} /> : <IconSend size={16} />}
              정리 시작
            </button>
          </div>
        </form>
        {busy ? <Working text="받았어요. 정리하는 중" lines={3} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- one question

/** 질문 하나: 선택지 2~4개, 직접 쓰기, 모름, 고객에게 물을게요 */
export function QuestionCard({ t, q, onAnswer, busy, n, note }: { t: Ticket; q: ClarifyQuestion; onAnswer: (kind: AnswerKind, text?: string) => void; busy: boolean; n?: number; note?: string }) {
  const [other, setOther] = useState(false);
  const [otherText, setOtherText] = useState("");
  useEffect(() => {
    setOther(false);
    setOtherText("");
  }, [q.id]);
  // 양식 모드는 선택지가 없을 수 있다: 바로 직접 쓰기
  const free = !q.choices.length;
  return (
    <section className="cq tk-q slide-in" aria-label="질문">
      {note ? <span className="tk-q-note">{note}</span> : null}
      <div className="cq-head">
        <span className="cq-q">{q.question}</span>
        {n ? <span className="t-meta mono nowrap">{n}번째</span> : null}
      </div>
      {q.why ? <p className="tk-why">{q.why}</p> : null}
      {free ? null : (
        <div className="chips cq-chips">
          {q.choices.map((c) => (
            <button key={c} className="chip pick" disabled={busy} onClick={() => onAnswer("answer", c)}>
              {c}
            </button>
          ))}
          <button className={`chip pick ${other ? "on" : ""}`} aria-expanded={other} disabled={busy} onClick={() => setOther((o) => !o)}>
            직접 쓰기
          </button>
        </div>
      )}
      {other || free ? (
        <form
          className="rq-other"
          onSubmit={(e) => {
            e.preventDefault();
            if (otherText.trim()) onAnswer("answer", otherText.trim());
          }}
        >
          <input autoFocus={!free} aria-label="직접 쓰기" value={otherText} onChange={(e) => setOtherText(e.target.value)} placeholder="직접 적어 주세요" maxLength={300} />
          <button className="btn sm w" type="submit" disabled={!otherText.trim() || busy}>
            보내기
          </button>
        </form>
      ) : null}
      <div className="row-btns tk-q-alt">
        <button className="btn sm q" disabled={busy} onClick={() => onAnswer("unknown")}>
          모름
        </button>
        <button className="btn sm q" disabled={busy} onClick={() => onAnswer("ask_customer")} title={`${t.requester}님이 고객에게 물어보고 나중에 답을 붙여요`}>
          고객에게 물을게요
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- customer asks

/** 고객에게 물을 것: 목록, 고객에게 보낼 문구 복사, 답 붙이기, 모름으로 두기 */
export function CustomerAsks({ t, onChange, compact }: { t: Ticket; onChange: (t: Ticket) => void; compact?: boolean }) {
  const tapi = useTicketApi();
  const { busy, run } = useAct();
  const items = t.spec?.askCustomer ?? [];
  const open = items.filter((a) => !a.answer);
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!items.length) return null;
  const key = t.key ?? t.id;
  return (
    <section className="tk-asks" aria-label="고객에게 물을 것">
      <div className="card-head">
        <h3 className="sec-t">고객에게 물을 것 {open.length ? <span className="mono">{open.length}</span> : null}</h3>
        {open.length ? <CopyBtn text={customerMessage(open)} label="고객에게 보낼 문구 복사" ok="복사했어요. 상담 창에 붙여 넣어 주세요" /> : null}
      </div>
      <ul className="tk-ask-list">
        {items.map((a) => (
          <li key={a.field} className={a.answer ? "done" : ""}>
            <p className="tk-ask-q">{a.question}</p>
            {a.answer ? (
              <p className="t-meta">
                <IconCheck size={12} /> 고객 답: <b>{a.answer}</b>
              </p>
            ) : compact ? null : (
              <form
                className="rq-other"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const v = draft[a.field]?.trim();
                  if (!v) return;
                  const next = await run(`ca-${a.field}`, () => tapi.customerAnswer(key, { field: a.field, answer: v }), "고객 답을 붙였어요");
                  if (next) onChange(next);
                }}
              >
                <input aria-label="고객 답" value={draft[a.field] ?? ""} onChange={(e) => setDraft({ ...draft, [a.field]: e.target.value })} placeholder="고객 답 붙이기" />
                <button className="btn sm w" type="submit" disabled={!draft[a.field]?.trim() || !!busy}>
                  {busy === `ca-${a.field}` ? <Spinner size={12} /> : null}붙이기
                </button>
                <button
                  className="btn sm q"
                  type="button"
                  disabled={!!busy}
                  title="고객 답 없이 모름으로 두고 넘어가요"
                  onClick={async () => {
                    const next = await run(`un-${a.field}`, () => tapi.editField(key, { field: a.field, value: null, confirm: true }));
                    if (next) onChange(next);
                  }}
                >
                  모름으로 두기
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- draft panel

function DraftPanel({ t, onChange }: { t: Ticket; onChange: (t: Ticket) => void }) {
  const n = filledCount(t);
  return (
    <aside className="tk-draft" aria-label="초안">
      <div className="card-head">
        <h2 className="t-title">초안</h2>
        <span className="t-meta mono">{n}/{FIELDS.length}칸</span>
      </div>
      {t.spec?.title ? <p className="tk-draft-title">{t.spec.title}</p> : null}
      <FieldList t={t} mode="live" />
      <CustomerAsks t={t} onChange={onChange} />
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------- conversation

function Bubble({ who, me, children, live }: { who: string; me?: boolean; children: ReactNode; live?: boolean }) {
  return (
    <div className={`tk-msg ${me ? "me" : "bot"} slide-in`} aria-live={live ? "polite" : undefined}>
      {me ? null : (
        <span className="avatar bot" style={{ width: 28, height: 28 }} aria-hidden>
          <Logo size={16} />
        </span>
      )}
      <div className="tk-bubble">
        {me ? null : <span className="tk-who">{who}</span>}
        {children}
      </div>
    </div>
  );
}

function Pasted({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const utt = utterances(text);
  const long = text.split("\n").length > 4 || text.length > 240;
  return (
    <Bubble who="나" me>
      <span className="t-meta">{utt.length > 1 ? `상담 기록 ${utt.length}줄` : "문의"}</span>
      <p className={`tk-pasted ${long && !open ? "clip" : ""}`}>{text}</p>
      {long ? (
        <button type="button" className="ai-orig" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "접기" : "전부 보기"}
        </button>
      ) : null}
    </Bubble>
  );
}

/** 질문과 답을 시간 순서로. 끝에 지금 질문(또는 흘러나오는 글자, 대기열) */
export function IntakeChat({ ticket, setTicket, delta, queue, user }: { ticket: Ticket; setTicket: (t: Ticket) => void; delta: string; queue: number; user: User }) {
  const tapi = useTicketApi();
  const toast = useToast();
  const ai = useAiStatus();
  const phone = !useMedia("(min-width: 1024px)");
  const [sheet, setSheet] = useState(false);
  const [pending, setPending] = useState<{ q: ClarifyQuestion; text: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const t = ticket;
  const key = t.key ?? t.id;
  const mine = t.requester === user.name;
  const answered = t.questions.filter((q) => q.answer);
  const extracted = FIELDS.filter((f) => fieldMeta(t.spec, f)?.sources.some((s) => s.kind === "utterance" && s.speaker !== "cs")).length;
  const held = heldFields(t);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [answered.length, delta.length > 0, queue, pending, t.status]);

  const answer = async (kind: AnswerKind, text?: string) => {
    const q = t.next;
    if (!q || pending) return;
    setPending({ q, text: kind === "answer" ? text ?? "" : KIND_ANSWER[kind] });
    try {
      setTicket(await tapi.message(key, { questionId: q.id, kind, text }));
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setPending(null);
    }
  };

  // 서버가 다음 질문이나 초안을 만드는 중 (스트림으로 바뀐다)
  const thinking = !!pending || (t.status === "draft") || (t.status === "clarifying" && !t.next);

  const chat = (
    <div className="tk-chat">
      <FormModeNote ai={ai} />
      <Pasted text={t.text} />
      <Bubble who="willnew">
        <p>{extracted ? `받았어요. 대화에서 칸 ${extracted}개를 채웠어요. 빈 칸만 물어볼게요` : "받았어요. 빈 칸을 하나씩 물어볼게요"}</p>
      </Bubble>
      {answered.map((q) => (
        <div key={q.id} className="tk-pair">
          <Bubble who="willnew">
            <p>{q.question}</p>
          </Bubble>
          <Bubble who={q.answeredBy ?? "나"} me>
            <p>{q.answer}</p>
          </Bubble>
        </div>
      ))}
      {pending && !t.questions.find((x) => x.id === pending.q.id)?.answer ? (
        <div className="tk-pair">
          <Bubble who="willnew">
            <p>{pending.q.question}</p>
          </Bubble>
          <Bubble who="나" me>
            <p>{pending.text}</p>
          </Bubble>
        </div>
      ) : null}
      {thinking ? (
        queue > 0 ? (
          <Bubble who="willnew" live>
            <p className="tk-queue st">앞에 {queue}명. 차례가 오면 바로 물어볼게요</p>
          </Bubble>
        ) : delta ? (
          <Bubble who="willnew" live>
            <p className="tk-delta">
              {delta}
              <span className="tk-caret" aria-hidden />
            </p>
          </Bubble>
        ) : (
          <Bubble who="willnew" live>
            <Working text={t.status === "clarifying" && !pending && filledCount(t) === FIELDS.length ? "초안 만드는 중" : "정리하는 중"} lines={1} />
          </Bubble>
        )
      ) : t.next && mine ? (
        <QuestionCard t={t} q={t.next} onAnswer={answer} busy={!!pending} n={answered.length + 1} />
      ) : t.next ? (
        <p className="t-meta">{t.requester}님 답 기다리는 중</p>
      ) : t.status === "waiting_customer" ? (
        <Bubble who="willnew">
          <p>고객 답이 필요한 칸만 남았어요. 고객에게 물어보고 답을 붙여 주세요. 답 없이 모름으로 두고 넘어가도 돼요</p>
          {phone ? <CustomerAsks t={t} onChange={setTicket} /> : null}
        </Bubble>
      ) : null}
      <div ref={end} />
    </div>
  );

  return (
    <div className={`tk-intake ${phone ? "phone" : ""}`}>
      <div className="tk-intake-main">
        <div className="tk-intake-head">
          <span className="mono t-meta">{t.key}</span>
          <h1 className="t-title">{t.spec?.title || t.title || "새 문의"}</h1>
        </div>
        {chat}
      </div>
      {phone ? (
        <>
          <button className={`tk-sheet-bar ${sheet ? "open" : ""}`} aria-expanded={sheet} onClick={() => setSheet((s) => !s)}>
            <span>초안</span>
            <span className="mono t-meta">{filledCount(t)}/{FIELDS.length}칸</span>
            {held.length ? <span className="warn-chip">고객에게 물을 것 {held.length}</span> : null}
            <IconChevron size={14} className="tk-sheet-chev" />
          </button>
          {sheet ? (
            <div className="tk-sheet-back" onMouseDown={(e) => e.target === e.currentTarget && setSheet(false)}>
              <div className="tk-sheet" role="dialog" aria-label="초안">
                <button className="tk-sheet-grip" aria-label="초안 닫기" onClick={() => setSheet(false)} />
                <DraftPanel t={t} onChange={setTicket} />
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <DraftPanel t={t} onChange={setTicket} />
      )}
    </div>
  );
}

export function TicketLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="turn-page">
      <div className="turn-col">
        <ErrorBox error={`불러오기 실패. ${error}`} onRetry={onRetry} />
      </div>
    </div>
  );
}
