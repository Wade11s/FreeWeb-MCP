import type { CrawlInput, FetchInput, FetchPage, MapInput, SearchInput, SearchOutput } from "../types.js";
import { FreeWebError, errorInfo } from "../errors.js";
import {
  startFirecrawlRuntime,
  nodeCommandRunner,
  childProcessEnv,
  type FirecrawlConfig,
  type FirecrawlRuntime,
  type ProcessDeps,
  type CommandRunner,
} from "./firecrawl-process.js";
import type { CrawlProviderPage, CrawlProviderSnapshot, FirecrawlAdapter, SearchProvider } from "./interfaces.js";

const LOCAL = "firecrawl-local" as const;
const SEARCH = "firecrawl-search" as const;

export type FirecrawlProviderDeps = ProcessDeps;

const FETCH_KEYS = [
  "urls", "formats", "onlyMainContent", "includeSelectors", "excludeSelectors",
  "waitForMs", "timeoutMs", "provider", "fallback",
];
const MAP_KEYS = ["url", "limit", "search", "includeSubdomains", "sitemap"];
const CRAWL_KEYS = [
  "url", "limit", "maxDiscoveryDepth", "crawlEntireDomain", "allowSubdomains",
  "allowExternalLinks", "includePaths", "excludePaths", "maxConcurrency", "delayMs",
  "sitemap", "formats", "onlyMainContent", "waitForMs", "timeoutMs",
];
const SEARCH_KEYS = ["query", "limit", "provider", "fallback", "options"];
const SUPPORTED_FETCH_FORMATS = new Set(["markdown", "html", "rawHtml", "links", "screenshot"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Provider links reach MCP output schemas that require absolute URLs, so anything else is dropped. */
function absoluteHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { return undefined; }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
}

function assertKnownKeys(input: unknown, allowed: readonly string[], operation: string, provider: string = LOCAL): void {
  if (!isRecord(input)) throw new FreeWebError("INVALID_INPUT", `${operation} input must be an object`, { provider });
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new FreeWebError("UNSUPPORTED_OPTION", `${operation} does not support: ${unknown.sort().join(", ")}`, {
      provider,
      details: { options: unknown.sort() },
    });
  }
}

function normalizeLinks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: string[] = [];
  for (const item of value) {
    if (typeof item === "string") links.push(item);
    else if (isRecord(item) && typeof item.url === "string") links.push(item.url);
  }
  return links;
}

function normalizeFormats(data: Record<string, unknown>): Record<string, unknown> {
  const formats: Record<string, unknown> = {};
  for (const name of SUPPORTED_FETCH_FORMATS) {
    const value = data[name];
    if (typeof value === "string") formats[name] = value;
  }
  const links = normalizeLinks(data.links);
  if (links) formats.links = links;
  return formats;
}

function normalizeFetchPage(url: string, payload: unknown): FetchPage {
  const envelope = isRecord(payload) ? payload : {};
  const data = isRecord(envelope.data) ? envelope.data : envelope;
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const page: FetchPage = { url, formats: normalizeFormats(data) };
  const links = normalizeLinks(data.links);
  if (links) page.links = links;
  const finalUrl = absoluteHttpUrl(metadata.url ?? metadata.sourceURL ?? data.url);
  if (finalUrl) page.finalUrl = finalUrl;
  if (typeof metadata.title === "string") page.title = metadata.title;
  if (typeof metadata.description === "string") page.description = metadata.description;
  const language = metadata.language ?? metadata.lang;
  if (typeof language === "string") page.language = language;
  return page;
}

function assertRegexStrings(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new FreeWebError("INVALID_REGEX", `${name} must be an array of regex strings`, {
      provider: LOCAL,
      details: { field: name },
    });
  }
}

function normalizeCrawlPage(data: Record<string, unknown>): CrawlProviderPage {
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const page: CrawlProviderPage = {
    url: typeof data.url === "string" ? data.url : typeof metadata.url === "string" ? metadata.url : typeof metadata.sourceURL === "string" ? metadata.sourceURL : "",
    formats: normalizeFormats(data),
  };
  const finalUrl = absoluteHttpUrl(metadata.url ?? metadata.sourceURL ?? data.url);
  if (finalUrl) page.finalUrl = finalUrl;
  if (typeof metadata.title === "string") page.title = metadata.title;
  return page;
}

function normalizeCrawlErrors(value: unknown): CrawlProviderSnapshot["errors"] {
  if (!Array.isArray(value)) return [];
  const errors: CrawlProviderSnapshot["errors"] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const code = typeof item.code === "string" && item.code ? item.code : "CRAWL_ERROR";
    const message = typeof item.message === "string" && item.message
      ? item.message
      : typeof item.error === "string" ? item.error : "Crawl error";
    const error: CrawlProviderSnapshot["errors"][number] = { code, message };
    if (typeof item.url === "string") error.url = item.url;
    errors.push(error);
  }
  return errors;
}

/** Bound on followed crawl status pages so a compatible server cannot stream forever. */
export const MAX_CRAWL_PAGES = 100;

function normalizeCrawlSnapshot(payload: unknown): CrawlProviderSnapshot {
  if (!isRecord(payload)) throw new FreeWebError("INVALID_RESPONSE", "Firecrawl Local returned no crawl status", { provider: LOCAL });
  const rawStatus = payload.status;
  const status = rawStatus === "scraping" || rawStatus === "completed" || rawStatus === "failed" || rawStatus === "cancelled"
    ? rawStatus
    : "failed";
  const data = Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
  const total = typeof payload.total === "number" ? Math.max(payload.total, data.length) : data.length;
  const completed = typeof payload.completed === "number" ? payload.completed : data.length;
  return {
    status,
    total,
    completed,
    pages: data.map(normalizeCrawlPage),
    errors: normalizeCrawlErrors(payload.errors),
  };
}

function nextCrawlPage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const next = payload.next;
  return typeof next === "string" && next.trim() ? next.trim() : undefined;
}

function invalidCrawlNext(reason: "origin" | "path" | "loop" | "limit"): FreeWebError {
  return new FreeWebError(
    "FIRECRAWL_INVALID_NEXT",
    `Firecrawl Local returned a crawl next page that is unsafe to follow (${reason})`,
    { provider: LOCAL, retryable: false, details: { reason } },
  );
}

/**
 * A `next` link is only a page cursor on the serve process that produced it. Anything
 * outside that origin or the crawl API is refused rather than fetched as a URL.
 */
function resolveCrawlNext(raw: string, baseUrl: string): URL {
  let target: URL;
  try {
    target = new URL(raw, baseUrl);
  } catch {
    throw invalidCrawlNext("origin");
  }
  if (target.origin !== new URL(baseUrl).origin) throw invalidCrawlNext("origin");
  if (target.pathname !== "/v2/crawl" && !target.pathname.startsWith("/v2/crawl/")) throw invalidCrawlNext("path");
  return target;
}

export class FirecrawlLocalProvider implements FirecrawlAdapter {
  readonly name = LOCAL;

  private runtime?: Promise<FirecrawlRuntime>;
  private starting?: AbortController;
  private runtimeId = 0;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly config: FirecrawlConfig,
    private readonly deps: FirecrawlProviderDeps = {},
  ) {}

  private closedError(): FreeWebError {
    return new FreeWebError("FIRECRAWL_PROVIDER_CLOSED", "Firecrawl Local provider is closed", {
      provider: LOCAL,
      retryable: false,
    });
  }

  private async getRuntime(): Promise<FirecrawlRuntime> {
    if (this.closed) throw this.closedError();
    if (this.runtime) return this.runtime;
    const id = ++this.runtimeId;
    const controller = new AbortController();
    this.starting = controller;
    const release = (): void => {
      if (this.runtimeId !== id) return;
      this.runtime = undefined;
      if (this.starting === controller) this.starting = undefined;
    };
    const started = startFirecrawlRuntime(this.config, this.deps, controller.signal).then(
      async (runtime) => {
        runtime.onDead(release);
        if (!runtime.isAlive()) release();
        // close() may have landed while serve was starting; stop it instead of
        // handing a fresh process to an operation from a closed provider.
        if (this.closed) {
          release();
          await runtime.close();
          throw this.closedError();
        }
        return runtime;
      },
      (error: unknown) => {
        release();
        // A cancelled startup is always close(): report it as the closed provider
        // rather than leaking the internal cancellation code.
        if (this.closed) throw this.closedError();
        throw error;
      },
    );
    this.runtime = started;
    return started;
  }

  async fetch(input: FetchInput): Promise<{ results: FetchPage[]; errors: FetchOutputErrors }> {
    assertKnownKeys(input, FETCH_KEYS, "fetch");
    const unsupported = input.formats.filter((format) => !SUPPORTED_FETCH_FORMATS.has(format));
    if (unsupported.length > 0) {
      throw new FreeWebError("UNSUPPORTED_FORMAT", `Firecrawl Local cannot produce: ${unsupported.join(", ")}`, {
        provider: LOCAL,
        details: { formats: unsupported },
      });
    }

    const runtime = await this.getRuntime();
    const results: FetchPage[] = [];
    const errors: FetchOutputErrors = [];
    for (const url of input.urls) {
      const body: Record<string, unknown> = {
        url,
        formats: input.formats,
        onlyMainContent: input.onlyMainContent,
        timeout: input.timeoutMs,
      };
      if (input.includeSelectors && input.includeSelectors.length > 0) body.includeTags = input.includeSelectors;
      if (input.excludeSelectors && input.excludeSelectors.length > 0) body.excludeTags = input.excludeSelectors;
      if (input.waitForMs > 0) body.waitFor = input.waitForMs;

      try {
        const payload = await runtime.request("/v2/scrape", {
          method: "POST",
          body: JSON.stringify(body),
          timeoutMs: input.timeoutMs,
        });
        if (!isRecord(payload)) throw new FreeWebError("INVALID_RESPONSE", "Firecrawl Local returned no scrape data", { provider: LOCAL });
        results.push(normalizeFetchPage(url, payload));
      } catch (error) {
        const info = errorInfo(error, LOCAL);
        errors.push({
          url,
          code: info.code,
          message: info.message,
          provider: LOCAL,
          retryable: info.retryable,
        });
      }
    }
    return { results, errors };
  }

  async map(input: MapInput): Promise<{ links: Array<{ url: string }> }> {
    assertKnownKeys(input, MAP_KEYS, "map");
    const runtime = await this.getRuntime();
    const body: Record<string, unknown> = {
      url: input.url,
      limit: input.limit,
      includeSubdomains: input.includeSubdomains,
      sitemap: input.sitemap,
    };
    if (input.search !== undefined) body.search = input.search;
    const payload = await runtime.request("/v2/map", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });
    if (!isRecord(payload) || !Array.isArray(payload.links)) {
      throw new FreeWebError("INVALID_RESPONSE", "Firecrawl Local returned no map links", { provider: LOCAL });
    }
    const links: Array<{ url: string }> = [];
    for (const item of payload.links) {
      if (!isRecord(item)) continue;
      const url = absoluteHttpUrl(item.url);
      if (url) links.push({ url });
    }
    return { links };
  }

  async startCrawl(input: CrawlInput): Promise<{ id: string }> {
    assertKnownKeys(input, CRAWL_KEYS, "crawl");
    assertRegexStrings(input.includePaths, "includePaths");
    assertRegexStrings(input.excludePaths, "excludePaths");
    const runtime = await this.getRuntime();
    const scrapeOptions: Record<string, unknown> = {
      formats: input.formats,
      onlyMainContent: input.onlyMainContent,
      timeout: input.timeoutMs,
    };
    if (input.waitForMs > 0) scrapeOptions.waitFor = input.waitForMs;
    const body: Record<string, unknown> = {
      url: input.url,
      limit: input.limit,
      maxDiscoveryDepth: input.maxDiscoveryDepth,
      crawlEntireDomain: input.crawlEntireDomain,
      allowSubdomains: input.allowSubdomains,
      allowExternalLinks: input.allowExternalLinks,
      sitemap: input.sitemap,
      maxConcurrency: input.maxConcurrency,
      scrapeOptions,
    };
    if (input.includePaths !== undefined) body.includePaths = input.includePaths;
    if (input.excludePaths !== undefined) body.excludePaths = input.excludePaths;
    if (input.delayMs !== undefined) body.delay = input.delayMs;

    const payload = await runtime.request("/v2/crawl", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: input.timeoutMs,
    });
    if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id) {
      throw new FreeWebError("INVALID_RESPONSE", "Firecrawl Local returned no crawl id", { provider: LOCAL });
    }
    return { id: payload.id };
  }

  async getCrawl(id: string): Promise<CrawlProviderSnapshot> {
    const runtime = await this.getRuntime();
    const firstPath = `/v2/crawl/${encodeURIComponent(id)}`;
    const seen = new Set<string>([new URL(firstPath, runtime.baseUrl).href]);
    let payload = await runtime.request(firstPath, { method: "GET", timeoutMs: 30_000 });
    let snapshot = normalizeCrawlSnapshot(payload);
    const pages = [...snapshot.pages];
    const errors = [...snapshot.errors];
    let total = snapshot.total;
    let completed = snapshot.completed;
    let status = snapshot.status;

    // Local v0.1.0 does not paginate, but a compatible serve may emit `next`; follow it
    // so an incomplete checkpoint can never silently drop later pages.
    let next = nextCrawlPage(payload);
    while (next !== undefined) {
      if (seen.size >= MAX_CRAWL_PAGES) throw invalidCrawlNext("limit");
      const target = resolveCrawlNext(next, runtime.baseUrl);
      if (seen.has(target.href)) throw invalidCrawlNext("loop");
      seen.add(target.href);
      payload = await runtime.request(`${target.pathname}${target.search}`, { method: "GET", timeoutMs: 30_000 });
      snapshot = normalizeCrawlSnapshot(payload);
      pages.push(...snapshot.pages);
      errors.push(...snapshot.errors);
      total = Math.max(total, snapshot.total);
      completed = Math.max(completed, snapshot.completed);
      status = snapshot.status;
      next = nextCrawlPage(payload);
    }

    return {
      status,
      total: Math.max(total, pages.length),
      completed: Math.max(completed, pages.length),
      pages,
      errors,
    };
  }

  async cancelCrawl(id: string): Promise<void> {
    const runtime = await this.getRuntime();
    await runtime.request(`/v2/crawl/${encodeURIComponent(id)}`, {
      method: "DELETE",
      timeoutMs: 30_000,
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    // Set the guard before the first await so operations racing shutdown can
    // never spawn a replacement serve process.
    this.closed = true;
    const startup = this.starting;
    const runtime = this.runtime;
    // Cancel a serve that is still starting and stop its own child right away
    // instead of waiting out the 30-120s health poll; an aborted startup shuts
    // down the process it spawned within shutdownTimeoutMs.
    startup?.abort();
    this.closing = (async () => {
      if (!runtime) return;
      try {
        await (await runtime).close();
      } catch {
        // Startup failed or was cancelled; the aborted startup already stopped
        // its own serve process.
      } finally {
        if (this.runtime === runtime) this.runtime = undefined;
      }
    })();
    return this.closing;
  }
}

type FetchOutputErrors = Array<{
  url: string;
  code: string;
  message: string;
  provider?: typeof LOCAL;
  retryable?: boolean;
}>;

function parseSearchResults(stdout: string): SearchOutput["results"] {
  let payload: unknown;
  try { payload = JSON.parse(stdout.trim()); }
  catch (error) {
    throw new FreeWebError("INVALID_RESPONSE", "Firecrawl search CLI did not return JSON", {
      provider: SEARCH,
      cause: error,
    });
  }
  if (!isRecord(payload)) throw new FreeWebError("INVALID_RESPONSE", "Firecrawl search CLI returned no JSON object", { provider: SEARCH });
  if (payload.success === false) {
    const code = typeof payload.code === "string" && payload.code ? payload.code : "FIRECRAWL_SEARCH_FAILED";
    const message = typeof payload.error === "string" && payload.error
      ? payload.error
      : typeof payload.message === "string" ? payload.message : "Firecrawl search failed";
    throw new FreeWebError(code, message, { provider: SEARCH });
  }
  const rows = Array.isArray(payload.results) ? payload.results
    : Array.isArray(payload.data) ? payload.data
      : isRecord(payload.data) && Array.isArray(payload.data.web) ? payload.data.web
        : [];
  const results: SearchOutput["results"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.url !== "string") continue;
    let parsed: URL;
    try { parsed = new URL(row.url); }
    catch { continue; }
    if (!["http:", "https:"].includes(parsed.protocol)) continue;
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    const result: SearchOutput["results"][number] = {
      position: results.length + 1,
      title: typeof row.title === "string" && row.title ? row.title : parsed.hostname,
      url: row.url,
    };
    const snippet = row.description ?? row.snippet ?? row.content;
    if (typeof snippet === "string" && snippet) result.snippet = snippet;
    results.push(result);
  }
  return results;
}

export class FirecrawlSearchProvider implements SearchProvider {
  readonly name = SEARCH;

  constructor(
    private readonly config: FirecrawlConfig,
    private readonly deps: Pick<FirecrawlProviderDeps, "commandRunner"> = {},
  ) {}

  async search(input: SearchInput): Promise<{ results: SearchOutput["results"] }> {
    assertKnownKeys(input, SEARCH_KEYS, "search", SEARCH);
    if (input.options && Object.keys(input.options).length > 0) {
      throw new FreeWebError("UNSUPPORTED_OPTION", "Firecrawl search does not support MCP search options", {
        provider: SEARCH,
        details: { options: Object.keys(input.options) },
      });
    }
    if (!this.config.searchFallback) {
      throw new FreeWebError("SEARCH_FALLBACK_DISABLED", "Firecrawl search is disabled by configuration", { provider: SEARCH });
    }

    const runner = this.deps.commandRunner ?? nodeCommandRunner;
    let result: Awaited<ReturnType<CommandRunner>>;
    try {
      result = await runner({
        command: this.config.binary,
        // clap treats a leading-dash query as a flag without the `--` terminator.
        args: ["search", "-l", String(input.limit), "--", input.query],
        env: childProcessEnv({ FIRECRAWL_CLOUD: "search" }),
        timeoutMs: 60_000,
      });
    } catch (error) {
      // A spawn failure (ENOENT/EACCES) never produces a CommandResult, so it is
      // classified here instead of surfacing as an untagged INTERNAL_ERROR.
      throw this.spawnFailure(error);
    }
    if (result.exitCode !== 0 || result.timedOut) {
      throw new FreeWebError("FIRECRAWL_SEARCH_FAILED", result.stderr.trim() || `Firecrawl search exited with ${result.exitCode ?? result.signal}`, {
        provider: SEARCH,
        retryable: Boolean(result.timedOut),
      });
    }
    return { results: parseSearchResults(result.stdout) };
  }

  /** Keeps the firecrawl-search attribution and the original spawn cause. */
  private spawnFailure(error: unknown): FreeWebError {
    // An already classified provider error keeps its own code and attribution.
    if (error instanceof FreeWebError && error.options.provider) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new FreeWebError(
      "FIRECRAWL_SEARCH_FAILED",
      `Cannot run ${this.config.binary}: ${detail}`,
      {
        provider: SEARCH,
        retryable: false,
        details: { command: this.config.binary },
        cause: error,
      },
    );
  }
}
