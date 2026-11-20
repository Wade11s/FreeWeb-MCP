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

// Controlled Crawl Jobs. A URL containing "/slow" stays scraping until the Job is
// cancelled, so cancellation can be exercised without a real provider.
const cancelled = new Set();

function crawlSnapshot(id) {
  if (id === "controlled-slow-crawl") {
    return cancelled.has(id)
      ? { success: true, status: "cancelled", total: 0, completed: 0, data: [] }
      : { success: true, status: "scraping", total: 0, completed: 0, data: [] };
  }
  return {
    success: true,
    status: "completed",
    total: 2,
    completed: 2,
    data: [
      {
        markdown: "controlled Crawl content for https://public.fake-ip.test/crawl",
        metadata: { url: "https://public.fake-ip.test/crawl", title: "Controlled Crawl Root" },
      },
      {
        markdown: "controlled Crawl content for https://public.fake-ip.test/crawl/next",
        links: [{ url: "https://public.fake-ip.test/crawl/next" }],
        metadata: { url: "https://public.fake-ip.test/crawl/next", title: "Controlled Crawl Next" },
      },
    ],
  };
}

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
    if (request.url === "/v2/crawl" && request.method === "POST") {
      const input = JSON.parse(body);
      const id = String(input.url).includes("/slow") ? "controlled-slow-crawl" : "controlled-crawl";
      record({ kind: "crawl-start", id, url: input.url });
      response.end(JSON.stringify({ success: true, id }));
      return;
    }
    const crawlMatch = request.url?.match(/^\/v2\/crawl\/([^/?]+)$/);
    if (crawlMatch && request.method === "GET") {
      const id = decodeURIComponent(crawlMatch[1]);
      record({ kind: "crawl-status", id });
      response.end(JSON.stringify(crawlSnapshot(id)));
      return;
    }
    if (crawlMatch && request.method === "DELETE") {
      const id = decodeURIComponent(crawlMatch[1]);
      cancelled.add(id);
      record({ kind: "crawl-cancel", id });
      response.end(JSON.stringify({ success: true, status: "cancelled" }));
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
