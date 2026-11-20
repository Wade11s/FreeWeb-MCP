import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cliPath = resolve("dist/cli.js");

let root: string | undefined;
let invalidConfigPath: string | undefined;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cliEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return {
    ...env,
    FREEWEB_CONFIG: join(root!, "missing-config.json"),
    FREEWEB_DATA_DIR: join(root!, "data"),
    FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "false",
    TINYFISH_API_KEY: "",
    ...overrides,
  };
}

function runCli(args: string[], overrides: Record<string, string> = {}): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: cliEnv(overrides),
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-cli-"));
  invalidConfigPath = join(root, "invalid.json");
  await writeFile(invalidConfigPath, "{ not valid json");
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  invalidConfigPath = undefined;
});

describe("built CLI surface", () => {
  it("prints help on stdout and exits 0 without arguments, without starting the server", () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: freeweb-mcp [options] [command]");
    for (const command of ["mcp", "doctor", "print-config"]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("listening on stdio");
  });

  it("prints help for --help, -h, and the help command", () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: freeweb-mcp [options] [command]");
      expect(result.stderr).toBe("");
    }
  });

  it("prints command help for --help, -h, and help with a command target", () => {
    for (const args of [["mcp", "--help"], ["mcp", "-h"], ["help", "mcp"]]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: freeweb-mcp mcp [options]");
      expect(result.stdout).toContain("Start the stdio MCP server");
      expect(result.stderr).toBe("");
    }
    const doctor = runCli(["help", "doctor"]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("Usage: freeweb-mcp doctor [options]");
    expect(doctor.stdout).toContain("--json");
    expect(doctor.stderr).toBe("");
  });

  it("prints only the semantic version for --version and -v", () => {
    for (const args of [["--version"], ["-v"]]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("0.1.0\n");
      expect(result.stderr).toBe("");
    }
  });

  it("keeps help and version working with invalid business configuration", () => {
    const overrides = { FREEWEB_CONFIG: invalidConfigPath! };
    for (const args of [[], ["--help"], ["help", "doctor"], ["--version"], ["-v"]]) {
      const result = runCli(args, overrides);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toBe("");
    }
  });

  it("keeps print-config working with invalid business configuration", () => {
    const result = runCli(["print-config"], { FREEWEB_CONFIG: invalidConfigPath! });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const printed = JSON.parse(result.stdout);
    expect(printed.mcpServers.freeweb.command).toBe(process.execPath);
    expect(printed.mcpServers.freeweb.args).toEqual([cliPath, "mcp"]);
  });

  it("fails unknown commands and unknown options on stderr with exit code 1", () => {
    const unknownCommand = runCli(["strat"]);
    expect(unknownCommand.status).toBe(1);
    expect(unknownCommand.stdout).toBe("");
    expect(unknownCommand.stderr).toContain("unknown command");

    for (const args of [["--nope"], ["doctor", "--nope"]]) {
      const unknownOption = runCli(args);
      expect(unknownOption.status).toBe(1);
      expect(unknownOption.stdout).toBe("");
      expect(unknownOption.stderr).toContain("unknown option");
    }
  });

  it("fails unknown help targets with exit code 1 and a stderr diagnostic", () => {
    const result = runCli(["help", "strat"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown help topic");
  });

  it("fails excess positional arguments with exit code 1 and a stderr diagnostic", () => {
    for (const args of [["doctor", "extra"], ["mcp", "extra"], ["print-config", "extra"], ["help", "mcp", "doctor"]]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("too many arguments");
    }
  });

  it("fails excess positionals even when combined with a help or version flag", () => {
    for (const args of [["--help", "mcp"], ["-v", "mcp"], ["--version", "doctor"], ["doctor", "extra", "--version"], ["mcp", "extra", "--help"]]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("too many arguments");
    }
    for (const args of [["-v", "extra"], ["--version", "extra"], ["--help", "extra"]]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown command");
    }
  });

  it("fails unknown options even when combined with help or version flags", () => {
    for (const args of [
      ["--help", "--nope"], ["--nope", "--help"], ["--json", "--help"], ["--help", "--json"],
      ["--nope", "--version"], ["--version", "--nope"], ["doctor", "--nope", "--version"],
      ["doctor", "--nope", "--help"], ["doctor", "--help", "--nope"], ["mcp", "--nope", "--help"],
      ["doctor", "--json=true", "--help"],
    ]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown option");
    }
  });

  it("fails near-miss version and help flags instead of treating them as --version", () => {
    for (const args of [["-vv"], ["-v=1"], ["-vh"], ["doctor", "-vv"], ["mcp", "-vv"], ["--version=1"], ["--version=1", "mcp"]]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown option");
    }
  });

  it("keeps -- terminating option parsing", () => {
    for (const args of [["--", "--version"], ["--", "--help"], ["doctor", "--", "--json"], ["doctor", "--", "extra"]]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toBe("");
    }
  });

  it("fails an unknown command that merely precedes a version flag", () => {
    const result = runCli(["extra", "--version"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command");
  });

  it("keeps command help valid alongside other flags", () => {
    for (const args of [["doctor", "--help"], ["doctor", "--json", "--help"], ["doctor", "--help", "--json"], ["mcp", "--help"], ["help", "mcp"]]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: freeweb-mcp");
    }
  });

  it("reports a broken package.json as a controlled diagnostic instead of an unhandled rejection", async () => {
    const brokenRoot = await mkdtemp(join(tmpdir(), "freeweb-broken-"));
    try {
      await cp(resolve("dist"), join(brokenRoot, "dist"), { recursive: true });
      await symlink(resolve("node_modules"), join(brokenRoot, "node_modules"));
      await writeFile(join(brokenRoot, "package.json"), JSON.stringify({ type: "module" }));
      const result = spawnSync(process.execPath, [join(brokenRoot, "dist", "cli.js"), "--version"], {
        encoding: "utf8",
        timeout: 20_000,
        env: cliEnv({}),
      });
      if (result.error) throw result.error;
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toBe("");
      expect(result.stderr).not.toContain(" at ");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });

  it("fails mcp and doctor with invalid business configuration", () => {
    const overrides = { FREEWEB_CONFIG: invalidConfigPath! };
    const mcp = runCli(["mcp"], overrides);
    expect(mcp.status).toBe(1);
    expect(mcp.stdout).toBe("");
    expect(mcp.stderr).toContain(invalidConfigPath!);

    const doctor = runCli(["doctor"], overrides);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toBe("");
    expect(doctor.stderr).toContain(invalidConfigPath!);
  });

  it("routes doctor --json through the dispatcher as pure JSON on stdout", () => {
    const result = runCli(["doctor", "--json"]);
    const report = JSON.parse(result.stdout) as { checks: { name: string }[] };
    expect(result.stderr).toBe("");
    expect(report.checks.map((check) => check.name)).toContain("node");
  });

  it("keeps MCP stdout free of startup diagnostics and shuts down in order", async () => {
    const child = spawn(process.execPath, [cliPath, "mcp"], {
      env: cliEnv({}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not announce startup; stderr so far: ${stderr}`)), 10_000);
      child.stderr.on("data", (chunk) => {
        if (String(chunk).includes("listening on stdio")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    child.kill("SIGTERM");
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not exit after SIGTERM")), 15_000);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    expect(closed.signal).toBeNull();
    expect(closed.code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("FreeWeb-MCP listening on stdio");
  });
});
