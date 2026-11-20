import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { ArtifactOutput } from "../../src/artifacts/output.js";
import { CrawlManager } from "../../src/crawl/crawl-manager.js";
import type { CrawlJobAdapter, CrawlJobSnapshot } from "../../src/crawl/crawl-job-adapter.js";
import { FreeWebError } from "../../src/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { FreeWebToolHandlers } from "../../src/mcp/runtime-interface.js";
import type { BrowseInput, CrawlInput, CrawlStatusInput, SearchInput } from "../../src/types.js";

class FakeCrawlAdapter implements CrawlJobAdapter {
  snapshot: CrawlJobSnapshot = { status: "scraping", total: 0, completed: 0, pages: [], errors: [] };
  starts = 0;

  async startCrawl(_input: CrawlInput) { this.starts++; return { id: "provider-job-1" }; }
  async getCrawl(_providerJobId: string) { return this.snapshot; }
  async cancelCrawl(_providerJobId: string) { this.snapshot = { ...this.snapshot, status: "cancelled" }; }
}

class FakeRuntime implements FreeWebToolHandlers {
  artifacts!: ArtifactStore;
  unrestricted = false;
  searchInput?: SearchInput;

  async search(input: SearchInput) {
    this.searchInput = input;
    return {
      provider: "tinyfish" as const,
      query: input.query,
      results: [{ position: 1, title: "Result", url: "https://example.com", snippet: "snippet" }],
      attempts: [{ provider: "tinyfish" as const, outcome: "success" as const, durationMs: 1 }],
      warnings: [],
      partial: false,
    };
  }
  async fetch(): Promise<any> { throw new FreeWebError("FETCH_DOWN", "fetch unavailable"); }
  async map(): Promise<any> { throw new Error("not used"); }
  async crawl(_input: CrawlInput): Promise<any> { throw new Error("not used"); }
  async crawlStatus(_input: CrawlStatusInput): Promise<any> { throw new Error("not used"); }
  async crawlCancel(_input: { crawlId: string }): Promise<any> { throw new Error("not used"); }
  async managedBrowseToolCall(_input: BrowseInput): Promise<CallToolResult> { throw new Error("not used"); }
  async browseEvaluate(): Promise<any> { throw new Error("not used"); }
  async browseNode() {
    return { exitCode: 0, stdout: "", stderr: "ok", durationMs: 1, timedOut: false, mayHaveLateEffects: false };
  }
}

let root: string;
let runtime: FakeRuntime;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-mcp-test-"));
  runtime = new FakeRuntime();
  runtime.artifacts = new ArtifactStore({ root });
  server = createMcpServer(runtime);
  client = new Client({ name: "freeweb-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("MCP public protocol seam", () => {
  it("lists eight tools by default and passes parsed Search defaults", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "search", "fetch", "map", "crawl", "crawl_status", "crawl_cancel", "browse", "browse_evaluate",
    ]);
    expect(listed.tools.some((tool) => tool.name === "browse_node")).toBe(false);

    const result = await client.callTool({ name: "search", arguments: { query: "MCP" } });
    expect(result.isError).not.toBe(true);
    expect(runtime.searchInput?.limit).toBe(10);
    expect(result.structuredContent).toMatchObject({ provider: "tinyfish", query: "MCP" });
  });

  it("returns tool errors for invalid input and provider failure", async () => {
    const invalid = await client.callTool({ name: "search", arguments: { query: "MCP", limit: 999 } });
    expect(invalid.isError).toBe(true);

    const failed = await client.callTool({ name: "fetch", arguments: { urls: ["https://example.com"] } });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain("FETCH_DOWN");
  });

  it("registers unrestricted Node only on opt-in and marks non-zero exits as tool errors", async () => {
    await client.close();
    await server.close();
    runtime.unrestricted = true;
    runtime.browseNode = async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "script failed",
      durationMs: 1,
      timedOut: false,
      mayHaveLateEffects: true,
    });
    server = createMcpServer(runtime);
    client = new Client({ name: "freeweb-unrestricted-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.some((tool) => tool.name === "browse_node")).toBe(true);
    const result = await client.callTool({ name: "browse_node", arguments: { script: "process.exit(2)" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ exitCode: 2, mayHaveLateEffects: true });
  });

  it("returns a generic Managed Browse result unchanged", async () => {
    const output = { status: "ok", result: "done" };
    runtime.managedBrowseToolCall = async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    });

    const result = await client.callTool({
      name: "browse",
      arguments: { action: "status" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(output) }]);
    expect(result.structuredContent).toEqual(output);
  });

  it("presents a Managed Browse source error as a tool error", async () => {
    const failure = { error: { code: "EGO_DOWN", message: "source failed", provider: "ego-lite" } };
    runtime.managedBrowseToolCall = async () => ({
      content: [{ type: "text", text: JSON.stringify(failure) }],
      isError: true,
    });

    const result = await client.callTool({
      name: "browse",
      arguments: { action: "status" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("EGO_DOWN");
    expect(result.structuredContent).toBeUndefined();
  });

  it("presents an already-generated screenshot warning without failing Browse", async () => {
    const output = { status: "ok", warnings: ["Screenshot unavailable: ENOENT"] };
    runtime.managedBrowseToolCall = async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    });

    const result = await client.callTool({
      name: "browse",
      arguments: { action: "call", method: "screenshot", args: [] },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      warnings: [expect.stringContaining("Screenshot unavailable")],
    });
  });

  it("lists and reads saved Artifacts as MCP Resources", async () => {
    const saved = await runtime.artifacts.save({ data: JSON.stringify({ complete: true }), mimeType: "application/json" });

    const listed = await client.listResources();
    expect(listed.resources.some((resource) => resource.uri === saved.uri)).toBe(true);
    const read = await client.readResource({ uri: saved.uri });
    expect(read.contents[0]).toMatchObject({ uri: saved.uri, text: JSON.stringify({ complete: true }) });
  });

  it("returns unique Crawl Pages with truthful pagination and links over MCP", async () => {
    const adapter = new FakeCrawlAdapter();
    const manager = new CrawlManager({
      adapter,
      root,
      output: new ArtifactOutput(runtime.artifacts),
      pollIntervalMs: 0,
    });
    await manager.recover();
    runtime.crawl = (input) => manager.start(input);
    runtime.crawlStatus = (input) => manager.status(input);
    runtime.crawlCancel = (input) => manager.cancel(input);

    try {
      const started = await client.callTool({
        name: "crawl",
        arguments: { url: "https://example.com", limit: 5, formats: ["markdown", "links"] },
      });
      expect(started.isError).not.toBe(true);
      const crawlId = (started.structuredContent as { crawlId: string }).crawlId;
      expect(crawlId).toBeDefined();

      adapter.snapshot = {
        status: "completed",
        total: 6,
        completed: 6,
        pages: [
          { url: "https://example.com/a", formats: { markdown: "A", links: ["https://example.com/a/1"] } },
          { url: "https://example.com/a#part", formats: { markdown: "A again", links: ["https://example.com/a/2"] } },
          { url: "https://example.com/b?tab=1", formats: { markdown: "B one", links: [] } },
          { url: "https://example.com/b?tab=2", formats: { markdown: "B two", links: [] } },
          { url: "https://example.com/dir/", formats: { markdown: "dir", links: [] } },
          { url: "https://example.com/dir", formats: { markdown: "dir no slash", links: [] } },
        ],
        errors: [],
      };

      const first = await client.callTool({
        name: "crawl_status",
        arguments: { crawlId, offset: 0, limit: 3 },
      });
      expect(first.isError).not.toBe(true);
      const firstOutput = first.structuredContent as {
        total: number;
        completed: number;
        returned: number;
        hasMore: boolean;
        artifactId: string;
        pages: Array<{ url: string; links?: string[]; formats: Record<string, unknown> }>;
      };
      expect(firstOutput.total).toBe(5);
      expect(firstOutput.completed).toBe(5);
      expect(firstOutput.returned).toBe(3);
      expect(firstOutput.hasMore).toBe(true);
      expect(firstOutput.pages.map((page) => page.url)).toEqual([
        "https://example.com/a",
        "https://example.com/b?tab=1",
        "https://example.com/b?tab=2",
      ]);
      expect(firstOutput.pages[0].links).toEqual(["https://example.com/a/2"]);
      expect(firstOutput.pages[0].formats.links).toEqual(["https://example.com/a/2"]);

      const second = await client.callTool({
        name: "crawl_status",
        arguments: { crawlId, offset: 3, limit: 3 },
      });
      expect(second.isError).not.toBe(true);
      const secondOutput = second.structuredContent as typeof firstOutput;
      expect(secondOutput.returned).toBe(2);
      expect(secondOutput.hasMore).toBe(false);
      expect(secondOutput.pages.map((page) => page.url)).toEqual([
        "https://example.com/dir/",
        "https://example.com/dir",
      ]);
      const exposed = [...firstOutput.pages, ...secondOutput.pages].map((page) => page.url);
      expect(new Set(exposed).size).toBe(exposed.length);

      const read = await client.readResource({ uri: `freeweb://artifacts/${firstOutput.artifactId}` });
      const checkpoint = JSON.parse((read.contents[0] as { text: string }).text) as {
        total: number;
        completed: number;
        pages: Array<{ url: string; links?: string[]; formats: Record<string, unknown> }>;
      };
      expect(checkpoint.total).toBe(5);
      expect(checkpoint.completed).toBe(5);
      expect(checkpoint.pages.map((page) => page.url)).toEqual([
        "https://example.com/a",
        "https://example.com/b?tab=1",
        "https://example.com/b?tab=2",
        "https://example.com/dir/",
        "https://example.com/dir",
      ]);
      expect(checkpoint.pages.every((page) => page.links === undefined)).toBe(true);
      expect(adapter.starts).toBe(1);
    } finally {
      await manager.close();
    }
  });
});
