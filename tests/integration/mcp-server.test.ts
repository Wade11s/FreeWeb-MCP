import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { FreeWebError } from "../../src/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { FreeWebToolHandlers } from "../../src/mcp/runtime-interface.js";
import type { BrowseInput, SearchInput } from "../../src/types.js";

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
  async crawl(): Promise<any> { throw new Error("not used"); }
  async crawlStatus(): Promise<any> { throw new Error("not used"); }
  async crawlCancel(): Promise<any> { throw new Error("not used"); }
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
});
