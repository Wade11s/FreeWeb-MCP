import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { FreeWebError } from "../../src/errors.js";
import { ProviderRouter } from "../../src/providers/router.js";
import type { FetchProvider, FirecrawlAdapter, SearchProvider } from "../../src/providers/interfaces.js";
import { fetchInputSchema, mapInputSchema, searchInputSchema } from "../../src/types.js";

class FakeTinyFish implements SearchProvider, FetchProvider {
  readonly name = "tinyfish" as const;
  searchCalls = 0;
  fetchCalls = 0;
  searchError: unknown;
  empty = false;
  fetchHandler?: (input: { urls: string[] }) => Promise<{ results: any[]; errors: any[] }>;

  async search() {
    this.searchCalls++;
    if (this.searchError) throw this.searchError;
    return { results: this.empty ? [] : [{ position: 1, title: "TinyFish", url: "https://example.com", snippet: "result" }] };
  }
  async fetch(input: { urls: string[] }) {
    this.fetchCalls++;
    if (this.fetchHandler) return this.fetchHandler(input);
    throw new Error("not configured in this test");
  }
}

class FakeFirecrawlSearch implements SearchProvider {
  readonly name = "firecrawl-search" as const;
  calls = 0;
  async search() {
    this.calls++;
    return { results: [{ position: 1, title: "Firecrawl", url: "https://example.org", snippet: "fallback" }] };
  }
}

function unusedFirecrawl(fetchImpl?: FirecrawlAdapter["fetch"]): FirecrawlAdapter {
  return {
    name: "firecrawl-local",
    fetch: fetchImpl ?? (async () => { throw new Error("not used"); }),
    async map() { throw new Error("not used"); },
    async startCrawl() { throw new Error("not used"); },
    async getCrawl() { throw new Error("not used"); },
    async cancelCrawl() {},
    async close() {},
  };
}

let root: string;
let tinyfish: FakeTinyFish;
let firecrawlSearch: FakeFirecrawlSearch;
let router: ProviderRouter;
let config: AppConfig;
let artifacts: ArtifactStore;

function makeRouter(firecrawl: FirecrawlAdapter) {
  return new ProviderRouter({
    config,
    artifacts,
    tinyfish,
    firecrawl,
    firecrawlSearch,
    cloudUrlValidator: async (url) => new URL(url),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-router-"));
  tinyfish = new FakeTinyFish();
  firecrawlSearch = new FakeFirecrawlSearch();
  config = await loadConfig({ configPath: join(root, "missing.json"), env: {} });
  artifacts = new ArtifactStore({ root });
  router = makeRouter(unusedFirecrawl());
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ProviderRouter Search seam", () => {
  it("explains when no Search provider is configured", async () => {
    router = new ProviderRouter({ config, artifacts, firecrawl: unusedFirecrawl() });

    await expect(router.search(searchInputSchema.parse({ query: "unconfigured" })))
      .rejects.toMatchObject({
        code: "SEARCH_NOT_CONFIGURED",
        options: {
          details: {
            attempts: [
              expect.objectContaining({ provider: "tinyfish", outcome: "skipped" }),
              expect.objectContaining({ provider: "firecrawl-search", outcome: "skipped" }),
            ],
          },
        },
      });
  });

  it("uses one Firecrawl Search fallback after a TinyFish rate limit", async () => {
    tinyfish.searchError = new FreeWebError("RATE_LIMIT_EXCEEDED", "quota exhausted", { provider: "tinyfish", retryable: true });

    const result = await router.search(searchInputSchema.parse({ query: "web MCP" }));

    expect(result.provider).toBe("firecrawl-search");
    expect(result.results[0].title).toBe("Firecrawl");
    expect(result.attempts.map((attempt) => attempt.provider)).toEqual(["tinyfish", "firecrawl-search"]);
    expect(result.warnings[0]).toContain("fallback");
    expect(tinyfish.searchCalls).toBe(1);
    expect(firecrawlSearch.calls).toBe(1);
  });

  it("does not fall back after an empty Search response", async () => {
    tinyfish.empty = true;

    const result = await router.search(searchInputSchema.parse({ query: "no results" }));

    expect(result.results).toEqual([]);
    expect(result.provider).toBe("tinyfish");
    expect(firecrawlSearch.calls).toBe(0);
  });

  it("does not repeat a cloud Search after an outcome-uncertain timeout", async () => {
    tinyfish.searchError = new FreeWebError("UPSTREAM_TIMEOUT_UNCERTAIN", "request outcome is unknown", { provider: "tinyfish", retryable: false });

    await expect(router.search(searchInputSchema.parse({ query: "uncertain" }))).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(firecrawlSearch.calls).toBe(0);
  });

  it("records a skipped explicit provider and its fallback", async () => {
    router = new ProviderRouter({
      config,
      artifacts,
      firecrawl: unusedFirecrawl(),
      firecrawlSearch,
      cloudUrlValidator: async (url) => new URL(url),
    });

    const result = await router.search(searchInputSchema.parse({ query: "fallback", provider: "tinyfish" }));
    expect(result.provider).toBe("firecrawl-search");
    expect(result.requestedProvider).toBe("tinyfish");
    expect(result.attempts[0]).toMatchObject({ outcome: "skipped", provider: "tinyfish", code: "PROVIDER_NOT_CONFIGURED" });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("enforces the local TinyFish Search budget before calling the SDK", async () => {
    config.limits.tinyfishSearchPerMinute = 1;
    router = makeRouter(unusedFirecrawl());
    await router.search(searchInputSchema.parse({ query: "first" }));

    const second = await router.search(searchInputSchema.parse({ query: "second" }));

    expect(second.provider).toBe("firecrawl-search");
    expect(tinyfish.searchCalls).toBe(1);
    expect(second.attempts[0]).toMatchObject({ provider: "tinyfish", code: "RATE_LIMITED", outcome: "error" });
  });
});

describe("ProviderRouter Fetch seam", () => {
  it("falls back only for failed URLs and preserves successful primary results", async () => {
    const firecrawl = unusedFirecrawl(async (input) => ({
      results: input.urls.filter((url) => url.endsWith("/a")).map((url) => ({ url, formats: { markdown: "primary" } })),
      errors: input.urls.filter((url) => url.endsWith("/b")).map((url) => ({ url, code: "FETCH_FAILED", message: "local failure" })),
    }));
    tinyfish.fetchHandler = async (input) => {
      expect(input.urls).toEqual(["https://example.com/b"]);
      return { results: [{ url: "https://example.com/b", formats: { markdown: "fallback" } }], errors: [] };
    };
    router = makeRouter(firecrawl);

    const result = await router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com/a", "https://example.com/b"],
    }));

    expect(result.results).toHaveLength(2);
    expect(result.errors).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.results.find((page) => page.url.endsWith("/a"))).toMatchObject({ provider: "firecrawl-local" });
    expect(result.results.find((page) => page.url.endsWith("/b"))).toMatchObject({ provider: "tinyfish", formats: { markdown: "fallback" } });
    expect(result.attempts.map((attempt) => attempt.provider)).toEqual(["firecrawl-local", "tinyfish"]);
    expect(result.provider).toBe("tinyfish");
  });

  it("marks a zero-result primary attempt as error and attributes the fallback provider", async () => {
    const firecrawl = unusedFirecrawl(async () => ({
      results: [],
      errors: [{ url: "https://example.com/b", code: "FETCH_FAILED", message: "local failure" }],
    }));
    tinyfish.fetchHandler = async (input) => ({
      results: input.urls.map((url) => ({ url, formats: { markdown: "fallback" } })),
      errors: [],
    });
    router = makeRouter(firecrawl);

    const result = await router.fetch(fetchInputSchema.parse({ urls: ["https://example.com/b"] }));

    expect(result.provider).toBe("tinyfish");
    expect(result.attempts[0]).toMatchObject({ provider: "firecrawl-local", outcome: "error", code: "FETCH_FAILED" });
    expect(result.results[0].provider).toBe("tinyfish");
  });

  it("rejects private URLs at the TinyFish boundary even when local private access is enabled", async () => {
    const firecrawl = unusedFirecrawl(async (input) => ({
      results: input.urls.map((url) => ({ url, formats: { markdown: "local" } })),
      errors: [],
    }));
    config.firecrawl.allowPrivate = true;
    router = new ProviderRouter({
      config,
      artifacts,
      tinyfish,
      firecrawl,
      firecrawlSearch,
      cloudUrlValidator: async () => { throw new FreeWebError("PRIVATE_URL_BLOCKED", "cloud blocked"); },
    });

    const result = await router.fetch(fetchInputSchema.parse({
      urls: ["http://10.0.0.5/intranet"],
      provider: "tinyfish",
    }));

    expect(result.provider).toBe("firecrawl-local");
    expect(tinyfish.fetchCalls).toBe(0);
    expect(result.attempts[0]).toMatchObject({ provider: "tinyfish", code: "PRIVATE_URL_BLOCKED" });
  });

  it("fetches a Firecrawl batch concurrently without exceeding the shared budget", async () => {
    let active = 0;
    let maxActive = 0;
    const firecrawl = unusedFirecrawl(async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { results: [{ url: input.urls[0], formats: { markdown: "ok" } }], errors: [] };
    });
    router = makeRouter(firecrawl);
    const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`);

    const result = await router.fetch(fetchInputSchema.parse({ urls }));

    expect(result.results).toHaveLength(10);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("records an unsupported explicit provider before using the alternate", async () => {
    tinyfish.fetchHandler = async (input) => ({
      results: input.urls.map((url) => ({ url, formats: { json: { ok: true } } })),
      errors: [],
    });
    router = makeRouter(unusedFirecrawl());

    const result = await router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com"],
      formats: ["json"],
      provider: "firecrawl-local",
    }));

    expect(result.provider).toBe("tinyfish");
    expect(result.requestedProvider).toBe("firecrawl-local");
    expect(result.attempts[0]).toMatchObject({ outcome: "skipped", provider: "firecrawl-local", code: "UNSUPPORTED_OPTION" });
    expect(result.warnings).toContain("Requested provider firecrawl-local was skipped before fallback");
  });

  it("rejects an incompatible TinyFish timeout before any provider call", async () => {
    router = makeRouter(unusedFirecrawl());

    await expect(router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com"],
      provider: "tinyfish",
      fallback: false,
      timeoutMs: 120_000,
    }))).rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
    expect(tinyfish.fetchCalls).toBe(0);
  });

  it("runs per-URL fallbacks concurrently within the TinyFish budget", async () => {
    const firecrawl = unusedFirecrawl(async (input) => ({
      results: [],
      errors: input.urls.map((url) => ({ url, code: "FETCH_FAILED", message: "local failure" })),
    }));
    let active = 0;
    let maxActive = 0;
    tinyfish.fetchHandler = async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { results: [{ url: input.urls[0], formats: { markdown: "fallback" } }], errors: [] };
    };
    router = makeRouter(firecrawl);
    const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`);

    const result = await router.fetch(fetchInputSchema.parse({ urls }));

    expect(result.results).toHaveLength(10);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("does not fall back to TinyFish when selectors cannot be preserved", async () => {
    const firecrawl = unusedFirecrawl(async () => { throw new FreeWebError("FETCH_FAILED", "local failure"); });
    router = makeRouter(firecrawl);

    await expect(router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com"],
      includeSelectors: ["article"],
    }))).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(tinyfish.fetchCalls).toBe(0);
  });

  it("stores screenshot bytes as a binary Artifact instead of truncating base64 text", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
    const firecrawl = unusedFirecrawl(async () => ({
      results: [{ url: "https://example.com", formats: { screenshot: `data:image/png;base64,${png.toString("base64")}` } }],
      errors: [],
    }));
    router = makeRouter(firecrawl);

    const result = await router.fetch(fetchInputSchema.parse({ urls: ["https://example.com"], formats: ["screenshot"] }));

    expect(result.results[0].formats.screenshot).toBeUndefined();
    expect(result.results[0].screenshotArtifactId).toBeDefined();
    const saved = await artifacts.read(result.results[0].screenshotArtifactId!);
    expect(saved.data).toEqual(png);
    expect(saved.descriptor.mimeType).toBe("image/png");
  });

  it("counts links and JSON objects toward Fetch inline budgets", async () => {
    config.artifacts.inlineFetchTotalChars = 150;
    const firecrawl = unusedFirecrawl(async () => ({
      results: [{
        url: "https://example.com",
        formats: { links: Array.from({ length: 30 }, (_, index) => `https://example.com/${index}`) },
        links: Array.from({ length: 30 }, (_, index) => `https://example.com/${index}`),
      }],
      errors: [],
    }));
    router = makeRouter(firecrawl);
    const linked = await router.fetch(fetchInputSchema.parse({ urls: ["https://example.com"], formats: ["links"] }));
    expect(linked.artifactIds).toBeDefined();
    expect(linked.results[0].truncated).toBe(true);
    expect(linked.results[0].links!.length).toBeLessThan(30);

    tinyfish.fetchHandler = async () => ({
      results: [{ url: "https://example.com/json", formats: { json: { text: "x".repeat(500) } } }],
      errors: [],
    });
    router = makeRouter(unusedFirecrawl());
    const json = await router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com/json"],
      formats: ["json"],
      provider: "tinyfish",
      fallback: false,
    }));
    expect(json.artifactIds).toBeDefined();
    expect(typeof json.results[0].formats.json).toBe("string");
    expect(json.results[0].truncated).toBe(true);
  });

  it("stores untruncated Fetch pages as Artifacts before applying inline budgets", async () => {
    config.artifacts.inlineFetchPageChars = 100;
    config.artifacts.inlineFetchTotalChars = 150;
    const longText = "x".repeat(180);
    const firecrawl = unusedFirecrawl(async (input) => ({
      results: input.urls[0].endsWith("/long")
        ? [{ url: "https://example.com/long", formats: { markdown: longText } }]
        : [{ url: "https://example.com/other", formats: { markdown: "y".repeat(100) } }],
      errors: [],
    }));
    router = makeRouter(firecrawl);

    const result = await router.fetch(fetchInputSchema.parse({ urls: ["https://example.com/long", "https://example.com/other"] }));

    expect(result.results[0].formats.markdown).toBe("x".repeat(100));
    expect(result.results[1].formats.markdown).toBe("y".repeat(50));
    expect(result.results.every((page) => page.truncated)).toBe(true);
    expect(result.artifactIds).toHaveLength(2);
    const saved = JSON.parse(await artifacts.readText(result.artifactIds![0]));
    expect(saved.formats.markdown).toBe(longText);
  });
});

describe("ProviderRouter Map seam", () => {
  it("returns Map links and moves overflow into a complete Artifact", async () => {
    config.artifacts.inlineFetchTotalChars = 1000;
    const links = Array.from({ length: 100 }, (_, index) => ({ url: `https://example.com/${index}-${"p".repeat(30)}` }));
    let receivedLimit = 0;
    const firecrawl: FirecrawlAdapter = {
      ...unusedFirecrawl(),
      async map(input) { receivedLimit = input.limit; return { links }; },
    };
    router = makeRouter(firecrawl);

    const result = await router.map(mapInputSchema.parse({ url: "https://example.com" }));

    expect(receivedLimit).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.links.length).toBeLessThan(links.length);
    expect(result.artifactId).toBeDefined();
    expect(JSON.parse(await artifacts.readText(result.artifactId!)).links).toHaveLength(100);
    expect(result.attempts[0].provider).toBe("firecrawl-local");
  });
});
