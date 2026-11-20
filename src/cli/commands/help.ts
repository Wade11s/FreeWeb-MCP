import type { Command } from "commander";
import type { CliContext } from "../main.js";
import { text } from "../text.js";

/**
 * Declares the `help` subcommand shape: name, description, and a single
 * optional command target. Shared by the dispatcher and the validation probe.
 */
export function declareHelp(program: Command): Command {
  return program
    .command("help")
    .description("display help for command")
    .argument("[command]", "command to describe")
    .allowExcessArguments(false);
}

/**
 * Registers the `help` subcommand action on the command declareCommands
 * produced. Commander's implicit help command routes unknown targets to
 * stderr help output; a local help command keeps help text on stdout and
 * turns unknown targets into a clear stderr diagnostic with exit code 1.
 * The dispatcher's pre-pass already rejects unknown topics before flags can
 * mask them; this branch still guards argv like `help -- nope`, where the
 * topic arrives as a positional after the `--` terminator.
 */
export function registerHelp(help: Command, program: Command, ctx: CliContext, result: { code: number }): void {
  help.action((name?: string) => {
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
}
