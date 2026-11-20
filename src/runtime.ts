import type { CallToolResult } from "@modelcontextprotocol/server";
import { ArtifactStore } from "./artifacts/artifact-store.js";
import { ArtifactOutput } from "./artifacts/output.js";
import type { AppConfig } from "./config.js";
import { CrawlManager } from "./crawl/crawl-manager.js";
import { ManagedBrowseToolCall } from "./mcp/managed-browse-tool-call.js";
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
  private readonly output: ArtifactOutput;
  private readonly managedBrowse: ManagedBrowseToolCall;
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
    const output = new ArtifactOutput(this.artifacts);
    this.output = output;
    this.router = new ProviderRouter({ config, output, tinyfish, firecrawl: this.firecrawl, firecrawlSearch });
    this.crawls = new CrawlManager({
      adapter: this.firecrawl,
      root: config.dataDir!,
      output,
      maxJobs: config.limits.maxCrawlJobs,
      inlineTotalChars: config.artifacts.inlineFetchTotalChars,
      inlinePageChars: config.artifacts.inlineFetchPageChars,
      retentionMs: config.artifacts.retentionMs,
    });
    this.ego = dependencies.ego ?? new EgoProvider(config, { artifacts: this.artifacts, output });
    this.managedBrowse = new ManagedBrowseToolCall({
      browse: this.browse.bind(this),
      artifacts: this.artifacts,
      dataDir: config.dataDir,
      screenshotMaxBytes: config.artifacts.screenshotMaxBytes,
    });
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
    for (const url of input.urls) {
      await assertPublicHttpUrl(url, {
        allowPrivate: this.config.firecrawl.allowPrivate,
        trustedDnsServers: this.config.network.trustedDnsServers,
      });
    }
    return this.router.fetch(input);
  }

  async map(input: MapInput) {
    await assertPublicHttpUrl(input.url, {
      allowPrivate: this.config.firecrawl.allowPrivate,
      trustedDnsServers: this.config.network.trustedDnsServers,
    });
    return this.router.map(input);
  }

  async crawl(input: CrawlInput) {
    await assertPublicHttpUrl(input.url, { allowPrivate: this.config.firecrawl.allowPrivate });
    return this.crawls.start(input);
  }

  async crawlStatus(input: CrawlStatusInput) { return this.crawls.status(input); }
  async crawlCancel(input: { crawlId: string }) { return this.crawls.cancel(input); }
  async browse(input: BrowseInput) { return this.boundedBrowseOutput(await this.ego.browse(input)); }
  async managedBrowseToolCall(input: BrowseInput): Promise<CallToolResult> { return this.managedBrowse.run(input); }
  async browseEvaluate(input: BrowseEvaluateInput) { return this.boundedBrowseOutput(await this.ego.evaluate(input)); }

  async browseNode(input: BrowseNodeInput): Promise<BrowseNodeOutput> {
    return this.ego.node(input);
  }

  private async boundedBrowseOutput(output: Awaited<ReturnType<EgoProvider["browse"]>>) {
    const published = await this.output.publish({
      kind: "managed-output",
      output,
      inlineTotalChars: this.config.artifacts.inlineFetchTotalChars,
    });
    return published.output;
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
