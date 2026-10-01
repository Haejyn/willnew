// Offline stand-in that claims success without changing anything.
console.log(JSON.stringify({ type: "text", text: "Looks fine to me." }));
console.log(JSON.stringify({ type: "result", text: "No change needed.", turns: 1, inputTokens: 900, outputTokens: 20, costUsd: 0.001 }));
