import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let root: string | undefined;
let client: Client | undefined;
let transport: StdioClientTransport | undefined;

async function startClient(unrestricted: boolean) {
  root = await mkdtemp(join(tmpdir(), "freeweb-stdio-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js")],
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

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
  client = undefined;
  transport = undefined;
  root = undefined;
});

describe("built stdio server", () => {
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
