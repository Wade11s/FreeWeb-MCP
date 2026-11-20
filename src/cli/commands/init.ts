import type { Command } from "commander";
import { runInitDetailed, defaultInitDeps } from "../../init/command.js";
import { createPrompt } from "../../init/prompt.js";
import type { CliContext } from "../main.js";
import { text } from "../text.js";

/**
 * Declares the `init` subcommand shape: name, description, options, and strict
 * positional arity. Shared by the dispatcher and the validation probe.
 */
export function declareInit(program: Command): Command {
  return program
    .command("init")
    .description("Initialize providers step by step and write safe configuration")
    .option("--json", "write one machine-readable final report to stdout; prompts remain interactive on stderr")
    .allowExcessArguments(false);
}

interface InitOptions {
  json: boolean;
}

/**
 * Registers the interactive command boundary. Text mode sends prompts and
 * progress to stdout. JSON mode sends all human interaction to stderr and
 * reserves stdout for exactly one final versioned report.
 */
export function registerInit(init: Command, ctx: CliContext, result: { code: number }): void {
  init.action(async (options: InitOptions) => {
    const writeHuman = (chunk: string): void => {
      if (options.json) ctx.err(chunk);
      else ctx.out(chunk);
    };
    const prompt = createPrompt({
      input: process.stdin,
      write: writeHuman,
      interactive: Boolean(process.stdin.isTTY && (options.json ? process.stderr.isTTY : process.stdout.isTTY)),
    });
    const io = {
      prompt,
      writeLine: (line: string) => {
        writeHuman(text(line));
      },
      errorLine: (line: string) => {
        ctx.err(text(line));
      },
    };
    try {
      const execution = await runInitDetailed(io, defaultInitDeps(process.env));
      if (options.json) ctx.out(text(JSON.stringify(execution.report, null, 2)));
      result.code = execution.exitCode;
    } finally {
      // The interactive stdin reader must not keep the process alive.
      prompt.close();
    }
  });
}
