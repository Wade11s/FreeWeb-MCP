import type { InitDetection } from "./component.js";
import { completeExistingConfig, highRiskSettingWarnings, type ConfigClassification } from "./config-store.js";
import type { InitComponentId, InitWarning } from "./outcomes.js";

/** The action kinds an Initialization plan item can describe. */
export type InitAction = "detect" | "verify" | "configure" | "write" | "handoff";

export interface InitPlanItem {
  readonly component: InitComponentId;
  readonly action: InitAction;
  readonly description: string;
  readonly required: boolean;
  readonly selected: boolean;
}

/** An explicit old → new configuration value change awaiting its own confirmation. */
export interface InitPathRepair {
  readonly component: InitComponentId;
  readonly setting: string;
  readonly oldValue: string;
  readonly newValue: string;
}

export interface InitPlanContext {
  readonly configPath: string;
  readonly classification: ConfigClassification;
  /** Read-only detections keyed by component id. */
  readonly detections: ReadonlyMap<InitComponentId, InitDetection>;
  /** Plan items contributed by the registered provider components. */
  readonly componentItems: readonly InitPlanItem[];
}

export interface InitPlan {
  readonly items: readonly InitPlanItem[];
  readonly warnings: readonly InitWarning[];
  readonly repairs: readonly InitPathRepair[];
  /** Present only when the configuration is damaged and recovery is the plan. */
  readonly recovery: { readonly reason: string } | null;
}

/**
 * Builds the Initialization plan from the current environment and existing
 * configuration. Pure data shaping: detection already happened, and nothing
 * here performs a side effect.
 */
export function buildInitPlan(context: InitPlanContext): InitPlan {
  const { configPath, classification, detections, componentItems } = context;
  const warnings: InitWarning[] = [];
  const repairs: InitPathRepair[] = [];
  const items: InitPlanItem[] = [...componentItems];

  const firecrawl = detections.get("firecrawl");
  if (firecrawl?.installed && firecrawl.version !== undefined && !firecrawl.certified) {
    warnings.push({
      code: "Uncertified",
      message: firecrawl.version
        ? `Firecrawl Local reports '${firecrawl.version}', which is not the certified 0.1.0 release; it will be left untouched`
        : "Firecrawl Local's version could not be determined; the existing installation will be left untouched",
    });
  }

  if (classification.status === "malformed" || classification.status === "schema-invalid") {
    const reason = classification.status === "malformed"
      ? classification.message
      : `schema-invalid: ${classification.issues.join("; ")}`;
    items.push({
      component: "configuration",
      action: "write",
      description: `back up the damaged file to a non-overwriting backup, then rebuild conservative configuration at ${configPath}`,
      required: true,
      selected: true,
    });
    return { items, warnings, repairs, recovery: { reason } };
  }

  if (classification.status === "absent") {
    items.push({
      component: "configuration",
      action: "write",
      description: `write new configuration with conservative defaults (no private access, no Search Fallback, no Unrestricted Browse) to ${configPath}${firecrawl?.installed && firecrawl.binary ? ` and record ${firecrawl.binary}` : ""}`,
      required: true,
      selected: true,
    });
    return { items, warnings, repairs, recovery: null };
  }

  warnings.push(...highRiskSettingWarnings(classification.raw));
  const completed = completeExistingConfig(classification.raw);
  if (firecrawl?.staleConfiguredPath && firecrawl.installed && firecrawl.binary) {
    repairs.push({
      component: "firecrawl",
      setting: "firecrawl.binary",
      oldValue: firecrawl.staleConfiguredPath,
      newValue: firecrawl.binary,
    });
  }
  if (completed.added.length > 0 || repairs.length > 0) {
    items.push({
      component: "configuration",
      action: "write",
      description: repairs.length > 0
        ? `apply confirmed repairs and add ${completed.added.length} missing safe default${completed.added.length === 1 ? "" : "s"} to ${configPath}; every explicit value is preserved`
        : `add ${completed.added.length} missing safe default${completed.added.length === 1 ? "" : "s"} to ${configPath}; every explicit value is preserved`,
      required: true,
      selected: true,
    });
  } else {
    items.push({
      component: "configuration",
      action: "configure",
      description: `configuration at ${configPath} is already complete; no changes will be made`,
      required: true,
      selected: true,
    });
  }
  return { items, warnings, repairs, recovery: null };
}
