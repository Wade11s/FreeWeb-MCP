/**
 * The shared Initialization vocabulary.
 *
 * Every Initialization run classifies each component into exactly one
 * outcome and derives its exit status from these types. Later
 * Initialization tickets (Firecrawl installation, TinyFish, ego-lite) reuse
 * these outcomes and register components rather than inventing parallel
 * outcome types.
 */

/**
 * Provider components live in `src/init/components/`; `configuration` is the
 * base configuration step owned by the orchestrator. Registration is the
 * only production change a new component needs, so this is not a closed
 * orchestrator-owned union.
 */
export type InitComponentId = string;

/**
 * The five Initialization outcome categories. `Uncertified` is deliberately
 * not an outcome: it is a warning attached to an installed result.
 */
export type InitOutcome = "Installed" | "Configured" | "Skipped" | "Pending" | "Failed";

/** A warning attached to a component result; never an outcome of its own. */
export interface InitWarning {
  readonly code: string;
  readonly message: string;
}

/** One component's classified result at the end of an Initialization run. */
export interface InitComponentResult {
  readonly component: InitComponentId;
  readonly label: string;
  readonly outcome: InitOutcome;
  /** Required components gate the exit status; optional ones never do. */
  readonly required: boolean;
  /** True when the run actually selected (planned to execute) this component. */
  readonly selected: boolean;
  readonly warnings: readonly InitWarning[];
  readonly detail: string;
  /** Non-secret settings persisted by the shared post-execution write. */
  readonly configPatches?: readonly import("./component.js").InitConfigPatch[];
}

/** Classified summary of a whole Initialization run. */
export interface InitRunSummary {
  readonly results: readonly InitComponentResult[];
  readonly exitCode: number;
}

/** Stable machine-report step states, independent of human capitalization. */
export type InitStepStatus = "succeeded" | "skipped" | "pending" | "failed" | "cancelled";

/** One step in the versioned Initialization report emitted by `init --json`. */
export interface InitStepReport {
  readonly step: number;
  readonly id: string;
  readonly title: string;
  readonly kind: "inspection" | "component" | "configuration" | "verification";
  readonly required: boolean;
  readonly status: InitStepStatus;
  readonly outcome?: InitOutcome;
  readonly detail: string;
  readonly warnings: readonly InitWarning[];
  readonly attempts: number;
}

/** Doctor's stable subset embedded in the Initialization report. */
export interface InitDoctorReport {
  readonly ok: boolean;
  readonly checks: readonly import("../doctor.js").DoctorCheck[];
}

/** Versioned machine output. Human prompts and progress never enter this value. */
export interface InitRunReport {
  readonly schemaVersion: 1;
  readonly command: "init";
  readonly ok: boolean;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly steps: readonly InitStepReport[];
  readonly doctor: InitDoctorReport | null;
  readonly nextSteps: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
}

/** Internal run result; the CLI chooses text or JSON rendering at its boundary. */
export interface InitExecution {
  readonly exitCode: number;
  readonly report: InitRunReport;
}

/**
 * The single exit-status derivation for Initialization.
 *
 * 0 only when every expected required component is usable and no selected
 * operation actually failed. 1 when a selected installation, write, or
 * verification operation failed, or when a required component is Pending,
 * Failed, unexpectedly Skipped, or absent from the result set. Optional
 * Pending or Skipped components never fail the run.
 */
export function initExitCode(
  results: readonly InitComponentResult[],
  expectedRequiredResults = 2,
): number {
  const readyRequired = new Set<InitComponentId>();
  for (const result of results) {
    if (result.selected && result.outcome === "Failed") return 1;
    if (result.required) {
      if (result.outcome !== "Installed" && result.outcome !== "Configured") return 1;
      readyRequired.add(result.component);
    }
  }
  // The caller supplies the number of registered required providers plus the
  // base configuration. This keeps readiness generic while ensuring an empty
  // or partial result set cannot masquerade as a usable local baseline.
  return readyRequired.size === expectedRequiredResults ? 0 : 1;
}

/** Builds the run summary, deriving the exit status exactly once. */
export function initRunSummary(
  results: readonly InitComponentResult[],
  expectedRequiredResults = 2,
): InitRunSummary {
  return { results, exitCode: initExitCode(results, expectedRequiredResults) };
}
