import { constants as fsConstants } from "node:fs";
import { delimiter as pathDelimiter, resolve } from "node:path";
import {
  childProcessEnv,
  nodeCommandRunner,
  startFirecrawlRuntime,
  type CommandRunner,
  type FirecrawlConfig,
  type FirecrawlRuntime,
} from "../../providers/firecrawl-process.js";
import type { InitComponent, InitDetection, InitExecuteInput, InitVerifyInput } from "../component.js";
import { nodeInitFilesystem, type ConfigClassification, type InitFilesystem } from "../config-store.js";
import type { InitComponentResult, InitWarning } from "../outcomes.js";
import type { InitPlanItem } from "../plan.js";

export const CERTIFIED_FIRECRAWL_VERSION = "0.1.0";
const DEFAULT_BINARY_NAME = "firecrawl-local";
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const LOCAL_QUICKSTART = "https://docs.firecrawl.dev/quickstarts/firecrawl-local";

export interface FirecrawlComponentDeps {
  readonly fs?: Pick<InitFilesystem, "access" | "stat">;
  readonly commandRunner?: CommandRunner;
  readonly startRuntime?: typeof startFirecrawlRuntime;
}

/**
 * The Firecrawl Local Initialization component. #22 covers the
 * existing-installation path only: detection preserves whatever binary is
 * found (never upgrading, downgrading, or reinstalling), and verification
 * reuses `startFirecrawlRuntime` — a FreeWeb-MCP-owned loopback process on
 * an owned port with Cloud Off, local health only, and the bounded shutdown
 * discipline. The installation path (#23) extends `plan`/`execute` behind
 * this same interface.
 */
export function createFirecrawlComponent(deps: FirecrawlComponentDeps = {}): InitComponent {
  const fs = deps.fs ?? nodeInitFilesystem;
  const runner = deps.commandRunner ?? nodeCommandRunner;
  const start = deps.startRuntime ?? startFirecrawlRuntime;

  const detect = async (env: NodeJS.ProcessEnv, classification: ConfigClassification): Promise<InitDetection> => {
    const envBinary = typeof env.FIRECRAWL_LOCAL_BIN === "string" && env.FIRECRAWL_LOCAL_BIN
      ? env.FIRECRAWL_LOCAL_BIN
      : undefined;
    const configured = classification.status === "ok" ? explicitConfiguredBinary(classification.raw) : undefined;

    // Detection is filesystem-only. Even a bounded --version probe launches
    // the provider, so it belongs to execute() after plan confirmation.
    // The runtime resolution order is env override, then configured value,
    // then the default name on PATH; detection mirrors it so the plan
    // verifies the binary the server would actually start.
    if (envBinary) {
      const resolved = await locateBinary(envBinary, env, fs);
      if (!resolved) {
        return { installed: false, certified: false, notes: [`FIRECRAWL_LOCAL_BIN does not resolve to an executable file: ${envBinary}`] };
      }
      const configuredPath = configured && !(await locateBinary(configured, env, fs)) ? configured : undefined;
      return {
        installed: true,
        binary: resolved,
        source: "env",
        certified: false,
        ...(configuredPath ? { staleConfiguredPath: configuredPath } : {}),
      };
    }
    if (configured) {
      const resolved = await locateBinary(configured, env, fs);
      if (resolved) return { installed: true, binary: resolved, source: "config", certified: false };
      const onPath = await locateBinary(DEFAULT_BINARY_NAME, env, fs);
      if (onPath) return { installed: true, binary: onPath, source: "path", certified: false, staleConfiguredPath: configured };
      return { installed: false, certified: false, staleConfiguredPath: configured };
    }
    const onPath = await locateBinary(DEFAULT_BINARY_NAME, env, fs);
    return onPath
      ? { installed: true, binary: onPath, source: "path", certified: false }
      : { installed: false, certified: false };
  };

  const plan = (detection: InitDetection): readonly InitPlanItem[] =>
    detection.installed
      ? [{
          component: "firecrawl" as const,
          action: "verify" as const,
          description: `verify the existing installation${detection.version ? ` (${detection.version})` : ""} with an owned loopback health check (Cloud Off)`,
          required: true,
          selected: true,
        }]
      : [{
          component: "firecrawl" as const,
          action: "handoff" as const,
          description: "Firecrawl Local is not installed; report official manual installation guidance (automated installation arrives in a later release)",
          required: true,
          selected: true,
        }];

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

  const execute = async (input: InitExecuteInput): Promise<InitComponentResult> => {
    const base = { component: "firecrawl" as const, label: "Firecrawl Local", required: true, selected: true };
    const detection = input.detection;
    if (!detection.installed) {
      const notes = detection.notes && detection.notes.length > 0 ? ` ${detection.notes.join("; ")}` : "";
      return {
        ...base,
        outcome: "Pending",
        warnings: [],
        detail: `not installed; install it manually per the official local quickstart (${LOCAL_QUICKSTART}), then rerun init. Automated installation arrives in a later release.${notes}`,
      };
    }
    const binary = input.binary ?? detection.binary!;
    const probe = await runner({
      command: binary,
      args: ["--version"],
      env: childProcessEnv({}),
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    }).catch(() => undefined);
    const version = probe && probe.exitCode === 0 && !probe.timedOut ? firstLine(probe.stdout + probe.stderr) : undefined;
    const warnings: InitWarning[] = [];
    if (!isCertifiedVersion(version)) {
      warnings.push({
        code: "Uncertified",
        message: version
          ? `Firecrawl Local reports '${version}', which is not the certified ${CERTIFIED_FIRECRAWL_VERSION} release; the existing installation was left untouched`
          : "the Firecrawl Local version could not be determined; the existing installation was left untouched and is not certified",
      });
    }
    const verification = await verify({ binary, timeouts: input.timeouts });
    if (!verification.ok) {
      return {
        ...base,
        outcome: "Failed",
        warnings,
        detail: `health check failed: ${verification.message ?? "unknown error"}`,
      };
    }
    return {
      ...base,
      outcome: "Installed",
      warnings,
      detail: `existing installation at ${binary} verified with an owned loopback health check (Cloud Off)`,
    };
  };

  return { id: "firecrawl", label: "Firecrawl Local", required: true, detect, plan, verify, execute };
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
