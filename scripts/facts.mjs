// Run the test suite and print facts.json (version, commit, date, test counts). `--out <file>` writes it to a file.
// The portfolio reads only this file, so numbers are never copied by hand. Exits non-zero if any test fails.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1] : undefined;
if (i > 0 && !out) {
  console.error("--out 뒤에 파일 경로가 필요해요");
  process.exit(2);
}

const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(git("log", "-1", "--format=%cI")));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// vitest output goes to stderr so stdout stays clean JSON
const tmp = mkdtempSync(join(tmpdir(), "willnew-facts-"));
const report = join(tmp, "vitest.json");
const run = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json", `--outputFile=${report}`],
  { cwd: root, stdio: ["ignore", 2, 2] });
let r;
try {
  r = JSON.parse(readFileSync(report, "utf8"));
} catch {
  console.error(`vitest 결과 파일을 읽지 못했어요 (종료 코드 ${run.status})`);
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const tests = { passed: r.numPassedTests, failed: r.numFailedTests, total: r.numTotalTests, files: r.testResults.length };
if (run.status !== 0 || !r.success || tests.failed > 0) {
  console.error(`테스트 실패: ${tests.failed}/${tests.total} (vitest 종료 코드 ${run.status})`);
  process.exit(1);
}

const json = JSON.stringify({ schema: 1, project: "willnew", version, commit, date, tests }, null, 2) + "\n";
if (out) writeFileSync(resolve(out), json);
else process.stdout.write(json);
