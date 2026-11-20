#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const logPath = join(dirname(fileURLToPath(import.meta.url)), "firecrawl-events.jsonl");
const args = process.argv.slice(2);
const record = (event) => appendFileSync(logPath, `${JSON.stringify(event)}\n`);
record({
  kind: "serve-start",
  args,
  cloud: process.env.FIRECRAWL_CLOUD,
  allowPrivate: process.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE,
});
const port = Number(args[args.indexOf("--port") + 1]);
const host = args[args.indexOf("--host") + 1];

const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", engine: "firecrawl-local", version: "0.1.0-controlled" }));
      return;
    }
    if (request.url === "/v2/scrape" && request.method === "POST") {
      const input = JSON.parse(body);
      record({ kind: "local-fetch", url: input.url });
      response.end(JSON.stringify({
        success: true,
        data: {
          markdown: `controlled Firecrawl content for ${input.url}`,
          metadata: { url: input.url, title: "Controlled Firecrawl" },
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false, error: "Controlled route not found" }));
  });
});

server.listen(port, host);
const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
