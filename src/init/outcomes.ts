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

/**
 * The single exit-status derivation for Initialization.
 *
 * 0 only when every required component (Firecrawl, base configuration) is
 * usable and no selected operation actually failed. 1 when a selected
 * installation, write, or verification operation failed, or when a required
 * component is Pending, Failed, or unexpectedly Skipped. Optional Pending or
 * Skipped components never fail the run.
 */
export function initExitCode(results: readonly InitComponentResult[]): number {
  let firecrawlReady = false;
  let configurationReady = false;
  for (const result of results) {
    if (result.selected && result.outcome === "Failed") return 1;
    if (result.required && result.outcome !== "Installed" && result.outcome !== "Configured") return 1;
    if (result.component === "firecrawl" && result.required && result.outcome === "Installed") firecrawlReady = true;
    if (result.component === "configuration" && result.required && result.outcome === "Configured") configurationReady = true;
  }
  // An empty or partial result set is not evidence that the required local
  // baseline is ready. Both required results must be present and usable.
  return firecrawlReady && configurationReady ? 0 : 1;
}

/** Builds the run summary, deriving the exit status exactly once. */
export function initRunSummary(results: readonly InitComponentResult[]): InitRunSummary {
  return { results, exitCode: initExitCode(results) };
}
