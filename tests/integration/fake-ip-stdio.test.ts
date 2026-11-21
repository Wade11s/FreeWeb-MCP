import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chmod, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const preloadPath = resolve("tests/integration/fixtures/fake-ip-preload.mjs");
const firecrawlFixture = resolve("tests/integration/fixtures/fake-firecrawl-serve.mjs");
const egoFixture = resolve("tests/integration/fixtures/fake-ego-browser.mjs");

let root: string | undefined;
let client: Client | undefined;
let transport: StdioClientTransport | undefined;

async function startClient(options: { trusted?: boolean; dns?: "plain" | "doh"; firecrawlAllowPrivate?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "freeweb-fake-ip-stdio-"));
  const firecrawlBinary = join(root, "fake-firecrawl-serve.mjs");
  const egoBinary = join(root, "fake-ego-browser.mjs");
  await copyFile(firecrawlFixture, firecrawlBinary);
  await copyFile(egoFixture, egoBinary);
  await chmod(firecrawlBinary, 0o700);
  await chmod(egoBinary, 0o700);
  await writeFile(join(root, "config.json"), JSON.stringify({
    network: { trustedDnsServers: ["1.1.1.1", "2606:4700:4700::1111"] },
    firecrawl: { binary: firecrawlBinary, allowPrivate: options.firecrawlAllowPrivate ?? false },
    ego: { binary: egoBinary, allowPrivate: false },
  }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const trustedDnsServers = options.dns === "doh"
    ? "https://1.1.1.1/dns-query"
    : "1.1.1.1,2606:4700:4700::1111";
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "mcp"],
    env: {
      ...env,
      NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ""}--import=${preloadPath}`,
      FREEWEB_CONFIG: join(root, "config.json"),
      FREEWEB_DATA_DIR: join(root, "data"),
      FREEWEB_TRUSTED_DNS_SERVERS: options.trusted === false ? "" : trustedDnsServers,
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

async function egoEvents(): Promise<Array<Record<string, any>>> {
  if (!root) return [];
  const text = await readFile(join(root, "ego-events.jsonl"), "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function browseTasks(): Promise<Record<string, Record<string, any>>> {
  if (!root) return {};
  const registry = JSON.parse(
    await readFile(join(root, "data", "browse", "tasks.json"), "utf8").catch(() => JSON.stringify({ tasks: {} })),
  ) as { tasks: Record<string, Record<string, any>> };
  return registry.tasks;
}

async function callFetch(connected: Client, url: string, provider: "firecrawl-local" | "tinyfish") {
  return connected.callTool({
    name: "fetch",
    arguments: { urls: [url], provider, fallback: true },
  });
}

async function callMap(connected: Client, url: string) {
  return connected.callTool({ name: "map", arguments: { url } });
}

async function callCrawl(connected: Client, url: string) {
  return connected.callTool({
    name: "crawl",
    arguments: { url, formats: ["markdown", "links"] },
  });
}

async function openBrowsePage(connected: Client, url: string) {
  return connected.callTool({
    name: "browse",
    arguments: { action: "open", name: "controlled fake-ip Page", page: "p1", url },
  });
}

async function navigateBrowsePage(connected: Client, browseId: string, url: string) {
  return connected.callTool({
    name: "browse",
    arguments: { action: "call", browseId, page: "p1", method: "page.goto", args: [url] },
  });
}

/** The structured tool failure is one JSON text block shaped as `{ error: { code, ... } }`. */
function toolError(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("Expected a text error block");
  return JSON.parse(block.text).error;
}

function failureCode(result: Awaited<ReturnType<Client["callTool"]>>): string | undefined {
  return toolError(result).code;
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

  it("retrieves a public target through explicit DoH with both private-access settings disabled", async () => {
    const connected = await startClient({ dns: "doh" });

    const result = await callFetch(connected, "https://public.fake-ip.test/doh", "firecrawl-local");

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      provider: "firecrawl-local",
      results: [{ formats: { markdown: "controlled Firecrawl content for https://public.fake-ip.test/doh" } }],
    });
    const log = await events();
    expect(log.filter((event) => event.kind === "doh-query")).toEqual([
      { kind: "doh-query", hostname: "public.fake-ip.test", type: 1 },
      { kind: "doh-query", hostname: "public.fake-ip.test", type: 28 },
    ]);
    expect(log.some((event) => event.kind.startsWith("trusted-"))).toBe(false);
    const starts = (await firecrawlEvents()).filter((event) => event.kind === "serve-start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ cloud: "off", allowPrivate: "false" });
    expect(starts[0]?.args).not.toContain("--allow-private");
  });

  it("fails a DoH target retryably without Provider Fallback or leaking the response body", async () => {
    const connected = await startClient({ dns: "doh" });

    const result = await callFetch(connected, "https://doh-unverified.fake-ip.test/", "tinyfish");

    expect(result.isError).toBe(true);
    expect(toolError(result)).toMatchObject({ code: "FAKE_IP_DNS_UNVERIFIED", retryable: true });
    expect(JSON.stringify(result.content)).toContain("https://1.1.1.1/dns-query");
    expect(JSON.stringify(result.content)).not.toContain("controlled DoH failure body");
    expect((await events()).filter((event) => event.kind === "doh-query")).toHaveLength(2);
    expect(await firecrawlEvents()).toEqual([]);
    expect((await events()).filter((event) => event.kind === "tinyfish-fetch")).toEqual([]);
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

describe("real stdio Map through controlled fake-ip DNS", () => {
  it("discovers controlled public URLs with private access disabled through trusted DNS", async () => {
    const connected = await startClient();

    const result = await callMap(connected, "https://public.fake-ip.test/map");

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      provider: "firecrawl-local",
      links: [
        { url: "https://public.fake-ip.test/a" },
        { url: "https://public.fake-ip.test/b" },
      ],
      attempts: [expect.objectContaining({ provider: "firecrawl-local", outcome: "success" })],
      warnings: [],
      partial: false,
    });

    const dnsEvents = await events();
    expect(dnsEvents.some((event) => event.kind === "system-lookup" && event.hostname === "public.fake-ip.test")).toBe(true);
    expect(dnsEvents.some((event) => event.kind === "trusted-a")).toBe(true);
    expect(dnsEvents.some((event) => event.kind === "trusted-aaaa")).toBe(true);

    const providerEvents = await firecrawlEvents();
    expect(providerEvents.filter((event) => event.kind === "local-map")).toEqual([
      { kind: "local-map", url: "https://public.fake-ip.test/map" },
    ]);
    const starts = providerEvents.filter((event) => event.kind === "serve-start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ cloud: "off", allowPrivate: "false" });
    expect(starts[0]?.args).not.toContain("--allow-private");
  });

  it("fails a nonexistent public domain rejected by trusted DNS before Map Provider execution", async () => {
    const connected = await startClient();

    const result = await callMap(connected, "https://missing-trusted.fake-ip.test/");

    expect(result.isError).toBe(true);
    expect(failureCode(result)).toBe("FAKE_IP_DNS_UNVERIFIED");
    expect((await events()).some((event) => event.kind === "trusted-a")).toBe(true);
    expect(await firecrawlEvents()).toEqual([]);
  });

  it("turns an HTTP 200 application failure into the existing Map Provider failure with its cause", async () => {
    const connected = await startClient();

    const result = await callMap(connected, "https://application-failure.fake-ip.test/");

    expect(result.isError).toBe(true);
    expect(toolError(result)).toMatchObject({
      code: "ALL_PROVIDERS_FAILED",
      message: "Firecrawl Local Map failed",
      cause: "Controlled Map application failure",
      attempts: [expect.objectContaining({
        provider: "firecrawl-local",
        outcome: "error",
        code: "MAP_APPLICATION_FAILED",
        message: "Controlled Map application failure",
      })],
    });
    expect((await firecrawlEvents()).filter((event) => event.kind === "local-map")).toHaveLength(1);
  });

  it("keeps a confirmed empty Map result successful without Fallback", async () => {
    const connected = await startClient();

    const result = await callMap(connected, "https://empty-result.fake-ip.test/");

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      provider: "firecrawl-local",
      links: [],
      attempts: [
        expect.objectContaining({ provider: "firecrawl-local", outcome: "success" }),
      ],
      warnings: [],
      partial: false,
    });
    expect((result.structuredContent as { attempts: unknown[] }).attempts).toHaveLength(1);
    expect((await firecrawlEvents()).filter((event) => event.kind === "local-map")).toHaveLength(1);
  });

  it("reports fake-ip detection without trusted DNS before Map Provider execution", async () => {
    const connected = await startClient({ trusted: false });

    const result = await callMap(connected, "https://public.fake-ip.test/");

    expect(result.isError).toBe(true);
    expect(failureCode(result)).toBe("FAKE_IP_DNS_DETECTED");
    expect((await events()).some((event) => event.kind.startsWith("trusted-"))).toBe(false);
    expect(await firecrawlEvents()).toEqual([]);
  });

  it.each([
    ["https://unverified.fake-ip.test/", "FAKE_IP_DNS_UNVERIFIED"],
    ["https://private-trusted.fake-ip.test/", "PRIVATE_URL_BLOCKED"],
    ["https://198.18.0.1/", "PRIVATE_URL_BLOCKED"],
    ["http://127.0.0.1/", "PRIVATE_URL_BLOCKED"],
    ["http://10.0.0.5/private", "PRIVATE_URL_BLOCKED"],
  ])("blocks %s before Map Provider execution", async (url, code) => {
    const connected = await startClient();

    const result = await callMap(connected, url);

    expect(result.isError).toBe(true);
    expect(failureCode(result)).toBe(code);
    expect(await firecrawlEvents()).toEqual([]);
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

describe("real stdio Managed Browse through controlled fake-ip DNS", () => {
  it("opens and navigates a controlled public Page with ego private access disabled", async () => {
    const connected = await startClient();

    const opened = await openBrowsePage(connected, "https://public.fake-ip.test/start");
    expect(opened.isError).not.toBe(true);
    const openedOutput = opened.structuredContent as Record<string, any>;
    expect(openedOutput).toMatchObject({ spaceId: 7, status: "ok", pages: ["p1"] });
    const browseId = openedOutput.browseId as string;

    const absolute = await navigateBrowsePage(connected, browseId, "https://public.fake-ip.test/next");
    expect(absolute.isError).not.toBe(true);
    expect(absolute.structuredContent).toMatchObject({ browseId, spaceId: 7, status: "ok", pages: ["p1"] });

    // A same-origin relative navigation stays on the verified Page origin and needs no
    // additional DNS decision. The existing scheme and authority-smuggling guard remains.
    const relative = await navigateBrowsePage(connected, browseId, "/relative");
    expect(relative.isError).not.toBe(true);
    expect(relative.structuredContent).toMatchObject({ browseId, spaceId: 7, status: "ok" });
    const protocolRelative = await navigateBrowsePage(connected, browseId, "//evil.example/path");
    expect(protocolRelative.isError).toBe(true);
    expect(failureCode(protocolRelative)).toBe("INVALID_INPUT");

    expect((await egoEvents()).filter((event) => event.kind === "ego-navigation")).toEqual([
      { kind: "ego-navigation", spaceId: 7, url: "https://public.fake-ip.test/start" },
      { kind: "ego-navigation", spaceId: 7, url: "https://public.fake-ip.test/next" },
      { kind: "ego-navigation", spaceId: 7, url: "/relative" },
    ]);
    const dnsEvents = await events();
    expect(dnsEvents.filter((event) => event.kind === "system-lookup" && event.hostname === "public.fake-ip.test")).toHaveLength(2);
    expect(dnsEvents.filter((event) => event.kind === "trusted-a" && event.hostname === "public.fake-ip.test")).toHaveLength(2);
    const tasks = await browseTasks();
    expect(Object.keys(tasks)).toEqual([browseId]);
    expect(tasks[browseId]).toMatchObject({ browseId, spaceId: 7, status: "active", pages: ["p1"] });
  });

  it("reports fake-ip detection without trusted DNS before creating a Task Space", async () => {
    const connected = await startClient({ trusted: false });

    const result = await openBrowsePage(connected, "https://public.fake-ip.test/");

    expect(result.isError).toBe(true);
    expect(failureCode(result)).toBe("FAKE_IP_DNS_DETECTED");
    expect(JSON.stringify(result.content)).toContain("restart the MCP server or reload the session");
    expect(await egoEvents()).toEqual([]);
    expect(await browseTasks()).toEqual({});
    expect((await events()).some((event) => event.kind.startsWith("trusted-"))).toBe(false);
  });

  it("blocks unsafe and unverifiable open targets before ego execution", async () => {
    const connected = await startClient();

    for (const [url, code] of [
      ["http://127.0.0.1/", "PRIVATE_URL_BLOCKED"],
      ["http://localhost/", "PRIVATE_URL_BLOCKED"],
      ["https://198.18.0.1/", "PRIVATE_URL_BLOCKED"],
      ["https://mixed.fake-ip.test/", "PRIVATE_URL_BLOCKED"],
      ["https://private-trusted.fake-ip.test/", "PRIVATE_URL_BLOCKED"],
      ["https://unverified.fake-ip.test/", "FAKE_IP_DNS_UNVERIFIED"],
    ]) {
      const result = await openBrowsePage(connected, url);
      expect(result.isError, url).toBe(true);
      expect(failureCode(result), url).toBe(code);
    }

    expect(await egoEvents()).toEqual([]);
    expect(await browseTasks()).toEqual({});
  });

  it("blocks unsafe native navigation without replacing or taking over the Task Space", async () => {
    const connected = await startClient();
    const opened = await openBrowsePage(connected, "https://public.fake-ip.test/start");
    const browseId = (opened.structuredContent as Record<string, any>).browseId as string;
    const before = await browseTasks();
    const workBefore = (await egoEvents()).filter((event) => event.kind === "ego-work").length;

    for (const [url, code] of [
      ["http://10.0.0.5/private", "PRIVATE_URL_BLOCKED"],
      ["http://metadata.google.internal/", "PRIVATE_URL_BLOCKED"],
      ["https://mixed.fake-ip.test/", "PRIVATE_URL_BLOCKED"],
      ["https://unverified.fake-ip.test/", "FAKE_IP_DNS_UNVERIFIED"],
      ["file:///etc/passwd", "INVALID_INPUT"],
      ["https:public.fake-ip.test/next", "INVALID_INPUT"],
      ["/\\127.0.0.1/", "INVALID_INPUT"],
    ]) {
      const result = await navigateBrowsePage(connected, browseId, url);
      expect(result.isError, url).toBe(true);
      expect(failureCode(result), url).toBe(code);
    }

    const log = await egoEvents();
    expect(log.filter((event) => event.kind === "ego-work")).toHaveLength(workBefore);
    expect(log.filter((event) => event.kind === "ego-navigation")).toEqual([
      { kind: "ego-navigation", spaceId: 7, url: "https://public.fake-ip.test/start" },
    ]);
    expect(await browseTasks()).toEqual(before);
  });
});
