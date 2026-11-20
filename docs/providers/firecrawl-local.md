# Firecrawl Local provider contract

For the combined Initialization journey, see the [setup guide](setup.md), [opt-in macOS live-run procedure](macos-live-run.md), and [unexecuted evidence scaffold](macos-live-evidence.md).

The certified baseline is firecrawl-local 0.1.0. The local binary was found at /Users/hwj/.cargo/bin/firecrawl-local on the development machine. Other versions are reported by doctor as not fully certified rather than silently treated as identical.

## Installation and platform evidence

`freeweb-mcp init` installs only when no `firecrawl-local` executable is detected. The exact request is:

```text
cargo install firecrawl-local --version 0.1.0
```

The version pin is `CERTIFIED_FIRECRAWL_VERSION = "0.1.0"` in `src/init/components/firecrawl.ts`; the install argument list is `FIRECRAWL_INSTALL_ARGS = ["install", "firecrawl-local", "--version", "0.1.0"]` in the same file. Initialization does not run `cargo install firecrawl-local` without the version, does not clone a source branch, and does not select a fallback version. Before Cargo runs it probes `rustc --version`, `cargo --version`, and the C compiler: `cc --version` first, then `gcc --version`, then `clang --version`, accepting the first that answers. Missing prerequisites produce `Pending` with official guidance: rustup for Rust/Cargo, `xcode-select --install` on macOS, and build-essential on Debian/Ubuntu. Initialization never installs those prerequisites, system package managers, Xcode command-line tools, or Chrome/Chromium. The installed binary is read from `CARGO_INSTALL_ROOT/bin`, `CARGO_HOME/bin`, `~/.cargo/bin`, or `PATH`, then must report exactly 0.1.0 and pass the shared health check before it is recorded as Installed.

| Platform | Initialization behavior | Official installation evidence | FreeWeb-MCP verification in this change |
| --- | --- | --- | --- |
| macOS | Automatic install after prerequisite checks | Official quickstart requires Rust and the Xcode command-line tools | Simulated with fake `rustc`/`cargo`/`cc` and fake Cargo output on macOS; no live Cargo build was performed |
| Debian/Ubuntu | Automatic install after prerequisite checks | Official quickstart requires Rust and build-essential | Simulated only, with injected Debian/Ubuntu `os-release`; no live Debian or Ubuntu machine was used |
| Windows | Detection and manual guidance only; no automatic-installation claim | Official quickstart documents the manual path | Simulated only |
| Other platforms/distributions | Detection and manual guidance only; no automatic-installation claim | Official quickstart | Simulated only |

The issue #26 all-component macOS live run has **not** been performed by the implementation agent. Until the orchestrator records actual evidence, macOS Initialization also remains simulated-only for this ticket. Windows, Debian/Ubuntu, and all other platforms were not live-tested.

An existing installation, including a version other than 0.1.0, is never upgraded, downgraded, or reinstalled. A newly installed binary is not certified merely because Cargo exited 0: a missing or different version, or a failed health check, is reported as Failed. A successful install records its resolved absolute path so a rerun verifies it instead of installing again. One exception is deliberate: when Cargo installs the certified version but the health check fails, the run is still Failed, yet the resolved binary path is written to `firecrawl.binary` so the rerun verifies rather than reinstalls that binary. Chrome/Chromium is detected and reported as an optional JavaScript-rendering/screenshot enhancement; it is never installed and never a readiness condition.

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
