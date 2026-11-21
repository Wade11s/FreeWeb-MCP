// Sends SIGTERM to this process from inside the first write that reports
// readiness. The signal is delivered before the event loop can run another
// turn, so a command that installs its shutdown handlers after that write is
// killed by the default disposition instead of shutting down cleanly.
const write = process.stderr.write.bind(process.stderr);

process.stderr.write = (chunk, ...rest) => {
  const written = write(chunk, ...rest);
  if (String(chunk).includes("FreeWeb-MCP listening on stdio")) {
    process.kill(process.pid, "SIGTERM");
  }
  return written;
};
