/**
 * Pacing for local Ollama calls (src/server/ai/pace.ts, thermal.ts, queue.ts). No real GPU and no real waiting: the
 * temperature, the sleep and the clock are injected.
 */
import { afterEach, describe, expect, it } from "vitest";
import { currentPace, holdWhileHot, planRest } from "../src/server/ai/pace.js";
import { Queue } from "../src/server/ai/queue.js";
import { __setGpuTempForTest, gpuTempC, restFactor } from "../src/server/ai/thermal.js";

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  process.env.WILLNEW_AI_PACE = "fast";
  __setGpuTempForTest(undefined);
});

describe("planRest", () => {
  it("fast and cloud never rest and drop the carry", () => {
    expect(planRest(5000, 9000, "fast", true)).toEqual({ restMs: 0, carryMs: 0 });
    expect(planRest(5000, 9000, "gentle", false)).toEqual({ restMs: 0, carryMs: 0 });
  });

  it("gentle rests as long as the call worked, plus the carry", () => {
    expect(planRest(4000, 0, "gentle", true)).toEqual({ restMs: 4000, carryMs: 0 });
    expect(planRest(4000, 1500, "gentle", true)).toEqual({ restMs: 5500, carryMs: 0 });
  });

  it("one rest is capped at 30 s and the rest carries, up to 120 s", () => {
    expect(planRest(45_000, 0, "gentle", true)).toEqual({ restMs: 30_000, carryMs: 15_000 });
    expect(planRest(10_000, 15_000, "gentle", true)).toEqual({ restMs: 25_000, carryMs: 0 });
    expect(planRest(400_000, 0, "gentle", true)).toEqual({ restMs: 30_000, carryMs: 120_000 });
  });

  it("a hot GPU doubles the rest and the cap", () => {
    expect(planRest(4000, 0, "gentle", true, 2)).toEqual({ restMs: 8000, carryMs: 0 });
    expect(planRest(45_000, 0, "gentle", true, 2)).toEqual({ restMs: 60_000, carryMs: 30_000 });
  });
});

describe("thermal", () => {
  it("restFactor is 2 from 80°C, 1 below or unknown", () => {
    expect(restFactor(80)).toBe(2);
    expect(restFactor(79)).toBe(1);
    expect(restFactor(undefined)).toBe(1);
  });

  it("an injected temperature replaces nvidia-smi", async () => {
    __setGpuTempForTest(83);
    expect(await gpuTempC()).toBe(83);
    __setGpuTempForTest(null);
    expect(await gpuTempC()).toBeUndefined();
  });
});

describe("holdWhileHot", () => {
  it("waits from 80°C until below 75°C", async () => {
    const temps = [85, 78, 74];
    const state: { hot?: boolean; resting?: boolean } = {};
    const waits: { ms: number; resting?: boolean }[] = [];
    const waited = await holdWhileHot(state, async () => temps.shift(), async (ms) => void waits.push({ ms, resting: state.resting }), 5000);
    expect(waited).toBe(true);
    expect(temps).toEqual([]);
    expect(waits).toEqual([{ ms: 5000, resting: true }]);
    expect(state).toEqual({ hot: true, resting: false });
  });

  it("does not wait when cool or unknown", async () => {
    const wait = async () => { throw new Error("waited"); };
    expect(await holdWhileHot({}, async () => 79, wait)).toBe(false);
    expect(await holdWhileHot({}, async () => undefined, wait)).toBe(false);
  });
});

describe("currentPace", () => {
  it("env first, then config, else gentle", () => {
    process.env.WILLNEW_AI_PACE = "gentle";
    expect(currentPace({ pace: "fast" })).toBe("gentle");
    delete process.env.WILLNEW_AI_PACE;
    expect(currentPace({ pace: "fast" })).toBe("fast");
    expect(currentPace({})).toBe("gentle");
  });
});

describe("queue pacing", () => {
  it("gives a local job's result right away and holds the slot while resting", async () => {
    let clock = 0;
    const rest = gate();
    const rests: number[] = [];
    const q = new Queue(1, { pace: () => "gentle", read: async () => 60, sleep: (ms) => (rests.push(ms), rest.p), now: () => clock });
    const started: string[] = [];
    const a = q.run("a", async () => {
      started.push("a");
      clock += 1200;
      return "a";
    }, { local: true });
    const b = q.run("b", async () => (started.push("b"), "b"), { local: true });
    expect(await a).toBe("a");
    await tick();
    expect(rests).toEqual([1200]);
    expect(started).toEqual(["a"]);
    expect(q.pacing()).toMatchObject({ resting: true, hot: false, maxGpuC: 60 });
    expect(q.size()).toBe(1);
    rest.open();
    expect(await b).toBe("b");
    expect(started).toEqual(["a", "b"]);
    expect(q.pacing().restedMs).toBeGreaterThanOrEqual(1200);
  });

  it("a hot reading after the call doubles the rest; the carry stays on the queue", async () => {
    let clock = 0;
    const rests: number[] = [];
    // read before each call (cool, so no waiting) and after it (hot)
    const temps = [70, 81, 70, 81];
    const q = new Queue(1, { pace: () => "gentle", read: async () => temps.shift(), sleep: async (ms) => void rests.push(ms), now: () => clock });
    await q.run(undefined, async () => { clock += 40_000; }, { local: true });
    await tick();
    expect(rests).toEqual([60_000]);   // 80 s wanted, 60 s cap when hot, 20 s carried
    expect(q.pacing()).toMatchObject({ hot: true, maxGpuC: 81 });
    await q.run(undefined, async () => { clock += 1000; }, { local: true });
    await tick();
    expect(rests).toEqual([60_000, 22_000]);
    expect(q.size()).toBe(0);
  });

  it("fast and non-local jobs never rest or read the GPU", async () => {
    const read = async () => { throw new Error("read"); };
    const sleep = async () => { throw new Error("slept"); };
    const gentle = new Queue(1, { pace: () => "gentle", read, sleep });
    expect(await gentle.run(undefined, async () => 1)).toBe(1);
    const fast = new Queue(1, { pace: () => "fast", read, sleep });
    expect(await fast.run(undefined, async () => 2, { local: true })).toBe(2);
    await tick();
    expect(fast.pacing()).toMatchObject({ resting: false, restedMs: 0 });
  });
});
