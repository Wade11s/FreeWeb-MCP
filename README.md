# FreeWeb-MCP

Free-first, local Web MCP built with **Firecrawl Local**, **TinyFish Search/Fetch**, and **ego-lite**. It exposes Search, Fetch, Crawl, Map, managed Browse, arbitrary Page JavaScript, and explicitly opt-in native ego Node.js execution through one stdio MCP server.

## What “Free” means

- Firecrawl scrape/crawl/map runs locally with `FIRECRAWL_CLOUD=off`.
- TinyFish is used only for Search/Fetch and only with an API key for an account that **cannot spend from a wallet**. A free tier, zero current balance, or disabled auto-reload alone is not the same guarantee.
- TinyFish is disabled unless the key and explicit `freeOnlyConfirmed` attestation are both present.
- Keyless Firecrawl Search fallback is optional and separately enabled.
- TinyFish Agent/Browser/Research are not exposed. SDK retries are disabled so FreeWeb-MCP can control every request and fallback.

See [Security model](docs/security.md) before enabling user Profiles or unrestricted execution.

## Requirements

- Node.js 22.12+ (the exact floor is the `engines.node` value in `package.json`; `doctor` enforces that value rather than a second copy)
- `firecrawl-local` **v0.1.0** for Fetch/Crawl/Map (the certified baseline)
- Optional TinyFish API key for Search/Fetch
- Optional [ego lite](https://lite.ego.app/) on macOS or Windows for Browse
- Chrome/Chromium if Firecrawl needs JavaScript rendering or screenshots

Firecrawl installation follows the [official Local quickstart](https://docs.firecrawl.dev/quickstarts/firecrawl-local). Providers are installed separately and are not redistributed by this package.

## Command line

The package exposes one executable, `freeweb-mcp` (`dist/cli.js` in a checkout):

```text
freeweb-mcp               Print help; never starts the server
freeweb-mcp mcp           Start the stdio MCP server
freeweb-mcp doctor [--json]  Check local provider configuration
freeweb-mcp init          Interactively initialize providers and safe configuration
freeweb-mcp print-config  Print an example MCP client configuration
freeweb-mcp help [command]  Print global or command help
freeweb-mcp -v | --version  Print the version
```

The MCP server starts only through the explicit `mcp` subcommand; there is no implicit no-argument startup. Unknown commands, unknown options, unknown help targets, and excess positional arguments fail with exit code 1 and a diagnostic on stderr. Help and version never load business configuration; `mcp` and `doctor` load and validate it.

### doctor

```bash
freeweb-mcp doctor          # human-readable report on stdout
freeweb-mcp doctor --json   # the same report as JSON on stdout
```

Text mode writes one status line per check, an overall result, and the effective configuration:

```text
PASS node: v22.12.0
PASS firecrawl-local: firecrawl-local 0.1.0
PASS ego-browser: ego-browser 1.2.3
PASS tinyfish: Enabled by explicit free-only account attestation; no wallet request was made
PASS ego-platform: darwin
PASS data-directory: /Users/you/.freeweb-mcp
Result: ok
Configuration:
{
  "dataDir": "/Users/you/.freeweb-mcp",
  "tinyfish": { "freeOnlyConfirmed": true, "apiKey": "[redacted]", ... },
  ...
}
```

- The status word is `PASS` for a passing check, `FAIL` for a failed required check, and `WARN` for a failed optional check. A check may add an indented `  warning: ...` line; today only an uncertified Firecrawl Local version does.
- `Result:` is `ok` or `failed`.
- `Configuration:` is followed by the effective configuration (file plus environment overrides) as pretty-printed JSON, with the TinyFish key replaced by `[redacted]`.
- The checks are `node`, `firecrawl-local`, `ego-browser`, `tinyfish`, `ego-platform`, and `data-directory`, always in that order. `node` enforces the `engines.node` floor from `package.json` (currently Node.js 22.12.0). `tinyfish` reports configuration and account attestation only.

`--json` writes only the report to stdout, with no help text, diagnostics, or configuration prose in that stream:

```json
{
  "ok": false,
  "checks": [
    { "name": "node", "ok": true, "required": true, "version": "v22.12.0" },
    { "name": "firecrawl-local", "ok": false, "required": true, "message": "Command failed: firecrawl-local --version" },
    { "name": "tinyfish", "ok": false, "required": false, "message": "Disabled: TINYFISH_API_KEY is not set" }
  ]
}
```

A real report always contains one entry per check (the example above is trimmed); `version`, `message`, and `warning` appear only when they carry information. Exit status is 0 when every required check passes — optional `WARN` checks and `warning` lines do not fail it — and 1 when a required check fails.

If the business configuration cannot be read or is invalid, doctor exits 1. In text mode the diagnostic is on stderr and stdout stays empty; with `--json` the diagnostic is on stderr and stdout still holds a parseable report whose single check is a failed required `configuration` check. Doctor never starts business providers and never makes a TinyFish wallet or API request: provider binaries are only asked for `--version`.

Unknown options and extra positional arguments are usage errors: exit code 1, diagnostic on stderr, nothing on stdout.

## Build and check

```bash
npm install
npm run build
node dist/cli.js doctor
node dist/cli.js mcp   # same as npm start
```

`doctor` checks local binaries and configuration without starting business providers or making TinyFish wallet/API calls; see [doctor](#doctor) for the exact output contract. Other Firecrawl versions are reported as uncertified; v0.1.0 is the integration-test baseline.

## Initialization

`freeweb-mcp init` is an interactive, terminal-only command that sets up the local baseline. It runs only when explicitly invoked — never from MCP startup or `doctor` — and there is no `--yes`, unattended, or JSON mode.

1. **Plan and confirm.** It shows the planned provider and configuration actions and asks for confirmation before any side effect. Declining, or running without a terminal, stops before any write, installation, or provider launch and exits non-zero.
2. **Existing Firecrawl is preserved.** An installed `firecrawl-local` is detected and never upgraded, downgraded, or reinstalled. Verification starts a FreeWeb-MCP-owned serve process on a loopback address, an owned port, with `FIRECRAWL_CLOUD=off`, requests only the local `/health` endpoint, and shuts the process down with the bounded shutdown discipline. Versions other than the certified 0.1.0 are left untouched and reported as an `Uncertified` warning; a failed health check is reported separately as `Failed`. A missing installation is reported as `Pending` with official manual guidance — automated installation arrives in a later release (#23).
3. **Safe configuration.** New configuration uses conservative schema defaults — no private-network access, no Search Fallback, no Unrestricted Browse — and records the resolved absolute path of the detected Firecrawl binary so GUI clients do not depend on your terminal `PATH`. Existing valid configuration keeps every explicit value and receives only missing safe defaults; high-risk settings (private access, Search Fallback, unrestricted execution, the free-only attestation) are surfaced as warnings and never silently changed.
4. **Repairs ask first.** A stale configured binary path produces an explicit old → new repair proposal and is changed only after its own confirmation.
5. **Damaged configuration is never treated as absent.** Malformed or schema-invalid files require an explicit backup-and-rebuild confirmation before any installation or write; declining aborts with zero changes. The backup is non-overwriting (`config.backup.json`, then `config.backup.1.json`, …) and its path is reported without echoing damaged-file contents. Configuration writes are atomic — same-directory temporary file plus rename — with mode 0600 files and 0700 directories on POSIX; backups are also changed to 0600 where supported, so an interrupted run never leaves partially written JSON.
6. **Doctor and summary.** A completed run executes the local doctor checks (the MCP server is never started), prints a summary using the `Installed / Configured / Skipped / Pending / Failed` outcome categories, and points at `freeweb-mcp print-config` for MCP client registration. `init` never reads or writes other MCP clients' configurations.

Exit status: `0` only when Firecrawl and the base configuration are usable and no selected operation actually failed; `1` when a selected installation, write, or verification operation fails, or when Firecrawl or the base configuration remains `Pending` or `Failed`. Optional `Pending` or `Skipped` components never fail the run.

Initialization is idempotent: rerun it after an interruption, after a failed run, or after installing a provider manually. This release covers users who already have Firecrawl Local installed; automated Firecrawl installation (#23) and optional TinyFish (#24) and ego-lite (#25) setup arrive in later releases.

## Configuration

The default configuration path is:

- macOS/Linux: `~/.config/freeweb-mcp/config.json`, or `$XDG_CONFIG_HOME/freeweb-mcp/config.json`
- Windows: `%APPDATA%/FreeWeb-MCP/config.json`

Set `FREEWEB_CONFIG` to use another path. Start with [`config.example.json`](config.example.json):

```json
{
  "tinyfish": {
    "freeOnlyConfirmed": false
  },
  "firecrawl": {
    "binary": "firecrawl-local",
    "port": 0,
    "allowPrivate": false,
    "searchFallback": false
  },
  "ego": {
    "binary": "ego-browser",
    "unrestricted": false,
    "defaultProfile": "Default",
    "allowedProfiles": ["Default"],
    "allowPrivate": false
  }
}
```

Only set `freeOnlyConfirmed: true` after verifying the TinyFish account has no wallet spending capability. Provide the key through the environment, not the shared configuration file:

```bash
export TINYFISH_API_KEY="your-key"
```

Useful environment overrides:

| Variable | Meaning |
| --- | --- |
| `FREEWEB_CONFIG` | Configuration file path |
| `FREEWEB_DATA_DIR` | Private Artifact/checkpoint directory (default `~/.freeweb-mcp`) |
| `TINYFISH_API_KEY` | TinyFish key |
| `FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED` | `true` only after the no-wallet-spending check |
| `FIRECRAWL_LOCAL_BIN` | Firecrawl binary path |
| `FIRECRAWL_PORT` | Fixed port; `0` selects an owned free port |
| `FREEWEB_FIRECRAWL_SEARCH_FALLBACK` | Enable keyless Firecrawl Search fallback |
| `EGO_BROWSER_BIN` | ego-browser binary path |
| `FREEWEB_EGO_UNRESTRICTED` | Register the unrestricted `browse_node` tool |

Firecrawl and ego private-network access have separate opt-in settings. Do not enable them for untrusted MCP clients.

## MCP client

`freeweb-mcp print-config` emits the executable-native client configuration:

```json
{
  "mcpServers": {
    "freeweb": {
      "command": "freeweb-mcp",
      "args": ["mcp"]
    }
  }
}
```

The MCP client starts the server with the explicit `mcp` subcommand. `print-config` emits pure JSON on stdout; it never loads business configuration, so it also works when configuration is missing or invalid.

**Deployment prerequisite:** the MCP client process environment must be able to resolve `freeweb-mcp` through its `PATH`. Install or link the package where the client runs, or add a launcher directory to the client's `PATH`. GUI and service clients may not inherit an interactive shell's `PATH`, so verify resolution from the client's own environment. The generated output deliberately contains no Node.js or `dist/cli.js` path. A checkout can still be started directly with `node dist/cli.js mcp`, but that form is not emitted by `print-config`. In MCP mode, stdout is reserved for JSON-RPC; startup and shutdown diagnostics go to stderr.

Restart the MCP client after changing tool-registration settings such as `ego.unrestricted`.

## Tools

| Tool | Purpose |
| --- | --- |
| `search` | TinyFish Search, with one optional keyless Firecrawl Search fallback |
| `fetch` | Fetch 1–10 URLs; Firecrawl Local first, TinyFish only for compatible failed URLs |
| `map` | Synchronously discover URLs through Firecrawl Local |
| `crawl` | Start a bounded, robots-respecting asynchronous Crawl Job |
| `crawl_status` | Read status and paginated checkpoints; interrupted Jobs become `lost` |
| `crawl_cancel` | Cancel an active Job and preserve its checkpoint |
| `browse` | Managed TaskSpace lifecycle and validated native ego Page/Task methods |
| `browse_evaluate` | Arbitrary JavaScript inside one Page with one JSON argument |
| `browse_node` | Full native ego Node.js, CDP, filesystem, network and process execution; opt-in only |

All tools return structured content. Large Fetch/Map/Crawl/raw outputs use private local Artifacts and `freeweb://artifacts/{id}` MCP Resources instead of silently discarding data.

### Examples

Search:

```json
{
  "query": "local web MCP",
  "limit": 10
}
```

Fetch:

```json
{
  "urls": ["https://example.com"],
  "formats": ["markdown", "links"]
}
```

Start and read a Crawl Job:

```json
{
  "url": "https://example.com/docs",
  "limit": 20,
  "maxDiscoveryDepth": 3
}
```

```json
{
  "crawlId": "returned-uuid",
  "offset": 0,
  "limit": 10
}
```

Open a managed Browse Task and take a snapshot:

```json
{
  "action": "open",
  "url": "https://example.com"
}
```

```json
{
  "action": "call",
  "browseId": "returned-uuid",
  "method": "page.snapshot",
  "args": []
}
```

Evaluate Page JavaScript:

```json
{
  "browseId": "returned-uuid",
  "page": "p1",
  "script": "({ selector, limit }) => [...document.querySelectorAll(selector)].slice(0, limit).map(a => ({ text: a.textContent, href: a.href }))",
  "argument": { "selector": "article a", "limit": 20 }
}
```

Close the Task:

```json
{
  "action": "close",
  "browseId": "returned-uuid"
}
```

### Unrestricted Node warning

`browse_node` is **arbitrary local code execution**, not a browser-safe subset. It can read files, start processes, access private networks, invoke CDP and affect other browser Spaces. Scripts manage their own TaskSpaces. Timeouts do not roll back side effects. Never allow webpage text or prompt injection to authorize it.

## Tests

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:live
npm run check
```

Unit and in-memory MCP tests do not require provider credentials. Live tests are separated from mock tests and should use a dedicated ego test Profile/Space. TinyFish live tests are opt-in and must never be pointed at a wallet-enabled account.

See the [verification report](docs/testing.md) and [code review record](docs/review.md) for exact test counts, live environment limitations, and the final delegate-review result.

## License

MIT for FreeWeb-MCP. Firecrawl, TinyFish and ego-lite have their own licenses, accounts and terms. See [Provider boundaries ADR](docs/adr/0001-provider-boundaries-and-fallback.md) and [Unrestricted ego ADR](docs/adr/0002-unrestricted-ego-execution.md).
