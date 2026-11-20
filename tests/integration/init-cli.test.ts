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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-cli-"));
  binDir = join(root, "bin");
  configDir = join(root, "config");
  configPath = join(configDir, "config.json");
  homeDir = join(root, "home");
  await mkdir(binDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cliEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return {
    ...base,
    PATH: [binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: homeDir,
    FREEWEB_CONFIG: configPath,
    FREEWEB_DATA_DIR: join(root, "data"),
    TINYFISH_API_KEY: "",
    ...overrides,
  };
}

function runCli(args: string[], overrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", timeout: 20_000, env: cliEnv(overrides) });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function writeFakeFirecrawl(): Promise<void> {
  const binary = join(binDir, "firecrawl-local");
  const script = `#!/usr/bin/env node
import http from "node:http";
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(root, "firecrawl-invocations.log"))}, JSON.stringify(process.argv.slice(2)) + " cloud=" + (process.env.FIRECRAWL_CLOUD ?? "unset") + "\\n");
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
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
  await writeFile(binary, script, { mode: 0o755 });
  await chmod(binary, 0o755);
}

interface PtyResult {
  status: number | null;
  output: string;
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
 */
function runCliInPty(answers: readonly string[], overrides: Record<string, string> = {}): Promise<PtyResult> {
  const script = join(root, "drive.exp");
  const program = [
    "set timeout 60",
    "set answers [lindex $argv 0]",
    "set cmd [lrange $argv 1 end]",
    "spawn {*}$cmd",
    "set i 0",
    "expect {",
    "  -re {y/N} {",
    "    if {$i < [llength $answers]} { send -- \"[lindex $answers $i]\\r\" }",
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
        resolveRun({ status: code, output: output.replace(/\r/g, "") });
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
    expect((await readdir(root)).sort()).toEqual(["bin", "config"]);
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
    expect(result.output).toContain("FreeWeb-MCP initialization plan:");
    expect(result.output).toContain("Firecrawl Local: Installed");
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
    expect(second.output).toContain("TinyFish Search/Fetch: Configured");
    expect(second.output).toContain("no content changes were made");
    expect(second.output).not.toContain("Confirm the Free attestation:");
    expect(second.output).not.toContain(secret);
    expect(await readFile(configPath, "utf8")).toBe(content);
    expect(existsSync(cliLog)).toBe(false);
    await expectTreeToOmit(root, secret);
  });

  it("keeps TinyFish Pending until the manual environment step is completed", async () => {
    await writeFakeFirecrawl();
    const first = await runCliInPty(["y", "y", "y"]);
    expect(first.status).toBe(0);
    expect(first.output).toContain("TinyFish Search/Fetch: Pending");
    expect(first.output).toContain("TINYFISH_API_KEY is not set");
    expect(first.output).toContain("environment of the process that runs FreeWeb-MCP");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as { tinyfish: { freeOnlyConfirmed?: boolean } };
    expect(raw.tinyfish.freeOnlyConfirmed).toBe(true);

    const secret = "integration-tinyfish-added-later";
    const second = await runCliInPty(["y"], { TINYFISH_API_KEY: secret });
    expect(second.status).toBe(0);
    expect(second.output).toContain("TinyFish Search/Fetch: Configured");
    expect(second.output).not.toContain(secret);
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
