import type { Command } from "commander";
import { loadConfig, redactedConfig, type AppConfig } from "../../config.js";
import { runDoctor, type DoctorCheck, type DoctorReport } from "../../doctor.js";
import { FreeWebError } from "../../errors.js";
import { readPackageMetadata } from "../../package-metadata.js";
import type { CliContext } from "../main.js";
import { text } from "../text.js";

interface DoctorOptions {
  json: boolean;
  showConfig: boolean;
}

interface DoctorOutputCheck extends DoctorCheck {
  readonly status: "PASS" | "FAIL" | "WARN";
  readonly remediation?: string;
}

interface DoctorOutputReport {
  readonly schemaVersion: 1;
  readonly command: "doctor";
  readonly ok: boolean;
  readonly status: "ready" | "action_required";
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly warnings: number;
  };
  readonly checks: readonly DoctorOutputCheck[];
  readonly nextSteps: readonly string[];
  readonly config?: unknown;
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
    .option("--show-config", "include the effective configuration with secrets redacted")
    .allowExcessArguments(false);
}

/** `PASS` for a passing check, `FAIL` for a failed required one, `WARN` for a failed optional one. */
function statusOf(check: DoctorCheck): "PASS" | "FAIL" | "WARN" {
  if (check.ok) return "PASS";
  return check.required ? "FAIL" : "WARN";
}

/** Passing checks report what they found; failing checks report both version and cause when available. */
function detailOf(check: DoctorCheck): string {
  const detail = check.ok
    ? check.version ?? check.message
    : [check.version, check.message].filter((value) => value !== undefined && value !== "").join(" — ");
  // One check is one line: multi-line child-process errors are flattened.
  return (detail ?? "").replace(/\r?\n/g, " ").trim();
}

function labelOf(name: string): string {
  const labels: Record<string, string> = {
    configuration: "Configuration",
    node: "Node.js runtime",
    "firecrawl-local": "Firecrawl Local",
    "ego-browser": "ego-lite command",
    tinyfish: "TinyFish Search/Fetch",
    "trusted-dns": "Trusted DNS for fake-ip",
    "firecrawl-wrapper-target-policy": "Firecrawl wrapper target trust",
    "ego-platform": "Managed Browse platform",
    "data-directory": "Data directory",
  };
  return labels[name] ?? name;
}

/** Actionable guidance is attached to its check as well as summarized below. */
function remediationOf(check: DoctorCheck): string | undefined {
  if (check.name === "trusted-dns") {
    return "Optional for fake-ip DNS: set network.trustedDnsServers or FREEWEB_TRUSTED_DNS_SERVERS to public DNS IP literals or explicit HTTPS DoH endpoints (required when a proxy hijacks port 53). Configuration changes require MCP restart or session reload.";
  }
  if (check.ok && !check.warning) return undefined;
  if (check.warning && check.name === "firecrawl-local") {
    return "Use Firecrawl Local v0.1.0 for the certified baseline, or run the contract tests for this version.";
  }
  switch (check.name) {
    case "configuration":
      return "Run `freeweb-mcp init` to inspect and repair the configuration, then rerun `freeweb-mcp doctor`.";
    case "node":
      return "Install a Node.js version supported by this package, then rerun `freeweb-mcp doctor`.";
    case "firecrawl-local":
      return "Run `freeweb-mcp init` and select Firecrawl Local setup, then rerun `freeweb-mcp doctor`.";
    case "data-directory":
      return "Choose a writable FREEWEB_DATA_DIR or fix its permissions, then rerun `freeweb-mcp doctor`.";
    case "tinyfish":
      return "Optional: set TINYFISH_API_KEY for a no-wallet-spending account and select TinyFish during `freeweb-mcp init`.";
    case "ego-browser":
      return "Optional: install and onboard ego lite, then select ego-lite during `freeweb-mcp init`.";
    case "ego-platform":
      return "Optional: Managed Browse requires macOS or Windows; local Fetch/Crawl/Map remain available on this platform.";
    default:
      return check.ok ? "Review the warning and run the relevant contract checks." : "Resolve this check, then rerun `freeweb-mcp doctor`.";
  }
}

function outputReport(report: DoctorReport, config?: AppConfig, showConfig = false): DoctorOutputReport {
  const checks = report.checks.map((check) => {
    const remediation = remediationOf(check);
    return {
      ...check,
      status: statusOf(check),
      ...(remediation ? { remediation } : {}),
    };
  });
  const remediations = checks.flatMap((check) =>
    check.remediation && (!check.ok || check.warning) ? [check.remediation] : []
  );
  const nextSteps = remediations.length > 0
    ? [...new Set(remediations)]
    : ["Run `freeweb-mcp print-config` to obtain the MCP client configuration."];
  return {
    schemaVersion: 1,
    command: "doctor",
    ok: report.ok,
    status: report.ok ? "ready" : "action_required",
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok && check.required).length,
      warnings: checks.filter((check) => Boolean(check.warning) || (!check.ok && !check.required)).length,
    },
    checks,
    nextSteps,
    ...(showConfig && config ? { config: redactedConfig(config) } : {}),
  };
}

/** Grouped human report; complete configuration is opt-in and always redacted. */
function renderTextReport(
  report: DoctorOutputReport,
  showConfig: boolean,
  configurationError?: string,
): string {
  const lines = [
    "FreeWeb-MCP Doctor",
    `Status: ${report.ok ? "READY" : "ACTION REQUIRED"}`,
    `Summary: ${report.summary.passed}/${report.summary.total} checks passed; ${report.summary.failed} required failed; ${report.summary.warnings} warning${report.summary.warnings === 1 ? "" : "s"}`,
  ];
  const writeGroup = (title: string, required: boolean): void => {
    const checks = report.checks.filter((check) => check.required === required);
    if (checks.length === 0) return;
    lines.push("", title);
    for (const check of checks) {
      const detail = detailOf(check);
      lines.push(`  ${check.status.padEnd(4)} ${labelOf(check.name)}${detail ? `: ${detail}` : ""}`);
      if (check.warning) lines.push(`       Warning: ${check.warning}`);
      if (check.remediation && (!check.ok || check.warning || check.name === "trusted-dns")) {
        lines.push(`       Next: ${check.remediation}`);
      }
    }
  };
  writeGroup("Required checks", true);
  writeGroup("Optional capabilities", false);
  lines.push("", "Next steps");
  for (const [index, next] of report.nextSteps.entries()) lines.push(`  ${index + 1}. ${next}`);
  if (showConfig && report.config !== undefined) {
    lines.push("", "Configuration (secrets redacted)", JSON.stringify(report.config, null, 2));
  } else if (configurationError) {
    lines.push("", `Configuration unavailable: ${configurationError}`);
  } else {
    lines.push("", "Configuration is hidden by default; use --show-config to display it with secrets redacted.");
  }
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

/** Fold schema issues into the single failed configuration check. */
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

/** Runs one report. JSON stdout is always one parseable document. */
async function runDoctorReport(options: DoctorOptions, ctx: CliContext): Promise<number> {
  const metadata = await readPackageMetadata();
  let config: AppConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    const message = describeConfigError(error);
    const report = outputReport({
      ok: false,
      checks: [{ name: "configuration", ok: false, required: true, message }],
    });
    if (options.json) {
      ctx.out(text(JSON.stringify(report, null, 2)));
      ctx.err(text(`error: ${message}`));
    } else {
      ctx.out(text(renderTextReport(report, options.showConfig, message)));
    }
    return 1;
  }
  const report = await runDoctor(config, { minimumNodeVersion: metadata.minimumNodeVersion });
  const output = outputReport(report, config, options.showConfig);
  ctx.out(text(options.json ? JSON.stringify(output, null, 2) : renderTextReport(output, options.showConfig)));
  return report.ok ? 0 : 1;
}

/** A failed required check exits 1; optional warnings do not. */
export function registerDoctor(doctor: Command, ctx: CliContext, result: { code: number }): void {
  doctor.action(async (options: DoctorOptions) => {
    result.code = await runDoctorReport(options, ctx);
  });
}
