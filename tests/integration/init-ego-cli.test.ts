import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EGO_DOWNLOAD_URL,
  EGO_INSTALL_REFERENCE_URL,
  EGO_NATIVE_MARKER,
} from "../../src/init/components/ego.js";
import { defaultConfigFile } from "../../src/init/config-store.js";

const cliPath = resolve("dist/cli.js");
const PLATFORM_SIMULATION = { FREEWEB_INIT_TEST_MODE: "1" };
const expectBinary = "/usr/bin/expect";
const hasExpect = existsSync(expectBinary);

let root: string;
let binDir: string;
let stubDir: string;
let configDir: string;
let configPath: string;
let homeDir: string;
let openerLog: string;
let egoLog: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-ego-cli-"));
  binDir = join(root, "bin");
  stubDir = join(root, "stubs");
  configDir = join(root, "config");
  configPath = join(configDir, "config.json");
  homeDir = join(root, "home");
  openerLog = join(stubDir, "opener.log");
  egoLog = join(root, "ego-invocations.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(stubDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cliEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [stubDir, binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: homeDir,
    FREEWEB_CONFIG: configPath,
    FREEWEB_DATA_DIR: join(root, "data"),
    TINYFISH_API_KEY: "unit-ego-secret-do-not-leak",
    ...overrides,
  };
}

async function writeFakeFirecrawl(): Promise<void> {
  const binary = join(binDir, "firecrawl-local");
  const script = `#!/usr/bin/env node
import http from "node:http";
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

function egoScriptText(options: { failNative?: boolean } = {}): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(egoLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("ego-browser 1.2.3"); process.exit(0); }
if (args[0] === "nodejs" && args[1] === "-e") {
  // Real ego-browser writes the embedded script output to stderr.
  ${options.failNative ? "process.exit(2);" : `console.error(${JSON.stringify(EGO_NATIVE_MARKER)}); process.exit(0);`}
}
process.exit(2);
`;
}

async function writeFakeEgo(options: { failNative?: boolean } = {}, name = "ego-browser"): Promise<string> {
  const binary = join(binDir, name);
  await writeFile(binary, egoScriptText(options), { mode: 0o755 });
  await chmod(binary, 0o755);
  return binary;
}

/**
 * The only "installer" side effect in these tests: a fake opener records the
 * exact URL and may materialize a fake ego-browser to simulate a completed
 * GUI handoff. No real browser, installer, or GUI is ever launched.
 */
async function writeOpeners(options: { installEgo?: boolean } = {}): Promise<void> {
  const embeddedEgoScript = options.installEgo ? JSON.stringify(egoScriptText()) : "undefined";
  const script = `#!/usr/bin/env node
import { appendFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
const name = process.argv[2];
appendFileSync(${JSON.stringify(openerLog)}, name + "|" + JSON.stringify(process.argv.slice(3)) + "\\n");
const embedded = ${embeddedEgoScript};
if (embedded !== undefined) {
  const target = ${JSON.stringify(join(binDir, "ego-browser"))};
  if (!existsSync(target)) {
    writeFileSync(target, embedded);
    chmodSync(target, 0o755);
  }
}
`;
  const scriptPath = join(stubDir, "opener.js");
  await writeFile(scriptPath, script, { mode: 0o644 });
  // On POSIX a .exe extension cannot carry a Node shebang, so the simulated
  // Windows opener is a shell trampoline with a fixed, injected name+URL.
  for (const name of ["open", "explorer.exe"]) {
    const path = join(stubDir, name);
    const wrapper = `#!/bin/sh
exec node ${JSON.stringify(scriptPath)} ${JSON.stringify(name)} "$@"\n`;
    await writeFile(path, wrapper, { mode: 0o755 });
    await chmod(path, 0o755);
  }
}

interface PtyResult {
  status: number | null;
  output: string;
  promptCount: number;
}

/**
 * Drives the built CLI behind a real pseudo-terminal. Answers are sent after
 * each numbered `Choose [1-N]` prompt; surplus prompts beyond the supplied
 * list receive `surplusAnswer` so optional components cannot leave a test
 * hanging.
 */
function runCliInPty(
  answers: readonly string[],
  overrides: Record<string, string> = {},
  surplusAnswer = "n",
  tinyFishAnswer = "n",
): Promise<PtyResult> {
  const script = join(root, "drive.exp");
  const program = [
    "set timeout 60",
    "set answers [lindex $argv 0]",
    "set tinyfish [lindex $argv 1]",
    "set surplus [lindex $argv 2]",
    "set cmd [lrange $argv 3 end]",
    "spawn {*}$cmd",
    "set i 0",
    "expect {",
    // TinyFish's component-selection menu is answered separately so an ego
    // test's answer list stays focused on Firecrawl and ego decisions.
    "  -re {What do you want to do with TinyFish(.|\\n)*Choose \\[} {",
    "    send -- \"$tinyfish\\r\"",
    "    exp_continue",
    "  }",
    "  -re {(Apply the selected settings|Run local Doctor)(.|\\n)*Choose \\[} {",
    "    send -- \"1\\r\"",
    "    exp_continue",
    "  }",
    "  -re {This step failed(.|\\n)*Choose \\[} {",
    "    send -- \"2\\r\"",
    "    exp_continue",
    "  }",
    "  -re {Choose \\[} {",
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
      const child = spawn(expectBinary, [script, answers.join(" "), tinyFishAnswer, surplusAnswer, process.execPath, cliPath, "init"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        env: cliEnv(overrides),
      });
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
          promptCount: (normalizedOutput.match(/Choose \[/g) ?? []).length,
        });
      });
    }, rejectRun);
  });
}

async function readLog(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
}

async function writeCompleteConfig(egoBinary: string): Promise<void> {
  const config = defaultConfigFile();
  await writeFile(configPath, JSON.stringify({ ...config, ego: { ...config.ego, binary: egoBinary } }));
}

describe.skipIf(!hasExpect)("built CLI all-component initialization baselines", () => {
  it("accepts every default-selected optional component and reruns without duplicate installation side effects", async () => {
    await writeFakeFirecrawl();
    await writeOpeners({ installEgo: true });

    const first = await runCliInPty(["y", "y", "y", "y", "y"], {}, "n", "y");

    expect(first.status).toBe(0);
    expect(first.promptCount).toBe(8);
    expect(first.output).toContain("Firecrawl Local: Installed");
    expect(first.output).toContain("TinyFish Search/Fetch: Configured");
    expect(first.output).toContain("ego-lite: Installed");
    expect(first.output).toContain("Configuration: Configured");
    expect(first.output).toContain("Result: Initialization command succeeded");
    expect(first.output).toContain("does not mean every optional capability is ready");
    expect(first.output).toContain("freeweb-mcp print-config");
    expect(await readLog(openerLog)).toEqual([`open|["${EGO_DOWNLOAD_URL}"]`]);
    expect(((await readConfig()).tinyfish as Record<string, unknown>).freeOnlyConfirmed).toBe(true);
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe(join(binDir, "ego-browser"));

    const content = await readFile(configPath, "utf8");
    const second = await runCliInPty(["y", "y", "y"], {}, "n", "y");
    expect(second.status).toBe(0);
    expect(second.promptCount).toBe(6);
    expect(second.output).toContain("no content changes were made");
    expect(second.output).not.toContain("Open the official ego-lite download page");
    expect(await readFile(configPath, "utf8")).toBe(content);
    expect(await readLog(openerLog)).toEqual([`open|["${EGO_DOWNLOAD_URL}"]`]);
  });

  it("declines every optional component while retaining a successful required baseline", async () => {
    await writeFakeFirecrawl();
    await writeOpeners({ installEgo: true });

    const result = await runCliInPty(["y", "n"]);

    expect(result.status).toBe(0);
    expect(result.promptCount).toBe(5);
    expect(result.output).toContain("Firecrawl Local: Installed");
    expect(result.output).toContain("TinyFish Search/Fetch: Skipped");
    expect(result.output).toContain("ego-lite: Skipped");
    expect(result.output).toContain("Configuration: Configured");
    expect(result.output).toContain("Result: Initialization command succeeded");
    expect(result.output).toContain("does not mean every optional capability is ready");
    expect(await readLog(openerLog)).toEqual([]);
    expect(await readLog(egoLog)).toEqual([]);
    const config = await readConfig();
    expect((config.tinyfish as Record<string, unknown>).freeOnlyConfirmed).toBe(false);
    expect((config.firecrawl as Record<string, unknown>).searchFallback).toBe(false);
    expect((config.ego as Record<string, unknown>).binary).toBe("ego-browser");
  });
});

describe.skipIf(!hasExpect)("built CLI ego-lite handoff (platforms simulated with fake openers)", () => {
  it("opens the official page after selecting this step, verifies only after onboarding consent, and records the path", async () => {
    await writeFakeFirecrawl();
    await writeOpeners({ installEgo: true });

    const result = await runCliInPty(["y", "y", "y", "y"]);

    expect(result.status).toBe(0);
    expect(result.promptCount).toBe(7);
    expect(result.output).toContain(`after selecting this step, ask before opening the official ego-lite download page (${EGO_DOWNLOAD_URL})`);
    expect(result.output).toContain("Open the official ego-lite download page");
    expect(result.output).toContain("Opened the official ego-lite download page");
    expect(result.output).toContain("ego-lite: Installed");
    expect(result.output).toContain("after your onboarding confirmation");
    expect(result.output).not.toContain("unit-ego-secret-do-not-leak");
    expect(await readLog(openerLog)).toEqual([`open|["${EGO_DOWNLOAD_URL}"]`]);
    const calls = await readLog(egoLog);
    expect(calls).toContain('["--version"]');
    expect(calls.some((line) => line.includes('"nodejs","-e"'))).toBe(true);
    expect(calls.every((line) => !/xattr|sudo|curl|upgrade|import/i.test(line))).toBe(true);
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe(join(binDir, "ego-browser"));
  });

  it("simulates Windows with explorer.exe and never invokes the macOS opener", async () => {
    await writeFakeFirecrawl();
    await writeOpeners({ installEgo: true });

    const result = await runCliInPty(["y", "y", "y", "y"], { ...PLATFORM_SIMULATION, FREEWEB_INIT_PLATFORM: "win32" });

    expect(result.status).toBe(0);
    expect(result.promptCount).toBe(7);
    expect(result.output).toContain("on win32");
    expect(await readLog(openerLog)).toEqual([`explorer.exe|["${EGO_DOWNLOAD_URL}"]`]);
    expect((await readLog(openerLog)).some((line) => line.startsWith("open|"))).toBe(false);
  });

  it("skips an unsupported platform without opening an installer or verifying", async () => {
    await writeFakeFirecrawl();
    await writeOpeners({ installEgo: true });

    const result = await runCliInPty(["y", "y"], { ...PLATFORM_SIMULATION, FREEWEB_INIT_PLATFORM: "linux" });

    expect(result.status).toBe(0);
    expect(result.output).toContain("ego-lite: Skipped");
    expect(result.output).toContain("unsupported platform linux");
    expect(result.output).toContain(EGO_INSTALL_REFERENCE_URL);
    expect(await readLog(openerLog)).toEqual([]);
    expect(await readLog(egoLog)).toEqual([]);
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe("ego-browser");
  });

  it("leaves ego Pending when onboarding is declined while the required baseline still succeeds", async () => {
    await writeFakeFirecrawl();
    await writeOpeners();

    const result = await runCliInPty(["y", "y", "y", "n"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("ego-lite: Pending");
    expect(result.output).toContain("no command or native-entry verification");
    expect(result.output).toContain("was opened during this step");
    expect(await readLog(openerLog)).toEqual([`open|["${EGO_DOWNLOAD_URL}"]`]);
    expect(await readLog(egoLog)).toEqual([]);
  });

  it("skips ego with no opener when its handoff consent is declined", async () => {
    await writeFakeFirecrawl();
    await writeOpeners();

    const result = await runCliInPty(["y", "y", "n"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("Open the official ego-lite download page");
    expect(result.output).toContain("ego-lite: Skipped");
    expect(result.output).toContain("no browser was opened");
    expect(await readLog(openerLog)).toEqual([]);
    expect(await readLog(egoLog)).toEqual([]);
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe("ego-browser");
  });

  it("opens nothing and writes nothing when the plan is declined", async () => {
    await writeFakeFirecrawl();
    await writeOpeners({ installEgo: true });

    const result = await runCliInPty(["n"]);

    expect(result.status).toBe(1);
    expect(result.output).toContain("canceled before any changes were made");
    expect(await readLog(openerLog)).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
  });

  it("applies a stale ego path repair only after its own confirmation", async () => {
    const binary = await writeFakeEgo();
    await writeFakeFirecrawl();
    await writeOpeners();
    await writeFile(configPath, JSON.stringify({ ego: { binary: "/gone/ego-browser" } }));

    const result = await runCliInPty(["y", "y", "y", "y"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain(`ego.binary: /gone/ego-browser -> ${binary}`);
    expect(result.output).toContain(`Repair ego.binary: /gone/ego-browser -> ${binary}`);
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe(binary);
    expect(await readLog(openerLog)).toEqual([]);
  });

  it("returns 1 when a selected native verification fails", async () => {
    await writeFakeFirecrawl();
    await writeFakeEgo({ failNative: true });
    await writeOpeners();

    const result = await runCliInPty(["y", "y", "y"]);

    expect(result.status).toBe(1);
    expect(result.output).toContain("ego-lite: Failed");
    expect(result.output).toContain("Firecrawl Local: Installed");
    expect(result.output).toContain("Initialization command did not complete successfully");
  });

  it("prompts before replacing an explicit configured command name", async () => {
    const binary = await writeFakeEgo();
    await writeFakeFirecrawl();
    await writeCompleteConfig("ego-browser");

    const result = await runCliInPty(["y", "y", "y", "y"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain(`ego.binary: ego-browser -> ${binary}`);
    expect(result.output).toContain(`Repair ego.binary: ego-browser -> ${binary}`);
    expect(result.output).not.toContain("no content changes will be made");
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe(binary);
  });

  it("prompts before an EGO_BROWSER_BIN override replaces a different valid configured path", async () => {
    const configured = await writeFakeEgo({}, "configured-ego-browser");
    const envBinary = await writeFakeEgo();
    await writeFakeFirecrawl();
    await writeCompleteConfig(configured);

    const result = await runCliInPty(["y", "y", "y", "y"], { EGO_BROWSER_BIN: envBinary });

    expect(result.status).toBe(0);
    expect(result.output).toContain(`ego.binary: ${configured} -> ${envBinary}`);
    expect(result.output).toContain(`Repair ego.binary: ${configured} -> ${envBinary}`);
    expect(result.output).toContain("every explicit value is preserved");
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe(envBinary);
  });

  it("recovers on rerun after incomplete onboarding without reopening the page", async () => {
    await writeFakeFirecrawl();
    await writeOpeners();
    const first = await runCliInPty(["y", "y", "y", "n"]);
    expect(first.status).toBe(0);
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe("ego-browser");

    await writeFakeEgo();
    const second = await runCliInPty(["y", "y", "y", "y"]);

    expect(second.status).toBe(0);
    expect(second.output).toContain(`Repair ego.binary: ego-browser -> ${join(binDir, "ego-browser")}`);
    expect(second.output).toContain("ego-lite: Installed");
    expect(((await readConfig()).ego as Record<string, unknown>).binary).toBe(join(binDir, "ego-browser"));
    expect(await readLog(openerLog)).toEqual([`open|["${EGO_DOWNLOAD_URL}"]`]);
  });
});
