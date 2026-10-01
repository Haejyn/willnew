// Offline stand-in for a coding agent: fixes the bug in math.js and reports like a CLI would.
import { readFileSync, writeFileSync } from "node:fs";
const say = (o) => console.log(JSON.stringify(o));
say({ type: "text", text: "Reading math.js" });
say({ type: "tool", text: "edit math.js" });
writeFileSync("math.js", readFileSync("math.js", "utf8").replace("a - b", "a + b"));
say({ type: "result", text: "Fixed add(): it subtracted instead of adding.", turns: 2, inputTokens: 1200, outputTokens: 80, costUsd: 0.004 });
