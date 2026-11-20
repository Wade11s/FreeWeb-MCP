import type { CrawlInput } from "../types.js";

/**
 * The provider view of one Crawl Job page. CrawlManager owns pagination, previews,
 * checkpoints and Artifacts; the adapter only reports what the provider collected.
 */
export interface CrawlJobPage {
  url: string;
  finalUrl?: string;
  title?: string;
  formats: Record<string, unknown>;
}

export interface CrawlJobError {
  code: string;
  message: string;
  url?: string;
}

/**
 * Provider-facing status only. `lost` is a local Crawl Job state produced by restart,
 * close or provider-not-found handling, so it never crosses this seam.
 */
export type CrawlJobProviderStatus = "scraping" | "completed" | "failed" | "cancelled";

/** A complete, already-aggregated provider snapshot. */
export interface CrawlJobSnapshot {
  status: CrawlJobProviderStatus;
  total: number;
  completed: number;
  pages: CrawlJobPage[];
  errors: CrawlJobError[];
}

/**
 * The only provider operations a Crawl Job needs. Fetch, Map and process lifecycle stay
 * behind other seams: CrawlManager never learns them, and FirecrawlLocalProvider does not
 * have to be split to satisfy this interface.
 */
export interface CrawlJobAdapter {
  startCrawl(input: CrawlInput): Promise<{ id: string }>;
  getCrawl(providerJobId: string): Promise<CrawlJobSnapshot>;
  cancelCrawl(providerJobId: string): Promise<void>;
}
