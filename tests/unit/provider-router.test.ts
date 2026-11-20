import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { ArtifactOutput } from "../../src/artifacts/output.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { FreeWebError } from "../../src/errors.js";
import { ProviderRouter } from "../../src/providers/router.js";
import {
  refused,
  SUPPORTED,
  type FetchMapAdapter,
  type FetchProvider,
  type ProviderPreflight,
  type SearchProvider,
} from "../../src/providers/interfaces.js";
import { fetchInputSchema, mapInputSchema, searchInputSchema } from "../../src/types.js";

class FakeTinyFish implements SearchProvider, FetchProvider {
  readonly name = "tinyfish" as const;
  searchCalls = 0;
  fetchCalls = 0;
  searchInspections = 0;
  fetchInspections = 0;
  searchError: unknown;
  empty = false;
  searchVerdict: ProviderPreflight;
  fetchVerdict: ProviderPreflight;
  fetchHandler?: (input: { urls: string[] }) => Promise<{ results: any[]; errors: any[] }>;

  constructor(searchVerdict: ProviderPreflight, fetchVerdict: ProviderPreflight) {
    this.searchVerdict = searchVerdict;
    this.fetchVerdict = fetchVerdict;
  }

  inspectSearch(): ProviderPreflight {
    this.searchInspections++;
    return this.searchVerdict;
  }

  inspectFetch(): ProviderPreflight {
    this.fetchInspections++;
    return this.fetchVerdict;
  }

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
  inspections = 0;
  searchVerdict: ProviderPreflight;

  constructor(searchVerdict: ProviderPreflight) {
    this.searchVerdict = searchVerdict;
  }

  inspectSearch(): ProviderPreflight {
    this.inspections++;
    return this.searchVerdict;
  }

  async search() {
    this.calls++;
    return { results: [{ position: 1, title: "Firecrawl", url: "https://example.org", snippet: "fallback" }] };
  }
}

function unusedFirecrawl(options: {
  fetchVerdict: ProviderPreflight;
  fetch?: FetchMapAdapter["fetch"];
  map?: FetchMapAdapter["map"];
}): FetchMapAdapter {
  return {
    name: "firecrawl-local",
    inspectFetch: () => options.fetchVerdict,
    fetch: options.fetch ?? (async () => { throw new Error("not used"); }),
    map: options.map ?? (async () => { throw new Error("not used"); }),
  };
}

let root: string;
let tinyfish: FakeTinyFish;
let firecrawlSearch: FakeFirecrawlSearch;
let router: ProviderRouter;
let config: AppConfig;
let artifacts: ArtifactStore;
let output: ArtifactOutput;

function makeRouter(firecrawl: FetchMapAdapter) {
  return new ProviderRouter({
    config,
    output,
    tinyfish,
    firecrawl,
    firecrawlSearch,
    cloudUrlValidator: async (url) => new URL(url),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-router-"));
  tinyfish = new FakeTinyFish(SUPPORTED, SUPPORTED);
  firecrawlSearch = new FakeFirecrawlSearch(SUPPORTED);
  config = await loadConfig({ configPath: join(root, "missing.json"), env: {} });
  artifacts = new ArtifactStore({ root });
  output = new ArtifactOutput(artifacts);
  router = makeRouter(unusedFirecrawl({ fetchVerdict: SUPPORTED }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ProviderRouter Search seam", () => {
  it("explains when no Search provider is configured", async () => {
    router = new ProviderRouter({ config, output, firecrawl: unusedFirecrawl({ fetchVerdict: SUPPORTED }) });

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

  it("skips a generically refused explicit candidate and executes the alternate", async () => {
    firecrawlSearch.searchVerdict = refused(
      "FAKE_FILTER_UNSUPPORTED",
      "Fake provider cannot preserve this filter",
      new FreeWebError("FAKE_FILTER_CAUSE", "fake filter cause", { provider: "firecrawl-search" }),
    );

    const result = await router.search(searchInputSchema.parse({ query: "fallback", provider: "firecrawl-search" }));

    expect(result.provider).toBe("tinyfish");
    expect(result.requestedProvider).toBe("firecrawl-search");
    expect(result.attempts[0]).toMatchObject({
      provider: "firecrawl-search",
      outcome: "skipped",
      code: "FAKE_FILTER_UNSUPPORTED",
      message: "Fake provider cannot preserve this filter",
    });
    expect(firecrawlSearch.inspections).toBe(1);
    expect(firecrawlSearch.calls).toBe(0);
    expect(tinyfish.searchCalls).toBe(1);
  });

  it("keeps the refusal error as the Search cause when no candidate executes", async () => {
    tinyfish.searchVerdict = refused(
      "FAKE_TINYFISH_UNSUPPORTED",
      "TinyFish fake refusal",
      new FreeWebError("FAKE_TINYFISH_CAUSE", "tinyfish refusal cause", { provider: "tinyfish" }),
    );
    firecrawlSearch.searchVerdict = refused(
      "FAKE_FIRECRAWL_UNSUPPORTED",
      "Firecrawl fake refusal",
      new FreeWebError("FAKE_FIRECRAWL_CAUSE", "firecrawl refusal cause", { provider: "firecrawl-search" }),
    );

    await expect(router.search(searchInputSchema.parse({ query: "all refused" })))
      .rejects.toMatchObject({
        code: "ALL_PROVIDERS_FAILED",
        cause: expect.objectContaining({ code: "FAKE_FIRECRAWL_CAUSE" }),
        options: {
          details: {
            attempts: [
              expect.objectContaining({ provider: "tinyfish", outcome: "skipped", code: "FAKE_TINYFISH_UNSUPPORTED" }),
              expect.objectContaining({ provider: "firecrawl-search", outcome: "skipped", code: "FAKE_FIRECRAWL_UNSUPPORTED" }),
            ],
            cause: "firecrawl refusal cause",
          },
        },
      });
    expect(tinyfish.searchCalls).toBe(0);
    expect(firecrawlSearch.calls).toBe(0);
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

  it("does not inspect an alternate Search candidate when fallback is disabled", async () => {
    tinyfish.searchError = new FreeWebError("RATE_LIMIT_EXCEEDED", "quota exhausted", { provider: "tinyfish", retryable: true });

    await expect(router.search(searchInputSchema.parse({ query: "no fallback", fallback: false })))
      .rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED", message: expect.stringContaining("fallback: false") });
    expect(firecrawlSearch.inspections).toBe(0);
    expect(firecrawlSearch.calls).toBe(0);
  });

  it("separates an unconfigured explicit primary from a disabled per-call fallback", async () => {
    router = new ProviderRouter({
      config,
      output,
      firecrawl: unusedFirecrawl({ fetchVerdict: SUPPORTED }),
      firecrawlSearch,
      cloudUrlValidator: async (url) => new URL(url),
    });

    await expect(router.search(searchInputSchema.parse({ query: "no primary", provider: "tinyfish", fallback: false })))
      .rejects.toMatchObject({
        code: "PROVIDER_NOT_CONFIGURED",
        message: expect.stringContaining("fallback: false"),
        options: {
          details: {
            fallback: false,
            requestedProvider: "tinyfish",
            attempts: [expect.objectContaining({ provider: "tinyfish", outcome: "skipped", code: "PROVIDER_NOT_CONFIGURED" })],
          },
        },
      });
    expect(firecrawlSearch.inspections).toBe(0);
    expect(firecrawlSearch.calls).toBe(0);
  });

  it("records a skipped explicit provider and its fallback", async () => {
    router = new ProviderRouter({
      config,
      output,
      firecrawl: unusedFirecrawl({ fetchVerdict: SUPPORTED }),
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
    router = makeRouter(unusedFirecrawl({ fetchVerdict: SUPPORTED }));
    await router.search(searchInputSchema.parse({ query: "first" }));

    const second = await router.search(searchInputSchema.parse({ query: "second" }));

    expect(second.provider).toBe("firecrawl-search");
    expect(tinyfish.searchCalls).toBe(1);
    expect(second.attempts[0]).toMatchObject({ provider: "tinyfish", code: "RATE_LIMITED", outcome: "error" });
  });
});

describe("ProviderRouter Fetch seam", () => {
  it("falls back only for failed URLs and preserves successful primary results", async () => {
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async (input) => ({
        results: input.urls.filter((url) => url.endsWith("/a")).map((url) => ({ url, formats: { markdown: "primary" } })),
        errors: input.urls.filter((url) => url.endsWith("/b")).map((url) => ({ url, code: "FETCH_FAILED", message: "local failure" })),
      }),
    });
    tinyfish.fetchHandler = async (input) => {
      expect(input.urls).toEqual(["https://example.com/b"]);
      return { results: [{ url: "https://example.com/b", formats: { markdown: "fallback" } }], errors: [] };
    };
    router = makeRouter(firecrawl);

    const result = await router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com/a", "https://example.com/b"],
    }));

    expect(result.results).toHaveLength(2);
    expect(result.results.map((page) => page.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.errors).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.requestedProvider).toBe("auto");
    expect(result.results.find((page) => page.url.endsWith("/a"))).toMatchObject({ provider: "firecrawl-local" });
    expect(result.results.find((page) => page.url.endsWith("/b"))).toMatchObject({ provider: "tinyfish", formats: { markdown: "fallback" } });
    expect(result.attempts.map((attempt) => attempt.provider)).toEqual(["firecrawl-local", "tinyfish"]);
    expect(result.warnings).toContain("One or more URLs used a fallback provider");
    expect(result.provider).toBe("tinyfish");
  });

  it("marks a zero-result primary attempt as error and attributes the fallback provider", async () => {
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async () => ({
        results: [],
        errors: [{ url: "https://example.com/b", code: "FETCH_FAILED", message: "local failure" }],
      }),
    });
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
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async (input) => ({
        results: input.urls.map((url) => ({ url, formats: { markdown: "local" } })),
        errors: [],
      }),
    });
    config.firecrawl.allowPrivate = true;
    router = new ProviderRouter({
      config,
      output,
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
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async (input) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { results: [{ url: input.urls[0], formats: { markdown: "ok" } }], errors: [] };
      },
    });
    router = makeRouter(firecrawl);
    const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`);

    const result = await router.fetch(fetchInputSchema.parse({ urls }));

    expect(result.results).toHaveLength(10);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("skips a generically refused explicit primary and executes the alternate", async () => {
    tinyfish.fetchVerdict = refused(
      "FAKE_OPTION_UNSUPPORTED",
      "Fake adapter cannot preserve this option",
      new FreeWebError("FAKE_OPTION_CAUSE", "fake option cause", { provider: "tinyfish" }),
    );
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async (input) => ({
        results: input.urls.map((url) => ({ url, formats: { markdown: "fallback" } })),
        errors: [],
      }),
    });
    router = makeRouter(firecrawl);

    const result = await router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com"],
      provider: "tinyfish",
    }));

    expect(result.provider).toBe("firecrawl-local");
    expect(result.requestedProvider).toBe("tinyfish");
    expect(result.attempts[0]).toMatchObject({
      outcome: "skipped",
      provider: "tinyfish",
      code: "FAKE_OPTION_UNSUPPORTED",
      message: "Fake adapter cannot preserve this option",
    });
    expect(tinyfish.fetchInspections).toBe(1);
    expect(tinyfish.fetchCalls).toBe(0);
    expect(result.warnings).toContain("Requested provider tinyfish was skipped before fallback");
  });

  it("uses a generic auto refusal only to filter candidates", async () => {
    let firecrawlCalls = 0;
    const firecrawl = unusedFirecrawl({
      fetchVerdict: refused(
        "FAKE_LOCAL_UNSUPPORTED",
        "Fake local adapter cannot preserve this option",
        new FreeWebError("FAKE_LOCAL_CAUSE", "fake local cause", { provider: "firecrawl-local" }),
      ),
      fetch: async () => {
        firecrawlCalls++;
        throw new Error("refused adapter must not execute");
      },
    });
    tinyfish.fetchHandler = async (input) => ({
      results: input.urls.map((url) => ({ url, formats: { markdown: "fallback" } })),
      errors: [],
    });
    router = makeRouter(firecrawl);

    const result = await router.fetch(fetchInputSchema.parse({ urls: ["https://example.com"], provider: "auto" }));

    expect(result.provider).toBe("tinyfish");
    expect(result.attempts.map((attempt) => attempt.provider)).toEqual(["tinyfish"]);
    expect(result.warnings).not.toContain("Requested provider firecrawl-local was skipped before fallback");
    expect(firecrawlCalls).toBe(0);
  });

  it("rejects an explicit refused primary with UNSUPPORTED_OPTION when fallback is disabled", async () => {
    tinyfish.fetchVerdict = refused(
      "FAKE_OPTION_UNSUPPORTED",
      "Fake adapter cannot preserve this option",
      new FreeWebError("FAKE_OPTION_CAUSE", "fake option cause", { provider: "tinyfish" }),
    );
    router = makeRouter(unusedFirecrawl({ fetchVerdict: SUPPORTED }));

    await expect(router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com"],
      provider: "tinyfish",
      fallback: false,
    }))).rejects.toMatchObject({
      code: "UNSUPPORTED_OPTION",
      message: "Fake adapter cannot preserve this option",
      options: { provider: "tinyfish" },
    });
    expect(tinyfish.fetchCalls).toBe(0);
  });

  it("reports the missing explicit primary through ALL_PROVIDERS_FAILED without preflight", async () => {
    router = new ProviderRouter({
      config,
      output,
      firecrawl: unusedFirecrawl({ fetchVerdict: SUPPORTED }),
      firecrawlSearch,
      cloudUrlValidator: async (url) => new URL(url),
    });
    const urls = ["https://example.com"];

    await expect(router.fetch(fetchInputSchema.parse({ urls, provider: "tinyfish", fallback: false })))
      .rejects.toMatchObject({
        code: "ALL_PROVIDERS_FAILED",
        message: "No configured Fetch provider can preserve the requested options",
        options: {
          details: {
            attempts: [{
              provider: "tinyfish",
              outcome: "skipped",
              durationMs: 0,
              code: "PROVIDER_NOT_CONFIGURED",
              message: "Requested provider is not configured",
            }],
            urls,
          },
        },
      });
  });

  it("reports an unconfigured primary refused options through ALL_PROVIDERS_FAILED", async () => {
    // A missing adapter has no verdict to refuse with, so the Router falls back to the
    // no-eligible-candidate branch instead of a provider-specific rule.
    router = new ProviderRouter({
      config,
      output,
      firecrawl: unusedFirecrawl({ fetchVerdict: SUPPORTED }),
      firecrawlSearch,
      cloudUrlValidator: async (url) => new URL(url),
    });

    await expect(router.fetch(fetchInputSchema.parse({
      urls: ["https://example.com"],
      provider: "tinyfish",
      fallback: false,
      formats: ["rawHtml"],
    }))).rejects.toMatchObject({
      code: "ALL_PROVIDERS_FAILED",
      options: { details: { attempts: [expect.objectContaining({ provider: "tinyfish", code: "PROVIDER_NOT_CONFIGURED" })] } },
    });
    expect(tinyfish.fetchCalls).toBe(0);
  });

  it("does not add a cloud attempt after an outcome-uncertain Fetch timeout", async () => {
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async (input) => ({
        results: [],
        errors: input.urls.map((url) => ({
          url,
          code: "UPSTREAM_TIMEOUT_UNCERTAIN",
          message: "request outcome is unknown",
          retryable: false,
        })),
      }),
    });
    router = makeRouter(firecrawl);

    await expect(router.fetch(fetchInputSchema.parse({ urls: ["https://example.com/uncertain"] })))
      .rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    expect(tinyfish.fetchCalls).toBe(0);
  });

  it("runs per-URL fallbacks concurrently within the TinyFish budget", async () => {
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async (input) => ({
        results: [],
        errors: input.urls.map((url) => ({ url, code: "FETCH_FAILED", message: "local failure" })),
      }),
    });
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

  it("stores screenshot bytes as a binary Artifact instead of truncating base64 text", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async () => ({
        results: [{ url: "https://example.com", formats: { screenshot: `data:image/png;base64,${png.toString("base64")}` } }],
        errors: [],
      }),
    });
    router = makeRouter(firecrawl);

    const result = await router.fetch(fetchInputSchema.parse({ urls: ["https://example.com"], formats: ["screenshot"] }));

    expect(result.results[0].formats.screenshot).toBeUndefined();
    expect(result.results[0].screenshotArtifactId).toBeDefined();
    const saved = await artifacts.read(result.results[0].screenshotArtifactId!);
    expect(saved.data).toEqual(png);
    expect(saved.descriptor.mimeType).toBe("image/png");
  });

  it("stores untruncated Fetch pages as Artifacts before applying inline budgets", async () => {
    config.artifacts.inlineFetchPageChars = 100;
    config.artifacts.inlineFetchTotalChars = 150;
    const longText = "x".repeat(180);
    const firecrawl = unusedFirecrawl({
      fetchVerdict: SUPPORTED,
      fetch: async (input) => ({
        results: input.urls[0].endsWith("/long")
          ? [{ url: "https://example.com/long", formats: { markdown: longText } }]
          : [{ url: "https://example.com/other", formats: { markdown: "y".repeat(100) } }],
        errors: [],
      }),
    });
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
    const firecrawl: FetchMapAdapter = {
      ...unusedFirecrawl({ fetchVerdict: SUPPORTED }),
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
