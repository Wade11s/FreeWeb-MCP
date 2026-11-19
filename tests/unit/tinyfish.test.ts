import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { FreeWebError } from "../../src/errors.js";
import {
  TinyFishProvider,
  type TinyFishClientHandle,
  type TinyFishClientOptions,
} from "../../src/providers/tinyfish.js";
import type { FetchInput, SearchInput } from "../../src/types.js";

function tinyfishConfig(overrides: Partial<AppConfig["tinyfish"]> = {}): AppConfig["tinyfish"] {
  return {
    freeOnlyConfirmed: true,
    searchTimeoutMs: 10_000,
    fetchTimeoutMs: 150_000,
    apiKey: "test-api-key",
    ...overrides,
  };
}

function searchInput(overrides: Partial<SearchInput> = {}): SearchInput {
  return { query: "cats", limit: 10, provider: "tinyfish", fallback: false, ...overrides };
}

function fetchInput(overrides: Partial<FetchInput> = {}): FetchInput {
  return {
    urls: ["https://example.com/a"],
    formats: ["markdown"],
    onlyMainContent: true,
    waitForMs: 0,
    timeoutMs: 30_000,
    provider: "tinyfish",
    fallback: false,
    ...overrides,
  };
}

function fakeClient(): TinyFishClientHandle {
  return {
    search: { query: vi.fn(async () => ({ query: "cats", results: [], total_results: 0, page: 0 })) },
    fetch: { getContents: vi.fn(async () => ({ results: [], errors: [] })) },
  };
}

describe("TinyFishProvider configuration gate", () => {
  it("exposes the tinyfish provider name", () => {
    const provider = new TinyFishProvider(tinyfishConfig());
    expect(provider.name).toBe("tinyfish");
  });

  it.each([
    ["missing apiKey", tinyfishConfig({ apiKey: undefined })],
    ["blank apiKey", tinyfishConfig({ apiKey: "   " })],
    ["freeOnlyConfirmed false", tinyfishConfig({ freeOnlyConfirmed: false })],
  ])("rejects search when %s", async (_label, config) => {
    const factory = vi.fn((_options: TinyFishClientOptions) => fakeClient());
    const provider = new TinyFishProvider(config, { clientFactory: factory });

    await expect(provider.search(searchInput())).rejects.toMatchObject({
      code: "TINYFISH_NOT_CONFIGURED",
      options: expect.objectContaining({ provider: "tinyfish", retryable: false }),
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    ["missing apiKey", tinyfishConfig({ apiKey: undefined })],
    ["freeOnlyConfirmed false", tinyfishConfig({ freeOnlyConfirmed: false })],
  ])("rejects fetch when %s", async (_label, config) => {
    const factory = vi.fn((_options: TinyFishClientOptions) => fakeClient());
    const provider = new TinyFishProvider(config, { clientFactory: factory });

    await expect(provider.fetch(fetchInput())).rejects.toMatchObject({
      code: "TINYFISH_NOT_CONFIGURED",
      options: expect.objectContaining({ provider: "tinyfish" }),
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("throws FreeWebError instances, not plain errors", async () => {
    const provider = new TinyFishProvider(tinyfishConfig({ freeOnlyConfirmed: false }));
    await expect(provider.search(searchInput())).rejects.toBeInstanceOf(FreeWebError);
  });
});

describe("TinyFishProvider search mapping", () => {
  it("builds the SDK search client with config timeout and maxRetries: 0", async () => {
    const config = tinyfishConfig({ searchTimeoutMs: 12_345 });
    const factory = vi.fn((_options: TinyFishClientOptions) => fakeClient());
    const provider = new TinyFishProvider(config, { clientFactory: factory });

    await provider.search(searchInput({ query: "docs" }));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      apiKey: "test-api-key",
      timeout: 12_345,
      maxRetries: 0,
    });
  });

  it("uses an injected search client instead of creating one", async () => {
    const client = fakeClient();
    const factory = vi.fn((_options: TinyFishClientOptions) => fakeClient());
    const provider = new TinyFishProvider(tinyfishConfig(), {
      clientFactory: factory,
      searchClient: client,
    });

    await provider.search(searchInput());

    expect(client.search.query).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
  });

  it("maps public and TinyFish-specific search options", async () => {
    const client = fakeClient();
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });
    const input = {
      ...searchInput({ query: "machine learning" }),
      options: {
        location: "US",
        language: "en",
        includeDomains: ["github.com", "arxiv.org"],
        excludeDomains: ["pinterest.com"],
        page: 2,
        purpose: "research",
        recencyMinutes: 60,
        domainType: "news" as const,
        pubYearMin: 2020,
        pubYearMax: 2024,
      },
    } as unknown as SearchInput;

    await provider.search(input);

    expect(client.search.query).toHaveBeenCalledWith({
      query: "machine learning",
      location: "US",
      language: "en",
      include_domains: "github.com,arxiv.org",
      exclude_domains: "pinterest.com",
      page: 2,
      purpose: "research",
      recency_minutes: 60,
      domain_type: "news",
      pub_year_min: 2020,
      pub_year_max: 2024,
    });
  });

  it("normalizes search results: filters invalid/duplicate URLs, reindexes positions, applies limit", async () => {
    const client = fakeClient();
    client.search.query = vi.fn(async () => ({
      query: "cats",
      page: 0,
      total_results: 5,
      results: [
        { position: 9, site_name: "a", snippet: "first", title: "First", url: "https://a.example/1" },
        { position: 1, site_name: "b", snippet: "dupe", title: "Dupe", url: "https://a.example/1" },
        { position: 3, site_name: "c", snippet: "second", title: "Second", url: "https://b.example/2" },
        { position: 4, site_name: "d", snippet: "bad", title: "Bad", url: "not-a-url" },
      ],
    }));
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const output = await provider.search(searchInput({ limit: 2 }));

    expect(output.results).toEqual([
      { position: 1, title: "First", url: "https://a.example/1", snippet: "first" },
      { position: 2, title: "Second", url: "https://b.example/2", snippet: "second" },
    ]);
  });

  it("rejects unknown search options instead of silently dropping them", async () => {
    const client = fakeClient();
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });
    const input = {
      ...searchInput(),
      options: { mysteryFlag: true },
    } as unknown as SearchInput;

    await expect(provider.search(input)).rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
    expect(client.search.query).not.toHaveBeenCalled();
  });
});

describe("TinyFishProvider fetch mapping", () => {
  it("builds the SDK fetch client with the configured fetch timeout", async () => {
    const factory = vi.fn((_options: TinyFishClientOptions) => fakeClient());
    const provider = new TinyFishProvider(tinyfishConfig({ fetchTimeoutMs: 123_456 }), {
      clientFactory: factory,
    });

    await provider.fetch(fetchInput());

    expect(factory).toHaveBeenCalledWith({
      apiKey: "test-api-key",
      timeout: 123_456,
      maxRetries: 0,
    });
  });

  it("maps markdown + links params and SDK results/errors", async () => {
    const client = fakeClient();
    client.fetch.getContents = vi.fn(async () => ({
      results: [
        {
          url: "https://example.com/a",
          final_url: "https://example.com/final",
          title: "Title",
          description: "Description",
          language: "en",
          author: null,
          published_date: null,
          format: "markdown" as const,
          text: "# Hello",
          links: ["https://example.com/b"],
        },
      ],
      errors: [{ url: "https://example.com/bad", error: "timeout after 30000ms" }],
    }));
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const output = await provider.fetch(fetchInput({
      urls: ["https://example.com/a", "https://example.com/bad"],
      formats: ["markdown", "links"],
      timeoutMs: 45_000,
    }));

    expect(client.fetch.getContents).toHaveBeenCalledWith({
      urls: ["https://example.com/a", "https://example.com/bad"],
      format: "markdown",
      links: true,
      per_url_timeout_ms: 45_000,
    });
    expect(output.results).toEqual([
      {
        url: "https://example.com/a",
        finalUrl: "https://example.com/final",
        title: "Title",
        description: "Description",
        language: "en",
        formats: { markdown: "# Hello" },
        links: ["https://example.com/b"],
      },
    ]);
    expect(output.errors).toEqual([
      {
        url: "https://example.com/bad",
        code: "UPSTREAM_TIMEOUT_UNCERTAIN",
        message: "timeout after 30000ms",
        provider: "tinyfish",
        retryable: false,
      },
    ]);
  });

  it("maps html and json formats without requesting links", async () => {
    const client = fakeClient();
    client.fetch.getContents = vi.fn(async () => ({ results: [], errors: [] }));
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    await provider.fetch(fetchInput({ formats: ["html"] }));
    expect(client.fetch.getContents).toHaveBeenLastCalledWith({
      urls: ["https://example.com/a"],
      format: "html",
      per_url_timeout_ms: 30_000,
    });

    await provider.fetch(fetchInput({ formats: ["json"] }));
    expect(client.fetch.getContents).toHaveBeenLastCalledWith({
      urls: ["https://example.com/a"],
      format: "json",
      per_url_timeout_ms: 30_000,
    });
  });

  it("supports links-only fetches", async () => {
    const client = fakeClient();
    client.fetch.getContents = vi.fn(async () => ({
      results: [{ url: "https://example.com/a", final_url: null, title: null, description: null, language: null, author: null, published_date: null, format: "markdown" as const, text: null, links: ["https://example.com/b"] }],
      errors: [],
    }));
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const output = await provider.fetch(fetchInput({ formats: ["links"] }));

    expect(client.fetch.getContents).toHaveBeenCalledWith({
      urls: ["https://example.com/a"],
      links: true,
      per_url_timeout_ms: 30_000,
    });
    expect(output.results[0]?.links).toEqual(["https://example.com/b"]);
    expect(output.results[0]?.formats).toEqual({});
  });

  it.each([
    ["rawHtml", fetchInput({ formats: ["rawHtml"] })],
    ["screenshot", fetchInput({ formats: ["screenshot"] })],
    ["multiple content formats", fetchInput({ formats: ["markdown", "html"] })],
    ["waitForMs > 0", fetchInput({ waitForMs: 1 })],
    ["onlyMainContent:false", fetchInput({ onlyMainContent: false })],
    ["includeSelectors", fetchInput({ includeSelectors: ["main"] })],
    ["excludeSelectors", fetchInput({ excludeSelectors: ["nav"] })],
    ["timeoutMs above SDK per_url_timeout_ms cap", fetchInput({ timeoutMs: 111_000 })],
  ])("rejects %s with UNSUPPORTED_OPTION", async (_label, input) => {
    const client = fakeClient();
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    await expect(provider.fetch(input)).rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
    expect(client.fetch.getContents).not.toHaveBeenCalled();
  });
});

describe("TinyFishProvider batching and coverage", () => {
  it("uses timeout-bounded batches and preserves other URL results when one batch times out", async () => {
    const client = fakeClient();
    let calls = 0;
    client.fetch.getContents = vi.fn(async ({ urls }: { urls: string[] }) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("batch deadline"), { name: "APITimeoutError" });
      return {
        results: [{
          url: urls[0],
          final_url: urls[0],
          title: "B",
          description: null,
          language: "en",
          author: null,
          published_date: null,
          format: "markdown" as const,
          text: "ok",
        }],
        errors: [],
      };
    });
    const provider = new TinyFishProvider(tinyfishConfig(), { client });

    const output = await provider.fetch(fetchInput({
      urls: ["https://example.com/a", "https://example.com/b"],
      timeoutMs: 110_000,
    }));

    expect(calls).toBe(2);
    expect(output.results.map((page) => page.url)).toEqual(["https://example.com/b"]);
    expect(output.errors).toEqual([expect.objectContaining({
      url: "https://example.com/a",
      code: "UPSTREAM_TIMEOUT_UNCERTAIN",
      retryable: false,
    })]);
  });

  it("reports URLs omitted from both results and errors", async () => {
    const client = fakeClient();
    const provider = new TinyFishProvider(tinyfishConfig(), { client });

    const output = await provider.fetch(fetchInput());
    expect(output.results).toEqual([]);
    expect(output.errors).toEqual([expect.objectContaining({
      url: "https://example.com/a",
      code: "TINYFISH_EMPTY_RESULT",
    })]);
  });
});

describe("TinyFishProvider invalid provider URLs", () => {
  it("turns an invalid result URL into a structured error instead of an MCP schema failure", async () => {
    const client = fakeClient();
    client.fetch.getContents = vi.fn(async () => ({
      results: [{
        url: "/relative",
        final_url: null,
        title: null,
        description: null,
        language: null,
        author: null,
        published_date: null,
        format: "markdown" as const,
        text: "bad",
      }],
      errors: [],
    }));
    const provider = new TinyFishProvider(tinyfishConfig(), { client });

    const output = await provider.fetch(fetchInput());
    expect(output.results).toEqual([]);
    expect(output.errors).toEqual([{
      url: "https://example.com/a",
      code: "INVALID_PROVIDER_URL",
      message: "TinyFish returned an invalid result URL",
      provider: "tinyfish",
      retryable: false,
    }]);
  });
});

describe("TinyFishProvider error classification", () => {
  async function capture(promise: Promise<unknown>): Promise<FreeWebError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(FreeWebError);
      return error as FreeWebError;
    }
    throw new Error("Expected provider call to reject");
  }

  it("classifies authentication errors as non-retryable", async () => {
    const { AuthenticationError } = await import("@tiny-fish/sdk");
    const client = fakeClient();
    client.search.query = vi.fn(async () => {
      throw new AuthenticationError("invalid key", { response: new Response(null, { status: 401 }) });
    });
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const error = await capture(provider.search(searchInput()));

    expect(error.code).toBe("TINYFISH_AUTH");
    expect(error.options).toMatchObject({ provider: "tinyfish", retryable: false });
    expect(client.search.query).toHaveBeenCalledTimes(1);
  });

  it("classifies rate limits as retryable and preserves Retry-After in ms", async () => {
    const { RateLimitError } = await import("@tiny-fish/sdk");
    const client = fakeClient();
    client.fetch.getContents = vi.fn(async () => {
      throw new RateLimitError("slow down", {
        response: new Response(null, { status: 429, headers: { "retry-after": "2" } }),
      });
    });
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const error = await capture(provider.fetch(fetchInput()));

    expect(error.code).toBe("TINYFISH_RATE_LIMIT");
    expect(error.options).toMatchObject({ provider: "tinyfish", retryable: true, retryAfterMs: 2000 });
    expect(client.fetch.getContents).toHaveBeenCalledTimes(1);
  });

  it("classifies 402 payment required as non-retryable", async () => {
    const { PaymentRequiredError } = await import("@tiny-fish/sdk");
    const client = fakeClient();
    client.search.query = vi.fn(async () => {
      throw new PaymentRequiredError("wallet empty", { response: new Response(null, { status: 402 }) });
    });
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const error = await capture(provider.search(searchInput()));

    expect(error.code).toBe("TINYFISH_PAYMENT_REQUIRED");
    expect(error.options.retryable).toBe(false);
  });

  it("classifies timeout errors as retryable", async () => {
    const { APITimeoutError, RequestTimeoutError } = await import("@tiny-fish/sdk");
    const client = fakeClient();
    client.search.query = vi.fn(async () => { throw new APITimeoutError("client timed out"); });
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const timeoutError = await capture(provider.search(searchInput()));
    expect(timeoutError.code).toBe("UPSTREAM_TIMEOUT_UNCERTAIN");
    expect(timeoutError.options.retryable).toBe(false);

    client.search.query = vi.fn(async () => {
      throw new RequestTimeoutError("request timed out", { response: new Response(null, { status: 408 }) });
    });
    const requestTimeoutError = await capture(provider.search(searchInput()));
    expect(requestTimeoutError.code).toBe("UPSTREAM_TIMEOUT_UNCERTAIN");
    expect(requestTimeoutError.options.retryable).toBe(false);
  });

  it("classifies API status and generic SDK errors without retrying", async () => {
    const { APIStatusError, SDKError } = await import("@tiny-fish/sdk");
    const client = fakeClient();
    client.search.query = vi.fn(async () => {
      throw new APIStatusError("server error", {
        response: new Response(null, { status: 503, headers: { "retry-after": "3" } }),
        statusCode: 503,
      });
    });
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const apiError = await capture(provider.search(searchInput()));
    expect(apiError.code).toBe("TINYFISH_API_ERROR");
    expect(apiError.options).toMatchObject({ retryable: true, retryAfterMs: 3000 });
    expect(client.search.query).toHaveBeenCalledTimes(1);

    client.search.query = vi.fn(async () => { throw new SDKError("bad params"); });
    const sdkError = await capture(provider.search(searchInput()));
    expect(sdkError.code).toBe("TINYFISH_API_ERROR");
    expect(sdkError.options.retryable).toBe(false);
  });

  it("redacts the API key from error messages", async () => {
    const { SDKError } = await import("@tiny-fish/sdk");
    const client = fakeClient();
    client.search.query = vi.fn(async () => { throw new SDKError("failed for test-api-key"); });
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });

    const error = await capture(provider.search(searchInput()));

    expect(error.code).toBe("TINYFISH_API_ERROR");
    expect(error.message).not.toContain("test-api-key");
    expect(error.message).toContain("[redacted]");
    expect(JSON.stringify({ message: error.message, details: error.options.details })).not.toContain("test-api-key");
  });
});

describe("TinyFishProvider provider-specific search seam", () => {
  it("accepts TinyFish-specific options from a top-level providerOptions object", async () => {
    const client = fakeClient();
    const provider = new TinyFishProvider(tinyfishConfig(), { client: client });
    const input = {
      ...searchInput(),
      providerOptions: { domainType: "research_paper", pubYearMin: 2019 },
    } as unknown as SearchInput;

    await provider.search(input);

    expect(client.search.query).toHaveBeenCalledWith({
      query: "cats",
      domain_type: "research_paper",
      pub_year_min: 2019,
    });
  });
});
