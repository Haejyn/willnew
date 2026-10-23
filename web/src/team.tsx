/**
 * 팀 모드 조각: 허브에 붙은 러너, 내가 맡을게요, 확인 뒤 이어서 작업. 팀 모드가 아니면(혼자 모드, 데모) 아무것도 그리지 않는다.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Api, HeldWork, Request, Run, RunnerInfo } from "./api";
import { Spinner, useToast } from "./ui";
import { relTime, type User } from "./util";

interface TeamState {
  on: boolean;
  runners: RunnerInfo[] | null;
  reload: () => void;
}

const TeamCtx = createContext<TeamState>({ on: false, runners: null, reload: () => undefined });
export const useTeam = () => useContext(TeamCtx);

/** 러너 목록은 5초마다 다시 읽는다 (연결, 슬롯). */
export function TeamProvider({ api, on, children }: { api: Api; on: boolean; children: ReactNode }) {
  const [runners, setRunners] = useState<RunnerInfo[] | null>(null);
  const reload = useCallback(() => {
    if (on && api.runners) api.runners().then(setRunners).catch(() => undefined);
  }, [api, on]);
  useEffect(() => {
    if (!on) return;
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [on, reload]);
  return <TeamCtx.Provider value={{ on, runners, reload }}>{children}</TeamCtx.Provider>;
}

const OPEN_BEFORE_DECISION = new Set(["draft", "clarifying", "spec_ready", "proposed"]);
/** 팀 모드에서 아직 아무도 맡지 않은 요청 */
export const waitingForClaim = (req: Request) => !!req.unclaimed && OPEN_BEFORE_DECISION.has(req.status);

export const myRunners = (runners: RunnerInfo[] | null, user: User) => (runners ?? []).filter((r) => r.owner === user.name);

/** 내가 맡을게요. 내 러너가 둘 이상이면 고르고, 없으면 러너부터 연결하라고 알려 준다. */
export function ClaimButton({ api, req, user, onDone }: { api: Api; req: Request; user: User; onDone?: () => void }) {
  const { on, runners, reload } = useTeam();
  const toast = useToast();
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  if (!on || user.role === "requester" || !waitingForClaim(req) || !runners || !api.claim) return null;
  const mine = myRunners(runners, user);
  if (!mine.length)
    return (
      <p className="t-meta claim-hint">
        러너를 먼저 연결해 주세요. 허브를 띄운 사람에게 <code className="mono">willnew runner-token {user.name}</code> 로 러너 토큰을 받아 내 PC 에서 <code className="mono">willnew runner</code> 를 띄우면 돼요
      </p>
    );
  const live = mine.filter((r) => r.connected);
  const chosen = live.find((r) => r.runnerId === pick)?.runnerId ?? live[0]?.runnerId;
  const go = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      await api.claim!(req.id, chosen);
      toast(req.status === "draft" ? "맡았어요. 내 러너가 정리를 시작해요" : "맡았어요", "ok");
      onDone?.();
    } catch (e) {
      toast((e as Error).message, "err");
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row-btns claim" onClick={(e) => e.stopPropagation()}>
      {live.length > 1 ? (
        <select aria-label="맡을 러너" value={chosen} onChange={(e) => setPick(e.target.value)}>
          {live.map((r) => (
            <option key={r.runnerId} value={r.runnerId}>
              {r.runnerId} ({r.auth === "api" ? "API" : "구독"}, {r.used}/{r.slots})
            </option>
          ))}
        </select>
      ) : null}
      <button className="btn m" disabled={busy || !chosen} onClick={go}>
        {busy ? <Spinner size={12} /> : null}내가 맡을게요
      </button>
      {!live.length ? <span className="t-meta">내 러너가 연결돼 있지 않아요</span> : null}
    </div>
  );
}

const KIND_KO: Record<HeldWork["kind"], string> = { steer: "이어서 지시", comments: "줄 댓글", changes: "다시 봐 주세요" };

/** 구독 러너에 다른 사람이 보낸 후속 작업. 러너 주인이 확인하고 이어서 실행을 눌러야 러너로 간다. */
export function HeldCard({ api, run, user }: { api: Api; run: Run; user: User }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const held = run.held ?? [];
  if (!held.length || !api.releaseHeld) return null;
  const owner = run.runnerOwner;
  const mine = !!owner && owner === user.name;
  const release = async () => {
    setBusy(true);
    try {
      await api.releaseHeld!(run.id);
      toast("이어서 작업해요", "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="held" aria-label="확인 뒤 이어서 작업">
      <div className="held-head">
        <h3 className="sec-t">확인 뒤 이어서 작업</h3>
        <span className="t-meta mono">{held.length}</span>
      </div>
      <ul className="held-list">
        {held.map((h, i) => (
          <li key={i}>
            <span>
              <b>{h.by}</b> {KIND_KO[h.kind]} <span className="t-meta">{relTime(h.at)}</span>
            </span>
            <span className="held-text">{h.text.length > 160 ? `${h.text.slice(0, 159)}…` : h.text}</span>
          </li>
        ))}
      </ul>
      {mine ? (
        <div className="row-btns">
          <button className="btn m" disabled={busy} onClick={release}>
            {busy ? <Spinner size={12} /> : null}이어서 실행
          </button>
          <span className="t-meta">구독 러너라 내가 확인한 일만 내 러너로 가요</span>
        </div>
      ) : (
        <p className="t-meta">{owner ?? "러너 주인"}님 확인 뒤에 이어서 작업해요</p>
      )}
    </section>
  );
}

/** 설정 칸: 내 러너 (연결, 인증 방식, 슬롯, 마지막 연결) */
export function MyRunners({ user }: { user: User }) {
  const { on, runners } = useTeam();
  if (!on) return null;
  const mine = myRunners(runners, user);
  return (
    <section className="my-runners" aria-label="내 러너">
      <span className="lab">내 러너</span>
      {!runners ? (
        <p className="t-meta">불러오는 중</p>
      ) : !mine.length ? (
        <p className="t-meta">
          아직 없어요. <code className="mono">willnew runner-token {user.name}</code> 로 토큰을 받아 띄워 주세요
        </p>
      ) : (
        <ul className="runner-list">
          {mine.map((r) => (
            <li key={r.runnerId}>
              <i className={`dot ${r.connected ? "on" : ""}`} aria-hidden />
              <span className="mono">{r.runnerId}</span>
              <span className="t-meta">
                {r.connected ? "연결됨" : r.problem ?? "끊김"}, {r.auth === "api" ? "API" : r.auth === "subscription" ? "구독" : "인증 모름"}, 슬롯 {r.used}/{r.slots}, 마지막 연결 {relTime(r.lastSeen)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
