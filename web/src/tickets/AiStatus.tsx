/** 설정의 AI 칸: Ollama 상태와 안내, 모델과 digest, 대기열, 양식 모드. */
import { useEffect, useState } from "react";
import type { AiStatus } from "./api";
import { useTicketApi } from "./parts";

const STATE_KO: Record<AiStatus["state"], string> = { not_installed: "설치 안 됨", stopped: "꺼짐", no_model: "모델 없음", ready: "준비됨" };
const GUIDE: Record<AiStatus["state"], string> = {
  not_installed: "이 PC 에 Ollama 가 없어요. ollama.com 에서 설치하면 AI 가 질문을 만들어요.",
  stopped: "Ollama 가 꺼져 있어요. 앱을 켜거나 터미널에서 ollama serve 를 실행해 주세요.",
  no_model: "받은 모델이 없어요. 터미널에서 ollama pull qwen3:8b 로 받아 주세요.",
  ready: "이 PC 의 Ollama 로 질문과 초안을 만들어요.",
};

export function AiStatusInfo({ open }: { open: boolean }) {
  const tapi = useTicketApi();
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    tapi
      .aiStatus()
      .then((a) => {
        setAi(a);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [tapi, open]);
  if (failed) return <p className="pop-note">AI 상태를 읽지 못했어요.</p>;
  if (!ai) return <div className="skel tk-skel-line" aria-busy />;
  const model = ai.routing?.ask?.model ?? ai.models[0]?.name;
  const digest = ai.models.find((m) => m.name === model)?.digest ?? ai.models[0]?.digest;
  return (
    <section className="tk-ai" aria-label="AI 상태">
      <dl className="pop-info">
        <dt>AI</dt>
        <dd>
          <span className={`st ${ai.state === "ready" ? "ok" : ai.state === "not_installed" ? "" : "warn"}`}>Ollama {STATE_KO[ai.state]}</span>
        </dd>
        {!ai.enabled ? (
          <>
            <dt>방식</dt>
            <dd>양식 모드 (AI 없음)</dd>
          </>
        ) : null}
        {model ? (
          <>
            <dt>모델</dt>
            <dd className="mono">{model}</dd>
          </>
        ) : null}
        {digest ? (
          <>
            <dt>digest</dt>
            <dd className="mono" title={digest}>{digest.replace(/^sha256:/, "").slice(0, 12)}</dd>
          </>
        ) : null}
        <dt>대기열</dt>
        <dd className="mono">{ai.queue ? `${ai.queue}건` : "비어 있음"}</dd>
      </dl>
      <p className="pop-note">{GUIDE[ai.state]}{ai.enabled ? "" : " 그동안은 정해진 질문으로 물어요."}</p>
      {ai.note ? <p className="pop-note st warn">{ai.note}</p> : null}
    </section>
  );
}
