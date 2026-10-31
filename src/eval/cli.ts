/**
 * `pnpm eval [--ai fake|ollama|none] [--out docs/eval/<날짜>.md] [--golden tests/golden]`
 *
 * --ai 는 쉼표로 여럿 줄 수 있다 (`--ai none,fake`). 둘 이상이면 문서 앞에 비교표가 붙는다. 기본은 fake.
 * 티켓과 가린 값은 임시 WILLNEW_HOME 에 쓰고 지운다. ollama 는 실제 설정(~/.willnew/config.json 의 ai.routing)을 쓴다.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAi, type Ai } from "../server/ai/index.js";
import { loadGolden } from "./golden.js";
import { reportMarkdown, type AiMode, type EvalRun } from "./run.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODES: AiMode[] = ["none", "fake", "ollama"];

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function main(args: string[]): Promise<number> {
  const modes = (arg(args, "--ai") ?? "fake").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const bad = modes.filter((m) => !MODES.includes(m as AiMode));
  if (bad.length || !modes.length) {
    console.error(`--ai 는 ${MODES.join(", ")} 중에서 골라 주세요 (받은 값: ${bad.join(", ") || "없음"})`);
    return 2;
  }
  const cases = loadGolden(resolve(ROOT, arg(args, "--golden") ?? "tests/golden"));

  // ollama 는 실제 설정과 키를 읽어야 해서 홈을 바꾸기 전에 만든다
  let ollama: { ai: Ai; model?: string } | undefined;
  if (modes.includes("ollama")) {
    const ai = createAi();
    const s = await ai.status();
    if (s.state !== "ready" || !s.enabled) {
      console.error("Ollama 가 꺼져 있어요");
      console.error(`상태: ${s.state}${s.state === "ready" && !s.enabled ? " (설정에서 AI 를 껐어요)" : ""}`);
      return 1;
    }
    ollama = { ai, model: s.routing.extract?.model };
  }

  const home = mkdtempSync(join(tmpdir(), "willnew-eval-"));
  process.env.WILLNEW_HOME = home;
  process.env.WILLNEW_TRIAGE = "rules";
  const { runEval } = await import("./run.js");
  const runs: EvalRun[] = [];
  try {
    for (const mode of modes as AiMode[]) runs.push(await runEval({ mode, cases, root: ROOT, ai: mode === "ollama" ? ollama?.ai : undefined, model: ollama?.model }));
  } finally {
    // 열린 저장소 파일 때문에 Windows 에서 못 지울 수 있다. 임시 폴더라 남아도 된다
    try {
      rmSync(home, { recursive: true, force: true });
    } catch { /* 그대로 둔다 */ }
  }

  const md = reportMarkdown(runs, today());
  process.stdout.write(md);
  const out = arg(args, "--out");
  if (out) {
    const file = resolve(ROOT, out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, md);
    console.error(`\n${out} 에 저장했어요`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
