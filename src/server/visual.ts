/**
 * 요청자 확인 (B2): open the previews of a passing result and capture before/after pairs.
 * The default uses the per-worktree `--preview` dev server for the branch and a detached worktree of the base commit for
 * main. Tests pass a fake.
 */
import { join } from "node:path";
import type { RunManager } from "./runs.js";
import { ShotService } from "./shots.js";
import type { Run, Screen, ShotPair } from "./types.js";

export interface PreviewSide {
  /** what the browser on this machine opens (capture) */
  local: string;
  /** what people open (--preview-base-url) */
  url: string;
}

export interface Previews {
  before?: PreviewSide;
  after?: PreviewSide;
  localOnly: boolean;
  note?: string;
}

export interface VisualCheck {
  previews(run: Run, agentId: string): Promise<Previews>;
  capture(input: { requestId: string; round: number; screens: Screen[]; mobile: boolean; before?: string; after?: string }): Promise<{ shots: ShotPair[]; note?: string }>;
  /** path of a stored shot for the API, null when unknown */
  file(requestId: string, round: string, name: string): string | null;
}

type Runs = Pick<RunManager, "previewCommand" | "previewLink" | "startPreview" | "startBasePreview">;

export function defaultVisualCheck(runs: Runs, home: string, shots = new ShotService(join(home, "shots"))): VisualCheck {
  return {
    async previews(run, agentId) {
      if (!runs.previewCommand)
        return { localOnly: true, note: "미리보기 명령이 없어 화면을 띄우지 못했어요. 개발자가 serve --preview 로 띄우면 링크와 스크린샷이 붙어요" };
      const notes: string[] = [];
      const side = async (start: () => Promise<{ status: string; port: number }>, what: string): Promise<PreviewSide | undefined> => {
        try {
          const p = await start();
          if (p.status !== "ready") {
            notes.push(`${what} 미리보기가 뜨지 않았어요`);
            return undefined;
          }
          return { local: `http://127.0.0.1:${p.port}`, url: runs.previewLink(p.port).url };
        } catch (e) {
          notes.push(`${what} 미리보기 실패: ${(e as Error).message.slice(0, 120)}`);
          return undefined;
        }
      };
      const [after, before] = await Promise.all([side(() => runs.startPreview(run.id, agentId), "브랜치"), side(() => runs.startBasePreview(run.id), "main")]);
      return { after, before, localOnly: runs.previewLink(0).localOnly, note: notes.join(". ") || undefined };
    },
    capture: (input) => shots.capture(input),
    file: (id, round, name) => shots.file(id, round, name),
  };
}
