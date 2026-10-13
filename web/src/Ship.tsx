/** 승인 뒤 파이프라인 한 줄: PR #512 → CI 3/3 → main 병합 → 배포 (production). 대기는 흐리게, 통과는 초록, 실패는 빨강. */
import type { Ship } from "./api";
import { IconCheck, IconX } from "./icons";

type State = "todo" | "now" | "done" | "fail";

export function shipSteps(ship: Ship, base: string): { id: string; label: string; state: State; href?: string }[] {
  const checks = ship.checks ?? [];
  const pass = checks.filter((c) => c.state === "pass").length;
  const anyFail = checks.some((c) => c.state === "fail");
  const merged = ship.stage === "merged" || ship.stage === "deploying" || ship.stage === "deployed" || ship.stage === "deploy_failed";
  const ciDone = merged || (checks.length > 0 && pass === checks.length);
  const prFailed = ship.stage === "ci_failed" && !ship.prNumber;
  const steps: { id: string; label: string; state: State; href?: string }[] = [
    { id: "pr", label: ship.prNumber ? `PR #${ship.prNumber}` : "PR 만드는 중", state: prFailed ? "fail" : ship.prNumber ? "done" : "now", href: ship.prUrl },
    {
      id: "ci",
      label: checks.length ? `CI ${pass}/${checks.length}` : "CI",
      state: anyFail || (ship.stage === "ci_failed" && !!ship.prNumber) ? "fail" : ciDone ? "done" : ship.prNumber ? "now" : "todo",
    },
    { id: "merge", label: `${base} 병합`, state: merged ? "done" : "todo" },
  ];
  if (ship.env)
    steps.push({ id: "deploy", label: `배포 (${ship.env})`, state: ship.stage === "deployed" ? "done" : ship.stage === "deploy_failed" ? "fail" : ship.stage === "deploying" ? "now" : "todo" });
  return steps;
}

export function ShipRow({ ship, base = "main" }: { ship: Ship; base?: string }) {
  const steps = shipSteps(ship, base);
  return (
    <ol className="ship-row" aria-label="배포 단계">
      {steps.map((s, i) => {
        const body = (
          <>
            {s.state === "done" ? <IconCheck size={12} /> : s.state === "fail" ? <IconX size={12} /> : null}
            {s.label}
          </>
        );
        return (
          <li key={s.id} className={`ship-step ${s.state}`}>
            {s.href ? (
              <a href={s.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                {body}
              </a>
            ) : (
              <span>{body}</span>
            )}
            {i < steps.length - 1 ? <span className="arrow" aria-hidden>→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
