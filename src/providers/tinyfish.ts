import {
  APITimeoutError,
  APIConnectionError,
  APIError,
  APIStatusError,
  AuthenticationError,
  PaymentRequiredError,
  RateLimitError,
  RequestTimeoutError,
  SDKError,
  TinyFish,
  type FetchGetContentsParams,
  type FetchResponse,
  type FetchResult,
  type SearchQueryParams,
  type SearchQueryResponse,
  type SearchResult,
} from "@tiny-fish/sdk";
import type { AppConfig } from "../config.js";
import { FreeWebError } from "../errors.js";
import type { FetchInput, FetchPage, FetchOutput, SearchInput, SearchOutput } from "../types.js";
import { refused, SUPPORTED, type FetchProvider, type ProviderPreflight, type SearchProvider } from "./interfaces.js";

/** Minimal structural surface of the official SDK client used by this provider. */
export interface TinyFishClientHandle {
  search: { query(params: SearchQueryParams): Promise<SearchQueryResponse> };
  fetch: { getContents(params: FetchGetContentsParams): Promise<FetchResponse> };
}

/** Options passed to an injected client factory, derived from AppConfig. */
export interface TinyFishClientOptions {
  apiKey: string;
  timeout: number;
  maxRetries: 0;
}

/** Public construction seam for injecting fake clients or a fake client factory. */
export interface TinyFishProviderOptions {
  /** One client used for both Search and Fetch. */
  client?: TinyFishClientHandle;
  /** Overrides `client` for Search only. */
  searchClient?: TinyFishClientHandle;
  /** Overrides `client` for Fetch only. */
  fetchClient?: TinyFishClientHandle;
  /** Called lazily with SDK client options; return a real or fake client. */
  clientFactory?: (options: TinyFishClientOptions) => TinyFishClientHandle;
  /** Alias for `clientFactory`. */
  createClient?: (options: TinyFishClientOptions) => TinyFishClientHandle;
}

export type TinyFishProviderDeps = TinyFishProviderOptions;

type ClientKind = "search" | "fetch";

const SEARCH_DOMAIN_TYPES = ["web", "news", "research_paper"] as const;
const CONTENT_FORMATS = ["markdown", "html", "json"] as const;
type ContentFormat = (typeof CONTENT_FORMATS)[number];
const UNSUPPORTED_FETCH_FORMATS = ["rawHtml", "screenshot"] as const;
type UnsupportedFetchFormat = (typeof UNSUPPORTED_FETCH_FORMATS)[number];
const SDK_MAX_PER_URL_TIMEOUT_MS = 110_000;

function isContentFormat(value: string): value is ContentFormat {
  return (CONTENT_FORMATS as readonly string[]).includes(value);
}

function isUnsupportedFetchFormat(value: string): value is UnsupportedFetchFormat {
  return (UNSUPPORTED_FETCH_FORMATS as readonly string[]).includes(value);
}

function unsupportedFetchFormats(input: FetchInput): UnsupportedFetchFormat[] {
  return (input.formats ?? []).filter(isUnsupportedFetchFormat);
}

function selectedContentFormats(input: FetchInput): ContentFormat[] {
  return (input.formats ?? ["markdown"]).filter(isContentFormat);
}

interface SearchOptionExtras {
  purpose?: string;
  recencyMinutes?: number;
  recency_minutes?: number;
  afterDate?: string;
  after_date?: string;
  beforeDate?: string;
  before_date?: string;
  domainType?: (typeof SEARCH_DOMAIN_TYPES)[number];
  domain_type?: (typeof SEARCH_DOMAIN_TYPES)[number];
  pubYearMin?: number;
  pub_year_min?: number;
  pubYearMax?: number;
  pub_year_max?: number;
  include_domains?: string | string[];
  exclude_domains?: string | string[];
  tinyfish?: SearchOptionExtras;
}

/** SearchInput plus the TinyFish Search parameters that the public schema does not expose. */
export type TinyFishSearchInput = Omit<SearchInput, "options"> & {
  options?: NonNullable<SearchInput["options"]> & SearchOptionExtras;
  providerOptions?: SearchOptionExtras;
  provider_options?: SearchOptionExtras;
};

function redactApiKey(message: string, apiKey?: string): string {
  if (!apiKey || apiKey.trim() === "") return message;
  return message.split(apiKey).join("[redacted]");
}

function errorStatus(error: unknown): number | undefined {
  if (error instanceof APIStatusError) return error.statusCode;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status = candidate.status ?? candidate.statusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  let headers: Headers | undefined;
  if (error instanceof APIError) headers = error.response?.headers;
  if (!headers && typeof error === "object" && error !== null) {
    const candidate = error as { response?: { headers?: unknown }; retryAfterMs?: unknown };
    const candidateHeaders = candidate.response?.headers;
    if (candidateHeaders && typeof (candidateHeaders as Headers).get === "function") {
      headers = candidateHeaders as Headers;
    }
    if (typeof candidate.retryAfterMs === "number") return Math.max(0, candidate.retryAfterMs);
  }
  const raw = headers?.get("retry-after");
  if (typeof raw !== "string") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function classifySdkError(error: unknown, apiKey?: string): FreeWebError {
  if (error instanceof FreeWebError) return error;

  const message = redactApiKey(error instanceof Error ? error.message : String(error), apiKey);
  const status = errorStatus(error);
  const retryAfter = retryAfterMs(error);
  const name = error instanceof Error ? error.name : "";
  const make = (code: string, retryable: boolean): FreeWebError => new FreeWebError(code, message, {
    provider: "tinyfish",
    retryable,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
  });

  if (error instanceof AuthenticationError || status === 401 || name === "AuthenticationError") {
    return make("TINYFISH_AUTH", false);
  }
  if (error instanceof RateLimitError || status === 429 || name === "RateLimitError") {
    return make("TINYFISH_RATE_LIMIT", true);
  }
  if (error instanceof PaymentRequiredError || status === 402 || name === "PaymentRequiredError") {
    return make("TINYFISH_PAYMENT_REQUIRED", false);
  }
  if (
    error instanceof APITimeoutError || error instanceof RequestTimeoutError || status === 408 ||
    name === "APITimeoutError" || name === "RequestTimeoutError"
  ) {
    return make("UPSTREAM_TIMEOUT_UNCERTAIN", false);
  }
  if (error instanceof APIConnectionError || name === "APIConnectionError") {
    return make("TINYFISH_API_ERROR", true);
  }
  if (error instanceof APIError || error instanceof SDKError || status !== undefined || name.endsWith("Error")) {
    const retryable = status !== undefined ? (status === 408 || status === 429 || status >= 500) : false;
    return make("TINYFISH_API_ERROR", retryable);
  }
  return make("TINYFISH_API_ERROR", false);
}

function classifyFetchError(raw: string, apiKey?: string): { code: string; message: string; retryable: boolean } {
  const message = redactApiKey(raw, apiKey);
  if (/timeout|timed out|\b408\b/i.test(raw)) {
    return { code: "UPSTREAM_TIMEOUT_UNCERTAIN", message, retryable: false };
  }
  if (/rate limit|\b429\b/i.test(raw)) {
    return { code: "TINYFISH_RATE_LIMIT", message, retryable: true };
  }
  if (/payment required|\b402\b/i.test(raw)) {
    return { code: "TINYFISH_PAYMENT_REQUIRED", message, retryable: false };
  }
  if (/unauthor|authentication|invalid api key|\b401\b/i.test(raw)) {
    return { code: "TINYFISH_AUTH", message, retryable: false };
  }
  return { code: "TINYFISH_FETCH_ERROR", message, retryable: false };
}

function unsupportedOption(option: string): FreeWebError {
  return new FreeWebError("UNSUPPORTED_OPTION", `TinyFish does not support ${option}`, {
    provider: "tinyfish",
    retryable: false,
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * One definition per capability rule. The Router-facing preflight and the direct
 * `fetchPlan()` read the same predicates but keep their own historical order and
 * messages, so neither path can drift from the other.
 */
const FETCH_PREDICATES = {
  rawHtmlOrScreenshot: (input: FetchInput): boolean => unsupportedFetchFormats(input).length > 0,
  timeoutTooLong: (input: FetchInput): boolean =>
    (input.timeoutMs ?? 30_000) > SDK_MAX_PER_URL_TIMEOUT_MS,
  multipleContentFormats: (input: FetchInput): boolean => selectedContentFormats(input).length > 1,
  waitForMs: (input: FetchInput): boolean => (input.waitForMs ?? 0) > 0,
  selectors: (input: FetchInput): boolean =>
    Boolean(input.includeSelectors?.length || input.excludeSelectors?.length),
  onlyMainContentOff: (input: FetchInput): boolean => input.onlyMainContent === false,
  formatsWithoutEquivalent: (input: FetchInput): boolean =>
    selectedContentFormats(input).length === 0 && !(input.formats ?? []).includes("links"),
};

const FETCH_PREFLIGHT_RULES: ReadonlyArray<{
  predicate: (input: FetchInput) => boolean;
  message: string;
}> = [
  {
    predicate: FETCH_PREDICATES.rawHtmlOrScreenshot,
    message: "TinyFish does not support rawHtml or screenshot",
  },
  {
    predicate: FETCH_PREDICATES.timeoutTooLong,
    message: "TinyFish does not support timeoutMs above 110000",
  },
  {
    predicate: FETCH_PREDICATES.multipleContentFormats,
    message: "TinyFish supports only one content format per Fetch request",
  },
  { predicate: FETCH_PREDICATES.waitForMs, message: "TinyFish cannot preserve waitForMs" },
  {
    predicate: FETCH_PREDICATES.selectors,
    message: "TinyFish SDK does not support CSS selector scoping",
  },
  {
    predicate: FETCH_PREDICATES.onlyMainContentOff,
    message: "TinyFish cannot preserve onlyMainContent=false",
  },
];

function preflightRefusal(message: string): ProviderPreflight {
  return refused("UNSUPPORTED_OPTION", message, new FreeWebError("UNSUPPORTED_OPTION", message, {
    provider: "tinyfish",
    retryable: false,
  }));
}

export class TinyFishProvider implements SearchProvider, FetchProvider {
  readonly name = "tinyfish" as const;

  private readonly handles: Partial<Record<ClientKind, TinyFishClientHandle>> = {};

  constructor(
    private readonly config: AppConfig["tinyfish"],
    private readonly options: TinyFishProviderOptions = {},
  ) {}

  inspectSearch(_input: SearchInput): ProviderPreflight {
    return SUPPORTED;
  }

  inspectFetch(input: FetchInput): ProviderPreflight {
    for (const rule of FETCH_PREFLIGHT_RULES) {
      if (rule.predicate(input)) return preflightRefusal(rule.message);
    }
    return SUPPORTED;
  }

  private requireConfigured(): string {
    const apiKey = this.config?.apiKey;

    if (typeof apiKey !== "string" || apiKey.trim() === "" || this.config?.freeOnlyConfirmed !== true) {
      throw new FreeWebError("TINYFISH_NOT_CONFIGURED", "TinyFish requires an apiKey and freeOnlyConfirmed", {
        provider: "tinyfish",
        retryable: false,
      });
    }
    return apiKey;
  }

  private getClient(kind: ClientKind): TinyFishClientHandle {
    const override = kind === "search"
      ? this.options.searchClient ?? this.options.client
      : this.options.fetchClient ?? this.options.client;
    if (override) return override;

    const cached = this.handles[kind];
    if (cached) return cached;

    const apiKey = this.requireConfigured();
    const timeout = kind === "search" ? this.config.searchTimeoutMs : this.config.fetchTimeoutMs;
    const clientOptions: TinyFishClientOptions = { apiKey, timeout, maxRetries: 0 };
    const factory = this.options.clientFactory ?? this.options.createClient;
    const handle = factory ? factory(clientOptions) : new TinyFish(clientOptions);
    this.handles[kind] = handle;
    return handle;
  }

  private searchParams(input: TinyFishSearchInput): SearchQueryParams {
    const rawOptions = input.options ?? {};
    const options = {
      ...rawOptions,
      ...(rawOptions.tinyfish ?? {}),
      ...(input.providerOptions ?? {}),
      ...(input.provider_options ?? {}),
    } as NonNullable<TinyFishSearchInput["options"]>;
    const allowed = new Set([
      "location", "language", "includeDomains", "excludeDomains", "page",
      "purpose", "recencyMinutes", "recency_minutes", "afterDate", "after_date",
      "beforeDate", "before_date", "domainType", "domain_type",
      "pubYearMin", "pub_year_min", "pubYearMax", "pub_year_max",
      "include_domains", "exclude_domains", "tinyfish",
    ]);
    for (const key of Object.keys(options)) {
      if (!allowed.has(key)) throw unsupportedOption(`search option ${key}`);
    }

    const params: SearchQueryParams = { query: input.query };
    if (options.location !== undefined) params.location = options.location;
    if (options.language !== undefined) params.language = options.language;

    const include = options.includeDomains ?? options.include_domains;
    if (include !== undefined) {
      params.include_domains = Array.isArray(include) ? include.join(",") : include;
    }
    const exclude = options.excludeDomains ?? options.exclude_domains;
    if (exclude !== undefined) {
      params.exclude_domains = Array.isArray(exclude) ? exclude.join(",") : exclude;
    }

    const after = options.afterDate ?? options.after_date;
    if (after !== undefined) params.after_date = after;
    const before = options.beforeDate ?? options.before_date;
    if (before !== undefined) params.before_date = before;
    const recency = options.recencyMinutes ?? options.recency_minutes;
    if (recency !== undefined) params.recency_minutes = recency;

    const domainType = options.domainType ?? options.domain_type;
    if (domainType !== undefined) {
      if (!SEARCH_DOMAIN_TYPES.includes(domainType)) throw unsupportedOption(`search domainType ${domainType}`);
      params.domain_type = domainType;
    }

    const pubYearMin = options.pubYearMin ?? options.pub_year_min;
    if (pubYearMin !== undefined) params.pub_year_min = pubYearMin;
    const pubYearMax = options.pubYearMax ?? options.pub_year_max;
    if (pubYearMax !== undefined) params.pub_year_max = pubYearMax;
    if (options.page !== undefined) params.page = options.page;
    if (options.purpose !== undefined) params.purpose = options.purpose;

    return params;
  }

  private normalizeSearchResults(response: SearchQueryResponse, limit: number): SearchOutput["results"] {
    const results: SearchOutput["results"] = [];
    const seen = new Set<string>();
    for (const item of response.results ?? []) {
      const result = item as SearchResult;
      if (!result || typeof result !== "object") continue;
      if (typeof result.url !== "string" || !isHttpUrl(result.url) || seen.has(result.url)) continue;
      seen.add(result.url);
      results.push({
        position: results.length + 1,
        title: typeof result.title === "string" ? result.title : "",
        url: result.url,
        ...(typeof result.snippet === "string" && result.snippet ? { snippet: result.snippet } : {}),
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  async search(input: TinyFishSearchInput): Promise<{ results: SearchOutput["results"] }> {
    this.requireConfigured();
    const params = this.searchParams(input);
    const client = this.getClient("search");
    let response: SearchQueryResponse;
    try {
      response = await client.search.query(params);
    } catch (error) {
      throw classifySdkError(error, this.config?.apiKey);
    }
    return { results: this.normalizeSearchResults(response, input.limit ?? 10) };
  }

  private fetchPlan(input: FetchInput): { format?: ContentFormat; links: boolean } {
    if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 10) {
      throw new FreeWebError("INVALID_INPUT", "TinyFish fetch accepts 1 to 10 URLs", {
        provider: "tinyfish",
        retryable: false,
      });
    }
    if (FETCH_PREDICATES.onlyMainContentOff(input)) throw unsupportedOption("onlyMainContent:false");
    if (FETCH_PREDICATES.waitForMs(input)) throw unsupportedOption("waitForMs > 0");
    if (FETCH_PREDICATES.selectors(input)) {
      throw unsupportedOption(input.includeSelectors?.length ? "includeSelectors" : "excludeSelectors");
    }
    if (FETCH_PREDICATES.timeoutTooLong(input)) {
      throw unsupportedOption(`timeoutMs above ${SDK_MAX_PER_URL_TIMEOUT_MS}`);
    }

    const formats = input.formats ?? ["markdown"];
    const unsupported = unsupportedFetchFormats(input);
    if (unsupported.length > 0) throw unsupportedOption(`format ${unsupported.join(", ")}`);

    const contentFormats = selectedContentFormats(input);
    if (FETCH_PREDICATES.multipleContentFormats(input)) {
      throw unsupportedOption("multiple content formats in one fetch");
    }
    const links = formats.includes("links");
    if (FETCH_PREDICATES.formatsWithoutEquivalent(input)) {
      throw unsupportedOption("formats without a supported equivalent");
    }
    return { format: contentFormats[0], links };
  }

  private mapFetchResponse(
    response: FetchResponse,
    plan: { format?: ContentFormat; links: boolean },
    requestedUrls: string[],
  ): { results: FetchPage[]; errors: FetchOutput["errors"] } {
    const results: FetchPage[] = [];
    const errors: FetchOutput["errors"] = [];
    for (const item of response.results ?? []) {
      const result = item as FetchResult;
      if (!isHttpUrl(result.url)) {
        errors.push({
          url: requestedUrls[0],
          code: "INVALID_PROVIDER_URL",
          message: "TinyFish returned an invalid result URL",
          provider: "tinyfish" as const,
          retryable: false,
        });
        continue;
      }
      const formats: Record<string, unknown> = {};
      if (plan.format && result.format) formats[result.format] = result.text;
      results.push({
        url: result.url,
        ...(result.final_url && isHttpUrl(result.final_url) ? { finalUrl: result.final_url } : {}),
        ...(result.title ? { title: result.title } : {}),
        ...(result.description ? { description: result.description } : {}),
        ...(result.language ? { language: result.language } : {}),
        formats,
        ...(plan.links ? { links: Array.isArray(result.links) ? result.links : [] } : {}),
      });
    }
    errors.push(...(response.errors ?? []).map((item) => {
      const classified = classifyFetchError(item.error, this.config?.apiKey);
      return {
        url: isHttpUrl(item.url) ? item.url : requestedUrls[0],
        code: classified.code,
        message: classified.message,
        provider: "tinyfish" as const,
        retryable: classified.retryable,
      };
    }));
    return { results, errors };
  }

  async fetch(input: FetchInput): Promise<{ results: FetchPage[]; errors: FetchOutput["errors"] }> {
    this.requireConfigured();
    const plan = this.fetchPlan(input);
    const perUrlTimeout = input.timeoutMs ?? 30_000;
    const batchSize = Math.max(1, Math.floor(this.config.fetchTimeoutMs / perUrlTimeout));
    const results: FetchPage[] = [];
    const errors: FetchOutput["errors"] = [];

    for (let offset = 0; offset < input.urls.length; offset += batchSize) {
      const urls = input.urls.slice(offset, offset + batchSize);
      const params: FetchGetContentsParams = {
        urls,
        ...(plan.format ? { format: plan.format } : {}),
        ...(plan.links ? { links: true } : {}),
        per_url_timeout_ms: perUrlTimeout,
      };
      try {
        const client = this.getClient("fetch");
        const response = await client.fetch.getContents(params);
        const mapped = this.mapFetchResponse(response, plan, urls);
        results.push(...mapped.results);
        errors.push(...mapped.errors);
      } catch (error) {
        if (input.urls.length === 1) throw classifySdkError(error, this.config?.apiKey);
        const classified = classifySdkError(error, this.config?.apiKey);
        for (const url of urls) {
          errors.push({
            url,
            code: classified.code,
            message: classified.message,
            provider: "tinyfish",
            retryable: classified.options.retryable ?? false,
          });
        }
      }
    }

    const covered = new Set<string>();
    for (const page of results) {
      covered.add(page.url);
      if (page.finalUrl) covered.add(page.finalUrl);
    }
    for (const error of errors) covered.add(error.url);
    for (const url of input.urls) {
      if (!covered.has(url)) {
        errors.push({
          url,
          code: "TINYFISH_EMPTY_RESULT",
          message: "TinyFish returned neither a result nor an error for this URL",
          provider: "tinyfish",
          retryable: false,
        });
      }
    }
    return { results, errors };
  }
}
