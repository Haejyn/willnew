import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// 테마 = theme.css + icons.ts 가 든 폴더. WILLNEW_THEME_DIR 이 없으면 저장소에 든 공개 기본 테마를 쓴다.
const custom = process.env.WILLNEW_THEME_DIR && resolve(process.env.WILLNEW_THEME_DIR);
if (custom && !existsSync(resolve(custom, "theme.css"))) throw new Error(`WILLNEW_THEME_DIR 에 theme.css 가 없어요: ${custom}`);
const themeDir = custom || resolve(root, "src/theme/public");

export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@theme": themeDir } },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    fs: { allow: [root, themeDir] },
    proxy: {
      "/api": { target: "http://127.0.0.1:7777", changeOrigin: true },
    },
  },
});
