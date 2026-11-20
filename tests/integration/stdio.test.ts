import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readPackageMetadata } from "../../src/package-metadata.js";

const execFileAsync = promisify(execFile);

let root: string | undefined;
let client: Client | undefined;
let transport: StdioClientTransport | undefined;

async function startClient(unrestricted: boolean) {
  root = await mkdtemp(join(tmpdir(), "freeweb-stdio-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "mcp"],
    env: {
      ...env,
      FREEWEB_CONFIG: join(root, "missing-config.json"),
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
});
