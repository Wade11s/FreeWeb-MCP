# macOS Initialization live-run evidence

> **Status: RUN on 2026-11-20 (macOS, this machine).** The orchestrator performed the opt-in run described in [macos-live-run.md](macos-live-run.md) against the packed tarball, with `TINYFISH_API_KEY` deliberately removed from the child environment. The implementation agent performed none of it. Every value below is an observed value, not an expected one.

## Safety review

- Evidence contains no credential value, API key, token, cookie, password, session, browser Profile, or personal browsing data: **yes**
- Raw environment dumps, shell profiles, browser data, and sensitive configuration were not attached: **yes**
- TinyFish account/billing attestation was not made by the orchestrator or implementation agent: **confirmed — the attestation prompt was answered `n`, and `tinyfish.freeOnlyConfirmed` stayed `false`**
- No privilege elevation, quarantine removal, remote shell installer, automatic provider replacement, or browser-data import was performed: **confirmed — no `sudo`, no `xattr`, no remote script, no installer or browser launch, no `ego-browser import`**

## Host and versions

| Item | Actual observation |
| --- | --- |
| Run date/time and timezone | 2026-11-20 20:49–20:53 local (UTC+8) |
| macOS version (`sw_vers`) | macOS 27.2.1, build 26B131 |
| Hardware architecture (`uname -m`) | arm64 (Apple M2) |
| Dedicated test account or approved existing account | approved existing account |
| Node.js | v26.13.1 |
| FreeWeb-MCP package/version and source (release or packed tarball) | `freeweb-mcp@0.1.0`, packed tarball installed into a temporary prefix (`npm install --prefix /tmp/… --offline`), run as `prefix/node_modules/.bin/freeweb-mcp` |
| Rust / Cargo / C compiler | `cargo` and `cc` present on PATH; no installation was needed or attempted |
| Firecrawl Local before run | `/Users/hwj/.cargo/bin/firecrawl-local`, version `0.1.0` (certified) |
| ego-lite / ego-browser before run | `/Users/hwj/.local/bin/ego-browser`, `0.6.3.14` (chromium 156.0.8078.96) |
| Chrome/Chromium | detected at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; reported as an optional enhancement only |

## Configuration scope

| Item | Actual observation |
| --- | --- |
| Configuration path class (default or `FREEWEB_CONFIG`; sanitize personal path) | default (`~/.config/freeweb-mcp/config.json`) |
| Pre-run state (absent / valid / malformed / schema-invalid) | absent before the first run |
| Data directory class (default or override; sanitize personal path) | default (`~/.freeweb-mcp`) |
| Existing valid explicit values preserved | yes — the rerun reported `no content changes were made` and the config was byte-identical (`cmp` reported identical) |
| Damaged-file backup name and non-overwrite behavior | not applicable — no damaged configuration existed and none was manufactured against the real home |
| Atomic write and private permissions observed | yes — file `-rw-------` (0600), directory `drwx------` (0700) |
| Other MCP client and shell configuration remained unchanged | yes — no MCP client config was read or written; `print-config` only printed JSON |

## All-component run observations

| Step | Actual observation, outcome, and exit status | Skipped? Why? |
| --- | --- | --- |
| Read-only Firecrawl detection | detected `firecrawl-local 0.1.0` at the cargo bin path; no version command was used to decide certification beyond `--version` | no |
| Certified Cargo installation, if needed | not applicable — a certified binary already existed; no `cargo install` was run | skipped, already installed |
| Existing uncertified version preservation, if applicable | not applicable — the installed version is certified | no |
| Owned loopback Cloud Off `/health` verification and cleanup | `Installed - existing installation … verified with an owned loopback health check (Cloud Off)`; the child `serve` process was started, `GET /health` returned `{"status":"ok","engine":"firecrawl-local","version":"0.1.0"}`, and the process was terminated and reaped | no |
| TinyFish setup selected, attestation declined, `Pending` | `Pending - TINYFISH_API_KEY is not set and the explicit Free attestation was not confirmed … tinyfish.freeOnlyConfirmed was not enabled` | no |
| TinyFish key absent from child via `env -u` | the child was started as `env -u TINYFISH_API_KEY <cli> init`; the attestation was answered `n` and no key value was read, printed, or written | no |
| ego official-page opener handoff | not reached — an existing ego installation was detected, so the plan offered verification instead of a download-page handoff | skipped, already installed |
| Human-only application installation and GUI onboarding | not performed in this run; the human confirmed the existing installation was already onboarded, which is the only onboarding state asserted | no (pre-existing state) |
| Human-only browser-data choices | no import was performed, offered, or recorded | skipped, not performed |
| ego command and native Node.js verification | `Installed - existing or newly installed ego-browser … verified on darwin after your onboarding confirmation (command and native Node.js entry)`; `ego-browser --version` reported `0.6.3.14` and the native entry printed the expected marker | no |
| Configuration generation/preservation | `Configured - wrote new conservative configuration (no private access, no Search Fallback, no Unrestricted Browse) with 2 contributed settings` (Firecrawl and ego binary paths) | no |
| Final doctor | `PASS node`, `PASS firecrawl-local`, `PASS ego-browser`, `WARN tinyfish` (optional, no key), `PASS ego-platform`, `PASS data-directory`; no required failure | no |
| `print-config` guidance | printed `{"mcpServers":{"freeweb":{"command":"freeweb-mcp","args":["mcp"]}}}`; no client was registered | no |
| First-run summary | Firecrawl `Installed` / TinyFish `Pending` / ego-lite `Installed` / Configuration `Configured` | no |
| First-run process exit | 0 — `Initialization command succeeded; Firecrawl and the base configuration are usable and no selected operation failed` | no |

Non-interactive invocation was also checked: piping into `init` with no terminal exits 1 with `freeweb-mcp init is interactive and requires a terminal; no changes were made.` and creates nothing.

Declining the plan in a real terminal was also checked: the plan was printed, the child exited 1 with `Initialization canceled before any changes were made.`, and no configuration file was created.

## Rerun observations

| Item | Actual observation |
| --- | --- |
| Firecrawl detected without another install | yes — the plan offered verification of the existing installation |
| Firecrawl health and cleanup repeated | yes — the owned Cloud Off health check ran again and the process was reaped |
| TinyFish still `Pending` without key/attestation | yes — identical `Pending` text |
| ego detected without duplicate opener | yes — no opener was invoked at all |
| No automatic provider upgrade/downgrade/replacement | yes — versions unchanged (`0.1.0`, `0.6.3.14`) |
| No configuration reset or unrelated duplicate side effect | yes — data directory untouched apart from its existing contents |
| Complete valid configuration reported no content changes, or exact reviewed changes only | `existing configuration … is complete; no content changes were made; file mode 0600 and directory mode 0700 enforced` |
| Existing backup not overwritten | not applicable — no backup was created in this run |
| Final doctor and summary | same six checks, same four outcomes |
| Rerun process exit | 0 |

## Interruption or partial completion

The first attempt was a real, unplanned partial-completion case and is recorded honestly: the run failed with exit 1 on a live-only defect. Both defects below were found only because this run happened, and both are now fixed with regression tests that reproduce them in simulation:

1. `FIRECRAWL_LOCAL_ALLOW_PRIVATE` was set to `0`, but `firecrawl-local 0.1.0` binds that variable to a clap boolean flag and rejects anything except `true`/`false`, so `serve` exited 2 and the health check reported `Failed`. Fixed to `true`/`false`.
2. ego verification looked for the native-entry marker on stdout only, while `ego-browser`'s embedded Node runtime writes script output to stderr, so `Installed` was reported as `Failed`. The marker is now matched across both streams, as the provider already did.

After the fixes the same procedure succeeded, then reran idempotently as recorded above. No recovery run manipulated an existing provider, and no backup was overwritten.

## Live-test limitation

**Windows was not live-tested. Debian/Ubuntu was not live-tested. Other Linux distributions and all other platforms were not live-tested. Their Initialization branches have simulated automated coverage only until separately verified.**

All observations in this document come from one macOS account (macOS 27.2.1, arm64) with a certified Firecrawl, an existing ego-lite, and no TinyFish key.

One further limitation is environmental rather than product-side: this host resolves public names through a fake-IP DNS proxy, so `example.com` resolves to `198.18.1.136`. The remote-URL guard correctly refuses the `198.18.0.0/15` benchmark range as non-public, which means the opt-in `tests/live/firecrawl.test.ts` page-fetch cases cannot run here without weakening the SSRF rule. That guard was left untouched. The code path the live run needed to prove — starting the real `firecrawl-local serve`, reading its `/health`, and shutting it down with bounded cleanup — was exercised by `init` itself and is recorded above.

Even after this run, TinyFish `Configured` (if separately chosen by the account holder) would attest only to key presence and the holder's explicit statement; it would not prove service, quota, or billing behavior. ego command/native verification does not prove every Browse or Profile path is ready.

## Sanitized evidence references

- Command forms only: `env -u TINYFISH_API_KEY <prefix>/node_modules/.bin/freeweb-mcp init`, then the same command again.
- `freeweb-mcp doctor` and `freeweb-mcp print-config` run from the same temporary prefix.
- No terminal dumps, configuration contents, or environment values are attached.
