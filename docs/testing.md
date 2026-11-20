# Verification report

Latest local verification for the MVP:

## Automated checks

```text
npm run check
  TypeScript: passed
  Unit tests: 430 passed across 15 files
  In-memory, real-stdio and external CLI integration tests: 33 passed across 3 files
  Build: passed

npm audit
  0 vulnerabilities
```

The stdio tests spawn `dist/cli.js` with the explicit `mcp` command and verify the default eight-tool list and opt-in nine-tool list. The external CLI tests spawn the built executable to verify no-argument help, command help and help targets, both version flags, configuration-independent help/version behavior, strict usage errors with stderr diagnostics, and MCP stdout purity. They also parse the exact `print-config` JSON, verify it contains only the executable-native `freeweb-mcp mcp` entry with valid, missing, and invalid business configuration, and reject unknown options and excess print-config arguments. Mock/provider tests are not counted as live provider verification.

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
