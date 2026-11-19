import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { CrawlManager } from "../../src/crawl/crawl-manager.js";
import { FreeWebError } from "../../src/errors.js";
import type { CrawlProviderSnapshot, FirecrawlAdapter } from "../../src/providers/interfaces.js";
import { crawlInputSchema } from "../../src/types.js";

class FakeFirecrawl implements FirecrawlAdapter {
  readonly name = "firecrawl-local" as const;
  nextId = "provider-job-1";
  snapshot: CrawlProviderSnapshot = { status: "scraping", total: 0, completed: 0, pages: [], errors: [] };
  starts: unknown[] = [];
  cancelled: string[] = [];
  reads = 0;
  getError?: unknown;
  cancelError?: unknown;

  async startCrawl(input: unknown) { this.starts.push(input); return { id: this.nextId }; }
  async getCrawl(_id: string) { this.reads++; if (this.getError) throw this.getError; return this.snapshot; }
  async cancelCrawl(id: string) {
    this.cancelled.push(id);
    if (this.cancelError) throw this.cancelError;
    this.snapshot = { ...this.snapshot, status: "cancelled" };
  }
  async fetch(): Promise<never> { throw new Error("not used"); }
  async map(): Promise<never> { throw new Error("not used"); }
  async close() {}
}

let root: string;
let adapter: FakeFirecrawl;
let manager: CrawlManager;
let artifacts: ArtifactStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-crawl-"));
  adapter = new FakeFirecrawl();
  artifacts = new ArtifactStore({ root });
  manager = new CrawlManager({
    adapter,
    root,
    artifacts,
    pollIntervalMs: 0,
  });
  await manager.recover();
});

afterEach(async () => {
  await manager.close();
  await rm(root, { recursive: true, force: true });
});

describe("CrawlManager public seam", () => {
  it("starts an asynchronous Crawl Job and persists its provider ID", async () => {
    const input = crawlInputSchema.parse({ url: "https://example.com/docs" });
    const started = await manager.start(input);

    expect(started.crawlId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.providerJobId).toBe("provider-job-1");
    expect(started.status).toBe("scraping");
    expect(adapter.starts).toEqual([input]);

    const status = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 50_000 });
    expect(status.status).toBe("scraping");
    expect(adapter.reads).toBeGreaterThan(0);
  });

  it("checkpoints completed pages, paginates output and preserves full text in an Artifact", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "completed",
      total: 2,
      completed: 2,
      pages: [
        { url: "https://example.com/a", formats: { markdown: "a".repeat(200) } },
        { url: "https://example.com/b", formats: { markdown: "second page" } },
      ],
      errors: [],
    };

    const first = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 1, maxCharsPerPage: 100 });
    expect(first.status).toBe("completed");
    expect(first.partial).toBe(false);
    expect(first.returned).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.pages[0].formats.markdown).toBe("a".repeat(100));
    expect(first.pages[0].truncated).toBe(true);
    expect(first.artifactId).toBeDefined();

    const second = await manager.status({ crawlId: started.crawlId, offset: 1, limit: 1, maxCharsPerPage: 100 });
    expect(second.pages[0].url).toBe("https://example.com/b");
    expect(second.hasMore).toBe(false);

    const artifact = JSON.parse(await artifacts.readText(first.artifactId!));
    expect(artifact.pages[0].formats.markdown).toBe("a".repeat(200));
  });

  it("cancels an active provider job and exposes the cancelled checkpoint", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));

    const cancelled = await manager.cancel({ crawlId: started.crawlId });

    expect(adapter.cancelled).toEqual(["provider-job-1"]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.partial).toBe(true);
    expect(cancelled.artifactId).toBeDefined();
  });

  it("marks an interrupted job lost after restart without resuming provider polling", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "scraping",
      total: 1,
      completed: 1,
      pages: [{ url: "https://example.com/partial", formats: { markdown: "checkpoint" } }],
      errors: [],
    };
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    const readsBeforeRestart = adapter.reads;

    manager = new CrawlManager({ adapter, root, artifacts, pollIntervalMs: 0 });
    await manager.recover();
    const recovered = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });

    expect(recovered.status).toBe("lost");
    expect(recovered.pages[0].formats.markdown).toBe("checkpoint");
    expect(recovered.partial).toBe(true);
    expect(recovered.artifactId).toBeDefined();
    expect(adapter.reads).toBe(readsBeforeRestart);
  });

  it("rejects work above the active Crawl Job budget before calling the provider", async () => {
    const input = crawlInputSchema.parse({ url: "https://example.com" });
    await manager.start(input);
    await manager.start(input);
    await manager.start(input);
    const callsBeforeRejectedStart = adapter.starts.length;

    await expect(manager.start(input)).rejects.toMatchObject({ code: "CRAWL_LIMIT_REACHED" });
    expect(adapter.starts).toHaveLength(callsBeforeRejectedStart);
  });

  it("removes terminal checkpoints when their Artifact retention expires", async () => {
    let now = 1_000_000;
    artifacts = new ArtifactStore({ root, now: () => now });
    manager = new CrawlManager({ adapter, root, artifacts, pollIntervalMs: 0, now: () => now });
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "completed",
      total: 1,
      completed: 1,
      pages: [{ url: "https://example.com", formats: { markdown: "done" } }],
      errors: [],
    };
    const completed = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    expect(completed.artifactId).toBeDefined();

    now += 86_400_001;
    expect(await manager.cleanup()).toBe(1);
    await expect(manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 }))
      .rejects.toMatchObject({ code: "CRAWL_NOT_FOUND" });
  });

  it("cancels a provider job whose start finishes after manager close", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapter.startCrawl = async (input) => {
      adapter.starts.push(input);
      await gate;
      return { id: "provider-job-1" };
    };
    const starting = manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    await Promise.resolve();
    const closing = manager.close();

    release();
    await closing;
    await expect(starting).rejects.toMatchObject({ code: "CRAWL_MANAGER_CLOSED" });
    expect(adapter.cancelled).toEqual(["provider-job-1"]);
  });

  it("reserves the active-job budget while provider start is still pending", async () => {
    manager = new CrawlManager({ adapter, root, artifacts, pollIntervalMs: 0, maxJobs: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapter.startCrawl = async (input) => {
      adapter.starts.push(input);
      await gate;
      return { id: "provider-job-1" };
    };
    const input = crawlInputSchema.parse({ url: "https://example.com" });
    const first = manager.start(input);
    await Promise.resolve();
    const second = expect(manager.start(input)).rejects.toMatchObject({ code: "CRAWL_LIMIT_REACHED" });

    release();
    await first;
    await second;
    expect(adapter.starts).toHaveLength(1);
  });
});

describe("CrawlManager hardening", () => {
  const jobPath = (crawlId: string) => join(root, "crawls", crawlId, "job.json");

  it("caps total inline characters per status response and defers the rest to the Artifact", async () => {
    manager = new CrawlManager({ adapter, root, artifacts, pollIntervalMs: 0, inlineTotalChars: 250 });
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "completed",
      total: 3,
      completed: 3,
      pages: [0, 1, 2].map((index) => ({
        url: `https://example.com/${index}`,
        formats: { markdown: String(index).repeat(200) },
      })),
      errors: [],
    };

    const first = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 500_000 });
    const inlineChars = first.pages.reduce((total, page) => total + String(page.formats.markdown ?? "").length, 0);

    expect(inlineChars).toBeLessThanOrEqual(250);
    expect(first.returned).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.artifactId).toBeDefined();
    expect(first.pages[1].truncated).toBe(true);

    const artifact = JSON.parse(await artifacts.readText(first.artifactId!));
    expect(artifact.pages.map((page: { formats: { markdown: string } }) => page.formats.markdown.length))
      .toEqual([200, 200, 200]);

    const second = await manager.status({ crawlId: started.crawlId, offset: 1, limit: 1, maxCharsPerPage: 500_000 });
    expect(second.returned).toBe(1);
    expect(second.pages[0].formats.markdown).toBe("1".repeat(200));
    expect(second.hasMore).toBe(true);

    const last = await manager.status({ crawlId: started.crawlId, offset: 2, limit: 1, maxCharsPerPage: 500_000 });
    expect(last.hasMore).toBe(false);
    expect(last.pages[0].formats.markdown).toBe("2".repeat(200));
  });

  it("does not exceed the inline budget even for the default start checkpoint", async () => {
    manager = new CrawlManager({ adapter, root, artifacts, pollIntervalMs: 0, inlineTotalChars: 1000 });
    adapter.snapshot = {
      status: "scraping",
      total: 100,
      completed: 100,
      pages: Array.from({ length: 100 }, (_, index) => ({
        url: `https://example.com/${index}`,
        formats: { markdown: "z".repeat(5000) },
      })),
      errors: [],
    };
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    const out = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 100, maxCharsPerPage: 500_000 });
    const inlineChars = out.pages.reduce((total, page) => total + String(page.formats.markdown ?? "").length, 0);

    expect(inlineChars).toBeLessThanOrEqual(1000);
    expect(out.returned).toBe(1);
    expect(out.hasMore).toBe(true);
    expect(out.partial).toBe(true);
  });

  it("waits for an in-flight refresh so close finalizes the latest snapshot", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapter.getCrawl = async () => {
      await gate;
      return {
        status: "scraping",
        total: 1,
        completed: 1,
        pages: [{ url: "https://example.com/late", formats: { markdown: "late page" } }],
        errors: [],
      };
    };

    const pending = manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = manager.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await closing;
    await pending;

    const checkpoint = JSON.parse(await readFile(jobPath(started.crawlId), "utf8"));
    expect(checkpoint.status).toBe("lost");
    expect(checkpoint.pages[0].formats.markdown).toBe("late page");
    expect(checkpoint.artifactId).toBeDefined();
    expect((await readdir(join(root, "crawls", started.crawlId))).sort()).toEqual(["job.json"]);
  });

  it("keeps checkpoints parseable under concurrent refreshes and finalization", async () => {
    manager = new CrawlManager({ adapter, root, artifacts, pollIntervalMs: 0, inlineTotalChars: 1000 });
    const jobs = [];
    for (let index = 0; index < 3; index++) {
      adapter.snapshot = { status: "scraping", total: 0, completed: 0, pages: [], errors: [] };
      jobs.push(await manager.start(crawlInputSchema.parse({ url: `https://example.com/${index}` })));
    }
    adapter.snapshot = {
      status: "completed",
      total: 50,
      completed: 50,
      pages: Array.from({ length: 50 }, (_, index) => ({
        url: `https://example.com/p${index}`,
        formats: { markdown: "y".repeat(500) },
      })),
      errors: [],
    };

    await Promise.all(jobs.map((job) =>
      manager.status({ crawlId: job.crawlId, offset: 0, limit: 5, maxCharsPerPage: 500 })));

    for (const job of jobs) {
      const directory = join(root, "crawls", job.crawlId);
      expect((await readdir(directory)).sort()).toEqual(["job.json"]);
      const checkpoint = JSON.parse(await readFile(join(directory, "job.json"), "utf8"));
      expect(checkpoint.status).toBe("completed");
      expect(checkpoint.pages).toHaveLength(50);
      expect(checkpoint.artifactId).toBeDefined();
    }
  });

  it("does not rewrite the checkpoint when a poll observes no change", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "scraping",
      total: 1,
      completed: 1,
      pages: [{ url: "https://example.com", formats: { markdown: "same" } }],
      errors: [],
    };
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    const before = await stat(jobPath(started.crawlId));

    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });

    const after = await stat(jobPath(started.crawlId));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(adapter.reads).toBe(3);
  });

  it("writes the checkpoint again once the snapshot changes", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "scraping",
      total: 2,
      completed: 1,
      pages: [{ url: "https://example.com/a", formats: { markdown: "one" } }],
      errors: [],
    };
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    const before = JSON.parse(await readFile(jobPath(started.crawlId), "utf8"));

    adapter.snapshot = {
      status: "scraping",
      total: 2,
      completed: 2,
      pages: [
        { url: "https://example.com/a", formats: { markdown: "one" } },
        { url: "https://example.com/b", formats: { markdown: "two" } },
      ],
      errors: [],
    };
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    const after = JSON.parse(await readFile(jobPath(started.crawlId), "utf8"));

    expect(before.pages).toHaveLength(1);
    expect(after.pages).toHaveLength(2);
    expect(after.completed).toBe(2);
  });

  it("restores an evicted terminal checkpoint from disk on demand", async () => {
    manager = new CrawlManager({ adapter, root, artifacts, pollIntervalMs: 0, maxRetainedJobs: 1 });
    adapter.snapshot = {
      status: "completed",
      total: 1,
      completed: 1,
      pages: [{ url: "https://example.com/first", formats: { markdown: "first checkpoint" } }],
      errors: [],
    };
    const first = await manager.start(crawlInputSchema.parse({ url: "https://example.com/first" }));
    await manager.status({ crawlId: first.crawlId, offset: 0, limit: 10, maxCharsPerPage: 1000 });

    adapter.snapshot = {
      status: "completed",
      total: 1,
      completed: 1,
      pages: [{ url: "https://example.com/second", formats: { markdown: "second checkpoint" } }],
      errors: [],
    };
    const second = await manager.start(crawlInputSchema.parse({ url: "https://example.com/second" }));
    await manager.status({ crawlId: second.crawlId, offset: 0, limit: 10, maxCharsPerPage: 1000 });
    const reads = adapter.reads;

    const restored = await manager.status({ crawlId: first.crawlId, offset: 0, limit: 10, maxCharsPerPage: 1000 });
    expect(restored.status).toBe("completed");
    expect(restored.pages[0].formats.markdown).toBe("first checkpoint");
    expect(restored.artifactId).toBeDefined();
    expect(adapter.reads).toBe(reads);
  });

  it("cleans up an evicted checkpoint once its Artifact retention expires", async () => {
    let now = 1_000_000;
    artifacts = new ArtifactStore({ root, now: () => now });
    manager = new CrawlManager({
      adapter, root, artifacts, pollIntervalMs: 0, maxRetainedJobs: 1, now: () => now,
    });
    const completed = async (url: string) => {
      adapter.snapshot = {
        status: "completed",
        total: 1,
        completed: 1,
        pages: [{ url, formats: { markdown: "done" } }],
        errors: [],
      };
      const started = await manager.start(crawlInputSchema.parse({ url }));
      await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
      return started.crawlId;
    };
    const first = await completed("https://example.com/first");
    const second = await completed("https://example.com/second");

    now += 86_400_001;
    expect(await manager.cleanup()).toBe(2);
    await expect(manager.status({ crawlId: first, offset: 0, limit: 10, maxCharsPerPage: 100 }))
      .rejects.toMatchObject({ code: "CRAWL_NOT_FOUND" });
    await expect(manager.status({ crawlId: second, offset: 0, limit: 10, maxCharsPerPage: 100 }))
      .rejects.toMatchObject({ code: "CRAWL_NOT_FOUND" });
  });

  it("returns the last checkpoint with a warning when a refresh temporarily fails", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "scraping",
      total: 3,
      completed: 1,
      pages: [{ url: "https://example.com/a", formats: { markdown: "checkpoint" } }],
      errors: [],
    };
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });

    adapter.getCrawl = async () => { throw new Error("upstream 502"); };
    const degraded = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });

    expect(degraded.status).toBe("scraping");
    expect(degraded.pages[0].formats.markdown).toBe("checkpoint");
    expect(degraded.partial).toBe(true);
    expect(degraded.errors.some((error) => error.code === "CRAWL_REFRESH_FAILED")).toBe(true);
    const checkpoint = JSON.parse(await readFile(jobPath(started.crawlId), "utf8"));
    expect(checkpoint.pages[0].formats.markdown).toBe("checkpoint");
    expect(checkpoint.errors).toEqual([]);
  });

  it("marks a vanished provider job lost instead of degrading", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.getCrawl = async () => { throw new FreeWebError("JOB_NOT_FOUND", "provider forgot the job"); };

    const lost = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });

    expect(lost.status).toBe("lost");
    expect(lost.partial).toBe(true);
    expect(lost.errors.some((error) => error.code === "JOB_NOT_FOUND")).toBe(true);
  });

  it("maps the provider's generic NOT_FOUND code to lost", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.getError = new FreeWebError("NOT_FOUND", "missing provider job");

    const lost = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    expect(lost.status).toBe("lost");
    expect(lost.artifactId).toBeDefined();
  });

  it("cancels the provider job and removes local state when initial checkpoint persistence fails", async () => {
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    manager = new CrawlManager({ adapter, root: blocked, artifacts, pollIntervalMs: 0 });

    await expect(manager.start(crawlInputSchema.parse({ url: "https://example.com" }))).rejects.toBeDefined();
    expect(adapter.cancelled).toEqual(["provider-job-1"]);
    expect(adapter.starts).toHaveLength(1);
  });

  it("refreshes after cancellation instead of returning a pre-cancel snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    let notifyRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { notifyRead = resolve; });
    adapter.getCrawl = async () => {
      reads++;
      if (reads === 1) {
        const stale = adapter.snapshot;
        notifyRead();
        await gate;
        return stale;
      }
      return adapter.snapshot;
    };
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    const earlyStatus = manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    await readStarted;

    const cancelling = manager.cancel({ crawlId: started.crawlId });
    release();
    const cancelled = await cancelling;
    await earlyStatus;
    expect(cancelled.status).toBe("cancelled");
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("keeps crawl_cancel idempotent when the provider job is already gone", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.cancelError = new FreeWebError("NOT_FOUND", "already deleted");
    adapter.getError = new FreeWebError("NOT_FOUND", "already deleted");

    const cancelled = await manager.cancel({ crawlId: started.crawlId });
    expect(cancelled.status).toBe("lost");
    expect(cancelled.artifactId).toBeDefined();
  });

  it("marks a job failed after three consecutive provider refresh failures", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.getError = new FreeWebError("FIRECRAWL_PROCESS_DEAD", "serve exited");

    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    const failed = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });

    expect(failed.status).toBe("failed");
    expect(failed.errors.some((error) => error.code === "CRAWL_PROVIDER_UNAVAILABLE")).toBe(true);
    expect(failed.artifactId).toBeDefined();
    const reads = adapter.reads;
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    expect(adapter.reads).toBe(reads);
  });

  it("merges paginated snapshots without dropping earlier pages", async () => {
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "scraping",
      total: 1,
      completed: 1,
      pages: [{ url: "https://example.com/a", formats: { markdown: "page A" } }],
      errors: [],
    };
    await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    adapter.snapshot = {
      status: "completed",
      total: 2,
      completed: 2,
      pages: [{ url: "https://example.com/b", formats: { markdown: "page B" } }],
      errors: [],
    };

    const completed = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 });
    expect(completed.pages.map((page) => page.url).sort()).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("counts structured formats toward the total inline budget", async () => {
    manager = new CrawlManager({ adapter, root, artifacts, pollIntervalMs: 0, inlineTotalChars: 100 });
    const started = await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    adapter.snapshot = {
      status: "completed",
      total: 1,
      completed: 1,
      pages: [{
        url: "https://example.com",
        formats: { links: Array.from({ length: 50 }, (_, index) => `https://example.com/${index}`) },
      }],
      errors: [],
    };

    const output = await manager.status({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 50_000 });
    expect(typeof output.pages[0].formats.links).toBe("string");
    expect(output.pages[0].truncated).toBe(true);
    expect(String(output.pages[0].formats.links).length).toBeLessThanOrEqual(100);
    expect(output.artifactId).toBeDefined();
  });

  it("distinguishes an uncertain provider-accepted start from an ordinary start failure", async () => {
    adapter.startCrawl = async (input) => {
      adapter.starts.push(input);
      throw new FreeWebError("UPSTREAM_TIMEOUT_UNCERTAIN", "accepted but timed out");
    };

    await expect(manager.start(crawlInputSchema.parse({ url: "https://example.com" })))
      .rejects.toMatchObject({ code: "CRAWL_START_UNCERTAIN" });
    expect(adapter.starts).toHaveLength(1);
  });

  it("does not advertise a recovered terminal job whose Artifact finalization failed", async () => {
    const crawlId = randomUUID();
    const directory = join(root, "crawls", crawlId);
    await mkdir(directory, { recursive: true });
    const job = {
      crawlId,
      providerJobId: "provider-job-1",
      status: "completed",
      input: crawlInputSchema.parse({ url: "https://example.com" }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      total: 0,
      completed: 0,
      pages: [],
      errors: [],
    };
    await writeFile(join(directory, "job.json"), JSON.stringify(job));
    await writeFile(join(root, "not-a-directory"), "blocked");
    const brokenArtifacts = new ArtifactStore({ root: join(root, "not-a-directory") });
    manager = new CrawlManager({ adapter, root, artifacts: brokenArtifacts, pollIntervalMs: 0 });

    await manager.recover();
    await expect(manager.status({ crawlId, offset: 0, limit: 10, maxCharsPerPage: 100 }))
      .rejects.toBeDefined();
  });

  it("polls at the default multi-second interval rather than eagerly", async () => {
    manager = new CrawlManager({ adapter, root, artifacts });
    await manager.start(crawlInputSchema.parse({ url: "https://example.com" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.reads).toBe(0);
    expect(manager).toBeDefined();
  });
});
