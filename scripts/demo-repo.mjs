// Copy examples/duration into a fresh git repo (default: <tmp>/willnew-demo-<n>) and print its path.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../examples/duration");
const dest = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "willnew-demo-"));
cpSync(src, dest, { recursive: true });
const git = (...a) => execFileSync("git", ["-C", dest, ...a], { stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=willnew", "-c", "user.email=willnew@localhost", "commit", "-q", "-m", "duration: failing tests");
console.log(dest);
