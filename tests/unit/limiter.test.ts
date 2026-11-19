import { describe, expect, it } from "vitest";
import { Semaphore, SlidingWindowLimiter } from "../../src/util/limiter.js";

const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

describe("Semaphore", () => {
  it("never runs more than the configured maximum concurrently", async () => {
    const semaphore = new Semaphore(3);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 20 }, () => semaphore.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    })));
    expect(peak).toBe(3);
  });

  it("does not let a new caller take a slot that was handed to a queued waiter", async () => {
    const semaphore = new Semaphore(1);
    let active = 0;
    let peak = 0;
    let completed = 0;
    const gates: Array<() => void> = [];
    const operation = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active--;
      completed++;
    };

    const first = semaphore.run(operation());
    await flush();
    const second = semaphore.run(operation());
    await flush();
    expect(active).toBe(1);

    // Release the holder, then let a brand-new caller arrive in the same turn:
    // it must queue behind the waiter instead of stealing the freed slot.
    gates.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    const third = semaphore.run(operation());

    for (let turn = 0; turn < 20 && completed < 3; turn++) {
      await flush();
      gates.splice(0).forEach((release) => release());
    }
    await Promise.all([first, second, third]);

    expect(completed).toBe(3);
    expect(peak).toBe(1);
  });

  it("releases the slot when the operation rejects", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("SlidingWindowLimiter", () => {
  it("rejects work above the window budget and recovers after the window", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 1000, () => now);
    limiter.consume();
    limiter.consume();
    expect(() => limiter.consume()).toThrowError(/rate budget/i);
    now = 1001;
    expect(() => limiter.consume()).not.toThrow();
  });
});
