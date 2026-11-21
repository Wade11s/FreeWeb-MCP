import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { formatVersion, isAtLeast, type Version } from "./package-metadata.js";
import { childProcessEnv } from "./providers/firecrawl-process.js";
import { isDohEndpoint } from "./security/url.js";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  version?: string;
  message?: string;
  warning?: string;
}

export interface DoctorReport {
  /** True when every required check passed; optional failures never fail the report. */
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * Inputs doctor receives from its host instead of reading from the process.
 * The runtime floor comes from package.json, so doctor enforces exactly the
 * version the package declares rather than a second hard-coded copy.
 */
export interface DoctorEnvironment {
  /** Minimum Node.js version the package declares in `engines.node`, parsed to major/minor/patch. */
  readonly minimumNodeVersion: Version;
  /** Running Node.js version; defaults to `process.versions.node`. */
  readonly nodeVersion?: string;
  /** Host platform; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

async function versionCheck(name: string, binary: string, required: boolean): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, ["--version"], { timeout: 5000, windowsHide: true, env: childProcessEnv({}) });
    const version = (stdout + stderr).trim().split("\n")[0];
    return { name, ok: true, required, version };
  } catch (error) {
    return { name, ok: false, required, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Checks local readiness without starting business providers: version checks
 * spawn provider binaries with `--version` only, and TinyFish readiness is
 * read from configuration, so no wallet or API request is ever made.
 */
export async function runDoctor(config: AppConfig, environment: DoctorEnvironment): Promise<DoctorReport> {
  const nodeVersion = environment.nodeVersion ?? process.versions.node;
  const platform = environment.platform ?? process.platform;
  const nodeOk = isAtLeast(nodeVersion, environment.minimumNodeVersion);
  const checks: DoctorCheck[] = [{
    name: "node",
    ok: nodeOk,
    required: true,
    version: nodeVersion.startsWith("v") ? nodeVersion : `v${nodeVersion}`,
    ...(nodeOk ? {} : { message: `Node.js ${formatVersion(environment.minimumNodeVersion)} or newer is required` }),
  }];
  const firecrawl = await versionCheck("firecrawl-local", config.firecrawl.binary, true);
  if (firecrawl.ok && firecrawl.version && !firecrawl.version.includes("0.1.0")) {
    firecrawl.warning = "Only Firecrawl Local v0.1.0 is fully certified; run contract tests for this version";
  }
  checks.push(firecrawl);
  checks.push(await versionCheck("ego-browser", config.ego.binary, false));
  checks.push({
    name: "tinyfish",
    ok: Boolean(config.tinyfish.apiKey && config.tinyfish.freeOnlyConfirmed),
    required: false,
    message: config.tinyfish.apiKey
      ? config.tinyfish.freeOnlyConfirmed
        ? "Enabled by explicit free-only account attestation; no wallet request was made"
        : "Disabled: set freeOnlyConfirmed only for an account with no wallet spending capability"
      : "Disabled: TINYFISH_API_KEY is not set",
  });
  const dohCount = config.network.trustedDnsServers.filter(isDohEndpoint).length;
  const plainDnsCount = config.network.trustedDnsServers.length - dohCount;
  const configuredKinds = [
    plainDnsCount > 0 ? `${plainDnsCount} plain public DNS server${plainDnsCount === 1 ? "" : "s"}` : "",
    dohCount > 0 ? `${dohCount} DoH endpoint${dohCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");
  checks.push({
    name: "trusted-dns",
    ok: true,
    required: false,
    message: configuredKinds
      ? `Configured: ${configuredKinds}; used only after an all-fake-ip system answer`
      : "Not configured (default): neither plain DNS nor DoH; all-fake-ip system answers remain unverified",
  });
  checks.push({
    name: "ego-platform",
    ok: platform !== "linux",
    required: false,
    version: platform,
    ...(platform === "linux" ? { message: "Managed Browse is supported only on macOS and Windows" } : {}),
  });
  try {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    checks.push({ name: "data-directory", ok: true, required: true, version: config.dataDir });
  } catch (error) {
    checks.push({ name: "data-directory", ok: false, required: true, version: config.dataDir, message: error instanceof Error ? error.message : String(error) });
  }
  return { ok: checks.every((check) => !check.required || check.ok), checks };
}
