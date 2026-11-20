import type { Command } from "commander";
import { loadConfig, redactedConfig, type AppConfig } from "../../config.js";
import { runDoctor, type DoctorCheck, type DoctorReport } from "../../doctor.js";
import { FreeWebError } from "../../errors.js";
import { readPackageMetadata } from "../../package-metadata.js";
import type { CliContext } from "../main.js";
import { text } from "../text.js";

interface DoctorOptions {
  json: boolean;
}

/**
 * Declares the `doctor` subcommand shape: name, description, options, and
 * strict positional arity. Shared by the dispatcher and the validation probe.
 */
export function declareDoctor(program: Command): Command {
  return program
    .command("doctor")
    .description("Check local provider configuration and readiness")
    .option("--json", "emit the machine-readable report as JSON on stdout")
    .allowExcessArguments(false);
}

/** `PASS` for a passing check, `FAIL` for a failed required one, `WARN` for a failed optional one. */
function statusOf(check: DoctorCheck): "PASS" | "FAIL" | "WARN" {
  if (check.ok) return "PASS";
  return check.required ? "FAIL" : "WARN";
}

/** Passing checks report what they found; failing checks report why they failed. */
function detailOf(check: DoctorCheck): string {
  const detail = check.ok ? check.version ?? check.message : check.message ?? check.version;
  // One check is one line: multi-line child-process errors are flattened.
  return (detail ?? "").replace(/\r?\n/g, " ").trim();
}

/**
 * Human-readable report: one status line per check, any certification
 * warning under its check, an overall result, then the effective
 * configuration with secrets redacted. Stability matters here — operator
 * documentation quotes these lines.
 */
function renderTextReport(report: DoctorReport, config: AppConfig): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    const detail = detailOf(check);
    lines.push(`${statusOf(check)} ${check.name}${detail === "" ? "" : `: ${detail}`}`);
    if (check.warning) lines.push(`  warning: ${check.warning}`);
  }
  lines.push(`Result: ${report.ok ? "ok" : "failed"}`);
  lines.push("Configuration:");
  lines.push(JSON.stringify(redactedConfig(config), null, 2));
  return lines.join("\n");
}

/** Renders one validation issue as `path: message`, or `undefined` when it has neither. */
function describeIssue(issue: unknown): string | undefined {
  if (typeof issue !== "object" || issue === null) return undefined;
  const record = issue as { path?: unknown; message?: unknown };
  const path = Array.isArray(record.path) ? record.path.join(".") : "";
  const message = typeof record.message === "string" ? record.message : "";
  if (path === "" && message === "") return undefined;
  return `${path === "" ? "(root)" : path}: ${message}`;
}

/**
 * A configuration failure is one failed required check, so `--json` mode
 * still answers with a parseable report on stdout. Schema issues are folded
 * into the message because the report, not a second stream, is what
 * automation reads.
 */
function describeConfigError(error: unknown): string {
  if (!(error instanceof FreeWebError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const issues = error.options.details?.issues;
  const described = Array.isArray(issues)
    ? issues.map(describeIssue).filter((issue): issue is string => issue !== undefined)
    : [];
  return described.length === 0 ? error.message : `${error.message}: ${described.join("; ")}`;
}

/**
 * Runs one doctor report and returns the exit status. Streaming rules: text
 * mode writes the report and the redacted configuration to stdout; `--json`
 * mode writes only the JSON report to stdout; every human diagnostic goes to
 * stderr in both modes.
 */
async function runDoctorReport(options: DoctorOptions, ctx: CliContext): Promise<number> {
  const metadata = await readPackageMetadata();
  let config: AppConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    const message = describeConfigError(error);
    if (options.json) {
      const report: DoctorReport = {
        ok: false,
        checks: [{ name: "configuration", ok: false, required: true, message }],
      };
      ctx.out(text(JSON.stringify(report, null, 2)));
    }
    ctx.err(text(`error: ${message}`));
    return 1;
  }
  const report = await runDoctor(config, { minimumNodeVersion: metadata.minimumNodeVersion });
  ctx.out(text(options.json ? JSON.stringify(report, null, 2) : renderTextReport(report, config)));
  return report.ok ? 0 : 1;
}

/**
 * Registers the `doctor` subcommand action on the command declareCommands
 * produced: check local provider configuration and readiness, as a
 * human-readable report or `--json` machine output. A failed required check
 * exits 1; optional warnings do not.
 */
export function registerDoctor(doctor: Command, ctx: CliContext, result: { code: number }): void {
  doctor.action(async (options: DoctorOptions) => {
    result.code = await runDoctorReport(options, ctx);
  });
}
