import type { FreeWebError } from "../errors.js";
import type { FetchInput, FetchOutput, FetchPage, MapInput, SearchInput, SearchOutput } from "../types.js";

/**
 * A provider's synchronous verdict on whether it can honour one request.
 *
 * `code` and `message` are the Router-facing diagnostic used for a skipped attempt;
 * `error` is the full provider error the Router keeps as its cause. A refusal never
 * creates an Attempt: only the Router owns attempts and fallback.
 */
export type ProviderPreflight =
  | { supported: true }
  | { supported: false; code: string; message: string; error: FreeWebError };

/** No I/O, no configuration lookup: preflight runs on an already schema-parsed input. */
export const SUPPORTED: ProviderPreflight = { supported: true };

export function refused(code: string, message: string, error: FreeWebError): ProviderPreflight {
  return { supported: false, code, message, error };
}

export interface SearchProvider {
  readonly name: "tinyfish" | "firecrawl-search";
  inspectSearch(input: SearchInput): ProviderPreflight;
  search(input: SearchInput): Promise<{ results: SearchOutput["results"] }>;
}

export interface FetchProvider {
  readonly name: "tinyfish" | "firecrawl-local";
  inspectFetch(input: FetchInput): ProviderPreflight;
  fetch(input: FetchInput): Promise<{ results: FetchPage[]; errors: FetchOutput["errors"] }>;
}

/** The Fetch/Map surface ProviderRouter depends on. */
export interface FetchMapAdapter extends FetchProvider {
  map(input: MapInput): Promise<{ links: Array<{ url: string }> }>;
}
