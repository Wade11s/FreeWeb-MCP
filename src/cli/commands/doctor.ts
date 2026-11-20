import type { Command } from "commander";
import { loadConfig, redactedConfig } from "../../config.js";
import { runDoctor } from "../../doctor.js";
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

/**
 * Registers the `doctor` subcommand action on the command declareCommands
 * produced: check local provider configuration and readiness, as a
 * human-readable report or `--json` machine output.
 */
export function registerDoctor(doctor: Command, ctx: CliContext, result: { code: number }): void {
  doctor.action(async (options: DoctorOptions) => {
      const config = await loadConfig();
      const report = await runDoctor(config);
      if (options.json) {
        ctx.out(text(JSON.stringify(report, null, 2)));
      } else {
        for (const check of report.checks) {
          ctx.out(text(`${check.ok ? "PASS" : check.required ? "FAIL" : "WARN"} ${check.name}: ${check.version ?? check.message ?? ""}`));
          if (check.warning) ctx.out(text(`  warning: ${check.warning}`));
        }
        ctx.out(text(`Configuration: ${JSON.stringify(redactedConfig(config))}`));
      }
      result.code = report.ok ? 0 : 1;
    });
}
