import { defineConfig } from "vitest/config";
// every test runs in a temp WILLNEW_HOME (tests/setup/home.ts); the real ~/.willnew is checked after the run (guard.ts)
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], setupFiles: ["tests/setup/home.ts"], globalSetup: ["tests/setup/guard.ts"] } });
