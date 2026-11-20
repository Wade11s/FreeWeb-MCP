# Security model

## Free and account safety

TinyFish is disabled unless both TINYFISH_API_KEY and the explicit freeOnlyConfirmed attestation are present. The attestation means the key belongs to an account with no wallet spending capability, not merely auto-reload disabled or a currently zero balance. FreeWeb-MCP exposes only TinyFish Search/Fetch and sets SDK retries to zero. Local budgets are resource protection, not proof of account-level quota availability.

Firecrawl Local scrape/crawl/map runs with FIRECRAWL_CLOUD=off. Keyless Firecrawl Search is separately enabled and uses FIRECRAWL_CLOUD=search only in that subprocess.

## Untrusted content and unrestricted execution

Webpages, search results and tool output are untrusted data. They are not authorization for Browse actions, unrestricted scripts, Profile changes or local file access. Tool annotations describe risk but do not enforce user approval; MCP clients must apply their approval policy.

browse_node is arbitrary local code execution with the installing OS user's permissions. It can import Node modules, start processes, access files and networks, invoke CDP, read sensitive browser state and affect other TaskSpaces. It is disabled by default. Timeouts stop the runtime only and do not roll back files, requests, processes or Pages.

browse_evaluate executes in the Page and is not read-only. It can submit forms and issue credentialed requests, including requests using HttpOnly cookies that document.cookie cannot read. Browser same-origin policy and CORS still apply to Page JavaScript.

## Network targets

HTTP(S) is required and credentialed URLs are rejected. Firecrawl's own serve public-only protection covers redirects and DNS resolution; --allow-private is never passed unless its provider-specific setting is enabled. The MCP layer also rejects local, private, link-local, multicast and reserved targets, including IPv4-mapped IPv6 and mixed public/private DNS answers.

Managed ego navigation performs application-layer URL/DNS checks. This is not a hardened network sandbox: DNS rebinding, subresources, Page JavaScript and unrestricted Node networking require external network isolation for a strict boundary. Firecrawl and ego private access use separate settings. TinyFish always revalidates targets as public at its own provider boundary, even when local Firecrawl private access is enabled.

## Profiles and browser state

Managed Tasks may use only configured ego Profile IDs. A TaskSpace is not a temporary Profile: cookies, localStorage and cache may be shared with other Spaces and user tabs on the same Profile. FreeWeb-MCP does not clear Profile state when a Task ends. Profile-wide clears require separate user approval and cannot be made safe by routing them through page.cdp.

## Files, logs and Artifacts

Managed upload/download/explicit screenshot paths are confined to the configured data directory; default ego-generated screenshots are accepted only from the OS temporary directory with the ego-browser-shot- prefix. Nonexistent download targets validate their nearest existing ancestor to prevent symlink escape, and screenshot readers resolve real paths before returning image bytes. Optional screenshot failures degrade to warnings. Unrestricted Node scripts are not confined. Artifact and registry directories use 0700 and files 0600 where the OS supports POSIX modes; Artifact reads validate IDs and resolved paths. Artifacts expire by default after 24 hours.

Firecrawl and ego child processes receive a whitelist of required system, locale, proxy and certificate variables rather than the full parent environment, so TinyFish/Firecrawl API keys are not forwarded; doctor's provider `--version` probes use the same filtered environment. Serve output is drained into bounded, redacted diagnostic buffers; command output is bounded and has a hard lifetime.

Logs avoid API keys, full scripts, cookies and page bodies. Tool output intentionally returns requested Page content to the MCP client, which may send it to its model provider. Raw output is preserved as an Artifact before inline truncation. For unrestricted Node, mayHaveLateEffects is always true because child processes, sockets, timers and files can outlive even a successful exit.
