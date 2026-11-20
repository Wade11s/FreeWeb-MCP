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
  return {
    ...base,
    PATH: [stubDir, binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
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

/**
 * Drives the built CLI behind a real pseudo-terminal using expect: answers
 * are sent only after each `[y/N]` prompt appears, and the child's exit
 * status propagates through expect's wait.
 */
function runCliInPty(answers: readonly string[]): Promise<PtyResult> {
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
      ], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: cliEnv() });
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
    expect(result.output).toContain("FreeWeb-MCP initialization plan:");
    expect(result.output).toContain("Firecrawl Local: Installed");
    expect(result.output).toContain("ego-lite: Pending");
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
