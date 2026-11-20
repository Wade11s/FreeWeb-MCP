import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { runInitDetailed, type InitDeps } from "../../src/init/command.js";
import type { InitComponent } from "../../src/init/component.js";
import { ConfigStore } from "../../src/init/config-store.js";
import type { InitChoice, InitChoiceOptions, InitIo } from "../../src/init/prompt.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-report-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function requiredComponent(): InitComponent {
  return {
    id: "firecrawl",
    label: "Firecrawl Local",
    required: true,
    actionLabel: () => "Verify required test component",
    detect: async () => ({ installed: true, certified: true }),
    plan: () => [],
    verify: async () => ({ ok: true }),
    execute: async () => ({
      component: "firecrawl",
      label: "Firecrawl Local",
      outcome: "Installed",
      required: true,
      selected: true,
      warnings: [],
      detail: "ready",
    }),
  };
}

function reportIo(
  choose: (question: string, choices: readonly InitChoice[], defaultId: string, options?: InitChoiceOptions) => Promise<string>,
  interactive = true,
): InitIo {
  return {
    prompt: { interactive, choose, close: () => {} },
    writeLine: () => {},
    errorLine: () => {},
  };
}

function reportDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    env: {},
    configPath: join(root, "report-config.json"),
    components: [requiredComponent()],
    store: new ConfigStore(),
    runDoctor: async () => ({ ok: true, checks: [{ name: "baseline", ok: true, required: true }] }),
    loadAppConfig: (options) => loadConfig(options),
    ...overrides,
  };
}

describe("versioned init execution reports", () => {
  it("reports a non-TTY refusal as a failed run with no steps", async () => {
    const execution = await runInitDetailed(
      reportIo(async () => { throw new Error("must not prompt"); }, false),
      reportDeps(),
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report).toMatchObject({
      schemaVersion: 1,
      command: "init",
      ok: false,
      status: "failed",
      steps: [],
      doctor: null,
      error: { code: "TERMINAL_REQUIRED" },
    });
  });

  it("reports every completed step and the Doctor result", async () => {
    const execution = await runInitDetailed(reportIo(async (_question, choices) => choices[0]!.id), reportDeps());

    expect(execution.exitCode).toBe(0);
    expect(execution.report.status).toBe("succeeded");
    expect(execution.report.steps.map((step) => step.id)).toEqual(["inspection", "firecrawl", "configuration", "doctor"]);
    expect(execution.report.steps.every((step) => step.status === "succeeded")).toBe(true);
    expect(execution.report.doctor?.ok).toBe(true);
    expect(execution.report.nextSteps.join("\n")).toContain("print-config");
  });

  it("cancels before a pending configuration write and preserves completed step evidence", async () => {
    const deps = reportDeps();
    const execution = await runInitDetailed(reportIo(async (question, choices, defaultId) => {
      if (question.includes("Apply the selected settings")) return "quit";
      return choices[0]?.id ?? defaultId;
    }), deps);

    expect(execution.exitCode).toBe(1);
    expect(execution.report.status).toBe("cancelled");
    expect(execution.report.steps.at(-1)).toMatchObject({ id: "configuration", status: "cancelled" });
    expect(execution.report.steps.find((step) => step.id === "firecrawl")).toMatchObject({ status: "succeeded", outcome: "Installed" });
    expect(execution.report.doctor).toBeNull();
    await expect(readFile(deps.configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries only the failed step and records its attempt count", async () => {
    let executions = 0;
    const component = requiredComponent();
    component.execute = async () => {
      executions += 1;
      return {
        component: "firecrawl",
        label: "Firecrawl Local",
        outcome: executions === 1 ? "Failed" : "Installed",
        required: true,
        selected: true,
        warnings: [],
        detail: executions === 1 ? "transient failure" : "ready after retry",
      };
    };
    const execution = await runInitDetailed(reportIo(async (question, choices) => {
      if (question.includes("This step failed")) return "retry";
      return choices[0]!.id;
    }), reportDeps({ components: [component] }));

    expect(execution.exitCode).toBe(0);
    expect(executions).toBe(2);
    expect(execution.report.steps.find((step) => step.id === "firecrawl")).toMatchObject({
      status: "succeeded",
      attempts: 2,
      detail: "ready after retry",
    });
  });

  it("does not persist detection or execution patches from failed or skipped results", async () => {
    for (const outcome of ["Failed", "Skipped"] as const) {
      const id = outcome.toLowerCase();
      const component: InitComponent = {
        id,
        label: `${outcome} optional component`,
        required: false,
        actionLabel: () => `Run ${outcome}`,
        detect: async () => ({
          installed: true,
          certified: true,
          configPatches: [{ setting: "ego.binary", value: `/detection-${outcome}` }],
        }),
        plan: () => [],
        verify: async () => ({ ok: true }),
        execute: async () => ({
          component: id,
          label: `${outcome} optional component`,
          outcome,
          required: false,
          selected: true,
          warnings: [],
          detail: `${outcome} result with patches that must not persist`,
          configPatches: [{ setting: "ego.binary", value: `/execution-${outcome}` }],
        }),
      };
      const configPath = join(root, `${id}-patches.json`);
      const execution = await runInitDetailed(reportIo(async (question, choices) => {
        if (question.includes("This step failed")) return "continue";
        return choices[0]!.id;
      }), reportDeps({ configPath, components: [requiredComponent(), component] }));

      expect(execution.exitCode).toBe(outcome === "Failed" ? 1 : 0);
      const written = JSON.parse(await readFile(configPath, "utf8")) as { ego: { binary: string } };
      expect(written.ego.binary).toBe("ego-browser");
    }
  });

  it("fails the run when Doctor cannot run even if component results are ready", async () => {
    const execution = await runInitDetailed(reportIo(async (question, choices) => {
      if (question.includes("This step failed")) return "continue";
      return choices[0]!.id;
    }), reportDeps({
      loadAppConfig: async () => { throw new Error("simulated config load failure"); },
    }));

    expect(execution.exitCode).toBe(1);
    expect(execution.report.status).toBe("failed");
    expect(execution.report.doctor).toBeNull();
    expect(execution.report.steps.at(-1)).toMatchObject({ id: "doctor", status: "failed" });
  });

  it("continues after a backup failure without rebuilding the damaged file", async () => {
    class BackupFailStore extends ConfigStore {
      writes = 0;
      override async backup(): Promise<string> {
        throw new Error("simulated backup failure");
      }
      override async write(path: string, value: unknown): Promise<void> {
        this.writes += 1;
        await super.write(path, value);
      }
    }
    const store = new BackupFailStore();
    const deps = reportDeps({ store });
    await writeFile(deps.configPath, "{ damaged");
    let failureChoices: readonly InitChoice[] = [];
    let failureDefault = "";
    let failureOptions: InitChoiceOptions | undefined;
    const execution = await runInitDetailed(reportIo(async (question, choices, defaultId, options) => {
      if (question.includes("This step failed")) {
        failureChoices = choices;
        failureDefault = defaultId;
        failureOptions = options;
        return "continue";
      }
      return choices[0]!.id;
    }), deps);

    expect(failureChoices.map((choice) => choice.id)).toEqual(["retry", "continue", "quit"]);
    expect(failureDefault).toBe("continue");
    expect(failureOptions).toEqual({ legacyYes: "default" });
    expect(execution.exitCode).toBe(1);
    expect(execution.report.status).toBe("failed");
    expect(execution.report.steps.find((step) => step.id === "inspection")).toMatchObject({
      status: "failed",
      detail: "Read-only detection completed, but the confirmed backup failed: simulated backup failure",
    });
    expect(execution.report.steps.find((step) => step.id === "configuration")).toMatchObject({
      status: "failed",
      detail: "configuration rebuild blocked because the required backup failed: simulated backup failure",
    });
    expect(store.writes).toBe(0);
    expect(await readFile(deps.configPath, "utf8")).toBe("{ damaged");
  });

  it("preserves unsupported-platform detection warnings when an optional step is skipped", async () => {
    const unsupported: InitComponent = {
      id: "ego",
      label: "ego-lite",
      required: false,
      actionLabel: () => "Set up ego-lite",
      detect: async () => ({
        installed: false,
        certified: false,
        notes: ["ego-lite setup is supported only on macOS and Windows; linux is unsupported"],
        warnings: [{ code: "EgoPlatformUnsupported", message: "Managed Browse is unavailable on linux" }],
      }),
      plan: () => [],
      verify: async () => ({ ok: true }),
      execute: async () => { throw new Error("a skipped component must not execute"); },
    };
    const execution = await runInitDetailed(reportIo(async (question, choices, defaultId) => {
      if (question.includes("What do you want to do with ego-lite")) return "skip";
      return choices[0]?.id ?? defaultId;
    }), reportDeps({ components: [requiredComponent(), unsupported] }));

    expect(execution.exitCode).toBe(0);
    expect(execution.report.steps.find((step) => step.id === "ego")).toMatchObject({
      status: "skipped",
      warnings: [{ code: "EgoPlatformUnsupported", message: "Managed Browse is unavailable on linux" }],
      detail: "optional setup was skipped at its step; the component action did not run; ego-lite setup is supported only on macOS and Windows; linux is unsupported",
    });
  });

  it("redacts credentials throughout the machine report", async () => {
    const secret = "machine-report-credential-canary";
    const component = requiredComponent();
    component.execute = async () => ({
      component: "firecrawl",
      label: "Firecrawl Local",
      outcome: "Installed",
      required: true,
      selected: true,
      warnings: [{ code: "Test", message: `warning ${secret}` }],
      detail: `ready ${secret}`,
    });
    const execution = await runInitDetailed(
      reportIo(async (_question, choices) => choices[0]!.id),
      reportDeps({ env: { TINYFISH_API_KEY: secret }, components: [component] }),
    );

    expect(JSON.stringify(execution.report)).not.toContain(secret);
    expect(JSON.stringify(execution.report)).toContain("[redacted]");
  });

  it("redacts raw credentials before JSON escaping in nested step and Doctor fields", async () => {
    const secret = "quote\" backslash\\ newline\n tab\t end";
    const component = requiredComponent();
    component.execute = async () => ({
      component: "firecrawl",
      label: "Firecrawl Local",
      outcome: "Installed",
      required: true,
      selected: true,
      warnings: [{ code: "Test", message: `warning ${secret}` }],
      detail: `ready ${secret}`,
    });
    const execution = await runInitDetailed(
      reportIo(async (_question, choices) => choices[0]!.id),
      reportDeps({
        env: { TINYFISH_API_KEY: secret },
        components: [component],
        runDoctor: async () => ({
          ok: true,
          checks: [{ name: "baseline", ok: true, required: true, message: `doctor ${secret}` }],
        }),
      }),
    );

    const componentStep = execution.report.steps.find((step) => step.id === "firecrawl");
    expect(componentStep?.detail).toBe("ready [redacted]");
    expect(componentStep?.warnings[0]?.message).toBe("warning [redacted]");
    expect(execution.report.doctor?.checks[0]?.message).toBe("doctor [redacted]");
    expect(JSON.stringify(execution.report)).not.toContain('quote"');
  });
});
