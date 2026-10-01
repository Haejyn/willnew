#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const cmd = argv[0] ?? "serve";
if (cmd !== "serve") {
  console.log(`usage: willnew serve [--repo <path>] [--check "<cmd>"] [--preview "<dev server cmd, {port}>"] [--port 7777] [--host 127.0.0.1]`);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}

const repo = resolve(flag("repo", process.cwd())!);
const check = flag("check", "")!;
const preview = flag("preview");
const port = Number(flag("port", "7777"));
const host = flag("host", "127.0.0.1")!;
// Anything beyond localhost (e.g. your phone on the LAN) needs a token: agents can edit code on this machine.
const token = host === "127.0.0.1" || host === "localhost" ? flag("token") : flag("token", randomBytes(12).toString("hex"));

const { app, injectWebSocket } = createApp({ repo, check, token, preview });
const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${token ? `/?token=${token}` : ""}`;
  console.log(`willnew · repo ${repo}${check ? ` · check "${check}"` : ""}${preview ? ` · preview "${preview}"` : ""}`);
  console.log(`open ${url}`);
});
injectWebSocket(server);
