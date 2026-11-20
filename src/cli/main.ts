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

/** Matches option tokens that make Commander print help or version and stop parsing. */
function shortCircuits(token: string): boolean {
  return /^(-h|--help|-v|--version)/.test(token);
}

/** Names the option `token` refers to, ignoring an attached `=value` form. */
function optionName(token: string): string {
  return token.split("=", 1)[0]!;
}

/** True when `token` names an option of `command` that consumes the next argv slot. */
function consumesValue(command: Command, token: string): boolean {
  const name = optionName(token);
  const option = command.options.find((candidate) => candidate.long === name || candidate.short === name);
  return option?.required === true;
}

/** Replicates Commander's excess-arguments diagnostic so gated argv fails identically. */
function tooManyArguments(command: Command, received: string[]): string {
  const expected = command.registeredArguments.length;
  const plural = expected === 1 ? "" : "s";
  const owner = command.parent ? ` for '${command.name()}'` : "";
  return `error: too many arguments${owner}. Expected ${expected} argument${plural} but got ${received.length}: ${received.join(", ")}.`;
}

/**
 * Strict-argument policy. Commander acts on help/version flags while it is
 * still parsing options and before it validates positional arguments, so a
 * non-option token combined with such a flag (`doctor extra --version`,
 * `--help mcp`) would print help or the version and exit 0. When argv holds
 * such a flag, this pass applies the positional rules up front: the first
 * non-option token must name a command, a `help` target must name a command,
 * and no command may take excess positionals. Without such a flag,
 * Commander's own checks are equivalent and keep their richer diagnostics,
 * so the pass stands down.
 */
function enforceStrictArguments(argv: readonly string[], program: Command): void {
  let flagged = false;
  for (const token of argv) {
    if (token === "--") break;
    if (shortCircuits(token)) {
      flagged = true;
      break;
    }
  }
  if (!flagged) return;

  let context: Command = program;
  let sawFlagBeforeCommand = false;
  let onlyPositionals = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!onlyPositionals && token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (!onlyPositionals && token.length > 1 && token.startsWith("-")) {
      if (context === program && shortCircuits(token)) sawFlagBeforeCommand = true;
      if (consumesValue(context, token)) i += 1;
      continue;
    }
    if (context === program) {
      const takesCommandSlot = positionals.length === 0 && !sawFlagBeforeCommand;
      const target = takesCommandSlot ? program.commands.find((command) => command.name() === token) : undefined;
      if (target) {
        context = target;
        continue;
      }
      program.error(
        takesCommandSlot ? `error: unknown command '${token}'` : tooManyArguments(program, [token]),
        takesCommandSlot ? { code: "commander.unknownCommand" } : { code: "commander.excessArguments" },
      );
    }
    positionals.push(token);
  }

  const registered = context.registeredArguments;
  const variadic = registered.length > 0 && registered[registered.length - 1]!.variadic;
  if (!variadic && positionals.length > registered.length) {
    context.error(tooManyArguments(context, positionals), { code: "commander.excessArguments" });
  }
  if (context.name() === "help" && positionals.length === 1 && !program.commands.some((command) => command.name() === positionals[0])) {
    context.error(`error: unknown help topic '${positionals[0]}'`, { code: "commander.unknownHelpTopic" });
  }
}

/**
 * Parses argv and dispatches one command. Returns the process exit status.
 * Help and version never load business configuration; `doctor` and `mcp`
 * load and validate it inside their handlers. A missing or invalid
 * package.json is reported through `ctx.err` like any other startup failure,
 * never as an unhandled rejection.
 */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const result = { code: 0 };
  try {
    const program = buildProgram(await readPackageVersion(), ctx, result);

    if (argv.length === 0) {
      program.outputHelp();
      return 0;
    }

    enforceStrictArguments(argv, program);
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
