import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ContentBlock } from "@modelcontextprotocol/server";
import { ArtifactStore } from "./artifacts/artifact-store.js";
import type { AppConfig } from "./config.js";
import { CrawlManager } from "./crawl/crawl-manager.js";
import { FreeWebError } from "./errors.js";
import type { FreeWebToolHandlers } from "./mcp/runtime-interface.js";
import { EgoProvider } from "./providers/ego.js";
import { FirecrawlLocalProvider, FirecrawlSearchProvider } from "./providers/firecrawl.js";
import { ProviderRouter } from "./providers/router.js";
import { TinyFishProvider } from "./providers/tinyfish.js";
import { assertPublicHttpUrl } from "./security/url.js";
import type {
  BrowseEvaluateInput, BrowseInput, BrowseNodeInput, BrowseNodeOutput,
  CrawlInput, CrawlStatusInput, FetchInput, MapInput, SearchInput,
} from "./types.js";

type EgoRuntime = Pick<EgoProvider, "browse" | "evaluate" | "node" | "close" | "reapExpired">;

export class FreeWebRuntime implements FreeWebToolHandlers {
  readonly artifacts: ArtifactStore;
  readonly unrestricted: boolean;
  private readonly router: ProviderRouter;
  private readonly crawls: CrawlManager;
  private readonly ego: EgoRuntime;
  private readonly firecrawl: FirecrawlLocalProvider;
  private readonly maintenance: NodeJS.Timeout;

  constructor(readonly config: AppConfig, dependencies: { ego?: EgoRuntime } = {}) {
    this.artifacts = new ArtifactStore({ root: config.dataDir!, retentionMs: config.artifacts.retentionMs });
    this.firecrawl = new FirecrawlLocalProvider(config.firecrawl);
    const tinyfish = config.tinyfish.apiKey && config.tinyfish.freeOnlyConfirmed
      ? new TinyFishProvider(config.tinyfish)
      : undefined;
    const firecrawlSearch = config.firecrawl.searchFallback
      ? new FirecrawlSearchProvider(config.firecrawl)
      : undefined;
    this.router = new ProviderRouter({ config, artifacts: this.artifacts, tinyfish, firecrawl: this.firecrawl, firecrawlSearch });
    this.crawls = new CrawlManager({
      adapter: this.firecrawl,
      root: config.dataDir!,
      artifacts: this.artifacts,
      maxJobs: config.limits.maxCrawlJobs,
      inlineTotalChars: config.artifacts.inlineFetchTotalChars,
      inlinePageChars: config.artifacts.inlineFetchPageChars,
      retentionMs: config.artifacts.retentionMs,
    });
    this.ego = dependencies.ego ?? new EgoProvider(config, { artifacts: this.artifacts });
    this.unrestricted = config.ego.unrestricted;
    this.maintenance = setInterval(() => {
      void Promise.allSettled([this.crawls.cleanup(), this.artifacts.cleanup(), this.ego.reapExpired()]);
    }, 60_000);
    this.maintenance.unref();
  }

  async recover(): Promise<void> {
    await this.crawls.recover();
    await this.crawls.cleanup();
    await this.artifacts.cleanup();
  }

  async search(input: SearchInput) { return this.router.search(input); }

  async fetch(input: FetchInput) {
    for (const url of input.urls) await assertPublicHttpUrl(url, { allowPrivate: this.config.firecrawl.allowPrivate });
    return this.router.fetch(input);
  }

  async map(input: MapInput) {
    await assertPublicHttpUrl(input.url, { allowPrivate: this.config.firecrawl.allowPrivate });
    return this.router.map(input);
  }

  async crawl(input: CrawlInput) {
    await assertPublicHttpUrl(input.url, { allowPrivate: this.config.firecrawl.allowPrivate });
    return this.crawls.start(input);
  }

  async crawlStatus(input: CrawlStatusInput) { return this.crawls.status(input); }
  async crawlCancel(input: { crawlId: string }) { return this.crawls.cancel(input); }
  async browse(input: BrowseInput) { return this.boundedBrowseOutput(await this.ego.browse(input)); }
  async browseEvaluate(input: BrowseEvaluateInput) { return this.boundedBrowseOutput(await this.ego.evaluate(input)); }

  async browseNode(input: BrowseNodeInput): Promise<BrowseNodeOutput> {
    return this.ego.node(input);
  }

  private async boundedBrowseOutput(output: Awaited<ReturnType<EgoProvider["browse"]>>) {
    const serialized = JSON.stringify(output);
    if (serialized.length <= this.config.artifacts.inlineFetchTotalChars) return output;
    const artifact = await this.artifacts.save({ data: serialized, mimeType: "application/json" });
    return {
      ...output,
      result: {
        summary: "Large Browse result is available as an Artifact",
        artifactId: artifact.id,
        originalChars: serialized.length,
      },
      artifactId: artifact.id,
    };
  }

  async browseScreenshot(result: unknown): Promise<ContentBlock | undefined> {
    const candidate = typeof result === "string"
      ? result
      : typeof result === "object" && result !== null && "path" in result && typeof result.path === "string"
        ? result.path
        : undefined;
    if (!candidate?.endsWith(".png")) return undefined;
    const resolved = await realpath(candidate);
    const inside = (root: string, path: string) => {
      const rel = relative(root, path);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    const downloads = await realpath(join(this.config.dataDir, "downloads")).catch(() => undefined);
    const temporary = await realpath(tmpdir());
    const allowed = (downloads && inside(downloads, resolved))
      || (dirname(resolved) === temporary && basename(resolved).startsWith("ego-browser-shot-"));
    if (!allowed) {
      throw new FreeWebError("EGO_PATH_FORBIDDEN", "Screenshot path is outside managed downloads and ego temporary screenshots", { provider: "ego-lite" });
    }
    const info = await stat(resolved);
    if (info.size <= this.config.artifacts.screenshotMaxBytes) {
      const data = await readFile(resolved);
      return { type: "image", data: data.toString("base64"), mimeType: "image/png" };
    }
    const artifact = await this.artifacts.saveFile({ sourcePath: resolved, mimeType: "image/png" });
    return {
      type: "resource_link",
      uri: artifact.uri,
      name: "ego-lite screenshot",
      description: "Screenshot exceeded the inline image budget",
      mimeType: "image/png",
    };
  }

  async close(): Promise<void> {
    clearInterval(this.maintenance);
    const results = await Promise.allSettled([
      this.crawls.close(),
      this.ego.close(),
      this.firecrawl.close(),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "One or more providers failed to close");
  }
}

export async function createFreeWebRuntime(config: AppConfig): Promise<FreeWebRuntime> {
  const runtime = new FreeWebRuntime(config);
  try {
    await runtime.recover();
    return runtime;
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}
