import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactOutput } from "../artifacts/output.js";
import { FreeWebError, errorInfo } from "../errors.js";
import { mergeCrawlPages, uniqueCrawlPages } from "./crawl-pages.js";
import type { CrawlJobAdapter, CrawlJobSnapshot } from "./crawl-job-adapter.js";
import type { CrawlInput, CrawlOutput, CrawlStatusInput } from "../types.js";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_INLINE_TOTAL_CHARS = 100_000;
const DEFAULT_MAX_RETAINED_JOBS = 100;
const REFRESH_FAILED_CODE = "CRAWL_REFRESH_FAILED";
const CHECKPOINT_FILE = "job.json";
const CHECKPOINT_TEMP_PREFIX = "job.tmp.";

interface JobRecord {
  crawlId: string;
  providerJobId: string;
  status: CrawlOutput["status"];
  input: CrawlInput;
  createdAt: string;
  updatedAt: string;
  total: number;
  completed: number;
  pages: CrawlOutput["pages"];
  errors: CrawlOutput["errors"];
  artifactId?: string;
  artifactExpiresAt?: string;
}

export class CrawlManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly stored = new Map<string, string>();
  private readonly warnings = new Map<string, CrawlOutput["errors"]>();
  private readonly refreshFailures = new Map<string, number>();
  private readonly fingerprints = new Map<string, string>();
  private readonly root: string;
  private readonly adapter: CrawlJobAdapter;
  private readonly artifactOutput: ArtifactOutput;
  private readonly pollIntervalMs: number;
  private readonly inlineTotalChars: number;
  private readonly inlinePageChars: number;
  private readonly maxRetainedJobs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly maxJobs: number;
  private starting = 0;
  private closed = false;

  constructor(options: {
    adapter: CrawlJobAdapter;
    root: string;
    output: ArtifactOutput;
    pollIntervalMs?: number;
    inlineTotalChars?: number;
    inlinePageChars?: number;
    maxRetainedJobs?: number;
    retentionMs?: number;
    now?: () => number;
    maxJobs?: number;
  }) {
    this.adapter = options.adapter;
    this.root = join(options.root, "crawls");
    this.artifactOutput = options.output;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.inlineTotalChars = Math.max(0, options.inlineTotalChars ?? DEFAULT_INLINE_TOTAL_CHARS);
    this.inlinePageChars = Math.max(0, options.inlinePageChars ?? 50_000);
    this.maxRetainedJobs = Math.max(0, options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS);
    this.retentionMs = options.retentionMs ?? 86_400_000;
    this.now = options.now ?? Date.now;
    this.maxJobs = options.maxJobs ?? 3;
  }

  async recover(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.root, entry.name);
      await this.removeStaleTemporaries(directory);
      try {
        const job = JSON.parse(await readFile(join(directory, CHECKPOINT_FILE), "utf8")) as JobRecord;
        if (job.status === "scraping") job.status = "lost";
        this.reconcilePages(job);
        await this.finalize(job);
        this.jobs.set(job.crawlId, job);
      } catch {
        // An incomplete checkpoint is not advertised as a valid Crawl Job.
      }
    }
    this.enforceRetentionCap();
  }

  async start(input: CrawlInput): Promise<CrawlOutput> {
    if (this.closed) throw new FreeWebError("CRAWL_MANAGER_CLOSED", "CrawlManager is closed");
    const activeJobs = [...this.jobs.values()].filter((job) => job.status === "scraping").length;
    if (activeJobs + this.starting >= this.maxJobs) throw new FreeWebError("CRAWL_LIMIT_REACHED", "Active Crawl Job budget exhausted", { retryable: true });
    this.starting++;
    let id: string;
    try {
      ({ id } = await this.adapter.startCrawl(input));
    } catch (error) {
      const info = errorInfo(error, "firecrawl-local");
      if (info.code === "UPSTREAM_TIMEOUT_UNCERTAIN") {
        throw new FreeWebError("CRAWL_START_UNCERTAIN", "Crawl start timed out after the provider may have accepted it; an unregistered provider job may remain", {
          provider: "firecrawl-local",
          retryable: false,
          details: { warning: "Firecrawl Local does not expose a job lookup by creation request; inspect or restart the owned serve process before retrying" },
          cause: error,
        });
      }
      throw error;
    } finally {
      this.starting--;
    }
    if (this.closed) {
      await this.adapter.cancelCrawl(id).catch(() => undefined);
      throw new FreeWebError("CRAWL_MANAGER_CLOSED", "CrawlManager closed while the provider start was pending");
    }
    const timestamp = new Date(this.now()).toISOString();
    const job: JobRecord = {
      crawlId: randomUUID(),
      providerJobId: id,
      status: "scraping",
      input,
      createdAt: timestamp,
      updatedAt: timestamp,
      total: 0,
      completed: 0,
      pages: [],
      errors: [],
    };
    try {
      await mkdir(this.directory(job.crawlId), { recursive: true, mode: 0o700 });
      this.jobs.set(job.crawlId, job);
      await this.persist(job);
    } catch (error) {
      this.jobs.delete(job.crawlId);
      this.stored.delete(job.crawlId);
      this.warnings.delete(job.crawlId);
      this.refreshFailures.delete(job.crawlId);
      this.fingerprints.delete(job.crawlId);
      await this.adapter.cancelCrawl(id).catch(() => undefined);
      await rm(this.directory(job.crawlId), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    this.enforceRetentionCap();
    if (this.pollIntervalMs > 0) {
      const timer = setInterval(() => { void this.refresh(job.crawlId).catch(() => undefined); }, this.pollIntervalMs);
      timer.unref();
      this.timers.set(job.crawlId, timer);
    }
    return this.output(job, { crawlId: job.crawlId, offset: 0, limit: 10, maxCharsPerPage: this.inlinePageChars });
  }

  async status(input: CrawlStatusInput): Promise<CrawlOutput> {
    const job = await this.loadJob(input.crawlId);
    if (job.status === "scraping") await this.refresh(job.crawlId);
    return this.output(job, input);
  }

  async cancel(input: { crawlId: string }): Promise<CrawlOutput> {
    const job = await this.loadJob(input.crawlId);
    if (job.status === "scraping") {
      try {
        await this.adapter.cancelCrawl(job.providerJobId);
      } catch (error) {
        const info = errorInfo(error, "firecrawl-local");
        if (!["JOB_NOT_FOUND", "CRAWL_NOT_FOUND", "NOT_FOUND", "HTTP_404"].includes(info.code)) throw error;
      }
      await this.settleRefreshes();
      await this.refresh(job.crawlId, true);
    }
    return this.output(job, { crawlId: job.crawlId, offset: 0, limit: 10, maxCharsPerPage: this.inlinePageChars });
  }

  async cleanup(): Promise<number> {
    const candidates = new Map<string, JobRecord>();
    for (const job of this.jobs.values()) candidates.set(job.crawlId, job);
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || candidates.has(entry.name) || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      try {
        const job = JSON.parse(await readFile(join(this.root, entry.name, CHECKPOINT_FILE), "utf8")) as JobRecord;
        if (job.crawlId === entry.name) candidates.set(entry.name, job);
      } catch {
        // Incomplete checkpoints stay on disk and are not advertised.
      }
    }

    let removed = 0;
    for (const job of candidates.values()) {
      if (job.status !== "scraping" && !job.artifactExpiresAt) {
        const checkpoint = await stat(join(this.directory(job.crawlId), CHECKPOINT_FILE)).catch(() => undefined);
        if (!checkpoint || this.now() - checkpoint.mtimeMs < this.retentionMs) continue;
      } else if (job.status === "scraping" || !job.artifactExpiresAt || Date.parse(job.artifactExpiresAt) > this.now()) {
        continue;
      }
      clearInterval(this.timers.get(job.crawlId));
      this.timers.delete(job.crawlId);
      this.jobs.delete(job.crawlId);
      this.stored.delete(job.crawlId);
      this.warnings.delete(job.crawlId);
      this.refreshFailures.delete(job.crawlId);
      this.fingerprints.delete(job.crawlId);
      await rm(this.directory(job.crawlId), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    // Give in-flight reads a short grace period, then mark active Jobs lost so
    // a slow provider call cannot hold shutdown for its full 30s timeout.
    const grace = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref();
    });
    await Promise.race([this.settleRefreshes(), grace]);
    for (const job of this.jobs.values()) {
      if (job.status === "scraping") {
        job.status = "lost";
        job.updatedAt = new Date(this.now()).toISOString();
        await this.finalize(job);
      }
    }
    await this.settleWrites();
  }

  private async settleRefreshes(): Promise<void> {
    while (this.refreshes.size > 0) await Promise.allSettled([...this.refreshes.values()]);
  }

  private async settleWrites(): Promise<void> {
    const failures: unknown[] = [];
    while (this.writes.size > 0) {
      const results = await Promise.allSettled([...this.writes.values()]);
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError(failures, "One or more Crawl checkpoints could not be persisted");
  }

  private async loadJob(crawlId: string): Promise<JobRecord> {
    const cached = this.jobs.get(crawlId);
    if (cached) return cached;
    const job = await this.readCheckpoint(crawlId);
    this.jobs.set(job.crawlId, job);
    this.enforceRetentionCap();
    return job;
  }

  private async readCheckpoint(crawlId: string): Promise<JobRecord> {
    const directory = this.directory(crawlId);
    let job: JobRecord;
    try {
      job = JSON.parse(await readFile(join(directory, CHECKPOINT_FILE), "utf8")) as JobRecord;
    } catch (error) {
      throw new FreeWebError("CRAWL_NOT_FOUND", "Crawl Job does not exist", { cause: error });
    }
    if (!job || job.crawlId !== crawlId) {
      throw new FreeWebError("CRAWL_NOT_FOUND", "Crawl Job does not exist");
    }
    if (job.status === "scraping") {
      // A checkpoint that is still marked active cannot be resumed after the
      // record left memory, so it is surfaced as lost without re-polling.
      job.status = "lost";
      job.updatedAt = new Date(this.now()).toISOString();
    }
    this.reconcilePages(job);
    if (!job.artifactId) await this.finalize(job);
    return job;
  }

  private requireJob(crawlId: string): JobRecord {
    const job = this.jobs.get(crawlId);
    if (!job) throw new FreeWebError("CRAWL_NOT_FOUND", "Crawl Job does not exist");
    return job;
  }

  private refresh(crawlId: string, force = false): Promise<void> {
    const existing = this.refreshes.get(crawlId);
    if (!force && existing) return existing;
    const pending = this.refreshInner(crawlId).finally(() => {
      if (this.refreshes.get(crawlId) === pending) this.refreshes.delete(crawlId);
    });
    this.refreshes.set(crawlId, pending);
    return pending;
  }

  private async refreshInner(crawlId: string): Promise<void> {
    const job = this.requireJob(crawlId);
    if (job.status !== "scraping" || this.closed) return;

    let snapshot: CrawlJobSnapshot;
    try {
      snapshot = await this.adapter.getCrawl(job.providerJobId);
    } catch (error) {
      // A snapshot that landed while the manager is closing is still applied by
      // close() below; only skip when the job itself already moved on.
      if (job.status !== "scraping") return;
      const info = errorInfo(error, "firecrawl-local");
      if (["JOB_NOT_FOUND", "CRAWL_NOT_FOUND", "NOT_FOUND", "HTTP_404"].includes(info.code)) {
        job.status = "lost";
        job.errors.push({ code: info.code, message: info.message });
        job.updatedAt = new Date(this.now()).toISOString();
        this.warnings.delete(crawlId);
        await this.persist(job);
        clearInterval(this.timers.get(crawlId));
        this.timers.delete(crawlId);
        await this.finalize(job);
        return;
      }
      // Temporary provider failures degrade to the last checkpoint plus a
      // warning; repeated process-level failures become a terminal failed Job.
      const failures = (this.refreshFailures.get(crawlId) ?? 0) + 1;
      this.refreshFailures.set(crawlId, failures);
      this.warnings.set(crawlId, [{
        code: REFRESH_FAILED_CODE,
        message: `${info.code}: ${info.message}`,
      }]);
      if (failures >= 3) {
        job.status = "failed";
        job.errors.push({ code: "CRAWL_PROVIDER_UNAVAILABLE", message: `Provider failed ${failures} consecutive refreshes: ${info.message}` });
        job.updatedAt = new Date(this.now()).toISOString();
        await this.persist(job);
        clearInterval(this.timers.get(crawlId));
        this.timers.delete(crawlId);
        await this.finalize(job);
      }
      return;
    }

    if (job.status !== "scraping") return;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([snapshot.status, snapshot.total, snapshot.completed, snapshot.pages, snapshot.errors]))
      .digest("hex");
    const previousFingerprint = this.fingerprints.get(crawlId);
    const changed = previousFingerprint !== fingerprint;
    this.refreshFailures.delete(crawlId);
    job.status = snapshot.status;
    job.total = snapshot.total;
    job.completed = snapshot.completed;
    job.pages = mergeCrawlPages(job.pages, snapshot.pages);
    job.errors = snapshot.errors.map((error) => ({ ...error }));
    this.reconcilePages(job);
    this.warnings.delete(crawlId);

    // Writing only on real transitions keeps a 1s poll from rewriting a large
    // checkpoint that has not changed.
    try {
      if (changed) {
        job.updatedAt = new Date(this.now()).toISOString();
        await this.persist(job);
      }
      this.fingerprints.set(crawlId, fingerprint);
    } catch (error) {
      if (previousFingerprint) this.fingerprints.set(crawlId, previousFingerprint);
      else this.fingerprints.delete(crawlId);
      throw error;
    }
    if (job.status !== "scraping") {
      clearInterval(this.timers.get(crawlId));
      this.timers.delete(crawlId);
      await this.finalize(job);
    }
  }

  private async output(job: JobRecord, input: CrawlStatusInput): Promise<CrawlOutput> {
    const warnings = this.warnings.get(job.crawlId) ?? [];
    const errors = [...job.errors, ...warnings];
    const preview = await this.artifactOutput.publish({
      kind: "crawl-preview",
      pages: this.outputPages(job),
      offset: input.offset,
      limit: input.limit,
      maxCharsPerPage: input.maxCharsPerPage,
      inlineTotalChars: this.inlineTotalChars,
    });
    const pages = preview.pages;
    return {
      crawlId: job.crawlId,
      providerJobId: job.providerJobId,
      status: job.status,
      total: job.total,
      completed: job.completed,
      offset: input.offset,
      returned: pages.length,
      hasMore: preview.inlineBudgetHit || input.offset + pages.length < job.pages.length,
      pages,
      errors,
      partial: job.status !== "completed" || errors.length > 0,
      artifactId: job.artifactId,
      expiresAt: job.artifactExpiresAt,
    };
  }

  /**
   * Crawl Pages gain the same optional top-level `links` as Fetch Pages when the Job requested
   * the links format. The value is derived from `formats.links` at read time, so checkpoints
   * keep one source and existing consumers keep the older representation.
   */
  private outputPages(job: JobRecord): CrawlOutput["pages"] {
    if (!job.input.formats.includes("links")) return job.pages;
    return job.pages.map((page) => {
      const stored = page.formats.links;
      if (!Array.isArray(stored)) return page;
      const links = stored.filter((link): link is string => typeof link === "string");
      return { ...page, links };
    });
  }

  /**
   * Keeps the stored collection unique and its counts truthful. An active Provider total may
   * stay an upper bound, but a terminal Job reports exactly the unique Pages it exposes and
   * `completed` never exceeds them.
   */
  private reconcilePages(job: JobRecord): void {
    job.pages = uniqueCrawlPages(job.pages);
    const unique = job.pages.length;
    job.completed = Math.min(job.completed, unique);
    job.total = job.status === "scraping" ? Math.max(job.total, unique) : unique;
  }

  private async finalize(job: JobRecord): Promise<void> {
    if (job.artifactId) return;
    const descriptor = await this.artifactOutput.publish({
      kind: "crawl-checkpoint",
      source: { ...job, artifactId: undefined, artifactExpiresAt: undefined },
    });
    job.artifactId = descriptor.id;
    job.artifactExpiresAt = descriptor.expiresAt;
    await this.persist(job);
    // The terminal checkpoint is on disk now; the serialized duplicate only
    // exists to suppress redundant active-job writes.
    this.stored.delete(job.crawlId);
    this.enforceRetentionCap();
  }

  private enforceRetentionCap(): void {
    const terminal = [...this.jobs.values()].filter((job) => job.status !== "scraping");
    let excess = terminal.length - this.maxRetainedJobs;
    if (excess <= 0) return;
    for (const job of terminal) {
      if (excess <= 0) return;
      this.jobs.delete(job.crawlId);
      this.stored.delete(job.crawlId);
      this.warnings.delete(job.crawlId);
      this.refreshFailures.delete(job.crawlId);
      this.fingerprints.delete(job.crawlId);
      clearInterval(this.timers.get(job.crawlId));
      this.timers.delete(job.crawlId);
      excess--;
    }
  }

  private directory(crawlId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(crawlId)) throw new FreeWebError("CRAWL_NOT_FOUND", "Crawl Job does not exist");
    return join(this.root, crawlId);
  }

  private async removeStaleTemporaries(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory); }
    catch { return; }
    await Promise.all(entries
      .filter((name) => name.startsWith(CHECKPOINT_TEMP_PREFIX) && name.endsWith(".json"))
      .map((name) => rm(join(directory, name), { force: true }).catch(() => undefined)));
  }

  private persist(job: JobRecord): Promise<void> {
    const payload = JSON.stringify(job);
    const directory = this.directory(job.crawlId);
    if (this.stored.get(job.crawlId) === payload) return this.writes.get(job.crawlId) ?? Promise.resolve();
    this.stored.set(job.crawlId, payload);
    const previous = this.writes.get(job.crawlId) ?? Promise.resolve();
    const pending = previous.then(
      () => this.writeCheckpoint(directory, payload),
      () => this.writeCheckpoint(directory, payload),
    ).catch((error: unknown) => {
      if (this.stored.get(job.crawlId) === payload) this.stored.delete(job.crawlId);
      throw error;
    });
    const tracked: Promise<void> = pending.finally(() => {
      if (this.writes.get(job.crawlId) === tracked) this.writes.delete(job.crawlId);
    });
    this.writes.set(job.crawlId, tracked);
    return tracked;
  }

  private async writeCheckpoint(directory: string, payload: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Unique temporary name per write: two concurrent writers for the same job
    // can never interleave into one shared scratch file.
    const temporary = join(directory, `${CHECKPOINT_TEMP_PREFIX}${randomUUID()}.json`);
    try {
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, join(directory, CHECKPOINT_FILE));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
