import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { ArtifactOutput } from "../../src/artifacts/output.js";
import type { BrowseOutput, CrawlOutput, FetchPage } from "../../src/types.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 0, 0xff, 0xd9]);
const GIF = Buffer.from(`GIF89a${"x".repeat(20)}`);
const WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=", "base64");

let root: string;
let store: ArtifactStore;
let output: ArtifactOutput;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-artifact-output-"));
  store = new ArtifactStore({ root });
  output = new ArtifactOutput(store);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function page(formats: Record<string, unknown>, overrides: Partial<FetchPage> = {}): FetchPage {
  return { url: "https://example.com", formats, ...overrides };
}

function crawlPage(
  formats: Record<string, unknown>,
  overrides: Partial<CrawlOutput["pages"][number]> = {},
): CrawlOutput["pages"][number] {
  return { url: "https://example.com", formats, ...overrides };
}

function publishFetch(results: FetchPage[], inlinePageChars = 1000, inlineTotalChars = 1000) {
  return output.publish({ kind: "fetch", results, inlinePageChars, inlineTotalChars });
}

function publishUnrestricted(options: {
  stdout: string;
  stderr: string;
  inlineNodeChars: number;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  timedOut?: boolean;
}) {
  return output.publish({
    kind: "unrestricted-output",
    stdout: options.stdout,
    stderr: options.stderr,
    inlineNodeChars: options.inlineNodeChars,
    exitCode: options.exitCode === undefined ? 0 : options.exitCode,
    signal: options.signal === undefined ? null : options.signal,
    durationMs: options.durationMs ?? 12,
    timedOut: options.timedOut ?? false,
  });
}

describe("ArtifactOutput Fetch publication", () => {
  it("saves a data URL screenshot as binary without truncating the page", async () => {
    const result = await publishFetch([page({ screenshot: `data:image/png;base64,${PNG.toString("base64")}` })]);

    expect(result.results[0].formats).toEqual({});
    expect(result.results[0].screenshotArtifactId).toBe(result.artifactIds?.[0]);
    expect(result.results[0]).not.toHaveProperty("truncated");
    expect(result.artifactIds).toHaveLength(1);
    const saved = await store.read(result.artifactIds![0]);
    expect(saved.data).toEqual(PNG);
    expect(saved.descriptor.mimeType).toBe("image/png");
  });

  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/gif", GIF],
    ["image/webp", WEBP],
  ])("sniffs %s from a bare base64 screenshot", async (mimeType, bytes) => {
    const result = await publishFetch([page({ screenshot: bytes.toString("base64") })]);

    const saved = await store.read(result.results[0].screenshotArtifactId!);
    expect(saved.descriptor.mimeType).toBe(mimeType);
    expect(saved.data).toEqual(bytes);
  });

  it("keeps unsupported, malformed, short, and unrecognized screenshot values inline", async () => {
    const values: unknown[] = [
      { base64: PNG.toString("base64") },
      "iVBORw0KGgo=",
      "not*a*valid*base64*value",
      Buffer.from("this is not an image").toString("base64"),
      `data:image/svg+xml;base64,${PNG.toString("base64")}`,
    ];

    const result = await publishFetch(values.map((value) => page({ screenshot: value })));

    expect(result.artifactIds).toBeUndefined();
    expect(result.results.map((entry) => entry.formats.screenshot)).toEqual(values);
    expect(result.results.every((entry) => entry.screenshotArtifactId === undefined)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("counts an unrecognized screenshot toward the original inline budget", async () => {
    const unrecognized = Buffer.from("x".repeat(40)).toString("base64");

    const result = await publishFetch([page({ screenshot: unrecognized })], 10, 10);

    expect(result.results[0].formats.screenshot).toBe(unrecognized.slice(0, 10));
    expect(result.results[0].screenshotArtifactId).toBeUndefined();
    expect(result.results[0].truncated).toBe(true);
    expect(result.artifactIds).toHaveLength(1);
    expect(JSON.parse(await store.readText(result.artifactIds![0])).formats.screenshot).toBe(unrecognized);
  });

  it("saves the complete extracted page before truncation and orders screenshot then page IDs", async () => {
    const original = page(
      { markdown: "x".repeat(30), screenshot: `data:image/png;base64,${PNG.toString("base64")}` },
      { title: "Complete page", provider: "firecrawl-local" },
    );

    const result = await publishFetch([original], 8, 8);

    expect(result.artifactIds).toHaveLength(2);
    const [screenshotId, pageId] = result.artifactIds!;
    expect(result.results[0].screenshotArtifactId).toBe(screenshotId);
    expect(result.results[0].formats).toEqual({ markdown: "x".repeat(8) });
    expect(result.results[0].truncated).toBe(true);
    expect((await store.read(screenshotId)).data).toEqual(PNG);
    const completePage = {
      ...original,
      formats: { markdown: "x".repeat(30) },
      screenshotArtifactId: screenshotId,
    };
    expect(await store.readText(pageId)).toBe(JSON.stringify(completePage));
    expect((await store.read(pageId)).descriptor.mimeType).toBe("application/json");
  });

  it("does not truncate a page whose original length exactly fits", async () => {
    const result = await publishFetch([page({ markdown: "x".repeat(10) })], 10, 10);

    expect(result.results[0].formats.markdown).toBe("x".repeat(10));
    expect(result.results[0]).not.toHaveProperty("truncated");
    expect(result.artifactIds).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("preserves formats insertion order and string versus structured truncation", async () => {
    const formats = { markdown: "abcd", html: "ef", json: { ok: true } };

    const result = await publishFetch([page(formats)], 4, 4);

    expect(Object.keys(result.results[0].formats)).toEqual(["markdown", "html", "json"]);
    expect(result.results[0].formats).toEqual({ markdown: "abcd", html: "", json: "" });
    expect(JSON.parse(await store.readText(result.artifactIds![0])).formats).toEqual(formats);
  });

  it("keeps a structured format that exactly fits the remaining page budget", async () => {
    const links = ["https://example.com/overflow"];

    const result = await publishFetch([page({ markdown: "abc", json: { a: 1 } }, { links })], 10, 10);

    expect(result.results[0].formats).toEqual({ markdown: "abc", json: { a: 1 } });
    expect(result.results[0].links).toEqual([]);
    expect(result.results[0].truncated).toBe(true);
    expect(JSON.parse(await store.readText(result.artifactIds![0])).links).toEqual(links);
  });

  it("converts a structured format to a serialized prefix when it overflows", async () => {
    const result = await publishFetch([page({ markdown: "abc", json: { a: 1 } })], 9, 9);

    expect(result.results[0].formats.markdown).toBe("abc");
    expect(result.results[0].formats.json).toBe(JSON.stringify({ a: 1 }).slice(0, 6));
    expect(typeof result.results[0].formats.json).toBe("string");
  });

  it.each([
    [14, ["aa", "bbbb"]],
    [13, ["aa"]],
  ])("uses the links 2 + sum(length + 3) prefix estimate at budget %i", async (budget, expected) => {
    const links = ["aa", "bbbb", "c"];

    const result = await publishFetch([page({}, { links })], budget, budget);

    expect(result.results[0].links).toEqual(expected);
    expect(result.results[0].truncated).toBe(true);
    expect(JSON.parse(await store.readText(result.artifactIds![0])).links).toEqual(links);
  });

  it("keeps independent total budgets for concurrent publications", async () => {
    const request = (name: string) => [
      page({ markdown: "x".repeat(8) }, { url: `https://example.com/${name}/first` }),
      page({ markdown: "y".repeat(8) }, { url: `https://example.com/${name}/second` }),
    ];

    const [first, second] = await Promise.all([
      publishFetch(request("a"), 20, 10),
      publishFetch(request("b"), 20, 10),
    ]);

    for (const result of [first, second]) {
      expect(result.results[0].formats.markdown).toBe("x".repeat(8));
      expect(result.results[0]).not.toHaveProperty("truncated");
      expect(result.results[1].formats.markdown).toBe("y".repeat(2));
      expect(result.results[1].truncated).toBe(true);
      expect(result.artifactIds).toHaveLength(1);
      expect(JSON.parse(await store.readText(result.artifactIds![0])).formats.markdown).toBe("y".repeat(8));
    }
  });
});

describe("ArtifactOutput Crawl preview", () => {
  it("previews only the requested page slice without saving an Artifact", async () => {
    const pages = [0, 1, 2, 3].map((index) => crawlPage(
      { markdown: `page-${index}` },
      { url: `https://example.com/${index}` },
    ));

    const result = await output.publish({
      kind: "crawl-preview",
      pages,
      offset: 1,
      limit: 2,
      maxCharsPerPage: 100,
      inlineTotalChars: 100,
    });

    expect(result.pages.map((entry) => entry.url)).toEqual(["https://example.com/1", "https://example.com/2"]);
    expect(result.inlineBudgetHit).toBe(false);
    expect(result.pages.every((entry) => entry.truncated === undefined)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("preserves formats insertion order and structured JSON prefixes when the total budget runs out", async () => {
    const json = { ok: true, nested: { value: 1 } };

    const result = await output.publish({
      kind: "crawl-preview",
      pages: [crawlPage({ markdown: "abc", json, html: "tail" })],
      offset: 0,
      limit: 1,
      maxCharsPerPage: 10,
      inlineTotalChars: 8,
    });

    expect(Object.keys(result.pages[0].formats)).toEqual(["markdown", "json", "html"]);
    expect(result.pages[0].formats).toEqual({
      markdown: "abc",
      json: JSON.stringify(json).slice(0, 5),
      html: "",
    });
    expect(result.pages[0].truncated).toBe(true);
    expect(result.inlineBudgetHit).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("keeps a structured format that exactly fits without reporting a budget hit", async () => {
    const json = { a: 1 };

    const result = await output.publish({
      kind: "crawl-preview",
      pages: [crawlPage({ markdown: "abc", json })],
      offset: 0,
      limit: 1,
      maxCharsPerPage: 10,
      inlineTotalChars: 10,
    });

    expect(result.pages[0].formats).toEqual({ markdown: "abc", json });
    expect(result.pages[0]).not.toHaveProperty("truncated");
    expect(result.inlineBudgetHit).toBe(false);
  });

  it("stops after the inline total is exhausted and reports the budget hit", async () => {
    const pages = [
      crawlPage({ markdown: "a".repeat(5) }, { url: "https://example.com/a" }),
      crawlPage({ markdown: "b".repeat(5) }, { url: "https://example.com/b" }),
    ];

    const result = await output.publish({
      kind: "crawl-preview",
      pages,
      offset: 0,
      limit: 2,
      maxCharsPerPage: 100,
      inlineTotalChars: 5,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].formats.markdown).toBe("a".repeat(5));
    expect(result.inlineBudgetHit).toBe(true);
  });

  it("reports an exhausted budget before any page when the total is zero", async () => {
    const result = await output.publish({
      kind: "crawl-preview",
      pages: [crawlPage({ markdown: "content" })],
      offset: 0,
      limit: 1,
      maxCharsPerPage: 100,
      inlineTotalChars: 0,
    });

    expect(result.pages).toEqual([]);
    expect(result.inlineBudgetHit).toBe(true);
  });

  it("keeps a concurrent Crawl preview and Fetch publication budget-independent", async () => {
    const crawlPages = [
      crawlPage({ markdown: "c".repeat(8) }, { url: "https://example.com/crawl/a" }),
      crawlPage({ markdown: "d".repeat(8) }, { url: "https://example.com/crawl/b" }),
    ];
    const fetchPages = [
      page({ markdown: "x".repeat(8) }, { url: "https://example.com/fetch/a" }),
      page({ markdown: "y".repeat(8) }, { url: "https://example.com/fetch/b" }),
    ];

    const [preview, publication] = await Promise.all([
      output.publish({
        kind: "crawl-preview",
        pages: crawlPages,
        offset: 0,
        limit: 2,
        maxCharsPerPage: 20,
        inlineTotalChars: 10,
      }),
      publishFetch(fetchPages, 20, 10),
    ]);

    expect(preview.pages[0].formats.markdown).toBe("c".repeat(8));
    expect(preview.pages[1].formats.markdown).toBe("d".repeat(2));
    expect(preview.inlineBudgetHit).toBe(true);
    expect(publication.results[0].formats.markdown).toBe("x".repeat(8));
    expect(publication.results[1].formats.markdown).toBe("y".repeat(2));
    expect(publication.results[1].truncated).toBe(true);
    expect(publication.artifactIds).toHaveLength(1);

    const saved = await store.list();
    expect(saved).toHaveLength(1);
    expect(await store.readText(saved[0].id)).toBe(JSON.stringify(fetchPages[1]));
  });
});

describe("ArtifactOutput Crawl checkpoint", () => {
  it("saves the exact complete checkpoint bytes as an untruncated JSON Artifact", async () => {
    const source = {
      crawlId: "crawl-1",
      status: "completed",
      pages: [{ url: "https://example.com/full", formats: { markdown: "x".repeat(500) } }],
      artifactId: undefined,
      artifactExpiresAt: undefined,
    };

    const descriptor = await output.publish({ kind: "crawl-checkpoint", source });
    const expected = "{"
      + '"crawlId":"crawl-1",'
      + '"status":"completed",'
      + '"pages":[{"url":"https://example.com/full","formats":{"markdown":' + JSON.stringify("x".repeat(500)) + "}}]"
      + "}";

    expect(descriptor.mimeType).toBe("application/json");
    expect(descriptor.size).toBe(Buffer.byteLength(expected));
    expect(await store.readText(descriptor.id)).toBe(expected);
    expect((await store.read(descriptor.id)).descriptor.id).toBe(descriptor.id);
    expect(JSON.parse(expected)).not.toHaveProperty("artifactId");
    expect(JSON.parse(expected)).not.toHaveProperty("artifactExpiresAt");
  });
});

function browseOutput(overrides: Partial<BrowseOutput> = {}): BrowseOutput {
  return { browseId: "11111111-1111-4111-8111-111111111111", spaceId: 7, status: "ok", pages: ["p1"], ...overrides };
}

async function writeHandoff(text: string): Promise<string> {
  const path = join(root, "managed-results", "hand-off.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
  return path;
}

describe("ArtifactOutput managed hand-off publication", () => {
  it("stores the complete hand-off file, deletes it, and rewrites the payload summary", async () => {
    const full = JSON.stringify({ ok: true, blob: "x".repeat(64), pages: ["p1"] });
    const sourcePath = await writeHandoff(full);
    const payload: Record<string, unknown> = {
      ok: true,
      truncated: true,
      artifactPath: sourcePath,
      artifactBytes: full.length,
      // Page-visible result data: the stored Artifact replaces it, it never becomes a link.
      value: { artifactId: "page-supplied-artifact-id" },
    };

    const result = await output.publish({ kind: "managed-handoff", payload, sourcePath });

    expect(result.payload).toBe(payload);
    expect(payload).not.toHaveProperty("artifactPath");
    expect(payload).not.toHaveProperty("artifactBytes");
    const artifactId = payload.handoffArtifactId as string;
    expect(artifactId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(payload.value).toEqual({ truncated: true, bytes: full.length, artifactId });
    expect(payload.value).not.toEqual({ artifactId: "page-supplied-artifact-id" });

    const saved = await store.read(artifactId);
    expect(saved.descriptor.mimeType).toBe("application/json");
    expect(saved.descriptor.size).toBe(full.length);
    expect(saved.data.toString("utf8")).toBe(full);
    // The hand-off copy never outlives a successful save.
    await expect(stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to the stored size and a false truncated flag when the summary omits them", async () => {
    const full = JSON.stringify({ ok: true, blob: "y".repeat(32), pages: [] });
    const sourcePath = await writeHandoff(full);
    const payload: Record<string, unknown> = { ok: true, artifactPath: sourcePath };

    await output.publish({ kind: "managed-handoff", payload, sourcePath });

    const artifactId = payload.handoffArtifactId as string;
    expect(payload.value).toEqual({ truncated: false, bytes: Buffer.byteLength(full), artifactId });
  });

  it("propagates the raw save error unchanged and still removes the hand-off file", async () => {
    const failure = new Error("disk full");
    const failing = {
      save: async () => { throw failure; },
      saveFile: async () => { throw failure; },
    } as unknown as ArtifactStore;
    const failingOutput = new ArtifactOutput(failing);
    const full = JSON.stringify({ ok: true, blob: "z".repeat(32), pages: [] });
    const sourcePath = await writeHandoff(full);
    const payload: Record<string, unknown> = {
      ok: true,
      truncated: true,
      artifactPath: sourcePath,
      artifactBytes: full.length,
    };

    // A raw error is what lets the provider decide the policy code (EGO_ARTIFACT_FAILED).
    await expect(failingOutput.publish({ kind: "managed-handoff", payload, sourcePath })).rejects.toBe(failure);
    await expect(stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(payload).not.toHaveProperty("handoffArtifactId");
  });
});

describe("ArtifactOutput managed Browse output publication", () => {
  it("leaves an output that exactly fits the inline budget untouched without saving", async () => {
    const value = browseOutput({ result: { text: "x".repeat(40) } });
    const inlineTotalChars = JSON.stringify(value).length;

    const result = await output.publish({ kind: "managed-output", output: value, inlineTotalChars });

    expect(result.output).toBe(value);
    expect(await store.list()).toEqual([]);
  });

  it("saves the complete output including an existing hand-off ID and replaces the result", async () => {
    const handoffArtifactId = "22222222-2222-4222-8222-222222222222";
    const value = browseOutput({
      artifactId: handoffArtifactId,
      result: { text: "x".repeat(500), nested: { artifactId: "page-supplied-artifact-id" } },
    });
    const serialized = JSON.stringify(value);

    const result = await output.publish({ kind: "managed-output", output: value, inlineTotalChars: serialized.length - 1 });

    expect(result.output.artifactId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.output.result).toEqual({
      summary: "Large Browse result is available as an Artifact",
      artifactId: result.output.artifactId,
      originalChars: serialized.length,
    });
    // Everything else from the original output survives the rewrite.
    expect(result.output.browseId).toBe(value.browseId);
    expect(result.output.spaceId).toBe(7);
    expect(result.output.status).toBe("ok");
    expect(result.output.pages).toEqual(["p1"]);

    const descriptors = await store.list();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].id).toBe(result.output.artifactId);
    expect(descriptors[0].mimeType).toBe("application/json");
    expect(await store.readText(descriptors[0].id)).toBe(serialized);
    // The stored copy is the pre-rewrite output, so the hand-off ID is not lost.
    expect(JSON.parse(await store.readText(descriptors[0].id)).artifactId).toBe(handoffArtifactId);
  });

  it("does not promote a page-supplied Artifact ID when an output is published", async () => {
    const value = browseOutput({ result: { artifactId: "page-supplied-artifact-id", text: "x".repeat(200) } });
    const serialized = JSON.stringify(value);

    const result = await output.publish({ kind: "managed-output", output: value, inlineTotalChars: serialized.length - 1 });

    // The returned link is the Artifact this publication stored, not the page value.
    expect(result.output.artifactId).not.toBe("page-supplied-artifact-id");
    expect(result.output.result).toMatchObject({ artifactId: result.output.artifactId });
    expect(JSON.parse(await store.readText(result.output.artifactId!)).result.artifactId).toBe("page-supplied-artifact-id");
  });
});

describe("ArtifactOutput unrestricted output publication", () => {
  it("always saves short streams and a clean exit, with the default retention", async () => {
    const result = await publishUnrestricted({ stdout: "out\n", stderr: "", inlineNodeChars: 100 });
    const expected = JSON.stringify({
      stdout: "out\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 12,
      timedOut: false,
    });

    expect(result).toEqual({ stdout: "out\n", stderr: "", artifactId: expect.any(String) });
    const descriptors = await store.list();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].mimeType).toBe("application/json");
    expect(descriptors[0].size).toBe(Buffer.byteLength(expected));
    expect(await store.readText(result.artifactId)).toBe(expected);
    expect(Date.parse(descriptors[0].expiresAt) - Date.parse(descriptors[0].createdAt)).toBe(86_400_000);
  });

  it("returns streams unchanged when their lengths exactly fit the budget", async () => {
    const exact = await publishUnrestricted({
      stdout: "a".repeat(5),
      stderr: "b".repeat(5),
      inlineNodeChars: 10,
    });

    expect(exact.stdout).toBe("a".repeat(5));
    expect(exact.stderr).toBe("b".repeat(5));
    expect(exact.stdout).not.toContain("[truncated]");
    expect(exact.stderr).not.toContain("[truncated]");
  });

  it("saves the exact complete JSON bytes and metadata before bounding the preview", async () => {
    const stdout = "x".repeat(5000);
    const stderr = "y".repeat(3000);
    const result = await publishUnrestricted({
      stdout,
      stderr,
      exitCode: null,
      signal: "SIGKILL",
      durationMs: 999,
      timedOut: true,
      inlineNodeChars: 100,
    });
    const expected = JSON.stringify({
      stdout,
      stderr,
      exitCode: null,
      signal: "SIGKILL",
      durationMs: 999,
      timedOut: true,
    });

    const saved = await store.read(result.artifactId);
    expect(saved.descriptor.mimeType).toBe("application/json");
    expect(saved.descriptor.size).toBe(Buffer.byteLength(expected));
    expect(saved.data.toString("utf8")).toBe(expected);
    expect(await store.readText(result.artifactId)).toBe(expected);
    expect(JSON.parse(expected)).toEqual({
      stdout,
      stderr,
      exitCode: null,
      signal: "SIGKILL",
      durationMs: 999,
      timedOut: true,
    });
  });

  it("splits an overflowing budget into equal halves for two long streams", async () => {
    const result = await publishUnrestricted({
      stdout: "x".repeat(5000),
      stderr: "y".repeat(5000),
      inlineNodeChars: 100,
    });

    expect(result.stdout).toBe(`${"x".repeat(38)}\n[truncated]`);
    expect(result.stderr).toBe(`${"y".repeat(38)}\n[truncated]`);
    expect(result.stdout.length).toBe(50);
    expect(result.stderr.length).toBe(50);
    expect(result.stdout.length + result.stderr.length).toBe(100);
  });

  it("transfers a short stream's half to the long stream", async () => {
    const shortStdout = await publishUnrestricted({
      stdout: "ok\n",
      stderr: "y".repeat(4000),
      inlineNodeChars: 1000,
    });

    expect(shortStdout.stdout).toBe("ok\n");
    expect(shortStdout.stderr).toBe(`${"y".repeat(985)}\n[truncated]`);
    expect(shortStdout.stdout.length + shortStdout.stderr.length).toBe(1000);

    const shortStderr = await publishUnrestricted({
      stdout: "x".repeat(4000),
      stderr: "bad\n",
      inlineNodeChars: 1000,
    });

    // The spare goes to stdout first, so stderr's unused half does not come back to it.
    expect(shortStderr.stdout).toBe(`${"x".repeat(984)}\n[truncated]`);
    expect(shortStderr.stderr).toBe("bad\n");
    expect(shortStderr.stdout.length + shortStderr.stderr.length).toBe(1000);
  });

  it("keeps the full marker and the exact odd total budget", async () => {
    const result = await publishUnrestricted({
      stdout: "x".repeat(100),
      stderr: "y".repeat(100),
      inlineNodeChars: 101,
    });

    // The odd character goes to stderr first because stdoutLimit is floored.
    expect(result.stdout).toBe(`${"x".repeat(38)}\n[truncated]`);
    expect(result.stderr).toBe(`${"y".repeat(39)}\n[truncated]`);
    expect(result.stdout.length).toBe(50);
    expect(result.stderr.length).toBe(51);
    expect(result.stdout.length + result.stderr.length).toBe(101);
  });

  it("never exceeds a budget smaller than the truncation marker", async () => {
    const result = await publishUnrestricted({
      stdout: "x".repeat(50),
      stderr: "y".repeat(50),
      inlineNodeChars: 8,
    });

    expect(result.stdout).toBe("\n[tr");
    expect(result.stderr).toBe("\n[tr");
    expect(result.stdout.length + result.stderr.length).toBe(8);
  });

  it("propagates a save failure before returning any preview", async () => {
    const failure = new Error("disk full");
    const failingOutput = new ArtifactOutput({
      save: async () => { throw failure; },
    } as unknown as ArtifactStore);

    await expect(failingOutput.publish({
      kind: "unrestricted-output",
      stdout: "x".repeat(50),
      stderr: "y".repeat(50),
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      inlineNodeChars: 10,
    })).rejects.toBe(failure);
  });

  it("keeps concurrent Unrestricted, Managed and Fetch budgets independent", async () => {
    const managed = browseOutput({ result: { text: "m".repeat(100) } });
    const serializedManaged = JSON.stringify(managed);
    const fetchPages = [
      page({ markdown: "x".repeat(8) }, { url: "https://example.com/fetch/a" }),
      page({ markdown: "y".repeat(8) }, { url: "https://example.com/fetch/b" }),
    ];

    const [unrestrictedResult, managedResult, fetchResult] = await Promise.all([
      publishUnrestricted({
        stdout: "u".repeat(40),
        stderr: "v".repeat(40),
        inlineNodeChars: 40,
      }),
      output.publish({
        kind: "managed-output",
        output: managed,
        inlineTotalChars: serializedManaged.length - 1,
      }),
      publishFetch(fetchPages, 20, 10),
    ]);

    expect(unrestrictedResult.stdout).toBe(`${"u".repeat(8)}\n[truncated]`);
    expect(unrestrictedResult.stderr).toBe(`${"v".repeat(8)}\n[truncated]`);
    expect(unrestrictedResult.stdout.length + unrestrictedResult.stderr.length).toBe(40);
    expect(managedResult.output.artifactId).toBeDefined();
    expect(managedResult.output.result).toMatchObject({
      summary: "Large Browse result is available as an Artifact",
      originalChars: serializedManaged.length,
    });
    expect(fetchResult.results[0].formats.markdown).toBe("x".repeat(8));
    expect(fetchResult.results[0]).not.toHaveProperty("truncated");
    expect(fetchResult.results[1].formats.markdown).toBe("y".repeat(2));
    expect(fetchResult.results[1].truncated).toBe(true);

    const artifactIds = [
      unrestrictedResult.artifactId,
      managedResult.output.artifactId!,
      fetchResult.artifactIds![0],
    ];
    expect(new Set(artifactIds).size).toBe(3);
    expect(await store.list()).toHaveLength(3);
    expect(await store.readText(unrestrictedResult.artifactId)).toBe(JSON.stringify({
      stdout: "u".repeat(40),
      stderr: "v".repeat(40),
      exitCode: 0,
      signal: null,
      durationMs: 12,
      timedOut: false,
    }));
    expect(await store.readText(managedResult.output.artifactId!)).toBe(serializedManaged);
    expect(await store.readText(fetchResult.artifactIds![0])).toBe(JSON.stringify(fetchPages[1]));
  });
});

describe("ArtifactOutput Map publication", () => {
  it("returns every link without an Artifact when the size exactly fits", async () => {
    const links = [{ url: "https://example.com/a" }, { url: "https://example.com/b" }];
    const inlineTotalChars = 20 + links.reduce((sum, link) => sum + link.url.length + 20, 0);

    const result = await output.publish({ kind: "map", links, inlineTotalChars });

    expect(result).toEqual({ links, truncated: false });
    expect(await store.list()).toEqual([]);
  });

  it("saves one complete Map Artifact and returns the inline prefix on overflow", async () => {
    const links = [{ url: "https://example.com/a" }, { url: "https://example.com/b" }];
    const inlineTotalChars = 20 + links.reduce((sum, link) => sum + link.url.length + 20, 0) - 1;

    const result = await output.publish({ kind: "map", links, inlineTotalChars });

    expect(result.links).toEqual([links[0]]);
    expect(result.truncated).toBe(true);
    expect(result.artifactId).toBeDefined();
    expect(await store.readText(result.artifactId!)).toBe(JSON.stringify({ links }));
    expect((await store.read(result.artifactId!)).descriptor.mimeType).toBe("application/json");
    expect(await store.list()).toHaveLength(1);
  });
});
