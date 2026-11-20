import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfigPath, loadConfig, type AppConfig } from "../config.js";
import { runDoctor, type DoctorCheck } from "../doctor.js";
import { readPackageMetadata } from "../package-metadata.js";
import { registeredInitComponents } from "./components/registry.js";
import type { InitComponent, InitConfigPatch, InitConfigRepair, InitConfigValue, InitDetection } from "./component.js";
import {
  ConfigStore,
  completeExistingConfig,
  highRiskSettingWarnings,
  newConfigFile,
  setPath,
  type ConfigClassification,
} from "./config-store.js";
import {
  initRunSummary,
  type InitComponentId,
  type InitComponentResult,
  type InitDoctorReport,
  type InitExecution,
  type InitRunReport,
  type InitStepReport,
  type InitStepStatus,
  type InitWarning,
} from "./outcomes.js";
import { buildInitPlan, type InitPlanItem } from "./plan.js";
import type { InitChoice, InitIo } from "./prompt.js";
import { redactInitIo, redactInitValue } from "./redaction.js";
import { containsEnvironmentCredential } from "./secrets.js";

export interface InitDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath: string;
  /** Registered provider components: Firecrawl Local plus optional TinyFish Search/Fetch and ego-lite. */
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
const INSPECTION_ID = "inspection";
const DOCTOR_ID = "doctor";

/** Backward-compatible programmatic entry point: return only the exit status. */
export async function runInit(io: InitIo, deps: InitDeps): Promise<number> {
  return (await runInitDetailed(io, deps)).exitCode;
}

/**
 * Runs Initialization and returns a versioned report. The CLI decides whether
 * human progress goes to stdout or stderr and whether this report is rendered;
 * component code remains unaware of output modes.
 */
export async function runInitDetailed(io: InitIo, deps: InitDeps): Promise<InitExecution> {
  const publicPhrases = deps.components.flatMap((component) => component.publicPhrases ?? []);
  const redactedIo = redactInitIo(io, deps.env, publicPhrases);
  try {
    const execution = await runInitCore(redactedIo, deps);
    return { ...execution, report: redactReport(execution.report, deps.env, publicPhrases) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    redactedIo.errorLine(`Initialization failed: ${message}`);
    return {
      exitCode: 1,
      report: redactReport({
        schemaVersion: 1,
        command: "init",
        ok: false,
        status: "failed",
        steps: [],
        doctor: null,
        nextSteps: ["Resolve the reported error, then rerun `freeweb-mcp init`; it is safe to rerun."],
        error: { code: "INITIALIZATION_ERROR", message },
      }, deps.env, publicPhrases),
    };
  }
}

/**
 * Step-by-step Initialization: inspect → one provider at a time → one
 * configuration write → doctor. No provider-specific installation or
 * verification logic moves into this orchestrator.
 */
async function runInitCore(io: InitIo, deps: InitDeps): Promise<InitExecution> {
  if (!io.prompt.interactive) {
    const message = "freeweb-mcp init is interactive and requires a terminal; no changes were made.";
    io.errorLine(message);
    io.errorLine("Run it from an interactive shell. JSON mode changes the report format, not the consent requirements.");
    return {
      exitCode: 1,
      report: {
        schemaVersion: 1,
        command: "init",
        ok: false,
        status: "failed",
        steps: [],
        doctor: null,
        nextSteps: ["Run `freeweb-mcp init` from an interactive terminal."],
        error: { code: "TERMINAL_REQUIRED", message },
      },
    };
  }

  const totalSteps = deps.components.length + 3;
  const steps: InitStepReport[] = [];
  const results: InitComponentResult[] = [];
  const appliedRepairs: InitConfigRepair[] = [];
  let doctor: InitDoctorReport | null = null;

  io.writeLine("FreeWeb-MCP Initialization");
  io.writeLine(`${totalSteps} steps, one decision at a time. Configuration is written only in Step ${totalSteps - 1}.`);
  io.writeLine("No MCP server is started; init never reads or writes other clients' configurations.");

  const finish = (
    status: InitRunReport["status"],
    exitCode: number,
    error?: { code: string; message: string },
  ): InitExecution => {
    const report: InitRunReport = {
      schemaVersion: 1,
      command: "init",
      ok: exitCode === 0,
      status,
      steps,
      doctor,
      nextSteps: initNextSteps(status, steps, doctor),
      ...(error ? { error } : {}),
    };
    writeSummary(io, report);
    return { exitCode, report };
  };

  const finishCompleted = (): InitExecution => {
    const expectedRequiredResults = deps.components.filter((component) => component.required).length + 1;
    const summary = initRunSummary(results, expectedRequiredResults);
    const exitCode = !doctor?.ok ? 1 : summary.exitCode;
    return finish(exitCode === 0 ? "succeeded" : "failed", exitCode);
  };

  const cancel = (
    step: number,
    id: string,
    title: string,
    kind: InitStepReport["kind"],
    required: boolean,
  ): InitExecution => {
    steps.push({
      step,
      id,
      title,
      kind,
      required,
      status: "cancelled",
      detail: "Quit was selected before this step's action ran; no later steps ran.",
      warnings: [],
      attempts: 0,
    });
    return finish("cancelled", 1, {
      code: "INITIALIZATION_CANCELLED",
      message: "Initialization was cancelled. Completed external actions are preserved and listed in the step report; no pending configuration write was performed.",
    });
  };

  // Step 1 is read-only except for an explicitly approved damaged-file backup.
  stepHeader(io, 1, totalSteps, "Inspect environment", true);
  io.writeLine(`  Configuration file: ${deps.configPath}`);
  const classification = await deps.store.classify(deps.configPath);
  const detections = new Map<InitComponentId, InitDetection>();
  for (const component of deps.components) {
    detections.set(component.id, await component.detect(deps.env, classification));
  }
    const componentItems: InitPlanItem[] = [];
  for (const component of deps.components) {
    componentItems.push(...component.plan(detections.get(component.id)!).map((item) => ({ ...item, stage: "component" as const })));
  }
  const plan = buildInitPlan({
    configPath: deps.configPath,
    dataDir: plannedDataDir(deps.env, classification),
    classification,
    detections,
    componentItems,
  });

  let rebuild = false;
  let recoveryBackup: string | undefined;
  let recoveryError: string | undefined;
  let recoveryStatus: "ready" | "failed" = "ready";
  let inspectionAttempts = 0;
  if (plan.recovery) {
    io.writeLine(`  The configuration is damaged: ${plan.recovery.reason}`);
    io.writeLine("  A damaged file is never treated as absent or overwritten without a backup.");
    const backup = await deps.store.proposedBackupPath(deps.configPath);
    io.writeLine(`  Backup destination: ${backup} (an earlier backup is never overwritten)`);
    const recoveryChoice = await io.prompt.choose(
      "Back up the damaged configuration before continuing?",
      [
        { id: "backup", label: "Back up the damaged file and continue one step at a time" },
        { id: "quit", label: "Quit initialization without changing any file" },
      ],
      "quit",
    );
    if (recoveryChoice === "quit") {
      io.errorLine("Initialization canceled; the damaged configuration and every other file were left unchanged.");
      return cancel(1, INSPECTION_ID, "Inspect environment", "inspection", true);
    }
    rebuild = true;
    for (;;) {
      inspectionAttempts += 1;
      try {
        recoveryBackup = await deps.store.backup(deps.configPath);
        recoveryError = undefined;
        recoveryStatus = "ready";
        io.writeLine(`  Backed up damaged configuration to ${recoveryBackup}`);
        break;
      } catch (error) {
        recoveryError = error instanceof Error ? error.message : String(error);
        io.writeLine(`  Backup failed: ${recoveryError}`);
        const failureChoice = await failurePrompt(io, "Continue without a backup; configuration rebuild will be blocked");
        if (failureChoice === "retry") continue;
        if (failureChoice === "quit") {
          steps.push({
            step: 1,
            id: INSPECTION_ID,
            title: "Inspect environment",
            kind: "inspection",
            required: true,
            status: "failed",
            detail: recoveryError,
            warnings: [],
            attempts: inspectionAttempts,
          });
          return finish("cancelled", 1, {
            code: "INITIALIZATION_CANCELLED",
            message: "Initialization was cancelled after the backup failed; no provider action or configuration write ran.",
          });
        }
        recoveryStatus = "failed";
        break;
      }
    }
  }

  steps.push({
    step: 1,
    id: INSPECTION_ID,
    title: "Inspect environment",
    kind: "inspection",
    required: true,
    status: recoveryStatus === "failed" ? "failed" : "succeeded",
    detail: recoveryStatus === "failed"
      ? `Read-only detection completed, but the confirmed backup failed: ${recoveryError}`
      : recoveryBackup
        ? `Read-only detection completed; damaged configuration was backed up to ${recoveryBackup}`
        : `Read-only detection completed; configuration classification: ${classification.status}`,
    warnings: [],
    attempts: Math.max(1, inspectionAttempts),
  });
  if (recoveryStatus === "failed") {
    io.writeLine("  Continuing without a successful backup leaves configuration rebuild blocked; provider steps still require individual selections.");
  } else {
    io.writeLine("  Read-only environment detection complete.");
  }

  for (const [index, component] of deps.components.entries()) {
    const stepNumber = index + 2;
    const detection = detections.get(component.id)!;
    stepHeader(io, stepNumber, totalSteps, component.label, component.required);
    writeDetection(io, detection);
    writePlanItems(io, plan.items.filter((item) => item.component === component.id));
    writeWarnings(io, detection.warnings ?? []);

    const actionId = "run";
    const choices: InitChoice[] = [
      { id: actionId, label: component.actionLabel(detection) },
      ...(!component.required ? [{ id: "skip", label: `Skip ${component.label} for now` }] : []),
      { id: "quit", label: "Quit initialization" },
    ];
    const defaultId = component.required ? "quit" : "skip";
    const selected = await io.prompt.choose(`What do you want to do with ${component.label}?`, choices, defaultId);
    if (selected === "quit") {
      if (steps.every((step) => step.kind === "inspection") && !recoveryBackup) {
        io.errorLine("Initialization canceled before any changes were made.");
      }
      return cancel(stepNumber, component.id, component.label, "component", component.required);
    }
    if (selected === "skip") {
      const skipped = skippedComponent(component, detection);
      results.push(skipped);
      steps.push(componentStep(stepNumber, skipped, 0));
      io.writeLine(`  ${component.label}: Skipped; its setup action did not run.`);
      continue;
    }

    let repairCancelled = false;
    for (const repair of plan.repairs.filter((item) => item.component === component.id)) {
      const repairChoice = await io.prompt.choose(
        `Repair ${repair.setting}: ${displayConfigValue(repair.oldValue)} -> ${displayConfigValue(repair.newValue)}?`,
        [
          { id: "repair", label: `Use ${displayConfigValue(repair.newValue)}` },
          { id: "keep", label: `Keep ${displayConfigValue(repair.oldValue)}` },
          { id: "quit", label: "Quit initialization without writing configuration" },
        ],
        "keep",
      );
      if (repairChoice === "quit") {
        repairCancelled = true;
        break;
      }
      if (repairChoice === "repair") appliedRepairs.push(repair);
      else io.writeLine(`  Kept ${repair.setting}: ${displayConfigValue(repair.oldValue)}`);
    }
    if (repairCancelled) return cancel(stepNumber, component.id, component.label, "component", component.required);

    let attempts = 0;
    let result: InitComponentResult;
    for (;;) {
      attempts += 1;
      result = await component.execute({
        io,
        env: deps.env,
        detection,
        appliedRepairs: appliedRepairs.filter((repair) => repair.component === component.id),
        timeouts: detection.timeouts,
      });
      if (result.outcome !== "Failed") break;
      io.writeLine(`  ${component.label} failed: ${result.detail}`);
      const failureChoice = await failurePrompt(io);
      if (failureChoice === "retry") {
        io.writeLine(`  Retrying ${component.label}; no other step runs first.`);
        continue;
      }
      results.push(result);
      steps.push(componentStep(stepNumber, result, attempts));
      if (failureChoice === "quit") {
        return finish("cancelled", 1, {
          code: "INITIALIZATION_CANCELLED",
          message: `Initialization was cancelled after ${component.label} failed; no later steps ran and no pending configuration write was performed.`,
        });
      }
      break;
    }
    if (steps.some((step) => step.step === stepNumber)) continue;
    results.push(result);
    steps.push(componentStep(stepNumber, result, attempts));
    io.writeLine(`  ${component.label}: ${result.outcome}`);
  }

  // Step N-1 is the sole configuration-write boundary.
  const configurationStep = totalSteps - 1;
  stepHeader(io, configurationStep, totalSteps, CONFIGURATION_LABEL, true);
  writePlanItems(io, plan.items.filter((item) => item.stage === "configuration"));
  for (const warning of plan.warnings) writeWarnings(io, [warning]);
  const configurationChoice = await io.prompt.choose(
    recoveryStatus === "failed"
      ? "The required backup failed, so configuration cannot be rebuilt. Finish this step as failed or quit?"
      : "Apply the selected settings and safe defaults now?",
    recoveryStatus === "failed"
      ? [
          { id: "run", label: "Record the configuration step as failed and continue to Doctor" },
          { id: "quit", label: "Quit without writing configuration" },
        ]
      : [
          { id: "run", label: classification.status === "ok" ? "Apply configuration and enforce safe file permissions" : "Write the new configuration with conservative defaults" },
          { id: "quit", label: "Quit without writing configuration" },
        ],
    "quit",
  );
  if (configurationChoice === "quit") {
    return cancel(configurationStep, "configuration", CONFIGURATION_LABEL, "configuration", true);
  }

  let configurationAttempts = 0;
  let configurationResult: InitComponentResult;
  for (;;) {
    configurationAttempts += 1;
    configurationResult = await writeConfigurationStep(
      deps,
      classification,
      detections,
      appliedRepairs,
      results,
      { rebuild, backup: recoveryBackup, ...(recoveryStatus === "failed" ? { error: recoveryError ?? "configuration backup failed" } : {}) },
    );
    if (configurationResult.outcome !== "Failed") break;
    io.writeLine(`  Configuration failed: ${configurationResult.detail}`);
    const failureChoice = await failurePrompt(io);
    if (failureChoice === "retry") continue;
    results.push(configurationResult);
    steps.push(componentStep(configurationStep, configurationResult, configurationAttempts));
    if (failureChoice === "quit") {
      return finish("cancelled", 1, {
        code: "INITIALIZATION_CANCELLED",
        message: "Initialization was cancelled after configuration failed; no Doctor verification ran.",
      });
    }
    break;
  }
  if (!steps.some((step) => step.step === configurationStep)) {
    results.push(configurationResult);
    steps.push(componentStep(configurationStep, configurationResult, configurationAttempts));
  }
  io.writeLine(`  Configuration: ${configurationResult.outcome}`);

  // The final step runs only after an explicit selection. Doctor may create
  // the data directory, but never starts the MCP server or a business provider.
  stepHeader(io, totalSteps, totalSteps, "Doctor verification", true);
  io.writeLine("  Checks local versions, configuration, and the data directory; no TinyFish API or wallet request is made.");
  writePlanItems(io, plan.items.filter((item) => item.stage === "doctor"));
  const doctorChoice = await io.prompt.choose(
    "Run local Doctor verification now?",
    [
      { id: "run", label: "Run Doctor and show the final summary" },
      { id: "quit", label: "Quit now; keep completed changes but skip Doctor" },
    ],
    "quit",
  );
  if (doctorChoice === "quit") {
    return cancel(totalSteps, DOCTOR_ID, "Doctor verification", "verification", true);
  }

  let doctorAttempts = 0;
  let doctorDetail = "";
  for (;;) {
    doctorAttempts += 1;
    io.writeLine("  Running local doctor checks (the MCP server is not started)…");
    try {
      const config = await deps.loadAppConfig({ env: deps.env, configPath: deps.configPath });
      const report = await deps.runDoctor(config);
      doctor = { ok: report.ok, checks: report.checks };
      doctorDetail = report.ok ? "All required Doctor checks passed." : "One or more required Doctor checks failed.";
      for (const check of report.checks) {
        io.writeLine(`  ${doctorCheckState(check)} ${check.name}: ${doctorCheckDetail(check)}`);
        if (check.warning) io.writeLine(`    warning: ${check.warning}`);
      }
    } catch (error) {
      doctor = null;
      doctorDetail = `Doctor could not run: ${error instanceof Error ? error.message : String(error)}`;
      io.errorLine(doctorDetail);
    }
    if (doctor?.ok) break;
    const failureChoice = await failurePrompt(io, "Finish initialization and show the summary");
    if (failureChoice === "retry") continue;
    if (failureChoice === "quit") {
      steps.push({
        step: totalSteps,
        id: DOCTOR_ID,
        title: "Doctor verification",
        kind: "verification",
        required: true,
        status: "failed",
        detail: doctorDetail,
        warnings: [],
        attempts: doctorAttempts,
      });
      return finish("cancelled", 1, {
        code: "INITIALIZATION_CANCELLED",
        message: "Initialization was cancelled after Doctor failed; completed configuration and provider changes were preserved.",
      });
    }
    break;
  }
  steps.push({
    step: totalSteps,
    id: DOCTOR_ID,
    title: "Doctor verification",
    kind: "verification",
    required: true,
    status: doctor?.ok ? "succeeded" : "failed",
    detail: doctorDetail,
    warnings: [],
    attempts: doctorAttempts,
  });
  return finishCompleted();
}

function stepHeader(io: InitIo, step: number, total: number, title: string, required: boolean): void {
  io.writeLine("");
  io.writeLine(`Step ${step}/${total} — ${title} (${required ? "required" : "optional"})`);
}

function writeDetection(io: InitIo, detection: InitDetection): void {
  io.writeLine(`  Current state: ${detection.installed ? "installed" : "not installed"}`);
  if (detection.binary) io.writeLine(`  Binary: ${detection.binary}`);
  if (detection.version) io.writeLine(`  Version: ${detection.version}`);
  for (const note of detection.notes ?? []) io.writeLine(`  ${note}`);
}

function writeWarnings(io: InitIo, warnings: readonly InitWarning[]): void {
  for (const warning of warnings) io.writeLine(`  Warning [${warning.code}]: ${warning.message}`);
}

function skippedComponent(component: InitComponent, detection: InitDetection): InitComponentResult {
  const detectionNotes = detection.notes?.join(" ") ?? "";
  return {
    component: component.id,
    label: component.label,
    outcome: "Skipped",
    required: component.required,
    selected: false,
    warnings: detection.warnings ?? [],
    detail: `optional setup was skipped at its step; the component action did not run${detectionNotes ? `; ${detectionNotes}` : ""}`,
  };
}

async function failurePrompt(io: InitIo, continueLabel = "Continue to the next step"): Promise<"retry" | "continue" | "quit"> {
  const choices: InitChoice[] = [
    { id: "retry", label: "Retry this step" },
    { id: "continue", label: continueLabel },
    { id: "quit", label: "Quit initialization" },
  ];
  return await io.prompt.choose(
    "This step failed. What do you want to do next?",
    choices,
    "continue",
    // A habitual legacy y must not re-execute a failed side-effectful step.
    { legacyYes: "default" },
  ) as "retry" | "continue" | "quit";
}

function componentStep(step: number, result: InitComponentResult, attempts: number): InitStepReport {
  const status: InitStepStatus = result.outcome === "Failed"
    ? "failed"
    : result.outcome === "Pending"
      ? "pending"
      : result.outcome === "Skipped"
        ? "skipped"
        : "succeeded";
  return {
    step,
    id: result.component,
    title: result.label,
    kind: result.component === "configuration" ? "configuration" : "component",
    required: result.required,
    status,
    outcome: result.outcome,
    detail: result.detail,
    warnings: result.warnings,
    attempts,
  };
}

function initNextSteps(
  status: InitRunReport["status"],
  steps: readonly InitStepReport[],
  doctor: InitDoctorReport | null,
): string[] {
  const next: string[] = [];
  if (status === "cancelled") {
    next.push("Run `freeweb-mcp init` to resume. Already completed external actions are not rolled back; every later action will be presented again.");
  } else if (status === "failed") {
    next.push("Address failed or required pending steps, then rerun `freeweb-mcp init`; it is safe to rerun.");
  } else {
    next.push("Run `freeweb-mcp print-config` to obtain the MCP client configuration; init never modifies another client's configuration.");
  }
  if (doctor && !doctor.ok) next.push("Run `freeweb-mcp doctor` after resolving the failed required checks.");
  if (steps.some((step) => !step.required && (step.status === "pending" || step.status === "skipped" || step.status === "failed"))) {
    next.push("Optional capabilities can be configured later by rerunning `freeweb-mcp init` and selecting their setup actions.");
  }
  return next;
}

function writeSummary(io: InitIo, report: InitRunReport): void {
  io.writeLine("");
  io.writeLine("Initialization summary:");
  for (const step of report.steps) {
    if (step.kind === "inspection") continue;
    const outcome = step.outcome ?? (step.status === "cancelled" ? "Cancelled" : step.status === "succeeded" ? "Passed" : "Failed");
    io.writeLine(`  ${step.title}: ${outcome}${step.detail ? ` - ${step.detail}` : ""}`);
    for (const warning of step.warnings) io.writeLine(`    warning [${warning.code}]: ${warning.message}`);
  }
  if (report.status === "succeeded") {
    io.writeLine("Result: Initialization command succeeded; Firecrawl and the base configuration are usable and no selected operation failed.");
    io.writeLine("This command success does not mean every optional capability is ready; use the optional outcomes above and their human-step details.");
  } else if (report.status === "cancelled") {
    io.writeLine("Result: Initialization was cancelled; review the completed steps above for changes that were already made.");
  } else {
    io.writeLine("Result: Initialization command did not complete successfully; address the failed or required pending items above.");
  }
  io.writeLine("Next steps:");
  for (const next of report.nextSteps) io.writeLine(`  - ${next}`);
}

/** Passing checks report what was found; failing checks report the cause. */
function doctorCheckDetail(check: DoctorCheck): string {
  return check.ok ? check.version ?? check.message ?? "" : check.message ?? check.version ?? "";
}

/** Mirrors the doctor command's PASS/FAIL/WARN line states without nested ternaries. */
function doctorCheckState(check: DoctorCheck): "PASS" | "FAIL" | "WARN" {
  if (check.ok) return "PASS";
  if (check.required) return "FAIL";
  return "WARN";
}

function writePlanItems(io: InitIo, items: readonly InitPlanItem[]): void {
  for (const item of items) {
    io.writeLine(`  Action: ${item.description}`);
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
  if (recovery.error) return failedConfiguration(`configuration rebuild blocked because the required backup failed: ${recovery.error}`);
  if ((classification.status === "malformed" || classification.status === "schema-invalid") && !recovery.rebuild) {
    return failedConfiguration("configuration was not rebuilt");
  }

  const contributingResults = results.filter((result) => result.outcome !== "Skipped" && result.outcome !== "Failed");
  const contributingComponents = new Set(contributingResults.map((result) => result.component));
  const detectionPatches = [...detections.entries()]
    .filter(([component]) => contributingComponents.has(component))
    .flatMap(([, detection]) => detection.configPatches ?? []);
  const repairPatches: InitConfigPatch[] = appliedRepairs.map((repair) => ({ setting: repair.setting, value: repair.newValue }));
  const executionPatches = contributingResults.flatMap((result) => result.configPatches ?? []);
  // Execution contributions are last: post-run choices supersede proposals
  // from the pre-run snapshot rather than being silently overwritten by it.
  const patches = [...detectionPatches, ...repairPatches, ...executionPatches];
  const credentialPatch = patches.find((patch) => containsEnvironmentCredential(patch.value, deps.env));
  if (credentialPatch) {
    return failedConfiguration(`refusing to persist ${credentialPatch.setting}: component patch matches an environment credential`);
  }
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

function redactReport(report: InitRunReport, env: NodeJS.ProcessEnv, publicPhrases: readonly string[]): InitRunReport {
  return redactInitValue(report, env, publicPhrases);
}
