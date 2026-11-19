import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { childProcessEnv } from "./providers/firecrawl-process.js";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  version?: string;
  message?: string;
  warning?: string;
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

export async function runDoctor(config: AppConfig): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks: DoctorCheck[] = [{
    name: "node",
    ok: nodeMajor >= 22,
    required: true,
    version: process.version,
    ...(nodeMajor >= 22 ? {} : { message: "Node.js 22 or newer is required" }),
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
  checks.push({
    name: "ego-platform",
    ok: process.platform !== "linux",
    required: false,
    version: process.platform,
    ...(process.platform === "linux" ? { message: "Managed Browse is supported only on macOS and Windows" } : {}),
  });
  try {
    await mkdir(config.dataDir!, { recursive: true, mode: 0o700 });
    checks.push({ name: "data-directory", ok: true, required: true, version: config.dataDir! });
  } catch (error) {
    checks.push({ name: "data-directory", ok: false, required: true, version: config.dataDir!, message: error instanceof Error ? error.message : String(error) });
  }
  return { ok: checks.every((check) => !check.required || check.ok), checks };
}
