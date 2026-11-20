import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readPackageMetadata } from "../../src/package-metadata.js";

const execFileAsync = promisify(execFile);

let root: string | undefined;
let client: Client | undefined;
let transport: StdioClientTransport | undefined;

async function startClient(
  unrestricted: boolean,
  prepare?: (root: string) => Promise<Record<string, unknown> | undefined>,
) {
  root = await mkdtemp(join(tmpdir(), "freeweb-stdio-"));
  const config = prepare ? await prepare(root) : undefined;
  const configPath = join(root, config ? "config.json" : "missing-config.json");
  if (config) await writeFile(configPath, JSON.stringify(config));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "mcp"],
    env: {
      ...env,
      FREEWEB_CONFIG: configPath,
      FREEWEB_DATA_DIR: join(root, "data"),
      FREEWEB_EGO_UNRESTRICTED: unrestricted ? "true" : "false",
      FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "false",
      TINYFISH_API_KEY: "",
    },
    cwd: process.cwd(),
    stderr: "pipe",
  });
  client = new Client({ name: "stdio-acceptance", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function builtCliVersion(): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [resolve("dist/cli.js"), "--version"]);
  return stdout.trim();
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
  client = undefined;
  transport = undefined;
  root = undefined;
});

describe("built stdio server started through the explicit mcp command", () => {
  it("reports the package version during initialize, matching the CLI", async () => {
    const connected = await startClient(false);
    const metadata = await readPackageMetadata();

    expect(connected.getServerVersion()).toMatchObject({ name: "freeweb-mcp", version: metadata.version });
    expect(await builtCliVersion()).toBe(metadata.version);
  });

  it("serves the default MCP tool list over a real child process", async () => {
    const connected = await startClient(false);
    const listed = await connected.listTools();

    expect(listed.tools).toHaveLength(8);
    expect(listed.tools.map((tool) => tool.name)).toContain("search");
    expect(listed.tools.some((tool) => tool.name === "browse_node")).toBe(false);
  });

  it("registers browse_node only after explicit unrestricted opt-in", async () => {
    const connected = await startClient(true);
    const listed = await connected.listTools();

    expect(listed.tools).toHaveLength(9);
    expect(listed.tools.some((tool) => tool.name === "browse_node")).toBe(true);
  });

  it("returns unique Crawl Pages with links and truthful pagination over real stdio", async () => {
    let requestsLog = "";
    const connected = await startClient(false, async (directory) => {
      const script = join(directory, "fake-firecrawl-local.js");
      requestsLog = join(directory, "firecrawl-requests.jsonl");
      await writeFile(script, fakeFirecrawlServe(requestsLog));
      await chmod(script, 0o755);
      return {
        firecrawl: {
          binary: script,
          allowPrivate: true,
          startupTimeoutMs: 10_000,
          shutdownTimeoutMs: 1_000,
        },
      };
    });

    const started = await connected.callTool({
      name: "crawl",
      arguments: { url: "http://127.0.0.1/start", limit: 5, formats: ["markdown", "links"] },
    });
    expect(started.isError).not.toBe(true);
    const crawlId = (started.structuredContent as { crawlId: string }).crawlId;

    const first = await connected.callTool({
      name: "crawl_status",
      arguments: { crawlId, offset: 0, limit: 3 },
    });
    expect(first.isError).not.toBe(true);
    const firstOutput = first.structuredContent as {
      total: number;
      completed: number;
      returned: number;
      hasMore: boolean;
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

    const second = await connected.callTool({
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

    const requests = (await readFile(requestsLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; path: string });
    expect(requests.filter((request) => request.method === "POST" && request.path === "/v2/crawl")).toHaveLength(1);
  });
});

function fakeFirecrawlServe(logPath: string): string {
  const pages = [
    { url: "https://example.com/a", markdown: "A", links: ["https://example.com/a/1"], metadata: { title: "A", url: "https://example.com/a" } },
    { url: "https://example.com/a", markdown: "A again", links: ["https://example.com/a/2"], metadata: { title: "A" } },
    { url: "https://example.com/a#part", markdown: "A fragment", metadata: { title: "A" } },
    { url: "https://example.com/b?tab=1", markdown: "B one", metadata: {} },
    { url: "https://example.com/b?tab=2", markdown: "B two", metadata: {} },
    { url: "https://example.com/dir/", markdown: "dir", metadata: {} },
    { url: "https://example.com/dir", markdown: "dir no slash", metadata: {} },
  ];
  return `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const logPath = ${JSON.stringify(logPath)};
const pages = ${JSON.stringify(pages)};
const record = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
const send = (response, body) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  record({ method: request.method, path: url.pathname });
  if (url.pathname === "/health") {
    return send(response, { status: "ok", engine: "firecrawl-local", version: "0.1.0" });
  }
  if (request.method === "POST" && url.pathname === "/v2/crawl") {
    return send(response, { success: true, id: "job-1" });
  }
  if (request.method === "GET" && url.pathname === "/v2/crawl/job-1") {
    return send(response, {
      success: true,
      status: "completed",
      total: 8,
      completed: 8,
      data: pages,
      errors: [],
    });
  }
  if (request.method === "DELETE" && url.pathname === "/v2/crawl/job-1") {
    return send(response, { success: true, status: "cancelled" });
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, "127.0.0.1");
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setTimeout(() => process.exit(0), 20_000).unref();
`;
}
