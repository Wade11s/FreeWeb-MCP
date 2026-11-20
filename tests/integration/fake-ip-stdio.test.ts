import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chmod, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const preloadPath = resolve("tests/integration/fixtures/fake-ip-preload.mjs");
const firecrawlFixture = resolve("tests/integration/fixtures/fake-firecrawl-serve.mjs");

let root: string | undefined;
let client: Client | undefined;
let transport: StdioClientTransport | undefined;

async function startClient(options: { trusted?: boolean; firecrawlAllowPrivate?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "freeweb-fake-ip-stdio-"));
  const firecrawlBinary = join(root, "fake-firecrawl-serve.mjs");
  await copyFile(firecrawlFixture, firecrawlBinary);
  await chmod(firecrawlBinary, 0o700);
  await writeFile(join(root, "config.json"), JSON.stringify({
    network: { trustedDnsServers: ["1.1.1.1", "2606:4700:4700::1111"] },
    firecrawl: { binary: firecrawlBinary, allowPrivate: options.firecrawlAllowPrivate ?? false },
    ego: { allowPrivate: false },
  }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "mcp"],
    env: {
      ...env,
      NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ""}--import=${preloadPath}`,
      FREEWEB_CONFIG: join(root, "config.json"),
      FREEWEB_DATA_DIR: join(root, "data"),
      FREEWEB_TRUSTED_DNS_SERVERS: options.trusted === false ? "" : "1.1.1.1,2606:4700:4700::1111",
      FREEWEB_TEST_FAKE_IP_LOG: join(root, "events.jsonl"),
      FREEWEB_EGO_UNRESTRICTED: "false",
      FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "true",
      TINYFISH_API_KEY: "controlled-not-a-real-key",
    },
    cwd: process.cwd(),
    stderr: "pipe",
  });
  client = new Client({ name: "fake-ip-stdio-acceptance", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function events(): Promise<Array<Record<string, any>>> {
  if (!root) return [];
  const text = await readFile(join(root, "events.jsonl"), "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function firecrawlEvents(): Promise<Array<Record<string, any>>> {
  if (!root) return [];
  const text = await readFile(join(root, "firecrawl-events.jsonl"), "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function callFetch(connected: Client, url: string, provider: "firecrawl-local" | "tinyfish") {
  return connected.callTool({
    name: "fetch",
    arguments: { urls: [url], provider, fallback: true },
  });
}

async function callCrawl(connected: Client, url: string) {
  return connected.callTool({
    name: "crawl",
    arguments: { url, formats: ["markdown", "links"] },
  });
}

/** The structured tool failure is one JSON text block shaped as `{ error: { code, ... } }`. */
function failureCode(result: Awaited<ReturnType<Client["callTool"]>>): string | undefined {
  const block = result.content?.[0];
  if (!block || block.type !== "text") return undefined;
  return JSON.parse(block.text).error?.code;
}

/** Crawl Job checkpoints live under the configured data directory. */
async function crawlJobDirectories(): Promise<string[]> {
  if (!root) return [];
  return readdir(join(root, "data", "crawls")).catch(() => []);
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
  client = undefined;
  transport = undefined;
  root = undefined;
});

describe("real stdio Fetch through controlled fake-ip DNS", () => {
  it("retrieves public targets through local and TinyFish Fetch with private access disabled", async () => {
    const connected = await startClient();

    const local = await callFetch(connected, "https://public.fake-ip.test/page", "firecrawl-local");
    expect(local.isError).not.toBe(true);
    expect(local.structuredContent).toMatchObject({
      provider: "firecrawl-local",
      results: [{ formats: { markdown: "controlled Firecrawl content for https://public.fake-ip.test/page" } }],
      errors: [],
    });

    const cloud = await callFetch(connected, "https://public.fake-ip.test/cloud", "tinyfish");
    expect(cloud.isError).not.toBe(true);
    expect(cloud.structuredContent).toMatchObject({
      provider: "tinyfish",
      results: [{ formats: { markdown: "controlled TinyFish content for https://public.fake-ip.test/cloud" } }],
      errors: [],
    });

    const trustedBeforeOrdinary = (await events()).filter((event) => event.kind.startsWith("trusted-")).length;
    const ordinary = await callFetch(connected, "https://ordinary.public.test/", "firecrawl-local");
    expect(ordinary.isError).not.toBe(true);
    const allEvents = await events();
    expect(allEvents.filter((event) => event.kind.startsWith("trusted-"))).toHaveLength(trustedBeforeOrdinary);
    expect(allEvents.filter((event) => event.kind === "tinyfish-fetch")).toHaveLength(1);

    const starts = (await firecrawlEvents()).filter((event) => event.kind === "serve-start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ cloud: "off", allowPrivate: "false" });
    expect(starts[0]?.args).not.toContain("--allow-private");
  });

  it("reports actionable detection without trusted DNS and starts no Provider", async () => {
    const connected = await startClient({ trusted: false });

    const result = await callFetch(connected, "https://public.fake-ip.test/", "firecrawl-local");

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("FAKE_IP_DNS_DETECTED");
    expect(JSON.stringify(result.content)).toContain("restart the MCP server or reload the session");
    expect(await firecrawlEvents()).toEqual([]);
    expect((await events()).filter((event) => event.kind === "tinyfish-fetch")).toEqual([]);
    expect((await events()).some((event) => event.kind.startsWith("trusted-"))).toBe(false);
  });

  it.each([
    ["https://unverified.fake-ip.test/", "FAKE_IP_DNS_UNVERIFIED"],
    ["https://empty-trusted.fake-ip.test/", "FAKE_IP_DNS_UNVERIFIED"],
    ["https://private-trusted.fake-ip.test/", "PRIVATE_URL_BLOCKED"],
    ["https://mixed.fake-ip.test/", "PRIVATE_URL_BLOCKED"],
    ["https://198.18.0.1/", "PRIVATE_URL_BLOCKED"],
    ["http://127.0.0.1/", "PRIVATE_URL_BLOCKED"],
    ["https://user:pass@public.fake-ip.test/", "INVALID_URL"],
    ["ftp://public.fake-ip.test/", "INVALID_URL_SCHEME"],
  ])("blocks %s before Fallback or a cloud request", async (url, code) => {
    const connected = await startClient();

    const result = await callFetch(connected, url, "tinyfish");

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(code);
    expect(await firecrawlEvents()).toEqual([]);
    expect((await events()).filter((event) => event.kind === "tinyfish-fetch")).toEqual([]);
  });

  it("keeps TinyFish public-only at its Provider boundary without local Fallback", async () => {
    const connected = await startClient({ firecrawlAllowPrivate: true });

    const result = await callFetch(connected, "http://10.0.0.5/private", "tinyfish");

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("PRIVATE_URL_BLOCKED");
    expect(await firecrawlEvents()).toEqual([]);
    expect((await events()).filter((event) => event.kind === "tinyfish-fetch")).toEqual([]);
  });
});

describe("real stdio Crawl through controlled fake-ip DNS", () => {
  it("starts, pages and completes a verified public Crawl Job with private access disabled", async () => {
    const connected = await startClient();

    const started = await callCrawl(connected, "https://public.fake-ip.test/crawl");
    expect(started.isError).not.toBe(true);
    const job = started.structuredContent as Record<string, any>;
    expect(job).toMatchObject({ status: "scraping", providerJobId: "controlled-crawl", total: 0, completed: 0 });

    const first = await connected.callTool({
      name: "crawl_status",
      arguments: { crawlId: job.crawlId, limit: 1 },
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      crawlId: job.crawlId,
      status: "completed",
      total: 2,
      completed: 2,
      offset: 0,
      returned: 1,
      hasMore: true,
      partial: false,
      pages: [{
        url: "https://public.fake-ip.test/crawl",
        title: "Controlled Crawl Root",
        formats: { markdown: "controlled Crawl content for https://public.fake-ip.test/crawl" },
      }],
    });
    expect((first.structuredContent as Record<string, any>).artifactId).toEqual(expect.any(String));

    const second = await connected.callTool({
      name: "crawl_status",
      arguments: { crawlId: job.crawlId, offset: 1, limit: 1 },
    });
    expect(second.structuredContent).toMatchObject({
      status: "completed",
      total: 2,
      completed: 2,
      offset: 1,
      returned: 1,
      hasMore: false,
      pages: [{
        url: "https://public.fake-ip.test/crawl/next",
        links: ["https://public.fake-ip.test/crawl/next"],
        formats: {
          markdown: "controlled Crawl content for https://public.fake-ip.test/crawl/next",
          links: ["https://public.fake-ip.test/crawl/next"],
        },
      }],
    });
    // The terminal checkpoint Artifact is the same on every read of the Job.
    expect((second.structuredContent as Record<string, any>).artifactId)
      .toBe((first.structuredContent as Record<string, any>).artifactId);

    const starts = (await firecrawlEvents()).filter((event) => event.kind === "serve-start");
    expect(starts).toHaveLength(1);
    // Provider-level public-only protection stays on: Crawl never widens it.
    expect(starts[0]).toMatchObject({ cloud: "off", allowPrivate: "false" });
    expect(starts[0]?.args).not.toContain("--allow-private");
    expect((await firecrawlEvents()).filter((event) => event.kind === "crawl-start"))
      .toEqual([{ kind: "crawl-start", id: "controlled-crawl", url: "https://public.fake-ip.test/crawl" }]);
    // The verified fake-ip target reached the Provider exactly once, through trusted DNS.
    expect((await events()).filter((event) => event.kind === "trusted-a"))
      .toEqual([expect.objectContaining({ hostname: "public.fake-ip.test", servers: ["1.1.1.1", "2606:4700:4700::1111"] })]);
  });

  it("cancels an active verified public Crawl Job and preserves its checkpoint", async () => {
    const connected = await startClient();

    const started = await callCrawl(connected, "https://public.fake-ip.test/slow/start");
    const job = started.structuredContent as Record<string, any>;
    expect(job).toMatchObject({ status: "scraping", providerJobId: "controlled-slow-crawl" });

    const cancelled = await connected.callTool({
      name: "crawl_cancel",
      arguments: { crawlId: job.crawlId },
    });

    expect(cancelled.isError).not.toBe(true);
    expect(cancelled.structuredContent).toMatchObject({
      crawlId: job.crawlId,
      status: "cancelled",
      total: 0,
      completed: 0,
      returned: 0,
      hasMore: false,
    });
    expect((cancelled.structuredContent as Record<string, any>).artifactId).toEqual(expect.any(String));
    expect((await firecrawlEvents()).filter((event) => event.kind === "crawl-cancel"))
      .toEqual([{ kind: "crawl-cancel", id: "controlled-slow-crawl" }]);
  });

  it.each([
    ["http://127.0.0.1/", "PRIVATE_URL_BLOCKED", false],
    ["http://10.0.0.5/private", "PRIVATE_URL_BLOCKED", false],
    ["https://198.18.0.1/", "PRIVATE_URL_BLOCKED", false],
    ["https://mixed.fake-ip.test/", "PRIVATE_URL_BLOCKED", false],
    ["https://private-trusted.fake-ip.test/", "PRIVATE_URL_BLOCKED", true],
    ["https://unverified.fake-ip.test/", "FAKE_IP_DNS_UNVERIFIED", true],
    ["https://empty-trusted.fake-ip.test/", "FAKE_IP_DNS_UNVERIFIED", true],
  ])("refuses %s before creating a Crawl Job or invoking the Provider", async (url, code, trustedConsulted) => {
    const connected = await startClient();

    const result = await callCrawl(connected, url);

    expect(result.isError).toBe(true);
    expect(failureCode(result)).toBe(code);
    expect(JSON.stringify(result.content)).not.toContain("crawlId");
    // No Crawl Job record and no Firecrawl request at all: the local serve never starts.
    expect(await crawlJobDirectories()).toEqual([]);
    expect(await firecrawlEvents()).toEqual([]);
    // Only DNS traffic is allowed to explain the refusal: no Provider or cloud request follows.
    const log = await events();
    expect(log.filter((event) => !event.kind.startsWith("system-") && !event.kind.startsWith("trusted-"))).toEqual([]);
    expect(log.some((event) => event.kind.startsWith("trusted-"))).toBe(trustedConsulted);
  });

  it("refuses an all-fake-ip target with actionable detection when trusted DNS is unconfigured", async () => {
    const connected = await startClient({ trusted: false });

    const result = await callCrawl(connected, "https://public.fake-ip.test/crawl");

    expect(result.isError).toBe(true);
    expect(failureCode(result)).toBe("FAKE_IP_DNS_DETECTED");
    expect(JSON.stringify(result.content)).toContain("restart the MCP server or reload the session");
    expect(await crawlJobDirectories()).toEqual([]);
    expect(await firecrawlEvents()).toEqual([]);
    expect((await events()).some((event) => event.kind.startsWith("trusted-"))).toBe(false);
  });
});
