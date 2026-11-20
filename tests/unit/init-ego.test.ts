import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandCall, CommandResult, CommandRunner } from "../../src/providers/firecrawl-process.js";
import type { InitDetection } from "../../src/init/component.js";
import {
  createEgoComponent,
  EGO_DOWNLOAD_URL,
  EGO_INSTALL_REFERENCE_URL,
  EGO_NATIVE_MARKER,
} from "../../src/init/components/ego.js";
import { initExitCode, type InitComponentResult } from "../../src/init/outcomes.js";
import type { InitIo } from "../../src/init/prompt.js";

let root: string;
let binary: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-ego-test-"));
  binary = join(root, "ego-browser");
  await writeFile(binary, "#!/usr/bin/env node\n", { mode: 0o755 });
  await chmod(binary, 0o755);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type CallKind = "open" | "version" | "native" | "other";

function callKind(call: CommandCall): CallKind {
  if (call.args[0] === "--version") return "version";
  if (call.args[0] === "nodejs") return "native";
  if (call.args.length === 1 && call.args[0] === EGO_DOWNLOAD_URL) return "open";
  return "other";
}

function recorder(overrides: Partial<Record<CallKind, Partial<CommandResult>>> = {}): { runner: CommandRunner; calls: CommandCall[] } {
  const calls: CommandCall[] = [];
  const runner: CommandRunner = async (call) => {
    calls.push(call);
    const kind = callKind(call);
    const defaultResult: CommandResult = {
      exitCode: 0,
      stdout: kind === "native" ? EGO_NATIVE_MARKER : "ego-browser 1.2.3",
      stderr: "",
    };
    return { ...defaultResult, ...overrides[kind] };
  };
  return { runner, calls };
}

function fakeIo(
  answers: readonly boolean[],
  peek?: () => readonly CommandCall[],
): { io: InitIo; questions: string[]; callCounts: number[] } {
  const questions: string[] = [];
  const callCounts: number[] = [];
  let index = 0;
  return {
    questions,
    callCounts,
    io: {
      prompt: {
        interactive: true,
        confirm: async (question) => {
          questions.push(question);
          callCounts.push((peek?.() ?? []).length);
          return answers[index++] ?? false;
        },
        close: () => {},
      },
      writeLine: () => {},
      errorLine: () => {},
    },
  };
}

function installedDetection(overrides: Partial<InitDetection> = {}): InitDetection {
  return { installed: true, binary, source: "path", certified: false, ...overrides };
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: [root, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: root, ...overrides };
}

function simulatedPlatform(platform: string): Record<string, string> {
  return { FREEWEB_INIT_TEST_MODE: "1", FREEWEB_INIT_PLATFORM: platform };
}

function executeInput(
  detection: InitDetection,
  options: { io?: InitIo; overrides?: Record<string, string>; repairs?: InitDetection["repairs"] } = {},
) {
  return {
    io: options.io ?? fakeIo([true]).io,
    env: env(options.overrides),
    detection,
    appliedRepairs: options.repairs ?? [],
  };
}

describe("ego-lite init detection and plan", () => {
  it("resolves an existing command read-only and contributes the absolute path patch", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });

    const detection = await component.detect(env({ EGO_BROWSER_BIN: binary }), { status: "absent" });

    expect(detection).toEqual({
      installed: true,
      binary,
      source: "env",
      certified: false,
      configPatches: [{ setting: "ego.binary", value: binary }],
    });
    expect(calls).toEqual([]);
  });

  it("proposes a repair instead of patching a resolvable configured command name", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });

    const detection = await component.detect(env(), { status: "ok", raw: { ego: { binary: "ego-browser" } } });

    expect(detection.source).toBe("config");
    expect(detection.binary).toBe(binary);
    expect(detection.configPatches).toBeUndefined();
    expect(detection.repairs).toEqual([{ component: "ego", setting: "ego.binary", oldValue: "ego-browser", newValue: binary }]);
    expect(calls).toEqual([]);
  });

  it("proposes a repair when EGO_BROWSER_BIN overrides a different valid configured path", async () => {
    const alternate = join(root, "alternate-ego-browser");
    await writeFile(alternate, "#!/usr/bin/env node\n", { mode: 0o755 });
    await chmod(alternate, 0o755);
    const { runner } = recorder();
    const component = createEgoComponent({ commandRunner: runner });

    const detection = await component.detect(
      env({ EGO_BROWSER_BIN: binary }),
      { status: "ok", raw: { ego: { binary: alternate } } },
    );

    expect(detection.source).toBe("env");
    expect(detection.binary).toBe(binary);
    expect(detection.configPatches).toBeUndefined();
    expect(detection.repairs).toEqual([{ component: "ego", setting: "ego.binary", oldValue: alternate, newValue: binary }]);
  });

  it("plans an official handoff after confirmation and never claims Browse readiness", () => {
    const component = createEgoComponent();
    const items = component.plan({ installed: false, certified: false });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ component: "ego", action: "handoff", required: false, selected: true });
    expect(items[0]!.description).toContain("after plan confirmation");
    expect(items[0]!.description).toContain(EGO_DOWNLOAD_URL);
    expect(items[0]!.description).toContain(EGO_INSTALL_REFERENCE_URL);
    expect(items[0]!.description).not.toMatch(/ready|configured/i);
  });

  it("ignores a leaked FREEWEB_INIT_PLATFORM unless test mode is explicitly enabled", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: descriptor.writable,
    });
    try {
      const { runner } = recorder();
      const component = createEgoComponent({ commandRunner: runner });
      const detection = await component.detect(env({ FREEWEB_INIT_PLATFORM: "linux" }), { status: "absent" });

      expect(detection.warnings).toBeUndefined();
      expect(component.plan(detection)[0]!.description).not.toContain("linux");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("reports unsupported platforms as Skipped with an explanation and no installer", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const detection = await component.detect(env(simulatedPlatform("linux")), { status: "absent" });
    expect(detection.warnings?.[0]?.code).toBe("EgoPlatformUnsupported");
    expect(component.plan(detection)[0]!.description).toContain("linux");

    const prompts: string[] = [];
    const result = await component.execute({
      ...executeInput(detection, { overrides: simulatedPlatform("linux") }),
      io: {
        prompt: { interactive: true, confirm: async (question) => { prompts.push(question); return true; }, close: () => {} },
        writeLine: () => {},
        errorLine: () => {},
      },
    });

    expect(result.outcome).toBe("Skipped");
    expect(result.required).toBe(false);
    expect(result.detail).toContain("unsupported platform linux");
    expect(result.detail).toContain(EGO_INSTALL_REFERENCE_URL);
    expect(calls).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

describe("ego-lite init handoff and verification", () => {
  it("waits for onboarding confirmation before checking an existing installation", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const { io, callCounts } = fakeIo([true], () => calls);

    const result = await component.execute(executeInput(installedDetection(), { io }));

    expect(callCounts).toEqual([0]);
    expect(result.outcome).toBe("Installed");
    expect(result.configPatches).toEqual([{ setting: "ego.binary", value: binary }]);
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      [binary, "--version"],
      [binary, "nodejs"],
    ]);
    expect(calls[1]!.args).toEqual(["nodejs", "-e", `console.log(${JSON.stringify(EGO_NATIVE_MARKER)})`]);
    const allArgs = calls.flatMap((call) => [call.command, ...call.args]).join(" ");
    expect(allArgs).not.toMatch(/curl|sh\b|sudo|xattr|upgrade|import|profile|cookie|password|session|bookmark|extension/i);
    expect(result.detail).toContain("no upgrade, import, quarantine change, or elevation");
    expect(result.detail).toContain("Browse use still depends on your GUI choices");
  });

  it("treats explorer.exe exit 1 as a successful simulated Windows launch", async () => {
    const { runner, calls } = recorder({ open: { exitCode: 1, stderr: "explorer characteristic exit" } });
    const component = createEgoComponent({ commandRunner: runner });
    const overrides = simulatedPlatform("win32");
    const { io, questions } = fakeIo([true, true]);
    const callCounts: number[] = [];
    io.prompt.confirm = async (question) => {
      questions.push(question);
      callCounts.push(calls.length);
      return true;
    };

    const result = await component.execute(executeInput({ installed: false, certified: false }, { io, overrides }));

    expect(result.outcome).toBe("Installed");
    expect(calls[0]).toMatchObject({ command: "explorer.exe", args: [EGO_DOWNLOAD_URL] });
    expect(callCounts).toEqual([0, 1]);
    expect(questions[0]).toContain("Open the official ego-lite download page");
    expect(questions[1]).toContain("Have you installed ego lite");
    expect(result.detail).toContain("on win32");
    expect(calls.some((call) => call.command === "open")).toBe(false);
  });

  it("passes a filtered child environment with PATH to the opener", async () => {
    const secret = "unitf3w7-child-env-secret";
    vi.stubEnv("TINYFISH_API_KEY", secret);
    vi.stubEnv("PATH", `/fake/opener-path${delimiter}${process.env.PATH ?? ""}`);
    try {
      const { runner, calls } = recorder();
      const component = createEgoComponent({ commandRunner: runner });

      await component.execute(executeInput({ installed: false, certified: false }, { io: fakeIo([true, true]).io }));

      expect(calls[0]!.command).toBe("open");
      expect(calls[0]!.env.TINYFISH_API_KEY).toBeUndefined();
      expect(calls[0]!.env.PATH).toContain("/fake/opener-path");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records a path discovered after onboarding with the shared config patch contract", async () => {
    const { runner } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const result = await component.execute(
      executeInput({ installed: false, certified: false }, { io: fakeIo([true, true]).io }),
    );

    expect(result.outcome).toBe("Installed");
    expect(result.configPatches).toEqual([{ setting: "ego.binary", value: binary }]);
  });

  it("never rewrites an explicit configured path after a successful verify", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const detection = installedDetection({ source: "config" });

    const result = await component.execute(executeInput(detection));

    expect(result.outcome).toBe("Installed");
    expect(result.configPatches).toBeUndefined();
    expect(calls.map((call) => call.command)).toEqual([binary, binary]);
  });

  it("verifies the env path but preserves explicit config when its repair is declined", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const detection = installedDetection({
      source: "env",
      repairs: [{ component: "ego", setting: "ego.binary", oldValue: "/configured/ego-browser", newValue: binary }],
    });

    const result = await component.execute(executeInput(detection));

    expect(result.outcome).toBe("Installed");
    expect(result.configPatches).toBeUndefined();
    expect(calls.map((call) => call.command)).toEqual([binary, binary]);
  });

  it("uses a confirmed stale-path repair without a duplicate patch", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const detection = installedDetection({ staleConfiguredPath: "/gone/ego-browser" });

    const result = await component.execute(executeInput(detection, {
      repairs: [{ component: "ego", setting: "ego.binary", oldValue: "/gone/ego-browser", newValue: binary }],
    }));

    expect(result.outcome).toBe("Installed");
    expect(result.configPatches).toBeUndefined();
    expect(calls.map((call) => call.command)).toEqual([binary, binary]);
  });

  it("reports incomplete onboarding as Pending without running verification", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const { io, questions } = fakeIo([false]);

    const result = await component.execute(executeInput(installedDetection(), { io }));

    expect(result.outcome).toBe("Pending");
    expect(result.detail).toContain("not confirmed");
    expect(result.configPatches).toBeUndefined();
    expect(calls).toEqual([]);
    expect(questions).toHaveLength(1);
  });

  it("skips the optional handoff with no opener when its consent is declined", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const { io, questions } = fakeIo([false]);

    const result = await component.execute(executeInput({ installed: false, certified: false }, { io }));

    expect(result.outcome).toBe("Skipped");
    expect(result.detail).toContain("no browser was opened");
    expect(result.configPatches).toBeUndefined();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Open the official ego-lite download page");
    expect(calls).toEqual([]);
  });

  it("reports a genuine simulated Windows opener spawn failure before asking for onboarding consent", async () => {
    const { io, questions } = fakeIo([true, true]);
    const component = createEgoComponent({
      commandRunner: async (call) => {
        expect(call.command).toBe("explorer.exe");
        throw new Error("spawn explorer.exe ENOENT");
      },
    });

    const result = await component.execute(executeInput(
      { installed: false, certified: false },
      { io, overrides: simulatedPlatform("win32") },
    ));

    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("spawn explorer.exe ENOENT");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Open the official ego-lite download page");
  });

  it("reports a failed native entry check as Failed after consent", async () => {
    const { runner } = recorder({ native: { exitCode: 1, stderr: "native entry unavailable" } });
    const component = createEgoComponent({ commandRunner: runner });

    const result = await component.execute(executeInput(installedDetection()));

    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("native entry unavailable");
  });

  it("rejects a native entry that prints the wrong marker", async () => {
    const { runner } = recorder({ native: { stdout: "unexpected output" } });
    const component = createEgoComponent({ commandRunner: runner });

    const result = await component.execute(executeInput(installedDetection()));

    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("expected marker");
  });
});

describe("optional ego outcome exit semantics", () => {
  function baseline(extra: Partial<InitComponentResult>): InitComponentResult[] {
    return [
      { component: "firecrawl", label: "Firecrawl Local", outcome: "Installed", required: true, selected: true, warnings: [], detail: "" },
      { component: "configuration", label: "Configuration", outcome: "Configured", required: true, selected: true, warnings: [], detail: "" },
      {
        component: "ego", label: "ego-lite", outcome: "Pending", required: false, selected: true, warnings: [], detail: "",
        ...extra,
      },
    ];
  }

  it("does not fail a ready baseline for optional Pending or Skipped", () => {
    expect(initExitCode(baseline({ outcome: "Pending" }))).toBe(0);
    expect(initExitCode(baseline({ outcome: "Skipped" }))).toBe(0);
  });

  it("fails the run when a selected ego verification actually fails", () => {
    expect(initExitCode(baseline({ outcome: "Failed" }))).toBe(1);
  });
});
