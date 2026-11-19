import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { toolSuccess } from "../../src/mcp/results.js";

let root: string;
let artifacts: ArtifactStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-results-test-"));
  artifacts = new ArtifactStore({ root });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("MCP Artifact resource links", () => {
  it("uses the Artifact's real image MIME type instead of application/json", async () => {
    const saved = await artifacts.save({ data: Buffer.from([137, 80, 78, 71]), mimeType: "image/png" });

    const result = await toolSuccess({ artifactId: saved.id }, [saved.id], artifacts);

    expect(result.content).toContainEqual(expect.objectContaining({
      type: "resource_link",
      uri: saved.uri,
      mimeType: "image/png",
    }));
  });

  it("keeps JSON Artifact links as application/json", async () => {
    const saved = await artifacts.save({ data: JSON.stringify({ ok: true }), mimeType: "application/json" });

    const result = await toolSuccess({ artifactId: saved.id }, [saved.id], artifacts);

    expect(result.content).toContainEqual(expect.objectContaining({
      type: "resource_link",
      mimeType: "application/json",
    }));
  });
});
