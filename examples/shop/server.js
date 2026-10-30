import { createApp } from "./src/server.js";

function portFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") return argv[i + 1];
    if (arg.startsWith("--port=")) return arg.slice("--port=".length);
  }
  return undefined;
}

const port = Number(portFromArgs(process.argv.slice(2)) ?? process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`포트 값이 잘못됐어요: ${port}`);
  process.exit(1);
}

const server = createApp();
server.listen(port, () => {
  console.log(`shop: http://localhost:${server.address().port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
