import { describe, expect, it } from "vitest";
import type { InitDetection } from "../../src/init/component.js";
import { buildInitPlan, type InitPlanItem } from "../../src/init/plan.js";
import type { ConfigClassification } from "../../src/init/config-store.js";

function detection(overrides: Partial<InitDetection> = {}): InitDetection {
  return {
    installed: true,
    binary: "/bin/firecrawl-local",
    version: "firecrawl-local 0.1.0",
    certified: true,
    source: "path",
    ...overrides,
  };
}

const componentItems: readonly InitPlanItem[] = [{
  component: "firecrawl",
  action: "verify",
  description: "verify the existing installation with an owned loopback health check (Cloud Off)",
  required: true,
  selected: true,
}];

function plan(classification: ConfigClassification, firecrawl = detection()) {
  return buildInitPlan({
    configPath: "/cfg/config.json",
    classification,
    detections: new Map([["firecrawl", firecrawl]]),
    componentItems,
  });
}

describe("init plan construction", () => {
  it("plans verification plus a conservative configuration write for an absent config", () => {
    const result = plan({ status: "absent" }, detection({
      configPatches: [{ setting: "firecrawl.binary", value: "/bin/firecrawl-local" }],
    }));
    expect(result.recovery).toBeNull();
    expect(result.items.map((item) => item.action)).toEqual(["verify", "write"]);
    expect(result.items[1]!.description).toContain("conservative defaults");
    expect(result.items[1]!.description).toContain("/cfg/config.json");
    expect(result.items[1]!.description).toContain("detected component settings");
    expect(result.warnings).toEqual([]);
    expect(result.repairs).toEqual([]);
  });

  it("carries manual handoff guidance when Firecrawl is not installed", () => {
    const result = buildInitPlan({
      configPath: "/cfg/config.json",
      classification: { status: "absent" },
      detections: new Map([["firecrawl", detection({ installed: false, certified: false, binary: undefined, version: undefined })]]),
      componentItems: [{ ...componentItems[0]!, action: "handoff", description: "report official manual installation guidance" }],
    });
    expect(result.items.map((item) => item.action)).toEqual(["handoff", "write"]);
    expect(result.items[0]!.description).toContain("manual installation");
    expect(result.items[1]!.description).not.toContain("and record");
  });

  it("plans missing-default completion for a partial valid config", () => {
    const result = plan({ status: "ok", raw: { firecrawl: { binary: "/bin/firecrawl-local" } } });
    expect(result.items[1]!.action).toBe("write");
    expect(result.items[1]!.description).toContain("missing safe defaults");
    expect(result.items[1]!.description).toContain("every explicit value is preserved");
  });

  it("plans no changes for an already-complete valid config", () => {
    const raw = {
      tinyfish: { freeOnlyConfirmed: false, searchTimeoutMs: 10_000, fetchTimeoutMs: 150_000 },
      firecrawl: { binary: "/bin/firecrawl-local", host: "127.0.0.1" as const, port: 0, allowPrivate: false, searchFallback: false, startupTimeoutMs: 30_000, shutdownTimeoutMs: 5000 },
      ego: { binary: "ego-browser", unrestricted: false, defaultProfile: "Default", allowedProfiles: ["Default"], allowPrivate: false, taskIdleTimeoutMs: 900_000, taskMaxAgeMs: 3_600_000, maxTasks: 3, maxNodeProcesses: 2 },
      limits: { firecrawlConcurrency: 4, maxCrawlJobs: 3, tinyfishSearchConcurrency: 5, tinyfishSearchPerMinute: 25, tinyfishFetchConcurrency: 3, tinyfishFetchUrlsPerMinute: 100 },
      artifacts: { retentionMs: 86_400_000, inlineFetchPageChars: 50_000, inlineFetchTotalChars: 100_000, inlineNodeChars: 1_000_000, screenshotMaxBytes: 5_000_000 },
    };
    const result = plan({ status: "ok", raw });
    expect(result.items[1]!.action).toBe("configure");
    expect(result.items[1]!.description).toContain("no changes will be made");
    expect(result.repairs).toEqual([]);
  });

  it("carries high-risk explicit settings into plan warnings", () => {
    const result = plan({ status: "ok", raw: { firecrawl: { allowPrivate: true } } });
    expect(result.warnings.map((warning) => warning.code)).toContain("HighRiskSetting");
  });

  it("carries an uncertified detection into plan warnings", () => {
    const result = plan({ status: "absent" }, detection({
      version: "firecrawl-local 9.9.9",
      certified: false,
      warnings: [{ code: "Uncertified", message: "Firecrawl Local reports 9.9.9" }],
    }));
    expect(result.warnings.map((warning) => warning.code)).toEqual(["Uncertified"]);
    expect(result.warnings[0]!.message).toContain("9.9.9");
  });

  it("proposes an old-to-new repair for a stale configured binary path", () => {
    const result = plan(
      { status: "ok", raw: { firecrawl: { binary: "/gone/firecrawl-local" } } },
      detection({
        source: "path",
        staleConfiguredPath: "/gone/firecrawl-local",
        repairs: [{
          component: "firecrawl",
          setting: "firecrawl.binary",
          oldValue: "/gone/firecrawl-local",
          newValue: "/bin/firecrawl-local",
        }],
      }),
    );
    expect(result.repairs).toEqual([{
      component: "firecrawl",
      setting: "firecrawl.binary",
      oldValue: "/gone/firecrawl-local",
      newValue: "/bin/firecrawl-local",
    }]);
    expect(result.items[1]!.action).toBe("write");
    expect(result.items[1]!.description).toContain("confirmed repairs");
  });

  it("plans backup-and-rebuild recovery for malformed configuration", () => {
    const result = plan({ status: "malformed", message: "not valid JSON: boom" });
    expect(result.recovery).toEqual({ reason: "not valid JSON: boom" });
    expect(result.items[1]!.component).toBe("configuration");
    expect(result.items[1]!.action).toBe("write");
    expect(result.items[1]!.description).toContain("non-overwriting backup");
  });

  it("plans backup-and-rebuild recovery for schema-invalid configuration", () => {
    const result = plan({ status: "schema-invalid", issues: ["firecrawl.port: expected number"] });
    expect(result.recovery!.reason).toContain("firecrawl.port");
    expect(result.items[1]!.description).toContain("rebuild conservative configuration");
  });
});
