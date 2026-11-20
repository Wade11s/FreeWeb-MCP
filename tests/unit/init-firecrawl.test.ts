import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FirecrawlConfig, FirecrawlRuntime } from "../../src/providers/firecrawl-process.js";
import { createFirecrawlComponent } from "../../src/init/components/firecrawl.js";
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
      commandRunner: async () => {
        launches += 1;
        throw new Error("detection must not launch the provider");
      },
    });

    const result = await component.detect({ FIRECRAWL_LOCAL_BIN: binary }, { status: "absent" });

    expect(result).toEqual({
      installed: true,
      binary,
      source: "env",
      certified: false,
      configPatches: [{ setting: "firecrawl.binary", value: binary }],
    });
    expect(launches).toBe(0);
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
});
