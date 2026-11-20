import type { InitConfigRepair, InitDetection } from "./component.js";
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

/** Backward-compatible name for a component-proposed configuration repair. */
export type InitPathRepair = InitConfigRepair;

export interface InitPlanContext {
  readonly configPath: string;
  readonly dataDir: string;
  readonly classification: ConfigClassification;
  /** Read-only detections keyed by component id. */
  readonly detections: ReadonlyMap<InitComponentId, InitDetection>;
  /** Plan items contributed by the registered provider components. */
  readonly componentItems: readonly InitPlanItem[];
}

export interface InitPlan {
  readonly items: readonly InitPlanItem[];
  readonly warnings: readonly InitWarning[];
  readonly repairs: readonly InitConfigRepair[];
  /** Present only when the configuration is damaged and recovery is the plan. */
  readonly recovery: { readonly reason: string } | null;
}

/**
 * Builds the Initialization plan from generic component contributions. Pure
 * data shaping: detection already happened, and nothing here has side effects.
 */
export function buildInitPlan(context: InitPlanContext): InitPlan {
  const { configPath, dataDir, classification, detections, componentItems } = context;
  const detected = [...detections.values()];
  const warnings: InitWarning[] = detected.flatMap((detection) => detection.warnings ?? []);
  const repairs: InitConfigRepair[] = detected.flatMap((detection) => detection.repairs ?? []);
  const detectionPatches = detected.flatMap((detection) => detection.configPatches ?? []);
  const items: InitPlanItem[] = [...componentItems];
  const includeDoctor = (): void => {
    items.push({
      component: "configuration",
      action: "configure",
      description: `run local doctor checks; create the data directory at ${dataDir} with mode 0700 if it is absent`,
      required: true,
      selected: true,
    });
  };

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
    includeDoctor();
    return { items, warnings, repairs: [], recovery: { reason } };
  }

  if (classification.status === "absent") {
    items.push({
      component: "configuration",
      action: "write",
      description: `write new configuration with conservative defaults (no private access, no Search Fallback, no Unrestricted Browse) to ${configPath}${detectionPatches.length > 0 ? " and apply detected component settings" : ""}`,
      required: true,
      selected: true,
    });
    includeDoctor();
    return { items, warnings, repairs: [], recovery: null };
  }

  warnings.push(...highRiskSettingWarnings(classification.raw));
  const completed = completeExistingConfig(classification.raw);
  if (completed.added.length > 0 || repairs.length > 0 || detectionPatches.length > 0) {
    items.push({
      component: "configuration",
      action: "write",
      description: repairs.length > 0
        ? `apply confirmed repairs and component settings, and add ${completed.added.length} missing safe default${completed.added.length === 1 ? "" : "s"} to ${configPath}; every explicit value is preserved`
        : `apply component settings and add ${completed.added.length} missing safe default${completed.added.length === 1 ? "" : "s"} to ${configPath}; every explicit value is preserved`,
      required: true,
      selected: true,
    });
  } else {
    items.push({
      component: "configuration",
      action: "configure",
      description: `configuration at ${configPath} is already complete; no content changes will be made, but file mode 0600 and directory mode 0700 will be enforced`,
      required: true,
      selected: true,
    });
  }
  includeDoctor();
  return { items, warnings, repairs, recovery: null };
}
