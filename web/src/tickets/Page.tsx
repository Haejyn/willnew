/**
 * 티켓 화면 묶음. 주소:
 *   #/tickets          티켓함 (개발자). 요청자는 내 티켓
 *   #/tickets/new      새 문의
 *   #/tickets/mine     내 티켓 (CS)
 *   #/tickets/T-42     상태와 역할에 따라 대화, 초안 확인, 상세
 */
import type { ReactNode } from "react";
import type { Api } from "../api";
import { Empty } from "../ui";
import type { User } from "../util";
import { isIntake } from "./api";
import { TicketDetail } from "./Detail";
import { DraftReview } from "./Draft";
import { Inbox } from "./Inbox";
import { TicketMine } from "./Mine";
import { IntakeChat, NewTicket, TicketLoadError } from "./NewTicket";
import { useTicket } from "./parts";
import "./tickets.css";

export type TicketRoute = { view: "inbox" } | { view: "new" } | { view: "mine" } | { view: "ticket"; key: string };

export function parseTicketRoute(path: string): TicketRoute | null {
  const m = /^\/tickets(?:\/([^/]+))?/.exec(path);
  if (!m) return null;
  const k = m[1] ? decodeURIComponent(m[1]) : "";
  if (!k) return { view: "inbox" };
  if (k === "new") return { view: "new" };
  if (k === "mine") return { view: "mine" };
  return { view: "ticket", key: k };
}

function TicketByKey({ api, k, user, go }: { api: Api; k: string; user: User; go: (p: string) => void }) {
  const { ticket, setTicket, error, reload, delta, queue } = useTicket(k);
  if (error && !ticket) return <TicketLoadError error={error} onRetry={reload} />;
  if (!ticket)
    return (
      <div className="turn-page">
        <div className="turn-col">
          <div className="skel card-skel" aria-busy />
        </div>
      </div>
    );
  const dev = user.role === "dev";
  if (isIntake(ticket.status)) {
    if (dev && ticket.requester !== user.name)
      return <Empty title="아직 보내지 않은 티켓이에요">{ticket.requester}님이 확인하고 보내면 여기서 볼 수 있어요.</Empty>;
    // 초안이 만들어졌으면(제목이 있으면) 초안 확인. 대리 검토 질문도 여기서 먼저 묻는다
    const drafted = ticket.status === "spec_ready" || (ticket.status === "clarifying" && !!ticket.spec?.title && !!ticket.spec?.acceptanceCriteria?.length);
    if (drafted) return <DraftReview ticket={ticket} setTicket={setTicket} user={user} go={go} delta={delta} />;
    return <IntakeChat ticket={ticket} setTicket={setTicket} delta={delta} queue={queue} user={user} />;
  }
  return <TicketDetail api={api} ticket={ticket} setTicket={setTicket} user={user} go={go} />;
}

export function TicketPages({ route, api, user, go, me }: { route: TicketRoute; api: Api; user: User; go: (p: string) => void; me?: ReactNode }) {
  if (route.view === "new") return <NewTicket user={user} go={go} me={me} />;
  if (route.view === "mine" || (route.view === "inbox" && user.role === "requester")) return <TicketMine user={user} go={go} me={me} />;
  if (route.view === "inbox") return <Inbox api={api} user={user} go={go} me={me} />;
  return <TicketByKey key={route.key} api={api} k={route.key} user={user} go={go} />;
}
