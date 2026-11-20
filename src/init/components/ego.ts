import { constants as fsConstants } from "node:fs";
import { delimiter as pathDelimiter, resolve } from "node:path";
import {
  childProcessEnv,
  nodeCommandRunner,
  type CommandCall,
  type CommandRunner,
} from "../../providers/firecrawl-process.js";
import type { InitComponent, InitDetection, InitExecuteInput, InitVerifyInput } from "../component.js";
import { nodeInitFilesystem, type ConfigClassification, type InitFilesystem } from "../config-store.js";
import type { InitComponentResult } from "../outcomes.js";
import type { InitPlanItem } from "../plan.js";

/** Official ego-lite download page used by both supported desktop platforms. */
export const EGO_DOWNLOAD_URL = "https://lite.ego.app/";
/** Official installation/onboarding reference shown in plan and skip guidance. */
export const EGO_INSTALL_REFERENCE_URL = "https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/install.md";
/** Printed by `ego-browser nodejs -e`; proves the native Node.js entry works. */
export const EGO_NATIVE_MARKER = "freeweb-mcp-ego-ready";

const DEFAULT_BINARY_NAME = "ego-browser";
const COMMAND_TIMEOUT_MS = 10_000;
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "win32"];
const KNOWN_PLATFORMS: readonly NodeJS.Platform[] = [
  "aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd",
];

/**
 * Private detection detail: whether the configuration snapshot already
 * contained an explicit `ego.binary`. This is deliberately not part of the
 * generic `InitDetection` contract; the orchestrator only consumes patches
 * and repairs.
 */
interface EgoDetection extends InitDetection {
  readonly explicitConfiguredBinary?: boolean;
}

export interface EgoComponentDeps {
  readonly fs?: Pick<InitFilesystem, "access" | "stat">;
  /** Shared bounded command seam; tests inject a recorder or use fake PATH executables. */
  readonly commandRunner?: CommandRunner;
  /**
   * Explicit platform override for simulated platform branches. Production
   * uses `process.platform`; built-CLI tests may set FREEWEB_INIT_PLATFORM.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Optional ego-lite Initialization. This component only opens the official
 * download page and waits for a human. It never runs a remote install script,
 * touches quarantine attributes, elevates privileges, upgrades an existing
 * app, or chooses any Browser Profile / cookie / password / session / bookmark
 * / extension import option. Verification happens only after the user
 * explicitly confirms that installation and GUI onboarding are complete.
 */
export function createEgoComponent(deps: EgoComponentDeps = {}): InitComponent {
  const fs = deps.fs ?? nodeInitFilesystem;
  const runner = deps.commandRunner ?? nodeCommandRunner;

  const detect = async (env: NodeJS.ProcessEnv, classification: ConfigClassification): Promise<InitDetection> => {
    const platform = platformFor(env, deps.platform);
    if (!isSupported(platform)) {
      const message = `ego-lite setup is supported only on macOS and Windows; ${platform} is unsupported, so this optional component is Skipped without opening an installer or running verification. See ${EGO_INSTALL_REFERENCE_URL}.`;
      return { installed: false, certified: false, notes: [message], warnings: [{ code: "EgoPlatformUnsupported", message }] };
    }

    const envBinary = nonEmpty(env.EGO_BROWSER_BIN);
    const configured = classification.status === "ok" ? explicitConfiguredBinary(classification.raw) : undefined;

    // Detection contributes configuration declaratively through the shared
    // patch/repair contract. A new or missing setting gets a patch; any
    // resolvable explicit value that differs from the absolute binary path
    // gets its own confirmed old → new proposal. Explicit values are never
    // overwritten by a successful verification.
    const contribute = (detection: InitDetection): EgoDetection => {
      const configPatches = detection.installed && detection.binary && (classification.status !== "ok" || !configured)
        ? [{ setting: "ego.binary", value: detection.binary }]
        : [];
      const repairs = classification.status === "ok" && configured && detection.installed && detection.binary && configured !== detection.binary
        ? [{
            component: "ego" as const,
            setting: "ego.binary",
            oldValue: configured,
            newValue: detection.binary,
          }]
        : [];
      return {
        ...detection,
        ...(configured !== undefined ? { explicitConfiguredBinary: true } : {}),
        ...(configPatches.length > 0 ? { configPatches } : {}),
        ...(repairs.length > 0 ? { repairs } : {}),
      };
    };

    // Detection is read-only: no version probe, no app launch, no GUI changes.
    if (envBinary) {
      const resolved = await locateBinary(envBinary, env, fs);
      if (!resolved) {
        return contribute({
          installed: false,
          certified: false,
          notes: [`EGO_BROWSER_BIN does not resolve to an executable file: ${envBinary}`],
        });
      }
      const staleConfiguredPath = configured && !(await locateBinary(configured, env, fs)) ? configured : undefined;
      return contribute({
        installed: true,
        binary: resolved,
        source: "env",
        certified: false,
        ...(staleConfiguredPath ? { staleConfiguredPath } : {}),
      });
    }
    if (configured) {
      const resolved = await locateBinary(configured, env, fs);
      if (resolved) return contribute({ installed: true, binary: resolved, source: "config", certified: false });
      const onPath = await locateBinary(DEFAULT_BINARY_NAME, env, fs);
      return contribute(onPath
        ? { installed: true, binary: onPath, source: "path", certified: false, staleConfiguredPath: configured }
        : { installed: false, certified: false, staleConfiguredPath: configured });
    }
    const onPath = await locateBinary(DEFAULT_BINARY_NAME, env, fs);
    return contribute(onPath
      ? { installed: true, binary: onPath, source: "path", certified: false }
      : { installed: false, certified: false });
  };

  const plan = (detection: InitDetection): readonly InitPlanItem[] => {
    const unsupported = detection.warnings?.find((warning) => warning.code === "EgoPlatformUnsupported");
    let description: string;
    if (unsupported) {
      description = `skip ego-lite: ${unsupported.message}`;
    } else if (detection.installed) {
      description = "keep the existing ego-browser installation unchanged (no upgrade); wait for your explicit confirmation that GUI onboarding is complete, then verify the command and native Node.js entry";
    } else {
      description = `after plan confirmation, ask before opening the official ego-lite download page (${EGO_DOWNLOAD_URL}); declining skips this optional handoff with no browser launch; accepting leaves installation, GUI onboarding, and every browser-data import choice to you; verification waits for a separate explicit confirmation; guidance: ${EGO_INSTALL_REFERENCE_URL}`;
    }
    return [{
      component: "ego" as const,
      action: "handoff" as const,
      description,
      required: false,
      selected: true,
    }];
  };

  /** Checks the command and the native Node.js entry; caller must have consent. */
  const verify = async (input: InitVerifyInput): Promise<{ readonly ok: boolean; readonly message?: string }> => {
    const nativeArgs = ["nodejs", "-e", `console.log(${JSON.stringify(EGO_NATIVE_MARKER)})`];
    let version: Awaited<ReturnType<CommandRunner>>;
    try {
      version = await runner(commandCall(input.binary, ["--version"]));
    } catch (error) {
      return { ok: false, message: `ego-browser command check failed: ${errorMessage(error)}` };
    }
    if (!commandSucceeded(version)) {
      return { ok: false, message: `ego-browser command check failed: ${failureDetail(version)}` };
    }
    let native: Awaited<ReturnType<CommandRunner>>;
    try {
      native = await runner(commandCall(input.binary, nativeArgs));
    } catch (error) {
      return { ok: false, message: `ego-browser native Node.js entry check failed: ${errorMessage(error)}` };
    }
    if (!commandSucceeded(native)) {
      return { ok: false, message: `ego-browser native Node.js entry check failed: ${failureDetail(native)}` };
    }
    if (!native.stdout.includes(EGO_NATIVE_MARKER)) {
      return { ok: false, message: "ego-browser native Node.js entry did not report the expected marker" };
    }
    return { ok: true };
  };

  const execute = async (input: InitExecuteInput): Promise<InitComponentResult> => {
    const platform = platformFor(input.env, deps.platform);
    const base = { component: "ego" as const, label: "ego-lite", required: false, selected: true };
    if (!isSupported(platform)) {
      return {
        ...base,
        outcome: "Skipped",
        warnings: [],
        detail: `unsupported platform ${platform}; no installer was opened and no verification was run. Install ego lite yourself only if an official build becomes available: ${EGO_INSTALL_REFERENCE_URL}`,
      };
    }

    if (!input.detection.installed) {
      // Optional setup must be skippable before any side effect. Unlike the
      // later onboarding question, a no here returns Skipped and no opener
      // process is started, matching the TinyFish optional-setup pattern.
      const openerConfirmed = await input.io.prompt.confirm(
        `Open the official ego-lite download page (${EGO_DOWNLOAD_URL}) now? Choose no to skip this optional handoff and continue Initialization. [y/N]`,
      );
      if (!openerConfirmed) {
        return {
          ...base,
          outcome: "Skipped",
          warnings: [],
          detail: `optional ego-lite handoff skipped; no browser was opened, no installation or verification was run, and no configuration was changed. Guidance: ${EGO_INSTALL_REFERENCE_URL}`,
        };
      }
      const opener = platform === "darwin"
        ? { command: "open", args: [EGO_DOWNLOAD_URL] }
        : { command: "explorer.exe", args: [EGO_DOWNLOAD_URL] };
      let launch;
      try {
        launch = await runner(commandCall(opener.command, opener.args));
      } catch (error) {
        return {
          ...base,
          outcome: "Failed",
          warnings: [],
          detail: `could not open the official ego-lite download page (${EGO_DOWNLOAD_URL}) on ${platform}: ${errorMessage(error)}; no installation was attempted`,
        };
      }
      if (!commandSucceeded(launch)) {
        return {
          ...base,
          outcome: "Failed",
          warnings: [],
          detail: `could not open the official ego-lite download page (${EGO_DOWNLOAD_URL}) on ${platform}: ${failureDetail(launch)}; no installation was attempted`,
        };
      }
      input.io.writeLine(`Opened the official ego-lite download page (${EGO_DOWNLOAD_URL}) in your browser; no installer was executed.`);
    }

    const onboardingConfirmed = await input.io.prompt.confirm(
      "Have you installed ego lite and completed its GUI onboarding yourself, including all Browser Profile, cookie, password, session, bookmark, and extension import choices? Continue only when ego-browser is available on PATH. [y/N]",
    );
    if (!onboardingConfirmed) {
      return {
        ...base,
        outcome: "Pending",
        warnings: [],
        detail: "GUI installation/onboarding was not confirmed; no command or native-entry verification was run. Rerun init after you finish onboarding.",
      };
    }

    const resolved = await resolveAfterOnboarding(input, fs);
    if (!resolved.ok) {
      return { ...base, outcome: "Failed", warnings: [], detail: resolved.message };
    }
    const verification = await verify({ binary: resolved.binary });
    if (!verification.ok) {
      return {
        ...base,
        outcome: "Failed",
        warnings: [],
        detail: `verification failed after onboarding confirmation: ${verification.message ?? "unknown error"}`,
      };
    }

    // The orchestrator already handles a confirmed old → new repair patch.
    // Only a binary discovered with no explicit configuration is a new
    // setting; any explicit path (including one overridden by the environment
    // or left stale after a declined repair) must stay as the user wrote it
    // unless its own repair was confirmed.
    const detection = input.detection as EgoDetection;
    const pathWasExplicit = detection.source === "config" || detection.explicitConfiguredBinary === true
      || Boolean(detection.staleConfiguredPath)
      || (detection.repairs?.some((repair) => repair.setting === "ego.binary") ?? false);
    const repairApplied = input.appliedRepairs.some((repair) => repair.setting === "ego.binary");
    const alreadyProposed = detection.configPatches?.some((patch) => patch.setting === "ego.binary" && patch.value === resolved.binary) ?? false;
    return {
      ...base,
      outcome: "Installed",
      warnings: [],
      detail: `existing or newly installed ego-browser at ${resolved.binary} verified on ${platform} after your onboarding confirmation (command and native Node.js entry); no upgrade, import, quarantine change, or elevation was performed; Browse use still depends on your GUI choices`,
      ...(pathWasExplicit || repairApplied || alreadyProposed ? {} : { configPatches: [{ setting: "ego.binary", value: resolved.binary }] }),
    };
  };

  return { id: "ego", label: "ego-lite", required: false, detect, plan, verify, execute };
}

/** The command runner receives only the same filtered child environment other providers use. */
function commandCall(command: string, args: readonly string[]): CommandCall {
  return { command, args: [...args], env: childProcessEnv({}), timeoutMs: COMMAND_TIMEOUT_MS };
}

function commandSucceeded(result: Awaited<ReturnType<CommandRunner>>): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function failureDetail(result: Awaited<ReturnType<CommandRunner>>): string {
  if (result.timedOut) return "command timed out";
  const text = result.stderr.trim() || result.stdout.trim();
  return text || `exit code ${String(result.exitCode)}`;
}

async function resolveAfterOnboarding(
  input: InitExecuteInput,
  fs: Pick<InitFilesystem, "access" | "stat">,
): Promise<{ readonly ok: true; readonly binary: string } | { readonly ok: false; readonly message: string }> {
  const repair = input.appliedRepairs.find((item) => item.setting === "ego.binary");
  if (repair && typeof repair.newValue === "string") return { ok: true, binary: repair.newValue };

  const envBinary = nonEmpty(input.env.EGO_BROWSER_BIN);
  if (envBinary) {
    const resolved = await locateBinary(envBinary, input.env, fs);
    return resolved
      ? { ok: true, binary: resolved }
      : { ok: false, message: `EGO_BROWSER_BIN does not resolve to an executable file: ${envBinary}` };
  }
  // A declined stale-path repair must be verified, not silently replaced by a
  // PATH fallback; that is the shared stale old → new configuration contract.
  if (input.detection.staleConfiguredPath) return { ok: true, binary: input.detection.staleConfiguredPath };
  if (input.detection.source === "config" && input.detection.binary) return { ok: true, binary: input.detection.binary };
  // EGO_BROWSER_BIN overrides the file at runtime. Verify the path detection
  // resolved even when a proposed repair for the explicit file value was
  // declined; declining must preserve the file, not silently substitute PATH.
  if (input.detection.source === "env" && input.detection.binary) return { ok: true, binary: input.detection.binary };
  if (input.detection.source === "path" && input.detection.binary) {
    if (await locateBinary(input.detection.binary, input.env, fs)) return { ok: true, binary: input.detection.binary };
  }
  const onPath = await locateBinary(DEFAULT_BINARY_NAME, input.env, fs);
  return onPath
    ? { ok: true, binary: onPath }
    : { ok: false, message: "ego-browser was not found on PATH after onboarding confirmation; rerun init from a terminal started after onboarding" };
}

function platformFor(env: NodeJS.ProcessEnv, override?: NodeJS.Platform): NodeJS.Platform {
  if (override) return override;
  const simulated = KNOWN_PLATFORMS.find((platform) => platform === env.FREEWEB_INIT_PLATFORM);
  return simulated ?? process.platform;
}

function isSupported(platform: NodeJS.Platform): boolean {
  return SUPPORTED_PLATFORMS.includes(platform);
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function explicitConfiguredBinary(raw: Record<string, unknown>): string | undefined {
  const ego = raw.ego;
  if (!isRecord(ego)) return undefined;
  return typeof ego.binary === "string" && ego.binary ? ego.binary : undefined;
}

/** Resolves a bare name on PATH or a path-containing candidate as-is. */
async function locateBinary(
  name: string,
  env: NodeJS.ProcessEnv,
  fs: Pick<InitFilesystem, "access" | "stat">,
): Promise<string | undefined> {
  if (name.includes("/") || name.includes("\\")) {
    const candidate = resolve(name);
    return (await isExecutableFile(candidate, fs)) ? candidate : undefined;
  }
  for (const directory of (env.PATH ?? "").split(pathDelimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    if (await isExecutableFile(candidate, fs)) return candidate;
  }
  return undefined;
}

async function isExecutableFile(path: string, fs: Pick<InitFilesystem, "access" | "stat">): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.X_OK);
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
