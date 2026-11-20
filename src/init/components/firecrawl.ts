import { constants as fsConstants } from "node:fs";
import { delimiter as pathDelimiter, join, resolve } from "node:path";
import {
  childProcessEnv,
  nodeCommandRunner,
  startFirecrawlRuntime,
  type CommandResult,
  type CommandRunner,
  type FirecrawlConfig,
  type FirecrawlRuntime,
} from "../../providers/firecrawl-process.js";
import type { InitComponent, InitDetection, InitExecuteInput, InitVerifyInput } from "../component.js";
import { nodeInitFilesystem, type ConfigClassification, type InitFilesystem } from "../config-store.js";
import type { InitComponentResult, InitWarning } from "../outcomes.js";
import type { InitPlanItem } from "../plan.js";

export const CERTIFIED_FIRECRAWL_VERSION = "0.1.0";
export const FIRECRAWL_INSTALL_ARGS: readonly string[] = [
  "install",
  "firecrawl-local",
  "--version",
  CERTIFIED_FIRECRAWL_VERSION,
];
const DEFAULT_BINARY_NAME = "firecrawl-local";
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const PREREQUISITE_PROBE_TIMEOUT_MS = 10_000;
/**
 * Building Firecrawl Local is a full Rust release build. The bound exists to
 * guarantee interruption cleanup, not to make a real build look fast.
 */
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const LOCAL_QUICKSTART = "https://docs.firecrawl.dev/quickstarts/firecrawl-local";
const RUST_GUIDANCE = "install Rust and Cargo with the official rustup installer from https://rustup.rs, then rerun init";

type FirecrawlPlatform = "macos" | "debian" | "windows" | "unsupported";

export interface FirecrawlComponentDeps {
  readonly fs?: Pick<InitFilesystem, "access" | "stat" | "readFile">;
  readonly commandRunner?: CommandRunner;
  readonly startRuntime?: typeof startFirecrawlRuntime;
  /** Host platform; tests inject macOS, Debian/Ubuntu, Windows, and unsupported hosts. */
  readonly platform?: NodeJS.Platform;
  /** Reads /etc/os-release; tests inject a Debian/Ubuntu or other distribution. */
  readonly readOsRelease?: () => Promise<string | undefined>;
}

/**
 * The Firecrawl Local Initialization component, covering both the existing
 * installation path (#22) and automatic installation of the certified
 * crates.io release (#23).
 *
 * Detection is filesystem-only and preserves whatever binary is found: init
 * never upgrades, downgrades, or reinstalls an existing installation.
 * Verification reuses `startFirecrawlRuntime` — a FreeWeb-MCP-owned loopback
 * process on an owned port with Cloud Off, local health only, and the bounded
 * shutdown discipline. A missing installation is installed only on macOS and
 * Debian/Ubuntu, only after Rust, Cargo, and a C compiler are confirmed
 * present, and only from the exact crates.io `firecrawl-local 0.1.0` release.
 * Init never installs toolchains, package managers, or browser binaries.
 */
export function createFirecrawlComponent(deps: FirecrawlComponentDeps = {}): InitComponent {
  const fs = deps.fs ?? nodeInitFilesystem;
  const runner = deps.commandRunner ?? nodeCommandRunner;
  const start = deps.startRuntime ?? startFirecrawlRuntime;
  const platform = deps.platform ?? process.platform;
  let detectedPlatform: FirecrawlPlatform = platform === "darwin"
    ? "macos"
    : platform === "win32"
      ? "windows"
      : "unsupported";
  let chromeNote = OPTIONAL_CHROME_UNCHECKED;

  const resolvePlatform = async (): Promise<FirecrawlPlatform> => {
    if (platform === "darwin") return "macos";
    if (platform === "win32") return "windows";
    if (platform !== "linux") return "unsupported";
    const release = deps.readOsRelease ? await deps.readOsRelease() : await defaultOsRelease(fs);
    return isDebianFamily(release) ? "debian" : "unsupported";
  };

  const detect = async (env: NodeJS.ProcessEnv, classification: ConfigClassification): Promise<InitDetection> => {
    detectedPlatform = await resolvePlatform();
    chromeNote = await detectChrome(env, fs, detectedPlatform);
    const envBinary = typeof env.FIRECRAWL_LOCAL_BIN === "string" && env.FIRECRAWL_LOCAL_BIN
      ? env.FIRECRAWL_LOCAL_BIN
      : undefined;
    const configured = classification.status === "ok" ? explicitConfiguredBinary(classification.raw) : undefined;

    // Detection contributes configuration declaratively. New/rebuilt files
    // and files with no explicit binary get a patch; an explicit stale path
    // gets an individually confirmed old → new repair instead.
    const contribute = (detection: InitDetection): InitDetection => {
      const configPatches = detection.installed && detection.binary && (classification.status !== "ok" || !configured)
        ? [{ setting: "firecrawl.binary", value: detection.binary }]
        : [];
      const repairs = classification.status === "ok" && detection.staleConfiguredPath && detection.installed && detection.binary
        ? [{
            component: "firecrawl",
            setting: "firecrawl.binary",
            oldValue: detection.staleConfiguredPath,
            newValue: detection.binary,
          }]
        : [];
      return {
        ...detection,
        ...(configPatches.length > 0 ? { configPatches } : {}),
        ...(repairs.length > 0 ? { repairs } : {}),
      };
    };

    // Detection is filesystem-only. Even a bounded --version probe launches
    // the provider, so it belongs to execute() after plan confirmation.
    // The runtime resolution order is env override, then configured value,
    // then the default name on PATH; detection mirrors it so the plan
    // verifies the binary the server would actually start.
    if (envBinary) {
      const resolved = await locateBinary(envBinary, env, fs);
      if (!resolved) {
        return contribute({ installed: false, certified: false, notes: [`FIRECRAWL_LOCAL_BIN does not resolve to an executable file: ${envBinary}`] });
      }
      const configuredPath = configured && !(await locateBinary(configured, env, fs)) ? configured : undefined;
      return contribute({
        installed: true,
        binary: resolved,
        source: "env",
        certified: false,
        ...(configuredPath ? { staleConfiguredPath: configuredPath } : {}),
      });
    }
    if (configured) {
      const resolved = await locateBinary(configured, env, fs);
      if (resolved) return contribute({ installed: true, binary: resolved, source: "config", certified: false });
      const onPath = await locateDefaultInstall(env, fs);
      if (onPath) return contribute({ installed: true, binary: onPath, source: "path", certified: false, staleConfiguredPath: configured });
      return contribute({ installed: false, certified: false, staleConfiguredPath: configured });
    }
    const onPath = await locateDefaultInstall(env, fs);
    return contribute(onPath
      ? { installed: true, binary: onPath, source: "path", certified: false }
      : { installed: false, certified: false });
  };

  const plan = (detection: InitDetection): readonly InitPlanItem[] => {
    if (detection.installed) {
      return [{
        component: "firecrawl" as const,
        action: "verify" as const,
        description: `verify the existing installation${detection.version ? ` (${detection.version})` : ""} with an owned loopback health check (Cloud Off); Chrome/Chromium is optional and is not required for readiness`,
        required: true,
        selected: true,
      }];
    }
    if (isAutomaticPlatform(detectedPlatform)) {
      return [{
        component: "firecrawl" as const,
        action: "install" as const,
        description: `install firecrawl-local ${CERTIFIED_FIRECRAWL_VERSION} from crates.io with \`cargo install firecrawl-local --version ${CERTIFIED_FIRECRAWL_VERSION}\` (version-pinned, never a source branch), then verify it with the same owned loopback Cloud Off health check; Rust, Cargo, and a C compiler must already be installed and are never installed by init; Chrome/Chromium is optional`,
        required: true,
        selected: true,
      }];
    }
    return [{
      component: "firecrawl" as const,
      action: "handoff" as const,
      description: `Firecrawl Local is not installed; automatic installation is not offered on ${platformLabel(detectedPlatform)}; report official manual installation guidance (${LOCAL_QUICKSTART}); Chrome/Chromium is optional`,
      required: true,
      selected: true,
    }];
  };

  const verify = async (input: InitVerifyInput): Promise<{ readonly ok: boolean; readonly message?: string }> => {
    const config: FirecrawlConfig = {
      binary: input.binary,
      host: "127.0.0.1",
      port: 0,
      allowPrivate: false,
      searchFallback: false,
      startupTimeoutMs: input.timeouts?.startupTimeoutMs ?? 30_000,
      shutdownTimeoutMs: input.timeouts?.shutdownTimeoutMs ?? 5_000,
    };
    let runtime: FirecrawlRuntime;
    try {
      runtime = await start(config);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    let result: { readonly ok: boolean; readonly message?: string };
    try {
      const health = await runtime.request("/health", { method: "GET" });
      result = isLocalHealth(health)
        ? { ok: true }
        : { ok: false, message: "the health endpoint did not report the local firecrawl-local engine" };
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    try {
      await runtime.close();
    } catch (error) {
      const cleanup = `owned process cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      return { ok: false, message: result.ok ? cleanup : `${result.message ?? "health check failed"}; ${cleanup}` };
    }
    return result;
  };

  const probeFirecrawlVersion = async (binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> => {
    const probe = await runner({
      command: binary,
      args: ["--version"],
      env: commandEnvironment(env),
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    }).catch(() => undefined);
    return probe && probe.exitCode === 0 && !probe.timedOut ? firstLine(probe.stdout + probe.stderr) : undefined;
  };

  const execute = async (input: InitExecuteInput): Promise<InitComponentResult> => {
    const base = { component: "firecrawl" as const, label: "Firecrawl Local", required: true, selected: true };
    const detection = input.detection;
    if (!detection.installed) {
      return await installMissing(input, base);
    }
    const binaryRepair = input.appliedRepairs.find((repair) => repair.setting === "firecrawl.binary");
    // A confirmed repair changes the effective configured path. Without one,
    // an env-selected detection still wins at runtime; otherwise a stale
    // configured path must be verified (and fail) rather than the PATH fallback.
    const binary = typeof binaryRepair?.newValue === "string"
      ? binaryRepair.newValue
      : detection.source === "env"
        ? detection.binary!
        : detection.staleConfiguredPath ?? detection.binary!;
    const version = await probeFirecrawlVersion(binary, input.env);
    const warnings: InitWarning[] = [];
    if (version && !isCertifiedVersion(version)) {
      warnings.push({
        code: "Uncertified",
        message: `Firecrawl Local reports '${version}', which is not the certified ${CERTIFIED_FIRECRAWL_VERSION} release; the existing installation was left untouched`,
      });
    }
    const verification = await verify({ binary, timeouts: input.timeouts });
    if (!verification.ok) {
      return {
        ...base,
        outcome: "Failed",
        warnings,
        detail: `health check failed: ${verification.message ?? "unknown error"}; ${chromeNote}`,
      };
    }
    return {
      ...base,
      outcome: "Installed",
      warnings,
      detail: `existing installation at ${binary} verified with an owned loopback health check (Cloud Off); ${chromeNote}`,
    };
  };

  /**
   * The only installation path. Every prerequisite is checked before cargo
   * runs, the command is version-pinned to the certified crates.io release,
   * and success requires both the certified version and the shared health
   * check. A failed or interrupted install never reports Installed.
   */
  const installMissing = async (
    input: InitExecuteInput,
    base: Omit<InitComponentResult, "outcome" | "warnings" | "detail">,
  ): Promise<InitComponentResult> => {
    const detection = input.detection;
    const notes = detection.notes && detection.notes.length > 0 ? ` ${detection.notes.join("; ")}.` : "";
    const currentPlatform = await resolvePlatform();
    if (!isAutomaticPlatform(currentPlatform)) {
      return {
        ...base,
        outcome: "Pending",
        warnings: [],
        detail: `${platformLabel(currentPlatform)} is supported for detection only; automation does not claim a verified automatic installation there. Install firecrawl-local ${CERTIFIED_FIRECRAWL_VERSION} manually per the official local quickstart (${LOCAL_QUICKSTART}), then rerun init.${notes} ${chromeNote}`,
      };
    }

    const missing = await missingPrerequisites(input.env, currentPlatform);
    if (missing.length > 0) {
      const guidance = [...new Set(missing.map((item) => item.guidance))].join("; ");
      return {
        ...base,
        outcome: "Pending",
        warnings: [],
        detail: `not installed; missing ${missing.map((item) => item.name).join(", ")}. ${guidance}. Initialization never installs system package managers, Rust, Cargo, compilers, Xcode command-line tools, or Chrome/Chromium.${notes} ${chromeNote} Official local quickstart: ${LOCAL_QUICKSTART}.`,
      };
    }

    let install: CommandResult | undefined;
    let installError: string | undefined;
    try {
      install = await runner({
        command: "cargo",
        args: [...FIRECRAWL_INSTALL_ARGS],
        env: commandEnvironment(input.env),
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
    } catch (error) {
      installError = error instanceof Error ? error.message : String(error);
    }
    if (!install || install.timedOut || install.exitCode !== 0) {
      return {
        ...base,
        outcome: "Failed",
        warnings: [],
        detail: `\`cargo install firecrawl-local --version ${CERTIFIED_FIRECRAWL_VERSION}\` did not complete: ${describeCommandFailure(install, installError)}. No installation was recorded; rerun init after resolving the cause. ${chromeNote}`,
      };
    }

    const binary = await resolveInstalledBinary(input.env, fs);
    if (!binary) {
      return {
        ...base,
        outcome: "Failed",
        warnings: [],
        detail: `cargo reported success but no executable firecrawl-local was found in the Cargo installation directory or on PATH; no installation was recorded. ${chromeNote}`,
      };
    }
    const version = await probeFirecrawlVersion(binary, input.env);
    if (!isCertifiedVersion(version)) {
      return {
        ...base,
        outcome: "Failed",
        warnings: [],
        detail: `cargo produced ${binary}${version ? ` reporting '${version}'` : " without a usable version string"}, not the certified ${CERTIFIED_FIRECRAWL_VERSION} release; the binary was left in place but is not treated as certified and no installation was recorded. ${chromeNote}`,
      };
    }

    const configPatches = [{ setting: "firecrawl.binary", value: binary }];
    const verification = await verify({ binary, timeouts: input.timeouts });
    if (!verification.ok) {
      return {
        ...base,
        outcome: "Failed",
        warnings: [],
        detail: `installed firecrawl-local ${CERTIFIED_FIRECRAWL_VERSION} at ${binary}, but the owned loopback Cloud Off health check failed: ${verification.message ?? "unknown error"}; the resolved binary path was recorded so a rerun verifies rather than reinstalls it. ${chromeNote}`,
        configPatches,
      };
    }
    return {
      ...base,
      outcome: "Installed",
      warnings: [],
      detail: `installed firecrawl-local ${CERTIFIED_FIRECRAWL_VERSION} from crates.io at ${binary} with \`cargo install firecrawl-local --version ${CERTIFIED_FIRECRAWL_VERSION}\` (no source branch), then verified it with an owned loopback Cloud Off health check; ${chromeNote}`,
      configPatches,
    };
  };

  const missingPrerequisites = async (
    env: NodeJS.ProcessEnv,
    currentPlatform: FirecrawlPlatform,
  ): Promise<readonly { readonly name: string; readonly guidance: string }[]> => {
    const commandEnv = commandEnvironment(env);
    const checks: ReadonlyArray<{ readonly name: string; readonly command: string; readonly guidance: string }> = [
      { name: "Rust (rustc)", command: "rustc", guidance: RUST_GUIDANCE },
      { name: "Cargo", command: "cargo", guidance: RUST_GUIDANCE },
      { name: "a C compiler (cc)", command: "cc", guidance: cCompilerGuidance(currentPlatform) },
    ];
    const missing: Array<{ readonly name: string; readonly guidance: string }> = [];
    for (const check of checks) {
      const result = await runner({
        command: check.command,
        args: ["--version"],
        env: commandEnv,
        timeoutMs: PREREQUISITE_PROBE_TIMEOUT_MS,
      }).catch(() => undefined);
      if (!result || result.timedOut || result.exitCode !== 0) {
        missing.push({ name: check.name, guidance: check.guidance });
      }
    }
    return missing;
  };

  return { id: "firecrawl", label: "Firecrawl Local", required: true, detect, plan, verify, execute };
}

const OPTIONAL_CHROME_UNCHECKED = "Chrome/Chromium is an optional enhancement for JavaScript rendering and screenshots; it is not required for readiness";

function isAutomaticPlatform(platform: FirecrawlPlatform): boolean {
  return platform === "macos" || platform === "debian";
}

function platformLabel(platform: FirecrawlPlatform): string {
  if (platform === "macos") return "macOS";
  if (platform === "debian") return "Debian/Ubuntu";
  if (platform === "windows") return "Windows";
  return "this platform";
}

function cCompilerGuidance(platform: FirecrawlPlatform): string {
  if (platform === "macos") return "install the Xcode command-line tools with `xcode-select --install`";
  if (platform === "debian") return "install build-essential on Debian/Ubuntu";
  return "install a C compiler";
}

/** Only explicit, non-secret command environment values are forwarded. */
function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overrides: Record<string, string> = {};
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "CARGO_HOME", "CARGO_INSTALL_ROOT", "RUSTUP_HOME", "CC", "CXX",
  ]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) overrides[key] = value;
  }
  return childProcessEnv(overrides);
}

async function defaultOsRelease(fs: Pick<InitFilesystem, "readFile">): Promise<string | undefined> {
  try {
    return await fs.readFile("/etc/os-release");
  } catch {
    return undefined;
  }
}

/** Accepts Debian, Ubuntu, and distributions that declare them in ID_LIKE. */
function isDebianFamily(release: string | undefined): boolean {
  if (!release) return false;
  const fields = new Map<string, string>();
  for (const line of release.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    fields.set(match[1]!, match[2]!.replace(/^["']|["']$/g, ""));
  }
  const families = [fields.get("ID") ?? "", ...(fields.get("ID_LIKE") ?? "").split(/\s+/)];
  return families.some((family) => family === "debian" || family === "ubuntu");
}

async function detectChrome(
  env: NodeJS.ProcessEnv,
  fs: Pick<InitFilesystem, "access" | "stat">,
  platform: FirecrawlPlatform,
): Promise<string> {
  const explicit = env.FIRECRAWL_CHROME_PATH;
  if (explicit) {
    const candidate = resolve(explicit);
    return (await isExecutableFile(candidate, fs))
      ? `Chrome/Chromium detected at ${candidate} (optional enhancement for JavaScript rendering and screenshots; never a readiness condition)`
      : `FIRECRAWL_CHROME_PATH does not resolve to an executable file: ${explicit} (Chrome/Chromium is an optional enhancement, never a readiness condition)`;
  }
  const candidates: string[] = [];
  if (platform === "macos") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
    if (env.HOME) {
      candidates.push(
        join(env.HOME, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        join(env.HOME, "Applications/Chromium.app/Contents/MacOS/Chromium"),
      );
    }
  } else if (platform === "windows") {
    for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        join(root, "Google", "Chrome", "Application", "chrome.exe"),
        join(root, "Chromium", "Application", "chrome.exe"),
      );
    }
  }
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate, fs)) {
      return `Chrome/Chromium detected at ${candidate} (optional enhancement for JavaScript rendering and screenshots; never a readiness condition)`;
    }
  }
  if (platform === "debian") {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      const found = await locateBinary(name, env, fs);
      if (found) {
        return `Chrome/Chromium detected at ${found} (optional enhancement for JavaScript rendering and screenshots; never a readiness condition)`;
      }
    }
  }
  const found = await locateBinary("chrome", env, fs);
  return found
    ? `Chrome/Chromium detected at ${found} (optional enhancement for JavaScript rendering and screenshots; never a readiness condition)`
    : "Chrome/Chromium was not found; it is an optional enhancement for JavaScript rendering and screenshots and is not required for readiness";
}

async function resolveInstalledBinary(
  env: NodeJS.ProcessEnv,
  fs: Pick<InitFilesystem, "access" | "stat">,
): Promise<string | undefined> {
  return await locateCargoInstalledBinary(env, fs) ?? await locateBinary(DEFAULT_BINARY_NAME, env, fs);
}

function describeCommandFailure(install: CommandResult | undefined, error: string | undefined): string {
  if (error) return error;
  if (!install) return "the command did not start";
  if (install.timedOut) return "the command timed out and was stopped";
  const output = lastLine(install.stderr) ?? lastLine(install.stdout);
  return `${install.exitCode === null ? "it was terminated" : `exit code ${install.exitCode}`}${output ? `: ${output}` : ""}`;
}

function lastLine(text: string): string | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

function explicitConfiguredBinary(raw: Record<string, unknown>): string | undefined {
  const firecrawl = raw.firecrawl;
  if (!isRecord(firecrawl)) return undefined;
  const binary = firecrawl.binary;
  return typeof binary === "string" && binary ? binary : undefined;
}

function firstLine(text: string): string | undefined {
  const line = text.trim().split("\n")[0]?.trim();
  return line ? line : undefined;
}

/** Only the exact 0.1.0 release is certified; lookalikes and prereleases are not. */
function isCertifiedVersion(version: string | undefined): boolean {
  if (!version) return false;
  const versions = version.match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g) ?? [];
  return versions.length === 1 && versions[0]!.replace(/^v/, "") === CERTIFIED_FIRECRAWL_VERSION;
}

async function locateDefaultInstall(
  env: NodeJS.ProcessEnv,
  fs: Pick<InitFilesystem, "access" | "stat">,
): Promise<string | undefined> {
  return await locateBinary(DEFAULT_BINARY_NAME, env, fs) ?? await locateCargoInstalledBinary(env, fs);
}

async function locateCargoInstalledBinary(
  env: NodeJS.ProcessEnv,
  fs: Pick<InitFilesystem, "access" | "stat">,
): Promise<string | undefined> {
  for (const root of [env.CARGO_INSTALL_ROOT, env.CARGO_HOME, env.HOME ? join(env.HOME, ".cargo") : undefined]) {
    if (!root) continue;
    const candidate = join(root, "bin", DEFAULT_BINARY_NAME);
    if (await isExecutableFile(candidate, fs)) return candidate;
  }
  return undefined;
}

/** Resolves a bare name on PATH, or a path-containing candidate as-is. */
async function locateBinary(
  name: string,
  env: NodeJS.ProcessEnv,
  fs: Pick<InitFilesystem, "access" | "stat">,
): Promise<string | undefined> {
  if (name.includes("/")) {
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
    const stats = await fs.stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

function isLocalHealth(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  return payload.status === "ok" && payload.engine === "firecrawl-local";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
