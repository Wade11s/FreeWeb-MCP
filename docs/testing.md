# Verification report

Latest local verification for the MVP plus the first Initialization ticket:

## Automated checks

```text
npm run check
  TypeScript: passed
  Unit tests: 480 passed across 21 files
  In-memory, real-stdio and external CLI integration tests: 65 passed across 5 files
  Build: passed

npm audit
  0 vulnerabilities
```

The stdio tests spawn `dist/cli.js` with the explicit `mcp` command and verify the default eight-tool list and opt-in nine-tool list. The external CLI tests spawn the built executable to verify no-argument help, command help and help targets, both version flags, configuration-independent help/version behavior, strict usage errors with stderr diagnostics, and MCP stdout purity. They also parse the exact `print-config` JSON, verify it contains only the executable-native `freeweb-mcp mcp` entry with valid, missing, and invalid business configuration, and reject unknown options and excess print-config arguments. Mock/provider tests are not counted as live provider verification.

`init` has two distinct automated seams. In-process `runInit` integration tests use temporary HOME/config directories, controlled environments, and fake provider executables to cover filesystem-only detection before consent, plan display, refusal and terminal EOF, damaged-configuration backup/rebuild and secret-safe refusal, stale-path repair confirmation/decline and environment-selected replacements, valid-config preservation and missing-default completion, atomic writes and 0600/0700 permissions, non-overwriting private backups, interrupted writes and rerun recovery, owned loopback Cloud Off health checks and bounded cleanup, cleanup failures, certified/uncertified versions versus health failures, required doctor failure and its incomplete-run footer, doctor invocation without MCP startup, other-client non-interference, and exit-code combinations. These tests do not spawn the built CLI.

The built-CLI tests separately cover global/command help, strict option and argument rejection, and non-TTY refusal without reads, writes, or provider launches. On macOS with `expect`, a real pseudo-terminal drives exactly three interactive scenarios through `dist/cli.js`: the confirmed happy path (including verification, configuration write, file mode 0600, doctor, and exit 0), plan decline without changes, and malformed-configuration backup/rebuild. Stale paths, preservation, uncertified-versus-health failure, backup non-overwrite, directory permissions, interrupted writes, and doctor-failure exit are covered only at the `runInit` seam; no PTY coverage is claimed for them. No live GUI onboarding was performed.

## Live providers

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

`npm pack --dry-run` succeeds and includes the CLI, declarations, README, license, configuration example, and public architecture/security/provider/ADR documents. Development agent instructions are excluded from the published document set.
