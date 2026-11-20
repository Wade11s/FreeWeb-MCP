import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { ArtifactOutput } from "../../src/artifacts/output.js";
import { loadConfig } from "../../src/config.js";
import { FreeWebError } from "../../src/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { FreeWebToolHandlers } from "../../src/mcp/runtime-interface.js";
import {
  SUPPORTED,
  type FetchMapAdapter,
  type FetchProvider,
  type ProviderPreflight,
  type SearchProvider,
} from "../../src/providers/interfaces.js";
import { ProviderRouter } from "../../src/providers/router.js";
import type { BrowseInput, SearchInput } from "../../src/types.js";

/** Deliberately not the current release: the MCP handshake must echo what it is given. */
const ordinaryVersion = "1.2.3";
const nonReleaseVersion = "2.0.0-rc.1+build.7";

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
  server = createMcpServer(runtime, ordinaryVersion);
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
  it.each([
    ["ordinary", ordinaryVersion],
    ["non-release", nonReleaseVersion],
  ])("reports the %s package version during initialize", async (_kind, version) => {
    await client.close();
    await server.close();
    server = createMcpServer(runtime, version);
    client = new Client({ name: "freeweb-version-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toMatchObject({ name: "freeweb-mcp", version });
  });

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
    server = createMcpServer(runtime, ordinaryVersion);
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

  describe("Search Fallback contract through the MCP public protocol", () => {
    class ControlledTinyFish implements SearchProvider, FetchProvider {
      readonly name = "tinyfish" as const;
      searchInspections = 0;
      searchCalls = 0;
      searchError: unknown;
      empty = false;

      inspectSearch(): ProviderPreflight {
        this.searchInspections++;
        return SUPPORTED;
      }

      inspectFetch(): ProviderPreflight {
        return SUPPORTED;
      }

      async search() {
        this.searchCalls++;
        if (this.searchError) throw this.searchError;
        return {
          results: this.empty
            ? []
            : [{ position: 1, title: "TinyFish Result", url: "https://example.com/tinyfish", snippet: "primary" }],
        };
      }

      async fetch(): Promise<never> {
        throw new Error("Fetch is not part of this Search contract");
      }
    }

    class ControlledFirecrawlSearch implements SearchProvider {
      readonly name = "firecrawl-search" as const;
      inspections = 0;
      calls = 0;
      searchError: unknown;

      inspectSearch(): ProviderPreflight {
        this.inspections++;
        return SUPPORTED;
      }

      async search() {
        this.calls++;
        if (this.searchError) throw this.searchError;
        return {
          results: [{ position: 1, title: "Firecrawl Result", url: "https://example.com/firecrawl", snippet: "fallback" }],
        };
      }
    }

    const unusedFirecrawl: FetchMapAdapter = {
      name: "firecrawl-local",
      inspectFetch: () => SUPPORTED,
      fetch: async (): Promise<never> => { throw new Error("Fetch is not part of this Search contract"); },
      map: async (): Promise<never> => { throw new Error("Map is not part of this Search contract"); },
    };

    class RouterBackedRuntime implements FreeWebToolHandlers {
      unrestricted = false;

      constructor(readonly artifacts: ArtifactStore, private readonly router: ProviderRouter) {}

      async search(input: SearchInput) { return this.router.search(input); }
      async fetch(): Promise<never> { throw new Error("not used"); }
      async map(): Promise<never> { throw new Error("not used"); }
      async crawl(): Promise<never> { throw new Error("not used"); }
      async crawlStatus(): Promise<never> { throw new Error("not used"); }
      async crawlCancel(): Promise<never> { throw new Error("not used"); }
      async managedBrowseToolCall(): Promise<never> { throw new Error("not used"); }
      async browseEvaluate(): Promise<never> { throw new Error("not used"); }
      async browseNode(): Promise<never> { throw new Error("not used"); }
    }

    async function connectSearchContract(options: {
      tinyfish?: ControlledTinyFish;
      firecrawlSearch?: ControlledFirecrawlSearch;
      tinyfishSearchPerMinute?: number;
    } = {}) {
      await client.close();
      await server.close();
      const config = await loadConfig({ configPath: join(root, "missing.json"), env: {} });
      if (options.tinyfishSearchPerMinute !== undefined) config.limits.tinyfishSearchPerMinute = options.tinyfishSearchPerMinute;
      const artifacts = new ArtifactStore({ root });
      const router = new ProviderRouter({
        config,
        output: new ArtifactOutput(artifacts),
        ...(options.tinyfish ? { tinyfish: options.tinyfish } : {}),
        firecrawl: unusedFirecrawl,
        ...(options.firecrawlSearch ? { firecrawlSearch: options.firecrawlSearch } : {}),
        cloudUrlValidator: async (url) => new URL(url),
      });
      server = createMcpServer(new RouterBackedRuntime(artifacts, router), ordinaryVersion);
      client = new Client({ name: "freeweb-search-contract-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    }

    function toolError(result: CallToolResult) {
      const block = result.content[0];
      if (!block || block.type !== "text") throw new Error("Expected a text error block");
      const parsed = JSON.parse(String(block.text)) as {
        error: { code: string; message: string; attempts?: Array<Record<string, unknown>> };
      };
      return parsed.error;
    }

    it("does not inspect or request the alternate after a primary failure when fallback is false", async () => {
      const tinyfish = new ControlledTinyFish();
      tinyfish.searchError = new FreeWebError("RATE_LIMIT_EXCEEDED", "quota exhausted", { provider: "tinyfish", retryable: true });
      const firecrawlSearch = new ControlledFirecrawlSearch();
      await connectSearchContract({ tinyfish, firecrawlSearch });

      const result = await client.callTool({ name: "search", arguments: { query: "no fallback", fallback: false } });

      expect(result.isError).toBe(true);
      const error = toolError(result);
      expect(error.code).toBe("ALL_PROVIDERS_FAILED");
      expect(error.message).toContain("fallback: false");
      expect(error.attempts).toEqual([expect.objectContaining({ provider: "tinyfish", outcome: "error", code: "RATE_LIMIT_EXCEEDED" })]);
      expect(firecrawlSearch.inspections).toBe(0);
      expect(firecrawlSearch.calls).toBe(0);
    });

    it("does not consume alternate quota after a primary failure when fallback is false", async () => {
      const tinyfish = new ControlledTinyFish();
      const firecrawlSearch = new ControlledFirecrawlSearch();
      firecrawlSearch.searchError = new FreeWebError("UPSTREAM_ERROR", "keyless search failed", { provider: "firecrawl-search" });
      await connectSearchContract({ tinyfish, firecrawlSearch, tinyfishSearchPerMinute: 1 });

      const failed = await client.callTool({
        name: "search",
        arguments: { query: "firecrawl first", provider: "firecrawl-search", fallback: false },
      });
      expect(failed.isError).toBe(true);
      expect(tinyfish.searchInspections).toBe(0);
      expect(tinyfish.searchCalls).toBe(0);

      const after = await client.callTool({
        name: "search",
        arguments: { query: "tinyfish still has quota", provider: "tinyfish", fallback: false },
      });
      expect(after.isError).not.toBe(true);
      expect(after.structuredContent).toMatchObject({ provider: "tinyfish", requestedProvider: "tinyfish" });
      expect(tinyfish.searchCalls).toBe(1);
    });

    it("reports an unconfigured explicit primary without inspecting the configured alternate when fallback is false", async () => {
      const firecrawlSearch = new ControlledFirecrawlSearch();
      await connectSearchContract({ firecrawlSearch });

      const result = await client.callTool({
        name: "search",
        arguments: { query: "unconfigured primary", provider: "tinyfish", fallback: false },
      });

      expect(result.isError).toBe(true);
      const error = toolError(result);
      expect(error.code).toBe("PROVIDER_NOT_CONFIGURED");
      expect(error.message).toContain("TINYFISH_API_KEY");
      expect(error.message).toContain("fallback: false");
      expect(error.message).toContain("no alternate Provider was inspected or attempted");
      expect(error.attempts).toEqual([expect.objectContaining({ provider: "tinyfish", outcome: "skipped", code: "PROVIDER_NOT_CONFIGURED" })]);
      expect(firecrawlSearch.inspections).toBe(0);
      expect(firecrawlSearch.calls).toBe(0);
    });

    it("skips an unconfigured explicit primary and attempts exactly one configured alternate when fallback is enabled", async () => {
      const firecrawlSearch = new ControlledFirecrawlSearch();
      await connectSearchContract({ firecrawlSearch });

      const result = await client.callTool({
        name: "search",
        arguments: { query: "configured alternate", provider: "tinyfish" },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        provider: "firecrawl-search",
        requestedProvider: "tinyfish",
        attempts: [
          expect.objectContaining({ provider: "tinyfish", outcome: "skipped", code: "PROVIDER_NOT_CONFIGURED" }),
          expect.objectContaining({ provider: "firecrawl-search", outcome: "success" }),
        ],
        warnings: [expect.stringContaining("fallback")],
      });
      expect((result.structuredContent as { attempts: unknown[] }).attempts).toHaveLength(2);
      expect(firecrawlSearch.calls).toBe(1);
    });

    it("attributes a successful fallback to requested and actual Providers with attempts and a warning", async () => {
      const tinyfish = new ControlledTinyFish();
      tinyfish.searchError = new FreeWebError("RATE_LIMIT_EXCEEDED", "quota exhausted", { provider: "tinyfish", retryable: true });
      const firecrawlSearch = new ControlledFirecrawlSearch();
      await connectSearchContract({ tinyfish, firecrawlSearch });

      const result = await client.callTool({
        name: "search",
        arguments: { query: "visible fallback", provider: "tinyfish" },
      });

      expect(result.isError).not.toBe(true);
      const output = result.structuredContent as {
        provider: string;
        requestedProvider: string;
        attempts: Array<{ provider: string; outcome: string; code?: string }>;
        warnings: string[];
        results: Array<{ title: string }>;
      };
      expect(output.provider).toBe("firecrawl-search");
      expect(output.requestedProvider).toBe("tinyfish");
      expect(output.attempts.map((attempt) => [attempt.provider, attempt.outcome, attempt.code])).toEqual([
        ["tinyfish", "error", "RATE_LIMIT_EXCEEDED"],
        ["firecrawl-search", "success", undefined],
      ]);
      expect(output.warnings).toHaveLength(1);
      expect(output.warnings[0]).toContain("fallback");
      expect(output.warnings[0]).toContain("firecrawl-search");
      expect(output.results[0].title).toBe("Firecrawl Result");
      expect(tinyfish.searchCalls).toBe(1);
      expect(firecrawlSearch.calls).toBe(1);
    });

    it("keeps a valid empty Search result successful without any fallback attempt", async () => {
      const tinyfish = new ControlledTinyFish();
      tinyfish.empty = true;
      const firecrawlSearch = new ControlledFirecrawlSearch();
      await connectSearchContract({ tinyfish, firecrawlSearch });

      const result = await client.callTool({ name: "search", arguments: { query: "valid empty" } });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        provider: "tinyfish",
        results: [],
        warnings: [],
        attempts: [expect.objectContaining({ provider: "tinyfish", outcome: "success" })],
      });
      expect(firecrawlSearch.inspections).toBe(0);
      expect(firecrawlSearch.calls).toBe(0);
    });

    it("distinguishes a disabled keyless Search Provider from a disabled per-call fallback", async () => {
      const tinyfish = new ControlledTinyFish();
      tinyfish.searchError = new FreeWebError("RATE_LIMIT_EXCEEDED", "quota exhausted", { provider: "tinyfish", retryable: true });
      await connectSearchContract({ tinyfish });

      const result = await client.callTool({ name: "search", arguments: { query: "keyless disabled" } });

      expect(result.isError).toBe(true);
      const error = toolError(result);
      expect(error.code).toBe("ALL_PROVIDERS_FAILED");
      expect(error.message).toContain("Keyless Firecrawl Search is not configured");
      expect(error.message).toContain("firecrawl.searchFallback");
      expect(error.message).toContain("Per-call fallback is enabled");
      expect(error.attempts).toEqual([
        expect.objectContaining({ provider: "tinyfish", outcome: "error", code: "RATE_LIMIT_EXCEEDED" }),
        expect.objectContaining({ provider: "firecrawl-search", outcome: "skipped", code: "PROVIDER_NOT_CONFIGURED" }),
      ]);
      expect(tinyfish.searchCalls).toBe(1);
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
