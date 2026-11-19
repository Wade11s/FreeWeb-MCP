import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, redactedConfig } from "../../src/config.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "freeweb-config-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("configuration environment overrides", () => {
  it("revalidates port ranges after applying environment overrides", async () => {
    await expect(loadConfig({ configPath: join(root, "missing.json"), env: { FIRECRAWL_PORT: "70000" } }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("rejects an empty data directory after applying environment overrides", async () => {
    await expect(loadConfig({ configPath: join(root, "missing.json"), env: { FREEWEB_DATA_DIR: "" } }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("keeps API keys out of redacted configuration output", async () => {
    const config = await loadConfig({
      configPath: join(root, "missing.json"),
      env: {
        FREEWEB_DATA_DIR: join(root, "data"),
        TINYFISH_API_KEY: "secret-test-key",
        FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "true",
      },
    });

    expect(config.tinyfish.freeOnlyConfirmed).toBe(true);
    expect(JSON.stringify(redactedConfig(config))).not.toContain("secret-test-key");
  });
});
