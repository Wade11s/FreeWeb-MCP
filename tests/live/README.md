# Live provider tests

Live tests are opt-in and are separate from mock/unit and in-memory/stdio integration tests.

## Firecrawl Local v0.1.0

```bash
FREEWEB_LIVE_FIRECRAWL=1 npm run test:live -- tests/live/firecrawl.test.ts
```

Some VPN/proxy DNS implementations map public hostnames to the reserved `198.18.0.0/15` range. The default public-only guard correctly rejects that mapping. To certify Firecrawl in that specific environment, explicitly opt into private/reserved targets for the test run only:

```bash
FREEWEB_LIVE_FIRECRAWL=1 FREEWEB_LIVE_ALLOW_PRIVATE=1 npm run test:live -- tests/live/firecrawl.test.ts
```

Do not copy that override into a production MCP configuration for untrusted clients.

Keyless Firecrawl Search is a separate opt-in:

```bash
FREEWEB_LIVE_FIRECRAWL=1 FREEWEB_LIVE_FIRECRAWL_SEARCH=1 FREEWEB_LIVE_ALLOW_PRIVATE=1 npm run test:live -- tests/live/firecrawl.test.ts
```

If Firecrawl requires sign-in for the current IP, that Search test is reported as an environment skip. It is not replaced with a paid/authenticated request.

## ego-lite

```bash
FREEWEB_LIVE_EGO=1 npm run test:live -- tests/live/ego.test.ts
```

The test serves a local fixture, explicitly enables private URLs only in its test configuration, uses uniquely named temporary Spaces, and closes both managed and raw Spaces. It does not sign into a website or clear Profile cookies/cache/storage.

## TinyFish

TinyFish live tests require all three opt-ins:

```bash
FREEWEB_LIVE_TINYFISH=1 \
FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED=true \
TINYFISH_API_KEY=... \
npm run test:live -- tests/live/tinyfish.test.ts
```

Use only a key whose account has no wallet spending capability. The tests call Search and Fetch once each, never Agent, Browser, Research or wallet endpoints. If the account cannot meet that requirement, leave the tests skipped.
