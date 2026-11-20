import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cliPath = resolve("dist/cli.js");
const expectBinary = "/usr/bin/expect";
const hasExpect = existsSync(expectBinary);

let root: string;
let binDir: string;
let configDir: string;
let configPath: string;
let homeDir: string;
let stubDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-cli-"));
  binDir = join(root, "bin");
  configDir = join(root, "config");
  configPath = join(configDir, "config.json");
  homeDir = join(root, "home");
  stubDir = join(root, "stubs");
  await mkdir(binDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(stubDir, { recursive: true });
  await writeStubOpeners();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cliEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: [stubDir, binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: homeDir,
    CARGO_HOME: join(root, "cargo-home"),
    FREEWEB_CONFIG: configPath,
    FREEWEB_DATA_DIR: join(root, "data"),
  };
  // A developer's provider/toolchain overrides must not change what detection resolves.
  for (const key of [
    "TINYFISH_API_KEY",
    "FIRECRAWL_LOCAL_BIN",
    "FIRECRAWL_CHROME_PATH",
    "CARGO_INSTALL_ROOT",
    "RUSTUP_HOME",
    "CC",
    "CXX",
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function runCli(args: string[], overrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", timeout: 20_000, env: cliEnv(overrides) });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Records opener calls instead of launching a real browser on any platform. */
async function writeStubOpeners(): Promise<void> {
  const log = join(stubDir, "open-invocations.log");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(1)) + "\\n");
`;
  for (const name of ["open", "explorer.exe"]) {
    await writeFile(join(stubDir, name), script, { mode: 0o755 });
    await chmod(join(stubDir, name), 0o755);
  }
}

function fakeFirecrawlScript(): string {
  return `#!/usr/bin/env node
import http from "node:http";
import { appendFileSync } from "node:fs";
const log = ${JSON.stringify(join(root, "firecrawl-invocations.log"))};
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + " cloud=" + (process.env.FIRECRAWL_CLOUD ?? "unset") + "\\n");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("firecrawl-local 0.1.0"); process.exit(0); }
if (args[0] !== "serve") process.exit(2);
const port = Number(args[args.indexOf("--port") + 1]);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", engine: "firecrawl-local", version: "0.1.0" }));
  } else { res.writeHead(404); res.end("{}"); }
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => {
  appendFileSync(log, "sigterm\\n");
  server.close(() => { appendFileSync(log, "serve-exit\\n"); process.exit(0); });
});
`;
}

async function writeFakeFirecrawl(): Promise<void> {
  const binary = join(binDir, "firecrawl-local");
  await writeFile(binary, fakeFirecrawlScript(), { mode: 0o755 });
  await chmod(binary, 0o755);
}

async function writeFakeTool(path: string, script: string): Promise<void> {
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
}

/**
 * Fake Rust, Cargo, and C compiler executables. They only answer --version
 * and the exact pinned install; the fake Cargo writes a fake Firecrawl binary
 * into the controlled CARGO_HOME instead of building anything.
 */
async function writeInstallTools(options: { installExitCode?: number; installOutput?: string } = {}): Promise<void> {
  const cargoLog = join(root, "cargo-invocations.log");
  const cargoScript = `#!/usr/bin/env node
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cargoLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("cargo 1.99.0"); process.exit(0); }
if (args[0] !== "install") process.exit(2);
if (JSON.stringify(args) !== JSON.stringify(["install", "firecrawl-local", "--version", "0.1.0"])) {
  console.log("unexpected install request");
  process.exit(3);
}
process.stdout.write(${JSON.stringify(options.installOutput ?? "Installed firecrawl-local 0.1.0\\n")});
if (${options.installExitCode ?? 0} !== 0) process.exit(${options.installExitCode ?? 0});
const cargoHome = process.env.CARGO_HOME || join(process.env.HOME, ".cargo");
const target = join(cargoHome, "bin", "firecrawl-local");
mkdirSync(join(cargoHome, "bin"), { recursive: true });
writeFileSync(target, ${JSON.stringify(fakeFirecrawlScript())}, { mode: 0o755 });
chmodSync(target, 0o755);
`;
  await writeFakeTool(join(binDir, "cargo"), cargoScript);
  await writeFakeTool(join(binDir, "rustc"), "#!/usr/bin/env node\nconsole.log('rustc 1.99.0');\n");
  await writeFakeTool(join(binDir, "cc"), "#!/usr/bin/env node\nconsole.log('cc (fake) 1.0.0');\n");
}

interface PtyResult {
  status: number | null;
  output: string;
  promptCount: number;
}

/** Searches file contents, not variable names, for an exact credential value. */
async function expectTreeToOmit(directory: string, secret: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await expectTreeToOmit(path, secret);
    } else if (entry.isFile()) {
      expect(await readFile(path, "utf8"), path).not.toContain(secret);
    }
  }
}

/**
 * Drives the built CLI behind a real pseudo-terminal using expect: answers
 * are sent only after each `[y/N]` prompt appears, and the child's exit
 * status propagates through expect's wait.
 *
 * Surplus prompts beyond the supplied answers receive `surplusAnswer` (a
 * decline by default) so a test that only cares about the required baseline
 * is not left hanging when an optional component starts asking questions.
 */
function runCliInPty(answers: readonly string[], overrides: Record<string, string> = {}, surplusAnswer = "n"): Promise<PtyResult> {
  const script = join(root, "drive.exp");
  const program = [
    "set timeout 60",
    "set answers [lindex $argv 0]",
    "set surplus [lindex $argv 1]",
    "set cmd [lrange $argv 2 end]",
    "spawn {*}$cmd",
    "set i 0",
    "expect {",
    "  -re {y/N} {",
    "    if {$i < [llength $answers]} { send -- \"[lindex $answers $i]\\r\" } else { send -- \"$surplus\\r\" }",
    "    incr i",
    "    exp_continue",
    "  }",
    "  eof {}",
    "  timeout { exit 3 }",
    "}",
    "catch wait result",
    "exit [lindex $result 3]",
    "",
  ].join("\n");
  return new Promise<PtyResult>((resolveRun, rejectRun) => {
    void writeFile(script, program).then(() => {
      const child = spawn(expectBinary, [
        script,
        answers.join(" "),
        surplusAnswer,
        process.execPath,
        cliPath,
        "init",
      ], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: cliEnv(overrides) });
      let output = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        rejectRun(new Error(`pty run timed out; output so far: ${output}`));
      }, 60_000);
      child.stdout?.on("data", (chunk) => { output += String(chunk); });
      child.stderr?.on("data", (chunk) => { output += String(chunk); });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectRun(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const normalizedOutput = output.replace(/\r/g, "");
        resolveRun({
          status: code,
          output: normalizedOutput,
          promptCount: (normalizedOutput.match(/\[y\/N\]/g) ?? []).length,
        });
      });
    }, rejectRun);
  });
}

describe("built CLI init surface", () => {
  it("lists init in global help", () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("init");
  });

  it("prints command help for init", () => {
    for (const args of [["init", "--help"], ["init", "-h"], ["help", "init"]]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: freeweb-mcp init");
      expect(result.stderr).toBe("");
    }
  });

  it("rejects unknown options and excess arguments for init", () => {
    for (const args of [["init", "--nope"], ["init", "--yes"], ["init", "--json"], ["init", "--config"], ["init", "extra"]]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toBe("");
    }
  });
});

describe("built CLI non-TTY init", () => {
  it("refuses to run without a terminal and performs no reads, writes, or launches", async () => {
    await writeFakeFirecrawl();
    const result = runCli(["init"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires a terminal");
    expect(result.stderr).toContain("no changes were made");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(root, "data"))).toBe(false);
    expect((await readdir(root)).sort()).toEqual(["bin", "config", "stubs"]);
    expect((await readdir(configDir)).length).toBe(0);
    // The fake provider was never invoked, not even for a version probe.
    expect((await readdir(binDir)).sort()).toEqual(["firecrawl-local"]);
  });
});

describe.skipIf(!hasExpect)("built CLI interactive init behind a pseudo-terminal", () => {
  it("confirms the plan, verifies, writes private configuration, and exits 0", async () => {
    await writeFakeFirecrawl();
    const result = await runCliInPty(["y", "n"]);
    expect(result.status).toBe(0);
    expect(result.promptCount).toBe(3);
    expect(result.output).toContain("FreeWeb-MCP initialization plan:");
    expect(result.output).toContain("Firecrawl Local: Installed");
    expect(result.output).toContain("Open the official ego-lite download page");
    expect(result.output).toContain("ego-lite: Skipped");
    expect(result.output).toContain("Configuration: Configured");
    expect(result.output).toContain("PASS node:");
    expect(result.output).toContain("print-config");
    expect(result.output).not.toContain("listening on stdio");

    const raw = JSON.parse(await readFile(configPath, "utf8")) as { firecrawl: { binary?: string } };
    expect(raw.firecrawl.binary).toBe(join(binDir, "firecrawl-local"));
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("stops without changes when the plan is declined", async () => {
    await writeFakeFirecrawl();
    const result = await runCliInPty(["n"]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("canceled before any changes were made");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(root, "firecrawl-invocations.log"))).toBe(false);
  });

  it("keeps a present TinyFish key Pending without attestation and exits 0 with a ready baseline", async () => {
    await writeFakeFirecrawl();
    const secret = "integration-tinyfish-key-no-attestation";
    const result = await runCliInPty(["y", "y", "n"], { TINYFISH_API_KEY: secret });

    expect(result.status).toBe(0);
    expect(result.output).toContain("TinyFish Search/Fetch: Pending");
    expect(result.output).toContain("explicit Free attestation was not confirmed");
    expect(result.output).not.toContain(secret);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as {
      tinyfish: { freeOnlyConfirmed?: boolean; apiKey?: string };
      firecrawl: { searchFallback?: boolean };
    };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(false);
    expect(raw.tinyfish.apiKey).toBeUndefined();
    expect(raw.firecrawl.searchFallback).toBe(false);
  });

  it("persists only the attestation, never invokes the TinyFish CLI, and is idempotent on rerun", async () => {
    await writeFakeFirecrawl();
    const secret = "integration-tinyfish-key-attested";
    const cliLog = join(root, "tinyfish-cli.log");
    await writeFile(join(binDir, "tinyfish"), `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(cliLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(99);\n`, { mode: 0o755 });

    const first = await runCliInPty(["y", "y", "y"], { TINYFISH_API_KEY: secret });
    expect(first.status).toBe(0);
    expect(first.promptCount).toBe(4);
    expect(first.output).toContain("TinyFish Search/Fetch: Configured");
    expect(first.output).toContain("This TinyFish API key belongs to an account with no wallet spending capability; free credits, a zero balance, disabled auto-reload, and installation success are not substitutes for this attestation.");
    expect(first.output).toContain("Successful Initialization does not prove TinyFish service or account readiness");
    expect(first.output).not.toContain(secret);
    expect(existsSync(cliLog)).toBe(false);

    const content = await readFile(configPath, "utf8");
    const raw = JSON.parse(content) as {
      tinyfish: { freeOnlyConfirmed?: boolean; apiKey?: string };
      firecrawl: { searchFallback?: boolean };
    };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(true);
    expect(raw.tinyfish.apiKey).toBeUndefined();
    expect(raw.firecrawl.searchFallback).toBe(false);
    expect(content).not.toContain(secret);

    const second = await runCliInPty(["y"], { TINYFISH_API_KEY: secret });
    expect(second.status).toBe(0);
    expect(second.promptCount).toBe(2);
    expect(second.output).toContain("TinyFish Search/Fetch: Configured");
    expect(second.output).toContain("no content changes were made");
    expect(second.output).not.toContain("Confirm the Free attestation:");
    expect(second.output).not.toContain(secret);
    expect(await readFile(configPath, "utf8")).toBe(content);
    expect(existsSync(cliLog)).toBe(false);
    await expectTreeToOmit(root, secret);
  });

  it("keeps the exact attestation intact when the key is a substring of it", async () => {
    await writeFakeFirecrawl();
    const result = await runCliInPty(["y", "y", "y"], { TINYFISH_API_KEY: "wallet" });
    const attestation = "This TinyFish API key belongs to an account with no wallet spending capability; free credits, a zero balance, disabled auto-reload, and installation success are not substitutes for this attestation.";

    expect(result.status).toBe(0);
    expect(result.output).toContain(`persist freeOnlyConfirmed only after confirming: "${attestation}"`);
    expect(result.output).toContain(`Confirm the Free attestation: ${attestation} [y/N]`);
    expect(result.output).not.toContain("no [redacted] spending capability");
    expect(result.output).toContain("TinyFish Search/Fetch: Configured");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as { tinyfish: { freeOnlyConfirmed?: boolean } };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(true);
  });

  it("keeps TinyFish Pending and unattested until the manual environment step is completed", async () => {
    await writeFakeFirecrawl();
    const first = await runCliInPty(["y", "y", "y"]);
    expect(first.status).toBe(0);
    expect(first.output).toContain("TinyFish Search/Fetch: Pending");
    expect(first.output).toContain("TINYFISH_API_KEY is not set");
    expect(first.output).toContain("environment of the process that runs FreeWeb-MCP");
    let raw = JSON.parse(await readFile(configPath, "utf8")) as { tinyfish: { freeOnlyConfirmed?: boolean } };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(false);

    const secret = "integration-tinyfish-added-later";
    const second = await runCliInPty(["y", "y", "y"], { TINYFISH_API_KEY: secret });
    expect(second.status).toBe(0);
    expect(second.output).toContain("TinyFish Search/Fetch: Configured");
    expect(second.output).not.toContain(secret);
    raw = JSON.parse(await readFile(configPath, "utf8")) as { tinyfish: { freeOnlyConfirmed?: boolean } };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(true);
  });

  it("persists an environment-only attestation only after the explicit prompt", async () => {
    await writeFakeFirecrawl();
    const result = await runCliInPty(["y", "y", "y"], {
      TINYFISH_API_KEY: "integration-env-only-attestation",
      FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "true",
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("Confirm the Free attestation:");
    expect(result.output).toContain("TinyFish Search/Fetch: Configured");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as { tinyfish: { freeOnlyConfirmed?: boolean } };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(true);
  });

  it("uses the same whitespace-only key presence as doctor and runtime", async () => {
    await writeFakeFirecrawl();
    const result = await runCliInPty(["y", "y", "y"], { TINYFISH_API_KEY: "   " });

    expect(result.status).toBe(0);
    expect(result.output).toContain("TinyFish Search/Fetch: Configured");
    expect(result.output).toContain("PASS tinyfish: Enabled");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as { tinyfish: { freeOnlyConfirmed?: boolean } };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(true);
  });

  it("allows optional TinyFish setup to be skipped without blocking the required baseline", async () => {
    await writeFakeFirecrawl();
    const secret = "integration-tinyfish-skipped";
    const result = await runCliInPty(["y", "n"], { TINYFISH_API_KEY: secret });
    expect(result.status).toBe(0);
    expect(result.output).toContain("TinyFish Search/Fetch: Skipped");
    expect(result.output).toContain("Firecrawl Local: Installed");
    expect(result.output).toContain("Configuration: Configured");
    expect(result.output).not.toContain(secret);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as {
      tinyfish: { freeOnlyConfirmed?: boolean };
      firecrawl: { searchFallback?: boolean };
    };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(false);
    expect(raw.firecrawl.searchFallback).toBe(false);
  });

  it("keeps the exact key out of output, config, backup, profiles, client files, and logs", async () => {
    await writeFakeFirecrawl();
    const secret = "integration-tinyfish-exact-secret-canary";
    await mkdir(homeDir, { recursive: true });
    const untouched = new Map([
      [join(homeDir, ".bashrc"), "export EXISTING_SETTING=unchanged\n"],
      [join(homeDir, ".zshrc"), "# existing profile\n"],
      [join(homeDir, ".claude.json"), JSON.stringify({ mcpServers: { existing: { command: "keep" } } })],
    ]);
    for (const [path, content] of untouched) await writeFile(path, content);
    await writeFile(configPath, "{ damaged without credentials");

    const result = await runCliInPty(["y", "y", "y"], { TINYFISH_API_KEY: secret });
    expect(result.status).toBe(0);
    expect(result.output).toContain("TinyFish Search/Fetch: Configured");
    expect(result.output).not.toContain(secret);
    expect(await readFile(join(configDir, "config.backup.json"), "utf8")).toBe("{ damaged without credentials");
    for (const [path, content] of untouched) expect(await readFile(path, "utf8")).toBe(content);

    // This includes stdout/stderr captured above, plan/summary/warnings in
    // those streams, the new config and backup, fake-provider logs, HOME
    // profiles, MCP client definitions, and every other file under temp HOME.
    await expectTreeToOmit(root, secret);
  });

  it("recovers a malformed configuration after explicit backup-and-rebuild consent", async () => {
    await writeFakeFirecrawl();
    await writeFile(configPath, "{ not valid json");
    const result = await runCliInPty(["y", "n"]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("never treated as absent");
    expect(await readFile(join(configDir, "config.backup.json"), "utf8")).toBe("{ not valid json");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(raw.firecrawl).toBeDefined();
  });
});

describe.skipIf(!hasExpect)("built CLI automatic Firecrawl installation behind a pseudo-terminal", () => {
  it("installs the exact crates.io 0.1.0 release, verifies with an owned Cloud Off process, and cleans it up", async () => {
    await writeInstallTools();
    const result = await runCliInPty(["y"]);
    expect(result.status).toBe(0);
    expect(result.promptCount).toBe(3);
    expect(result.output).toContain("install firecrawl-local 0.1.0 from crates.io");
    expect(result.output).toContain("cargo install firecrawl-local --version 0.1.0");
    expect(result.output).toContain("Firecrawl Local: Installed");
    expect(result.output).toContain("Configuration: Configured");
    expect(result.output).toContain("Chrome/Chromium");

    const binary = join(root, "cargo-home", "bin", "firecrawl-local");
    expect(existsSync(binary)).toBe(true);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as { firecrawl: { binary?: string } };
    expect(raw.firecrawl.binary).toBe(binary);

    const cargoCalls = (await readFile(join(root, "cargo-invocations.log"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    expect(cargoCalls.filter((args) => args[0] === "install")).toEqual([
      ["install", "firecrawl-local", "--version", "0.1.0"],
    ]);
    expect(cargoCalls.some((args) => args.includes("clone") || args.includes("git"))).toBe(false);

    const lines = (await readFile(join(root, "firecrawl-invocations.log"), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toContainEqual('["--version"] cloud=unset');
    const serveLine = lines.find((line) => line.includes('"serve"'));
    expect(serveLine).toBeDefined();
    expect(serveLine!).toContain("cloud=off");
    expect(lines).toContain("sigterm");
    expect(lines.filter((line) => line === "serve-exit")).toHaveLength(1);
    for (const line of lines.filter((entry) => entry.startsWith("["))) {
      const args = JSON.parse(line.slice(0, line.indexOf("]") + 1)) as string[];
      expect(["--version", "serve"]).toContain(args[0]);
    }
  });

  it("reports a failed Cargo installation as Failed without recording a binary", async () => {
    await writeInstallTools({ installExitCode: 1, installOutput: "Compiling firecrawl-local…\n" });
    const result = await runCliInPty(["y"]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Firecrawl Local: Failed");
    expect(result.output).toContain("did not complete");
    expect(result.output).toContain("exit code 1");
    expect(existsSync(join(root, "cargo-home", "bin", "firecrawl-local"))).toBe(false);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as { firecrawl: { binary?: string } };
    expect(raw.firecrawl.binary).toBe("firecrawl-local");
  });

  it("is idempotent on rerun and never reinstalls an existing valid 0.1.0", async () => {
    await writeInstallTools();
    expect((await runCliInPty(["y"])).status).toBe(0);
    const second = await runCliInPty(["y"]);
    expect(second.status).toBe(0);
    expect(second.output).toContain("verify the existing installation");
    expect(second.output).toContain("existing installation at");
    const installCalls = (await readFile(join(root, "cargo-invocations.log"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args[0] === "install");
    expect(installCalls).toHaveLength(1);
  });
});
