import type { ConfigClassification } from "./config-store.js";
import type { InitComponentId, InitComponentResult } from "./outcomes.js";
import type { InitPlanItem } from "./plan.js";
import type { InitIo } from "./prompt.js";

/**
 * Read-only environment detection for one provider component. Detection is
 * filesystem/environment inspection only: it never launches a provider,
 * installs anything, or writes a file before the plan is confirmed.
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
  /** Binary chosen after stale-path repair confirmations; defaults to the detection path. */
  readonly binary?: string;
  readonly timeouts?: InitTimeouts;
}

/**
 * One provider behind Initialization. The orchestrator calls detect and plan
 * before any confirmation, then execute after it; execute owns confirmed
 * probes, verification, and (in later tickets) installation, returning the
 * component's classified result using the shared outcome vocabulary.
 * Installation arrives in later tickets as additional execute behavior plus
 * new components — the interface itself is the contract.
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
