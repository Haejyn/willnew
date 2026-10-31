/** 티켓함 (개발자, 리드). 표, 필터, 담당자와 우선순위는 그 자리에서. 휴대폰에서는 줄마다 카드. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api } from "../api";
import { Avatar, Empty, ErrorBox } from "../ui";
import { useMedia, useNow, type User } from "../util";
import { age, type ListQuery, type Request, type RequestStatus, type TicketSummary } from "./api";
import { Priority, StatusDot, useAct, useTicketApi, useTicketList } from "./parts";

// 고객 답 대기(waiting_customer)는 보내기 전 티켓이라 개발자에게 보이지 않는다(서버도 주지 않는다)
type Filter = "open" | "mine" | "unassigned" | "cs" | "done";
const OPEN: RequestStatus[] = ["open", "assigned", "in_progress", "waiting_requester", "preview", "code_review"];
const FILTERS: { id: Filter; name: string; q: ListQuery }[] = [
  { id: "open", name: "열린 티켓", q: { status: OPEN } },
  { id: "mine", name: "내 티켓", q: { assignee: "me", status: OPEN } },
  { id: "unassigned", name: "담당자 없음", q: { status: ["open"] } },
  { id: "cs", name: "CS 답 대기", q: { status: ["waiting_requester"] } },
  { id: "done", name: "끝난 티켓", q: { status: ["merged", "deployed", "closed", "declined"] } },
];
const PRIORITIES: NonNullable<Request["priority"]>[] = ["P0", "P1", "P2", "P3"];
const FILTER_KEY = "willnew.tickets.filter";

function loadFilter(): Filter {
  try {
    const f = localStorage.getItem(FILTER_KEY) as Filter | null;
    return f && FILTERS.some((x) => x.id === f) ? f : "open";
  } catch {
    return "open";
  }
}

/** 담당자 후보: 채널 검토자(개발자)와 지금 목록의 담당자, 그리고 나 */
function useDevelopers(api: Api, user: User, list: TicketSummary[] | null) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    api.channels().then((cs) => setNames(cs.flatMap((c) => c.reviewers))).catch(() => undefined);
  }, [api]);
  return useMemo(() => [...new Set([user.role === "dev" ? user.name : "", ...names, ...(list ?? []).map((t) => t.assignee ?? "")].filter(Boolean))], [names, list, user]);
}

export function Inbox({ api, user, go, me }: { api: Api; user: User; go: (p: string) => void; me?: ReactNode }) {
  const tapi = useTicketApi();
  const [filter, setFilter] = useState<Filter>(loadFilter);
  const f = FILTERS.find((x) => x.id === filter)!;
  const { list, error, reload } = useTicketList(f.q);
  const devs = useDevelopers(api, user, list);
  const { busy, run } = useAct();
  const phone = !useMedia("(min-width: 768px)");
  const now = useNow(30000);
  const pick = (id: Filter) => {
    setFilter(id);
    try {
      localStorage.setItem(FILTER_KEY, id);
    } catch {
      /* storage blocked */
    }
  };
  const assign = async (t: TicketSummary, input: { assignee?: string; priority?: Request["priority"] }) => {
    const done = await run(`${t.key}-${input.assignee ? "a" : "p"}`, () => tapi.assign(t.key, input), input.assignee ? `${t.key} 담당 ${input.assignee}` : `${t.key} ${input.priority}`);
    if (done) reload();
  };
  const sorted = useMemo(() => {
    const rank = (p?: string) => (p ? PRIORITIES.indexOf(p as never) : 9);
    return (list ?? []).slice().sort((a, b) => rank(a.priority) - rank(b.priority) || a.createdAt - b.createdAt);
  }, [list]);
  const open = (t: TicketSummary) => go(`/tickets/${encodeURIComponent(t.key)}`);

  const pri = (t: TicketSummary) => (
    <select className="tk-sel mono" aria-label={`${t.key} 우선순위`} value={t.priority ?? ""} disabled={busy === `${t.key}-p`} onClick={(e) => e.stopPropagation()} onChange={(e) => void assign(t, { priority: (e.target.value || undefined) as Request["priority"] })}>
      <option value="">없음</option>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>{p}</option>
      ))}
    </select>
  );
  const who = (t: TicketSummary) => (
    <select className="tk-sel" aria-label={`${t.key} 담당자`} value={t.assignee ?? ""} disabled={busy === `${t.key}-a`} onClick={(e) => e.stopPropagation()} onChange={(e) => e.target.value && void assign(t, { assignee: e.target.value })}>
      <option value="">담당자 없음</option>
      {devs.map((d) => (
        <option key={d} value={d}>{d}</option>
      ))}
    </select>
  );

  return (
    <div className="page wide tk-inbox">
      <div className="page-head">
        <h1>티켓함 {list ? <span className="mono dim">{list.length}</span> : null}</h1>
        <span className="grow" />
        <span className="only-phone">{me}</span>
      </div>
      <div className="tk-filters chips" role="tablist" aria-label="필터">
        {FILTERS.map((x) => (
          <button key={x.id} role="tab" aria-selected={filter === x.id} className={`chip ${filter === x.id ? "on" : ""}`} onClick={() => pick(x.id)}>
            {x.name}
          </button>
        ))}
      </div>
      {error && !list ? <ErrorBox error={`불러오기 실패. ${error}`} onRetry={reload} /> : null}
      {!list && !error ? <div className="skel card-skel" aria-busy /> : null}
      {list && !list.length ? <Empty title={filter === "mine" ? "맡은 티켓이 없어요" : "해당하는 티켓이 없어요"} /> : null}
      {list?.length ? (
        phone ? (
          <div className="mcards">
            {sorted.map((t) => (
              <article key={t.id} className="mcard tk-card" onClick={() => open(t)}>
                <div className="mc-main">
                  <div className="mc-meta">
                    <span className="mono">{t.key}</span>
                    <StatusDot status={t.status} />
                    <span>{age(t.createdAt, now)}</span>
                    {t.affected > 1 ? <span>고객 {t.affected}명</span> : null}
                  </div>
                  <h2>{t.title}</h2>
                  <div className="row-btns">
                    {pri(t)}
                    {who(t)}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="tbl tk-tbl">
              <thead>
                <tr>
                  <th>키</th>
                  <th>제목</th>
                  <th>상태</th>
                  <th title="사람이 정해요. AI 는 채우지 않아요">우선순위</th>
                  <th title="사람이 정해요. AI 는 채우지 않아요">담당자</th>
                  <th className="num">영향 고객</th>
                  <th className="num">나이</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((t) => (
                  <tr key={t.id} tabIndex={0} onClick={() => open(t)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(t)}>
                    <td className="mono nowrap">{t.key}</td>
                    <td className="strong tk-title-cell">
                      <a href={`#/tickets/${encodeURIComponent(t.key)}`} onClick={(e) => e.stopPropagation()}>{t.title}</a>
                      <span className="t-meta">{t.requester}</span>
                    </td>
                    <td><StatusDot status={t.status} /></td>
                    <td>{user.role === "dev" ? pri(t) : <Priority p={t.priority} />}</td>
                    <td>
                      {user.role === "dev" ? (
                        <span className="tk-who-cell">
                          {t.assignee ? <Avatar name={t.assignee} size={20} /> : null}
                          {who(t)}
                        </span>
                      ) : (t.assignee ?? <span className="t-meta">없음</span>)}
                    </td>
                    <td className="num mono">{t.affected}</td>
                    <td className="num mono nowrap">{age(t.createdAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}
