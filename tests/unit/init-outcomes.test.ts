import { describe, expect, it } from "vitest";
import { initExitCode, initRunSummary, type InitComponentResult } from "../../src/init/outcomes.js";

function result(overrides: Omit<Partial<InitComponentResult>, "component"> & { component?: string } = {}): InitComponentResult {
  return {
    component: "firecrawl",
    label: "Firecrawl Local",
    outcome: "Installed",
    required: true,
    selected: true,
    warnings: [],
    detail: "",
    ...overrides,
  } as InitComponentResult;
}

describe("init exit-code derivation", () => {
  it("returns 0 when required components are Installed or Configured", () => {
    expect(initExitCode([
      result({ outcome: "Installed" }),
      result({ component: "configuration", label: "Configuration", outcome: "Configured" }),
    ])).toBe(0);
  });

  it("returns 1 when a required component is Pending", () => {
    expect(initExitCode([
      result({ outcome: "Pending" }),
      result({ component: "configuration", label: "Configuration", outcome: "Configured" }),
    ])).toBe(1);
  });

  it("returns 1 when a required component is Failed even when it was not selected", () => {
    expect(initExitCode([result({ outcome: "Failed", selected: false })])).toBe(1);
  });

  it("returns 1 when a selected optional operation actually failed", () => {
    // tinyfish and ego arrive in later tickets; the derivation must already
    // treat them as optional components whose real failures still fail the run.
    expect(initExitCode([
      result({ component: "tinyfish", outcome: "Failed", required: false }),
    ])).toBe(1);
  });

  it("keeps optional Pending and Skipped components from failing the run", () => {
    expect(initExitCode([
      result({ outcome: "Installed" }),
      result({ component: "configuration", label: "Configuration", outcome: "Configured" }),
      result({ component: "tinyfish", outcome: "Pending", required: false }),
      result({ component: "ego", outcome: "Skipped", required: false }),
    ])).toBe(0);
  });

  it("keeps an unselected optional failure from failing the run", () => {
    expect(initExitCode([
      result({ outcome: "Installed" }),
      result({ component: "configuration", outcome: "Configured" }),
      result({ component: "tinyfish", outcome: "Failed", required: false, selected: false }),
    ])).toBe(0);
  });

  it("treats a skipped required component as not ready", () => {
    expect(initExitCode([result({ outcome: "Skipped" })])).toBe(1);
  });

  it("returns 1 for empty or incomplete required result sets", () => {
    expect(initExitCode([])).toBe(1);
    expect(initExitCode([result({ outcome: "Installed" })])).toBe(1);
    expect(initExitCode([
      result({ component: "configuration", outcome: "Configured" }),
    ])).toBe(1);
  });

  it("derives the exit status exactly once in the run summary", () => {
    const summary = initRunSummary([
      result({ outcome: "Installed" }),
      result({ component: "configuration", outcome: "Configured" }),
    ]);
    expect(summary.results).toHaveLength(2);
    expect(summary.exitCode).toBe(0);
  });
});
