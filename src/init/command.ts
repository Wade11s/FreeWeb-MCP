import { defaultConfigPath, loadConfig, type AppConfig } from "../config.js";
import { runDoctor, type DoctorCheck } from "../doctor.js";
import { createFirecrawlComponent } from "./components/firecrawl.js";
import type { InitComponent, InitDetection, InitTimeouts } from "./component.js";
import {
  ConfigStore,
  completeExistingConfig,
  highRiskSettingWarnings,
  newConfigFile,
  setPath,
  type ConfigClassification,
} from "./config-store.js";
import { initRunSummary, type InitComponentId, type InitComponentResult, type InitWarning } from "./outcomes.js";
import { buildInitPlan, type InitPathRepair, type InitPlanItem } from "./plan.js";
import type { InitIo } from "./prompt.js";

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
    components: [createFirecrawlComponent()],
    store: new ConfigStore(),
    runDoctor,
    loadAppConfig: (options) => loadConfig(options),
  };
}

const CONFIGURATION_LABEL = "Configuration";
const DEFAULT_TIMEOUTS: InitTimeouts = { startupTimeoutMs: 30_000, shutdownTimeoutMs: 5_000 };

/**
 * The Initialization orchestrator: plan → confirm → execute per component →
 * write configuration → doctor → classified summary → exit code. It never
 * starts the MCP server and never reads or writes other MCP clients'
 * configurations; completion guidance points at the separate print-config
 * command.
 */
export async function runInit(io: InitIo, deps: InitDeps): Promise<number> {
  // A non-TTY invocation stops before any read, write, installation, or
  // provider launch: there is no unattended mode.
  if (!io.prompt.interactive) {
    io.errorLine("freeweb-mcp init is interactive and requires a terminal; no changes were made.");
    io.errorLine("Run it from an interactive shell. There is no unattended mode.");
    return 1;
  }

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
  const plan = buildInitPlan({ configPath: deps.configPath, classification, detections, componentItems });

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
        io.writeLine(`  - ${repair.setting}: ${repair.oldValue} -> ${repair.newValue}`);
      }
    }
    if (!(await io.prompt.confirm("Proceed with this plan? [y/N]"))) {
      io.errorLine("Initialization canceled before any changes were made.");
      return 1;
    }
  }

  const appliedRepairs: InitPathRepair[] = [];
  for (const repair of plan.repairs) {
    if (await io.prompt.confirm(`Update ${repair.setting} from ${repair.oldValue} to ${repair.newValue}? [y/N]`)) {
      appliedRepairs.push(repair);
    } else {
      io.writeLine(`Kept ${repair.setting}: ${repair.oldValue}`);
    }
  }

  const results: InitComponentResult[] = [];
  let configurationResult: InitComponentResult | undefined;

  if (rebuild) {
    // Recovery backs up and rebuilds the configuration before any provider
    // installation or write, exactly as confirmed above.
    const outcome = await backupAndRebuild(io, deps, detections.get("firecrawl"));
    configurationResult = outcome.error
      ? failedConfiguration(outcome.error)
      : {
          component: "configuration",
          label: CONFIGURATION_LABEL,
          outcome: "Configured",
          required: true,
          selected: true,
          warnings: [],
          detail: `damaged file backed up to ${outcome.backup}; conservative configuration rebuilt`,
        };
  }

  for (const component of deps.components) {
    const detection = detections.get(component.id)!;
    const repair = appliedRepairs.find((candidate) => candidate.setting.startsWith(`${component.id}.`));
    // Verification must exercise the binary the runtime would actually
    // start: the confirmed repair target, else the configured path even
    // when it is stale, else the detected path.
    const chosenBinary = repair ? repair.newValue : detection.staleConfiguredPath ?? detection.binary;
    results.push(await component.execute({
      io,
      env: deps.env,
      detection,
      ...(chosenBinary ? { binary: chosenBinary } : {}),
      timeouts: effectiveTimeouts(classification),
    }));
  }

  if (!configurationResult && (classification.status === "ok" || classification.status === "absent")) {
    configurationResult = await writeConfigurationStep(deps, classification, detections, appliedRepairs);
  }
  if (!configurationResult) {
    configurationResult = failedConfiguration("configuration was not rebuilt");
  }
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
  if (summary.exitCode !== 0) {
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

async function backupAndRebuild(
  io: InitIo,
  deps: InitDeps,
  detection: InitDetection | undefined,
): Promise<{ backup?: string; error?: string }> {
  try {
    const backup = await deps.store.backup(deps.configPath);
    io.writeLine(`Backed up damaged configuration to ${backup}`);
    const value = newConfigFile({
      firecrawlBinary: detection?.installed && detection.binary ? detection.binary : undefined,
    });
    await deps.store.write(deps.configPath, value);
    return { backup };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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

async function writeConfigurationStep(
  deps: InitDeps,
  classification: Extract<ConfigClassification, { status: "ok" } | { status: "absent" }>,
  detections: ReadonlyMap<InitComponentId, InitDetection>,
  appliedRepairs: readonly InitPathRepair[],
): Promise<InitComponentResult> {
  const base = { component: "configuration" as const, label: CONFIGURATION_LABEL, required: true, selected: true };
  const firecrawl = detections.get("firecrawl");
  let value: Record<string, unknown>;
  let warnings: InitWarning[] = [];
  let detail: string;

  if (classification.status === "absent") {
    value = newConfigFile({
      firecrawlBinary: firecrawl?.installed && firecrawl.binary ? firecrawl.binary : undefined,
    }) as unknown as Record<string, unknown>;
    detail = `wrote new conservative configuration (no private access, no Search Fallback, no Unrestricted Browse) to ${deps.configPath}`;
  } else {
    warnings = highRiskSettingWarnings(classification.raw);
    const completed = completeExistingConfig(classification.raw);
    value = completed.merged as unknown as Record<string, unknown>;
    // A binary the file never named explicitly is completed with the
    // resolved absolute path so GUI clients do not depend on terminal PATH.
    if (firecrawl?.installed && firecrawl.binary && !hasExplicitFirecrawlBinary(classification.raw)) {
      value = setPath(value, "firecrawl.binary", firecrawl.binary);
    }
    if (completed.added.length === 0 && appliedRepairs.length === 0) {
      return {
        ...base,
        outcome: "Configured",
        warnings,
        detail: `existing configuration at ${deps.configPath} is complete; no changes were made`,
      };
    }
    detail = appliedRepairs.length > 0
      ? `applied ${appliedRepairs.length} confirmed repair${appliedRepairs.length === 1 ? "" : "s"} and added ${completed.added.length} missing safe default${completed.added.length === 1 ? "" : "s"} to ${deps.configPath}; every explicit value is preserved`
      : `added ${completed.added.length} missing safe default${completed.added.length === 1 ? "" : "s"} to ${deps.configPath}; every explicit value is preserved`;
  }

  for (const repair of appliedRepairs) {
    value = setPath(value, repair.setting, repair.newValue);
  }
  try {
    await deps.store.write(deps.configPath, value);
  } catch (error) {
    return { ...base, outcome: "Failed", warnings: [], detail: error instanceof Error ? error.message : String(error) };
  }
  return { ...base, outcome: "Configured", warnings, detail };
}

function hasExplicitFirecrawlBinary(raw: Record<string, unknown>): boolean {
  return isRecord(raw.firecrawl) && typeof raw.firecrawl.binary === "string" && raw.firecrawl.binary !== "";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
