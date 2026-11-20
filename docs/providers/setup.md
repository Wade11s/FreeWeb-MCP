# Initialization setup guide

Run the final command from an interactive terminal:

```bash
freeweb-mcp init          # numbered human interaction
freeweb-mcp init --json   # same interaction; one final JSON report on stdout
```

Initialization is explicit and TTY-only. It never runs from MCP startup or `doctor`, and there is no `--yes`, unattended, or alternate-config-flag mode. JSON changes only the report presentation; it does not bypass consent. `FREEWEB_CONFIG` and the existing configuration-path rules remain authoritative.

## Prerequisites and support

Every platform needs Node.js 22.12+ and a usable `firecrawl-local` for the required local baseline. Automatic Firecrawl installation additionally requires an existing Rust/Cargo toolchain and C compiler. Chrome/Chromium is optional for JavaScript rendering and screenshots. TinyFish uses the SDK bundled with FreeWeb-MCP; no global TinyFish CLI is installed. ego-lite requires its official desktop application and human GUI onboarding.

| Platform | Firecrawl Local | TinyFish Search/Fetch | ego-lite | Initialization verification status |
| --- | --- | --- | --- | --- |
| macOS | Detect and preserve; if missing, offer the exact certified `cargo install firecrawl-local --version 0.1.0` after prerequisite checks | Optional SDK setup; environment key plus the account holder's explicit Free attestation | Optional official-download handoff and human onboarding | Automated simulation only until the separately recorded live run is completed |
| Debian/Ubuntu | Same certified Cargo path after prerequisite checks | Same optional SDK setup | Unsupported: `Skipped` | **Simulated only; not live-tested** |
| Windows | Detection and manual guidance only | Same optional SDK setup | Optional official-download handoff and human onboarding | **Simulated only; not live-tested** |
| Other Linux distributions and other platforms | Detection and manual guidance only | Same optional SDK setup | Unsupported: `Skipped` | **Simulated only; not live-tested** |

Provider support does not imply live platform certification. See the [macOS live-run procedure](macos-live-run.md) and its [unexecuted evidence scaffold](macos-live-evidence.md). Windows, Debian/Ubuntu, other Linux distributions, and every other non-macOS platform must remain documented as simulated-only until separate live evidence exists.

## Initialization Steps and shared safety boundary

Each step presents only its own current state, action, warnings, and numbered choices:

- **Firecrawl Local is required.** Its default is Quit; verification or installation must be selected explicitly.
- **TinyFish Search/Fetch is optional.** Its safe default is Skip, and skipping does not fail a usable required baseline.
- **ego-lite is optional** on macOS and Windows. Its safe default is Skip; unsupported platforms never launch an opener or verification.
- **Configuration and Doctor are separate required steps.** Neither runs without its own selection.

The journey uses the same order for every selection:

1. **Inspect environment.** Classify configuration and perform filesystem/environment-only provider detection. A damaged file requires explicit backup consent before any provider action.
2. **Handle one provider at a time.** Show Firecrawl, TinyFish, then ego-lite. Confirm old → new repairs within the owning provider step, and keep optional setup/handoff and human-readiness decisions separate.
3. **Write configuration once.** Collect non-secret contributions and apply them through one configuration safety boundary and at most one atomic content write per attempt. Existing explicit values remain unchanged except individually confirmed repairs.
4. **Run Doctor after selection.** Print one classified summary and show `freeweb-mcp print-config` guidance. The MCP server is never started and other MCP clients are never scanned or modified.

Empty input selects the safe default, invalid numbered input is explained and retried, and terminal EOF cannot grant consent. A failed operation offers Retry, Continue, or Quit; nothing retries automatically. Quit prevents all later actions and any pending configuration write. Earlier external changes are not rolled back, so the partial report lists completed steps rather than claiming that nothing changed.

## Machine-readable report

With `--json`, prompts and progress use stderr and stdout contains one final `schemaVersion: 1` document. Stdout can therefore be redirected while stdin and stderr stay attached to the terminal. The report has `status: succeeded | failed | cancelled`, ordered `steps` with stable ids/statuses/outcomes/attempt counts, `doctor` or `null`, `nextSteps`, and an optional structured `error`. Non-TTY refusal and cancellation also produce reports. It is a result format, not a JSON command-input or unattended protocol.

## Provider-specific human decisions

### Firecrawl Local

An existing executable is preserved, including an uncertified version. New installations use only crates.io `firecrawl-local` 0.1.0; Initialization does not install Rust, Cargo, compilers, Xcode tools, package managers, or Chrome/Chromium. Verification starts a FreeWeb-MCP-owned loopback process on an owned port with `FIRECRAWL_CLOUD=off`, requests only local `/health`, and closes that process with bounded shutdown. `Uncertified` is a warning, not a failure when health passes.

### TinyFish Search/Fetch

The user provides `TINYFISH_API_KEY` in the actual FreeWeb-MCP process environment. Initialization never requests, prints, persists, or copies its value. Only the account holder can affirm that the key belongs to an account with no wallet spending capability; free credits, zero balance, disabled auto-reload, and successful setup are not evidence. Missing key or attestation is `Pending`. Initialization makes no SDK, wallet, Search, Fetch, or other paid-risk request, so `Configured` is not service, quota, or account readiness.

### ego-lite

The user decides whether to open <https://lite.ego.app/>, downloads and installs the official application, and completes every GUI onboarding and browser-data decision. Initialization does not execute a remote installer, elevate privileges, remove quarantine attributes, upgrade an existing app, or import a Profile, cookies, passwords, sessions, bookmarks, or extensions. Only after separate explicit onboarding confirmation does it check `ego-browser --version` and the native Node.js entry. Passing these probes is not complete Browse readiness.

Official references:

- Firecrawl: <https://docs.firecrawl.dev/quickstarts/firecrawl-local>
- TinyFish SDK: <https://docs.tinyfish.ai/quick-start>
- ego-lite: <https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/install.md>

## Outcome and exit meanings

| Term | Meaning |
| --- | --- |
| `Installed` | The selected component's local installation and Initialization verification succeeded. This does not prove every capability built on it is ready. |
| `Configured` | The requested non-secret configuration prerequisites were applied or already effective. For TinyFish this means key presence plus attestation only. |
| `Skipped` | An optional component was declined or is unsupported. No selected operation failed. |
| `Pending` | A human prerequisite or decision remains, or a required manual installation is still needed. |
| `Failed` | A selected installation, opener, write, verification, or other operation actually failed. |
| `Uncertified` | A warning attached to an otherwise classified result; it is not a sixth outcome. |

| Condition at the end of the run | Exit code |
| --- | --- |
| Usable Firecrawl and base configuration, with no selected-operation failure | `0`, even when optional components are `Pending` or `Skipped` |
| Any selected installation, write, opener, or verification `Failed` | `1` |
| Required Firecrawl or base configuration is `Pending`, `Failed`, skipped, or missing from the result set | `1` |
| A required final doctor check fails or doctor cannot run | `1` |
| Step/damaged-configuration confirmation is declined, terminal input ends, or invocation is non-TTY | `1` before the corresponding pending side effects |

A successful summary means the **Initialization command** succeeded. It does not mean every optional capability, TinyFish account/service, or Browse path is ready; read each optional outcome and its detail.

## Configuration and recovery

New configuration uses conservative schema defaults: no private-network access, no Search Fallback, and no Unrestricted Browse. Detected provider paths are absolute where appropriate. Existing valid configuration retains every explicit value and receives only missing safe defaults. High-risk settings produce warnings without silent changes. Credential-valued patches are rejected; TinyFish keys are never configuration contributions.

Writes use a same-directory temporary file, atomic rename, and private permissions (0600 file and 0700 directory where POSIX modes are supported). Damaged configuration is backed up to the first non-overwriting backup name before rebuilding. Existing backups are never replaced.

To recover:

1. Read the summary and doctor output. Do not delete configuration or uninstall providers merely to force a different path.
2. Complete the stated human step or correct the failed prerequisite. For optional `Pending`/`Skipped`, this is optional; for required Firecrawl/configuration it is necessary for exit 0.
3. Rerun `freeweb-mcp init` interactively. Existing providers are detected and preserved, valid explicit settings remain intact, stale path changes still require confirmation, and earlier backups are not overwritten.
4. Run `freeweb-mcp doctor` for an independent report. Use `freeweb-mcp print-config` separately when registering an MCP client; Initialization never modifies Claude, Cursor, Codex, or other client files.

An interrupted write leaves the prior complete file in place. A partially installed Firecrawl binary is not certified from existence alone: the rerun must version-check and health-check it rather than automatically replacing it.
