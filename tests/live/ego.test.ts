import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { createFreeWebRuntime, type FreeWebRuntime } from "../../src/runtime.js";

const runEgo = process.env.FREEWEB_LIVE_EGO === "1";
const rawPrefix = `freeweb-live-raw-${process.pid}-${Date.now()}`;
let server: Server;
let origin: string;
let root: string;
let config: AppConfig;
let runtime: FreeWebRuntime;

beforeAll(async () => {
  if (!runEgo) return;
  server = createServer((request, response) => {
    if (request.url === "/api/message") {
      response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify({ message: "hello from page fetch" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><title>FreeWeb Live</title></head><body>
      <button id="change" onclick="document.querySelector('#state').textContent='changed'">Change</button>
      <div id="state">initial</div>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No live test port");
  origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(join(tmpdir(), "freeweb-live-ego-"));
  config = await loadConfig({
    configPath: join(root, "missing.json"),
    env: {
      FREEWEB_DATA_DIR: join(root, "data"),
      FREEWEB_EGO_ALLOW_PRIVATE: "true",
      FREEWEB_EGO_UNRESTRICTED: "true",
    },
  });
  runtime = await createFreeWebRuntime(config);
}, 120_000);

afterAll(async () => {
  if (runtime) {
    if (runEgo) {
      await runtime.browseNode({
        script: `const spaces = await listTaskSpaces();
for (const entry of spaces.filter((space) => space.name.startsWith(${JSON.stringify(rawPrefix)}))) {
  const task = entry.ownership === "user" ? await claimTaskSpace(entry.id)
    : entry.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(entry.id)
      : await taskSpace(entry.id);
  await task.finish({ keep: [] });
}
console.log("raw live Space cleanup complete");`,
        timeoutMs: 30_000,
      }).catch(() => undefined);
    }
    await runtime.close().catch(() => undefined);
  }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
}, 120_000);

describe.skipIf(!runEgo)("ego-lite live managed and unrestricted Browse", () => {
  it("runs managed navigation, evaluation, click, Page fetch and screenshot in one TaskSpace", async () => {
    const opened = await runtime.browse({
      action: "open",
      name: `freeweb-live-managed-${Date.now()}`,
      url: origin,
      page: "p1",
    });
    const browseId = opened.browseId!;
    expect(opened.spaceId).toBeGreaterThanOrEqual(0);

    const evaluated = await runtime.browseEvaluate({
      browseId,
      page: "p1",
      script: "({ titlePrefix }) => ({ title: titlePrefix + document.title, state: document.querySelector('#state').textContent })",
      argument: { titlePrefix: "Live: " },
    });
    expect(evaluated.result).toEqual({ title: "Live: FreeWeb Live", state: "initial" });

    await runtime.browse({ action: "call", browseId, page: "p1", method: "page.click", args: ["#change"] });
    const changed = await runtime.browseEvaluate({
      browseId,
      page: "p1",
      script: "() => document.querySelector('#state').textContent",
    });
    expect(changed.result).toBe("changed");

    const fetched = await runtime.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.fetch",
      args: ["/api/message", { method: "GET", timeout: 10_000 }],
    });
    expect(fetched.result).toMatchObject({ ok: true, status: 200 });
    expect(JSON.stringify(fetched.result)).toContain("hello from page fetch");

    const screenshot = await runtime.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.screenshot",
      args: [],
    });
    const image = await runtime.browseScreenshot(screenshot.result);
    expect(image?.type).toBe("image");

    const closed = await runtime.browse({ action: "close", browseId, page: "p1" });
    expect(closed.status).toBe("closed");
  }, 120_000);

  it("executes native Node JS whose script manages and closes its own Space", async () => {
    const name = `${rawPrefix}-contract`;
    const output = await runtime.browseNode({
      script: `const task = await taskSpace(${JSON.stringify(name)});
try {
  const page = task.page("p1");
  await page.goto(${JSON.stringify(origin)});
  const title = await page.evaluate(() => document.title);
  const fs = await import("node:fs/promises");
  console.log(JSON.stringify({ title, node: process.version, fsAvailable: typeof fs.readFile === "function" }));
} finally {
  await task.finish({ keep: [] });
}`,
      timeoutMs: 60_000,
    });

    expect(output.exitCode).toBe(0);
    expect(output.timedOut).toBe(false);
    expect(output.mayHaveLateEffects).toBe(true);
    expect(output.stderr).toContain("FreeWeb Live");
    expect(output.stderr).toContain("fsAvailable\":true");
    expect(output.artifactId).toBeDefined();

    const spaces = await runtime.browseNode({
      script: `console.log(JSON.stringify((await listTaskSpaces()).filter((space) => space.name === ${JSON.stringify(name)})));`,
      timeoutMs: 30_000,
    });
    expect(spaces.stderr).toContain("[]");
  }, 120_000);
});
