import type { InitComponent, InitConfigPatch, InitDetection, InitExecuteInput } from "../component.js";
import type { ConfigClassification } from "../config-store.js";
import type { InitComponentResult } from "../outcomes.js";
import type { InitPlanItem } from "../plan.js";
import { redactInitText } from "../redaction.js";

/**
 * The exact statement a user must affirm before Initialization may persist
 * tinyfish.freeOnlyConfirmed=true. Account balances and local setup outcomes
 * are deliberately excluded as evidence of the Free guarantee.
 */
export const TINYFISH_FREE_ATTESTATION = "This TinyFish API key belongs to an account with no wallet spending capability; free credits, a zero balance, disabled auto-reload, and installation success are not substitutes for this attestation.";

const MANUAL_ENVIRONMENT_STEP = "Set TINYFISH_API_KEY in the environment of the process that runs FreeWeb-MCP, then rerun init; Initialization never collects, prints, or persists its value.";
const NO_REQUESTS = "No TinyFish CLI, SDK, wallet, Search, Fetch, or other paid-risk request was made.";

interface TinyFishDetection extends InitDetection {
  /** Presence only: the credential value is never copied into detection state. */
  readonly tinyfishKeyPresent: boolean;
  /** The persisted file attestation, never an environment-only assertion. */
  readonly tinyfishAttested: boolean;
}

/**
 * Optional TinyFish setup for the SDK already shipped with FreeWeb-MCP.
 * Detection reads only environment presence and the existing configuration.
 * Execution has no installation or verification operation: it can only skip,
 * report a human handoff, or contribute the boolean Free attestation after an
 * explicit confirmation. The shared orchestrator performs any config write.
 */
export function createTinyFishComponent(): InitComponent {
  const detect = async (env: NodeJS.ProcessEnv, classification: ConfigClassification): Promise<TinyFishDetection> => ({
    // The official SDK integration is already a package dependency. There is
    // no provider binary to locate and no global TinyFish CLI involvement.
    installed: true,
    certified: true,
    tinyfishKeyPresent: Boolean(env.TINYFISH_API_KEY),
    tinyfishAttested: fileAttestation(classification),
    notes: ["TinyFish uses the SDK already included with FreeWeb-MCP; no global CLI is needed"],
  });

  const plan = (_detection: InitDetection): readonly InitPlanItem[] => [{
    component: "tinyfish",
    action: "configure",
    stage: "component",
    description: `optionally configure the SDK already included with FreeWeb-MCP (never install or invoke the global TinyFish CLI); persist freeOnlyConfirmed only after confirming: "${TINYFISH_FREE_ATTESTATION}"; make no wallet, business Search/Fetch, or other paid-risk request; never enable Firecrawl Search Fallback as a substitute`,
    required: false,
    selected: true,
  }];

  const verify = async (): Promise<{ readonly ok: boolean; readonly message: string }> => ({
    ok: true,
    message: "the bundled SDK needs no local installation verification; no TinyFish request was made",
  });

  const execute = async (input: InitExecuteInput): Promise<InitComponentResult> => {
    const base = { component: "tinyfish", label: "TinyFish Search/Fetch", required: false, selected: true } as const;
    // detect() above creates this private, non-secret extension. The public
    // component contract remains generic and the orchestrator needs no branch.
    const detection = input.detection as TinyFishDetection;
    try {
      if (detection.tinyfishAttested) {
        if (!detection.tinyfishKeyPresent) return pending(base, `an explicit Free attestation is present, but TINYFISH_API_KEY is not set. ${MANUAL_ENVIRONMENT_STEP} ${NO_REQUESTS}`);
        if (!effectiveAttestation(input.env, true)) {
          return pending(base, "the persisted Free attestation is present, but FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED=false still overrides it; remove that override after verifying the attestation, then rerun init");
        }
        return configured(base);
      }

      // The orchestrator's component step owns setup/skip/quit selection.
      // Execution begins at the one decision that only TinyFish can explain:
      // the exact Free attestation. A distinct affirmative option is the sole
      // source of a true execution patch.
      const attested = await input.io.prompt.choose(
        `Confirm the Free attestation: ${TINYFISH_FREE_ATTESTATION}`,
        [
          { id: "attest", label: "I confirm the attestation exactly as stated; enable TinyFish" },
          { id: "decline", label: "Do not enable TinyFish" },
        ],
        "decline",
      ) === "attest";
      if (!attested) {
        const credential = detection.tinyfishKeyPresent
          ? "TINYFISH_API_KEY is present, but the explicit Free attestation was not confirmed"
          : `TINYFISH_API_KEY is not set and the explicit Free attestation was not confirmed. ${MANUAL_ENVIRONMENT_STEP}`;
        return pending(base, `${credential}; tinyfish.freeOnlyConfirmed was not enabled. ${NO_REQUESTS}`);
      }

      if (!detection.tinyfishKeyPresent) {
        return pending(base, `the explicit Free attestation was confirmed, but TINYFISH_API_KEY is not set. ${MANUAL_ENVIRONMENT_STEP} ${NO_REQUESTS}`);
      }
      const configPatches: readonly InitConfigPatch[] = [{ setting: "tinyfish.freeOnlyConfirmed", value: true }];
      if (!effectiveAttestation(input.env, true)) {
        return pending(base, "the explicit Free attestation was confirmed, but FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED=false still overrides it; remove that override after verifying the attestation, then rerun init", configPatches);
      }
      return { ...configured(base), configPatches };
    } catch (error) {
      return {
        ...base,
        outcome: "Failed",
        warnings: [],
        detail: redactInitText(`TinyFish setup could not be completed: ${error instanceof Error ? error.message : String(error)}`, input.env),
      };
    }
  };

  return {
    id: "tinyfish",
    label: "TinyFish Search/Fetch",
    publicPhrases: [TINYFISH_FREE_ATTESTATION],
    required: false,
    actionLabel: (detection) => detection.installed ? "Configure or verify TinyFish Search/Fetch" : "Set up TinyFish Search/Fetch",
    detect,
    plan,
    verify,
    execute,
  };
}

type TinyFishResultBase = Pick<InitComponentResult, "component" | "label" | "required" | "selected">;

function configured(base: TinyFishResultBase): InitComponentResult {
  return {
    ...base,
    outcome: "Configured",
    warnings: [],
    detail: `TINYFISH_API_KEY is present and the explicit no-wallet-spending attestation is effective; Firecrawl Search Fallback was not enabled. ${NO_REQUESTS} Successful Initialization does not prove TinyFish service or account readiness.`,
  };
}

function pending(base: TinyFishResultBase, detail: string, configPatches?: readonly InitConfigPatch[]): InitComponentResult {
  return {
    ...base,
    outcome: "Pending",
    warnings: [],
    detail,
    ...(configPatches ? { configPatches } : {}),
  };
}

function fileAttestation(classification: ConfigClassification): boolean {
  if (classification.status !== "ok") return false;
  const tinyfish = classification.raw.tinyfish;
  return typeof tinyfish === "object" && tinyfish !== null && !Array.isArray(tinyfish)
    && (tinyfish as Record<string, unknown>).freeOnlyConfirmed === true;
}

/** Mirrors the existing boolean environment override without reading secrets. */
function effectiveAttestation(env: NodeJS.ProcessEnv, fileValue: boolean): boolean {
  const value = env.FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED?.toLowerCase();
  if (value !== undefined && ["1", "true", "yes", "on"].includes(value)) return true;
  if (value !== undefined && ["0", "false", "no", "off"].includes(value)) return false;
  return fileValue;
}
