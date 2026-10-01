/**
 * Terminals inside agent worktrees. One shell per worktree, shared by every browser tab that opens it;
 * a new tab gets the recent scrollback first. Uses a real PTY when @lydell/node-pty is available,
 * otherwise a plain piped shell (no line editing, but commands and output work).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const SCROLLBACK = 200_000;

interface Backend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

type PtyModule = typeof import("@lydell/node-pty");
let ptyModule: Promise<PtyModule | null> | null = null;
const loadPty = () => (ptyModule ??= import("@lydell/node-pty").catch(() => null));

const shell = () => (process.platform === "win32" ? process.env.COMSPEC || "powershell.exe" : process.env.SHELL || "bash");

async function openBackend(cwd: string, cols: number, rows: number): Promise<{ backend: Backend; pty: boolean }> {
  const pty = await loadPty();
  const env = { ...process.env, TERM: "xterm-256color", WILLNEW_TERMINAL: "1" } as Record<string, string>;
  if (pty) {
    const p = pty.spawn(shell(), [], { name: "xterm-256color", cols, rows, cwd, env });
    return {
      pty: true,
      backend: {
        write: (d) => p.write(d),
        resize: (c, r) => p.resize(Math.max(2, c), Math.max(2, r)),
        kill: () => p.kill(),
        onData: (cb) => void p.onData(cb),
        onExit: (cb) => void p.onExit((e) => cb(e.exitCode)),
      },
    };
  }
  const child = spawn(shell(), process.platform === "win32" ? [] : ["-i"], { cwd, env, windowsHide: true });
  return {
    pty: false,
    backend: {
      write: (d) => child.stdin.write(d.replace(/\r/g, "\n")),
      resize: () => undefined,
      kill: () => child.kill(),
      onData: (cb) => {
        child.stdout.on("data", (b: Buffer) => cb(b.toString("utf8")));
        child.stderr.on("data", (b: Buffer) => cb(b.toString("utf8")));
      },
      onExit: (cb) => void child.on("close", cb),
    },
  };
}

export class Terminal {
  private buffer = "";
  private listeners = new Set<(d: string) => void>();
  private exitListeners = new Set<() => void>();
  alive = true;
  constructor(readonly backend: Backend, readonly pty: boolean) {
    backend.onData((d) => {
      this.buffer = (this.buffer + d).slice(-SCROLLBACK);
      for (const l of this.listeners) l(d);
    });
    backend.onExit(() => {
      this.alive = false;
      for (const l of this.exitListeners) l();
    });
  }
  get scrollback() {
    return this.buffer;
  }
  subscribe(onData: (d: string) => void, onExit: () => void) {
    this.listeners.add(onData);
    this.exitListeners.add(onExit);
    return () => {
      this.listeners.delete(onData);
      this.exitListeners.delete(onExit);
    };
  }
}

export class Terminals {
  private open = new Map<string, Promise<Terminal>>();

  /** The shell for `key` (an agent id), started in `cwd` on first use. */
  async get(key: string, cwd: string, cols = 100, rows = 30): Promise<Terminal> {
    const cur = this.open.get(key);
    if (cur) {
      const t = await cur;
      if (t.alive) return t;
    }
    if (!existsSync(cwd)) throw new Error("작업 공간(워크트리)이 없어요");
    const next = openBackend(cwd, cols, rows).then(({ backend, pty }) => new Terminal(backend, pty));
    this.open.set(key, next);
    return next;
  }

  close(key: string) {
    const cur = this.open.get(key);
    this.open.delete(key);
    void cur?.then((t) => t.backend.kill());
  }

  closeAll() {
    for (const k of [...this.open.keys()]) this.close(k);
  }
}
