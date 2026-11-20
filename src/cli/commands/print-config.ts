import type { Command } from "commander";
import type { CliContext } from "../main.js";
import { text } from "../text.js";

/**
 * Declares the `print-config` subcommand shape: name, description, and
 * strict positional arity. Shared by the dispatcher and the validation probe.
 */
export function declarePrintConfig(program: Command): Command {
  return program
    .command("print-config")
    .description("Print an example MCP client configuration")
    .allowExcessArguments(false);
}

/** The executable-native MCP client configuration emitted by `print-config`. */
const MCP_CLIENT_CONFIG = {
  mcpServers: {
    freeweb: {
      command: "freeweb-mcp",
      args: ["mcp"],
    },
  },
} as const;

/**
 * Registers the `print-config` subcommand action on the command
 * declareCommands produced: print an MCP client configuration that launches
 * the installed `freeweb-mcp` executable with the explicit `mcp` subcommand.
 * The output contains no Node.js or built-script paths, and business
 * configuration is never loaded. Deployers must make the executable
 * resolvable in the MCP client's PATH.
 */
export function registerPrintConfig(printConfig: Command, ctx: CliContext): void {
  printConfig.action(() => {
    ctx.out(text(JSON.stringify(MCP_CLIENT_CONFIG, null, 2)));
  });
}
