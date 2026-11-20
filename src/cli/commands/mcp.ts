import type { Command } from "commander";
import { loadConfig } from "../../config.js";
import { runMcpCommand } from "../mcp.js";
import type { CliContext } from "../main.js";

/**
 * Declares the `mcp` subcommand shape: name, description, and strict
 * positional arity. Shared by the dispatcher and the validation probe.
 */
export function declareMcp(program: Command): Command {
  return program
    .command("mcp")
    .description("Start the stdio MCP server")
    .allowExcessArguments(false);
}

/**
 * Registers the `mcp` subcommand action on the command declareCommands
 * produced: load and validate business configuration, then run the stdio
 * MCP server with the package version already loaded by the dispatcher.
 */
export function registerMcp(mcp: Command, ctx: CliContext, result: { code: number }, version: string): void {
  mcp.action(async () => {
      const config = await loadConfig();
      await runMcpCommand(config, ctx, version);
      result.code = 0;
    });
}
