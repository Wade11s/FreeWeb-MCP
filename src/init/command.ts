import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfigPath, loadConfig, type AppConfig } from "../config.js";
import { runDoctor, type DoctorCheck } from "../doctor.js";
import { readPackageMetadata } from "../package-metadata.js";
import { registeredInitComponents } from "./components/registry.js";
import type { InitComponent, InitConfigPatch, InitConfigRepair, InitConfigValue, InitDetection, InitTimeouts } from "./component.js";
import {
  ConfigStore,
  completeExistingConfig,
  highRiskSettingWarnings,
  newConfigFile,
  setPath,
  type ConfigClassification,
} from "./config-store.js";
import { initRunSummary, type InitComponentId, type InitComponentResult, type InitWarning } from "./outcomes.js";
import { buildInitPlan, type InitPlanItem } from "./plan.js";
import type { InitIo } from "./prompt.js";
import { redactInitIo } from "./redaction.js";

export interface InitDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath: string;
  /** Registered provider components. #22 registers Firecrawl only. */
  readonly components: readonly InitComponent[];
  readonly store: ConfigStore;
  readonly runDoctor: (config: AppConfig) => Promise<{ ok: boolean; checks: DoctorCheck[] }>;
  readonly loadAppConfig: (options: { env: NodeJS.ProcessEnv; configPath: string }) => Promise<AppConfig>;
}

/** Real wiring; the CLI command boundary supplies the process environment. */
export function defaultInitDeps(env: NodeJS.ProcessEnv = process.env): InitDeps {
  return {
    env,
    configPath: defaultConfigPath(env),
    components: registeredInitComponents(),
    store: new ConfigStore(),
    runDoctor: async (config) => {
      const metadata = await readPackageMetadata();
      return runDoctor(config, { minimumNodeVersion: metadata.minimumNodeVersion });
    },
    loadAppConfig: (options) => loadConfig(options),
  };
}

const CONFIGURATION_LABEL = "Configuration";
const DEFAULT_TIMEOUTS: InitTimeouts = { startupTimeoutMs: 30_000, shutdownTimeoutMs: 5_000 };

/**
 * The Initialization orchestrator: plan → confirm → execute every component →
 * apply all configuration contributions in one write → doctor → summary. It
 * never starts the MCP server or touches other MCP clients' configurations.
 */
export async function runInit(io: InitIo, deps: InitDeps): Promise<number> {
  // A non-TTY invocation stops before any read, write, installation, or
  // provider launch: there is no unattended mode.
  if (!io.prompt.interactive) {
    io.errorLine("freeweb-mcp init is interactive and requires a terminal; no changes were made.");
    io.errorLine("Run it from an interactive shell. There is no unattended mode.");
    return 1;
  }

  // Every component-controlled display field and repair prompt crosses this
  // boundary. Components cannot accidentally print an environment credential.
  io = redactInitIo(io, deps.env);

  // Read-only phase: classify configuration and resolve provider binaries
  // without launching providers. Probes and verification wait for consent.
  const classification = await deps.store.classify(deps.configPath);
  const detections = new Map<InitComponentId, InitDetection>();
  for (const component of deps.components) {
    detections.set(component.id, await component.detect(deps.env, classification));
  }
  const componentItems: InitPlanItem[] = [];
  for (const component of deps.components) {
    componentItems.push(...component.plan(detections.get(component.id)!));
  }
  const plan = buildInitPlan({
    configPath: deps.configPath,
    dataDir: plannedDataDir(deps.env, classification),
    classification,
    detections,
    componentItems,
  });

  let rebuild = false;
  if (plan.recovery) {
    io.writeLine("The FreeWeb-MCP configuration file is damaged and cannot be used as-is:");
    io.writeLine(`  ${deps.configPath}: ${plan.recovery.reason}`);
    io.writeLine("A damaged file is never treated as absent. Recovery plan:");
    writePlanItems(io, deps, plan.items);
    const backup = await deps.store.proposedBackupPath(deps.configPath);
    io.writeLine(`The existing file will be backed up to ${backup} first; backups never overwrite an earlier backup.`);
    if (!(await io.prompt.confirm("Back up the damaged configuration and rebuild it? [y/N]"))) {
      io.errorLine("Initialization canceled; the damaged configuration and every other file were left unchanged.");
      return 1;
    }
    rebuild = true;
  } else {
    io.writeLine("FreeWeb-MCP initialization plan:");
    writePlanItems(io, deps, plan.items);
    for (const warning of plan.warnings) {
      io.writeLine(`Warning [${warning.code}]: ${warning.message}`);
    }
    if (plan.repairs.length > 0) {
      io.writeLine("Repair proposals (each is applied only after its own confirmation):");
      for (const repair of plan.repairs) {
        io.writeLine(`  - ${repair.setting}: ${displayConfigValue(repair.oldValue)} -> ${displayConfigValue(repair.newValue)}`);
      }
    }
    if (!(await io.prompt.confirm("Proceed with this plan? [y/N]"))) {
      io.errorLine("Initialization canceled before any changes were made.");
      return 1;
    }
  }

  const appliedRepairs: InitConfigRepair[] = [];
  for (const repair of plan.repairs) {
    if (await io.prompt.confirm(`Update ${repair.setting} from ${displayConfigValue(repair.oldValue)} to ${displayConfigValue(repair.newValue)}? [y/N]`)) {
      appliedRepairs.push(repair);
    } else {
      io.writeLine(`Kept ${repair.setting}: ${displayConfigValue(repair.oldValue)}`);
    }
  }

  // Recovery only takes the confirmed backup here. Rebuilding is part of the
  // same post-execution configuration write as every other component patch.
  let recoveryBackup: string | undefined;
  let recoveryError: string | undefined;
  if (rebuild) {
    try {
      recoveryBackup = await deps.store.backup(deps.configPath);
      io.writeLine(`Backed up damaged configuration to ${recoveryBackup}`);
    } catch (error) {
      recoveryError = error instanceof Error ? error.message : String(error);
    }
  }

  const results: InitComponentResult[] = [];
  for (const component of deps.components) {
    const detection = detections.get(component.id)!;
    results.push(await component.execute({
      io,
      env: deps.env,
      detection,
      appliedRepairs: appliedRepairs.filter((repair) => repair.component === component.id),
      timeouts: effectiveTimeouts(classification),
    }));
  }

  const configurationResult = await writeConfigurationStep(
    deps,
    classification,
    detections,
    appliedRepairs,
    results,
    { rebuild, backup: recoveryBackup, error: recoveryError },
  );
  results.push(configurationResult);

  // A completed run ends with the local doctor; the MCP server is never started.
  let doctorFailed = false;
  io.writeLine("Running local doctor checks (the MCP server is not started)…");
  try {
    const config = await deps.loadAppConfig({ env: deps.env, configPath: deps.configPath });
    const report = await deps.runDoctor(config);
    if (!report.ok) doctorFailed = true;
    for (const check of report.checks) {
      io.writeLine(`  ${doctorCheckState(check)} ${check.name}: ${check.version ?? check.message ?? ""}`);
      if (check.warning) io.writeLine(`    warning: ${check.warning}`);
    }
  } catch (error) {
    doctorFailed = true;
    io.errorLine(`Doctor could not run: ${error instanceof Error ? error.message : String(error)}`);
  }

  const summary = initRunSummary(results);
  io.writeLine("Initialization summary:");
  for (const result of results) {
    io.writeLine(`  ${result.label}: ${result.outcome}${result.detail ? ` - ${result.detail}` : ""}`);
    for (const warning of result.warnings) {
      io.writeLine(`    warning [${warning.code}]: ${warning.message}`);
    }
  }
  io.writeLine("Next steps:");
  io.writeLine("  - To register FreeWeb-MCP with an MCP client, run `freeweb-mcp print-config`; init never reads or writes other clients' configurations.");
  io.writeLine("  - Automated Firecrawl installation and optional TinyFish and ego-lite setup arrive in later releases.");
  if (summary.exitCode !== 0 || doctorFailed) {
    io.writeLine("  Initialization did not complete; rerun `freeweb-mcp init` after addressing the items above (it is safe to rerun).");
  }
  return doctorFailed ? 1 : summary.exitCode;
}

/** Mirrors the doctor command's PASS/FAIL/WARN line states without nested ternaries. */
function doctorCheckState(check: DoctorCheck): "PASS" | "FAIL" | "WARN" {
  if (check.ok) return "PASS";
  if (check.required) return "FAIL";
  return "WARN";
}

function writePlanItems(io: InitIo, deps: InitDeps, items: readonly InitPlanItem[]): void {
  const labels = new Map<string, string>(deps.components.map((component) => [component.id, component.label]));
  labels.set("configuration", CONFIGURATION_LABEL);
  for (const item of items) {
    const label = labels.get(item.component) ?? item.component;
    io.writeLine(`  - [${item.required ? "required" : "optional"}${item.selected ? "" : ", not selected"}] ${label}: ${item.description}`);
  }
}

async function writeConfigurationStep(
  deps: InitDeps,
  classification: ConfigClassification,
  detections: ReadonlyMap<InitComponentId, InitDetection>,
  appliedRepairs: readonly InitConfigRepair[],
  results: readonly InitComponentResult[],
  recovery: { readonly rebuild: boolean; readonly backup?: string; readonly error?: string },
): Promise<InitComponentResult> {
  const base = { component: "configuration" as const, label: CONFIGURATION_LABEL, required: true, selected: true };
  if (recovery.error) return failedConfiguration(recovery.error);
  if ((classification.status === "malformed" || classification.status === "schema-invalid") && !recovery.rebuild) {
    return failedConfiguration("configuration was not rebuilt");
  }

  const detectionPatches = [...detections.values()].flatMap((detection) => detection.configPatches ?? []);
  const repairPatches: InitConfigPatch[] = appliedRepairs.map((repair) => ({ setting: repair.setting, value: repair.newValue }));
  const executionPatches = results.flatMap((result) => result.configPatches ?? []);
  // Execution contributions are last: post-run choices supersede proposals
  // from the pre-run snapshot rather than being silently overwritten by it.
  const patches = [...detectionPatches, ...repairPatches, ...executionPatches];
  let warnings: InitWarning[] = [];
  let value: Record<string, unknown>;
  let added = 0;

  if (classification.status === "ok") {
    warnings = highRiskSettingWarnings(classification.raw);
    const completed = completeExistingConfig(classification.raw);
    value = completed.merged as unknown as Record<string, unknown>;
    added = completed.added.length;
    if (added === 0 && patches.length === 0) {
      try {
        await deps.store.enforcePermissions(deps.configPath);
      } catch (error) {
        return { ...base, outcome: "Failed", warnings: [], detail: error instanceof Error ? error.message : String(error) };
      }
      return {
        ...base,
        outcome: "Configured",
        warnings,
        detail: `existing configuration at ${deps.configPath} is complete; no content changes were made; file mode 0600 and directory mode 0700 enforced`,
      };
    }
  } else {
    value = newConfigFile() as unknown as Record<string, unknown>;
  }

  for (const patch of patches) value = setPath(value, patch.setting, patch.value);
  try {
    await deps.store.write(deps.configPath, value);
  } catch (error) {
    return { ...base, outcome: "Failed", warnings: [], detail: error instanceof Error ? error.message : String(error) };
  }

  let detail: string;
  if (recovery.rebuild) {
    detail = `damaged file backed up to ${recovery.backup}; conservative configuration rebuilt with ${patches.length} contributed setting${patches.length === 1 ? "" : "s"}`;
  } else if (classification.status === "absent") {
    detail = `wrote new conservative configuration (no private access, no Search Fallback, no Unrestricted Browse) with ${patches.length} contributed setting${patches.length === 1 ? "" : "s"} to ${deps.configPath}`;
  } else {
    detail = appliedRepairs.length > 0
      ? `applied ${appliedRepairs.length} confirmed repair${appliedRepairs.length === 1 ? "" : "s"}, ${patches.length - appliedRepairs.length} other component setting${patches.length - appliedRepairs.length === 1 ? "" : "s"}, and ${added} missing safe default${added === 1 ? "" : "s"} to ${deps.configPath}; every explicit value is preserved`
      : `applied ${patches.length} component setting${patches.length === 1 ? "" : "s"} and added ${added} missing safe default${added === 1 ? "" : "s"} to ${deps.configPath}; every explicit value is preserved`;
  }
  return { ...base, outcome: "Configured", warnings, detail };
}

function displayConfigValue(value: InitConfigValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function plannedDataDir(env: NodeJS.ProcessEnv, classification: ConfigClassification): string {
  if (env.FREEWEB_DATA_DIR) return env.FREEWEB_DATA_DIR;
  if (classification.status === "ok" && typeof classification.raw.dataDir === "string") return classification.raw.dataDir;
  return join(homedir(), ".freeweb-mcp");
}

function effectiveTimeouts(classification: ConfigClassification): InitTimeouts | undefined {
  if (classification.status !== "ok" || !isRecord(classification.raw.firecrawl)) return undefined;
  const record = classification.raw.firecrawl as Record<string, unknown>;
  const startup = typeof record.startupTimeoutMs === "number" ? record.startupTimeoutMs : undefined;
  const shutdown = typeof record.shutdownTimeoutMs === "number" ? record.shutdownTimeoutMs : undefined;
  if (startup === undefined && shutdown === undefined) return undefined;
  return {
    startupTimeoutMs: startup ?? DEFAULT_TIMEOUTS.startupTimeoutMs,
    shutdownTimeoutMs: shutdown ?? DEFAULT_TIMEOUTS.shutdownTimeoutMs,
  };
}

function failedConfiguration(message: string): InitComponentResult {
  return {
    component: "configuration",
    label: CONFIGURATION_LABEL,
    outcome: "Failed",
    required: true,
    selected: true,
    warnings: [],
    detail: message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
