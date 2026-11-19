import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { AppConfig } from "../config.js";
import { FreeWebError, errorInfo } from "../errors.js";
import type { Attempt, FetchInput, FetchOutput, MapInput, MapOutput, SearchInput, SearchOutput } from "../types.js";
import { Semaphore, SlidingWindowLimiter } from "../util/limiter.js";
import type { FetchProvider, FirecrawlAdapter, SearchProvider } from "./interfaces.js";
import { assertPublicHttpUrl } from "../security/url.js";

export class ProviderRouter {
  private readonly firecrawlSemaphore: Semaphore;
  private readonly tinyfishSearchSemaphore: Semaphore;
  private readonly tinyfishFetchSemaphore: Semaphore;
  private readonly tinyfishSearchLimiter: SlidingWindowLimiter;
  private readonly tinyfishFetchLimiter: SlidingWindowLimiter;

  constructor(private readonly options: {
    config: AppConfig;
    artifacts: ArtifactStore;
    tinyfish?: SearchProvider & FetchProvider;
    firecrawl: FirecrawlAdapter;
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
      if (name === "firecrawl-search" && input.options && Object.values(input.options).some((value) => value !== undefined)) {
        lastError = new FreeWebError("FALLBACK_UNSUPPORTED", "Firecrawl Search cannot preserve TinyFish-specific filters", { provider: name });
        attempts.push({ provider: name, outcome: "skipped", durationMs: 0, code: "FALLBACK_UNSUPPORTED", message: "Provider-specific filters are incompatible" });
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
    if (input.provider !== "auto") {
      const provider = primary === "tinyfish" ? this.options.tinyfish : this.options.firecrawl;
      const reason = !provider ? "Requested provider is not configured" : this.fetchUnsupportedReason(primary, input);
      if (reason) attempts.push({ provider: primary, outcome: "skipped", durationMs: 0, code: provider ? "UNSUPPORTED_OPTION" : "PROVIDER_NOT_CONFIGURED", message: reason });
    }
    const candidates = (input.fallback ? names : names.slice(0, 1)).filter((name) => {
      const provider = name === "tinyfish" ? this.options.tinyfish : this.options.firecrawl;
      return provider && this.fetchUnsupportedReason(name, input) === undefined;
    });
    if (candidates.length === 0) {
      const reason = this.fetchUnsupportedReason(primary, input);
      if (reason) throw new FreeWebError("UNSUPPORTED_OPTION", reason, { provider: primary });
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
    const budgeted = await this.applyFetchBudgets(results);
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

  private async applyFetchBudgets(results: FetchOutput["results"]) {
    const artifactIds: string[] = [];
    let remainingTotal = this.options.config.artifacts.inlineFetchTotalChars;
    const budgetedResults: FetchOutput["results"] = [];
    for (const originalPage of results) {
      let page = originalPage;
      const screenshot = this.decodeScreenshot(page.formats.screenshot);
      if (screenshot) {
        const artifact = await this.options.artifacts.save({ data: screenshot.data, mimeType: screenshot.mimeType });
        artifactIds.push(artifact.id);
        const formats = { ...page.formats };
        delete formats.screenshot;
        page = { ...page, formats, screenshotArtifactId: artifact.id };
      }
      const originalLength = Object.values(page.formats).reduce<number>((sum, value) => sum + this.fetchValueChars(value), 0)
        + (page.links ? this.fetchValueChars(page.links) : 0);
      const budget = Math.min(this.options.config.artifacts.inlineFetchPageChars, remainingTotal);
      if (originalLength > budget) {
        const artifact = await this.options.artifacts.save({ data: JSON.stringify(page), mimeType: "application/json" });
        artifactIds.push(artifact.id);
        let remaining = budget;
        let truncated = false;
        const formats: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(page.formats)) {
          if (typeof value === "string") {
            formats[key] = value.slice(0, remaining);
            truncated ||= value.length > remaining;
            remaining = Math.max(0, remaining - value.length);
          } else {
            const serialized = JSON.stringify(value) ?? "";
            if (serialized.length <= remaining) {
              formats[key] = value;
            } else {
              formats[key] = serialized.slice(0, remaining);
              truncated = true;
            }
            remaining = Math.max(0, remaining - serialized.length);
          }
        }
        let links = page.links;
        if (links) {
          const serializedLinks = JSON.stringify(links);
          if (serializedLinks.length <= remaining) {
            remaining -= serializedLinks.length;
          } else {
            const kept: string[] = [];
            let linkChars = 2;
            for (const link of links) {
              linkChars += link.length + 3;
              if (linkChars > remaining) break;
              kept.push(link);
            }
            links = kept;
            truncated = true;
          }
        }
        budgetedResults.push({ ...page, formats, ...(links ? { links } : { links: undefined }), truncated: true });
      } else {
        budgetedResults.push(page);
      }
      remainingTotal = Math.max(0, remainingTotal - Math.min(originalLength, budget));
    }
    return { results: budgetedResults, artifactIds: artifactIds.length ? artifactIds : undefined };
  }

  private fetchValueChars(value: unknown): number {
    return typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0);
  }

  private decodeScreenshot(value: unknown): { data: Buffer; mimeType: string } | undefined {
    if (typeof value !== "string") return undefined;
    const dataUrl = value.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s);
    const base64 = dataUrl?.[2] ?? value;
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64) || base64.length < 16) return undefined;
    const data = Buffer.from(base64, "base64");
    const mimeType = dataUrl?.[1]
      ?? (data[0] === 0x89 && data[1] === 0x50 ? "image/png"
        : data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg"
          : data.subarray(0, 4).toString() === "GIF8" ? "image/gif"
            : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP" ? "image/webp"
              : undefined);
    return mimeType ? { data, mimeType } : undefined;
  }

  private fetchUnsupportedReason(name: "firecrawl-local" | "tinyfish", input: FetchInput): string | undefined {
    const tinyfishOnly = new Set(["json"]);
    const firecrawlOnly = new Set(["rawHtml", "screenshot"]);
    if (name === "firecrawl-local" && input.formats.some((format) => tinyfishOnly.has(format))) return "Firecrawl Local does not support JSON extraction";
    if (name === "tinyfish" && input.formats.some((format) => firecrawlOnly.has(format))) return "TinyFish does not support rawHtml or screenshot";
    if (name === "tinyfish" && input.timeoutMs > 110_000) return "TinyFish does not support timeoutMs above 110000";
    if (name === "tinyfish" && input.formats.filter((format) => ["markdown", "html", "json"].includes(format)).length > 1) {
      return "TinyFish supports only one content format per Fetch request";
    }
    if (name === "tinyfish" && input.waitForMs > 0) return "TinyFish cannot preserve waitForMs";
    if (name === "tinyfish" && (input.includeSelectors?.length || input.excludeSelectors?.length)) return "TinyFish SDK does not support CSS selector scoping";
    if (name === "tinyfish" && !input.onlyMainContent) return "TinyFish cannot preserve onlyMainContent=false";
    return undefined;
  }

  async map(input: MapInput): Promise<MapOutput> {
    const started = Date.now();
    try {
      const { links } = await this.firecrawlSemaphore.run(() => this.options.firecrawl.map(input));
      const attempts: Attempt[] = [{ provider: "firecrawl-local", outcome: "success", durationMs: Date.now() - started }];
      const inline: Array<{ url: string }> = [];
      let size = 20;
      for (const link of links) {
        size += link.url.length + 20;
        if (size > this.options.config.artifacts.inlineFetchTotalChars) break;
        inline.push(link);
      }
      if (inline.length === links.length) {
        return { provider: "firecrawl-local", links, truncated: false, attempts, warnings: [], partial: false };
      }
      const artifact = await this.options.artifacts.save({ data: JSON.stringify({ links }), mimeType: "application/json" });
      return { provider: "firecrawl-local", links: inline, truncated: true, artifactId: artifact.id, attempts, warnings: ["Complete Map result is available as an Artifact"], partial: false };
    } catch (error) {
      const info = errorInfo(error, "firecrawl-local");
      throw new FreeWebError("ALL_PROVIDERS_FAILED", "Firecrawl Local Map failed", {
        cause: error,
        details: { attempts: [{ provider: "firecrawl-local", outcome: "error", durationMs: Date.now() - started, code: info.code, message: info.message }] },
      });
    }
  }
}
