#!/usr/bin/env node
import { runCli } from "./cli/main.js";

// The executable entry is the only place that reads argv, writes to the real
// process streams, or terminates the process. It hands those powers to the
// dispatcher as an injectable context so tests and the MCP stdio stream stay
// deterministic.
const exitCode = await runCli(process.argv.slice(2), {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
  exit: (code) => {
    process.exit(code);
  },
});
if (exitCode !== 0) process.exitCode = exitCode;
