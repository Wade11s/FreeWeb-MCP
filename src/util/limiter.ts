import { FreeWebError } from "../errors.js";

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  // The slot is reserved synchronously (or handed over directly on release) so
  // a caller that arrives while a waiter is being woken can never take the slot
  // that was already promised to that waiter.
  private acquire(): Promise<void> {
    if (this.active < this.max && this.waiters.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.waiters.push(resolve); });
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      // Transfer the slot: `active` stays the same because the waiter inherits it.
      waiter();
      return;
    }
    this.active--;
  }
}

export class SlidingWindowLimiter {
  private readonly timestamps: number[] = [];
  constructor(private readonly max: number, private readonly windowMs = 60_000, private readonly now = () => Date.now()) {}
  consume(count = 1): void {
    if (count > this.max) throw new FreeWebError("RATE_LIMITED", "Request exceeds the configured rate budget", { retryable: true, retryAfterMs: this.windowMs });
    const now = this.now();
    while (this.timestamps.length && this.timestamps[0] <= now - this.windowMs) this.timestamps.shift();
    if (this.timestamps.length + count > this.max) {
      const retryAfterMs = Math.max(1, this.timestamps[0] + this.windowMs - now);
      throw new FreeWebError("RATE_LIMITED", "Local provider rate budget exhausted", { retryable: true, retryAfterMs });
    }
    for (let index = 0; index < count; index++) this.timestamps.push(now);
  }
}
