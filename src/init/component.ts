import type { ConfigClassification } from "./config-store.js";
import type { InitComponentId, InitComponentResult, InitWarning } from "./outcomes.js";
import type { InitPlanItem } from "./plan.js";
import type { InitIo } from "./prompt.js";

/** Values accepted by the configuration schema's scalar and string-array fields. */
export type InitConfigValue = string | number | boolean | readonly string[];

/** A non-secret configuration value contributed by a component. */
export interface InitConfigPatch {
  /** Dotted path in the FreeWeb-MCP configuration schema. */
  readonly setting: string;
  readonly value: InitConfigValue;
}

/** An explicit old → new configuration change awaiting its own confirmation. */
export interface InitConfigRepair {
  readonly component: InitComponentId;
  readonly setting: string;
  readonly oldValue: InitConfigValue;
  readonly newValue: InitConfigValue;
}

/**
 * Read-only environment detection for one provider component. Detection is
 * filesystem/environment inspection only: it never launches a provider,
 * installs anything, or writes a file before the plan is confirmed.
 *
 * `configPatches` are applied to new configuration or to fill an omitted
 * setting; `repairs` require separate old → new confirmation. Neither may
 * contain credentials or other secrets. The orchestrator enforces this at
 * runtime by refusing any string or string-array item that exactly matches a
 * credential-valued environment variable. Configuration is persisted only by
 * the orchestrator's single post-execution write.
 *
 * REDACTION CONTRACT: `notes` and `warnings` are untrusted display strings.
 * The orchestrator redacts every secret-valued environment variable (names
 * containing API_KEY/APIKEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL/AUTH or
 * ending in _KEY), plus inline secret assignments, before printing any
 * component-controlled text or repair value. Components must nevertheless
 * return descriptions, never credentials; the central redactor is the final
 * output boundary for every component, including components added later.
 */
export interface InitDetection {
  readonly installed: boolean;
  /** Absolute path of the binary the run would use. */
  readonly binary?: string;
  /** Known version, if a component obtained one without pre-consent launch. */
  readonly version?: string;
  /** True only for the certified baseline version. */
  readonly certified: boolean;
  /** Where the binary was found. */
  readonly source?: "env" | "config" | "path";
  /** An explicitly configured path that no longer resolves to an executable. */
  readonly staleConfiguredPath?: string;
  readonly notes?: readonly string[];
  readonly warnings?: readonly InitWarning[];
  readonly configPatches?: readonly InitConfigPatch[];
  readonly repairs?: readonly InitConfigRepair[];
  /** Platform classification a platform-sensitive component resolved during detection. */
  readonly platform?: string;
  /** Optional-enhancement note a component resolved during detection. */
  readonly chromeNote?: string;
}

/** Timeouts carried from the effective configuration into verification. */
export interface InitTimeouts {
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export interface InitVerifyInput {
  readonly binary: string;
  readonly timeouts?: InitTimeouts;
}

export interface InitExecuteInput {
  readonly io: InitIo;
  readonly env: NodeJS.ProcessEnv;
  readonly detection: InitDetection;
  /** This component's repairs explicitly confirmed for this run. */
  readonly appliedRepairs: readonly InitConfigRepair[];
  readonly timeouts?: InitTimeouts;
}

/**
 * One provider behind Initialization. The orchestrator calls detect and plan
 * before any confirmation, then execute after it. execute owns confirmed
 * probes, verification, installation, and component-specific prompts.
 *
 * Results may return `configPatches`; these are combined with detection
 * patches and confirmed repairs and applied in one shared write after every
 * component has executed. A component therefore persists a setting solely by
 * returning a patch — it never writes configuration itself and never needs an
 * orchestrator special case. Patches must contain only schema-defined,
 * non-secret values.
 *
 * REDACTION CONTRACT: result `detail`/`warnings`, detection `notes`, plan
 * descriptions, and repair values are all rendered through the same central
 * secret redactor, including confirmation prompts. Component output cannot
 * bypass that boundary by placing an environment secret in any of those
 * fields. Do not put secrets in configuration patches: schema validation
 * rejects undeclared fields, and a central runtime guard refuses strings and
 * string-array items that exactly match credential-valued environment
 * variables before any configuration write.
 */
export interface InitComponent {
  readonly id: InitComponentId;
  readonly label: string;
  /** Required components gate the run's exit status. */
  readonly required: boolean;
  detect(env: NodeJS.ProcessEnv, classification: ConfigClassification): Promise<InitDetection>;
  plan(detection: InitDetection): readonly InitPlanItem[];
  /** Verification with owned resources only (loopback, owned port, Cloud Off). */
  verify(input: InitVerifyInput): Promise<{ readonly ok: boolean; readonly message?: string }>;
  execute(input: InitExecuteInput): Promise<InitComponentResult>;
}
