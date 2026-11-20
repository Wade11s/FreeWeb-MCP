# Verification report

Latest local verification for the MVP, the Initialization tickets (#21-#26), and the MCP correctness follow-ups (#28, #29, #31, #33):

## Automated checks

```text
npm run check
  TypeScript: passed
  Unit tests: 570 passed across 25 files
  In-memory, real-stdio and external CLI integration tests: 134 passed across 9 files
  Build: passed

npm audit
  0 vulnerabilities
```

The stdio tests spawn `dist/cli.js` with the explicit `mcp` command and verify the default eight-tool list and opt-in nine-tool list. They also compare the MCP initialize server version with the built CLI `--version` output and package metadata, without hardcoding the current release. In-memory MCP protocol tests supply ordinary and non-release versions and assert that initialize reports each exactly, while tool registration and behavior remain covered unchanged. The in-memory MCP protocol tests also include a Managed Browse open/handoff/status/resume lifecycle against controlled ego output: a clean zero-exit run with only the recognized user-control hard-stop guidance is a successful handoff, the serialized registry keeps `handoff` status and `agentDelegatedToUser` ownership in the same Space, status stays readable without an ego call, Page work returns `EGO_USER_CONTROL_REQUIRED` until an explicit resume, and work succeeds afterwards. They also drive Search Fallback through controlled Providers behind the same public protocol: per-call `fallback: false` after a primary failure or an unconfigured explicit primary inspects, requests, and consumes no alternate quota; an enabled per-call fallback skips an unconfigured explicit primary for exactly one configured alternate; successful degradation reports `requestedProvider`, the actual `provider`, `attempts`, and a warning; a valid empty result never falls back; and a disabled keyless Firecrawl Search Provider is reported separately from the per-call Fallback switch. The external CLI tests spawn the built executable with a temporary HOME and injected fake provider binaries to verify no-argument help, command help and help targets, both version flags, configuration-independent help/version behavior, strict usage errors with stderr diagnostics, and MCP stdout purity. The doctor CLI tests assert the grouped required/optional text report, actionable remediation, opt-in redacted configuration in text and JSON, versioned JSON-only stdout with retained `ok`/`checks` fields, exit status for failed required checks and optional warnings, the Node.js floor read from a swapped package.json `engines.node`, and an invalid business configuration reported as one failed required `configuration` check. They also record provider argv to prove doctor only ever asks for `--version`. The print-config tests parse the exact emitted JSON, verify it contains only the executable-native `freeweb-mcp mcp` entry with valid, missing, and invalid business configuration, and reject unknown options and excess print-config arguments. Mock/provider tests are not counted as live provider verification.

`init` has two distinct automated seams. In-process `runInit`/`runInitDetailed` integration and unit tests use temporary HOME/config directories, controlled environments, and fake provider executables to cover filesystem-only detection before consent, numbered step display and safe defaults, refusal and terminal EOF, cancellation before pending writes with completed-step evidence, retry attempt counts, versioned machine reports and report redaction, backup-failure continuation without an unsafe rebuild, skipped-platform warning preservation, credentials requiring JSON escaping, non-success component patch exclusion, and failure-menu legacy-y safe continuation, damaged-configuration backup/rebuild and secret-safe refusal, stale-path repair confirmation/decline and environment-selected replacements, valid-config preservation and missing-default completion, atomic writes and 0600/0700 permissions, non-overwriting private backups, interrupted writes and rerun recovery, owned loopback Cloud Off health checks and bounded cleanup, cleanup failures, certified/uncertified versions versus health failures, required doctor failure and its incomplete-run footer, doctor invocation without MCP startup, other-client non-interference, and exit-code combinations. An 18-row combined matrix drives fake required/TinyFish/ego components through component acceptance/decline × ready/pending/failed × required/configuration/doctor readiness, asserting each summary outcome and exit status, one doctor invocation for completed configuration steps, unchanged other-client files, print-config guidance, command-success versus optional-readiness wording, and preservation of `Uncertified`. These tests do not spawn the built CLI.

The built-CLI tests separately cover global/command help, strict option and argument rejection, and non-TTY refusal without reads, writes, or provider launches, including a parseable `init --json` error report. Missing-prerequisite `Pending` is covered at the in-process `runInit` seam; partial-install certification refusal and recovery are covered by Firecrawl component unit tests. On macOS with `expect`, a real pseudo-terminal drives the interactive `init` scenarios through `dist/cli.js`: the confirmed step-by-step happy path (verification, configuration write, file mode 0600, doctor, exit 0), redirected `init --json` stdout with interactive stdin/stderr and a single parseable report, step decline without changes, malformed-configuration backup/rebuild, automatic certified Firecrawl installation with fake Cargo/Rust/C-compiler tools (exact crates.io request, failed install, and rerun without reinstall), TinyFish attestation prompts including a key that is a substring of the attestation sentence, and the ego-lite handoff against fake `open`/`explorer.exe` openers with simulated Windows and Linux platforms. Two all-component baselines accept both optional components (including a no-duplicate-side-effect rerun) and decline both while retaining exit 0 for the ready required baseline. No routine test launches a real installer, a real GUI, or a real Cargo build, and every platform branch is simulated only.

## Live providers

The older provider checks below are not the issue #26 all-component Initialization live run. That run remains unexecuted; its procedure and evidence scaffold are [docs/providers/macos-live-run.md](providers/macos-live-run.md) and [docs/providers/macos-live-evidence.md](providers/macos-live-evidence.md). Windows, Debian/Ubuntu, other Linux distributions, and other platforms have simulated Initialization coverage only and were not live-tested.

```text
Firecrawl Local v0.1.0: 4 passed, 1 environment-skipped
  Scrape markdown/html/links: passed
  Screenshot: passed
  Map: passed
  One-page Crawl + checkpoint Artifact: passed
  Keyless Search: environment-skipped

ego-lite 0.6.3.14: 2 passed
  Managed open/evaluate-with-argument/click/page.fetch/screenshot/close: passed
  Unrestricted Node with fs import and self-managed Space cleanup: passed

TinyFish: 2 configuration-skipped
  No live key was explicitly confirmed for a no-wallet-spending account during verification.
```

Combined live result: **6 passed, 3 environment/configuration-skipped**.

### Environment notes

The development DNS/proxy resolved `example.com` to `198.18.1.136`, inside the reserved `198.18.0.0/15` range. The default guard correctly rejected it. Live Firecrawl tests then used their explicit `FREEWEB_LIVE_ALLOW_PRIVATE=1` test override; production defaults remain public-only.

Firecrawl keyless Search returned an official sign-in/API-key requirement for the current VPN/proxy IP. That test is reported as an environment skip, not replaced with an authenticated or paid request.

The ego tests used local fixtures and uniquely named temporary Spaces, with no login-site actions or Profile cookie/cache/storage clearing. Native string Page evaluation was verified both with a JSON argument and through ordinary DOM interaction.

## Packaging

`npm run verify:pack` (`scripts/verify-package.mjs`) verifies the published artifact end to end and is offline by construction. It builds the package, runs `npm pack`, lists the tarball with `tar`, installs that tarball into a temporary prefix outside the repository with `npm install --offline` (dependencies resolve from the local npm cache that `npm install` populates; a cold cache fails loudly instead of reaching the network), and then drives the installed executable through no-argument help, `help`, `--help`, `help mcp`, `mcp --help`, `--version`, `-v`, `print-config`, `doctor`, `doctor --json`, `doctor --show-config`, and an unknown command with its stderr diagnostic and exit status. It also starts the installed binary with the explicit `mcp` command over real stdio and asserts that initialize reports the same version as both installed CLI version flags and the installed package metadata. It asserts that the installed `node_modules/.bin` link resolves to the packed `dist/cli.js`, that the file keeps its shebang and executable mode, and that `doctor` still replaces the TinyFish key with `[redacted]`.

The release workflow runs `npm ci` and then `npm install --package-lock=false --ignore-scripts --no-audit --no-fund` before this verification. The second command populates registry metadata that `npm ci` alone may omit; the tarball installation itself remains offline.

The release workflow uses Node.js 22.14 and npm CLI 11.15 to run `npm stage publish --provenance` after all checks. The stage-only token cannot publish directly; a maintainer must review and approve the staged version with 2FA before it becomes publicly available.

The same run verifies the CLI-only surface. The installed `package.json` declares no `main`, `module`, `types`, `typings`, `exports`, or `imports`, and its only entry is the `freeweb-mcp` bin. A consumer project beside the install fails `await import("@wade11s/freeweb-mcp")` with `ERR_MODULE_NOT_FOUND: Cannot find package '.../node_modules/@wade11s/freeweb-mcp/index.js'` and fails `require.resolve("@wade11s/freeweb-mcp")` with `MODULE_NOT_FOUND`, so neither module system reaches a library entry.

The tarball contents are asserted against the intended set (executable and runtime modules, README, license, glossary, configuration example, and the architecture, security, testing, provider, and ADR documents) and against shipping source, tests, build or editor configuration, `AGENTS.md`, `node_modules`, or a nested tarball. `npm run check` stays independent of the npm cache, so packaging verification is a separate local command.

To reproduce the install step by hand:

```bash
npm pack --pack-destination /tmp
npm install --prefix /tmp/freeweb-prefix --offline --no-audit --no-fund /tmp/wade11s-freeweb-mcp-0.1.0.tgz
PATH="/tmp/freeweb-prefix/node_modules/.bin:$PATH" freeweb-mcp --version
cd /tmp/freeweb-prefix && node -e "import('@wade11s/freeweb-mcp').then(() => console.log('RESOLVED'), (error) => console.log('FAILED', error.code))"
```
