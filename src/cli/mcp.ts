import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { AppConfig } from "../config.js";
import { createMcpServer } from "../mcp/server.js";
import { createFreeWebRuntime } from "../runtime.js";
import type { CliContext } from "./main.js";

/**
 * Runs the stdio MCP server until a shutdown signal arrives. The command
 * handler owns runtime creation, stdio serving, signal handling, and the
 * orderly shutdown deadline; process termination goes through the
 * entry-point-owned exit hook. Stdout stays reserved for JSON-RPC, so every
 * startup and shutdown diagnostic is written to the error stream. The
 * version comes from the dispatcher's single package-metadata read and is
 * supplied explicitly to server construction.
 */
export async function runMcpCommand(
  config: AppConfig,
  ctx: Pick<CliContext, "err" | "exit">,
  version: string,
): Promise<void> {
  const runtime = await createFreeWebRuntime(config);
  const handle = serveStdio(() => createMcpServer(runtime, version));
  ctx.err("FreeWeb-MCP listening on stdio\n");
  let closing = false;
  const close = async (signal: "SIGINT" | "SIGTERM") => {
    if (closing) {
      ctx.err(`FreeWeb-MCP forced shutdown after repeated ${signal}\n`);
      ctx.exit(signal === "SIGINT" ? 130 : 0);
      return;
    }
    closing = true;
    const deadline = setTimeout(() => {
      ctx.err("FreeWeb-MCP shutdown deadline exceeded\n");
      ctx.exit(1);
    }, Math.max(20_000, config.firecrawl.shutdownTimeoutMs + 1000));
    deadline.unref();
    try {
      const runtimeClosing = runtime.close();
      await Promise.all([handle.close(), runtimeClosing]);
      clearTimeout(deadline);
      ctx.exit(0);
    } catch (error) {
      ctx.err(`FreeWeb-MCP shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      clearTimeout(deadline);
      ctx.exit(1);
    }
  };
  process.on("SIGINT", () => { void close("SIGINT"); });
  process.on("SIGTERM", () => { void close("SIGTERM"); });
}
