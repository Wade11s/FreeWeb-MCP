import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { runInit, type InitDeps } from "../../src/init/command.js";
import type { InitComponent } from "../../src/init/component.js";
import { ConfigStore } from "../../src/init/config-store.js";
import type { InitOutcome, InitWarning } from "../../src/init/outcomes.js";
import type { InitIo } from "../../src/init/prompt.js";

let root: string;
let home: string;
let configPath: string;
let otherClients: Map<string, string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-all-components-"));
  home = join(root, "home");
  configPath = join(root, "config", "config.json");
  await mkdir(join(home, ".cursor"), { recursive: true });
  otherClients = new Map([
    [join(home, ".claude.json"), JSON.stringify({ mcpServers: { existing: { command: "keep" } } })],
    [join(home, ".cursor", "config.json"), JSON.stringify({ keep: true })],
  ]);
  for (const [path, content] of otherClients) await writeFile(path, content);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type RequiredReadiness = "Installed" | "Pending" | "Failed";
type OptionalDecision = "ready" | "pending" | "failed" | "decline";

interface MatrixRow {
  readonly name: string;
  readonly required?: RequiredReadiness;
  readonly tinyfish: OptionalDecision;
  readonly ego: OptionalDecision;
  readonly configuration?: "ready" | "write-fails";
  readonly doctor?: "ready" | "failed";
  readonly uncertified?: boolean;
  readonly expected: {
    readonly firecrawl: InitOutcome;
    readonly tinyfish: InitOutcome;
    readonly ego: InitOutcome;
    readonly configuration: InitOutcome;
    readonly exitCode: number;
  };
}

const matrix: readonly MatrixRow[] = [
  {
    name: "all accepted and ready",
    tinyfish: "ready",
    ego: "ready",
    expected: { firecrawl: "Installed", tinyfish: "Configured", ego: "Installed", configuration: "Configured", exitCode: 0 },
  },
  {
    name: "all optional components declined",
    tinyfish: "decline",
    ego: "decline",
    expected: { firecrawl: "Installed", tinyfish: "Skipped", ego: "Skipped", configuration: "Configured", exitCode: 0 },
  },
  {
    name: "TinyFish accepted and ego declined",
    tinyfish: "ready",
    ego: "decline",
    expected: { firecrawl: "Installed", tinyfish: "Configured", ego: "Skipped", configuration: "Configured", exitCode: 0 },
  },
  {
    name: "TinyFish declined and ego accepted",
    tinyfish: "decline",
    ego: "ready",
    expected: { firecrawl: "Installed", tinyfish: "Skipped", ego: "Installed", configuration: "Configured", exitCode: 0 },
  },
  {
    name: "all accepted with both optional capabilities pending",
    tinyfish: "pending",
    ego: "pending",
    expected: { firecrawl: "Installed", tinyfish: "Pending", ego: "Pending", configuration: "Configured", exitCode: 0 },
  },
  {
    name: "TinyFish pending and ego declined",
    tinyfish: "pending",
    ego: "decline",
    expected: { firecrawl: "Installed", tinyfish: "Pending", ego: "Skipped", configuration: "Configured", exitCode: 0 },
  },
  {
    name: "TinyFish declined and ego pending",
    tinyfish: "decline",
    ego: "pending",
    expected: { firecrawl: "Installed", tinyfish: "Skipped", ego: "Pending", configuration: "Configured", exitCode: 0 },
  },
  {
    name: "selected TinyFish failure with ego ready",
    tinyfish: "failed",
    ego: "ready",
    expected: { firecrawl: "Installed", tinyfish: "Failed", ego: "Installed", configuration: "Configured", exitCode: 1 },
  },
  {
    name: "TinyFish ready with selected ego failure",
    tinyfish: "ready",
    ego: "failed",
    expected: { firecrawl: "Installed", tinyfish: "Configured", ego: "Failed", configuration: "Configured", exitCode: 1 },
  },
  {
    name: "both selected optional operations fail",
    tinyfish: "failed",
    ego: "failed",
    expected: { firecrawl: "Installed", tinyfish: "Failed", ego: "Failed", configuration: "Configured", exitCode: 1 },
  },
  {
    name: "required Firecrawl pending with optional components ready",
    required: "Pending",
    tinyfish: "ready",
    ego: "ready",
    expected: { firecrawl: "Pending", tinyfish: "Configured", ego: "Installed", configuration: "Configured", exitCode: 1 },
  },
  {
    name: "required Firecrawl pending with optional components declined",
    required: "Pending",
    tinyfish: "decline",
    ego: "decline",
    expected: { firecrawl: "Pending", tinyfish: "Skipped", ego: "Skipped", configuration: "Configured", exitCode: 1 },
  },
  {
    name: "required Firecrawl failed with optional components ready",
    required: "Failed",
    tinyfish: "ready",
    ego: "ready",
    expected: { firecrawl: "Failed", tinyfish: "Configured", ego: "Installed", configuration: "Configured", exitCode: 1 },
  },
  {
    name: "required Firecrawl failed with optional components declined",
    required: "Failed",
    tinyfish: "decline",
    ego: "decline",
    expected: { firecrawl: "Failed", tinyfish: "Skipped", ego: "Skipped", configuration: "Configured", exitCode: 1 },
  },
  {
    name: "base configuration write failure with optional components ready",
    tinyfish: "ready",
    ego: "ready",
    configuration: "write-fails",
    expected: { firecrawl: "Installed", tinyfish: "Configured", ego: "Installed", configuration: "Failed", exitCode: 1 },
  },
  {
    name: "base configuration write failure with optional components declined",
    tinyfish: "decline",
    ego: "decline",
    configuration: "write-fails",
    expected: { firecrawl: "Installed", tinyfish: "Skipped", ego: "Skipped", configuration: "Failed", exitCode: 1 },
  },
  {
    name: "required doctor failure despite otherwise ready selections",
    tinyfish: "ready",
    ego: "ready",
    doctor: "failed",
    expected: { firecrawl: "Installed", tinyfish: "Configured", ego: "Installed", configuration: "Configured", exitCode: 1 },
  },
  {
    name: "uncertified warning and optional non-readiness do not fail a usable baseline",
    tinyfish: "pending",
    ego: "decline",
    uncertified: true,
    expected: { firecrawl: "Installed", tinyfish: "Pending", ego: "Skipped", configuration: "Configured", exitCode: 0 },
  },
];

function requiredComponent(outcome: RequiredReadiness, uncertified: boolean): InitComponent {
  const warnings: readonly InitWarning[] = uncertified
    ? [{ code: "Uncertified", message: "existing Firecrawl version is not certified and was left untouched" }]
    : [];
  return {
    id: "firecrawl",
    label: "Firecrawl Local",
    required: true,
    detect: async () => ({ installed: true, certified: !uncertified }),
    plan: () => [{
      component: "firecrawl",
      action: "verify",
      description: "verify required Firecrawl",
      required: true,
      selected: true,
    }],
    verify: async () => ({ ok: outcome === "Installed" }),
    execute: async () => ({
      component: "firecrawl",
      label: "Firecrawl Local",
      outcome,
      required: true,
      selected: true,
      warnings,
      detail: `matrix required ${outcome}`,
    }),
  };
}

function optionalComponent(
  id: "tinyfish" | "ego",
  decision: OptionalDecision,
): InitComponent {
  const label = id === "tinyfish" ? "TinyFish Search/Fetch" : "ego-lite";
  const readyOutcome: InitOutcome = id === "tinyfish" ? "Configured" : "Installed";
  return {
    id,
    label,
    required: false,
    detect: async () => ({ installed: true, certified: true }),
    plan: () => [{
      component: id,
      action: "configure",
      description: `default-selected optional ${label}`,
      required: false,
      selected: true,
    }],
    verify: async () => ({ ok: decision !== "failed" }),
    execute: async ({ io }) => {
      const accepted = await io.prompt.confirm(`Select optional ${label}? [y/N]`);
      const base = { component: id, label, required: false } as const;
      if (!accepted) {
        return { ...base, outcome: "Skipped", selected: false, warnings: [], detail: "matrix declined" };
      }
      const outcome: InitOutcome = decision === "ready"
        ? readyOutcome
        : decision === "pending"
          ? "Pending"
          : decision === "failed"
            ? "Failed"
            : "Skipped";
      return { ...base, outcome, selected: true, warnings: [], detail: `matrix ${outcome}` };
    },
  };
}

function fakeIo(answers: readonly boolean[]): { io: InitIo; output: string[]; questions: string[] } {
  const remaining = [...answers];
  const output: string[] = [];
  const questions: string[] = [];
  return {
    output,
    questions,
    io: {
      prompt: {
        interactive: true,
        confirm: async (question) => {
          questions.push(question);
          return remaining.shift() ?? false;
        },
        close: () => {},
      },
      writeLine: (line) => output.push(line),
      errorLine: (line) => output.push(line),
    },
  };
}

class WriteFailingStore extends ConfigStore {
  override async write(): Promise<void> {
    throw new Error("simulated combined-flow write failure");
  }
}

describe("combined init component/readiness/confirmation matrix", () => {
  for (const row of matrix) {
    it(row.name, async () => {
      const fake = fakeIo([true, row.tinyfish !== "decline", row.ego !== "decline"]);
      let doctorCalls = 0;
      const doctorReady = row.doctor !== "failed";
      const deps: InitDeps = {
        env: {
          HOME: home,
          FREEWEB_DATA_DIR: join(root, "data"),
        },
        configPath,
        components: [
          requiredComponent(row.required ?? "Installed", row.uncertified === true),
          optionalComponent("tinyfish", row.tinyfish),
          optionalComponent("ego", row.ego),
        ],
        store: row.configuration === "write-fails" ? new WriteFailingStore() : new ConfigStore(),
        runDoctor: async () => {
          doctorCalls += 1;
          return {
            ok: doctorReady,
            checks: [{
              name: "matrix-baseline",
              ok: doctorReady,
              required: true,
              message: doctorReady ? "ready" : "simulated required doctor failure",
            }],
          };
        },
        loadAppConfig: (options) => loadConfig(options),
      };

      const code = await runInit(fake.io, deps);
      const output = fake.output.join("\n");

      expect(code).toBe(row.expected.exitCode);
      for (const [label, outcome] of [
        ["Firecrawl Local", row.expected.firecrawl],
        ["TinyFish Search/Fetch", row.expected.tinyfish],
        ["ego-lite", row.expected.ego],
        ["Configuration", row.expected.configuration],
      ] as const) {
        const summaryLine = fake.output.find((line) => line.startsWith(`  ${label}: `));
        expect(summaryLine, label).toContain(`${label}: ${outcome}`);
      }
      expect(output).toContain("[required] Firecrawl Local: verify required Firecrawl");
      expect(output).toContain("[optional] TinyFish Search/Fetch: default-selected optional TinyFish Search/Fetch");
      expect(output).toContain("[optional] ego-lite: default-selected optional ego-lite");
      expect(output).toContain("freeweb-mcp print-config");
      expect(output).toContain(row.expected.exitCode === 0
        ? "Result: Initialization command succeeded"
        : "Result: Initialization command did not complete successfully");
      if (row.expected.exitCode === 0) {
        expect(output).toContain("does not mean every optional capability is ready");
      }
      if (row.uncertified) expect(output).toContain("warning [Uncertified]");
      if (row.configuration !== "write-fails") expect(doctorCalls).toBe(1);

      for (const [path, content] of otherClients) {
        expect(await readFile(path, "utf8")).toBe(content);
      }
    });
  }
});
