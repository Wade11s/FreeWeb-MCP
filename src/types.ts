import * as z from "zod/v4";

export const providerNameSchema = z.enum(["tinyfish", "firecrawl-local", "firecrawl-search", "ego-lite", "none"]);
export const attemptSchema = z.object({
  provider: providerNameSchema,
  outcome: z.enum(["success", "error", "skipped"]),
  durationMs: z.number().int().nonnegative(),
  code: z.string().optional(),
  message: z.string().optional(),
});
export const operationMetaSchema = z.object({
  provider: providerNameSchema,
  attempts: z.array(attemptSchema),
  warnings: z.array(z.string()),
  partial: z.boolean(),
});
export const providerChoiceSchema = z.enum(["auto", "tinyfish", "firecrawl-local"]);
export const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).default(10),
  provider: z.enum(["auto", "tinyfish", "firecrawl-search"]).default("auto"),
  fallback: z.boolean().default(true),
  options: z.object({
    location: z.string().max(100).optional(),
    language: z.string().max(30).optional(),
    includeDomains: z.array(z.string().max(253)).max(20).optional(),
    excludeDomains: z.array(z.string().max(253)).max(20).optional(),
    page: z.number().int().min(0).max(100).optional(),
  }).strict().optional(),
});
export const searchResultSchema = z.object({
  position: z.number().int().nonnegative(),
  title: z.string(),
  url: z.string().url(),
  snippet: z.string().optional(),
});
export const searchOutputSchema = operationMetaSchema.extend({
  requestedProvider: z.string().optional(),
  query: z.string(),
  results: z.array(searchResultSchema),
});

export const fetchFormatSchema = z.enum(["markdown", "html", "json", "rawHtml", "links", "screenshot"]);
export const fetchInputSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(10),
  formats: z.array(fetchFormatSchema).min(1).max(6).default(["markdown"]),
  onlyMainContent: z.boolean().default(true),
  includeSelectors: z.array(z.string().max(2000)).max(20).optional(),
  excludeSelectors: z.array(z.string().max(2000)).max(20).optional(),
  waitForMs: z.number().int().min(0).max(30_000).default(0),
  timeoutMs: z.number().int().min(1000).max(150_000).default(30_000),
  provider: providerChoiceSchema.default("auto"),
  fallback: z.boolean().default(true),
});
export const fetchPageSchema = z.object({
  url: z.string().url(),
  provider: providerNameSchema.optional(),
  finalUrl: z.string().url().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  formats: z.record(z.string(), z.unknown()),
  links: z.array(z.string()).optional(),
  screenshotArtifactId: z.string().optional(),
  truncated: z.boolean().optional(),
});
export const fetchErrorSchema = z.object({
  url: z.string().url(),
  code: z.string(),
  message: z.string(),
  provider: providerNameSchema.optional(),
  retryable: z.boolean().optional(),
});
export const fetchOutputSchema = operationMetaSchema.extend({
  requestedProvider: z.string().optional(),
  results: z.array(fetchPageSchema),
  errors: z.array(fetchErrorSchema),
  artifactIds: z.array(z.string()).optional(),
});

export const mapInputSchema = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(10_000).default(500),
  search: z.string().max(500).optional(),
  includeSubdomains: z.boolean().default(false),
  sitemap: z.enum(["include", "skip", "only"]).default("include"),
});
export const mapOutputSchema = operationMetaSchema.extend({
  links: z.array(z.object({ url: z.string().url() })),
  truncated: z.boolean(),
  artifactId: z.string().optional(),
});

export const crawlInputSchema = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(100).default(20),
  maxDiscoveryDepth: z.number().int().min(0).max(10).default(3),
  crawlEntireDomain: z.boolean().default(false),
  allowSubdomains: z.boolean().default(false),
  allowExternalLinks: z.boolean().default(false),
  includePaths: z.array(z.string().max(2000)).max(100).optional(),
  excludePaths: z.array(z.string().max(2000)).max(100).optional(),
  maxConcurrency: z.number().int().min(1).max(8).default(2),
  delayMs: z.number().int().min(0).max(30_000).optional(),
  sitemap: z.enum(["include", "skip", "only"]).default("include"),
  formats: z.array(z.enum(["markdown", "html", "rawHtml", "links"])).min(1).default(["markdown"]),
  onlyMainContent: z.boolean().default(true),
  waitForMs: z.number().int().min(0).max(30_000).default(0),
  timeoutMs: z.number().int().min(1000).max(150_000).default(30_000),
});
export const crawlStatusSchema = z.enum(["scraping", "completed", "failed", "cancelled", "lost"]);
export const crawlPageSchema = z.object({
  url: z.string(),
  finalUrl: z.string().optional(),
  title: z.string().optional(),
  formats: z.record(z.string(), z.unknown()),
  truncated: z.boolean().optional(),
});
export const crawlOutputSchema = z.object({
  crawlId: z.string().uuid(),
  providerJobId: z.string().optional(),
  status: crawlStatusSchema,
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  pages: z.array(crawlPageSchema),
  errors: z.array(z.object({ code: z.string(), message: z.string(), url: z.string().optional() })),
  partial: z.boolean(),
  artifactId: z.string().optional(),
  expiresAt: z.string().optional(),
});
export const crawlStatusInputSchema = z.object({
  crawlId: z.string().uuid(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(10),
  maxCharsPerPage: z.number().int().min(100).max(500_000).default(50_000),
});
export const crawlCancelInputSchema = z.object({ crawlId: z.string().uuid() });

export const browseInputSchema = z.object({
  action: z.enum(["open", "status", "call", "handoff", "resume", "close"]),
  browseId: z.string().uuid().optional(),
  name: z.string().max(100).optional(),
  profileId: z.string().max(100).optional(),
  url: z.string().url().optional(),
  page: z.string().max(30).default("p1"),
  method: z.string().max(100).optional(),
  args: z.array(z.unknown()).max(30).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const browseEvaluateInputSchema = z.object({
  browseId: z.string().uuid(),
  page: z.string().max(30).default("p1"),
  script: z.string().min(1).max(200_000),
  argument: z.unknown().optional(),
});
export const browseNodeInputSchema = z.object({
  script: z.string().min(1).max(500_000),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
});
export const browseOutputSchema = z.object({
  browseId: z.string().uuid().optional(),
  artifactId: z.string().uuid().optional(),
  spaceId: z.number().int().nonnegative().optional(),
  status: z.string(),
  result: z.unknown().optional(),
  pages: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});
export const browseNodeOutputSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().optional(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  mayHaveLateEffects: z.boolean(),
  artifactId: z.string().optional(),
});

export type OperationMeta = z.infer<typeof operationMetaSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchOutput = z.infer<typeof searchOutputSchema>;
export type FetchInput = z.infer<typeof fetchInputSchema>;
export type FetchPage = z.infer<typeof fetchPageSchema>;
export type FetchOutput = z.infer<typeof fetchOutputSchema>;
export type MapInput = z.infer<typeof mapInputSchema>;
export type MapOutput = z.infer<typeof mapOutputSchema>;
export type CrawlInput = z.infer<typeof crawlInputSchema>;
export type CrawlOutput = z.infer<typeof crawlOutputSchema>;
export type CrawlStatusInput = z.infer<typeof crawlStatusInputSchema>;
export type BrowseInput = z.infer<typeof browseInputSchema>;
export type BrowseEvaluateInput = z.infer<typeof browseEvaluateInputSchema>;
export type BrowseNodeInput = z.infer<typeof browseNodeInputSchema>;
export type BrowseOutput = z.infer<typeof browseOutputSchema>;
export type BrowseNodeOutput = z.infer<typeof browseNodeOutputSchema>;
