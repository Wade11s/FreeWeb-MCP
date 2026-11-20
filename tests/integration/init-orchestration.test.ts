import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { runDoctor } from "../../src/doctor.js";
import { createFirecrawlComponent } from "../../src/init/components/firecrawl.js";
import { runInit, type InitDeps } from "../../src/init/command.js";
import { ConfigStore, nodeInitFilesystem, type InitFilesystem } from "../../src/init/config-store.js";
import { createPrompt, type InitIo } from "../../src/init/prompt.js";

let root: string;
let binDir: string;
let configDir: string;
let configPath: string;
let dataDir: string;
let homeDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-"));
  binDir = join(root, "bin");
  configDir = join(root, "config");
  configPath = join(configDir, "config.json");
  dataDir = join(root, "data");
  homeDir = join(root, "home");
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  // Doctor receives absolute fake provider paths below; routine tests must
  // never resolve a real provider through the parent process PATH.
  await writeFile(join(binDir, "ego-browser"), "#!/usr/bin/env node\nconsole.log('ego-browser fake');\n", { mode: 0o755 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: [binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: homeDir,
    FREEWEB_DATA_DIR: dataDir,
    ...overrides,
  };
}

interface FakeIo {
  io: InitIo;
  input: PassThrough;
  out(): string;
  err(): string;
}

function fakeIo(answers: readonly string[], interactive = true): FakeIo {
  const input = new PassThrough();
  for (const answer of answers) input.write(`${answer}\n`);
  const outLines: string[] = [];
  const errLines: string[] = [];
  const prompt = createPrompt({ input, write: (chunk) => outLines.push(chunk), interactive });
  return {
    input,
    io: {
      prompt,
      writeLine: (line) => {
        outLines.push(`${line}\n`);
      },
      errorLine: (line) => {
        errLines.push(`${line}\n`);
      },
    },
    out: () => outLines.join(""),
    err: () => errLines.join(""),
  };
}

function deps(overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    env: baseEnv(),
    configPath,
    components: [createFirecrawlComponent()],
    store: new ConfigStore(),
    runDoctor: async (config) => runDoctor({
      ...config,
      firecrawl: {
        ...config.firecrawl,
        binary: config.firecrawl.binary === "firecrawl-local" ? join(binDir, "firecrawl-local") : config.firecrawl.binary,
      },
      ego: { ...config.ego, binary: join(binDir, "ego-browser") },
    }, { minimumNodeVersion: [22, 12, 0] }),
    loadAppConfig: (options) => loadConfig(options),
    ...overrides,
  };
}

type Behavior = "healthy" | "exit" | "hang";

async function writeFakeFirecrawl(options: { version?: string; behavior?: Behavior } = {}): Promise<{ binary: string; log: string }> {
  const version = options.version ?? "0.1.0";
  const behavior = options.behavior ?? "healthy";
  const binary = join(binDir, "firecrawl-local");
  const log = join(root, "firecrawl.log");
  const script = `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import http from "node:http";
const log = ${JSON.stringify(log)};
const version = ${JSON.stringify(version)};
const behavior = ${JSON.stringify(behavior)};
const note = (line) => appendFile(log, line + "\\n", "utf8").catch(() => {});
const args = process.argv.slice(2);
await note("invoke " + JSON.stringify(args) + " cloud=" + (process.env.FIRECRAWL_CLOUD ?? "unset"));
if (args[0] === "--version") { console.log("firecrawl-local " + version); process.exit(0); }
if (args[0] !== "serve") process.exit(2);
if (behavior === "exit") process.exit(1);
if (behavior === "hang") {
  process.on("SIGTERM", () => { void note("sigterm"); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  const port = Number(args[args.indexOf("--port") + 1]);
  const server = http.createServer((req, res) => {
    void note("request " + req.method + " " + req.url);
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", engine: "firecrawl-local", version }));
    } else { res.writeHead(404); res.end("{}"); }
  });
  server.listen(port, "127.0.0.1");
  process.on("SIGTERM", () => { void note("sigterm"); server.close(() => { void note("serve-exit"); process.exit(0); }); });
}
`;
  await writeFile(binary, script, { mode: 0o755 });
  await chmod(binary, 0o755);
  return { binary, log };
}

async function readLogLines(log: string): Promise<string[]> {
  if (!existsSync(log)) return [];
  return (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0);
}

async function writeExistingConfig(value: unknown): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function readConfigFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
}

function interruptedStore(): { store: ConfigStore } {
  const fs: InitFilesystem = {
    ...nodeInitFilesystem,
    rename: async () => {
      throw new Error("simulated interruption: rename refused");
    },
  };
  return { store: new ConfigStore(fs) };
}

describe("init gates", () => {
  it("rejects a non-TTY invocation before any read, write, or provider launch", async () => {
    const fake = fakeIo([], false);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(1);
    expect(fake.err()).toContain("requires a terminal");
    expect(fake.err()).toContain("no changes were made");
    expect(fake.out()).toBe("");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(root, "firecrawl.log"))).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
    expect(await readdir(root)).toEqual(["bin", "home"]);
  });

  it("stops before any change when the plan is declined", async () => {
    await writeFakeFirecrawl();
    const fake = fakeIo(["n"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(1);
    expect(fake.err()).toContain("canceled before any changes were made");
    expect(fake.out()).toContain("FreeWeb-MCP initialization plan:");
    expect(fake.out()).toContain("[required] Firecrawl Local:");
    expect(existsSync(configPath)).toBe(false);
    expect(await readLogLines(join(root, "firecrawl.log"))).toEqual([]);
  });

  it("treats terminal EOF as a refusal without writes or provider launches", async () => {
    await writeFakeFirecrawl();
    const fake = fakeIo([]);
    const running = runInit(fake.io, deps());
    await new Promise<void>((resolve) => setImmediate(resolve));
    fake.input.end();
    const code = await running;
    expect(code).toBe(1);
    expect(fake.err()).toContain("canceled before any changes were made");
    expect(existsSync(configPath)).toBe(false);
    expect(await readLogLines(join(root, "firecrawl.log"))).toEqual([]);
  });
});

describe("init with an existing certified installation", () => {
  it("verifies with an owned loopback Cloud Off process, writes conservative configuration, runs doctor, and exits 0", async () => {
    const { binary, log } = await writeFakeFirecrawl();
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(0);

    // Plan and summary
    expect(fake.out()).toContain("verify the existing installation with an owned loopback health check (Cloud Off)");
    expect(fake.out()).toContain("Firecrawl Local: Installed");
    expect(fake.out()).toContain("Configuration: Configured");
    expect(fake.out()).toContain(`create the data directory at ${dataDir} with mode 0700 if it is absent`);
    expect(existsSync(dataDir)).toBe(true);

    // Doctor ran without starting the MCP server
    expect(fake.out()).toContain("Running local doctor checks");
    expect(fake.out()).toContain("PASS node:");
    expect(fake.out()).not.toContain("listening on stdio");

    // Configuration: conservative defaults, resolved absolute path, private modes
    const raw = await readConfigFile();
    expect((raw.firecrawl as Record<string, unknown>).binary).toBe(binary);
    expect((raw.firecrawl as Record<string, unknown>).allowPrivate).toBe(false);
    expect((raw.firecrawl as Record<string, unknown>).searchFallback).toBe(false);
    expect((raw.ego as Record<string, unknown>).unrestricted).toBe(false);
    expect((raw.tinyfish as Record<string, unknown>).freeOnlyConfirmed).toBe(false);
    expect(JSON.stringify(raw)).not.toContain("TINYFISH_API_KEY");
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    }

    // Owned loopback serve with Cloud Off, local health only, bounded cleanup
    const lines = await readLogLines(log);
    const serveLine = lines.find((line) => line.includes('"serve"'));
    expect(serveLine).toBeDefined();
    expect(serveLine!).toContain("cloud=off");
    const serveArgs = JSON.parse(serveLine!.slice("invoke ".length, serveLine!.indexOf(" cloud="))) as string[];
    expect(serveArgs[0]).toBe("serve");
    expect(serveArgs[1]).toBe("--host");
    expect(serveArgs[2]).toBe("127.0.0.1");
    expect(serveArgs[3]).toBe("--port");
    expect(Number(serveArgs[4])).toBeGreaterThan(0);
    const requests = lines.filter((line) => line.startsWith("request "));
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request).toBe("request GET /health");
    expect(lines).toContain("sigterm");
    expect(lines.filter((line) => line === "serve-exit")).toHaveLength(1);

    // Completion guidance references print-config
    expect(fake.out()).toContain("print-config");
  });

  it("uses the FIRECRAWL_LOCAL_BIN override and records it in the new configuration", async () => {
    const { binary, log } = await writeFakeFirecrawl();
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps({ env: baseEnv({ FIRECRAWL_LOCAL_BIN: binary }) }));
    expect(code).toBe(0);
    expect(((await readConfigFile()).firecrawl as Record<string, unknown>).binary).toBe(binary);
    expect(await readLogLines(log)).toContainEqual('invoke ["--version"] cloud=unset');
  });

  it("reports an unusable FIRECRAWL_LOCAL_BIN as not installed rather than falling back silently", async () => {
    await writeFakeFirecrawl();
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps({ env: baseEnv({ FIRECRAWL_LOCAL_BIN: "/missing/firecrawl-local" }) }));
    expect(code).toBe(1);
    expect(fake.out()).toContain("Firecrawl Local: Pending");
    expect(fake.out()).toContain("FIRECRAWL_LOCAL_BIN does not resolve");
  });

  it("never reads or writes other MCP client configurations", async () => {
    const claude = join(homeDir, ".claude.json");
    const cursor = join(homeDir, ".cursor", "config.json");
    await mkdir(dirname(cursor), { recursive: true });
    await writeFile(claude, JSON.stringify({ mcpServers: { other: {} } }));
    await writeFile(cursor, JSON.stringify({ keep: true }));
    const before = new Map<string, string>([[claude, await readFile(claude, "utf8")], [cursor, await readFile(cursor, "utf8")]]);

    await writeFakeFirecrawl();
    const fake = fakeIo(["y"]);
    expect(await runInit(fake.io, deps())).toBe(0);

    for (const [path, content] of before) {
      expect(await readFile(path, "utf8")).toBe(content);
    }
    expect(await readdir(homeDir)).toEqual([".claude.json", ".cursor"]);
    expect(fake.out()).toContain("init never reads or writes other clients' configurations");
  });
});

describe("init version handling", () => {
  it("warns Uncertified for a non-certified version and leaves the binary untouched", async () => {
    const { log } = await writeFakeFirecrawl({ version: "9.9.9" });
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(0);
    expect(fake.out()).toContain("Firecrawl Local: Installed");
    expect(fake.out()).toContain("warning [Uncertified]: Firecrawl Local reports 'firecrawl-local 9.9.9'");
    // Only version probes and the owned serve: no upgrade, downgrade, or reinstall.
    const lines = await readLogLines(log);
    for (const line of lines.filter((entry) => entry.startsWith("invoke "))) {
      expect(line.startsWith('invoke ["--version"]') || line.includes('"serve"')).toBe(true);
    }
  });

  it("reports a failed health check as Failed, separately from the Uncertified warning", async () => {
    await writeFakeFirecrawl({ version: "9.9.9", behavior: "exit" });
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(1);
    expect(fake.out()).toContain("Firecrawl Local: Failed");
    expect(fake.out()).toContain("health check failed");
    expect(fake.out()).toContain("warning [Uncertified]");
    expect(fake.out()).toContain("Configuration: Configured");
  });

  it("cleans up a serve process that never becomes healthy", async () => {
    const { log } = await writeFakeFirecrawl({ behavior: "hang" });
    await writeExistingConfig({ firecrawl: { binary: join(binDir, "firecrawl-local"), startupTimeoutMs: 1500, shutdownTimeoutMs: 2000 } });
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(1);
    expect(fake.out()).toContain("Firecrawl Local: Failed");
    const lines = await readLogLines(log);
    expect(lines).toContain("sigterm");
  });

  it("reports missing Firecrawl as Pending with manual guidance", async () => {
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(1);
    expect(fake.out()).toContain("Firecrawl Local: Pending");
    expect(fake.out()).toContain("docs.firecrawl.dev/quickstarts/firecrawl-local");
    expect(fake.out()).toContain("Automated installation arrives in a later release");
    expect(fake.out()).toContain("Configuration: Configured");
    expect(((await readConfigFile()).firecrawl as Record<string, unknown>).binary).toBe("firecrawl-local");
  });
});

describe("init existing configuration handling", () => {
  it("preserves every explicit value, adds only missing safe defaults, and completes the binary path", async () => {
    const { binary } = await writeFakeFirecrawl();
    await writeExistingConfig({
      dataDir: "/custom/data",
      firecrawl: { port: 3456, startupTimeoutMs: 60_000 },
      artifacts: { retentionMs: 120_000 },
    });
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(0);

    const raw = await readConfigFile();
    expect(raw.dataDir).toBe("/custom/data");
    const firecrawl = raw.firecrawl as Record<string, unknown>;
    expect(firecrawl.port).toBe(3456);
    expect(firecrawl.startupTimeoutMs).toBe(60_000);
    expect(firecrawl.binary).toBe(binary);
    expect((raw.artifacts as Record<string, unknown>).retentionMs).toBe(120_000);
    expect(raw.limits).toBeDefined();
    expect(fake.out()).not.toContain("HighRiskSetting");
    expect(fake.out()).toContain("missing safe defaults");
  });

  it("surfaces high-risk settings as warnings and never changes them", async () => {
    await writeFakeFirecrawl();
    await writeExistingConfig({
      firecrawl: { allowPrivate: true, searchFallback: true },
      ego: { unrestricted: true },
      tinyfish: { freeOnlyConfirmed: true },
    });
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(0);
    expect(fake.out()).toContain("Warning [HighRiskSetting]: firecrawl.allowPrivate=true is preserved unchanged");
    expect(fake.out()).toContain("Warning [HighRiskSetting]: firecrawl.searchFallback=true is preserved unchanged");
    expect(fake.out()).toContain("Warning [HighRiskSetting]: ego.unrestricted=true is preserved unchanged");
    expect(fake.out()).toContain("Warning [HighRiskSetting]: tinyfish.freeOnlyConfirmed=true is preserved unchanged");
    const raw = await readConfigFile();
    expect((raw.firecrawl as Record<string, unknown>).allowPrivate).toBe(true);
    expect((raw.firecrawl as Record<string, unknown>).searchFallback).toBe(true);
    expect((raw.ego as Record<string, unknown>).unrestricted).toBe(true);
    expect((raw.tinyfish as Record<string, unknown>).freeOnlyConfirmed).toBe(true);
  });

  it("applies a stale binary path repair only after its own confirmation", async () => {
    const { binary } = await writeFakeFirecrawl();
    await writeExistingConfig({ firecrawl: { binary: "/gone/firecrawl-local" } });
    const fake = fakeIo(["y", "y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(0);
    expect(fake.out()).toContain("firecrawl.binary: /gone/firecrawl-local -> " + binary);
    expect(fake.out()).toContain("Update firecrawl.binary from /gone/firecrawl-local to " + binary);
    expect(((await readConfigFile()).firecrawl as Record<string, unknown>).binary).toBe(binary);
    expect(fake.out()).toContain("Firecrawl Local: Installed");
  });

  it("proposes stale-path repair even when an environment override selects the replacement", async () => {
    const { binary } = await writeFakeFirecrawl();
    await writeExistingConfig({ firecrawl: { binary: "/gone/firecrawl-local" } });
    const fake = fakeIo(["y", "y"]);
    const code = await runInit(fake.io, deps({ env: baseEnv({ FIRECRAWL_LOCAL_BIN: binary }) }));
    expect(code).toBe(0);
    expect(fake.out()).toContain(`firecrawl.binary: /gone/firecrawl-local -> ${binary}`);
    expect(((await readConfigFile()).firecrawl as Record<string, unknown>).binary).toBe(binary);
  });

  it("verifies the stale configured path when its repair is declined without an env override", async () => {
    await writeFakeFirecrawl();
    await writeExistingConfig({ firecrawl: { binary: "/gone/firecrawl-local" } });
    const fake = fakeIo(["y", "n"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(1);
    expect(fake.out()).toContain("Kept firecrawl.binary: /gone/firecrawl-local");
    expect(((await readConfigFile()).firecrawl as Record<string, unknown>).binary).toBe("/gone/firecrawl-local");
    expect(fake.out()).toContain("Firecrawl Local: Failed");
    expect(fake.out()).toContain("spawn /gone/firecrawl-local ENOENT");
    // The working PATH fallback was not silently verified instead.
    expect(await readLogLines(join(root, "firecrawl.log"))).toEqual([]);
  });

  it("verifies the env override when a stale-path repair is declined", async () => {
    const { binary } = await writeFakeFirecrawl();
    await writeExistingConfig({ firecrawl: { binary: "/gone/firecrawl-local" } });
    const fake = fakeIo(["y", "n"]);
    const code = await runInit(fake.io, deps({ env: baseEnv({ FIRECRAWL_LOCAL_BIN: binary }) }));
    expect(code).toBe(0);
    expect(fake.out()).toContain("Kept firecrawl.binary: /gone/firecrawl-local");
    expect(fake.out()).toContain(`Firecrawl Local: Installed - existing installation at ${binary} verified`);
    expect(fake.out()).not.toContain("spawn /gone/firecrawl-local ENOENT");
    // Declining the repair preserves the file even though runtime and doctor use the override.
    expect(((await readConfigFile()).firecrawl as Record<string, unknown>).binary).toBe("/gone/firecrawl-local");
  });

  it("makes no changes to an already-complete configuration and is idempotent on rerun", async () => {
    const { binary } = await writeFakeFirecrawl();
    const first = fakeIo(["y"]);
    expect(await runInit(first.io, deps())).toBe(0);
    const content = await readFile(configPath, "utf8");
    await chmod(configPath, 0o644);
    await chmod(configDir, 0o755);

    const second = fakeIo(["y"]);
    expect(await runInit(second.io, deps())).toBe(0);
    expect(second.out()).toContain("no content changes were made");
    expect(await readFile(configPath, "utf8")).toBe(content);
    expect((await readdir(configDir)).sort()).toEqual(["config.json"]);
    expect(second.out()).toContain(`existing installation at ${binary} verified`);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    }
  });
});

describe("init damaged configuration recovery", () => {
  it("backs up and rebuilds a malformed configuration only after confirmation", async () => {
    await writeFakeFirecrawl();
    await writeExistingConfig("{ not valid json");
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(0);
    expect(fake.out()).toContain("damaged");
    expect(fake.out()).toContain("never treated as absent");
    expect(fake.out()).toContain("Backed up damaged configuration to " + join(configDir, "config.backup.json"));
    expect(await readFile(join(configDir, "config.backup.json"), "utf8")).toBe("{ not valid json");
    const raw = await readConfigFile();
    expect((raw.firecrawl as Record<string, unknown>).allowPrivate).toBe(false);
    expect(fake.out()).toContain("Configuration: Configured");
  });

  it("aborts with zero changes when the rebuild is declined", async () => {
    await writeFakeFirecrawl();
    await writeExistingConfig("{ not valid json");
    const fake = fakeIo(["n"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(1);
    expect(fake.err()).toContain("left unchanged");
    expect(await readFile(configPath, "utf8")).toBe("{ not valid json");
    expect(await readdir(configDir)).toEqual(["config.json"]);
    expect(await readLogLines(join(root, "firecrawl.log"))).toEqual([]);
  });

  it("does not echo secrets contained in malformed JSON diagnostics", async () => {
    await writeFakeFirecrawl();
    const secret = "init-test-tinyfish-secret";
    await writeExistingConfig(`{ "TINYFISH_API_KEY": "${secret}", }`);
    const fake = fakeIo(["n"]);
    expect(await runInit(fake.io, deps())).toBe(1);
    expect(fake.out()).not.toContain(secret);
    expect(fake.err()).not.toContain(secret);
  });

  it("recovers a schema-invalid configuration through the same flow", async () => {
    await writeFakeFirecrawl();
    await writeExistingConfig({ firecrawl: { port: "not-a-number" } });
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps());
    expect(code).toBe(0);
    expect(fake.out()).toContain("schema-invalid");
    expect(fake.out()).toContain("firecrawl.port");
    const raw = await readConfigFile();
    expect((raw.firecrawl as Record<string, unknown>).port).toBe(0);
  });

  it("never overwrites an earlier backup across repeated recoveries", async () => {
    await writeFakeFirecrawl();
    await writeExistingConfig("{ first");
    expect(await runInit(fakeIo(["y"]).io, deps())).toBe(0);
    await writeExistingConfig("{ second");
    expect(await runInit(fakeIo(["y"]).io, deps())).toBe(0);
    expect(await readFile(join(configDir, "config.backup.json"), "utf8")).toBe("{ first");
    expect(await readFile(join(configDir, "config.backup.1.json"), "utf8")).toBe("{ second");
    expect((await readdir(configDir)).sort()).toEqual(["config.backup.1.json", "config.backup.json", "config.json"]);
  });
});

describe("init interruption and rerun recovery", () => {
  it("keeps the original configuration intact and exits 1 when the atomic write is interrupted", async () => {
    await writeFakeFirecrawl();
    await writeExistingConfig({ firecrawl: { port: 3456 } });
    const original = await readFile(configPath, "utf8");
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps({ store: interruptedStore().store }));
    expect(code).toBe(1);
    expect(fake.out()).toContain("Configuration: Failed");
    expect(fake.out()).toContain("Cannot write");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(configDir)).toEqual(["config.json"]);
  });

  it("recovers on rerun after a partial failure", async () => {
    await writeFakeFirecrawl();
    await writeExistingConfig({ firecrawl: { port: 3456 } });
    expect(await runInit(fakeIo(["y"]).io, deps({ store: interruptedStore().store }))).toBe(1);
    const fake = fakeIo(["y"]);
    expect(await runInit(fake.io, deps())).toBe(0);
    const raw = await readConfigFile();
    expect((raw.firecrawl as Record<string, unknown>).port).toBe(3456);
    expect(fake.out()).toContain("Firecrawl Local: Installed");
  });

  it("returns 1 when a required doctor check reports the baseline is not usable", async () => {
    await writeFakeFirecrawl();
    const fake = fakeIo(["y"]);
    const code = await runInit(fake.io, deps({
      runDoctor: async () => ({
        ok: false,
        checks: [{ name: "data-directory", ok: false, required: true, message: "simulated failure" }],
      }),
    }));
    expect(code).toBe(1);
    expect(fake.out()).toContain("FAIL data-directory: simulated failure");
    expect(fake.out()).toContain("Initialization did not complete");
  });
});
