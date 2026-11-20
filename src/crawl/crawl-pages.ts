import type { CrawlJobPage } from "./crawl-job-adapter.js";

/**
 * The comparison key for a crawled URL. Fragments never identify a different Page, while the
 * query string and a trailing slash stay meaningful. A URL the standard parser rejects is
 * still comparable after a literal fragment strip, so provider data is never made unique by
 * an accidental normalization failure.
 */
export function crawlPageAlias(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    const fragment = value.indexOf("#");
    return fragment === -1 ? value : value.slice(0, fragment);
  }
}

/**
 * Every identity a Page is known by. A redirect makes the final URL an alias of the crawled
 * URL, so a later snapshot that reports either side still refers to the same Page.
 */
export function crawlPageAliases(page: CrawlJobPage): string[] {
  const aliases: string[] = [];
  for (const candidate of [page.url, page.finalUrl]) {
    const alias = crawlPageAlias(candidate);
    if (alias !== undefined && !aliases.includes(alias)) aliases.push(alias);
  }
  // Pages without any usable URL cannot be compared; they keep the previous empty-key
  // behavior instead of becoming one unique entry per snapshot.
  return aliases.length > 0 ? aliases : [""];
}

/** Empty values never replace content a previous snapshot already provided. */
function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function clonePage(page: CrawlJobPage): CrawlJobPage {
  return { ...page, formats: { ...page.formats } };
}

/**
 * Applies newer Page data on top of an existing entry. Identity fields keep their first-seen
 * value once present, while scalar content and formats only take the newer value when it is
 * nonempty, so a later sparse snapshot cannot erase content an earlier one already collected.
 */
export function mergeCrawlPage(existing: CrawlJobPage, incoming: CrawlJobPage): CrawlJobPage {
  const merged = clonePage(existing);
  if (!isNonEmpty(merged.url) && isNonEmpty(incoming.url)) merged.url = incoming.url;
  if (!isNonEmpty(merged.finalUrl) && isNonEmpty(incoming.finalUrl)) merged.finalUrl = incoming.finalUrl;
  if (isNonEmpty(incoming.title)) merged.title = incoming.title;
  for (const [name, value] of Object.entries(incoming.formats)) {
    if (isNonEmpty(value) || !(name in merged.formats)) merged.formats[name] = value;
  }
  return merged;
}

/**
 * Collapses Pages by URL alias while keeping first-seen order. The newest nonempty data is
 * merged into the earliest entry, including when a redirect alias bridges two entries that
 * were previously collected as different Pages.
 */
export function mergeCrawlPages(
  existing: readonly CrawlJobPage[],
  incoming: readonly CrawlJobPage[],
): CrawlJobPage[] {
  const pages = existing.map(clonePage);
  for (const page of incoming) {
    const incomingAliases = crawlPageAliases(page);
    const matches: number[] = [];
    pages.forEach((candidate, index) => {
      const candidateAliases = crawlPageAliases(candidate);
      if (incomingAliases.some((alias) => candidateAliases.includes(alias))) matches.push(index);
    });
    if (matches.length === 0) {
      pages.push(clonePage(page));
      continue;
    }
    let merged = pages[matches[0]];
    for (const index of matches.slice(1)) merged = mergeCrawlPage(merged, pages[index]);
    merged = mergeCrawlPage(merged, page);
    // Remove bridged entries from the end so earlier indices stay valid.
    for (let position = matches.length - 1; position >= 1; position--) pages.splice(matches[position], 1);
    pages[matches[0]] = merged;
  }
  return pages;
}

/** Collapses duplicates within one collection, e.g. a checkpoint written before this rule. */
export function uniqueCrawlPages(pages: readonly CrawlJobPage[]): CrawlJobPage[] {
  return mergeCrawlPages([], pages);
}
