# macOS Initialization live-run evidence

> **Status: NOT RUN — scaffold only.** The issue #26 implementation agent performed no live installation, GUI, browser, credential, or real-home Initialization step. The orchestrator must replace bracketed fields only with actual observations from the opt-in run. Do not convert an unobserved step into a pass.

## Safety review

- Evidence contains no credential value, API key, token, cookie, password, session, browser Profile, or personal browsing data: **[human reviewer confirms yes/no after the run]**
- Raw environment dumps, shell profiles, browser data, and sensitive configuration were not attached: **[yes/no]**
- TinyFish account/billing attestation was not made by the orchestrator or implementation agent: **[confirm actual conduct]**
- No privilege elevation, quarantine removal, remote shell installer, automatic provider replacement, or browser-data import was performed: **[confirm actual conduct]**

## Host and versions

| Item | Actual observation |
| --- | --- |
| Run date/time and timezone | **[fill]** |
| macOS version (`sw_vers`) | **[fill]** |
| Hardware architecture (`uname -m`) | **[fill]** |
| Dedicated test account or approved existing account | **[fill; no username needed]** |
| Node.js | **[fill]** |
| FreeWeb-MCP package/version and source (release or packed tarball) | **[fill]** |
| Rust / Cargo / C compiler | **[fill actual versions or missing]** |
| Firecrawl Local before run | **[path redacted if personal; actual version or missing]** |
| ego-lite / ego-browser before run | **[actual version or missing]** |
| Chrome/Chromium | **[detected/missing; optional only]** |

## Configuration scope

| Item | Actual observation |
| --- | --- |
| Configuration path class (default or `FREEWEB_CONFIG`; sanitize personal path) | **[fill]** |
| Pre-run state (absent / valid / malformed / schema-invalid) | **[fill]** |
| Data directory class (default or override; sanitize personal path) | **[fill]** |
| Existing valid explicit values preserved | **[yes/no/not applicable; observed evidence]** |
| Damaged-file backup name and non-overwrite behavior | **[sanitized observation or not applicable]** |
| Atomic write and private permissions observed | **[fill actual modes on macOS]** |
| Other MCP client and shell configuration remained unchanged | **[fill actual comparison; do not attach contents]** |

## All-component run observations

| Step | Actual observation, outcome, and exit status | Skipped? Why? |
| --- | --- | --- |
| Read-only Firecrawl detection | **[fill]** | **[fill]** |
| Certified Cargo installation, if needed | **[exact observed request/result or not applicable]** | **[fill]** |
| Existing uncertified version preservation, if applicable | **[fill]** | **[fill]** |
| Owned loopback Cloud Off `/health` verification and cleanup | **[fill actual summary observation]** | **[fill]** |
| TinyFish setup selected, attestation declined, `Pending` | **[fill; no credential or account claim]** | **[fill]** |
| TinyFish key absent from child via `env -u` | **[confirm command form only]** | **[fill]** |
| ego official-page opener handoff | **[fill actual opener result]** | **[fill]** |
| Human-only application installation and GUI onboarding | **[human confirms completed/not complete; no browser data]** | **[fill]** |
| Human-only browser-data choices | **[decision left to human; record no values or Profiles]** | **[fill]** |
| ego command and native Node.js verification | **[actual versions/marker result]** | **[fill]** |
| Configuration generation/preservation | **[fill]** | **[fill]** |
| Final doctor | **[actual required/optional results and exit]** | **[fill]** |
| `print-config` guidance | **[actual observation; no client registration required]** | **[fill]** |
| First-run summary | **[Firecrawl / TinyFish / ego / Configuration outcomes]** | **[fill]** |
| First-run process exit | **[0/1 and why]** | **[fill]** |

## Rerun observations

| Item | Actual observation |
| --- | --- |
| Firecrawl detected without another install | **[fill]** |
| Firecrawl health and cleanup repeated | **[fill]** |
| TinyFish still `Pending` without key/attestation | **[fill]** |
| ego detected without duplicate opener | **[fill]** |
| No automatic provider upgrade/downgrade/replacement | **[fill]** |
| No configuration reset or unrelated duplicate side effect | **[fill]** |
| Complete valid configuration reported no content changes, or exact reviewed changes only | **[fill]** |
| Existing backup not overwritten | **[fill or not applicable]** |
| Final doctor and summary | **[fill]** |
| Rerun process exit | **[0/1 and why]** |

## Interruption or partial completion

**[Record any interruption, pending human step, failed operation, recovery run, and actual result. Write “none observed” only if that is true.]**

## Live-test limitation

**Windows was not live-tested. Debian/Ubuntu was not live-tested. Other Linux distributions and all other platforms were not live-tested. Their Initialization branches have simulated automated coverage only until separately verified.**

Even after this macOS scaffold is completed, TinyFish `Configured` (if separately chosen by the account holder) would attest only to key presence and the holder's explicit statement; it would not prove service, quota, or billing behavior. ego command/native verification would not prove every Browse or Profile path is ready.

## Sanitized evidence references

**[List filenames or issue-comment links for sanitized excerpts only. Do not include secrets, browser data, personal configuration contents, or unreviewed terminal dumps.]**
