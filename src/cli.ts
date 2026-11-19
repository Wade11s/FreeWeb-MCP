#!/usr/bin/env node
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, redactedConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { createMcpServer } from "./mcp/server.js";
import { createFreeWebRuntime } from "./runtime.js";

function usage() {
  console.log([
    "FreeWeb-MCP v0.1.0",
    "",
    "Usage:",
    "  freeweb-mcp                 Start the MCP stdio server",
    "  freeweb-mcp doctor [--json] Check local provider configuration",
    "  freeweb-mcp print-config    Print an example MCP client configuration",
    "",
    "Configuration:",
    "  FREEWEB_CONFIG              Path to the user JSON configuration",
    "  TINYFISH_API_KEY           TinyFish key for a no-wallet-spending account",
    "  FREEWEB_EGO_UNRESTRICTED   Set true to register browse_node",
  ].join("\n"));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") return usage();
  const config = await loadConfig();
  if (command === "doctor") {
    const report = await runDoctor(config);
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      for (const check of report.checks) {
        console.log(`${check.ok ? "PASS" : check.required ? "FAIL" : "WARN"} ${check.name}: ${check.version ?? check.message ?? ""}`);
        if (check.warning) console.log(`  warning: ${check.warning}`);
      }
      console.log(`Configuration: ${JSON.stringify(redactedConfig(config))}`);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "print-config") {
    console.log(JSON.stringify({
      mcpServers: {
        freeweb: {
          command: process.execPath,
          args: [resolve(process.argv[1])],
        },
      },
    }, null, 2));
    return;
  }
  if (command) throw new Error(`Unknown command: ${command}`);

  const runtime = await createFreeWebRuntime(config);
  const handle = serveStdio(() => createMcpServer(runtime));
  console.error("FreeWeb-MCP listening on stdio");
  let closing = false;
  const close = async (signal: "SIGINT" | "SIGTERM") => {
    if (closing) {
      console.error(`FreeWeb-MCP forced shutdown after repeated ${signal}`);
      process.exit(signal === "SIGINT" ? 130 : 0);
    }
    closing = true;
    const deadline = setTimeout(() => {
      console.error("FreeWeb-MCP shutdown deadline exceeded");
      process.exit(1);
    }, Math.max(20_000, config.firecrawl.shutdownTimeoutMs + 1000));
    deadline.unref();
    try {
      const runtimeClosing = runtime.close();
      await Promise.all([handle.close(), runtimeClosing]);
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      console.error(`FreeWeb-MCP shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      clearTimeout(deadline);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => { void close("SIGINT"); });
  process.on("SIGTERM", () => { void close("SIGTERM"); });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
