/**
 * One queue per process for every AI call. `concurrency` jobs run at once, the rest wait in order. Whenever a job's
 * place changes the queue emits ("position", requestId, n): n jobs are ahead of it (running ones included), 0 once it
 * starts. Jobs without a requestId wait the same way but emit nothing.
 *
 * Jobs marked local (a call to Ollama on this machine) are paced (pace.ts): in "gentle" a job first waits while the GPU
 * is hot, and after it the queue keeps the slot for the planned rest. The job's result goes back right away; only the
 * next job waits. The carried-over rest belongs to the queue.
 */
import { EventEmitter } from "node:events";
import { holdWhileHot, planRest, sleep, type AiPace } from "./pace.js";
import { gpuTempC, restFactor } from "./thermal.js";
import type { AiQueue, PaceStats } from "./types.js";

interface Job {
  requestId?: string;
  start: () => void;
  /** the last position emitted, so an unchanged place is not sent again */
  last?: number;
}

/** What pacing reads and waits with. Tests swap these so no real GPU or clock is involved. */
export interface QueuePacing {
  pace: () => AiPace | Promise<AiPace>;
  read?: () => Promise<number | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class Queue extends EventEmitter implements AiQueue {
  private waiting: Job[] = [];
  private running = 0;
  /** running slots that are only resting */
  private restingSlots = 0;
  private carryMs = 0;
  private stats: PaceStats = { resting: false, hot: false, restedMs: 0 };
  private holding = { hot: false, resting: false };

  constructor(readonly concurrency = 1, private readonly pacer?: QueuePacing) {
    super();
    if (!(concurrency >= 1)) this.concurrency = 1;
  }

  size() {
    return this.waiting.length + this.running - this.restingSlots;
  }

  pacing(): PaceStats {
    return { ...this.stats, resting: this.restingSlots > 0 || this.holding.resting, hot: this.stats.hot || this.holding.hot };
  }

  /** Run `fn` when its turn comes. Its result or error is passed through. `local` paces it. */
  run<T>(requestId: string | undefined, fn: () => Promise<T>, o: { local?: boolean } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        requestId,
        start: () => {
          this.running++;
          this.tell(job, 0);
          const paced = o.local && this.pacer ? this.pacer : undefined;
          (paced ? this.paced(paced, fn, resolve, reject) : Promise.resolve().then(fn).then(resolve, reject)).finally(() => {
            this.running--;
            this.pump();
          });
        },
      };
      this.waiting.push(job);
      this.pump();
    });
  }

  private async paced<T>(p: QueuePacing, fn: () => Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void) {
    const now = p.now ?? Date.now;
    const wait = p.sleep ?? sleep;
    const read = async () => {
      let c: number | undefined;
      try {
        c = await (p.read ?? gpuTempC)();
      } catch { /* unknown */ }
      if (c !== undefined) this.stats.maxGpuC = Math.max(this.stats.maxGpuC ?? c, c);
      return c;
    };
    let pace: AiPace = "gentle";
    try {
      pace = await p.pace();
    } catch { /* gentle */ }
    if (pace === "gentle") {
      const t0 = now();
      this.holding = { hot: false, resting: false };
      if (await holdWhileHot(this.holding, read, wait)) this.stats.restedMs += now() - t0;
      this.stats.hot = this.holding.hot;
      this.holding = { hot: false, resting: false };
    }
    const t0 = now();
    await Promise.resolve().then(fn).then(resolve, reject);
    const workMs = now() - t0;
    const factor = pace === "gentle" ? restFactor(await read()) : 1;
    const plan = planRest(workMs, this.carryMs, pace, true, factor);
    this.carryMs = plan.carryMs;
    this.stats.hot = factor > 1;
    if (plan.restMs <= 0) return;
    this.restingSlots++;
    try {
      await wait(plan.restMs);
      this.stats.restedMs += plan.restMs;
    } finally {
      this.restingSlots--;
    }
  }

  private tell(job: Job, n: number) {
    if (job.requestId === undefined || job.last === n) return;
    job.last = n;
    this.emit("position", job.requestId, n);
  }

  private pump() {
    while (this.running < this.concurrency && this.waiting.length) this.waiting.shift()!.start();
    this.waiting.forEach((job, i) => this.tell(job, this.running + i));
  }
}
