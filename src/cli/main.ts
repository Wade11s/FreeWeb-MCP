import { readFile } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import { declareDoctor, registerDoctor } from "./commands/doctor.js";
import { declareHelp, registerHelp } from "./commands/help.js";
import { declareInit, registerInit } from "./commands/init.js";
import { declareMcp, registerMcp } from "./commands/mcp.js";
import { declarePrintConfig, registerPrintConfig } from "./commands/print-config.js";
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
  /** Absolute path of the Node executable running the CLI. */
  nodePath: string;
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

/** Routes Commander's output hooks through the CLI context seam. */
function outputHooks(ctx: CliContext): { writeOut(output: string): void; writeErr(diagnostics: string): void } {
  return {
    writeOut: (output) => ctx.out(output),
    writeErr: (diagnostics) => ctx.err(diagnostics),
  };
}

/** Program shape shared by the real program and the validation probe. */
function baseProgram(ctx: CliContext): Command {
  return new Command()
    .name("freeweb-mcp")
    .description("Free-first local Web MCP using Firecrawl Local, TinyFish and ego-lite")
    .helpOption("-h, --help", "display help for command")
    .configureOutput(outputHooks(ctx))
    .exitOverride()
    .allowExcessArguments(false)
    .helpCommand(false);
}

/** Subcommands declared by declareCommands, keyed for action registration. */
interface DeclaredCommands {
  mcp: Command;
  doctor: Command;
  init: Command;
  printConfig: Command;
  help: Command;
}

/**
 * The single declaration seam for subcommands: every command is declared
 * here, once, and both the real program and the validation probe shape
 * their tree from these declarations alone. A command added here reaches
 * both trees; a command missing here reaches neither — the drift test in
 * tests/unit/cli-program.test.ts holds the two trees to these declarations.
 */
function declareCommands(program: Command): DeclaredCommands {
  return {
    mcp: declareMcp(program),
    doctor: declareDoctor(program),
    init: declareInit(program),
    printConfig: declarePrintConfig(program),
    help: declareHelp(program),
  };
}

export function buildProgram(version: string, ctx: CliContext, result: { code: number }): Command {
  const program = baseProgram(ctx).version(version, "-v, --version", "output the version number");
  const commands = declareCommands(program);
  registerMcp(commands.mcp, ctx, result);
  registerDoctor(commands.doctor, ctx, result);
  registerInit(commands.init, ctx, result);
  registerPrintConfig(commands.printConfig, ctx);
  registerHelp(commands.help, program, ctx, result);
  return program;
}

/**
 * A program shaped exactly like the real one — same commands, descriptions,
 * options, argument arity, strict positionals, and output hooks — but with
 * every action, the help option, and the version option removed, so parsing
 * it can only validate argv or report a usage error: it can never act, load
 * configuration, or print help. It declares its subcommands through the
 * same declareCommands seam as the real program, so the two trees cannot
 * drift apart. Program-level options beyond help/version, should any be
 * added later, must be declared here as well to stay validated rather than
 * rejected.
 */
export function buildProbe(ctx: CliContext): Command {
  const probe = baseProgram(ctx).helpOption(false);
  declareCommands(probe);
  return probe;
}

/** Exact argv tokens that make Commander print help or the version and skip every other check. */
const SHORT_CIRCUIT_FLAGS: ReadonlySet<string> = new Set(["-h", "--help", "-v", "--version"]);

interface SplitArgv {
  /** argv without its exact help/version tokens, up to the first `--`. */
  rest: string[];
  /** The first operand when a help/version flag preceded it, else undefined. */
  commandAfterFlag: string | undefined;
}

/** True when `token` is an operand rather than an option (`-` alone is an operand). */
function isOperand(token: string): boolean {
  return !(token.length > 1 && token.startsWith("-"));
}

/**
 * Removes the exact `-h`, `--help`, `-v`, and `--version` tokens so the
 * remaining argv can be validated without Commander short-circuiting.
 * Recognition is anchored to whole tokens only: near misses (`-vv`, `-v=1`,
 * `--version=1`) and clustered flags stay in place for validation to reject.
 * Tokens after `--` stay untouched: those are positionals.
 */
function stripShortCircuitFlags(argv: readonly string[]): SplitArgv {
  const rest: string[] = [];
  let firstOperand: string | undefined;
  let flagBeforeOperand = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (SHORT_CIRCUIT_FLAGS.has(token)) {
      if (firstOperand === undefined) flagBeforeOperand = true;
      continue;
    }
    if (firstOperand === undefined && isOperand(token)) firstOperand = token;
    rest.push(token);
  }
  return { rest, commandAfterFlag: flagBeforeOperand ? firstOperand : undefined };
}

/**
 * Strict-usage pre-pass. Commander acts on help/version flags before it
 * checks unknown options, option values, and positional arity, so argv like
 * `--nope --version` would print the version and exit 0 with the usage error
 * unreported. This pass parses the argv with the exact help/version tokens
 * stripped on a probe built from the same declarations; every error the
 * probe raises is a usage error Commander would have masked, so it is thrown
 * and the real parse never runs. Unknown options, unknown commands, excess
 * positionals, and bad option values all fall out of Commander's own rules.
 *
 * Two shapes cannot come from the probe: operand-free argv (`--help`, `-v --`,
 * `--`) is left to the real parse, because the probe program registers no
 * options of its own and would only report its own lack of an action; and a
 * program-level help/version flag followed by a command token
 * (`--version mcp`) parses cleanly on the probe, yet Commander would answer
 * the flag and ignore the token — such a token is rejected as the excess
 * program argument it is, with Commander's own excess-argument diagnostic.
 *
 * Unknown help topics are the third masked shape: Commander answers a
 * help/version flag before it dispatches, so `help nope --version` would
 * print the version and never reach the help action's unknown-topic check.
 * They are rejected here as well, before the real parse, so no flag position
 * can mask them.
 */
async function rejectMaskedUsageErrors(argv: readonly string[], program: Command, ctx: CliContext): Promise<void> {
  const { rest, commandAfterFlag } = stripShortCircuitFlags(argv);
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "--")) return;
  await buildProbe(ctx).parseAsync(rest, { from: "user" });
  if (commandAfterFlag !== undefined && program.commands.some((command) => command.name() === commandAfterFlag)) {
    const excess = new Command()
      .allowExcessArguments(false)
      .exitOverride()
      .configureOutput(outputHooks(ctx));
    // Always fails: this program takes no arguments but is handed the command token.
    await excess.parseAsync([commandAfterFlag], { from: "user" });
  }
  rejectUnknownHelpTopic(rest, program);
}

/**
 * Fails a stripped argv of exactly `help <topic>` whose topic names no real
 * command. Longer remainders (extra positionals) and option-shaped topics
 * are already rejected by the probe's own rules, and `help` alone or a known
 * topic falls through to the real parse. Thrown as a plain error, it reaches
 * the caller's diagnostic channel — the same `error:` line the help action
 * produces — with exit code 1 and nothing on stdout.
 */
function rejectUnknownHelpTopic(rest: readonly string[], program: Command): void {
  if (rest.length !== 2 || rest[0] !== "help") return;
  const topic = rest[1]!;
  // `help --` and `help -- <topic>` are the terminator, not a topic; the real
  // parse decides those shapes.
  if (topic === "--") return;
  if (program.commands.some((command) => command.name() === topic)) return;
  throw new Error(`error: unknown help topic '${topic}'`);
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

    await rejectMaskedUsageErrors(argv, program, ctx);
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
