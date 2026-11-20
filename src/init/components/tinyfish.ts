import type { InitComponent, InitConfigPatch, InitDetection, InitExecuteInput } from "../component.js";
import type { ConfigClassification } from "../config-store.js";
import type { InitComponentResult } from "../outcomes.js";
import type { InitPlanItem } from "../plan.js";
import type { InitIo } from "../prompt.js";
import { redactInitText } from "../redaction.js";

/**
 * The exact statement a user must affirm before Initialization may persist
 * tinyfish.freeOnlyConfirmed=true. Account balances and local setup outcomes
 * are deliberately excluded as evidence of the Free guarantee.
 */
export const TINYFISH_FREE_ATTESTATION = "This TinyFish API key belongs to an account with no wallet spending capability; free credits, a zero balance, disabled auto-reload, and installation success are not substitutes for this attestation.";

const MANUAL_ENVIRONMENT_STEP = "Set TINYFISH_API_KEY in the environment of the process that runs FreeWeb-MCP, then rerun init; Initialization never collects, prints, or persists its value.";
const NO_REQUESTS = "No TinyFish CLI, SDK, wallet, Search, Fetch, or other paid-risk request was made.";

/**
 * Keeps the fixed, public attestation intact without disabling credential
 * redaction for any surrounding component-controlled text.
 */
export function redactTinyFishInitIo(io: InitIo, env: NodeJS.ProcessEnv): InitIo {
  const redact = (text: string): string => text
    .split(TINYFISH_FREE_ATTESTATION)
    .map((part) => redactInitText(part, env))
    .join(TINYFISH_FREE_ATTESTATION);
  return {
    prompt: {
      interactive: io.prompt.interactive,
      confirm: (question) => io.prompt.confirm(redact(question)),
      close: () => io.prompt.close(),
    },
    writeLine: (line) => io.writeLine(redact(line)),
    errorLine: (line) => io.errorLine(redact(line)),
  };
}

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

      const selected = await input.io.prompt.confirm("Set up optional TinyFish Search/Fetch with the SDK already included with FreeWeb-MCP? [y/N]");
      if (!selected) {
        return {
          ...base,
          outcome: "Skipped",
          warnings: [],
          detail: `optional setup skipped; no configuration was changed and Firecrawl Search Fallback was not enabled. ${NO_REQUESTS}`,
        };
      }

      // Repeat the exact statement at the decision point as well as in the
      // plan. A yes answer is the sole source of a true execution patch.
      const attested = await input.io.prompt.confirm(`Confirm the Free attestation: ${TINYFISH_FREE_ATTESTATION} [y/N]`);
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

  return { id: "tinyfish", label: "TinyFish Search/Fetch", required: false, detect, plan, verify, execute };
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
