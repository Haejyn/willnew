// Offline agent that only gets it right after seeing the verifier's output (tests self-correction).
import { readFileSync, writeFileSync } from "node:fs";
const prompt = process.argv[2] ?? "";
const say = (o) => console.log(JSON.stringify(o));
if (!prompt.includes("verification command")) {
  writeFileSync("math.js", readFileSync("math.js", "utf8").replace("a - b", "a + b + 1"));   // wrong first try
  say({ type: "result", text: "Changed add().", turns: 1, inputTokens: 500, outputTokens: 30, costUsd: 0.002 });
} else {
  say({ type: "text", text: "The check says 2+3 gave 6 — removing the stray +1." });
  writeFileSync("math.js", readFileSync("math.js", "utf8").replace("a + b + 1", "a + b"));
  say({ type: "result", text: "Fixed after reading the failing test.", turns: 1, inputTokens: 700, outputTokens: 40, costUsd: 0.003 });
}
