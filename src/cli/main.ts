import { readFile } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import { registerDoctor } from "./commands/doctor.js";
import { registerHelp } from "./commands/help.js";
import { registerMcp } from "./commands/mcp.js";
import { registerPrintConfig } from "./commands/print-config.js";
import { text } from "./text.js";

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

/** Reads the package version without loading any business configuration. */
async function readPackageVersion(): Promise<string> {
  const packageUrl = new URL("../../package.json", import.meta.url);
  const parsed = JSON.parse(await readFile(packageUrl, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json does not declare a version");
  }
  return parsed.version;
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

  registerMcp(program, ctx, result);
  registerDoctor(program, ctx, result);
  registerPrintConfig(program, ctx);
  registerHelp(program, ctx, result);

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
