import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { FreeWebRuntime } from "../../src/runtime.js";
import type { BrowseInput, BrowseNodeInput, BrowseOutput } from "../../src/types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");

class FakeEgo {
  constructor(private readonly output: BrowseOutput) {}
  async browse(_input: BrowseInput) { return this.output; }
  async evaluate() { return this.output; }
  async node(_input: BrowseNodeInput) {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, mayHaveLateEffects: true };
  }
  async close() {}
  async reapExpired() {}
}

let root: string;
let config: AppConfig;
let runtime: FreeWebRuntime;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-runtime-test-"));
  config = await loadConfig({ configPath: join(root, "missing.json"), env: { FREEWEB_DATA_DIR: join(root, "data") } });
});

afterEach(async () => {
  if (runtime) await runtime.close();
  await rm(root, { recursive: true, force: true });
});

describe("FreeWebRuntime Browse output seam", () => {
  it("moves an oversized managed result into one readable Artifact", async () => {
    const browseId = randomUUID();
    runtime = new FreeWebRuntime(config, {
      ego: new FakeEgo({ browseId, spaceId: 1, status: "ok", result: { text: "x".repeat(150_000) }, pages: ["p1"] }),
    });

    const output = await runtime.browse({ action: "status", browseId, page: "p1" });

    expect(output.artifactId).toBeDefined();
    expect(output.result).toMatchObject({ summary: expect.stringContaining("Artifact"), originalChars: expect.any(Number) });
    const artifact = JSON.parse(await runtime.artifacts.readText(output.artifactId!));
    expect(artifact.result.text).toHaveLength(150_000);
  });

  it("accepts managed screenshot paths but rejects arbitrary local files", async () => {
    runtime = new FreeWebRuntime(config, { ego: new FakeEgo({ status: "ok" }) });
    const downloads = join(config.dataDir, "downloads");
    const allowed = join(downloads, "shot.png");
    await mkdir(downloads, { recursive: true });
    await writeFile(allowed, png);
    const outside = join(root, "outside.png");
    await writeFile(outside, png);

    const image = await runtime.browseScreenshot({ path: allowed });
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    await expect(runtime.browseScreenshot(outside)).rejects.toMatchObject({ code: "EGO_PATH_FORBIDDEN" });
  });
});
