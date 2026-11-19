import type { CrawlInput, FetchInput, FetchOutput, FetchPage, MapInput, SearchInput, SearchOutput } from "../types.js";

export interface SearchProvider {
  readonly name: "tinyfish" | "firecrawl-search";
  search(input: SearchInput): Promise<{ results: SearchOutput["results"] }>;
}

export interface FetchProvider {
  readonly name: "tinyfish" | "firecrawl-local";
  fetch(input: FetchInput): Promise<{ results: FetchPage[]; errors: FetchOutput["errors"] }>;
}

export interface CrawlProviderPage {
  url: string;
  finalUrl?: string;
  title?: string;
  formats: Record<string, unknown>;
}
export interface CrawlProviderSnapshot {
  status: "scraping" | "completed" | "failed" | "cancelled";
  total: number;
  completed: number;
  pages: CrawlProviderPage[];
  errors: Array<{ code: string; message: string; url?: string }>;
}

export interface FirecrawlAdapter extends FetchProvider {
  map(input: MapInput): Promise<{ links: Array<{ url: string }> }>;
  startCrawl(input: CrawlInput): Promise<{ id: string }>;
  getCrawl(id: string): Promise<CrawlProviderSnapshot>;
  cancelCrawl(id: string): Promise<void>;
  close(): Promise<void>;
}
