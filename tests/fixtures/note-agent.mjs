// Offline agent that remembers its session: fixes add(), writes what it was asked into NOTES.md.
// A task containing SLOW keeps the first turn busy, so a follow-up can interrupt it.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [prompt = "", flag, sid] = process.argv.slice(2);
const say = (o) => console.log(JSON.stringify(o));
const resumed = flag === "--resume";
say({ type: "session", id: resumed ? sid : "sess-1" });
say({ type: "text", text: resumed ? `resuming ${sid}` : "starting" });
if (prompt.includes("SLOW") && !resumed) await new Promise((r) => setTimeout(r, 8000));
writeFileSync("math.js", readFileSync("math.js", "utf8").replace("a - b", "a + b"));
const asked = prompt.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).join(" | ") || "task";
appendFileSync("NOTES.md", `${resumed ? `resumed ${sid}` : "first"}: ${asked}\n`);
appendFileSync("PROMPTS.log", `${prompt}\n---\n`);
say({ type: "result", text: resumed ? `followed up: ${asked}` : "fixed add()", turns: 1, costUsd: 0.001 });
