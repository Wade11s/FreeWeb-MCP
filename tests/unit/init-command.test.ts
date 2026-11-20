import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { runInit, type InitDeps } from "../../src/init/command.js";
import type { InitComponent } from "../../src/init/component.js";
import { ConfigStore, defaultConfigFile } from "../../src/init/config-store.js";
import type { InitIo } from "../../src/init/prompt.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-command-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function requiredComponent(): InitComponent {
  return {
    id: "firecrawl",
    label: "Required test component",
    required: true,
    detect: async () => ({ installed: true, certified: true }),
    plan: () => [],
    verify: async () => ({ ok: true }),
    execute: async () => ({
      component: "firecrawl",
      label: "Required test component",
      outcome: "Installed",
      required: true,
      selected: true,
      warnings: [],
      detail: "ready",
    }),
  };
}

describe("generic init configuration contributions", () => {
  it("writes detection, confirmed repair, and execution patches once after a throwaway component executes, with redaction", async () => {
    const secret = "unit-test-tinyfish-secret-do-not-print";
    const configPath = join(root, "config.json");
    const original = defaultConfigFile();
    original.firecrawl.binary = secret;
    await writeFile(configPath, JSON.stringify(original));
    const events: string[] = [];

    class OneWriteStore extends ConfigStore {
      writes = 0;
      override async write(path: string, value: unknown): Promise<void> {
        this.writes += 1;
        events.push("write");
        await super.write(path, value);
      }
    }
    const store = new OneWriteStore();
    const throwaway: InitComponent = {
      id: "throwaway",
      label: "Throwaway",
      required: false,
      detect: async () => ({
        installed: true,
        certified: true,
        notes: [`detection note ${secret}`],
        warnings: [{ code: "TestWarning", message: `detection warning ${secret}` }],
        configPatches: [{ setting: "ego.binary", value: "/detected/ego-browser" }],
        repairs: [{
          component: "throwaway",
          setting: "firecrawl.binary",
          oldValue: secret,
          newValue: "/confirmed/firecrawl-local",
        }],
      }),
      plan: (detection) => [{
        component: "throwaway",
        action: "configure",
        description: `configure with ${detection.notes![0]}`,
        required: false,
        selected: true,
      }],
      verify: async () => ({ ok: true }),
      execute: async ({ detection, appliedRepairs }) => {
        events.push("throwaway execute");
        expect(appliedRepairs.map((repair) => repair.newValue)).toEqual(["/confirmed/firecrawl-local"]);
        // Execution still sees the original file: even recovery/rebuild and
        // detection patches cannot write before every component has run.
        expect(await readFile(configPath, "utf8")).toBe(JSON.stringify(original));
        return {
          component: "throwaway",
          label: "Throwaway",
          outcome: "Configured",
          required: false,
          selected: true,
          warnings: [{ code: "ResultWarning", message: `result warning ${secret}` }],
          detail: `result detail ${secret}; ${detection.notes![0]}`,
          configPatches: [{ setting: "tinyfish.freeOnlyConfirmed", value: true }],
        };
      },
    };

    const output: string[] = [];
    const questions: string[] = [];
    const io: InitIo = {
      prompt: {
        interactive: true,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
        close: () => {},
      },
      writeLine: (line) => output.push(line),
      errorLine: (line) => output.push(line),
    };
    const deps: InitDeps = {
      env: { TINYFISH_API_KEY: secret },
      configPath,
      components: [requiredComponent(), throwaway],
      store,
      runDoctor: async () => ({ ok: true, checks: [] }),
      loadAppConfig: (options) => loadConfig(options),
    };

    expect(await runInit(io, deps)).toBe(0);

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.ego.binary).toBe("/detected/ego-browser");
    expect(written.firecrawl.binary).toBe("/confirmed/firecrawl-local");
    expect(written.tinyfish.freeOnlyConfirmed).toBe(true);
    expect(written.tinyfish.apiKey).toBeUndefined();
    expect(store.writes).toBe(1);
    expect(events).toEqual(["throwaway execute", "write"]);
    const rendered = [...output, ...questions].join("\n");
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("[redacted]");
  });
});

describe("init component exception boundary", () => {
  it("redacts a credential thrown by a throwaway component before CLI output", async () => {
    const secret = "unit-thrown-api-key-rdlxycvbbn";
    const configPath = join(root, "config.json");
    const output: string[] = [];
    const io: InitIo = {
      prompt: { interactive: true, confirm: async () => true, close: () => {} },
      writeLine: (line) => output.push(line),
      errorLine: (line) => output.push(line),
    };
    const hostile: InitComponent = {
      id: "throwaway",
      label: "Hostile throwaway",
      required: false,
      detect: async () => ({ installed: true, certified: true }),
      plan: () => [],
      verify: async () => ({ ok: true }),
      execute: async () => {
        throw new Error(`hostile execute leaked ${secret}`);
      },
    };
    const deps: InitDeps = {
      env: { TINYFISH_API_KEY: secret },
      configPath,
      components: [hostile],
      store: new ConfigStore(),
      runDoctor: async () => ({ ok: true, checks: [] }),
      loadAppConfig: (options) => loadConfig(options),
    };

    expect(await runInit(io, deps)).toBe(1);

    const rendered = output.join("\n");
    expect(rendered).toContain("Initialization failed: hostile execute leaked [redacted]");
    expect(rendered).not.toContain(secret);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
