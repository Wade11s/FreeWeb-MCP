import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { FirecrawlSearchProvider } from "../../src/providers/firecrawl.js";
import { createFreeWebRuntime, type FreeWebRuntime } from "../../src/runtime.js";
import { searchInputSchema } from "../../src/types.js";

const runFirecrawl = process.env.FREEWEB_LIVE_FIRECRAWL === "1";
const runSearch = process.env.FREEWEB_LIVE_FIRECRAWL_SEARCH === "1";
let root: string;
let config: AppConfig;
let runtime: FreeWebRuntime;

beforeAll(async () => {
  if (!runFirecrawl && !runSearch) return;
  root = await mkdtemp(join(tmpdir(), "freeweb-live-firecrawl-"));
  config = await loadConfig({
    configPath: join(root, "missing.json"),
    env: {
      FREEWEB_DATA_DIR: join(root, "data"),
      FIRECRAWL_PORT: "0",
      FREEWEB_FIRECRAWL_ALLOW_PRIVATE: process.env.FREEWEB_LIVE_ALLOW_PRIVATE === "1" ? "true" : "false",
    },
  });
  config.firecrawl.searchFallback = runSearch;
  runtime = await createFreeWebRuntime(config);
}, 120_000);

afterAll(async () => {
  if (runtime) await runtime.close();
  if (root) await rm(root, { recursive: true, force: true });
}, 120_000);

describe.skipIf(!runFirecrawl)("Firecrawl Local v0.1.0 live contract", () => {
  it("scrapes a public page through the local v2 API", async () => {
    const output = await runtime.fetch({
      urls: ["https://example.com"],
      formats: ["markdown", "html", "links"],
      onlyMainContent: true,
      waitForMs: 0,
      timeoutMs: 30_000,
      provider: "firecrawl-local",
      fallback: false,
    });

    expect(output.errors).toEqual([]);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].formats.markdown).toContain("documentation examples");
    expect(output.results[0].formats.html).toContain("<html");
    expect(output.provider).toBe("firecrawl-local");
    expect(output.attempts[0].provider).toBe("firecrawl-local");
  }, 120_000);

  it("captures a screenshot as a binary Artifact when local Chrome is available", async () => {
    const output = await runtime.fetch({
      urls: ["https://example.com"],
      formats: ["screenshot"],
      onlyMainContent: true,
      waitForMs: 0,
      timeoutMs: 30_000,
      provider: "firecrawl-local",
      fallback: false,
    });

    expect(output.errors).toEqual([]);
    const page = output.results[0];
    if (page.screenshotArtifactId) {
      const screenshot = await runtime.artifacts.read(page.screenshotArtifactId);
      expect(screenshot.descriptor.mimeType).toBe("image/png");
      expect(screenshot.data.byteLength).toBeGreaterThan(100);
    } else {
      expect(page.formats.screenshot).toEqual(expect.any(String));
    }
  }, 120_000);

  it("maps a public starting page", async () => {
    const output = await runtime.map({
      url: "https://example.com",
      limit: 5,
      includeSubdomains: false,
      sitemap: "include",
    });

    expect(output.provider).toBe("firecrawl-local");
    expect(output.links.length).toBeGreaterThan(0);
    expect(output.links.every((link) => link.url.startsWith("http"))).toBe(true);
  }, 120_000);

  it("runs and checkpoints a one-page Crawl Job", async () => {
    const started = await runtime.crawl({
      url: "https://example.com",
      limit: 1,
      maxDiscoveryDepth: 0,
      crawlEntireDomain: false,
      allowSubdomains: false,
      allowExternalLinks: false,
      maxConcurrency: 1,
      sitemap: "skip",
      formats: ["markdown"],
      onlyMainContent: true,
      waitForMs: 0,
      timeoutMs: 30_000,
    });

    let status = started;
    const deadline = Date.now() + 90_000;
    while (status.status === "scraping" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = await runtime.crawlStatus({ crawlId: started.crawlId, offset: 0, limit: 10, maxCharsPerPage: 50_000 });
    }

    expect(status.status).toBe("completed");
    expect(status.pages[0].formats.markdown).toContain("documentation examples");
    expect(status.artifactId).toBeDefined();
    expect(status.partial).toBe(false);
  }, 120_000);
});

describe.skipIf(!runSearch)("Firecrawl keyless Search live contract", () => {
  it("returns normalized results without an API key", async (ctx) => {
    const provider = new FirecrawlSearchProvider(config.firecrawl);
    try {
      const output = await provider.search(searchInputSchema.parse({
        query: "Model Context Protocol",
        limit: 2,
        provider: "firecrawl-search",
        fallback: false,
      }));

      expect(output.results.length).toBeGreaterThan(0);
      expect(output.results.length).toBeLessThanOrEqual(2);
      expect(output.results[0].url).toMatch(/^https?:/);
    } catch (error) {
      if (error instanceof Error && error.message.includes("needs a sign-in")) {
        ctx.skip("Firecrawl keyless Search requires sign-in from this VPN/proxy IP");
      }
      throw error;
    }
  }, 120_000);
});
