import type { Command } from "commander";
import { runInit, defaultInitDeps } from "../../init/command.js";
import { createPrompt } from "../../init/prompt.js";
import type { CliContext } from "../main.js";
import { text } from "../text.js";

/**
 * Declares the `init` subcommand shape: name, description, and strict
 * positional arity. Shared by the dispatcher and the validation probe.
 */
export function declareInit(program: Command): Command {
  return program
    .command("init")
    .description("Interactively initialize providers and write safe configuration")
    .allowExcessArguments(false);
}

/**
 * Registers the `init` subcommand action on the command declareCommands
 * produced. This file is the interactive command boundary: the only init
 * code that touches the real process streams, it reads process.stdin/stdout
 * TTY state once and hands the streams to the injected prompt seam; all
 * orchestration lives behind `runInit` with injected dependencies.
 */
export function registerInit(init: Command, ctx: CliContext, result: { code: number }): void {
  init.action(async () => {
    const prompt = createPrompt({
      input: process.stdin,
      write: (chunk) => {
        // Questions share the dispatcher's stdout seam so every write to the
        // real stream still flows through the injected context.
        ctx.out(chunk);
      },
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    const io = {
      prompt,
      writeLine: (line: string) => {
        ctx.out(text(line));
      },
      errorLine: (line: string) => {
        ctx.err(text(line));
      },
    };
    try {
      result.code = await runInit(io, defaultInitDeps(process.env));
    } finally {
      // The interactive stdin reader must not keep the process alive.
      prompt.close();
    }
  });
}
