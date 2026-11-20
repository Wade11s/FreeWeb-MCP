import type { Command } from "commander";
import type { CliContext } from "../main.js";
import { text } from "../text.js";

/**
 * Registers the `print-config` subcommand: print an example MCP client
 * configuration for this executable. Business configuration is never loaded.
 */
export function registerPrintConfig(program: Command, ctx: CliContext): void {
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
}
