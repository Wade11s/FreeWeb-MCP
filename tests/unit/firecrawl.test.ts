import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { configFileSchema } from "../../src/config.js";
import { FreeWebError, errorInfo } from "../../src/errors.js";
import {
  crawlInputSchema,
  fetchInputSchema,
  fetchPageSchema,
  mapInputSchema,
  mapOutputSchema,
  searchInputSchema,
  type CrawlInput,
  type FetchInput,
  type SearchInput,
} from "../../src/types.js";
import {
  COMMAND_KILL_GRACE_MS,
  MAX_COMMAND_STDERR_CHARS,
  MAX_COMMAND_STDOUT_CHARS,
  nodeCommandRunner,
  nodeHttpSender,
  startFirecrawlRuntime,
  type ChildProcessLike,
  type HttpRequest,
  type SpawnCall,
} from "../../src/providers/firecrawl-process.js";
import { FirecrawlLocalProvider, FirecrawlSearchProvider, MAX_CRAWL_PAGES } from "../../src/providers/firecrawl.js";
import type { ProviderPreflight } from "../../src/providers/interfaces.js";

class FakeStream {
  readonly dataListeners: Array<(chunk: Buffer | string) => void> = [];

  on(event: string, listener: (chunk: Buffer | string) => void): this {
    if (event === "data") this.dataListeners.push(listener);
    return this;
  }

  write(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }
}

class FakeChild implements ChildProcessLike {
  pid = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly kills: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.killed = true;
    return true;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return configFileSchema.parse({ firecrawl: overrides }).firecrawl;
}

function healthResponse(): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({ status: "ok", engine: "firecrawl-local", version: "0.1.0" }),
  };
}

describe("Firecrawl Local v0.1.0 provider", () => {
  it("fetches one URL through POST /v2/scrape and normalises supported formats", async () => {
    const requests: HttpRequest[] = [];
    const spawnCalls: SpawnCall[] = [];
    const child = new FakeChild();
    const sender = async (request: HttpRequest) => {
      requests.push(request);
      if (request.method === "GET" && request.url.endsWith("/health")) return healthResponse();
      return {
        status: 200,
        body: JSON.stringify({
          success: true,
          data: {
            url: "https://example.com",
            markdown: "# Hello",
            metadata: { url: "https://example.com/final", title: "Example" },
          },
        }),
      };
    };

    const provider = new FirecrawlLocalProvider(config({ port: 34567 }), {
      http: sender,
      spawner: (call) => {
        spawnCalls.push(call);
        return child;
      },
      sleep: async () => {},
      now: () => 0,
    });

    const output = await provider.fetch(fetchInputSchema.parse({
      urls: ["https://example.com"],
      formats: ["markdown"],
    }));

    expect(output).toEqual({
      results: [{
        url: "https://example.com",
        finalUrl: "https://example.com/final",
        title: "Example",
        formats: { markdown: "# Hello" },
      }],
      errors: [],
    });

    const scrape = requests.find((request) => request.method === "POST");
    expect(scrape?.url).toBe("http://127.0.0.1:34567/v2/scrape");
    expect(JSON.parse(scrape?.body ?? "{}")).toEqual({
      url: "https://example.com",
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 30_000,
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toEqual(["serve", "--host", "127.0.0.1", "--port", "34567"]);
  });

  it("maps only the MCP-confirmed fields through POST /v2/map", async () => {
    const requests: HttpRequest[] = [];
    const sender = async (request: HttpRequest) => {
      requests.push(request);
      if (request.method === "GET" && request.url.endsWith("/health")) return healthResponse();
      return { status: 200, body: JSON.stringify({ success: true, links: [{ url: "https://example.com/docs" }] }) };
    };
    const provider = new FirecrawlLocalProvider(config({ port: 34568 }), {
      http: sender,
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    const output = await provider.map(mapInputSchema.parse({
      url: "https://example.com",
      limit: 25,
      search: "docs",
      includeSubdomains: true,
      sitemap: "only",
    }));

    expect(output).toEqual({ links: [{ url: "https://example.com/docs" }] });
    const map = requests.find((request) => request.method === "POST");
    expect(map?.url).toBe("http://127.0.0.1:34568/v2/map");
    expect(JSON.parse(map?.body ?? "{}")).toEqual({
      url: "https://example.com",
      limit: 25,
      includeSubdomains: true,
      sitemap: "only",
      search: "docs",
    });
  });

  it("maps crawl job payloads, status, data and errors without cloud-only fields", async () => {
    const requests: HttpRequest[] = [];
    const sender = async (request: HttpRequest) => {
      requests.push(request);
      if (request.method === "GET" && request.url.endsWith("/health")) return healthResponse();
      if (request.method === "POST") {
        return { status: 200, body: JSON.stringify({ success: true, id: "job-1", url: "http://127.0.0.1/v2/crawl/job-1" }) };
      }
      if (request.method === "GET") {
        return {
          status: 200,
          body: JSON.stringify({
            success: true,
            status: "completed",
            total: 2,
            completed: 2,
            data: [{
              url: "https://example.com/a",
              markdown: "# A",
              links: ["https://example.com/b"],
              metadata: { url: "https://example.com/a/final", title: "A" },
            }],
            errors: [{ code: "FETCH_FAILED", error: "Boom", url: "https://example.com/bad" }],
          }),
        };
      }
      return { status: 200, body: JSON.stringify({ success: true, status: "cancelled" }) };
    };
    const provider = new FirecrawlLocalProvider(config({ port: 34569 }), {
      http: sender,
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    const started = await provider.startCrawl(crawlInputSchema.parse({
      url: "https://example.com",
      limit: 5,
      maxDiscoveryDepth: 2,
      includePaths: ["^/blog/\\d+$"],
      excludePaths: ["(^|/)private/"],
      maxConcurrency: 2,
      delayMs: 250,
      sitemap: "include",
      formats: ["markdown", "links"],
      onlyMainContent: true,
      waitForMs: 1000,
      timeoutMs: 45_000,
    }));
    expect(started).toEqual({ id: "job-1" });

    const post = requests.find((request) => request.method === "POST");
    expect(post?.url).toBe("http://127.0.0.1:34569/v2/crawl");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      url: "https://example.com",
      limit: 5,
      maxDiscoveryDepth: 2,
      crawlEntireDomain: false,
      allowSubdomains: false,
      allowExternalLinks: false,
      includePaths: ["^/blog/\\d+$"],
      excludePaths: ["(^|/)private/"],
      maxConcurrency: 2,
      sitemap: "include",
      scrapeOptions: {
        formats: ["markdown", "links"],
        onlyMainContent: true,
        waitFor: 1000,
        timeout: 45_000,
      },
      delay: 250,
    });

    const snapshot = await provider.getCrawl("job-1");
    expect(snapshot).toEqual({
      status: "completed",
      total: 2,
      completed: 2,
      pages: [{
        url: "https://example.com/a",
        finalUrl: "https://example.com/a/final",
        title: "A",
        formats: { markdown: "# A", links: ["https://example.com/b"] },
      }],
      errors: [{ code: "FETCH_FAILED", message: "Boom", url: "https://example.com/bad" }],
    });

    await provider.cancelCrawl("job-1");
    expect(requests.find((request) => request.method === "DELETE")?.url).toBe("http://127.0.0.1:34569/v2/crawl/job-1");
  });

  it("refuses cloud-only crawl fields and regex objects that JSON would lose", async () => {
    const provider = new FirecrawlLocalProvider(config({ port: 34570 }), {
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });
    const base = crawlInputSchema.parse({ url: "https://example.com" });

    await expect(provider.startCrawl({ ...base, webhook: "https://example.com/hook" } as CrawlInput))
      .rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
    await expect(provider.startCrawl({ ...base, includePaths: [/private/] as unknown as string[] }))
      .rejects.toMatchObject({ code: "INVALID_REGEX" });
  });

  it("does not connect to an occupied configured port or kill a process it did not spawn", async () => {
    let now = 0;
    const spawnCalls: SpawnCall[] = [];
    const child = new FakeChild();
    const provider = new FirecrawlLocalProvider(config({ port: 34571, startupTimeoutMs: 1000 }), {
      probePort: async () => true,
      spawner: (call) => { spawnCalls.push(call); return child; },
      http: async () => { throw new Error("health should not be called"); },
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });

    await expect(provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] })))
      .rejects.toMatchObject({ code: "PORT_IN_USE" });
    expect(spawnCalls).toEqual([]);
    expect(child.kills).toEqual([]);
  });

  it("runs the search CLI with search-only cloud and parses its JSON envelope", async () => {
    const disabled = new FirecrawlSearchProvider(config({ searchFallback: false }), {
      commandRunner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    });
    await expect(disabled.search(searchInputSchema.parse({ query: "hello" })))
      .rejects.toMatchObject({ code: "SEARCH_FALLBACK_DISABLED" });

    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const provider = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async (call) => {
        calls.push(call);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            results: [{ url: "https://example.com/a", title: "A", description: "Snippet" }],
          }),
          stderr: "",
        };
      },
    });

    const output = await provider.search(searchInputSchema.parse({
      query: "hello world",
      limit: 3,
      provider: "firecrawl-search",
    }));

    expect(output).toEqual({
      results: [{ position: 1, title: "A", url: "https://example.com/a", snippet: "Snippet" }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("firecrawl-local");
    expect(calls[0]?.args).toEqual(["search", "-l", "3", "--", "hello world"]);
    expect(calls[0]?.env.FIRECRAWL_CLOUD).toBe("search");
  });

  it("rejects unsupported search options without running a command", async () => {
    const provider = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async () => { throw new Error("must not run"); },
    });
    await expect(provider.search({ ...searchInputSchema.parse({ query: "hello" }), extra: true } as SearchInput))
      .rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
  });

  it("uses an injected free port with cloud off and private targets disabled", async () => {
    const spawnCalls: SpawnCall[] = [];
    const requests: HttpRequest[] = [];
    const provider = new FirecrawlLocalProvider(config({ port: 0 }), {
      reservePort: async () => 45678,
      probePort: async () => false,
      http: async (request) => {
        requests.push(request);
        if (request.method === "GET") return healthResponse();
        return { status: 200, body: JSON.stringify({ success: true, data: { markdown: "ok" } }) };
      },
      spawner: (call) => { spawnCalls.push(call); return new FakeChild(); },
      sleep: async () => {},
      now: () => 0,
    });

    await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));

    expect(spawnCalls[0]?.args).toEqual(["serve", "--host", "127.0.0.1", "--port", "45678"]);
    expect(spawnCalls[0]?.env.FIRECRAWL_CLOUD).toBe("off");
    // firecrawl-local binds this to a clap bool flag: only true/false are valid.
    expect(spawnCalls[0]?.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE).toBe("false");
    expect(requests.find((request) => request.method === "POST")?.url).toBe("http://127.0.0.1:45678/v2/scrape");
  });

  it("passes --allow-private only when configured", async () => {
    const spawnCalls: SpawnCall[] = [];
    const provider = new FirecrawlLocalProvider(config({ port: 34572, allowPrivate: true }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET" ? healthResponse() : { status: 200, body: JSON.stringify({ success: true, data: {} }) },
      spawner: (call) => { spawnCalls.push(call); return new FakeChild(); },
      sleep: async () => {},
      now: () => 0,
    });

    await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    expect(spawnCalls[0]?.args).toContain("--allow-private");
    expect(spawnCalls[0]?.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE).toBe("true");
  });

  it("gives wrapper-validated target trust the same Provider-side relaxation without changing allowPrivate", async () => {
    const spawnCalls: SpawnCall[] = [];
    const trustedConfig = config({ port: 34576, trustWrapperTargetPolicy: true });
    const provider = new FirecrawlLocalProvider(trustedConfig, {
      probePort: async () => false,
      http: async (request) => request.method === "GET" ? healthResponse() : { status: 200, body: JSON.stringify({ success: true, data: {} }) },
      spawner: (call) => { spawnCalls.push(call); return new FakeChild(); },
      sleep: async () => {},
      now: () => 0,
    });

    await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    expect(trustedConfig.allowPrivate).toBe(false);
    expect(spawnCalls[0]?.args).toContain("--allow-private");
    expect(spawnCalls[0]?.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE).toBe("true");
    expect(spawnCalls[0]?.env.FIRECRAWL_CLOUD).toBe("off");
  });

  it("starts a Crawl with the same public-only serve protection as Fetch", async () => {
    const spawnCalls: SpawnCall[] = [];
    const requests: HttpRequest[] = [];
    const provider = new FirecrawlLocalProvider(config({ port: 34575 }), {
      probePort: async () => false,
      http: async (request) => {
        requests.push(request);
        if (request.method === "GET" && request.url.endsWith("/health")) return healthResponse();
        return { status: 200, body: JSON.stringify({ success: true, id: "job-1" }) };
      },
      spawner: (call) => { spawnCalls.push(call); return new FakeChild(); },
      sleep: async () => {},
      now: () => 0,
    });

    // Wrapper validation runs before this Provider call; the serve process still keeps its
    // own public-only protection instead of trusting the caller to have checked the target.
    const started = await provider.startCrawl(crawlInputSchema.parse({ url: "https://public.fake-ip.test/crawl" }));

    expect(started).toEqual({ id: "job-1" });
    expect(spawnCalls[0]?.args).toEqual(["serve", "--host", "127.0.0.1", "--port", "34575"]);
    expect(spawnCalls[0]?.args).not.toContain("--allow-private");
    expect(spawnCalls[0]?.env.FIRECRAWL_CLOUD).toBe("off");
    expect(spawnCalls[0]?.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE).toBe("false");
    const crawlRequest = requests.find((request) => request.method === "POST" && request.url.endsWith("/v2/crawl"));
    expect(JSON.parse(crawlRequest?.body ?? "{}").url).toBe("https://public.fake-ip.test/crawl");
  });

  it("cleans up its own child when health does not identify Firecrawl Local 0.1.0", async () => {
    let now = 0;
    const child = new FakeChild();
    const provider = new FirecrawlLocalProvider(config({ port: 34573, startupTimeoutMs: 1000, shutdownTimeoutMs: 100 }), {
      probePort: async () => false,
      http: async () => ({ status: 200, body: JSON.stringify({ status: "ok", engine: "another-server", version: "0.1.0" }) }),
      spawner: () => child,
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });

    await expect(provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] })))
      .rejects.toMatchObject({ code: "FIRECRAWL_START_FAILED" });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("closes only its own child with SIGTERM then SIGKILL and stays closed", async () => {
    let now = 0;
    const child = new FakeChild();
    const provider = new FirecrawlLocalProvider(config({ port: 34574, shutdownTimeoutMs: 100 }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET"
        ? healthResponse()
        : { status: 200, body: JSON.stringify({ success: true, data: { markdown: "ok" } }) },
      spawner: () => child,
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));

    await provider.close();
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    await provider.close();
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("consumes serve stdout/stderr into a bounded, redacted startup log buffer", async () => {
    let now = 0;
    const child = new FakeChild();
    const tinyfishKey = "tf-abcdefgh-secret-value";
    const firecrawlKey = "fc-ijklmnop-secret-value";
    const savedTinyfish = process.env.TINYFISH_API_KEY;
    const savedFirecrawl = process.env.FIRECRAWL_API_KEY;
    process.env.TINYFISH_API_KEY = tinyfishKey;
    process.env.FIRECRAWL_API_KEY = firecrawlKey;
    try {
      let emitted = false;
      const provider = new FirecrawlLocalProvider(config({ port: 34600, startupTimeoutMs: 1000 }), {
        probePort: async () => false,
        http: async () => {
          if (!emitted) {
            emitted = true;
            child.stderr.write(`${"x".repeat(5000)}\nFATAL cannot bind: api=${tinyfishKey}\nTINYFISH_API_KEY=${tinyfishKey}\nEND-OF-LOG\n`);
          }
          return { status: 200, body: JSON.stringify({ status: "ok", engine: "another-server", version: "0.1.0" }) };
        },
        spawner: () => child,
        sleep: async (ms) => { now += ms; },
        now: () => now,
      });

      const error = await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] })).catch((thrown: unknown) => thrown);

      expect(child.stderr.dataListeners.length).toBeGreaterThan(0);
      expect(child.stdout.dataListeners.length).toBeGreaterThan(0);
      expect(error).toMatchObject({ code: "FIRECRAWL_START_FAILED" });
      const message = (error as Error).message;
      expect(message).toContain("cannot bind");
      expect(message).toContain("END-OF-LOG");
      expect(message).not.toContain(tinyfishKey);
      expect(message).not.toContain(firecrawlKey);
      expect(message.length).toBeLessThan(4000);
    } finally {
      if (savedTinyfish === undefined) delete process.env.TINYFISH_API_KEY;
      else process.env.TINYFISH_API_KEY = savedTinyfish;
      if (savedFirecrawl === undefined) delete process.env.FIRECRAWL_API_KEY;
      else process.env.FIRECRAWL_API_KEY = savedFirecrawl;
    }
  });

  it("maps an aborted HTTP request to an outcome-uncertain timeout", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === "/slow") return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"status\":\"ok\"}");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(nodeHttpSender({ method: "GET", url: `http://127.0.0.1:${port}/slow`, timeoutMs: 50 }))
        .rejects.toMatchObject({
          code: "UPSTREAM_TIMEOUT_UNCERTAIN",
          options: { provider: "firecrawl-local", retryable: false },
        });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("maps 408 to an outcome-uncertain timeout so the router never repeats the request", async () => {
    const provider = new FirecrawlLocalProvider(config({ port: 34601 }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET"
        ? healthResponse()
        : { status: 408, body: "scrape deadline exceeded" },
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    const output = await provider.fetch(fetchInputSchema.parse({ urls: ["https://slow.example"] }));

    expect(output.errors).toEqual([{
      url: "https://slow.example",
      code: "UPSTREAM_TIMEOUT_UNCERTAIN",
      message: expect.stringContaining("408"),
      provider: "firecrawl-local",
      retryable: false,
    }]);
  });

  it("handles non-2xx status before JSON parsing and truncates HTML error bodies", async () => {
    const html = `<html><head><title>502 Bad Gateway</title></head><body>upstream boom${'<div>noise</div>'.repeat(400)}</body></html>`;
    const provider = new FirecrawlLocalProvider(config({ port: 34602 }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET" ? healthResponse() : { status: 502, body: html },
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    const output = await provider.fetch(fetchInputSchema.parse({ urls: ["https://gateway.example"] }));

    expect(output.errors).toHaveLength(1);
    const [error] = output.errors;
    expect(error?.code).toBe("FIRECRAWL_SERVER_ERROR");
    expect(error?.retryable).toBe(true);
    expect(error?.message).toContain("502");
    expect(error?.message).toContain("upstream boom");
    expect(error?.message.length).toBeLessThan(320);
    expect(error?.message).not.toContain("INVALID_RESPONSE");

    const unauthorized = new FirecrawlLocalProvider(config({ port: 34603 }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET"
        ? healthResponse()
        : { status: 401, body: "<html><body>unauthorized</body></html>" },
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });
    const denied = await unauthorized.fetch(fetchInputSchema.parse({ urls: ["https://private.example"] }));
    expect(denied.errors[0]).toMatchObject({ code: "UNAUTHORIZED", retryable: false });
  });

  it("keeps only absolute http(s) provider links so the MCP schema cannot fail", async () => {
    const provider = new FirecrawlLocalProvider(config({ port: 34604 }), {
      probePort: async () => false,
      http: async (request) => {
        if (request.method === "GET") return healthResponse();
        const body = JSON.parse(request.body ?? "{}") as { url: string };
        if (body.url.endsWith("/map")) {
          return {
            status: 200,
            body: JSON.stringify({
              success: true,
              links: [
                { url: "https://example.com/docs" },
                { url: "/relative" },
                { url: "javascript:alert(1)" },
                { url: "not a url" },
                { url: "ftp://example.com/file" },
              ],
            }),
          };
        }
        return {
          status: 200,
          body: JSON.stringify({
            success: true,
            data: { markdown: "# ok", metadata: { url: body.url.includes("relative.example") ? "/relative/final" : "https://example.com/final" } },
          }),
        };
      },
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    const mapped = await provider.map(mapInputSchema.parse({ url: "https://example.com/map" }));
    expect(mapped.links).toEqual([{ url: "https://example.com/docs" }]);
    expect(mapOutputSchema.shape.links.parse(mapped.links)).toEqual([{ url: "https://example.com/docs" }]);

    const fetched = await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com/page", "https://relative.example/page"] }));
    expect(fetched.errors).toEqual([]);
    expect(fetched.results.map((page) => page.finalUrl)).toEqual(["https://example.com/final", undefined]);
    for (const page of fetched.results) expect(fetchPageSchema.parse(page)).toEqual(page);
  });

  it("passes only a whitelisted child environment without provider API keys", async () => {
    const spawnCalls: SpawnCall[] = [];
    const commandCalls: Array<{ env: NodeJS.ProcessEnv }> = [];
    const saved = {
      tinyfish: process.env.TINYFISH_API_KEY,
      firecrawl: process.env.FIRECRAWL_API_KEY,
      proxy: process.env.HTTPS_PROXY,
    };
    process.env.TINYFISH_API_KEY = "tf-whitelist-secret";
    process.env.FIRECRAWL_API_KEY = "fc-whitelist-secret";
    process.env.HTTPS_PROXY = "http://proxy.internal:8080";
    try {
      const local = new FirecrawlLocalProvider(config({ port: 34605 }), {
        probePort: async () => false,
        http: async (request) => request.method === "GET"
          ? healthResponse()
          : { status: 200, body: JSON.stringify({ success: true, data: { markdown: "ok" } }) },
        spawner: (call) => { spawnCalls.push(call); return new FakeChild(); },
        sleep: async () => {},
        now: () => 0,
      });
      await local.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));

      const search = new FirecrawlSearchProvider(config({ searchFallback: true }), {
        commandRunner: async (call) => {
          commandCalls.push(call);
          return { exitCode: 0, stdout: JSON.stringify({ success: true, results: [] }), stderr: "" };
        },
      });
      await search.search(searchInputSchema.parse({ query: "hello" }));

      const serveEnv = spawnCalls[0]?.env ?? {};
      const searchEnv = commandCalls[0]?.env ?? {};
      for (const env of [serveEnv, searchEnv]) {
        expect(Object.keys(env)).not.toContain("TINYFISH_API_KEY");
        expect(Object.keys(env)).not.toContain("FIRECRAWL_API_KEY");
        expect(JSON.stringify(env)).not.toContain("whitelist-secret");
        expect(env.PATH).toBe(process.env.PATH);
        expect(env.HOME).toBe(process.env.HOME);
        expect(env.HTTPS_PROXY).toBe("http://proxy.internal:8080");
      }
      expect(serveEnv.TMPDIR).toBe(process.env.TMPDIR ?? serveEnv.TMPDIR);
      expect(serveEnv.FIRECRAWL_CLOUD).toBe("off");
      expect(serveEnv.FIRECRAWL_LOCAL_ALLOW_PRIVATE).toBe("false");
      expect(searchEnv.FIRECRAWL_CLOUD).toBe("search");
    } finally {
      if (saved.tinyfish === undefined) delete process.env.TINYFISH_API_KEY;
      else process.env.TINYFISH_API_KEY = saved.tinyfish;
      if (saved.firecrawl === undefined) delete process.env.FIRECRAWL_API_KEY;
      else process.env.FIRECRAWL_API_KEY = saved.firecrawl;
      if (saved.proxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved.proxy;
    }
  });

  it("escalates SIGTERM to SIGKILL and resolves instead of leaving a hung command", async () => {
    const startedAt = Date.now();
    const result = await nodeCommandRunner({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      env: { PATH: process.env.PATH },
      timeoutMs: 400,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(elapsed).toBeLessThan(400 + COMMAND_KILL_GRACE_MS + 3000);
  });

  it("bounds command stdout/stderr while keeping the stderr tail", async () => {
    const result = await nodeCommandRunner({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2000000)); process.stderr.write('y'.repeat(200000) + 'ERR-TAIL');"],
      env: { PATH: process.env.PATH },
      timeoutMs: 20_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_COMMAND_STDOUT_CHARS);
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_COMMAND_STDERR_CHARS);
    expect(result.stderr.endsWith("ERR-TAIL")).toBe(true);
  });

  it("maps local success:false and HTTP status to per-URL fetch errors", async () => {
    const provider = new FirecrawlLocalProvider(config({ port: 34575 }), {
      probePort: async () => false,
      http: async (request) => {
        if (request.method === "GET") return healthResponse();
        const body = JSON.parse(request.body ?? "{}") as { url: string };
        if (body.url === "https://blocked.example") {
          return { status: 200, body: JSON.stringify({ success: false, code: "BLOCKED_TARGET", error: "Blocked" }) };
        }
        if (body.url === "https://gateway.example") {
          return { status: 502, body: JSON.stringify({ error: "Bad gateway" }) };
        }
        return { status: 200, body: JSON.stringify({ success: true, data: { markdown: "ok" } }) };
      },
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    const output = await provider.fetch(fetchInputSchema.parse({
      urls: ["https://blocked.example", "https://gateway.example", "https://ok.example"],
    }));

    expect(output.errors).toEqual([
      { url: "https://blocked.example", code: "BLOCKED_TARGET", message: "Blocked", provider: "firecrawl-local", retryable: false },
      { url: "https://gateway.example", code: "FIRECRAWL_SERVER_ERROR", message: "Bad gateway", provider: "firecrawl-local", retryable: true },
    ]);
    expect(output.results).toHaveLength(1);
  });

  it("refuses unsupported fetch formats and unknown actions", async () => {
    const base = fetchInputSchema.parse({ urls: ["https://example.com"] });
    const provider = new FirecrawlLocalProvider(config({ port: 34576 }), {
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    await expect(provider.fetch({ ...base, formats: ["json"] }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await expect(provider.fetch({ ...base, actions: [{ type: "wait", milliseconds: 100 }] } as FetchInput))
      .rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
  });

  it("maps search CLI failures and cloud-only responses to errors", async () => {
    const failing = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: "not signed in" }),
    });
    await expect(failing.search(searchInputSchema.parse({ query: "hello" })))
      .rejects.toMatchObject({ code: "FIRECRAWL_SEARCH_FAILED", message: "not signed in" });

    const cloudOnly = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ success: false, code: "CLOUD_ONLY", error: "Cloud is off" }),
        stderr: "",
      }),
    });
    await expect(cloudOnly.search(searchInputSchema.parse({ query: "hello" })))
      .rejects.toMatchObject({ code: "CLOUD_ONLY", message: "Cloud is off" });
  });

  it("wraps a spawn ENOENT in FIRECRAWL_SEARCH_FAILED with firecrawl-search attribution", async () => {
    const enoent = Object.assign(new Error("spawn firecrawl-local ENOENT"), {
      code: "ENOENT",
      errno: -2,
      path: "firecrawl-local",
      syscall: "spawn firecrawl-local",
    });
    const provider = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async () => { throw enoent; },
    });

    const error = await provider.search(searchInputSchema.parse({ query: "hello" })).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FreeWebError);
    expect(error).toMatchObject({
      code: "FIRECRAWL_SEARCH_FAILED",
      options: { provider: "firecrawl-search", retryable: false, cause: enoent },
    });
    const message = (error as Error).message;
    expect(message).toContain("ENOENT");
    expect(message).toContain("firecrawl-local");
    expect(errorInfo(error, "firecrawl")).toMatchObject({
      code: "FIRECRAWL_SEARCH_FAILED",
      provider: "firecrawl-search",
      retryable: false,
      command: "firecrawl-local",
    });
  });

  it("wraps a non-Error spawn failure instead of leaking it untagged", async () => {
    const provider = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async () => { throw "spawn EACCES"; },
    });

    const error = await provider.search(searchInputSchema.parse({ query: "hello" })).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "FIRECRAWL_SEARCH_FAILED", options: { provider: "firecrawl-search" } });
    expect((error as Error).message).toContain("spawn EACCES");
  });

  it("fails an already-resolved Runtime immediately after serve exits, without killing a dead child", async () => {
    let now = 0;
    const child = new FakeChild();
    const requests: HttpRequest[] = [];
    const runtime = await startFirecrawlRuntime(config({ port: 34620, shutdownTimeoutMs: 100 }), {
      probePort: async () => false,
      http: async (request) => {
        requests.push(request);
        return healthResponse();
      },
      spawner: () => child,
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    let deaths = 0;
    runtime.onDead(() => { deaths += 1; });
    expect(runtime.isAlive()).toBe(true);

    child.exit(1);

    expect(deaths).toBe(1);
    expect(runtime.isAlive()).toBe(false);
    const requestsBefore = requests.length;
    await expect(runtime.request("/v2/scrape", { method: "POST", body: "{}" }))
      .rejects.toMatchObject({ code: "FIRECRAWL_PROCESS_DEAD", options: { retryable: false } });
    expect(requests).toHaveLength(requestsBefore);

    await runtime.close();
    await runtime.close();
    expect(child.kills).toEqual([]);
  });

  it("restarts local serve on demand after the resolved child exits", async () => {
    const children: FakeChild[] = [];
    const provider = new FirecrawlLocalProvider(config({ port: 34621 }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET"
        ? healthResponse()
        : { status: 200, body: JSON.stringify({ success: true, data: { markdown: "ok" } }) },
      spawner: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      sleep: async () => {},
      now: () => 0,
    });

    await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    expect(children).toHaveLength(1);

    children[0]!.exit(1);

    const output = await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    expect(output.errors).toEqual([]);
    expect(output.results).toHaveLength(1);
    expect(children).toHaveLength(2);
  });

  it("follows same-origin next pages and aggregates crawl data and errors", async () => {
    const requests: HttpRequest[] = [];
    const next = "http://127.0.0.1:34622/v2/crawl/job-paged?skip=1";
    const sender = async (request: HttpRequest) => {
      requests.push(request);
      if (request.method === "GET" && request.url.endsWith("/health")) return healthResponse();
      if (request.method === "POST") {
        return { status: 200, body: JSON.stringify({ success: true, id: "job-paged" }) };
      }
      if (request.url.endsWith("?skip=1")) {
        return {
          status: 200,
          body: JSON.stringify({
            success: true,
            status: "completed",
            total: 2,
            completed: 2,
            data: [{ url: "https://example.com/b", markdown: "# B" }],
            errors: [{ code: "B_FAILED", error: "B failed", url: "https://example.com/b-bad" }],
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          success: true,
          status: "scraping",
          total: 2,
          completed: 2,
          data: [{ url: "https://example.com/a", markdown: "# A" }],
          errors: [{ code: "A_FAILED", error: "A failed", url: "https://example.com/a-bad" }],
          next,
        }),
      };
    };
    const provider = new FirecrawlLocalProvider(config({ port: 34622 }), {
      probePort: async () => false,
      http: sender,
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    await provider.startCrawl(crawlInputSchema.parse({ url: "https://example.com" }));
    const snapshot = await provider.getCrawl("job-paged");

    expect(snapshot.status).toBe("completed");
    expect(snapshot.total).toBe(2);
    expect(snapshot.completed).toBe(2);
    expect(snapshot.pages.map((page) => page.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(snapshot.errors.map((error) => error.code)).toEqual(["A_FAILED", "B_FAILED"]);
    const statusCalls = requests.filter((request) => request.method === "GET" && request.url.includes("/v2/crawl/"));
    expect(statusCalls.map((request) => request.url)).toEqual([
      "http://127.0.0.1:34622/v2/crawl/job-paged",
      next,
    ]);
  });

  it("rejects a next page outside the local serve origin", async () => {
    const requests: HttpRequest[] = [];
    const provider = new FirecrawlLocalProvider(config({ port: 34623 }), {
      probePort: async () => false,
      http: async (request) => {
        requests.push(request);
        if (request.method === "GET" && request.url.endsWith("/health")) return healthResponse();
        return {
          status: 200,
          body: JSON.stringify({
            success: true,
            status: "completed",
            data: [],
            next: "https://evil.example/v2/crawl/job-external?skip=1",
          }),
        };
      },
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    await expect(provider.getCrawl("job-external"))
      .rejects.toMatchObject({ code: "FIRECRAWL_INVALID_NEXT", options: { details: { reason: "origin" } } });
    expect(requests.some((request) => request.url.includes("evil.example"))).toBe(false);
  });

  it("rejects a next page that points outside /v2/crawl or loops back", async () => {
    const sender = (next: string) => async (request: HttpRequest) => {
      if (request.method === "GET" && request.url.endsWith("/health")) return healthResponse();
      return { status: 200, body: JSON.stringify({ success: true, status: "completed", data: [], next }) };
    };
    const outsidePath = new FirecrawlLocalProvider(config({ port: 34624 }), {
      probePort: async () => false,
      http: sender("http://127.0.0.1:34624/v2/scrape?skip=1"),
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });
    await expect(outsidePath.getCrawl("job-path"))
      .rejects.toMatchObject({ code: "FIRECRAWL_INVALID_NEXT", options: { details: { reason: "path" } } });

    const looped = new FirecrawlLocalProvider(config({ port: 34625 }), {
      probePort: async () => false,
      http: sender("http://127.0.0.1:34625/v2/crawl/job-loop"),
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });
    await expect(looped.getCrawl("job-loop"))
      .rejects.toMatchObject({ code: "FIRECRAWL_INVALID_NEXT", options: { details: { reason: "loop" } } });
  });

  it("rejects crawl pagination that never stops", async () => {
    let requests = 0;
    const provider = new FirecrawlLocalProvider(config({ port: 34626 }), {
      probePort: async () => false,
      http: async (request) => {
        if (request.method === "GET" && request.url.endsWith("/health")) return healthResponse();
        requests += 1;
        return {
          status: 200,
          body: JSON.stringify({
            success: true,
            status: "completed",
            data: [],
            next: `http://127.0.0.1:34626/v2/crawl/job-endless?page=${requests + 1}`,
          }),
        };
      },
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    await expect(provider.getCrawl("job-endless"))
      .rejects.toMatchObject({ code: "FIRECRAWL_INVALID_NEXT", options: { details: { reason: "limit" } } });
    expect(requests).toBe(MAX_CRAWL_PAGES);
  });

  it("dedupes search results by URL and renumbers positions consecutively", async () => {
    const provider = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          results: [
            { url: "https://example.com/a", title: "A", description: "First" },
            { url: "https://example.com/b", title: "B" },
            { url: "https://example.com/a", title: "A again", description: "Duplicate" },
            { url: "https://example.com/c", title: "C" },
          ],
        }),
        stderr: "",
      }),
    });

    const output = await provider.search(searchInputSchema.parse({ query: "hello", limit: 4 }));

    expect(output.results).toEqual([
      { position: 1, title: "A", url: "https://example.com/a", snippet: "First" },
      { position: 2, title: "B", url: "https://example.com/b" },
      { position: 3, title: "C", url: "https://example.com/c" },
    ]);
  });

  it("refuses every local operation after close instead of spawning serve again", async () => {
    let now = 0;
    const spawnCalls: SpawnCall[] = [];
    const child = new FakeChild();
    const provider = new FirecrawlLocalProvider(config({ port: 34630, shutdownTimeoutMs: 100 }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET"
        ? healthResponse()
        : { status: 200, body: JSON.stringify({ success: true, data: { markdown: "ok" } }) },
      spawner: (call) => { spawnCalls.push(call); return child; },
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });

    await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    expect(spawnCalls).toHaveLength(1);

    await provider.close();
    await provider.close();

    const closed = { code: "FIRECRAWL_PROVIDER_CLOSED" };
    await expect(provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] })))
      .rejects.toMatchObject(closed);
    await expect(provider.map(mapInputSchema.parse({ url: "https://example.com" })))
      .rejects.toMatchObject(closed);
    await expect(provider.startCrawl(crawlInputSchema.parse({ url: "https://example.com" })))
      .rejects.toMatchObject(closed);
    await expect(provider.getCrawl("job-1")).rejects.toMatchObject(closed);
    await expect(provider.cancelCrawl("job-1")).rejects.toMatchObject(closed);

    expect(spawnCalls).toHaveLength(1);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stays closed when its child dies after close and cannot be reopened by death notices", async () => {
    let now = 0;
    const spawnCalls: SpawnCall[] = [];
    const child = new FakeChild();
    const provider = new FirecrawlLocalProvider(config({ port: 34631, shutdownTimeoutMs: 100 }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET"
        ? healthResponse()
        : { status: 200, body: JSON.stringify({ success: true, data: { markdown: "ok" } }) },
      spawner: (call) => { spawnCalls.push(call); return child; },
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });

    await provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    await provider.close();

    child.exit(1);
    await provider.close();

    await expect(provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] })))
      .rejects.toMatchObject({ code: "FIRECRAWL_PROVIDER_CLOSED" });
    expect(spawnCalls).toHaveLength(1);
  });

  it("aborts a pending startup on close instead of waiting out the health deadline", async () => {
    let now = 0;
    let sleeps = 0;
    const spawnCalls: SpawnCall[] = [];
    const child = new FakeChild();
    const provider = new FirecrawlLocalProvider(
      config({ port: 34650, startupTimeoutMs: 120_000, shutdownTimeoutMs: 100 }),
      {
        probePort: async () => false,
        // A health endpoint that never answers must not keep close() waiting.
        http: () => new Promise(() => {}),
        spawner: (call) => { spawnCalls.push(call); return child; },
        sleep: async (ms) => { sleeps += 1; now += ms; },
        now: () => now,
      },
    );

    const pending = provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawnCalls).toHaveLength(1);

    await provider.close();

    await expect(pending).rejects.toMatchObject({ code: "FIRECRAWL_PROVIDER_CLOSED" });
    expect(spawnCalls).toHaveLength(1);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    // Bounded by shutdownTimeoutMs, not by the 120s startup deadline.
    expect(now).toBeLessThan(1000);
    expect(sleeps).toBeLessThan(20);
  });

  it("keeps close idempotent and bounded while a startup is pending", async () => {
    let now = 0;
    const spawnCalls: SpawnCall[] = [];
    const child = new FakeChild();
    const provider = new FirecrawlLocalProvider(
      config({ port: 34651, startupTimeoutMs: 120_000, shutdownTimeoutMs: 100 }),
      {
        probePort: async () => false,
        http: () => new Promise(() => {}),
        spawner: (call) => { spawnCalls.push(call); return child; },
        sleep: async (ms) => { now += ms; },
        now: () => now,
      },
    );

    const first = provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    const second = provider.map(mapInputSchema.parse({ url: "https://example.com" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await Promise.all([provider.close(), provider.close()]);

    const closed = { code: "FIRECRAWL_PROVIDER_CLOSED" };
    await expect(first).rejects.toMatchObject(closed);
    await expect(second).rejects.toMatchObject(closed);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawnCalls).toHaveLength(1);
    expect(now).toBeLessThan(1000);

    // Reopening stays refused and never spawns again.
    await expect(provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] })))
      .rejects.toMatchObject(closed);
    expect(spawnCalls).toHaveLength(1);
  });

  it("stops its own child when the startup signal aborts during the health poll", async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    let now = 0;
    const started = startFirecrawlRuntime(
      config({ port: 34652, startupTimeoutMs: 120_000, shutdownTimeoutMs: 100 }),
      {
        probePort: async () => false,
        http: () => new Promise(() => {}),
        spawner: () => child,
        sleep: async (ms) => { now += ms; },
        now: () => now,
      },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();

    await expect(started).rejects.toMatchObject({ code: "FIRECRAWL_START_ABORTED" });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(now).toBeLessThan(1000);
  });

  it("does not spawn serve when the startup signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnCalls: SpawnCall[] = [];

    await expect(startFirecrawlRuntime(
      config({ port: 34653 }),
      {
        probePort: async () => false,
        spawner: (call) => { spawnCalls.push(call); return new FakeChild(); },
        sleep: async () => {},
        now: () => 0,
      },
      controller.signal,
    )).rejects.toMatchObject({ code: "FIRECRAWL_START_ABORTED" });

    expect(spawnCalls).toEqual([]);
  });

  it("cancels a startup at the port probe so a close never spends a serve process", async () => {
    let now = 0;
    let spawnCalls = 0;
    let releaseProbe: ((inUse: boolean) => void) | undefined;
    const child = new FakeChild();
    const provider = new FirecrawlLocalProvider(config({ port: 34654, shutdownTimeoutMs: 100 }), {
      probePort: () => new Promise<boolean>((resolve) => { releaseProbe = resolve; }),
      http: async () => healthResponse(),
      spawner: () => { spawnCalls += 1; return child; },
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });

    const pending = provider.fetch(fetchInputSchema.parse({ urls: ["https://example.com"] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = provider.close();
    releaseProbe?.(false);
    await closing;

    await expect(pending).rejects.toMatchObject({ code: "FIRECRAWL_PROVIDER_CLOSED" });
    expect(spawnCalls).toBe(0);
    expect(child.kills).toEqual([]);
  });

  it("keeps a local 404 mapped to NOT_FOUND instead of inventing a new status", async () => {
    const provider = new FirecrawlLocalProvider(config({ port: 34627 }), {
      probePort: async () => false,
      http: async (request) => request.method === "GET" && request.url.endsWith("/health")
        ? healthResponse()
        : { status: 404, body: "crawl job not found" },
      spawner: () => new FakeChild(),
      sleep: async () => {},
      now: () => 0,
    });

    await expect(provider.getCrawl("missing-job"))
      .rejects.toMatchObject({ code: "NOT_FOUND", options: { retryable: false } });
  });
});

describe("Firecrawl adapter preflight", () => {
  function expectSearchRefusal(verdict: ProviderPreflight): void {
    if (verdict.supported) throw new Error("Expected a Firecrawl Search refusal");
    expect(verdict.code).toBe("FALLBACK_UNSUPPORTED");
    expect(verdict.message).toBe("Provider-specific filters are incompatible");
    expect(verdict.error).toBeInstanceOf(FreeWebError);
    expect(verdict.error.code).toBe("FALLBACK_UNSUPPORTED");
    expect(verdict.error.message).toBe("Firecrawl Search cannot preserve TinyFish-specific filters");
    expect(verdict.error.options).toMatchObject({ provider: "firecrawl-search" });
    // The Router-facing skipped-attempt diagnostic is not the provider error message.
    expect(verdict.message).not.toBe(verdict.error.message);
  }

  function expectJsonRefusal(verdict: ProviderPreflight): void {
    if (verdict.supported) throw new Error("Expected a Firecrawl Local JSON refusal");
    expect(verdict.code).toBe("UNSUPPORTED_OPTION");
    expect(verdict.message).toBe("Firecrawl Local does not support JSON extraction");
    expect(verdict.error).toBeInstanceOf(FreeWebError);
    expect(verdict.error.code).toBe("UNSUPPORTED_OPTION");
    expect(verdict.error.message).toBe("Firecrawl Local does not support JSON extraction");
    expect(verdict.error.options).toMatchObject({ provider: "firecrawl-local" });
  }

  it("supports Firecrawl Search when no TinyFish-specific filter has a defined value", () => {
    const provider = new FirecrawlSearchProvider(config({ searchFallback: false }), {
      commandRunner: async () => { throw new Error("must not run"); },
    });

    expect(provider.inspectSearch(searchInputSchema.parse({ query: "hello" }))).toEqual({ supported: true });
    expect(provider.inspectSearch(searchInputSchema.parse({ query: "hello", options: {} })))
      .toEqual({ supported: true });
    const undefinedOnly = {
      ...searchInputSchema.parse({ query: "hello" }),
      options: { location: undefined },
    } as SearchInput;
    expect(provider.inspectSearch(undefinedOnly)).toEqual({ supported: true });
  });

  it.each([
    ["location", { location: "US" }],
    ["language", { language: "en" }],
    ["includeDomains", { includeDomains: ["example.com"] }],
    ["excludeDomains", { excludeDomains: ["example.com"] }],
    ["page", { page: 2 }],
  ])("refuses Firecrawl Search for the defined %s filter", (_label, options) => {
    const provider = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async () => { throw new Error("must not run"); },
    });

    const verdict = provider.inspectSearch(searchInputSchema.parse({ query: "hello", options }));

    expectSearchRefusal(verdict);
  });

  it("keeps the direct Firecrawl Search error distinct from the preflight diagnostic", async () => {
    const provider = new FirecrawlSearchProvider(config({ searchFallback: true }), {
      commandRunner: async () => { throw new Error("must not run"); },
    });
    const input = searchInputSchema.parse({ query: "hello", options: { location: "US" } });

    expectSearchRefusal(provider.inspectSearch(input));
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPTION",
      message: "Firecrawl search does not support MCP search options",
      options: { provider: "firecrawl-search", details: { options: ["location"] } },
    });
  });

  it("refuses a present-but-undefined direct Search option while preflight stays supported", async () => {
    const runner = vi.fn(async () => { throw new Error("must not run"); });
    const provider = new FirecrawlSearchProvider(config({ searchFallback: true }), { commandRunner: runner });
    const input = { ...searchInputSchema.parse({ query: "hello" }), options: { location: undefined } };

    expect(provider.inspectSearch(input)).toEqual({ supported: true });
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPTION",
      message: "Firecrawl search does not support MCP search options",
      options: { provider: "firecrawl-search", details: { options: ["location"] } },
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("supports every schema-valid Firecrawl Local format except JSON extraction", () => {
    const provider = new FirecrawlLocalProvider(config({ port: 34660 }), {
      spawner: () => new FakeChild(),
    });
    const base = { urls: ["https://example.com"] };

    for (const formats of [
      ["markdown"],
      ["html"],
      ["rawHtml"],
      ["links"],
      ["screenshot"],
      ["markdown", "html", "rawHtml", "links", "screenshot"],
    ]) {
      expect(provider.inspectFetch(fetchInputSchema.parse({ ...base, formats }))).toEqual({ supported: true });
    }
  });

  it("refuses Firecrawl Local preflight when formats include json", () => {
    const provider = new FirecrawlLocalProvider(config({ port: 34661 }), {
      spawner: () => new FakeChild(),
    });

    expectJsonRefusal(provider.inspectFetch(fetchInputSchema.parse({
      urls: ["https://example.com"],
      formats: ["markdown", "json"],
    })));
  });

  it("keeps the direct Firecrawl Local format error distinct from the preflight diagnostic", async () => {
    const provider = new FirecrawlLocalProvider(config({ port: 34662 }), {
      spawner: () => new FakeChild(),
    });
    const input = fetchInputSchema.parse({
      urls: ["https://example.com"],
      formats: ["markdown", "json"],
    });

    expectJsonRefusal(provider.inspectFetch(input));
    await expect(provider.fetch(input)).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
      message: "Firecrawl Local cannot produce: json",
      options: { provider: "firecrawl-local", details: { formats: ["json"] } },
    });
  });

  it("does no I/O, starts no runtime and runs no command during preflight", () => {
    const http = vi.fn(async () => { throw new Error("preflight must not send HTTP"); });
    const spawner = vi.fn(() => { throw new Error("preflight must not spawn serve"); });
    const probePort = vi.fn(async () => { throw new Error("preflight must not probe a port"); });
    const reservePort = vi.fn(async () => { throw new Error("preflight must not reserve a port"); });
    const commandRunner = vi.fn(async () => { throw new Error("preflight must not run a command"); });
    const getRuntime = vi.spyOn(
      FirecrawlLocalProvider.prototype as unknown as { getRuntime: () => Promise<unknown> },
      "getRuntime",
    );

    try {
      const local = new FirecrawlLocalProvider(config({ port: 34663 }), {
        http,
        spawner,
        probePort,
        reservePort,
      });
      const search = new FirecrawlSearchProvider(config({ searchFallback: true }), { commandRunner });

      expect(local.inspectFetch(fetchInputSchema.parse({ urls: ["https://example.com"] })))
        .toEqual({ supported: true });
      expect(local.inspectFetch(fetchInputSchema.parse({ urls: ["https://example.com"], formats: ["json"] })).supported)
        .toBe(false);
      expect(search.inspectSearch(searchInputSchema.parse({ query: "hello" }))).toEqual({ supported: true });
      expect(search.inspectSearch(searchInputSchema.parse({ query: "hello", options: { location: "US" } })).supported)
        .toBe(false);

      expect(getRuntime).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(spawner).not.toHaveBeenCalled();
      expect(probePort).not.toHaveBeenCalled();
      expect(reservePort).not.toHaveBeenCalled();
      expect(commandRunner).not.toHaveBeenCalled();
    } finally {
      getRuntime.mockRestore();
    }
  });
});
