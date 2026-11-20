import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { FreeWebError } from "../../src/errors.js";
import { ManagedBrowseToolCall } from "../../src/mcp/managed-browse-tool-call.js";
import type { BrowseInput, BrowseOutput } from "../../src/types.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let root: string;
let dataDir: string;
let downloads: string;
let artifacts: ArtifactStore;
let temporaryScreenshots: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-managed-browse-test-"));
  dataDir = join(root, "data");
  downloads = join(dataDir, "downloads");
  await mkdir(downloads, { recursive: true });
  artifacts = new ArtifactStore({ root: dataDir });
  temporaryScreenshots = [];
});

afterEach(async () => {
  await Promise.all(temporaryScreenshots.map((path) => rm(path, { force: true })));
  await rm(root, { recursive: true, force: true });
});

function screenshotInput(method = "page.screenshot"): BrowseInput {
  return { action: "call", method, args: [], page: "p1" };
}

function source(output: BrowseOutput) {
  return vi.fn(async (_input: BrowseInput): Promise<BrowseOutput> => output);
}

function tool(browse: ReturnType<typeof source>, screenshotMaxBytes = png.length) {
  return new ManagedBrowseToolCall({ browse, artifacts, dataDir, screenshotMaxBytes });
}

function parsedText(result: CallToolResult): unknown {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  if (block?.type !== "text") throw new Error("Expected a text block");
  return JSON.parse(block.text);
}

function structured(result: CallToolResult): BrowseOutput {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as BrowseOutput;
}

async function temporaryScreenshot(data = png): Promise<string> {
  const path = join(tmpdir(), `ego-browser-shot-${randomUUID()}.png`);
  temporaryScreenshots.push(path);
  await writeFile(path, data);
  return path;
}

describe("ManagedBrowseToolCall", () => {
  it.each(["page.screenshot", "screenshot"])("enriches the canonical screenshot method and its alias: %s", async (method) => {
    const path = await temporaryScreenshot();
    const browse = source({ status: "ok", result: path });
    const input = screenshotInput(method);

    const result = await tool(browse).run(input);

    expect(browse).toHaveBeenCalledWith(input);
    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  });

  it("accepts an object screenshot result under the managed downloads root", async () => {
    const path = join(downloads, "object-result.png");
    await writeFile(path, png);

    const result = await tool(source({ status: "ok", result: { path } })).run(screenshotInput());

    expect(result.content[1]).toMatchObject({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  });

  it.each([
    { action: "status", method: "page.screenshot", page: "p1" },
    { action: "call", method: "page.title", args: [], page: "p1" },
  ] as BrowseInput[])("does not attempt screenshot enrichment for non-matching input: %o", async (input) => {
    const browse = source({ status: "ok", result: join(downloads, "missing.png") });

    const result = await tool(browse).run(input);

    expect(browse).toHaveBeenCalledWith(input);
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toEqual({ status: "ok", result: join(downloads, "missing.png") });
  });

  it.each([
    "shot.jpg",
    { path: "shot.jpeg" },
    { path: 42 },
    42,
    null,
    ["shot.png"],
  ])("ignores non-PNG and unrecognized result candidates: %o", async (candidate) => {
    const result = await tool(source({ status: "ok", result: candidate })).run(screenshotInput());

    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toEqual({ status: "ok", result: candidate });
    expect(await artifacts.list()).toHaveLength(0);
  });

  it("degrades a missing screenshot to a warning", async () => {
    const path = join(downloads, "missing.png");

    const result = await tool(source({ status: "ok", result: path })).run(screenshotInput());

    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
    expect(structured(result).warnings).toHaveLength(1);
    expect(structured(result).warnings?.[0]).toMatch(/^Screenshot unavailable: .*ENOENT/);
  });

  it("degrades an outside screenshot path with the managed-path warning", async () => {
    const path = join(root, "outside.png");
    await writeFile(path, png);

    const result = await tool(source({ status: "ok", result: path })).run(screenshotInput());

    expect(result.isError).not.toBe(true);
    expect(structured(result).warnings).toEqual([
      "Screenshot unavailable: Screenshot path is outside managed downloads and ego temporary screenshots",
    ]);
  });

  it("rejects a downloads symlink that escapes to an outside file", async () => {
    const outside = join(root, "outside.png");
    const path = join(downloads, "escape.png");
    await writeFile(outside, png);
    await symlink(outside, path);

    const result = await tool(source({ status: "ok", result: path })).run(screenshotInput());

    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
    expect(structured(result).warnings).toEqual([
      "Screenshot unavailable: Screenshot path is outside managed downloads and ego temporary screenshots",
    ]);
    expect(await artifacts.list()).toHaveLength(0);
  });

  it("inlines a screenshot exactly at the byte threshold without saving an Artifact", async () => {
    const path = join(downloads, "threshold.png");
    await writeFile(path, png);

    const result = await tool(source({ status: "ok", result: path }), png.length).run(screenshotInput());

    expect(result.content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    expect(await artifacts.list()).toHaveLength(0);
  });

  it("saves a screenshot over the threshold as one image Artifact with the existing link", async () => {
    const bytes = Buffer.concat([png, Buffer.from("overflow")]);
    const path = join(downloads, "large.png");
    await writeFile(path, bytes);

    const result = await tool(source({ status: "ok", result: path }), png.length).run(screenshotInput());

    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(2);
    const link = result.content[1];
    expect(link).toMatchObject({
      type: "resource_link",
      name: "ego-lite screenshot",
      description: "Screenshot exceeded the inline image budget",
      mimeType: "image/png",
    });
    if (link?.type !== "resource_link") throw new Error("Expected a screenshot resource link");
    const id = link.uri.slice("freeweb://artifacts/".length);
    const saved = await artifacts.read(id);
    expect(saved.descriptor.mimeType).toBe("image/png");
    expect(saved.data).toEqual(bytes);
    expect(await artifacts.list()).toHaveLength(1);
    expect(result.structuredContent).toEqual({ status: "ok", result: path });
    expect(JSON.stringify(result.structuredContent)).not.toContain(id);
  });

  it("returns source failure as toolFailure without creating screenshot output", async () => {
    const browse = vi.fn(async (_input: BrowseInput): Promise<BrowseOutput> => {
      throw new FreeWebError("EGO_DOWN", "source failed", { provider: "ego-lite" });
    });

    const result = await tool(browse).run(screenshotInput());

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(parsedText(result)).toMatchObject({
      error: { code: "EGO_DOWN", message: "source failed", provider: "ego-lite" },
    });
    expect(result.structuredContent).toBeUndefined();
    expect(await artifacts.list()).toHaveLength(0);
  });

  it("appends screenshot warnings after existing warnings and keeps text and structuredContent in agreement", async () => {
    const path = join(downloads, "missing.png");
    const browse = source({ status: "ok", result: path, warnings: ["provider warning", "bounded-output warning"] });

    const result = await tool(browse).run(screenshotInput());

    expect(result.isError).not.toBe(true);
    expect(structured(result).warnings?.slice(0, 2)).toEqual(["provider warning", "bounded-output warning"]);
    expect(structured(result).warnings).toHaveLength(3);
    expect(structured(result).warnings?.[2]).toMatch(/^Screenshot unavailable: /);
    expect(parsedText(result)).toEqual(result.structuredContent);
  });

  it("orders text, output Artifact links, then the screenshot and excludes its ID from structuredContent", async () => {
    const outputArtifact = await artifacts.save({ data: JSON.stringify({ complete: true }), mimeType: "application/json" });
    const path = join(downloads, "large-with-output.png");
    await writeFile(path, Buffer.concat([png, Buffer.from("overflow")]));
    const browse = source({ status: "ok", result: path, artifactId: outputArtifact.id });

    const result = await tool(browse).run(screenshotInput());

    expect(result.content.map((block) => block.type)).toEqual(["text", "resource_link", "resource_link"]);
    expect(parsedText(result)).toEqual(result.structuredContent);
    expect(result.content[1]).toMatchObject({ uri: outputArtifact.uri, mimeType: "application/json" });
    const screenshotLink = result.content[2];
    if (screenshotLink?.type !== "resource_link") throw new Error("Expected a screenshot resource link");
    const screenshotId = screenshotLink.uri.slice("freeweb://artifacts/".length);
    expect(screenshotId).not.toBe(outputArtifact.id);
    expect(result.structuredContent).toEqual({ status: "ok", result: path, artifactId: outputArtifact.id });
    expect(JSON.stringify(result.structuredContent)).not.toContain(screenshotId);
    expect(await artifacts.list()).toHaveLength(2);
  });
});
