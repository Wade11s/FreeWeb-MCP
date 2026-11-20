# Architecture

FreeWeb-MCP is a local, single-user Node.js 22.12+ TypeScript MCP server. The public seam is nine MCP tools plus read-only Artifact Resources; stdio is the only transport in the MVP.

## Command line

The package exposes one executable, `freeweb-mcp`. A Commander-based dispatcher owns command routing with strict argument handling: `mcp`, `doctor [--json]`, `print-config`, global and command help (`help [command]`, `--help`, `-h`), and the version flags `-v`/`--version`. Running the executable without arguments prints help and exits 0 without creating providers or loading business configuration; the MCP server starts only through the explicit `mcp` command. Unknown commands, unknown help targets, unknown options, and excess positional arguments are usage errors with exit code 1 and diagnostics on stderr. Help and version output stay on stdout.

The executable entry point is the only code that reads argv, writes to the process streams, or terminates the process; it hands those powers to the dispatcher as an injectable context, isolating Commander's output and exit hooks at the CLI boundary so tests and the MCP stdio stream stay deterministic. `doctor` and `mcp` load and validate business configuration inside their handlers; help, version, and `print-config` never touch it. `print-config` emits a static executable-native entry whose command is `freeweb-mcp` and whose only argument is `mcp`; deployment must ensure the MCP client process can resolve that executable through its `PATH`, including for GUI or service clients that do not inherit an interactive shell's environment. The `mcp` handler owns runtime creation, stdio serving, signal handling, and the orderly shutdown deadline; stdout stays reserved for JSON-RPC, and startup and shutdown diagnostics go to stderr.

## Modules

- **FreeWebRuntime** coordinates configuration, providers, URL checks and shutdown. Providers start lazily.
- **ProviderRouter** owns Search/Fetch/Map provider selection, one-alternate fallback, local rate/concurrency budgets, structured attempts and inline output budgets.
- **FirecrawlLocalProvider** owns the local v0.1.0 HTTP contract and its child serve process. The serve process uses loopback, an owned port and FIRECRAWL_CLOUD=off. Unexpected process death invalidates the cached runtime for lazy restart; startup can be aborted during close, and a closed provider cannot revive itself. Crawl marks three consecutive provider refresh failures as failed instead of polling forever.
- **TinyFishProvider** uses only the official SDK Search and Fetch resources with maxRetries: 0.
- **CrawlManager** owns asynchronous Crawl Jobs, checkpoints, pagination, cancellation and terminal Artifacts. An interrupted active Job is lost, never silently resumed.
- **ArtifactStore** writes private local content and exposes freeweb://artifacts/{id} MCP Resources.
- **EgoProvider** owns managed TaskSpace records, native method validation, page evaluation and unrestricted Node execution.
- **MCP server** validates tool input/output with Zod, returns isError for tool failures, and keeps stdout reserved for JSON-RPC.

## Provider routes

| Capability | Primary | Alternate |
| --- | --- | --- |
| Search | TinyFish Search | Explicitly enabled keyless Firecrawl Search |
| Fetch | Firecrawl Local scrape | TinyFish Fetch per failed URL, only when semantics are preserved |
| Crawl | Firecrawl Local | Bounded same-provider behavior; no cloud fallback |
| Map | Firecrawl Local | None |
| Browse | ego-lite | Recovery in the same managed Space; raw scripts are self-managed |

A valid empty result or target HTTP response is not a provider failure. A timeout whose cloud outcome is uncertain is not repeated automatically. Unknown or provider-ignored options are rejected before a request.

## Crawl Job state

Active Jobs are scraping and are checkpointed when provider state changes and when status is read. Writes are serialized per Job with unique temporary files, and close allows two seconds for in-flight reads before marking active work lost. Provider 404 is lost, cancellation tolerates an already missing Job, and compatible next responses are aggregated without dropping earlier pages. Terminal states are completed, failed and cancelled. Process interruption makes an active Job lost. Terminal and lost Jobs have a complete checkpoint Artifact by default retained for 24 hours. Pagination and per-page/total inline truncation never alter the stored full checkpoint. A bounded in-memory terminal set can be reloaded from disk on demand, and expired checkpoints are reclaimed from both memory and disk.

## Browse rounds

A managed browseId maps to one ego TaskSpace. Work and finish run in separate ego Node invocations. Normal rounds finish with the minimal required kept Pages; later rounds claim/take over and adopt them. close finishes with keep: []. Errors and handoff preserve the same Space for recovery and do not create a replacement.

browse_evaluate passes script text as data to page.evaluate. browse_node is registered only when explicitly enabled, receives an unmodified script, and never receives an automatic finish. Its filesystem, process, network, CDP and TaskSpace side effects belong to the caller, so mayHaveLateEffects is always true. Large managed results are written to controlled hand-off files before registration as Artifacts, avoiding truncation in runner output; large structured results use bounded inline budgets and summaries. Managed navigation uses WHATWG parsing with control/backslash/authority-smuggling rejection and HTTP(S)-only targets. Open writes a recoverable placeholder before creating a Space, close/reap finish registered Spaces concurrently with short timeouts, and closed providers reject new work rather than reviving processes.
