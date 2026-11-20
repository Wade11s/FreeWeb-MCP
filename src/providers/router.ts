import { ArtifactOutput } from "../artifacts/output.js";
import type { AppConfig } from "../config.js";
import { FreeWebError, errorInfo } from "../errors.js";
import type { Attempt, FetchInput, FetchOutput, MapInput, MapOutput, SearchInput, SearchOutput } from "../types.js";
import { Semaphore, SlidingWindowLimiter } from "../util/limiter.js";
import type { FetchMapAdapter, FetchProvider, SearchProvider } from "./interfaces.js";
import { assertPublicHttpUrl } from "../security/url.js";

export class ProviderRouter {
  private readonly firecrawlSemaphore: Semaphore;
  private readonly tinyfishSearchSemaphore: Semaphore;
  private readonly tinyfishFetchSemaphore: Semaphore;
  private readonly tinyfishSearchLimiter: SlidingWindowLimiter;
  private readonly tinyfishFetchLimiter: SlidingWindowLimiter;

  constructor(private readonly options: {
    config: AppConfig;
    output: ArtifactOutput;
    tinyfish?: SearchProvider & FetchProvider;
    firecrawl: FetchMapAdapter;
    firecrawlSearch?: SearchProvider;
    cloudUrlValidator?: (url: string) => Promise<URL>;
  }) {
    this.firecrawlSemaphore = new Semaphore(options.config.limits.firecrawlConcurrency);
    this.tinyfishSearchSemaphore = new Semaphore(options.config.limits.tinyfishSearchConcurrency);
    this.tinyfishFetchSemaphore = new Semaphore(options.config.limits.tinyfishFetchConcurrency);
    this.tinyfishSearchLimiter = new SlidingWindowLimiter(options.config.limits.tinyfishSearchPerMinute);
    this.tinyfishFetchLimiter = new SlidingWindowLimiter(options.config.limits.tinyfishFetchUrlsPerMinute);
  }

  async search(input: SearchInput): Promise<SearchOutput> {
    const primary = input.provider === "auto" ? "tinyfish" : input.provider;
    const names = primary === "tinyfish"
      ? ["tinyfish", "firecrawl-search"] as const
      : ["firecrawl-search", "tinyfish"] as const;
    const candidates = input.fallback ? names : names.slice(0, 1);
    const attempts: Attempt[] = [];
    let lastError: unknown;

    for (const name of candidates) {
      const provider = name === "tinyfish" ? this.options.tinyfish : this.options.firecrawlSearch;
      if (!provider) {
        attempts.push({ provider: name, outcome: "skipped", durationMs: 0, code: "PROVIDER_NOT_CONFIGURED", message: "Provider is not configured" });
        continue;
      }
      const verdict = provider.inspectSearch(input);
      if (!verdict.supported) {
        lastError = verdict.error;
        attempts.push({ provider: name, outcome: "skipped", durationMs: 0, code: verdict.code, message: verdict.message });
        continue;
      }
      const started = Date.now();
      try {
        const { results } = name === "tinyfish"
          ? await this.tinyfishSearchSemaphore.run(async () => {
              this.tinyfishSearchLimiter.consume();
              return provider.search(input);
            })
          : await this.firecrawlSemaphore.run(() => provider.search(input));
        attempts.push({ provider: name, outcome: "success", durationMs: Date.now() - started });
        return {
          provider: name,
          requestedProvider: input.provider,
          query: input.query,
          results: results.slice(0, input.limit),
          attempts,
          warnings: attempts.length > 1
            ? [`Used fallback provider ${name} after ${attempts[0].provider} ${attempts[0].outcome === "skipped" ? "was skipped" : "failed"}`]
            : [],
          partial: false,
        };
      } catch (error) {
        lastError = error;
        const info = errorInfo(error, name);
        attempts.push({ provider: name, outcome: "error", durationMs: Date.now() - started, code: info.code, message: info.message });
        if (info.code === "UPSTREAM_TIMEOUT_UNCERTAIN") break;
      }
    }
    if (!lastError && attempts.every((attempt) => attempt.outcome === "skipped")) {
      throw new FreeWebError("SEARCH_NOT_CONFIGURED", "Search is not configured: set TINYFISH_API_KEY with freeOnlyConfirmed or enable firecrawl.searchFallback", {
        details: { attempts },
      });
    }
    throw new FreeWebError("ALL_PROVIDERS_FAILED", "All configured Search providers failed", {
      cause: lastError,
      details: {
        attempts,
        ...(lastError === undefined ? {} : { cause: lastError instanceof Error ? lastError.message : String(lastError) }),
      },
    });
  }

  async fetch(input: FetchInput): Promise<FetchOutput> {
    type Name = "firecrawl-local" | "tinyfish";
    const primary: Name = input.provider === "auto" ? "firecrawl-local" : input.provider;
    const names: Name[] = primary === "firecrawl-local"
      ? ["firecrawl-local", "tinyfish"]
      : ["tinyfish", "firecrawl-local"];
    const attempts: Attempt[] = [];
    const requestedNames = input.fallback ? names : names.slice(0, 1);
    const eligibility = new Map<Name, {
      provider?: FetchProvider;
      verdict?: ReturnType<FetchProvider["inspectFetch"]>;
    }>();
    for (const name of requestedNames) {
      const provider = name === "tinyfish" ? this.options.tinyfish : this.options.firecrawl;
      eligibility.set(name, {
        ...(provider ? { provider } : {}),
        ...(provider ? { verdict: provider.inspectFetch(input) } : {}),
      });
    }
    const primaryEligibility = eligibility.get(primary)!;
    if (input.provider !== "auto") {
      if (!primaryEligibility.provider) {
        attempts.push({ provider: primary, outcome: "skipped", durationMs: 0, code: "PROVIDER_NOT_CONFIGURED", message: "Requested provider is not configured" });
      } else if (primaryEligibility.verdict && !primaryEligibility.verdict.supported) {
        attempts.push({ provider: primary, outcome: "skipped", durationMs: 0, code: primaryEligibility.verdict.code, message: primaryEligibility.verdict.message });
      }
    }
    const candidates = requestedNames.filter((name) => {
      const state = eligibility.get(name)!;
      return state.provider !== undefined && state.verdict?.supported === true;
    });
    if (candidates.length === 0) {
      // A refusal needs an adapter verdict. A missing adapter is never preflighted, so an
      // unconfigured explicit primary reports ALL_PROVIDERS_FAILED even when its options
      // would have been refused: the Router no longer carries provider-specific rules.
      const refusal = primaryEligibility.verdict;
      if (refusal && !refusal.supported) throw new FreeWebError("UNSUPPORTED_OPTION", refusal.message, { provider: primary });
      throw new FreeWebError("ALL_PROVIDERS_FAILED", "No configured Fetch provider can preserve the requested options", {
        details: { attempts, urls: input.urls },
      });
    }

    const execute = async (name: Name, request: FetchInput) => {
      const provider = (name === "tinyfish" ? this.options.tinyfish : this.options.firecrawl)!;
      const started = Date.now();
      try {
        if (name === "tinyfish") {
          const validate = this.options.cloudUrlValidator ?? ((url: string) => assertPublicHttpUrl(url, { allowPrivate: false }));
          for (const url of request.urls) await validate(url);
        }
        if (name === "firecrawl-local" && request.urls.length > 1) {
          const settled = await Promise.allSettled(request.urls.map((url) =>
            this.firecrawlSemaphore.run(() => provider.fetch({ ...request, urls: [url] }))
          ));
          const response: Awaited<ReturnType<FetchProvider["fetch"]>> = { results: [], errors: [] };
          for (const [index, result] of settled.entries()) {
            if (result.status === "fulfilled") {
              response.results.push(...result.value.results);
              response.errors.push(...result.value.errors);
            } else {
              response.errors.push({ ...errorInfo(result.reason, name), url: request.urls[index] });
            }
          }
          attempts.push({
            provider: name,
            outcome: response.results.length > 0 || response.errors.length === 0 ? "success" : "error",
            durationMs: Date.now() - started,
            ...(response.results.length === 0 && response.errors.length > 0
              ? { code: response.errors[0].code, message: response.errors[0].message }
              : {}),
          });
          return response;
        }
        const response = name === "tinyfish"
          ? await this.tinyfishFetchSemaphore.run(async () => {
              this.tinyfishFetchLimiter.consume(request.urls.length);
              return provider.fetch(request);
            })
          : await this.firecrawlSemaphore.run(() => provider.fetch(request));
        attempts.push({
          provider: name,
          outcome: response.results.length > 0 || response.errors.length === 0 ? "success" : "error",
          durationMs: Date.now() - started,
          ...(response.results.length === 0 && response.errors.length > 0
            ? { code: response.errors[0].code, message: response.errors[0].message }
            : {}),
        });
        return response;
      } catch (error) {
        const info = errorInfo(error, name);
        attempts.push({ provider: name, outcome: "error", durationMs: Date.now() - started, code: info.code, message: info.message });
        throw error;
      }
    };

    const firstName = candidates[0];
    let firstResponse: Awaited<ReturnType<FetchProvider["fetch"]>>;
    try {
      firstResponse = await execute(firstName, input);
    } catch (error) {
      firstResponse = {
        results: [],
        errors: input.urls.map((url) => ({ ...errorInfo(error, firstName), url })),
      };
    }

    const results = firstResponse.results.map((page) => ({ ...page, provider: firstName }));
    const succeededUrls = new Set(results.map((page) => page.url));
    const errors: FetchOutput["errors"] = firstResponse.errors
      .filter((error) => !succeededUrls.has(error.url))
      .map((error) => ({ ...error, provider: error.provider ?? firstName }));
    const secondName = candidates[1];

    if (secondName && errors.length > 0) {
      const outcomes = await Promise.all(errors.map(async (failed) => {
        if (failed.code === "UPSTREAM_TIMEOUT_UNCERTAIN") return { pages: [], errors: [failed] };
        try {
          const fallbackResponse = await execute(secondName, { ...input, urls: [failed.url] });
          const successful = fallbackResponse.results.filter((page) => !succeededUrls.has(page.url));
          if (successful.length > 0) return { pages: successful, errors: [] };
          const fallbackErrors = fallbackResponse.errors.filter((error) => error.url === failed.url);
          return {
            pages: [],
            errors: fallbackErrors.length > 0
              ? fallbackErrors.map((error) => ({ ...error, provider: secondName }))
              : [{ ...failed, provider: secondName }],
          };
        } catch (error) {
          return { pages: [], errors: [{ ...errorInfo(error, secondName), url: failed.url }] };
        }
      }));
      const remainingErrors: FetchOutput["errors"] = [];
      for (const outcome of outcomes) {
        for (const page of outcome.pages) {
          if (succeededUrls.has(page.url)) continue;
          results.push({ ...page, provider: secondName });
          succeededUrls.add(page.url);
        }
        remainingErrors.push(...outcome.errors);
      }
      errors.splice(0, errors.length, ...remainingErrors);
    }

    if (results.length === 0) {
      throw new FreeWebError("ALL_PROVIDERS_FAILED", "All configured Fetch providers failed", {
        details: { attempts, errors },
      });
    }
    const actualProvider = results[results.length - 1].provider ?? firstName;
    const budgeted = await this.options.output.publish({
      kind: "fetch",
      results,
      inlinePageChars: this.options.config.artifacts.inlineFetchPageChars,
      inlineTotalChars: this.options.config.artifacts.inlineFetchTotalChars,
    });
    return {
      provider: actualProvider,
      requestedProvider: input.provider,
      results: budgeted.results,
      artifactIds: budgeted.artifactIds,
      errors,
      partial: errors.length > 0,
      attempts,
      warnings: [
        ...(attempts.some((attempt) => attempt.outcome === "skipped") ? [`Requested provider ${primary} was skipped before fallback`] : []),
        ...(new Set(results.map((page) => page.provider)).size > 1 || (attempts.length > 1 && results.some((page) => page.provider !== firstName))
          ? ["One or more URLs used a fallback provider"]
          : []),
      ],
    };
  }

  async map(input: MapInput): Promise<MapOutput> {
    const started = Date.now();
    try {
      const { links } = await this.firecrawlSemaphore.run(() => this.options.firecrawl.map(input));
      const attempts: Attempt[] = [{ provider: "firecrawl-local", outcome: "success", durationMs: Date.now() - started }];
      const published = await this.options.output.publish({
        kind: "map",
        links,
        inlineTotalChars: this.options.config.artifacts.inlineFetchTotalChars,
      });
      return {
        provider: "firecrawl-local",
        ...published,
        attempts,
        warnings: published.truncated ? ["Complete Map result is available as an Artifact"] : [],
        partial: false,
      };
    } catch (error) {
      const info = errorInfo(error, "firecrawl-local");
      throw new FreeWebError("ALL_PROVIDERS_FAILED", "Firecrawl Local Map failed", {
        cause: error,
        details: { attempts: [{ provider: "firecrawl-local", outcome: "error", durationMs: Date.now() - started, code: info.code, message: info.message }] },
      });
    }
  }
}
