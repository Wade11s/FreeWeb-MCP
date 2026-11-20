import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cliPath = resolve("dist/cli.js");

let root: string;
let home: string;
let binDir: string;
let configPath: string;
const extraRoots: string[] = [];

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Builds a hermetic environment: a temporary HOME with its own configuration
 * and data directory, and no inherited FreeWeb-MCP settings. Provider
 * binaries are injected explicitly through the configuration file, so
 * nothing outside the temporary tree is discovered or started.
 */
function cliEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    FREEWEB_CONFIG: configPath,
    FREEWEB_DATA_DIR: join(home, "data"),
    FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "false",
    TINYFISH_API_KEY: "",
    ...overrides,
  };
}

function runCli(args: string[], overrides: Record<string, string> = {}, script = cliPath): CliResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: cliEnv(overrides),
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Writes a fake provider executable that prints a version and records its argv. */
async function fakeBinary(name: string, version: string, invocations?: string): Promise<string> {
  const path = join(binDir, name);
  const lines = ["#!/bin/sh"];
  if (invocations) lines.push(`printf '%s\\n' "$*" >> ${JSON.stringify(invocations)}`);
  if (version === "") lines.push("exit 3");
  else lines.push(`echo ${JSON.stringify(version)}`);
  await writeFile(path, `${lines.join("\n")}\n`);
  await chmod(path, 0o700);
  return path;
}

async function writeConfig(config: unknown): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
}

/** Configuration with fake provider binaries, so doctor never touches a real provider. */
async function writeReadyConfig(options: { firecrawlVersion?: string; egoVersion?: string } = {}): Promise<void> {
  const firecrawl = await fakeBinary("firecrawl-local", options.firecrawlVersion ?? "firecrawl-local 0.1.0");
  const ego = await fakeBinary("ego-browser", options.egoVersion ?? "ego-browser 1.2.3");
  await writeConfig({ firecrawl: { binary: firecrawl }, ego: { binary: ego } });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-doctor-cli-"));
  home = join(root, "home");
  binDir = join(root, "bin");
  configPath = join(home, ".config", "freeweb-mcp", "config.json");
  await mkdir(binDir, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  for (const extra of extraRoots.splice(0)) await rm(extra, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

/** A copy of the built CLI under a package.json with a different declared runtime floor. */
async function cliWithPackage(packageJson: unknown): Promise<string> {
  const packageRoot = await mkdtemp(join(tmpdir(), "freeweb-doctor-package-"));
  extraRoots.push(packageRoot);
  await cp(resolve("dist"), join(packageRoot, "dist"), { recursive: true });
  await symlink(resolve("node_modules"), join(packageRoot, "node_modules"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ type: "module", ...(packageJson as object) }));
  return join(packageRoot, "dist", "cli.js");
}

describe("doctor text output", () => {
  it("reports every check and the redacted configuration through the built CLI", async () => {
    const invocations = join(root, "invocations.txt");
    const firecrawl = await fakeBinary("firecrawl-local", "firecrawl-local 0.1.0", invocations);
    const ego = await fakeBinary("ego-browser", "ego-browser 1.2.3", invocations);
    await writeConfig({ firecrawl: { binary: firecrawl }, ego: { binary: ego } });

    const result = runCli(["doctor"], {
      TINYFISH_API_KEY: "qyznrt-mblk-vdw",
      FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "true",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.split("\n");
    expect(lines).toContain(`PASS node: ${process.version}`);
    expect(lines).toContain("PASS firecrawl-local: firecrawl-local 0.1.0");
    expect(lines).toContain("PASS ego-browser: ego-browser 1.2.3");
    expect(lines).toContain("PASS tinyfish: Enabled by explicit free-only account attestation; no wallet request was made");
    expect(lines).toContain(`PASS data-directory: ${join(home, "data")}`);
    expect(lines).toContain("Result: ok");
    expect(result.stdout).toContain("Configuration:");

    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf("Configuration:\n") + "Configuration:\n".length)) as {
      dataDir: string;
      tinyfish: { apiKey?: string };
    };
    expect(printed.dataDir).toBe(join(home, "data"));
    expect(printed.tinyfish.apiKey).toBe("[redacted]");
    expect(result.stdout).not.toContain("qyznrt-mblk-vdw");
    expect(result.stderr).not.toContain("qyznrt-mblk-vdw");

    // Only `--version` probes ran: doctor never started a provider.
    expect((await readFile(invocations, "utf8")).trim().split("\n").sort()).toEqual(["--version", "--version"]);
  });

  it("keeps optional warnings from failing an otherwise ready environment", async () => {
    const firecrawl = await fakeBinary("firecrawl-local", "firecrawl-local 9.9.9");
    const ego = await fakeBinary("ego-browser", "ego-browser 1.2.3");
    await writeConfig({ firecrawl: { binary: firecrawl }, ego: { binary: ego } });

    const result = runCli(["doctor"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("PASS firecrawl-local: firecrawl-local 9.9.9");
    expect(result.stdout).toContain("  warning: Only Firecrawl Local v0.1.0 is fully certified");
    expect(result.stdout).toContain("WARN tinyfish: Disabled: TINYFISH_API_KEY is not set");
    expect(result.stdout).toContain("Result: ok");
  });

  it("fails with exit code 1 when a required check fails", async () => {
    const firecrawl = await fakeBinary("firecrawl-local", "");
    const ego = await fakeBinary("ego-browser", "ego-browser 1.2.3");
    await writeConfig({ firecrawl: { binary: firecrawl }, ego: { binary: ego } });

    const text = runCli(["doctor"]);
    expect(text.status).toBe(1);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain(`FAIL firecrawl-local: Command failed: ${firecrawl} --version`);
    expect(text.stdout).toContain("Result: failed");

    const json = runCli(["doctor", "--json"]);
    expect(json.status).toBe(1);
    expect(json.stderr).toBe("");
    const report = JSON.parse(json.stdout) as { ok: boolean; checks: { name: string; ok: boolean; required: boolean }[] };
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "firecrawl-local")).toMatchObject({ ok: false, required: true });
  });
});

describe("doctor JSON output", () => {
  it("emits only the JSON report on stdout", async () => {
    await writeReadyConfig();

    const result = runCli(["doctor", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    expect(result.stdout).not.toContain("PASS");
    expect(result.stdout).not.toContain("Configuration:");
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { name: string; ok: boolean; required: boolean; version?: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name))
      .toEqual(["node", "firecrawl-local", "ego-browser", "tinyfish", "ego-platform", "data-directory"]);
    expect(report.checks[0]).toMatchObject({ ok: true, required: true, version: process.version });
    expect(report.checks.find((check) => check.name === "tinyfish")).toMatchObject({ ok: false, required: false });
  });

  it("keeps the report parseable when business configuration is invalid", async () => {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{ not valid json");

    const json = runCli(["doctor", "--json"]);
    expect(json.status).toBe(1);
    expect(json.stdout).not.toContain("PASS");
    expect(json.stdout).not.toContain("error:");
    const report = JSON.parse(json.stdout) as { ok: boolean; checks: { name: string; ok: boolean; required: boolean; message?: string }[] };
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ name: "configuration", ok: false, required: true });
    expect(report.checks[0]?.message).toContain(configPath);
    expect(json.stderr).toContain(configPath);

    const text = runCli(["doctor"]);
    expect(text.status).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain(configPath);
  });

  it("reports schema violations as a configuration failure", async () => {
    await writeConfig({ firecrawl: { port: 70000 } });

    const result = runCli(["doctor", "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: { name: string; message?: string }[] };
    expect(report.checks[0]?.name).toBe("configuration");
    expect(report.checks[0]?.message).toContain("firecrawl.port");
  });
});

describe("doctor runtime floor", () => {
  it("enforces the Node.js minimum declared by package.json", async () => {
    await writeReadyConfig();
    const strictCli = await cliWithPackage({ version: "0.1.0", engines: { node: ">=99.0.0" } });

    const text = runCli(["doctor"], {}, strictCli);
    expect(text.status).toBe(1);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("FAIL node: Node.js 99.0.0 or newer is required");
    expect(text.stdout).toContain("PASS firecrawl-local");
    expect(text.stdout).toContain("Result: failed");

    const json = runCli(["doctor", "--json"], {}, strictCli);
    expect(json.status).toBe(1);
    const report = JSON.parse(json.stdout) as { ok: boolean; checks: { name: string; ok: boolean; required: boolean; message?: string }[] };
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "node", ok: false, required: true });
    expect(report.checks[0]?.message).toContain("99.0.0");
  });
});

describe("doctor usage errors", () => {
  it("rejects unknown options and excess positional arguments", async () => {
    await writeReadyConfig();

    for (const args of [["doctor", "--nope"], ["doctor", "--json=1"], ["doctor", "extra"], ["doctor", "--json", "extra"]]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/unknown option|too many arguments/);
    }
  });
});
