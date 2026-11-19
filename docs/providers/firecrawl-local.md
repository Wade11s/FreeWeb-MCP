# Firecrawl Local provider contract

The certified baseline is firecrawl-local 0.1.0. The local binary was found at /Users/hwj/.cargo/bin/firecrawl-local on the development machine. Other versions are reported by doctor as not fully certified rather than silently treated as identical.

## Process

FreeWeb-MCP starts its own serve process with 127.0.0.1, an owned fixed or automatically selected port, FIRECRAWL_CLOUD=off and no --allow-private by default. It checks GET /health for status ok and engine firecrawl-local. It never reuses an unknown process on the configured port and only terminates its own child. Child environments use a whitelist rather than inheriting provider API keys, stdout/stderr are drained into bounded redacted buffers, and CLI commands have bounded output plus SIGTERM/SIGKILL/hard-deadline handling.

The v0.1.0 CLI exposes serve --host, --port, --token, --allowed-host, --allow-private, --browser and --user-agent. Search is a separate CLI path and defaults to five results, so the MCP adapter passes -l explicitly.

## Routes and differences

Local routes used are POST /v2/scrape, POST /v2/map, and POST/GET/DELETE /v2/crawl. Crawl Jobs are asynchronous and memory-resident in Firecrawl. FreeWeb-MCP therefore maintains its own checkpoints and terminal Artifacts.

The adapter uses Local semantics rather than assuming Cloud parity. If a crawl start times out after the provider may have accepted it, FreeWeb-MCP returns CRAWL_START_UNCERTAIN with an explicit warning instead of silently starting a duplicate crawl; Local has no lookup-by-creation-request, so the user should inspect or restart the owned serve process before retrying.

- Crawl delayMs maps to delay in milliseconds.
- includePaths/excludePaths are pathname regex strings and do not filter the starting URL in Local.
- robots.txt remains enabled; ignoreRobotsTxt is not exposed.
- Map search is a case-insensitive URL substring filter, not semantic ranking.
- Local scrape actions, JSON extraction, summary and cloud-only formats are not exposed.
- webhook, ignoreQueryParameters, location, auditMetadata and other ignored/cloud-only fields are rejected rather than forwarded.

Official references:

- https://docs.firecrawl.dev/quickstarts/firecrawl-local
- https://github.com/firecrawl/firecrawl/tree/main/apps/local
- https://docs.firecrawl.dev/api-reference/endpoint/crawl-post
- https://docs.firecrawl.dev/api-reference/endpoint/map

Runtime verification results are recorded in the repository's test reports; source/documentation investigation alone is not treated as a live v0.1.0 contract test.
