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

- Node.js 22.12+
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
freeweb-mcp print-config  Print an example MCP client configuration
freeweb-mcp help [command]  Print global or command help
freeweb-mcp -v | --version  Print the version
```

The MCP server starts only through the explicit `mcp` subcommand; there is no implicit no-argument startup. Unknown commands, unknown options, unknown help targets, and excess positional arguments fail with exit code 1 and a diagnostic on stderr. Help and version never load business configuration; `mcp` and `doctor` load and validate it.

## Build and check

```bash
npm install
npm run build
node dist/cli.js doctor
node dist/cli.js mcp   # same as npm start
```

`doctor` checks local binaries and configuration without starting business providers or making TinyFish wallet/API calls. Other Firecrawl versions are reported as uncertified; v0.1.0 is the integration-test baseline.

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

The MCP client must start the server with the explicit `mcp` subcommand. From a checkout:

```json
{
  "mcpServers": {
    "freeweb": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/FreeWeb-MCP/dist/cli.js", "mcp"]
    }
  }
}
```

When the package is installed, the client only needs the executable, which must be resolvable in the MCP client's `PATH`:

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

`node dist/cli.js print-config` prints the checkout example above (Node executable plus the explicit `mcp` subcommand). In MCP mode, stdout is reserved for JSON-RPC; startup and shutdown diagnostics go to stderr.

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
