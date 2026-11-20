import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { ArtifactOutput } from "../../src/artifacts/output.js";
import { configFileSchema, type AppConfig } from "../../src/config.js";
import { FreeWebError } from "../../src/errors.js";
import { ManagedBrowseToolCall } from "../../src/mcp/managed-browse-tool-call.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { FreeWebToolHandlers } from "../../src/mcp/runtime-interface.js";
import {
  EgoProvider,
  type EgoRunRequest,
  type EgoRunResult,
  type EgoRunner,
} from "../../src/providers/ego.js";
import type {
  BrowseEvaluateInput, BrowseInput, BrowseNodeInput, BrowseNodeOutput, BrowseOutput,
  CrawlInput, CrawlOutput, CrawlStatusInput, FetchInput, FetchOutput,
  MapInput, MapOutput, SearchInput, SearchOutput,
} from "../../src/types.js";

const SPACE_ID = 7;

/**
 * Controlled ego-lite runner for the public lifecycle. A handoff returns the real terminal
 * contract: clean exit, no marker payload, and only the owned user-control hard-stop guidance.
 */
class LifecycleRunner implements EgoRunner {
  readonly calls: EgoRunRequest[] = [];

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    this.calls.push(request);
    if (request.kind === "finish") return withPayload(request, finishPayload());
    if (request.script.includes("await task.handOff()")) {
      return {
        exitCode: 0,
        stdout: [
          "Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.",
          "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
          "Wait until the user explicitly asks you to continue, then take control back and resume:",
          " const task = await takeOverTaskSpace(spaceId)",
          "",
        ].join("\n"),
        stderr: "",
        durationMs: 8,
        timedOut: false,
      };
    }
    return withPayload(request, taskPayload());
  }
}

function withPayload(request: EgoRunRequest, payload: Record<string, unknown>): EgoRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: `${request.marker}${JSON.stringify(payload)}\n`,
    durationMs: 8,
    timedOut: false,
  };
}

function taskPayload(): Record<string, unknown> {
  return {
    ok: true,
    value: { observed: true },
    task: { spaceId: SPACE_ID, ownership: "agent", name: "freeweb task" },
    pages: ["p1"],
    spaces: [{ id: SPACE_ID, ownership: "agent" }],
  };
}

function finishPayload(): Record<string, unknown> {
  return {
    ok: true,
    value: { finished: true },
    task: { spaceId: SPACE_ID, ownership: "user", name: "freeweb task" },
    pages: ["p1"],
    receipt: { kept: ["p1"], closed: [] },
  };
}

class LifecycleRuntime implements FreeWebToolHandlers {
  readonly artifacts: ArtifactStore;
  readonly unrestricted = false;
  readonly runner = new LifecycleRunner();
  private readonly ego: EgoProvider;
  private readonly managedBrowse: ManagedBrowseToolCall;

  constructor(private readonly config: AppConfig) {
    this.artifacts = new ArtifactStore({ root: config.dataDir });
    const output = new ArtifactOutput(this.artifacts);
    this.ego = new EgoProvider(config, { runner: this.runner, artifacts: this.artifacts, output });
    this.managedBrowse = new ManagedBrowseToolCall({
      browse: (input) => this.ego.browse(input),
      artifacts: this.artifacts,
      dataDir: config.dataDir,
      screenshotMaxBytes: config.artifacts.screenshotMaxBytes,
    });
  }

  async search(_input: SearchInput): Promise<SearchOutput> { throw new FreeWebError("NOT_USED", "not used"); }
  async fetch(_input: FetchInput): Promise<FetchOutput> { throw new FreeWebError("NOT_USED", "not used"); }
  async map(_input: MapInput): Promise<MapOutput> { throw new FreeWebError("NOT_USED", "not used"); }
  async crawl(_input: CrawlInput): Promise<CrawlOutput> { throw new FreeWebError("NOT_USED", "not used"); }
  async crawlStatus(_input: CrawlStatusInput): Promise<CrawlOutput> { throw new FreeWebError("NOT_USED", "not used"); }
  async crawlCancel(_input: { crawlId: string }): Promise<CrawlOutput> { throw new FreeWebError("NOT_USED", "not used"); }
  async managedBrowseToolCall(input: BrowseInput): Promise<CallToolResult> { return this.managedBrowse.run(input); }
  async browseEvaluate(input: BrowseEvaluateInput): Promise<BrowseOutput> { return this.ego.evaluate(input); }
  async browseNode(_input: BrowseNodeInput): Promise<BrowseNodeOutput> { throw new FreeWebError("NOT_USED", "not used"); }
}

let root: string;
let runtime: LifecycleRuntime;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-lifecycle-"));
  const parsed = configFileSchema.parse({ dataDir: root });
  runtime = new LifecycleRuntime({ ...parsed, dataDir: root });
  server = createMcpServer(runtime, "1.0.0-lifecycle");
  client = new Client({ name: "freeweb-lifecycle-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("MCP-visible Managed Browse handoff lifecycle", () => {
  it("reports a successful handoff, keeps status readable, blocks work, then resumes the same Space", async () => {
    const opened = await client.callTool({
      name: "browse",
      arguments: { action: "open", name: "lifecycle task", page: "p1" },
    });
    expect(opened.isError).not.toBe(true);
    const openedOutput = opened.structuredContent as { browseId: string; status: string; spaceId: number };
    expect(openedOutput).toMatchObject({ status: "ok", spaceId: SPACE_ID });
    const browseId = openedOutput.browseId;

    const handoff = await client.callTool({
      name: "browse",
      arguments: { action: "handoff", browseId, page: "p1" },
    });
    expect(handoff.isError).not.toBe(true);
    expect(handoff.structuredContent).toMatchObject({
      browseId,
      spaceId: SPACE_ID,
      status: "handoff",
      result: { handedOff: true },
      pages: ["p1"],
    });

    const registry = JSON.parse(await readFile(join(root, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { browseId: string; spaceId: number; status: string; ownership: string }>;
    };
    // Confirmed handoff serializes the delegated state without creating a replacement Space.
    expect(Object.keys(registry.tasks)).toEqual([browseId]);
    expect(registry.tasks[browseId]).toMatchObject({
      browseId,
      spaceId: SPACE_ID,
      status: "handoff",
      ownership: "agentDelegatedToUser",
    });

    const callsAfterHandoff = runtime.runner.calls.length;
    const status = await client.callTool({
      name: "browse",
      arguments: { action: "status", browseId, page: "p1" },
    });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      browseId,
      spaceId: SPACE_ID,
      status: "handoff",
      result: { status: "handoff", ownership: "agentDelegatedToUser", pages: ["p1"] },
    });
    // Reading the handed-off state must not run ego work or take ownership back.
    expect(runtime.runner.calls.length).toBe(callsAfterHandoff);

    const blocked = await client.callTool({
      name: "browse",
      arguments: { action: "call", browseId, page: "p1", method: "page.snapshot", args: [] },
    });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("EGO_USER_CONTROL_REQUIRED");
    expect(runtime.runner.calls.length).toBe(callsAfterHandoff);

    const resumed = await client.callTool({
      name: "browse",
      arguments: { action: "resume", browseId, page: "p1" },
    });
    expect(resumed.isError).not.toBe(true);
    expect(resumed.structuredContent).toMatchObject({ browseId, spaceId: SPACE_ID, status: "ok" });

    const resumedRegistry = JSON.parse(await readFile(join(root, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { browseId: string; spaceId: number; status: string; ownership: string }>;
    };
    expect(Object.keys(resumedRegistry.tasks)).toEqual([browseId]);
    expect(resumedRegistry.tasks[browseId]).toMatchObject({
      browseId,
      spaceId: SPACE_ID,
      status: "active",
    });
    expect(resumedRegistry.tasks[browseId]!.ownership).not.toBe("agentDelegatedToUser");

    const worked = await client.callTool({
      name: "browse",
      arguments: { action: "call", browseId, page: "p1", method: "page.snapshot", args: [] },
    });
    expect(worked.isError).not.toBe(true);
    expect(worked.structuredContent).toMatchObject({ browseId, spaceId: SPACE_ID, status: "ok" });
  });

  it("rejects unknown Page labels through public tools without invoking ego work", async () => {
    const opened = await client.callTool({
      name: "browse",
      arguments: { action: "open", name: "page guard task" },
    });
    expect(opened.isError).not.toBe(true);
    const browseId = (opened.structuredContent as { browseId: string }).browseId;
    const callsAfterOpen = runtime.runner.calls.length;

    const native = await client.callTool({
      name: "browse",
      arguments: { action: "call", browseId, page: "p9", method: "page.snapshot", args: [] },
    });
    expect(native.isError).toBe(true);
    expect(JSON.stringify(native.content)).toContain("EGO_PAGE_NOT_FOUND");
    expect(JSON.stringify(native.content)).toContain('"requestedPage":"p9"');
    expect(JSON.stringify(native.content)).toContain('"availablePages":["p1"]');
    expect(runtime.runner.calls.length).toBe(callsAfterOpen);

    const evaluated = await client.callTool({
      name: "browse_evaluate",
      arguments: { browseId, page: "p9", script: "document.title" },
    });
    expect(evaluated.isError).toBe(true);
    expect(JSON.stringify(evaluated.content)).toContain("EGO_PAGE_NOT_FOUND");
    expect(JSON.stringify(evaluated.content)).toContain('"requestedPage":"p9"');
    expect(JSON.stringify(evaluated.content)).toContain('"availablePages":["p1"]');
    expect(runtime.runner.calls.length).toBe(callsAfterOpen);

    const registryPath = join(root, "browse", "tasks.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { pages: string[] }>;
    };
    registry.tasks[browseId]!.pages = ["p2"];
    await writeFile(registryPath, JSON.stringify(registry));
    const callsAfterRegistryEdit = runtime.runner.calls.length;

    const defaulted = await client.callTool({
      name: "browse_evaluate",
      arguments: { browseId, script: "document.title" },
    });
    expect(defaulted.isError).toBe(true);
    expect(JSON.stringify(defaulted.content)).toContain("EGO_PAGE_NOT_FOUND");
    expect(JSON.stringify(defaulted.content)).toContain('"requestedPage":"p1"');
    expect(JSON.stringify(defaulted.content)).toContain('"availablePages":["p2"]');
    expect(runtime.runner.calls.length).toBe(callsAfterRegistryEdit);
  });
});
