import type { ContentBlock } from "@modelcontextprotocol/server";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type {
  BrowseEvaluateInput, BrowseInput, BrowseNodeInput, BrowseNodeOutput, BrowseOutput,
  CrawlInput, CrawlOutput, CrawlStatusInput, FetchInput, FetchOutput,
  MapInput, MapOutput, SearchInput, SearchOutput,
} from "../types.js";

export interface FreeWebToolHandlers {
  readonly artifacts: ArtifactStore;
  readonly unrestricted: boolean;
  search(input: SearchInput): Promise<SearchOutput>;
  fetch(input: FetchInput): Promise<FetchOutput>;
  map(input: MapInput): Promise<MapOutput>;
  crawl(input: CrawlInput): Promise<CrawlOutput>;
  crawlStatus(input: CrawlStatusInput): Promise<CrawlOutput>;
  crawlCancel(input: { crawlId: string }): Promise<CrawlOutput>;
  browse(input: BrowseInput): Promise<BrowseOutput>;
  browseEvaluate(input: BrowseEvaluateInput): Promise<BrowseOutput>;
  browseNode(input: BrowseNodeInput): Promise<BrowseNodeOutput>;
  browseScreenshot?(result: unknown): Promise<ContentBlock | undefined>;
}
