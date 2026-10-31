/**
 * One queue per process for every AI call. `concurrency` jobs run at once, the rest wait in order. Whenever a job's
 * place changes the queue emits ("position", requestId, n): n jobs are ahead of it (running ones included), 0 once it
 * starts. Jobs without a requestId wait the same way but emit nothing.
 */
import { EventEmitter } from "node:events";
import type { AiQueue } from "./types.js";

interface Job {
  requestId?: string;
  start: () => void;
  /** the last position emitted, so an unchanged place is not sent again */
  last?: number;
}

export class Queue extends EventEmitter implements AiQueue {
  private waiting: Job[] = [];
  private running = 0;

  constructor(readonly concurrency = 1) {
    super();
    if (!(concurrency >= 1)) this.concurrency = 1;
  }

  size() {
    return this.waiting.length + this.running;
  }

  /** Run `fn` when its turn comes. Its result or error is passed through. */
  run<T>(requestId: string | undefined, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        requestId,
        start: () => {
          this.running++;
          this.tell(job, 0);
          Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            this.running--;
            this.pump();
          });
        },
      };
      this.waiting.push(job);
      this.pump();
    });
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
