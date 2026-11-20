import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandCall, CommandResult, FirecrawlConfig, FirecrawlRuntime } from "../../src/providers/firecrawl-process.js";
import { CERTIFIED_FIRECRAWL_VERSION, FIRECRAWL_INSTALL_ARGS, createFirecrawlComponent } from "../../src/init/components/firecrawl.js";
import type { InitDetection } from "../../src/init/component.js";
import type { InitIo } from "../../src/init/prompt.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-firecrawl-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const io: InitIo = {
  prompt: { interactive: true, confirm: async () => true, close: () => {} },
  writeLine: () => {},
  errorLine: () => {},
};

function detection(binary: string): InitDetection {
  return { installed: true, binary, certified: false, source: "path" };
}

function runtime(overrides: Partial<FirecrawlRuntime> = {}): FirecrawlRuntime {
  return {
    baseUrl: "http://127.0.0.1:32123",
    isAlive: () => true,
    onDead: () => {},
    request: async () => ({ status: "ok", engine: "firecrawl-local", version: "0.1.0" }),
    close: async () => {},
    ...overrides,
  };
}

describe("Firecrawl init detection boundary", () => {
  it("resolves an existing executable without launching it before confirmation", async () => {
    const binary = join(root, "firecrawl-local");
    await writeFile(binary, "fake");
    await chmod(binary, 0o700);
    let launches = 0;
    const component = createFirecrawlComponent({
      platform: "linux",
      readOsRelease: async () => "ID=debian",
      commandRunner: async () => {
        launches += 1;
        throw new Error("detection must not launch the provider");
      },
    });

    const result = await component.detect({ FIRECRAWL_LOCAL_BIN: binary }, { status: "absent" });

    expect(result).toMatchObject({
      installed: true,
      binary,
      source: "env",
      certified: false,
      platform: "debian",
      configPatches: [{ setting: "firecrawl.binary", value: binary }],
    });
    expect(launches).toBe(0);
  });

  it("handles a rejecting os-release reader without escaping detection or execution", async () => {
    const component = createFirecrawlComponent({
      platform: "linux",
      readOsRelease: async () => {
        throw new Error("simulated /etc/os-release read failure");
      },
    });

    const detection = await component.detect({ PATH: join(root, "bin") }, { status: "absent" });
    expect(detection.platform).toBe("unsupported");
    expect(detection.notes?.join(" ")).toContain("could not be determined");
    expect(component.plan(detection)[0]!.action).toBe("handoff");

    const result = await component.execute({ io, env: { PATH: join(root, "bin") }, detection, appliedRepairs: [] });
    expect(result.outcome).toBe("Pending");
    expect(result.detail).toContain("detection only");
  });
});

describe("Firecrawl init verification", () => {
  it("uses an owned loopback port with Cloud Off, requests only health, and closes the runtime", async () => {
    let started: FirecrawlConfig | undefined;
    const requests: string[] = [];
    let closed = false;
    const owned = runtime({
      request: async (path, init) => {
        requests.push(`${init.method} ${path}`);
        return { status: "ok", engine: "firecrawl-local", version: "0.1.0" };
      },
      close: async () => {
        closed = true;
      },
    });
    const component = createFirecrawlComponent({
      startRuntime: async (config) => {
        started = config;
        return owned;
      },
    });

    await expect(component.verify({ binary: "/fake/firecrawl-local" })).resolves.toEqual({ ok: true });
    expect(started).toMatchObject({
      binary: "/fake/firecrawl-local",
      host: "127.0.0.1",
      port: 0,
      allowPrivate: false,
      searchFallback: false,
    });
    expect(requests).toEqual(["GET /health"]);
    expect(closed).toBe(true);
  });

  it("closes after a bad health response and reports cleanup failure instead of hiding it", async () => {
    let closed = false;
    const component = createFirecrawlComponent({
      startRuntime: async () => runtime({
        request: async () => ({ status: "not-ready" }),
        close: async () => {
          closed = true;
          throw new Error("simulated close failure");
        },
      }),
    });

    const result = await component.verify({ binary: "/fake/firecrawl-local" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("health endpoint");
    expect(result.message).toContain("owned process cleanup failed");
    expect(closed).toBe(true);
  });
});

describe("Firecrawl certified version classification", () => {
  it("accepts only the exact 0.1.0 release and keeps Uncertified as a warning", async () => {
    const cases = [
      { reported: "firecrawl-local 0.1.0", certified: true },
      { reported: "firecrawl-local v0.1.0", certified: true },
      { reported: "firecrawl-local 10.1.0", certified: false },
      { reported: "firecrawl-local 0.1.0-beta", certified: false },
    ];
    for (const testCase of cases) {
      const component = createFirecrawlComponent({
        commandRunner: async () => ({ exitCode: 0, stdout: `${testCase.reported}\n`, stderr: "" }),
        startRuntime: async () => runtime(),
      });
      const result = await component.execute({ io, env: {}, detection: detection("/fake/firecrawl-local"), appliedRepairs: [] });
      expect(result.outcome, testCase.reported).toBe("Installed");
      expect(result.warnings.some((warning) => warning.code === "Uncertified"), testCase.reported).toBe(!testCase.certified);
    }
  });

  it("does not label a missing binary Uncertified when no version string was produced", async () => {
    const component = createFirecrawlComponent({
      commandRunner: async () => {
        throw new Error("spawn /missing/firecrawl-local ENOENT");
      },
      startRuntime: async () => {
        throw new Error("spawn /missing/firecrawl-local ENOENT");
      },
    });

    const result = await component.execute({
      io,
      env: {},
      detection: detection("/missing/firecrawl-local"),
      appliedRepairs: [],
    });

    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("ENOENT");
    expect(result.warnings).toEqual([]);
  });
});

interface InstallHarnessOptions {
  readonly platform?: NodeJS.Platform;
  readonly osRelease?: string;
  readonly missing?: readonly string[];
  readonly available?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly install?: (call: CommandCall) => Promise<CommandResult> | CommandResult;
  readonly installedVersion?: string;
  readonly startRuntime?: typeof import("../../src/providers/firecrawl-process.js").startFirecrawlRuntime;
}

const TOOLCHAIN_COMMANDS = ["rustc", "cargo", "cc", "gcc", "clang"];

function installHarness(options: InstallHarnessOptions = {}) {
  const calls: string[] = [];
  const commands: CommandCall[] = [];
  const available = options.available ?? ["rustc", "cargo", "cc"];
  const cargoHome = join(root, "cargo-home");
  const env: NodeJS.ProcessEnv = {
    PATH: join(root, "bin"),
    HOME: join(root, "home"),
    CARGO_HOME: cargoHome,
    ...options.env,
  };
  const binary = join(cargoHome, "bin", "firecrawl-local");
  let closed = false;
  const component = createFirecrawlComponent({
    platform: options.platform ?? "darwin",
    readOsRelease: async () => options.osRelease,
    commandRunner: async (call) => {
      calls.push(`${call.command} ${call.args.join(" ")}`);
      commands.push(call);
      if (TOOLCHAIN_COMMANDS.includes(call.command) && call.args[0] === "--version") {
        if (options.missing?.includes(call.command) || !available.includes(call.command)) {
          throw new Error(`spawn ${call.command} ENOENT`);
        }
        return { exitCode: 0, stdout: `${call.command} 1.0.0\n`, stderr: "" };
      }
      if (call.command === "cargo" && call.args[0] === "install") {
        return await options.install?.(call) ?? { exitCode: 0, stdout: "installed\n", stderr: "" };
      }
      if (call.command === binary && call.args[0] === "--version") {
        return { exitCode: 0, stdout: `firecrawl-local ${options.installedVersion ?? CERTIFIED_FIRECRAWL_VERSION}\n`, stderr: "" };
      }
      throw new Error(`unexpected command ${call.command} ${call.args.join(" ")}`);
    },
    startRuntime: options.startRuntime ?? (async () => runtime({
      close: async () => {
        closed = true;
      },
    })),
  });
  return { component, env, calls, commands, binary, cargoHome, wasClosed: () => closed };
}

async function writeInstalledBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/usr/bin/env node\n", { mode: 0o755 });
  await chmod(path, 0o755);
}

function cargoInstalledBinaryPath(): string {
  return join(root, "cargo-home", "bin", "firecrawl-local");
}

describe("Firecrawl automatic installation platform matrix", () => {
  it("plans and performs the certified crates.io install on macOS after checking every prerequisite first", async () => {
    const harness = installHarness({
      install: async () => {
        await writeInstalledBinary(cargoInstalledBinaryPath());
        return { exitCode: 0, stdout: "Installed firecrawl-local 0.1.0\n", stderr: "" };
      },
    });

    const detection = await harness.component.detect(harness.env, { status: "absent" });
    const plan = harness.component.plan(detection);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ component: "firecrawl", action: "install", required: true, selected: true });
    expect(plan[0]!.description).toContain(`cargo install firecrawl-local --version ${CERTIFIED_FIRECRAWL_VERSION}`);
    expect(plan[0]!.description).toContain("never a source branch");
    expect(plan[0]!.description).toContain("Chrome/Chromium is optional");

    const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });

    expect(result.outcome).toBe("Installed");
    expect(result.configPatches).toEqual([{ setting: "firecrawl.binary", value: harness.binary }]);
    expect(harness.calls.slice(0, 4)).toEqual([
      "rustc --version",
      "cargo --version",
      "cc --version",
      `cargo ${FIRECRAWL_INSTALL_ARGS.join(" ")}`,
    ]);
    expect(harness.calls).toContain(`${harness.binary} --version`);
    expect(harness.calls.some((call) => /(^|\s)(clone|git)(\s|$)/.test(call))).toBe(false);
    expect(harness.calls.some((call) => /(^|\s)(login|init|mcp)(\s|$)/.test(call))).toBe(false);
    expect(harness.wasClosed()).toBe(true);
    expect(result.detail).toContain("Chrome/Chromium");
  });

  it("plans and performs the same install on Debian and Ubuntu when prerequisites exist", async () => {
    for (const release of [
      "ID=debian\nID_LIKE=debian",
      "ID=ubuntu\nID_LIKE=debian",
      "ID=linuxmint\nID_LIKE=ubuntu debian",
      "ID=debian\r\nID_LIKE=debian\r\n",
    ]) {
      const harness = installHarness({
        platform: "linux",
        osRelease: release,
        install: async () => {
          await writeInstalledBinary(cargoInstalledBinaryPath());
          return { exitCode: 0, stdout: "installed\n", stderr: "" };
        },
      });
      const detection = await harness.component.detect(harness.env, { status: "absent" });
      expect(harness.component.plan(detection)[0]!.action, release).toBe("install");
      const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });
      expect(result.outcome, release).toBe("Installed");
      expect(result.configPatches, release).toEqual([{ setting: "firecrawl.binary", value: harness.binary }]);
      await rm(cargoInstalledBinaryPath(), { force: true });
    }
  });

  it("provides detection and manual guidance without installing on Windows and unsupported Linux distributions", async () => {
    const cases = [
      { platform: "win32" as const, osRelease: undefined, label: "Windows" },
      { platform: "linux" as const, osRelease: "ID=fedora\nID_LIKE=fedora", label: "this platform" },
    ];
    for (const testCase of cases) {
      const harness = installHarness({ platform: testCase.platform, osRelease: testCase.osRelease });
      const detection = await harness.component.detect(harness.env, { status: "absent" });
      const plan = harness.component.plan(detection);
      expect(plan[0]!.action, testCase.label).toBe("handoff");
      expect(plan[0]!.description, testCase.label).toContain(`not offered on ${testCase.label}`);

      const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });
      expect(result.outcome, testCase.label).toBe("Pending");
      expect(result.detail, testCase.label).toContain("detection only");
      expect(result.detail, testCase.label).toContain("https://docs.firecrawl.dev/quickstarts/firecrawl-local");
      expect(result.configPatches, testCase.label).toBeUndefined();
      expect(harness.calls, testCase.label).toEqual([]);
    }
  });
});

describe("Firecrawl installation prerequisites", () => {
  it("forwards legitimate cargo and rustc environment keys without passing secrets through", async () => {
    const harness = installHarness({
      env: {
        RUSTFLAGS: "-C target-cpu=native",
        CARGO_TARGET_DIR: join(root, "target"),
        CARGO_BUILD_JOBS: "2",
        CARGO_NET_OFFLINE: "true",
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse",
        MACOSX_DEPLOYMENT_TARGET: "13.0",
        SDKROOT: "/fake/sdk",
        TINYFISH_API_KEY: "sk-live-secret-value",
        FIRECRAWL_API_KEY: "fc-live-secret-value",
      },
      install: async () => {
        await writeInstalledBinary(cargoInstalledBinaryPath());
        return { exitCode: 0, stdout: "installed\n", stderr: "" };
      },
    });
    const detection = await harness.component.detect(harness.env, { status: "absent" });
    const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });

    expect(result.outcome).toBe("Installed");
    const cargoInstall = harness.commands.find((call) => call.command === "cargo" && call.args[0] === "install");
    expect(cargoInstall?.env).toMatchObject({
      RUSTFLAGS: "-C target-cpu=native",
      CARGO_TARGET_DIR: join(root, "target"),
      CARGO_BUILD_JOBS: "2",
      CARGO_NET_OFFLINE: "true",
      CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse",
      MACOSX_DEPLOYMENT_TARGET: "13.0",
      SDKROOT: "/fake/sdk",
    });
    expect(cargoInstall?.env?.TINYFISH_API_KEY).toBeUndefined();
    expect(cargoInstall?.env?.FIRECRAWL_API_KEY).toBeUndefined();
  });

  it("accepts gcc or clang when the cc name is absent, keeping cc first", async () => {
    const gccHarness = installHarness({
      available: ["rustc", "cargo", "gcc"],
      install: async () => {
        await writeInstalledBinary(cargoInstalledBinaryPath());
        return { exitCode: 0, stdout: "installed\n", stderr: "" };
      },
    });
    const gccDetection = await gccHarness.component.detect(gccHarness.env, { status: "absent" });
    const gccResult = await gccHarness.component.execute({ io, env: gccHarness.env, detection: gccDetection, appliedRepairs: [] });
    expect(gccResult.outcome).toBe("Installed");
    expect(gccHarness.calls.slice(0, 5)).toEqual([
      "rustc --version",
      "cargo --version",
      "cc --version",
      "gcc --version",
      `cargo ${FIRECRAWL_INSTALL_ARGS.join(" ")}`,
    ]);
    expect(gccHarness.calls).not.toContain("clang --version");
    await rm(cargoInstalledBinaryPath(), { force: true });

    for (const compiler of ["gcc", "clang"] as const) {
      const harness = installHarness({
        available: ["rustc", "cargo", compiler],
        install: async () => {
          await writeInstalledBinary(cargoInstalledBinaryPath());
          return { exitCode: 0, stdout: "installed\n", stderr: "" };
        },
      });
      const detection = await harness.component.detect(harness.env, { status: "absent" });
      const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });
      expect(result.outcome, compiler).toBe("Installed");
      expect(harness.calls, compiler).toContain(`${compiler} --version`);
      await rm(cargoInstalledBinaryPath(), { force: true });
    }
  });

  it("reports missing Rust, Cargo, and C compilers as Pending with actionable official guidance and no install", async () => {
    const cases = [
      { platform: "darwin" as const, release: undefined, missing: ["rustc"], expected: "https://rustup.rs" },
      { platform: "darwin" as const, release: undefined, missing: ["cargo"], expected: "https://rustup.rs" },
      { platform: "darwin" as const, release: undefined, missing: ["cc"], expected: "xcode-select --install" },
      { platform: "linux" as const, release: "ID=ubuntu\nID_LIKE=debian", missing: ["cc"], expected: "build-essential" },
      { platform: "linux" as const, release: "ID=debian\nID_LIKE=debian", missing: ["rustc"], expected: "https://rustup.rs" },
    ];
    for (const testCase of cases) {
      const harness = installHarness({
        platform: testCase.platform,
        osRelease: testCase.release,
        missing: testCase.missing,
      });
      const detection = await harness.component.detect(harness.env, { status: "absent" });
      const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });

      expect(result.outcome, `${testCase.platform}/${testCase.missing}`).toBe("Pending");
      expect(result.detail, `${testCase.platform}/${testCase.missing}`).toContain(testCase.expected);
      expect(result.detail, `${testCase.platform}/${testCase.missing}`).toContain("never installs system package managers");
      expect(result.configPatches, `${testCase.platform}/${testCase.missing}`).toBeUndefined();
      expect(harness.calls.some((call) => call.startsWith("cargo install")), `${testCase.platform}/${testCase.missing}`).toBe(false);
    }
  });
});

describe("Firecrawl installation outcomes", () => {
  it("reports a failed cargo install as Failed without recording an installation", async () => {
    const harness = installHarness({
      install: async () => ({ exitCode: 1, signal: null, stdout: "Compiling firecrawl-local\n", stderr: "error: failed to compile firecrawl-local\n" }),
    });
    const detection = await harness.component.detect(harness.env, { status: "absent" });
    const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });

    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("exit code 1");
    expect(result.detail).toContain("failed to compile firecrawl-local");
    expect(result.configPatches).toBeUndefined();
    expect(harness.calls.some((call) => call.startsWith(`${harness.binary} --version`))).toBe(false);
  });

  it("treats an interrupted install as Failed and lets a rerun complete without a half-installed certification", async () => {
    let attempts = 0;
    const harness = installHarness({
      install: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { exitCode: null, signal: "SIGKILL", stdout: "Compiling firecrawl-local\n", stderr: "", timedOut: true };
        }
        await writeInstalledBinary(cargoInstalledBinaryPath());
        return { exitCode: 0, stdout: "installed\n", stderr: "" };
      },
    });

    const firstDetection = await harness.component.detect(harness.env, { status: "absent" });
    const first = await harness.component.execute({ io, env: harness.env, detection: firstDetection, appliedRepairs: [] });
    expect(first.outcome).toBe("Failed");
    expect(first.detail).toContain("timed out");
    expect(first.configPatches).toBeUndefined();

    const secondDetection = await harness.component.detect(harness.env, { status: "absent" });
    const second = await harness.component.execute({ io, env: harness.env, detection: secondDetection, appliedRepairs: [] });
    expect(second.outcome).toBe("Installed");
    expect(second.configPatches).toEqual([{ setting: "firecrawl.binary", value: harness.binary }]);
    expect(attempts).toBe(2);
  });

  it("fails an install whose binary is certified but whose health check fails, recording the path for a rerun", async () => {
    let runtimeStarts = 0;
    const harness = installHarness({
      install: async () => {
        await writeInstalledBinary(cargoInstalledBinaryPath());
        return { exitCode: 0, stdout: "installed\n", stderr: "" };
      },
      startRuntime: async () => {
        runtimeStarts += 1;
        return runtime({ request: async () => ({ status: "ok", engine: "other-engine" }) });
      },
    });
    const detection = await harness.component.detect(harness.env, { status: "absent" });
    const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });

    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("health check failed");
    expect(result.detail).toContain("path was recorded");
    expect(result.configPatches).toEqual([{ setting: "firecrawl.binary", value: harness.binary }]);
    expect(runtimeStarts).toBe(1);
  });

  it("does not certify a partially written binary left by an interrupted install on the strength of existence alone", async () => {
    let installAttempts = 0;
    let runtimeStarts = 0;
    const harness = installHarness({
      install: async () => {
        installAttempts += 1;
        await writeInstalledBinary(cargoInstalledBinaryPath());
        return { exitCode: null, signal: "SIGKILL", stdout: "Compiling firecrawl-local\n", stderr: "", timedOut: true };
      },
      startRuntime: async () => {
        runtimeStarts += 1;
        throw new Error("the partially written binary cannot serve");
      },
    });

    const firstDetection = await harness.component.detect(harness.env, { status: "absent" });
    const first = await harness.component.execute({ io, env: harness.env, detection: firstDetection, appliedRepairs: [] });
    expect(first.outcome).toBe("Failed");
    expect(first.detail).toContain("timed out");
    expect(first.configPatches).toBeUndefined();

    const secondDetection = await harness.component.detect(harness.env, { status: "absent" });
    expect(secondDetection.installed).toBe(true);
    expect(secondDetection.binary).toBe(harness.binary);
    const second = await harness.component.execute({ io, env: harness.env, detection: secondDetection, appliedRepairs: [] });
    expect(second.outcome).toBe("Failed");
    expect(second.detail).toContain("health check failed");
    expect(second.configPatches).toBeUndefined();
    expect(installAttempts).toBe(1);
    expect(runtimeStarts).toBe(1);
  });

  it("never certifies a cargo result that reports another version", async () => {
    let runtimeStarts = 0;
    const harness = installHarness({
      installedVersion: "0.2.0",
      install: async () => {
        await writeInstalledBinary(cargoInstalledBinaryPath());
        return { exitCode: 0, stdout: "installed\n", stderr: "" };
      },
      startRuntime: async () => {
        runtimeStarts += 1;
        return runtime();
      },
    });
    const detection = await harness.component.detect(harness.env, { status: "absent" });
    const result = await harness.component.execute({ io, env: harness.env, detection, appliedRepairs: [] });

    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("not the certified 0.1.0 release");
    expect(result.configPatches).toBeUndefined();
    expect(runtimeStarts).toBe(0);
  });

  it("does not reinstall an existing certified installation found in the Cargo bin directory and reports the optional Chrome enhancement", async () => {
    const binary = cargoInstalledBinaryPath();
    await writeInstalledBinary(binary);
    const calls: string[] = [];
    const component = createFirecrawlComponent({
      platform: "darwin",
      commandRunner: async (call) => {
        calls.push(`${call.command} ${call.args.join(" ")}`);
        if (call.command === binary && call.args[0] === "--version") {
          return { exitCode: 0, stdout: "firecrawl-local 0.1.0\n", stderr: "" };
        }
        throw new Error(`unexpected command ${call.command} ${call.args.join(" ")}`);
      },
      startRuntime: async () => runtime(),
    });
    const env: NodeJS.ProcessEnv = { PATH: join(root, "bin"), HOME: join(root, "home"), CARGO_HOME: join(root, "cargo-home") };

    const detection = await component.detect(env, { status: "absent" });
    expect(detection.binary).toBe(binary);
    expect(component.plan(detection)[0]!.action).toBe("verify");
    const result = await component.execute({ io, env, detection, appliedRepairs: [] });

    expect(result.outcome).toBe("Installed");
    expect(result.warnings).toEqual([]);
    expect(calls).toEqual([`${binary} --version`]);
    expect(result.detail).toContain("Chrome/Chromium");
  });
});
