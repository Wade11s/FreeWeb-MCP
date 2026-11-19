import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { createFreeWebRuntime, type FreeWebRuntime } from "../../src/runtime.js";

const runTinyFish = process.env.FREEWEB_LIVE_TINYFISH === "1"
  && Boolean(process.env.TINYFISH_API_KEY)
  && process.env.FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED === "true";
let root: string;
let config: AppConfig;
let runtime: FreeWebRuntime;

beforeAll(async () => {
  if (!runTinyFish) return;
  root = await mkdtemp(join(tmpdir(), "freeweb-live-tinyfish-"));
  config = await loadConfig({
    configPath: join(root, "missing.json"),
    env: {
      TINYFISH_API_KEY: process.env.TINYFISH_API_KEY!,
      FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "true",
      FREEWEB_DATA_DIR: join(root, "data"),
      FREEWEB_FIRECRAWL_ALLOW_PRIVATE: process.env.FREEWEB_LIVE_ALLOW_PRIVATE === "1" ? "true" : "false",
    },
  });
  runtime = await createFreeWebRuntime(config);
});

afterAll(async () => {
  if (runtime) await runtime.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!runTinyFish)("TinyFish no-wallet-spending live account", () => {
  it("searches once with SDK retries disabled", async () => {
    const output = await runtime.search({
      query: "Model Context Protocol",
      limit: 1,
      provider: "tinyfish",
      fallback: false,
    });

    expect(output.provider).toBe("tinyfish");
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results.length).toBeLessThanOrEqual(1);
    expect(output.attempts).toHaveLength(1);
  }, 60_000);

  it("fetches a public URL without calling another TinyFish product", async () => {
    const output = await runtime.fetch({
      urls: ["https://example.com"],
      formats: ["markdown"],
      onlyMainContent: true,
      waitForMs: 0,
      timeoutMs: 30_000,
      provider: "tinyfish",
      fallback: false,
    });

    expect(output.provider).toBe("tinyfish");
    expect(output.errors).toEqual([]);
    expect(output.results[0].formats.markdown).toContain("Example");
    expect(output.attempts).toHaveLength(1);
  }, 60_000);
});
