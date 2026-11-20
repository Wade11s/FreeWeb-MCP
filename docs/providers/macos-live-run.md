# Opt-in macOS Initialization live run

> **Status: procedure only. The implementation agent did not execute this run.** No real Cargo installation, browser launch, GUI onboarding, browser-data import, credential handling, or real-home Initialization was performed for issue #26. The orchestrator and account holder perform this procedure and fill in [the evidence scaffold](macos-live-evidence.md).

This run exercises the all-component journey on macOS. It is not evidence for Windows, Debian/Ubuntu, other Linux distributions, or any other platform.

## Roles and hard boundaries

- **Orchestrator:** explains each Initialization Step, starts only the commands the human explicitly approves, captures sanitized command status/output, and records skipped steps. It never answers provider or billing attestations for the human.
- **Human macOS user:** approves every side effect; decides whether an existing provider may be used; performs downloads, installation, GUI onboarding, and browser-data choices; and alone makes any TinyFish account attestation.
- **Account holder:** the only person who can decide whether the TinyFish no-wallet-spending statement is true. This procedure's required baseline deliberately uses the human-pending path and makes no account claim.

Never paste a TinyFish key or other credential into the evidence. Do not attach environment dumps, shell profiles, browser Profiles, cookies, passwords, sessions, bookmarks, extensions, personal browsing data, or unredacted configuration containing sensitive values. Do not run `sudo`, remote shell installers, `xattr` quarantine removal, browser import commands, `firecrawl-local login`, or Firecrawl's own `init`.

## 1. Record the host and installed CLI

**Performed by:** orchestrator, with the human's approval.

**Human decision:** approve running read-only version commands on the selected macOS account. If this is not a dedicated test account, review the existing FreeWeb-MCP configuration path before continuing; do not delete or reset it.

```bash
sw_vers
uname -m
node --version
command -v freeweb-mcp
freeweb-mcp --version
printf 'Config: %s\n' "${FREEWEB_CONFIG:-$HOME/.config/freeweb-mcp/config.json}"
printf 'Data: %s\n' "${FREEWEB_DATA_DIR:-$HOME/.freeweb-mcp}"
```

Use Node.js 22.12+ and the packed/released CLI intended for the live check. Record actual versions in the evidence scaffold, not expected values.

## 2. Detect Firecrawl and decide whether installation is allowed

**Performed by:** human and orchestrator together. These commands are read-only.

```bash
command -v firecrawl-local || true
firecrawl-local --version || true
rustc --version || true
cargo --version || true
cc --version || true
```

**Human decision:**

- If 0.1.0 is installed, allow detection and verification; no Cargo installation is needed.
- If another version is installed, decide whether to keep it for the `Uncertified` warning path or stop. Initialization must not replace it.
- If Firecrawl is missing and Rust/Cargo/C compiler are present, decide whether its step may run exactly `cargo install firecrawl-local --version 0.1.0`.
- If prerequisites are missing, allow the `Pending` path or stop. The human may install prerequisites separately through official sources; Initialization must not do it.

Do not install or change a provider before its Initialization Step is shown and explicitly selected.

## 3. Choose the safe TinyFish human-pending path

**Performed by:** orchestrator constructs the child command; the human answers prompts.

Use `env -u TINYFISH_API_KEY` for this required run so no credential value is needed or inspected:

```bash
env -u TINYFISH_API_KEY freeweb-mcp init
```

**Human decision at the TinyFish prompts:** select optional TinyFish setup to exercise the handoff, then **decline the Free attestation**. With no key and no attestation, the expected result is `Pending`. This is deliberately not `Configured` and must not be described as an account/billing verification.

An account holder may perform a separate later run with their own environment-provided key and answer the attestation themselves. The orchestrator must not request the key, recommend an attestation answer, or record the value. That separate run is optional and is not required for this human-pending evidence.

## 4. Select each step and perform Firecrawl verification

**Performed by:** human selects; Initialization executes approved operations.

At the Firecrawl step, verify that it is required and that TinyFish/ego-lite are separate optional steps with Skip defaults. Select Firecrawl only if the displayed installation or verification action is acceptable. Any stale old → new path repair has a separate numbered prompt; the human must approve or decline each exact change.

**Human decision:** approve or decline each component action and repair. Quitting stops later provider operations and any pending write and is recorded as a cancelled live run, not a pass.

For a new certified installation, observe the exact pinned Cargo request. For new and existing binaries, Initialization must report an owned loopback health check with Cloud Off and bounded cleanup. Do not start a second Firecrawl service or reuse an unknown process. Record `Installed`, `Pending`, or `Failed` exactly as observed.

## 5. Complete the ego installer handoff at the human boundary

**Performed by:** Initialization may open the official page only after the human accepts the ego handoff. The human performs every subsequent installation and GUI action.

**Human decision:** accept or decline opening <https://lite.ego.app/>. Declining must produce optional `Skipped` with no opener and can still leave the overall run successful.

If accepted:

1. In the opened page, the human downloads the official macOS application and follows the official instructions at <https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/install.md>.
2. The human alone installs the app, handles any macOS security prompts, completes GUI onboarding, and decides every Profile/cookie/password/session/bookmark/extension import option. The orchestrator does not act in the GUI and does not import browser data.
3. Ensure `ego-browser` is on `PATH` for the terminal running Initialization. Start a new terminal and rerun the procedure if PATH registration requires it.
4. Only the human answers the separate onboarding confirmation. Answer no if anything is incomplete; expected ego outcome is then `Pending` and no native verification should run.

After explicit confirmation, Initialization checks the command and native Node.js entry. The human may also run these read-only probes to corroborate the result:

```bash
command -v ego-browser
ego-browser --version
ego-browser nodejs -e 'console.log("freeweb-mcp-ego-ready")'
```

Record the observed ego outcome and versions. Do not equate these probes with complete Browse or Profile readiness.

## 6. Verify configuration, doctor, and client guidance

**Performed by:** the human selects configuration and Doctor separately; Initialization writes configuration and runs doctor; the human/orchestrator inspect only non-secret results.

Before selecting configuration generation, the human decides whether the displayed path and any damaged-file backup/rebuild action are acceptable. Existing valid explicit values must remain intact; damaged files require a non-overwriting backup and prior consent. Doctor runs only after its own explicit selection.

After the run:

```bash
env -u TINYFISH_API_KEY freeweb-mcp doctor
freeweb-mcp print-config
```

**Human decision:** approve running doctor and inspect whether the generated settings match the choices. Do not paste the configuration into evidence if it contains personal paths or other sensitive data; record only sanitized observations.

Check that the summary contains one result for Firecrawl, TinyFish, ego-lite, and Configuration; retains any `Uncertified` warning; distinguishes command success from optional readiness; and references `print-config`. Initialization must not start the MCP server or modify Claude, Cursor, Codex, shell startup files, or other MCP client configuration.

## 7. Rerun and check idempotence

**Performed by:** human confirms the rerun; orchestrator captures sanitized evidence.

```bash
env -u TINYFISH_API_KEY freeweb-mcp init
```

**Human decision:** use the same TinyFish pending choice and confirm ego onboarding only if it remains complete. Approve only repairs explicitly reviewed again.

Observe and record:

- Existing Firecrawl is detected and health-checked; no second Cargo install occurs.
- Existing ego is detected; the download page is not opened again solely because of a rerun.
- TinyFish without key/attestation remains `Pending` rather than becoming configured.
- Valid explicit configuration is preserved; a complete file reports no content changes. No earlier backup is overwritten.
- No unrelated provider replacement, configuration reset, duplicate opener, or duplicated MCP-client side effect occurs.
- Final doctor and the summary run again, with exit 0 only for a usable required baseline and no selected-operation failure.

If the first run was interrupted or a human step was incomplete, finish that step and rerun rather than deleting state. Record all skipped steps and why in the evidence scaffold.

## 8. Complete the evidence without sensitive data

**Performed by:** orchestrator, reviewed by the human.

Fill every applicable field in [macos-live-evidence.md](macos-live-evidence.md). Include actual observations, host/tool/provider versions, exit statuses, and explicit skip reasons. Attach only sanitized excerpts. The evidence must retain the statement that Windows, Debian/Ubuntu, other Linux distributions, and other platforms were not live-tested.
