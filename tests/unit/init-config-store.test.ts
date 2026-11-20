import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigStore,
  completeExistingConfig,
  highRiskSettingWarnings,
  newConfigFile,
  nodeInitFilesystem,
  setPath,
  type InitFilesystem,
} from "../../src/init/config-store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-init-store-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function configPath(name = "config.json"): string {
  return join(root, name);
}

describe("config classification", () => {
  it("classifies a missing file as absent", async () => {
    expect(await new ConfigStore().classify(configPath())).toEqual({ status: "absent" });
  });

  it("classifies unparsable JSON as malformed without echoing its contents", async () => {
    const secret = "config-parser-secret";
    await writeFile(configPath(), `{ "TINYFISH_API_KEY": "${secret}", }`);
    const classification = await new ConfigStore().classify(configPath());
    expect(classification).toEqual({ status: "malformed", message: "not valid JSON" });
    expect(JSON.stringify(classification)).not.toContain(secret);
  });

  it("classifies schema-invalid JSON separately with bounded issues", async () => {
    await writeFile(configPath(), JSON.stringify({ firecrawl: { port: "nope", allowPrivate: "yes" }, extra: 1 }));
    const classification = await new ConfigStore().classify(configPath());
    expect(classification.status).toBe("schema-invalid");
    if (classification.status === "schema-invalid") {
      expect(classification.issues.length).toBeGreaterThan(0);
      expect(classification.issues.length).toBeLessThanOrEqual(5);
      expect(classification.issues.join("; ")).toContain("firecrawl.port");
    }
  });

  it("classifies a valid file as ok with its raw values", async () => {
    await writeFile(configPath(), JSON.stringify({ firecrawl: { port: 3456 } }));
    const classification = await new ConfigStore().classify(configPath());
    expect(classification).toEqual({ status: "ok", raw: { firecrawl: { port: 3456 } } });
  });
});

describe("new configuration defaults", () => {
  it("uses conservative schema defaults with no resolved binary", () => {
    const file = newConfigFile();
    expect(file.firecrawl.allowPrivate).toBe(false);
    expect(file.firecrawl.searchFallback).toBe(false);
    expect(file.ego.unrestricted).toBe(false);
    expect(file.ego.allowPrivate).toBe(false);
    expect(file.tinyfish.freeOnlyConfirmed).toBe(false);
    expect(file.firecrawl.host).toBe("127.0.0.1");
  });

  it("uses the runtime default binary until a component contributes a resolved path", () => {
    expect(newConfigFile().firecrawl.binary).toBe("firecrawl-local");
  });
});

describe("existing configuration completion", () => {
  it("preserves every explicit value and adds only missing safe defaults", () => {
    const raw = { dataDir: "/custom/data", firecrawl: { port: 3456 }, artifacts: { retentionMs: 120_000 } };
    const { merged, added } = completeExistingConfig(raw);
    expect(merged.dataDir).toBe("/custom/data");
    expect(merged.firecrawl.port).toBe(3456);
    expect(merged.artifacts.retentionMs).toBe(120_000);
    expect(merged.limits.maxCrawlJobs).toBe(3);
    expect(added).toContain("tinyfish.freeOnlyConfirmed");
    expect(added).toContain("firecrawl.allowPrivate");
    expect(added).not.toContain("firecrawl.port");
    expect(added).not.toContain("artifacts.retentionMs");
  });

  it("reports every default as added for a fully partial file", () => {
    const { added } = completeExistingConfig({});
    expect(added.length).toBeGreaterThan(20);
  });

  it("flags explicit high-risk settings without changing them", () => {
    const raw = {
      tinyfish: { freeOnlyConfirmed: true },
      firecrawl: { allowPrivate: true, searchFallback: true },
      ego: { unrestricted: true, allowPrivate: true },
    };
    const warnings = highRiskSettingWarnings(raw);
    expect(warnings.map((warning) => warning.message.split("=")[0])).toEqual([
      "tinyfish.freeOnlyConfirmed",
      "firecrawl.allowPrivate",
      "firecrawl.searchFallback",
      "ego.allowPrivate",
      "ego.unrestricted",
    ]);
    expect(raw.firecrawl.allowPrivate).toBe(true);
    expect(highRiskSettingWarnings({ firecrawl: { allowPrivate: false } })).toEqual([]);
  });

  it("sets a dotted repair path on a copy", () => {
    const merged = newConfigFile() as unknown as Record<string, unknown>;
    const repaired = setPath(merged, "firecrawl.binary", "/new");
    expect((repaired.firecrawl as { binary: string }).binary).toBe("/new");
    expect((merged.firecrawl as { binary: string }).binary).toBe("firecrawl-local");
  });
});

describe("atomic configuration writes", () => {
  it("writes complete JSON with mode 0600 inside a 0700 directory and leaves no temp files", async () => {
    const store = new ConfigStore();
    const path = join(root, "config", "config.json");
    await store.write(path, newConfigFile());
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.firecrawl.allowPrivate).toBe(false);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(dirname(path))).toEqual(["config.json"]);
  });

  it("replaces an existing file and leaves the original intact when rename fails", async () => {
    const path = configPath();
    const original = `${JSON.stringify({ firecrawl: { port: 3456 } }, null, 2)}\n`;
    await writeFile(path, original);
    const interrupted: InitFilesystem = {
      ...nodeInitFilesystem,
      rename: async () => {
        throw new Error("simulated interruption: rename refused");
      },
    };
    await expect(new ConfigStore(interrupted).write(path, newConfigFile())).rejects.toMatchObject({
      code: "INIT_WRITE_FAILED",
    });
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(root)).toEqual(["config.json"]);
  });

  it("leaves the original intact when the temp write itself fails midway", async () => {
    const path = configPath();
    const original = "{}\n";
    await writeFile(path, original);
    const interrupted: InitFilesystem = {
      ...nodeInitFilesystem,
      open: async () => ({
        write: async () => {
          throw new Error("simulated interruption: disk full");
        },
        sync: async () => {},
        close: async () => {},
      }),
    };
    await expect(new ConfigStore(interrupted).write(path, newConfigFile())).rejects.toMatchObject({
      code: "INIT_WRITE_FAILED",
    });
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

describe("non-overwriting backups", () => {
  it("backs up to the first free name and never clobbers an earlier backup", async () => {
    const store = new ConfigStore();
    const path = configPath();
    await writeFile(path, "first-damaged");

    const first = await store.backup(path);
    expect(first).toBe(configPath("config.backup.json"));
    await writeFile(path, "second-damaged");

    const second = await store.backup(path);
    expect(second).toBe(configPath("config.backup.1.json"));
    expect(await readFile(first, "utf8")).toBe("first-damaged");
    expect(await readFile(second, "utf8")).toBe("second-damaged");
    expect(await store.proposedBackupPath(path)).toBe(configPath("config.backup.2.json"));
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(first)).mode & 0o777).toBe(0o600);
      expect((await stat(second)).mode & 0o777).toBe(0o600);
    }
  });

  it("proposes the first free name before any write happens", async () => {
    const store = new ConfigStore();
    expect(await store.proposedBackupPath(configPath())).toBe(configPath("config.backup.json"));
  });

  it("fails a backup cleanly when the source disappeared", async () => {
    const store = new ConfigStore();
    await mkdir(join(root, "gone"), { recursive: true });
    const missing = join(root, "gone", "config.json");
    await expect(store.backup(missing)).rejects.toMatchObject({ code: "INIT_BACKUP_FAILED" });
  });
});

describe("permissions on an existing configuration", () => {
  it("rewrites a world-readable config to 0600 through atomic replacement", async () => {
    const store = new ConfigStore();
    const path = configPath();
    await writeFile(path, "{}");
    await chmod(path, 0o644);
    await store.write(path, newConfigFile());
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("tightens an existing configuration directory to 0700", async () => {
    const store = new ConfigStore();
    const directory = join(root, "existing-config");
    const path = join(directory, "config.json");
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await chmod(directory, 0o755);
    await store.write(path, newConfigFile());
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  it("enforces 0600/0700 on the no-write path without changing configuration bytes", async () => {
    const store = new ConfigStore();
    const directory = join(root, "complete-config");
    const path = join(directory, "config.json");
    await mkdir(directory, { recursive: true });
    await writeFile(path, "{\"firecrawl\":{\"port\":3456}}\n");
    await chmod(path, 0o644);
    await chmod(directory, 0o755);
    const original = await readFile(path, "utf8");

    await store.enforcePermissions(path);

    expect(await readFile(path, "utf8")).toBe(original);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
  });
});
