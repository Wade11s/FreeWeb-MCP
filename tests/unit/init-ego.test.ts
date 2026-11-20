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
): { io: InitIo; questions: string[] } {
  const questions: string[] = [];
  let index = 0;
  return {
    questions,
    io: {
      prompt: {
        interactive: true,
        confirm: async (question) => {
          questions.push(question);
          expect(peek?.() ?? []).toEqual([]);
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

  it("reports unsupported platforms as Skipped with an explanation and no installer", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const detection = await component.detect(env({ FREEWEB_INIT_PLATFORM: "linux" }), { status: "absent" });
    expect(detection.warnings?.[0]?.code).toBe("EgoPlatformUnsupported");
    expect(component.plan(detection)[0]!.description).toContain("linux");

    const prompts: string[] = [];
    const result = await component.execute({
      ...executeInput(detection, { overrides: { FREEWEB_INIT_PLATFORM: "linux" } }),
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
    const { io } = fakeIo([true], () => calls);

    const result = await component.execute(executeInput(installedDetection(), { io }));

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

  it("opens the exact official URL through explorer.exe in a simulated Windows flow", async () => {
    const { runner, calls } = recorder();
    const component = createEgoComponent({ commandRunner: runner });
    const overrides = { FREEWEB_INIT_PLATFORM: "win32" };
    let callsAtConfirmation: number = -1;
    const { io, questions } = fakeIo([true]);
    io.prompt.confirm = async (question) => {
      questions.push(question);
      callsAtConfirmation = calls.length;
      return true;
    };

    const result = await component.execute(executeInput({ installed: false, certified: false }, { io, overrides }));

    expect(result.outcome).toBe("Installed");
    expect(calls[0]).toMatchObject({ command: "explorer.exe", args: [EGO_DOWNLOAD_URL] });
    expect(callsAtConfirmation).toBe(1);
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

      await component.execute(executeInput({ installed: false, certified: false }));

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
    const result = await component.execute(executeInput({ installed: false, certified: false }));

    expect(result.outcome).toBe("Installed");
    expect(result.configPatches).toEqual([{ setting: "ego.binary", value: binary }]);
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

  it("reports an installer-launch failure as Failed before asking for onboarding consent", async () => {
    const { io, questions } = fakeIo([true]);
    const component = createEgoComponent({
      commandRunner: async () => { throw new Error("simulated open failure"); },
    });

    const result = await component.execute(executeInput({ installed: false, certified: false }, { io }));

    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("simulated open failure");
    expect(questions).toEqual([]);
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
