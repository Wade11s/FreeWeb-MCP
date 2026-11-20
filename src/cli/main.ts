import { readFile } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import { loadConfig, redactedConfig } from "../config.js";
import { runDoctor } from "../doctor.js";
import { runMcpCommand } from "./mcp.js";

/**
 * Output and process-control seam for the CLI. The executable entry point
 * (src/cli.ts) is the only place that reads argv, touches the real process
 * streams, or terminates the process; dispatch code only sees this interface.
 */
export interface CliContext {
  /** Writes help and command output (stdout in the real CLI). */
  out(text: string): void;
  /** Writes usage and runtime diagnostics (stderr in the real CLI). */
  err(text: string): void;
  /** Terminates the process with an exit status; owned by the entry point. */
  exit(code: number): void;
  /** Absolute path of the running CLI entry script. */
  executablePath: string;
}

interface DoctorOptions {
  json: boolean;
}

/** Reads the package version without loading any business configuration. */
async function readPackageVersion(): Promise<string> {
  const packageUrl = new URL("../../package.json", import.meta.url);
  const parsed = JSON.parse(await readFile(packageUrl, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json does not declare a version");
  }
  return parsed.version;
}

function text(value: string): string {
  return `${value}\n`;
}

function buildProgram(version: string, ctx: CliContext, result: { code: number }): Command {
  const program = new Command();
  program
    .name("freeweb-mcp")
    .description("Free-first local Web MCP using Firecrawl Local, TinyFish and ego-lite")
    .version(version, "-v, --version", "output the version number")
    .helpOption("-h, --help", "display help for command")
    .configureOutput({
      writeOut: (help) => ctx.out(help),
      writeErr: (diagnostics) => ctx.err(diagnostics),
    })
    .exitOverride()
    .allowExcessArguments(false);

  program
    .command("mcp")
    .description("Start the stdio MCP server")
    .allowExcessArguments(false)
    .action(async () => {
      const config = await loadConfig();
      await runMcpCommand(config, ctx);
      result.code = 0;
    });

  program
    .command("doctor")
    .description("Check local provider configuration and readiness")
    .option("--json", "emit the machine-readable report as JSON on stdout")
    .allowExcessArguments(false)
    .action(async (options: DoctorOptions) => {
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

  program
    .command("print-config")
    .description("Print an example MCP client configuration")
    .allowExcessArguments(false)
    .action(() => {
      ctx.out(text(JSON.stringify({
        mcpServers: {
          freeweb: {
            command: process.execPath,
            args: [ctx.executablePath],
          },
        },
      }, null, 2)));
    });

  // Commander's implicit help command routes unknown targets to stderr help
  // output; a local help command keeps help text on stdout and turns unknown
  // targets into a clear stderr diagnostic with exit code 1.
  program.helpCommand(false);
  program
    .command("help")
    .description("display help for command")
    .argument("[command]", "command to describe")
    .allowExcessArguments(false)
    .action((name?: string) => {
      if (name === undefined) {
        program.outputHelp();
        return;
      }
      const target = program.commands.find((command) => command.name() === name);
      if (!target) {
        ctx.err(text(`error: unknown help topic '${name}'`));
        result.code = 1;
        return;
      }
      target.outputHelp();
    });

  return program;
}

/**
 * Parses argv and dispatches one command. Returns the process exit status.
 * Help and version never load business configuration; `doctor` and `mcp`
 * load and validate it inside their handlers.
 */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const version = await readPackageVersion();
  const result = { code: 0 };
  const program = buildProgram(version, ctx, result);

  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return result.code;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already wrote help, version, or usage diagnostics through
      // the configured output hooks; only the exit status remains.
      return error.exitCode;
    }
    ctx.err(text(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
