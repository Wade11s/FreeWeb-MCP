import type { Command } from "commander";
import type { CliContext } from "../main.js";
import { text } from "../text.js";

/**
 * Registers the `help` subcommand. Commander's implicit help command routes
 * unknown targets to stderr help output; a local help command keeps help text
 * on stdout and turns unknown targets into a clear stderr diagnostic with
 * exit code 1.
 */
export function registerHelp(program: Command, ctx: CliContext, result: { code: number }): void {
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
}
