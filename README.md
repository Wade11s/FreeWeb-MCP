# FreeWeb-MCP

Free-first, local Web MCP built with **Firecrawl Local**, **TinyFish Search/Fetch**, and **ego-lite**. It exposes Search, Fetch, Crawl, Map, managed Browse, arbitrary Page JavaScript, and explicitly opt-in native ego Node.js execution through one stdio MCP server.

## What “Free” means

- Firecrawl scrape/crawl/map runs locally with `FIRECRAWL_CLOUD=off`.
- TinyFish is used only for Search/Fetch and only with an API key for an account that **cannot spend from a wallet**. A free tier, zero current balance, or disabled auto-reload alone is not the same guarantee.
- TinyFish is disabled unless the key and explicit `freeOnlyConfirmed` attestation are both present.
- Keyless Firecrawl Search is an optional Provider that must be separately enabled; whether a call may try it is controlled by the per-call `fallback` input.
- TinyFish Agent/Browser/Research are not exposed. SDK retries are disabled so FreeWeb-MCP can control every request and fallback.

See [Security model](docs/security.md) before enabling user Profiles or unrestricted execution.

## Requirements

- Node.js 22.12+ (the exact floor is the `engines.node` value in `package.json`; `doctor` enforces that value rather than a second copy)
- `firecrawl-local` **v0.1.0** for Fetch/Crawl/Map (the certified baseline)
- Optional TinyFish API key for Search/Fetch
- Optional [ego lite](https://lite.ego.app/) on macOS or Windows for Browse
- Chrome/Chromium if Firecrawl needs JavaScript rendering or screenshots

Automatic Firecrawl installation additionally needs Rust, Cargo, and a C compiler that are already installed. `init` never installs Rust, Cargo, compilers, Xcode command-line tools, package managers, or Chrome/Chromium; when they are missing it reports the official `rustup`, `xcode-select`, or `build-essential` guidance instead.

Firecrawl installation follows the [official Local quickstart](https://docs.firecrawl.dev/quickstarts/firecrawl-local). On macOS and Debian/Ubuntu, `init` can install the certified 0.1.0 release when those prerequisites exist. Windows and other platforms receive detection and manual guidance only. Providers are installed separately and are not redistributed by this package.

### Initialization support matrix

| Platform | Firecrawl Local | ego-lite | Initialization evidence |
| --- | --- | --- | --- |
| macOS | Detect/preserve or certified Cargo install after prerequisite checks | Optional official-download handoff and human onboarding | Simulated in the automated suite; the opt-in live run is recorded separately |
| Debian/Ubuntu | Detect/preserve or certified Cargo install after prerequisite checks | Unsupported: `Skipped` | **Simulated only; not live-tested** |
| Windows | Detection and manual guidance only | Optional official-download handoff and human onboarding | **Simulated only; not live-tested** |
| Other platforms/distributions | Detection and manual guidance only | Unsupported: `Skipped` | **Simulated only; not live-tested** |

TinyFish uses the bundled SDK on every platform and remains optional; no live account or billing verification is implied. See the [Initialization setup guide](docs/providers/setup.md) for prerequisites, human decisions, outcomes, exit status, and recovery.

## Install

FreeWeb-MCP ships as a CLI-only package published as `@wade11s/freeweb-mcp`. The only public entry point is the `freeweb-mcp` executable declared by `bin` in `package.json`: the package declares no `main`, `types`, or `exports` metadata and has no public barrel modules, so importing the package name fails by design. Every internal TypeScript module is private to the CLI.

```bash
npm install --global @wade11s/freeweb-mcp                              # published release
npm install --prefix /opt/freeweb-mcp ./wade11s-freeweb-mcp-0.1.0.tgz  # local tarball from `npm pack`

freeweb-mcp --version
freeweb-mcp doctor
freeweb-mcp print-config
```

Release verification for the packed artifact is described in [docs/testing.md](docs/testing.md#packaging).

## Command line

The package exposes one executable, `freeweb-mcp` (`dist/cli.js` in a checkout):

```text
freeweb-mcp               Print help; never starts the server
freeweb-mcp mcp           Start the stdio MCP server
freeweb-mcp doctor [--json] [--show-config]  Check local provider configuration
freeweb-mcp init [--json]  Initialize interactively, one step at a time
freeweb-mcp print-config  Print an example MCP client configuration
freeweb-mcp help [command]  Print global or command help
freeweb-mcp -v | --version  Print the version
```

The MCP server starts only through the explicit `mcp` subcommand; there is no implicit no-argument startup. Unknown commands, unknown options, unknown help targets, and excess positional arguments fail with exit code 1 and a diagnostic on stderr. Help and version never load business configuration; `mcp` and `doctor` load and validate it.

### doctor

```bash
freeweb-mcp doctor                      # grouped human-readable report
freeweb-mcp doctor --show-config        # also show redacted effective configuration
freeweb-mcp doctor --json               # versioned machine-readable report
freeweb-mcp doctor --json --show-config # add redacted config to the JSON document
```

Text mode starts with the overall state and summary, separates required checks from optional capabilities, and gives actionable next steps:

```text
FreeWeb-MCP Doctor
Status: ACTION REQUIRED
Summary: 5/7 checks passed; 1 required failed; 1 warning

Required checks
  PASS Node.js runtime: v22.12.0
  FAIL Firecrawl Local: Command failed: firecrawl-local --version
       Next: Run `freeweb-mcp init` and select Firecrawl Local setup, then rerun `freeweb-mcp doctor`.
  PASS Data directory: /Users/you/.freeweb-mcp

Optional capabilities
  PASS ego-lite command: ego-browser 1.2.3
  WARN TinyFish Search/Fetch: Disabled: TINYFISH_API_KEY is not set
  PASS Trusted DNS for fake-ip: Not configured (default): all-fake-ip system answers remain unverified
       Next: Optional for fake-ip DNS: set network.trustedDnsServers or FREEWEB_TRUSTED_DNS_SERVERS to public DNS IP literals. Configuration changes require MCP restart or session reload.
  PASS Managed Browse platform: darwin

Next steps
  1. Run `freeweb-mcp init` and select Firecrawl Local setup, then rerun `freeweb-mcp doctor`.

Configuration is hidden by default; use --show-config to display it with secrets redacted.
```

- `PASS` means the check passed, `FAIL` means a required check failed, and `WARN` means an optional check failed. Uncertified-version warnings are shown beneath their check.
- The checks remain `node`, `firecrawl-local`, `ego-browser`, `tinyfish`, `trusted-dns`, `ego-platform`, and `data-directory`, in that order in JSON. `node` enforces the `engines.node` floor from `package.json`; `tinyfish` reports configuration and account attestation only; `trusted-dns` reports configuration state without a DNS or business request and includes MCP restart/session-reload remediation.
- `--show-config` adds the effective file-plus-environment configuration with the TinyFish key replaced by `[redacted]`. Without it, neither text nor JSON includes the complete configuration.

`--json` writes one `schemaVersion: 1` document to stdout. Existing `ok` and `checks` fields are retained; each check also has `status` and optional `remediation`, and the report adds `summary` and `nextSteps`:

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "ok": false,
  "status": "action_required",
  "summary": { "total": 7, "passed": 5, "failed": 1, "warnings": 1 },
  "checks": [
    { "name": "node", "ok": true, "required": true, "version": "v22.12.0", "status": "PASS" },
    {
      "name": "firecrawl-local",
      "ok": false,
      "required": true,
      "message": "Command failed: firecrawl-local --version",
      "status": "FAIL",
      "remediation": "Run `freeweb-mcp init` and select Firecrawl Local setup, then rerun `freeweb-mcp doctor`."
    }
  ],
  "nextSteps": ["Run `freeweb-mcp init` and select Firecrawl Local setup, then rerun `freeweb-mcp doctor`."]
}
```

The example is trimmed; a normal report contains every check. Exit status is 0 when every required check passes — optional `WARN` checks and uncertified warnings do not fail it — and 1 when a required check fails.

If business configuration cannot be read or is invalid, doctor exits 1 with one failed required `configuration` check. Text mode renders that report on stdout; JSON mode keeps stdout parseable and writes its human diagnostic to stderr. Doctor never starts business providers and never makes a TinyFish wallet or API request: provider binaries are only asked for `--version`.

Unknown options and extra positional arguments are usage errors: exit code 1, diagnostic on stderr, nothing on stdout.

## Build and check

```bash
npm install
npm run build
node dist/cli.js doctor
node dist/cli.js print-config
node dist/cli.js mcp   # same as npm start
```

`doctor` checks local binaries and configuration without starting business providers or making TinyFish wallet/API calls; see [doctor](#doctor) for the exact output contract. Other Firecrawl versions are reported as uncertified; v0.1.0 is the integration-test baseline.

## Initialization

`freeweb-mcp init` is an interactive, terminal-only command that sets up the local baseline. It runs only when explicitly invoked — never from MCP startup or `doctor` — and there is no `--yes` or unattended mode. It presents one Initialization Step at a time: Inspect environment → Firecrawl Local → TinyFish → ego-lite → Configuration → Doctor verification. Firecrawl is required, while TinyFish and ego-lite may be skipped without failing an otherwise usable required baseline.

```text
Step 3/6 — TinyFish Search/Fetch (optional)
  Current state: installed
  Action: configure the SDK already included with FreeWeb-MCP

What do you want to do with TinyFish Search/Fetch?
  1) Configure or verify TinyFish Search/Fetch
  2) Skip TinyFish Search/Fetch for now [default]
  3) Quit initialization
Choose [1-3] (2):
```

1. **One step and one decision at a time.** Each step shows only its current state, action, warnings, and numbered choices. Empty input selects the safe default (skip an optional component or quit a required action), `q` quits where available, and invalid choices are explained and asked again. Legacy `y`/`n` answers select the first/safe-default choice; on a failure menu, `y` selects Continue rather than retrying the failed side effect. There is no combined plan-confirmation gate.
2. **Firecrawl is installed only when missing, and existing installations are preserved.** On macOS and Debian/Ubuntu, a missing `firecrawl-local` is installed from crates.io with the exact certified request `cargo install firecrawl-local --version 0.1.0`; the pin is `CERTIFIED_FIRECRAWL_VERSION` in `src/init/components/firecrawl.ts`. Before Cargo runs, `init` checks `rustc`, `cargo`, and `cc`; when one is absent it reports `Pending` with official rustup, Xcode command-line tools, or build-essential guidance and never installs those prerequisites. It never follows a source branch, runs `git clone`, selects another version, runs Firecrawl `login` or Firecrawl's own `init`, enables the keyless Firecrawl Search Provider or private access, or registers an MCP client. Windows and other unsupported platforms receive detection and manual guidance without claiming a verified automatic installation. Existing installations of any version are never upgraded, downgraded, or reinstalled. Verification starts a FreeWeb-MCP-owned serve process on a loopback address, an owned port, with `FIRECRAWL_CLOUD=off`, requests only the local `/health` endpoint, and shuts the process down with the bounded shutdown discipline for both new and existing binaries. Versions other than the certified 0.1.0 are left untouched and reported as an `Uncertified` warning; a failed health check is reported separately as `Failed`. Chrome/Chromium is reported as an optional enhancement for JavaScript rendering and screenshots and is never a required readiness condition.
3. **Safe configuration.** New configuration uses conservative schema defaults — no private-network access, no keyless Firecrawl Search Provider, no Unrestricted Browse — and records the resolved absolute path of the detected Firecrawl binary so GUI clients do not depend on your terminal `PATH`. Existing valid configuration keeps every explicit value and receives only missing safe defaults; high-risk settings (private access, the keyless Firecrawl Search Provider, unrestricted execution, the free-only attestation) are surfaced as warnings and never silently changed.
4. **Repairs ask first.** A stale configured binary path produces an explicit old → new repair proposal and is changed only after its own confirmation.
5. **Damaged configuration is never treated as absent.** Malformed or schema-invalid files require an explicit backup-and-rebuild confirmation before any installation or write; declining aborts with zero changes. The backup is non-overwriting (`config.backup.json`, then `config.backup.1.json`, …) and its path is reported without echoing damaged-file contents. Configuration writes are atomic — same-directory temporary file plus rename — with mode 0600 files and 0700 directories on POSIX; backups are also changed to 0600 where supported, so an interrupted run never leaves partially written JSON.
6. **Configuration, Doctor, and summary are separate steps.** Configuration is written only after its own selection, and Doctor runs only after another explicit selection. A failed step offers `Retry / Continue / Quit` without automatic retries. Quit stops all later steps and any pending configuration write; already completed installations, backups, writes, or browser launches are not rolled back and are listed in the partial summary. A completed run classifies results as `Installed / Configured / Skipped / Pending / Failed`, points at `freeweb-mcp print-config`, and never starts the MCP server or modifies another MCP client's configuration.

`freeweb-mcp init --json` keeps the same numbered interaction but writes prompts, progress, and diagnostics to stderr. Stdout contains exactly one final `schemaVersion: 1` report, so it can be redirected to a file while stdin and stderr remain attached to the terminal. The report includes `status: succeeded | failed | cancelled`, ordered `steps` with stable ids/statuses/attempt counts, a `doctor` object or `null`, `nextSteps`, and an optional structured `error`. Cancellation and non-TTY refusal also emit parseable reports; JSON does not permit unattended execution or bypass any consent.

Outcomes mean: `Installed` — local installation and Initialization verification passed; `Configured` — requested non-secret prerequisites are effective (for TinyFish, key presence plus attestation only); `Skipped` — optional setup was declined or is unsupported; `Pending` — a human prerequisite or required manual installation remains; `Failed` — a selected operation actually failed. `Uncertified` remains a warning, not an outcome.

Exit status: `0` only when Firecrawl and the base configuration are usable, the selected Doctor step passes, and no selected operation failed; `1` when a selected installation, write, or verification operation fails, Doctor cannot run, a required component remains `Pending` or `Failed`, or the user quits. Optional `Pending` or `Skipped` components never fail the run.

Initialization is idempotent: rerun it after an interruption, after a failed run, or after installing a provider manually. Existing Firecrawl installations are preserved; only a missing Firecrawl is installed, and a rerun verifies a valid 0.1.0 instead of reinstalling it. Recovery is: read the summary, complete the required human/prerequisite step without deleting state, rerun `freeweb-mcp init`, and then run `freeweb-mcp doctor`. Valid explicit settings are preserved, stale path repairs still require confirmation, backups are never overwritten, and an interrupted atomic write leaves the prior complete file in place. Use `freeweb-mcp print-config` separately for client registration.

### TinyFish Initialization

TinyFish is an optional component in the default plan and uses the SDK already included with FreeWeb-MCP. Initialization never installs or invokes the global TinyFish CLI. You can decline or skip TinyFish without blocking an otherwise ready Firecrawl and configuration baseline.

The API key remains a manual environment step. Set `TINYFISH_API_KEY` in the environment of the process that actually runs FreeWeb-MCP, then rerun `freeweb-mcp init`; GUI and service MCP clients may not inherit an interactive shell's environment. Initialization checks only whether the variable is non-empty. It never asks you to paste the key, prints its value, or writes it to FreeWeb-MCP configuration, shell profiles, system environment configuration, MCP client definitions, logs, summaries, or backups.

Before Initialization can persist `tinyfish.freeOnlyConfirmed: true`, it shows and requires confirmation of this exact attestation:

> This TinyFish API key belongs to an account with no wallet spending capability; free credits, a zero balance, disabled auto-reload, and installation success are not substitutes for this attestation.

Only the boolean attestation is contributed to configuration, after that explicit confirmation. A missing key or missing attestation leaves TinyFish `Pending`, not `Configured`; skipping the optional component reports `Skipped`. TinyFish Initialization does not enable the keyless Firecrawl Search Provider.

Initialization makes no TinyFish wallet, business Search/Fetch, SDK, or other paid-risk verification request. Consequently, `Configured` means only that the environment credential is present and the explicit attestation is effective. Successful Initialization and doctor's TinyFish check do not prove that the key works, that the account has quota, or that TinyFish Search/Fetch is ready.

### ego-lite handoff (optional)

The optional ego-lite component is available in `init`. On macOS and Windows it asks before opening the official download page <https://lite.ego.app/> after its step is selected (`open` on macOS, `explorer.exe` on Windows); answering no returns `Skipped` with no browser launch and lets the rest of Initialization continue. Answering yes then waits for a **separate explicit confirmation** that you installed the app and completed GUI onboarding. Official step-by-step guidance is at <https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/install.md>. The handoff does not execute the official remote shell installer, remove macOS quarantine attributes, request elevation, upgrade/downgrade/reinstall an existing app, or choose any Browser Profile, cookie, password, session, bookmark, or extension import option. Those choices remain entirely yours.

Only after that confirmation does Initialization check `ego-browser --version` and the native Node.js entry (`ego-browser nodejs -e ...`). A newly discovered absolute path is recorded only when no explicit value existed. An explicit `ego.binary` is preserved as written: if it resolves to a different absolute path (including when `EGO_BROWSER_BIN` overrides it), Initialization proposes a separate old → new approval instead of silently rewriting it. Incomplete onboarding is `Pending`; an opener or verification failure is `Failed`; unsupported platforms (including Linux) are `Skipped` with an explanation and no opener launch. Optional `Pending`/`Skipped` does not fail the required local baseline, while a selected `Failed` operation does.

Installing the application and passing these probes is **not** configured Browse readiness: Managed Browse still depends on your allowed Profile, GUI onboarding state, and browser-data decisions, and FreeWeb-MCP never imports browser data for you. Routine automated tests use fake openers, fake executables and temporary homes; all Initialization platform branches are simulated only until separately verified, including Windows through `FREEWEB_INIT_TEST_MODE=1` with `FREEWEB_INIT_PLATFORM=win32` (production ignores `FREEWEB_INIT_PLATFORM`). No routine test launches a real installer or GUI. Windows, Debian/Ubuntu, other Linux distributions, and other non-macOS platforms have not been live-tested.

The opt-in [macOS live-run procedure](docs/providers/macos-live-run.md) assigns every action and decision to the human or orchestrator. Its [evidence scaffold](docs/providers/macos-live-evidence.md) is currently **not run** and must be filled with actual observations only; it never requests credentials or browser data.

## Configuration

The default configuration path is:

- macOS/Linux: `~/.config/freeweb-mcp/config.json`, or `$XDG_CONFIG_HOME/freeweb-mcp/config.json`
- Windows: `%APPDATA%/FreeWeb-MCP/config.json`

Set `FREEWEB_CONFIG` to use another path. Start with [`config.example.json`](config.example.json):

```json
{
  "network": {
    "trustedDnsServers": []
  },
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
| `FREEWEB_TRUSTED_DNS_SERVERS` | Comma-separated public DNS IPv4/IPv6 literals used only for verified fake-ip Fetch, Map and Crawl; empty by default |
| `TINYFISH_API_KEY` | TinyFish key |
| `FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED` | `true` only after the no-wallet-spending check |
| `FIRECRAWL_LOCAL_BIN` | Firecrawl binary path |
| `FIRECRAWL_PORT` | Fixed port; `0` selects an owned free port |
| `FREEWEB_FIRECRAWL_SEARCH_FALLBACK` | Enable the keyless Firecrawl Search Provider (separate from the per-call Search `fallback` input) |
| `EGO_BROWSER_BIN` | ego-browser binary path |
| `FREEWEB_EGO_UNRESTRICTED` | Register the unrestricted `browse_node` tool |

Firecrawl and ego private-network access have separate opt-in settings. Do not enable them for untrusted MCP clients.

`network.trustedDnsServers` defaults to `[]` and accepts only public IP literals, not resolver hostnames or URLs. For a non-IP Fetch, Map or Crawl start hostname, trusted DNS is consulted only when every system answer is in `198.18.0.0/15`. Ordinary and mixed answers never contact it. An all-fake-ip answer without configuration returns `FAKE_IP_DNS_DETECTED`; trusted resolution failure or no answers returns retryable `FAKE_IP_DNS_UNVERIFIED`. Every trusted answer must be public. Direct fake-ip literals, private trusted answers, local/private targets, credentialed URLs, and non-HTTP(S) URLs remain blocked, and validation failures never trigger Provider Fallback.

Local Fetch, TinyFish Fetch, local Map and Crawl startup all use this shared policy while retaining their own public-only checks; TinyFish revalidates at its Provider boundary and Firecrawl Local keeps its serve-level public-only protection. An explicit HTTP 200 application failure remains a Map Provider failure with its attempt and cause, while a confirmed empty Map result remains successful. A Crawl target that fails this policy creates no Crawl Job and makes no Provider request. Configuring trusted DNS does not enable either `allowPrivate` setting. Configuration is startup-loaded: after changing `network.trustedDnsServers` or `FREEWEB_TRUSTED_DNS_SERVERS`, restart the MCP server or reload the MCP session.

### Search providers and per-call Fallback

Search has two independent settings that are easy to confuse:

- **Provider configuration** decides which Providers exist. `TINYFISH_API_KEY` plus `tinyfish.freeOnlyConfirmed: true` enables TinyFish Search; `firecrawl.searchFallback: true` enables the keyless Firecrawl Search Provider. A Provider that is not configured is *disabled*; that is a configuration state, not Fallback.
- **The per-call `fallback` input** (default `true`) decides whether one Search call may try one alternate Provider. `fallback: false` means no alternate Provider is inspected, requested, or charged against its quota.

The two settings compose: with `fallback: false`, a failing or unconfigured requested Provider returns an error that names the relevant configuration and states that no alternate was attempted. With `fallback: true`, an explicit unconfigured primary may be skipped and at most one configured alternate is attempted. A successful degraded result reports `requestedProvider`, the actual `provider`, every `attempts` entry, and an explicit warning. A valid empty Search result is a success and never triggers Fallback.

A disabled Provider is not the same as disabling per-call Fallback, and `fallback: false` does not disable TinyFish or keyless Firecrawl Search configuration.

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
| `search` | Requested Provider first; per-call `fallback` allows at most one alternate; keyless Firecrawl Search must be enabled separately |
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

Search pinned to one Provider without any alternate attempt:

```json
{
  "query": "local web MCP",
  "provider": "tinyfish",
  "fallback": false
}
```

`provider` selects the requested Provider (`auto` starts with TinyFish). `fallback: false` forbids alternate Provider attempts even when keyless Firecrawl Search is configured.

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
  "maxDiscoveryDepth": 3,
  "formats": ["markdown", "links"]
}
```

Crawl Pages are unique and stably ordered across snapshots and checkpoints. When the Job requests `links`, each Page carries the same optional top-level `links` array as a Fetch Page, and `formats.links` is retained for existing consumers.

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
npm run verify:pack
```

Unit and in-memory MCP tests do not require provider credentials. Live tests are separated from mock tests and should use a dedicated ego test Profile/Space. TinyFish live tests are opt-in and must never be pointed at a wallet-enabled account. `npm run verify:pack` packs the real tarball, installs it into a temporary prefix offline, drives the installed executable, and proves that the removed library entry no longer resolves; it never touches the network.

See the [verification report](docs/testing.md) and [code review record](docs/review.md) for exact test counts, live environment limitations, and the final delegate-review result.

## License

MIT for FreeWeb-MCP. Firecrawl, TinyFish and ego-lite have their own licenses, accounts and terms. See [Provider boundaries ADR](docs/adr/0001-provider-boundaries-and-fallback.md) and [Unrestricted ego ADR](docs/adr/0002-unrestricted-ego-execution.md).
