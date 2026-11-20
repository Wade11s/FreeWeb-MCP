import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { configFileSchema } from "../../src/config.js";
import { FreeWebError } from "../../src/errors.js";
import type { AppConfig } from "../../src/config.js";
import {
  EgoProcessRunner,
  EgoProvider,
  type EgoRunRequest,
  type EgoRunResult,
  type EgoRunner,
  type EgoSpawnFn,
} from "../../src/providers/ego.js";
import { isSafeNavigationUrl, parseEgoUrl, prepareEgoCall } from "../../src/providers/ego-methods.js";
import { browseOutputSchema, type BrowseEvaluateInput, type BrowseInput } from "../../src/types.js";

type EgoPayload = Record<string, unknown>;

class FakeRunner implements EgoRunner {
  readonly calls: EgoRunRequest[] = [];
  private responders: Array<(request: EgoRunRequest, index: number) => EgoRunResult | Promise<EgoRunResult>> = [];
  private fallback: (request: EgoRunRequest, index: number) => EgoRunResult | Promise<EgoRunResult>;

  constructor(fallback?: (request: EgoRunRequest, index: number) => EgoRunResult) {
    this.fallback = fallback ?? ((request) => egoResult(request, taskPayload(7, "agent")));
  }

  queue(...responders: Array<(request: EgoRunRequest, index: number) => EgoRunResult | Promise<EgoRunResult>>): this {
    this.responders.push(...responders);
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.responders.length = 0;
  }

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    const index = this.calls.length;
    this.calls.push(request);
    const responder = this.responders.shift() ?? this.fallback;
    return await responder(request, index);
  }
}

function parseScriptArray(source: string, pattern: RegExp): string[] {
  const match = pattern.exec(source);
  if (!match) return [];
  const parsed = JSON.parse(match[1]) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

interface SimTab {
  readonly id: string;
  label: string | null;
  url: string;
  title: string;
  readonly openedBy: string;
  readonly active: boolean;
}

/**
 * Models ego-lite 0.6.3.14: finish(keep) retains tab objects in their original order but
 * drops their labels, and the next claim sees those unlabeled tabs. Restoration assigns
 * labels to those exact tab objects from the saved tab-order label list.
 */
class LabelLifecycleRunner implements EgoRunner {
  readonly calls: EgoRunRequest[] = [];
  readonly adoptedAs: string[] = [];
  workPages: string[] = [];
  workValue: unknown = undefined;
  lastWorkLabels: string[] = [];
  private tabs: SimTab[] = [];
  private nextTabId = 1;

  seedTabs(specs: Array<{ label: string; url: string; title: string }>): void {
    this.tabs = specs.map((spec, index) => ({
      id: `tab-${this.nextTabId++}`,
      label: spec.label,
      url: spec.url,
      title: spec.title,
      openedBy: "agent",
      active: index === 0,
    }));
  }

  pageOrder(): string[] {
    return this.tabs.map((tab) => tab.label).filter((label): label is string => label !== null);
  }

  labelsByTabId(): Record<string, string | null> {
    return Object.fromEntries(this.tabs.map((tab) => [tab.id, tab.label]));
  }

  labelForUrl(url: string): string | null {
    return this.tabs.find((tab) => tab.url === url)?.label ?? null;
  }

  changeIdentity(url: string, replacement: string, title?: string): void {
    const tab = this.tabs.find((entry) => entry.url === url);
    if (!tab) throw new Error(`no tab with url ${url}`);
    tab.url = replacement;
    tab.title = title ?? `Changed ${replacement}`;
  }

  private errorResult(request: EgoRunRequest, code: string, message: string, details: Record<string, unknown>): EgoRunResult {
    return egoResult(request, { ok: false, error: { name: "Error", message, code, details } });
  }

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    this.calls.push(request);
    const script = request.script;
    const keptPages = parseScriptArray(script, /const KEPT_PAGES = (\[[^\]]*\]);/);
    const pageOrder = parseScriptArray(script, /const PAGE_ORDER = (\[[^\]]*\]);/);
    const pageLabel = /const PAGE_LABEL = "([^"]+)";/.exec(script)?.[1];

    if (request.kind === "finish") {
      const keep = keptPages.length
        ? keptPages
        : parseScriptArray(script, /await task\.finish\(\{ keep: (\[[^\]]*\]) \}\)/);
      const keptTabs = this.tabs.filter((tab) => tab.label !== null && keep.includes(tab.label));
      const order = keptTabs.map((tab) => tab.label as string);
      // Kept tab objects stay in their original order; only their labels end.
      this.tabs = keptTabs;
      for (const tab of this.tabs) tab.label = null;
      return egoResult(request, { ...finishPayload(7), pages: keep, pageOrder: order });
    }

    if (/const TASK_ID = null;/.test(script) && this.tabs.length === 0) {
      this.seedTabs([{
        label: pageLabel ?? "p1",
        url: `https://page.test/${pageLabel ?? "p1"}`,
        title: `Page ${pageLabel ?? "p1"}`,
      }]);
    }

    // Real ego-lite hard-stops when taskSpace(id) is used to preview a finished Space.
    if (
      script.includes("const preview = await taskSpace(RESOLVED_ID);") &&
      !/const TASK_ID = null;/.test(script) &&
      this.tabs.some((tab) => tab.label === null)
    ) {
      return hardStopResult();
    }

    const candidates = this.tabs.filter((tab) => tab.label === null && tab.openedBy === "agent");
    if (candidates.length > 0) {
      const labels = [...new Set(pageOrder)];
      candidates.forEach((tab, index) => {
        const saved = labels[index] ?? (labels.length === 0 && keptPages.length === 1 && candidates.length === 1 ? keptPages[0] : undefined);
        tab.label = saved ?? `p${index + 1}`;
        this.adoptedAs.push(tab.label);
      });
    }

    const labels = this.pageOrder();
    if (pageLabel && !labels.includes(pageLabel)) {
      return this.errorResult(request, "EGO_PAGE_NOT_FOUND", `Page ${pageLabel} was not found`, {
        requestedPage: pageLabel,
        availablePages: labels,
      });
    }

    const explicitAs = /task\.adopt\(egoTab0\.page, \{ as: "([^"]+)" \}\)/.exec(script)?.[1];
    if (explicitAs) {
      const active = this.tabs.find((tab) => tab.active) ?? this.tabs[0];
      if (active) {
        active.label = explicitAs;
        active.url = `https://page.test/${explicitAs}`;
        active.title = `Page ${explicitAs}`;
        this.adoptedAs.push(explicitAs);
      }
    }

    const actualLabels = this.pageOrder();
    const pages = this.workPages.length ? [...this.workPages] : actualLabels;
    this.lastWorkLabels = [...actualLabels];
    const value = this.workValue;
    this.workPages = [];
    this.workValue = undefined;
    return egoResult(request, {
      ...taskPayload(7, "agent", pages),
      ...(value === undefined ? {} : { value }),
      pageOrder: this.pageOrder(),
    });
  }
}

/** Runner whose node scripts stay in flight until the test releases them. */
class ConcurrencyRunner implements EgoRunner {
  private readonly scripts: string[] = [];
  private readonly pending = new Map<string, () => void>();
  inFlight = 0;
  peak = 0;

  started(script: string): boolean {
    return this.scripts.includes(script);
  }

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    this.scripts.push(request.script);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await new Promise<void>((release) => this.pending.set(request.script, release));
      return egoResult(request, { ok: true }, { exitCode: 0, stdout: `ran ${request.script}\n` });
    } finally {
      this.inFlight -= 1;
    }
  }

  finish(script: string): void {
    const release = this.pending.get(script);
    if (!release) throw new Error(`node script is not running: ${script}`);
    this.pending.delete(script);
    release();
  }
}

/** Artifact store that can run a callback at the moment a node result is saved. */
class HookedArtifactStore {
  private hook: (() => void) | undefined;

  constructor(private readonly root: string) {}

  onNextSave(hook: () => void): void {
    this.hook = hook;
  }

  async save(options: { data: string | Buffer; mimeType: string }) {
    const hook = this.hook;
    this.hook = undefined;
    hook?.();
    const id = "00000000-0000-4000-8000-000000000001";
    return {
      id,
      uri: `freeweb://artifacts/${id}`,
      path: join(this.root, "artifacts", id, "content"),
      mimeType: options.mimeType,
      size: 0,
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
    };
  }
}

/** Minimal child process double for EgoProcessRunner spawn wiring tests. */
function fakeEgoChild(options: { stdout?: string; stderr?: string; exitCode?: number | null } = {}) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill: () => {
      child.emit("close", null, "SIGKILL");
      return true;
    },
  });
  setImmediate(() => {
    if (options.stdout) stdout.write(options.stdout);
    if (options.stderr) stderr.write(options.stderr);
    stdout.end();
    stderr.end();
    child.emit("close", options.exitCode ?? 0, null);
  });
  return child as unknown as ReturnType<EgoSpawnFn>;
}

/** Child that reports `exit` while a grandchild still holds the stdio pipes open. */
function exitOnlyEgoChild(options: { stdout?: string; exitCode?: number | null } = {}) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill: () => true,
  });
  setImmediate(() => {
    if (options.stdout) stdout.write(options.stdout);
    // Deliberately never emit `close`: only a real grandchild can close these pipes.
    child.emit("exit", options.exitCode ?? 0, null);
  });
  return child as unknown as ReturnType<EgoSpawnFn>;
}

/** Child that ignores SIGKILL and never reports `exit` or `close`. */
function wedgedEgoChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: () => true,
  });
  return child as unknown as ReturnType<EgoSpawnFn>;
}

/** Runner whose next managed call parks forever, like a wedged 60s browse. */
class WedgedRunner implements EgoRunner {
  readonly calls: EgoRunRequest[] = [];
  private wedged = false;
  private nextSpaceId = 7;

  wedgeNextManaged(): void {
    this.wedged = true;
  }

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    this.calls.push(request);
    if (this.wedged && request.kind === "managed") {
      this.wedged = false;
      return await new Promise<EgoRunResult>(() => {});
    }
    const spaceId = Number(/TASK_ID = (-?\d+)/.exec(request.script)?.[1] ?? 7);
    if (request.kind === "finish") return egoResult(request, finishPayload(spaceId));
    const created = this.nextSpaceId;
    this.nextSpaceId += 1;
    return egoResult(request, taskPayload(created, "agent"));
  }
}

/** Runner whose next managed call parks until the test releases it. */
class GatedManagedRunner implements EgoRunner {
  readonly calls: EgoRunRequest[] = [];
  parked = 0;
  private release: (() => void) | undefined;
  private parkNext = false;

  constructor(private readonly parkedPayload: EgoPayload = taskPayload(7, "agent")) {}

  parkNextManaged(): void {
    this.parkNext = true;
  }

  releaseParked(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    this.calls.push(request);
    if (request.kind === "managed" && this.parkNext) {
      this.parkNext = false;
      this.parked += 1;
      await new Promise<void>((resolve) => {
        this.release = () => {
          this.parked -= 1;
          resolve();
        };
      });
      return egoResult(request, this.parkedPayload);
    }
    if (request.kind === "finish") return egoResult(request, finishPayload(7));
    return egoResult(request, taskPayload(7, "agent"));
  }
}

/** Runner that parks shutdown finishes so the registry lock can be observed. */
class GatedReapRunner implements EgoRunner {
  readonly calls: EgoRunRequest[] = [];
  private readonly gates: Array<() => void> = [];
  private nextSpaceId = 7;

  get gatedCount(): number {
    return this.gates.length;
  }

  releaseGates(): void {
    for (const release of this.gates.splice(0)) release();
  }

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    this.calls.push(request);
    const spaceId = Number(/TASK_ID = (-?\d+)/.exec(request.script)?.[1] ?? 7);
    if (request.kind === "finish" && request.timeoutMs <= 5_000) {
      await new Promise<void>((release) => this.gates.push(release));
      return egoResult(request, finishPayload(spaceId));
    }
    if (request.kind === "finish") return egoResult(request, finishPayload(spaceId));
    const created = this.nextSpaceId;
    this.nextSpaceId += 1;
    return egoResult(request, taskPayload(created, "agent"));
  }
}

/** Runner that snapshots the registry while open() is still running. */
class PlaceholderObserverRunner implements EgoRunner {
  readonly calls: EgoRunRequest[] = [];
  observed: { tasks: Record<string, { spaceId: number; name: string }> } | undefined;

  constructor(private readonly registryPath: string) {}

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    this.calls.push(request);
    if (request.kind === "managed" && !this.observed) {
      this.observed = JSON.parse(await readFile(this.registryPath, "utf8")) as {
        tasks: Record<string, { spaceId: number; name: string }>;
      };
      return egoResult(request, taskPayload(7, "agent"));
    }
    if (request.kind === "finish") return egoResult(request, finishPayload(7));
    return egoResult(request, taskPayload(7, "agent"));
  }
}

/**
 * Runner that opens tasks immediately and holds each shutdown finish until every expected
 * shutdown finish is in flight, proving close() starts them concurrently.
 */
class ParallelCloseRunner implements EgoRunner {
  readonly calls: EgoRunRequest[] = [];
  readonly shutdownFinished: number[] = [];
  readonly openFinished: number[] = [];
  shutdownPeak = 0;
  private shutdownInFlight = 0;
  private nextSpaceId = 7;
  private readonly waiters = new Map<number, () => void>();
  private token = 0;

  constructor(private readonly expectedShutdownFinishes: number) {}

  resetTracking(): void {
    this.calls.length = 0;
    this.shutdownFinished.length = 0;
    this.openFinished.length = 0;
    this.shutdownPeak = 0;
  }

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    this.calls.push(request);
    const spaceId = Number(/const TASK_ID = (\d+);/.exec(request.script)?.[1] ?? -1);
    if (request.kind !== "finish") {
      const created = this.nextSpaceId;
      this.nextSpaceId += 1;
      return egoResult(request, taskPayload(created, "agent"));
    }
    // Opening a task also finishes it with the regular 30s managed timeout.
    if (request.timeoutMs > 5_000) {
      this.openFinished.push(spaceId);
      return egoResult(request, finishPayload(spaceId));
    }

    this.shutdownFinished.push(spaceId);
    this.shutdownInFlight += 1;
    this.shutdownPeak = Math.max(this.shutdownPeak, this.shutdownInFlight);
    const token = this.token;
    this.token += 1;
    const gate = new Promise<void>((resolve) => this.waiters.set(token, resolve));
    // A serial close would never reach the expected count; release on a watchdog so the
    // peak assertion fails instead of hanging the test.
    const watchdog = setTimeout(() => this.releaseWaiters(), 1_000);
    if (this.shutdownInFlight === this.expectedShutdownFinishes) this.releaseWaiters();
    await gate;
    clearTimeout(watchdog);
    this.shutdownInFlight -= 1;
    return egoResult(request, {
      ...finishPayload(spaceId, "agent"),
      // Foreign Spaces reported by the runtime must never be finished by close().
      spaces: [{ id: 999, ownership: "user" }],
    });
  }

  private releaseWaiters(): void {
    for (const resolve of this.waiters.values()) resolve();
    this.waiters.clear();
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  // CI workers may delay a runner for longer than the old fixed 50 × 1ms
  // window. Poll with real timers until a wall-clock deadline instead.
  const deadline = Date.now() + 2_000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function egoResult(
  request: EgoRunRequest,
  payload: EgoPayload,
  overrides: Partial<EgoRunResult> = {},
): EgoRunResult {
  const line = `${request.marker}${JSON.stringify(payload)}\n`;
  return {
    exitCode: 0,
    stdout: "",
    stderr: `ego-cli log line\n${line}`,
    durationMs: 12,
    timedOut: false,
    ...overrides,
  };
}

function taskPayload(spaceId: number, ownership: string, pages: string[] = ["p1"]): EgoPayload {
  return {
    ok: true,
    value: { observed: true },
    task: { spaceId, ownership, name: "freeweb task" },
    pages,
    spaces: [{ id: spaceId, ownership }],
  };
}

/**
 * The controlled ego-lite terminal-handoff fixture: a clean exit whose only output is the
 * owned user-control hard-stop guidance, because a handed-off round discards its buffer.
 */
const HANDOFF_HARD_STOP = [
  "Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.",
  "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
  "Wait until the user explicitly asks you to continue, then take control back and resume:",
  " const task = await takeOverTaskSpace(spaceId)",
].join("\n");

function hardStopResult(overrides: Partial<EgoRunResult> = {}): EgoRunResult {
  return {
    exitCode: 0,
    stdout: `${HANDOFF_HARD_STOP}\n`,
    stderr: "",
    durationMs: 8,
    timedOut: false,
    ...overrides,
  };
}

function finishPayload(spaceId: number, ownership = "user"): EgoPayload {
  return {
    ok: true,
    value: { finished: true },
    task: { spaceId, ownership, name: "freeweb task" },
    pages: ["p1"],
    receipt: { kept: ["p1"], closed: [] },
  };
}

async function makeConfig(dataDir: string, egoOverrides: Record<string, unknown> = {}): Promise<AppConfig> {
  const parsed = configFileSchema.parse({
    dataDir,
    ego: egoOverrides,
    artifacts: { inlineNodeChars: 1000 },
  });
  return { ...parsed, dataDir, tinyfish: { ...parsed.tinyfish } };
}

async function openTask(
  provider: EgoProvider,
  runner: FakeRunner,
  options: { spaceId?: number; profileId?: string; url?: string; name?: string } = {},
): Promise<string> {
  const spaceId = options.spaceId ?? 7;
  runner
    .queue(
      (request) => egoResult(request, taskPayload(spaceId, "agent")),
      (request) => egoResult(request, finishPayload(spaceId)),
    );
  const output = await provider.browse({
    action: "open",
    name: options.name ?? "demo task",
    page: "p1",
    ...(options.profileId === undefined ? {} : { profileId: options.profileId }),
    ...(options.url === undefined ? {} : { url: options.url }),
  });
  if (!output.browseId) throw new Error("expected browseId");
  return output.browseId;
}

async function openTaskWithPages(
  provider: EgoProvider,
  runner: FakeRunner,
  pages: string[],
): Promise<string> {
  const finish = { ...finishPayload(7), pages };
  runner.queue(
    (request) => egoResult(request, taskPayload(7, "agent", pages)),
    (request) => egoResult(request, finish),
  );
  const output = await provider.browse({
    action: "open",
    name: "page label task",
    page: pages[0] ?? "p1",
  });
  if (!output.browseId) throw new Error("expected browseId");
  return output.browseId;
}

async function openAndKeepPage(
  provider: EgoProvider,
  runner: LabelLifecycleRunner,
  label: string,
): Promise<string> {
  const opened = await provider.browse({ action: "open", name: "kept page task", page: "p1" });
  if (!opened.browseId) throw new Error("expected browseId");
  await provider.browse({
    action: "call",
    browseId: opened.browseId,
    page: "p1",
    method: "task.adopt",
    args: [{ active: true, as: label }],
  });
  return opened.browseId;
}

async function openWithTabs(
  dataDir: string,
  provider: EgoProvider,
  runner: LabelLifecycleRunner,
  tabs: Array<{ label: string; url: string; title: string }>,
): Promise<string> {
  const opened = await provider.browse({ action: "open", name: "identity task", page: "p1" });
  if (!opened.browseId) throw new Error("expected browseId");
  runner.seedTabs(tabs);
  const registryPath = join(dataDir, "browse", "tasks.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    tasks: Record<string, { pages: string[]; pageOrder?: string[] }>;
  };
  registry.tasks[opened.browseId]!.pages = tabs.map((tab) => tab.label);
  registry.tasks[opened.browseId]!.pageOrder = runner.pageOrder();
  await writeFile(registryPath, JSON.stringify(registry));
  return opened.browseId;
}

async function removePageOrder(dataDir: string, browseId: string): Promise<void> {
  const registryPath = join(dataDir, "browse", "tasks.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    tasks: Record<string, { pageOrder?: string[] }>;
  };
  delete registry.tasks[browseId]!.pageOrder;
  await writeFile(registryPath, JSON.stringify(registry));
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "freeweb-ego-test-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("EgoProvider managed browse", () => {
  it("creates a UUID/spaceId registry with private permissions and profile validation", async () => {
    const config = await makeConfig(dataDir, { allowedProfiles: ["Default", "Work"] });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });

    await expect(provider.browse({ action: "open", page: "p1", profileId: "Other" })).rejects.toMatchObject({
      code: "EGO_PROFILE_NOT_ALLOWED",
    });
    expect(runner.calls).toHaveLength(0);

    const browseId = await openTask(provider, runner);
    expect(browseId).toMatch(/^[0-9a-f-]{36}$/);

    const registryPath = join(dataDir, "browse", "tasks.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { spaceId: number; profileId: string }>;
    };
    expect(registry.tasks[browseId]).toMatchObject({ spaceId: 7, profileId: "Default" });
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);

    const createScript = runner.calls[0].script;
    expect(createScript).toContain("profileId: \"Default\"");
    expect(createScript).toContain("await listTaskSpaces()");
  });

  it("does not register a phantom Space when open fails before task creation", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "creation failed" },
      task: {},
      pages: [],
      spaces: [],
    }));

    await expect(provider.browse({ action: "open", page: "p1" })).rejects.toMatchObject({ code: "EGO_SCRIPT_ERROR" });
    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8").catch(() => JSON.stringify({ tasks: {} })));
    expect(registry.tasks).toEqual({});
  });

  it("enforces maxTasks before creating another space", async () => {
    const config = await makeConfig(dataDir, { maxTasks: 1 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    await openTask(provider, runner, { spaceId: 7 });

    runner.reset();
    await expect(provider.browse({ action: "open", page: "p1" })).rejects.toMatchObject({ code: "EGO_TASK_LIMIT" });
    expect(runner.calls).toHaveLength(0);
  });

  it("keeps work and finish in separate runner invocations with a minimal keep list", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    const output = await provider.browse({ action: "status", browseId, page: "p1" });
    expect(output).toMatchObject({ browseId, spaceId: 7, status: "ok" });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0].timeoutMs).toBe(30_000);
    const work = runner.calls[0].script;
    const finish = runner.calls[1].script;
    expect(work).not.toContain("task.finish(");
    expect(work).toContain("claimTaskSpace");
    expect(work).toContain("takeOverTaskSpace");
    expect(work).toContain("task.adopt(");
    expect(finish).toContain("await task.finish({ keep: [\"p1\"] })");
    expect(finish).toContain("const KEEP_COUNT = 1;");
    expect(finish).toContain("task.adopt(");
    expect(finish).not.toContain("page.snapshot(");
    expect(finish).not.toContain("page.goto(");
  });

  it("adopts only the pages a finish keeps, never the stale page count", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent", ["p1", "p2"])),
      (request) => egoResult(request, finishPayload(7)),
    );
    const output = await provider.browse({ action: "status", browseId, page: "p1" });
    expect(output.pages).toEqual(["p1"]);

    const finish = runner.calls[1].script;
    expect(finish).toContain("await task.finish({ keep: [\"p1\"] })");
    expect(finish).toContain("const KEEP_COUNT = 1;");
    expect(finish).not.toContain("const KEEP_COUNT = 2;");
    expect(finish).toContain("task.adopt(");
  });

  it("handoff does not finish, and resume takes over the same space", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    runner.reset();
    runner.queue((request) =>
      egoResult(request, {
        ...taskPayload(7, "agentDelegatedToUser"),
        value: { handedOff: true },
      }),
    );
    const handoff = await provider.browse({ action: "handoff", browseId, page: "p1" });
    expect(handoff.status).toBe("handoff");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].script).toContain("await task.handOff()");
    expect(runner.calls[0].script).not.toContain("task.finish(");

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({ action: "resume", browseId, page: "p1" });
    expect(runner.calls[0].script).toContain("takeOverTaskSpace");
    expect(runner.calls[1].script).toContain("await task.finish({ keep: [\"p1\"] })");
  });

  it("treats a confirmed user-control hard stop as a successful handoff that persists ownership", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    runner.reset();
    runner.queue(() => hardStopResult());
    const handoff = await provider.browse({ action: "handoff", browseId, page: "p1" });
    expect(handoff).toMatchObject({ browseId, spaceId: 7, status: "handoff", result: { handedOff: true }, pages: ["p1"] });
    expect(handoff.warnings).toBeUndefined();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].script).toContain("await task.handOff()");
    expect(runner.calls[0].script).not.toContain("task.finish(");

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number; status: string; ownership: string }>;
    };
    expect(Object.keys(registry.tasks)).toEqual([browseId]);
    expect(registry.tasks[browseId]).toMatchObject({ spaceId: 7, status: "handoff", ownership: "agentDelegatedToUser" });

    // Status after handoff reads the serialized state and never runs an ego call.
    runner.reset();
    const status = await provider.browse({ action: "status", browseId, page: "p1" });
    expect(status).toMatchObject({ browseId, spaceId: 7, status: "handoff", pages: ["p1"] });
    expect(status.result).toEqual({ status: "handoff", ownership: "agentDelegatedToUser", pages: ["p1"] });
    expect(runner.calls).toHaveLength(0);

    // Everything that targets the Page stays blocked until the explicit resume.
    await expect(provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] })).rejects.toMatchObject({ code: "EGO_USER_CONTROL_REQUIRED" });
    await expect(provider.evaluate({ browseId, page: "p1", script: "document.title" })).rejects.toMatchObject({ code: "EGO_USER_CONTROL_REQUIRED" });
    expect(runner.calls).toHaveLength(0);
  });

  it("keeps ambiguous handoff results as errors without marking the task handed off", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number; status: string; ownership: string }>;
    };
    const ownershipBeforeHandoff = registry.tasks[browseId]!.ownership;

    const cases: Array<{ label: string; result: EgoRunResult; code: string }> = [
      {
        label: "nonzero exit with the handoff diagnostic",
        result: hardStopResult({ exitCode: 1 }),
        code: "EGO_RUN_FAILED",
      },
      {
        label: "timeout with the handoff diagnostic",
        result: hardStopResult({ exitCode: null, signal: "SIGKILL", timedOut: true }),
        code: "EGO_TIMEOUT",
      },
      {
        label: "clean exit with unrelated missing output",
        result: { exitCode: 0, stdout: "", stderr: "session closed\n", durationMs: 4, timedOut: false },
        code: "EGO_NO_RESULT",
      },
      {
        label: "clean exit with an unrecognized hard-stop diagnostic",
        result: { exitCode: 0, stdout: "", stderr: "The user now controls this task space.\nResume only after the user confirms, using takeOverTaskSpace(spaceId).\n", durationMs: 4, timedOut: false },
        code: "EGO_NO_RESULT",
      },
    ];

    for (const testCase of cases) {
      runner.reset();
      runner.queue(() => testCase.result);
      await expect(
        provider.browse({ action: "handoff", browseId, page: "p1" }),
        testCase.label,
      ).rejects.toMatchObject({ code: testCase.code });

      const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
        tasks: Record<string, { spaceId: number; status: string; ownership: string }>;
      };
      expect(Object.keys(registry.tasks), testCase.label).toEqual([browseId]);
      expect(registry.tasks[browseId], testCase.label).toMatchObject({
        spaceId: 7,
        status: "active",
        ownership: ownershipBeforeHandoff,
      });
    }
  });

  it("does not weaken generic missing-payload handling for other managed operations", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    runner.reset();
    runner.queue(
      () => hardStopResult(),
      () => hardStopResult(),
      () => hardStopResult(),
    );
    await expect(provider.browse({ action: "status", browseId, page: "p1" })).rejects.toMatchObject({ code: "EGO_NO_RESULT" });
    await expect(provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] })).rejects.toMatchObject({ code: "EGO_NO_RESULT" });
    await expect(provider.evaluate({ browseId, page: "p1", script: "document.title" })).rejects.toMatchObject({ code: "EGO_NO_RESULT" });

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { status: string; ownership: string }>;
    };
    // The generic error path must not flip a working registration into handoff.
    expect(registry.tasks[browseId]).toMatchObject({ status: "active" });
    expect(registry.tasks[browseId]!.ownership).not.toBe("agentDelegatedToUser");
  });

  it("requires an explicit resume before work can take over a handed-off Space", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();
    runner.queue(() => hardStopResult());
    await provider.browse({ action: "handoff", browseId, page: "p1" });
    runner.reset();

    // Status stays readable without resuming, but Page-targeted work does not.
    await expect(provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] })).rejects.toMatchObject({ code: "EGO_USER_CONTROL_REQUIRED" });
    await expect(provider.evaluate({ browseId, page: "p1", script: "document.title" })).rejects.toMatchObject({ code: "EGO_USER_CONTROL_REQUIRED" });
    expect(runner.calls).toHaveLength(0);

    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    const resumed = await provider.browse({ action: "resume", browseId, page: "p1" });
    expect(resumed.status).toBe("ok");
    expect(runner.calls[0].script).toContain("takeOverTaskSpace");

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number; status: string; ownership: string }>;
    };
    expect(registry.tasks[browseId]).toMatchObject({ spaceId: 7, status: "active" });
    expect(registry.tasks[browseId]!.ownership).not.toBe("agentDelegatedToUser");

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await expect(provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] })).resolves.toMatchObject({ status: "ok" });
  });

  it("closes with keep:[] and forgets only that managed task", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    runner.reset();
    runner.queue((request) => egoResult(request, finishPayload(7, "agent")));
    const output = await provider.browse({ action: "close", browseId, page: "p1" });
    expect(output.status).toBe("closed");
    expect(runner.calls).toHaveLength(1);
    const finish = runner.calls[0].script;
    expect(finish).toContain("await task.finish({ keep: [] })");
    expect(finish).toContain("const KEEP_COUNT = 0;");
    expect(finish).not.toContain("task.adopt(");

    await expect(provider.browse({ action: "status", browseId, page: "p1" })).rejects.toMatchObject({
      code: "EGO_TASK_NOT_FOUND",
    });
  });

  it("reaps only expired registered tasks", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 60_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    const browseId = await openTask(provider, runner);

    now += 20_000;
    runner.reset();
    runner.queue((request) => egoResult(request, finishPayload(7, "agent")));
    await provider.reapExpired();

    expect(runner.calls).toHaveLength(1);
    const finish = runner.calls[0].script;
    expect(finish).toContain("await task.finish({ keep: [] })");
    expect(finish).toContain("const KEEP_COUNT = 0;");
    expect(finish).not.toContain("task.adopt(");
    expect(finish).toContain("7");
    await expect(provider.browse({ action: "status", browseId, page: "p1" })).rejects.toMatchObject({
      code: "EGO_TASK_NOT_FOUND",
    });
  });
});

describe("EgoProvider call whitelist", () => {
  it("rejects native methods that would bypass managed lifecycle or page evaluation", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    for (const method of [
      "evaluate",
      "page.evaluate",
      "page.cdp",
      "task.cdp",
      "task.finish",
      "task.handOff",
      "task.waitForControl",
      "taskSpace",
      "claimTaskSpace",
      "download.saveAs",
      "fileChooser.setFiles",
    ]) {
      await expect(
        provider.browse({ action: "call", browseId, page: "p1", method, args: [] }),
      ).rejects.toMatchObject({ code: "EGO_METHOD_NOT_ALLOWED" });
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("validates each method's JSON arguments and rejects out-of-scope paths", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    await expect(
      provider.browse({ action: "call", browseId, page: "p1", method: "page.click", args: [42] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.browse({
        action: "call",
        browseId,
        page: "p1",
        method: "page.screenshot",
        args: [{ path: "/etc/passwd" }],
      }),
    ).rejects.toMatchObject({ code: "EGO_PATH_FORBIDDEN" });
    await expect(
      provider.browse({ action: "call", browseId, page: "p1", method: "page.goto", args: ["http://127.0.0.1/"] }),
    ).rejects.toMatchObject({ code: "PRIVATE_URL_BLOCKED" });
    expect(runner.calls).toHaveLength(0);

    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] });
    expect(runner.calls[0].script).toContain("page.snapshot(");
  });

  it("arms popups, downloads and file choosers before the triggering action", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.waitForEvent",
      args: ["download", { timeout: 30_000 }],
      options: {
        action: { method: "page.click", args: ["button.download"] },
        saveAs: join(dataDir, "downloads", "report.pdf"),
      },
    });
    let script = runner.calls[0].script;
    expect(script.indexOf("page.waitForEvent(")).toBeLessThan(script.indexOf("page.click("));
    expect(script.indexOf("page.click(")).toBeLessThan(script.indexOf(".saveAs("));

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.waitForFileChooser",
      args: [{ timeout: 10_000 }],
      options: {
        action: { method: "page.click", args: ["button.upload"] },
        files: [join(dataDir, "uploads", "report.pdf")],
      },
    });
    script = runner.calls[0].script;
    expect(script.indexOf("page.waitForFileChooser(")).toBeLessThan(script.indexOf("page.click("));
    expect(script.indexOf("page.click(")).toBeLessThan(script.indexOf(".setFiles("));
  });

  it("uses a safe argument-driven waitForFunction form", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    await expect(
      provider.browse({
        action: "call",
        browseId,
        page: "p1",
        method: "page.waitForFunction",
        args: ["() => window.hacked = true"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(runner.calls).toHaveLength(0);

    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.waitForFunction",
      args: [{ selector: "#ready", text: "done" }, { timeout: 5000 }],
    });
    const script = runner.calls[0].script;
    expect(script).toContain("page.waitForFunction(");
    expect(script).not.toContain("window.hacked");
    expect(script).toContain("condition.selector");
  });
});

describe("EgoProvider managed native API coverage", () => {
  it("runs page.fetch with validated options and returns the native structured response", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    const saveAs = join(dataDir, "downloads", "items.json");
    runner.queue(
      (request) => egoResult(request, {
        ...taskPayload(7, "agent"),
        value: {
          ok: true,
          status: 200,
          statusText: "OK",
          url: "https://example.com/api/items",
          headers: { "content-type": "application/json" },
          body: "{\"ok\":true}",
        },
      }),
      (request) => egoResult(request, finishPayload(7)),
    );
    const output = await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.fetch",
      args: [
        "/api/items",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{\"limit\":20}",
          timeout: 10_000,
          saveAs,
        },
      ],
    });

    expect(output.result).toMatchObject({ ok: true, status: 200, body: "{\"ok\":true}" });
    const script = runner.calls[0].script;
    expect(script).toContain("await page.fetch(");
    expect(script).toContain('"POST"');
    expect(script).toContain('"/api/items"');
    expect(script).toContain(JSON.stringify(saveAs));
    expect(script).toContain('"timeout":10000');
    expect(runner.calls[0].timeoutMs).toBe(30_000);
  });

  it("validates page.fetch URL, options and saveAs containment", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    for (const args of [
      [],
      ["/api/items", { targetId: "cross-round" }],
      ["/api/items", { method: "BAD METHOD" }],
      ["/api/items", { method: 42 }],
      ["/api/items", { headers: { "x-test": 42 } }],
      ["/api/items", { body: 42 }],
      ["/api/items", { timeout: -1 }],
      ["file:///etc/passwd"],
      ["//evil.example/path"],
      ["  http://127.0.0.1/"],
    ]) {
      await expect(
        provider.browse({ action: "call", browseId, page: "p1", method: "page.fetch", args }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(
      provider.browse({
        action: "call",
        browseId,
        page: "p1",
        method: "page.fetch",
        args: ["https://example.com/report.pdf", { saveAs: "/etc/report.pdf" }],
      }),
    ).rejects.toMatchObject({ code: "EGO_PATH_FORBIDDEN" });
    await expect(
      provider.browse({
        action: "call",
        browseId,
        page: "p1",
        method: "page.fetch",
        args: ["http://127.0.0.1/"],
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_URL_BLOCKED" });
    expect(runner.calls).toHaveLength(0);
  });

  it("runs parameterless page.events", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    await expect(
      provider.browse({ action: "call", browseId, page: "p1", method: "page.events", args: [1] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(runner.calls).toHaveLength(0);

    runner.queue(
      (request) => egoResult(request, { ...taskPayload(7, "agent"), value: [{ event: "Network.requestWillBeSent" }] }),
      (request) => egoResult(request, finishPayload(7)),
    );
    const output = await provider.browse({ action: "call", browseId, page: "p1", method: "page.events", args: [] });
    expect(output.result).toEqual([{ event: "Network.requestWillBeSent" }]);
    expect(runner.calls[0].script).toContain("await page.events()");
  });

  it("releases an unknown-origin page by label without closing it", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    await expect(
      provider.browse({ action: "call", browseId, page: "p1", method: "task.release", args: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(runner.calls).toHaveLength(0);

    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    const output = await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "task.release",
      args: ["p2"],
    });
    expect(output.status).toBe("ok");
    const script = runner.calls[0].script;
    expect(script).toContain('await task.release("p2")');
    expect(script).not.toContain("page.close(");
    expect(script).not.toContain("task.finish(");
  });

  it("adopts only an explicit tab in the current space", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    for (const args of [[], [{ targetId: "cross-round" }], [{ active: true, index: 0 }]]) {
      await expect(
        provider.browse({ action: "call", browseId, page: "p1", method: "task.adopt", args }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(runner.calls).toHaveLength(0);

    const cases: Array<{ args: unknown[]; expected: string[] }> = [
      { args: [{ active: true, as: "p2" }], expected: [".find((tab) => tab.active)", 'task.adopt(egoTab0.page, { as: "p2" })'] },
      { args: [{ index: 1 }], expected: ["egoTabs0[1]", "task.adopt(egoTab0.page)"] },
      { args: [{ label: "p3" }], expected: ['tab.label === "p3"'] },
    ];
    for (const testCase of cases) {
      runner.reset();
      runner.queue(
        (request) => egoResult(request, { ...taskPayload(7, "agent", ["p1", "p2"]), value: { label: "p2" } }),
        (request) => egoResult(request, finishPayload(7)),
      );
      const output = await provider.browse({
        action: "call",
        browseId,
        page: "p1",
        method: "task.adopt",
        args: testCase.args,
      });
      const script = runner.calls[0].script;
      expect(script).toContain("task.tabs()");
      for (const expected of testCase.expected) expect(script).toContain(expected);
      expect(script).not.toContain("targetId");
      expect(script).not.toContain("EGO_PAGE_MISSING");
      expect(output.pages).toEqual(["p1", "p2"]);
    }
  });
});

describe("EgoProvider Page label resolution", () => {
  it("rejects an unknown Page label for a page-targeted native call before any ego script runs", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTaskWithPages(provider, runner, ["p1", "p2"]);
    runner.reset();

    await expect(provider.browse({
      action: "call",
      browseId,
      page: "p9",
      method: "page.snapshot",
      args: [],
    })).rejects.toMatchObject({
      code: "EGO_PAGE_NOT_FOUND",
      options: { details: { requestedPage: "p9", availablePages: ["p1", "p2"] } },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects an unknown Page label for Page Evaluation before any ego script runs", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTaskWithPages(provider, runner, ["p1", "p2"]);
    runner.reset();

    await expect(provider.evaluate({
      browseId,
      page: "p9",
      script: "document.title",
    })).rejects.toMatchObject({
      code: "EGO_PAGE_NOT_FOUND",
      options: { details: { requestedPage: "p9", availablePages: ["p1", "p2"] } },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("keeps the deterministic p1 default and still fails when p1 is absent", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTaskWithPages(provider, runner, ["p2"]);
    runner.reset();

    await expect(provider.evaluate({ browseId, script: "document.title" } as BrowseEvaluateInput)).rejects.toMatchObject({
      code: "EGO_PAGE_NOT_FOUND",
      options: { details: { requestedPage: "p1", availablePages: ["p2"] } },
    });
    await expect(provider.browse({
      action: "call",
      browseId,
      method: "page.snapshot",
      args: [],
    } as unknown as BrowseInput)).rejects.toMatchObject({
      code: "EGO_PAGE_NOT_FOUND",
      options: { details: { requestedPage: "p1", availablePages: ["p2"] } },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("leaves Task-level native calls unchanged when a Page label is unknown", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTaskWithPages(provider, runner, ["p1", "p2"]);
    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent", ["p1", "p2"])),
      (request) => egoResult(request, { ...finishPayload(7), pages: ["p1", "p2"] }),
    );

    const output = await provider.browse({
      action: "call",
      browseId,
      page: "p9",
      method: "task.pages",
      args: [],
    });
    expect(output.status).toBe("ok");
    expect(runner.calls).toHaveLength(2);
  });

  it("restores a kept non-p1 label on claim and continues Page work", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openAndKeepPage(provider, runner, "p2");

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { pages: string[] }>;
    };
    expect(registry.tasks[browseId]!.pages).toEqual(["p2"]);

    const before = runner.calls.length;
    const worked = await provider.browse({
      action: "call",
      browseId,
      page: "p2",
      method: "page.snapshot",
      args: [],
    });
    expect(worked).toMatchObject({ status: "ok", result: { observed: true }, pages: ["p2"] });
    expect(runner.calls[before]!.script).toContain("const PAGE_ORDER = ");
    expect(runner.adoptedAs.at(-1)).toBe("p2");
    expect(runner.lastWorkLabels).toEqual(["p2"]);

    const evaluated = await provider.evaluate({ browseId, page: "p2", script: "document.title" });
    expect(evaluated).toMatchObject({ status: "ok", result: { observed: true }, pages: ["p2"] });
  });

  it("restores original labels when keep order differs from tab order", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const p1Url = "https://page.test/p1";
    const p2Url = "https://page.test/p2";
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p1", url: p1Url, title: "Page 1" },
      { label: "p2", url: p2Url, title: "Page 2" },
    ]);

    runner.workPages = ["p2", "p1"];
    runner.workValue = { popup: { label: "p1" } };
    const first = await provider.browse({
      action: "call",
      browseId,
      page: "p2",
      method: "page.snapshot",
      args: [],
    });
    expect(first).toMatchObject({ status: "ok", pages: ["p2", "p1"] });

    const before = runner.calls.length;
    const second = await provider.browse({
      action: "call",
      browseId,
      page: "p2",
      method: "page.snapshot",
      args: [],
    });
    expect(second).toMatchObject({ status: "ok", pages: ["p2"] });
    expect(runner.lastWorkLabels).toEqual(["p1", "p2"]);
    expect(runner.adoptedAs.slice(-2).sort()).toEqual(["p1", "p2"]);
    expect(runner.calls[before]!.script).toContain("const PAGE_ORDER = ");
  });

  it("restores the correct label when a subset of tab-order Pages is kept", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const p1Url = "https://page.test/p1";
    const p2Url = "https://page.test/p2";
    const p3Url = "https://page.test/p3";
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p1", url: p1Url, title: "Page 1" },
      { label: "p2", url: p2Url, title: "Page 2" },
      { label: "p3", url: p3Url, title: "Page 3" },
    ]);

    runner.workPages = ["p2"];
    const first = await provider.browse({
      action: "call",
      browseId,
      page: "p2",
      method: "page.snapshot",
      args: [],
    });
    expect(first).toMatchObject({ status: "ok", pages: ["p2"] });

    const second = await provider.evaluate({ browseId, page: "p2", script: "document.title" });
    expect(second).toMatchObject({ status: "ok", pages: ["p2"] });
    expect(runner.lastWorkLabels).toEqual(["p2"]);
    expect(runner.labelForUrl(p1Url)).toBeNull();
    expect(runner.labelForUrl(p3Url)).toBeNull();
  });

  it("keeps restored labels after a failed exact-label claim so retry is non-destructive", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p1", url: "https://page.test/p1", title: "Page 1" },
      { label: "p2", url: "https://page.test/p2", title: "Page 2" },
    ]);

    runner.workPages = ["p1"];
    await provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] });
    const registryPath = join(dataDir, "browse", "tasks.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { pages: string[] }>;
    };
    registry.tasks[browseId]!.pages = ["p1", "p2"];
    await writeFile(registryPath, JSON.stringify(registry));
    const before = runner.calls.length;

    await expect(provider.browse({
      action: "call",
      browseId,
      page: "p2",
      method: "page.snapshot",
      args: [],
    })).rejects.toMatchObject({ code: "EGO_PAGE_NOT_FOUND" });
    expect(runner.pageOrder()).toEqual(["p1"]);
    expect(runner.calls.length).toBe(before + 1);

    const retry = await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.snapshot",
      args: [],
    });
    expect(retry).toMatchObject({ status: "ok", pages: ["p1"] });
    expect(runner.lastWorkLabels).toEqual(["p1"]);
  });

  it("restores labels for duplicate about:blank tabs without relying on url/title", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p1", url: "about:blank", title: "Blank" },
      { label: "p2", url: "about:blank", title: "Blank" },
    ]);

    runner.workPages = ["p2", "p1"];
    runner.workValue = { popup: { label: "p1" } };
    await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    const worked = await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });

    expect(worked.status).toBe("ok");
    expect(runner.lastWorkLabels).toEqual(["p1", "p2"]);
  });

  it("restores a kept label after navigation changes url and title", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const p2Url = "https://page.test/p2";
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p1", url: "https://page.test/p1", title: "Page 1" },
      { label: "p2", url: p2Url, title: "Page 2" },
    ]);

    runner.workPages = ["p2"];
    await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    runner.changeIdentity(p2Url, "https://page.test/navigated", "Navigated");

    const worked = await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    expect(worked.status).toBe("ok");
    expect(runner.lastWorkLabels).toEqual(["p2"]);
  });

  it("restores a kept label after a title-only change", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const p2Url = "https://page.test/p2";
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p1", url: "https://page.test/p1", title: "Page 1" },
      { label: "p2", url: p2Url, title: "Page 2" },
    ]);

    runner.workPages = ["p2"];
    await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    runner.changeIdentity(p2Url, p2Url, "Renamed");

    const worked = await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    expect(worked.status).toBe("ok");
    expect(runner.lastWorkLabels).toEqual(["p2"]);
  });

  it("uses registry labels deterministically for a legacy single-Page row", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p2", url: "https://page.test/p2", title: "Page 2" },
    ]);

    runner.workPages = ["p2"];
    await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    await removePageOrder(dataDir, browseId);

    const worked = await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    expect(worked.status).toBe("ok");
    expect(runner.lastWorkLabels).toEqual(["p2"]);
  });

  it("adopts every tab under ego's labels for an unlabeled legacy multi-Page row", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p1", url: "https://page.test/p1", title: "Page 1" },
      { label: "p2", url: "https://page.test/p2", title: "Page 2" },
    ]);

    runner.workPages = ["p2", "p1"];
    runner.workValue = { popup: { label: "p1" } };
    await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    // finish() has now unlabeled both surviving tabs; the registry row is legacy.
    await removePageOrder(dataDir, browseId);

    const worked = await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    expect(worked.status).toBe("ok");
    expect(runner.lastWorkLabels).toEqual(["p1", "p2"]);
    expect(runner.adoptedAs.slice(-2)).toEqual(["p1", "p2"]);
    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { pageOrder?: string[] }>;
    };
    expect(registry.tasks[browseId]!.pageOrder).toEqual(["p2"]);
    expect(runner.calls.some((call) => call.script.includes("const preview = await taskSpace(RESOLVED_ID);"))).toBe(false);
  });

  it("uses ego's labels when a legacy saved list is shorter than surviving tabs", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openWithTabs(dataDir, provider, runner, [
      { label: "p1", url: "https://page.test/p1", title: "Page 1" },
      { label: "p2", url: "https://page.test/p2", title: "Page 2" },
    ]);

    runner.workPages = ["p2", "p1"];
    runner.workValue = { popup: { label: "p1" } };
    await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    const registryPath = join(dataDir, "browse", "tasks.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { pages: string[]; pageOrder?: string[] }>;
    };
    registry.tasks[browseId]!.pages = ["p2"];
    delete registry.tasks[browseId]!.pageOrder;
    await writeFile(registryPath, JSON.stringify(registry));

    const worked = await provider.browse({ action: "call", browseId, page: "p2", method: "page.snapshot", args: [] });
    expect(worked.status).toBe("ok");
    expect(runner.lastWorkLabels).toEqual(["p1", "p2"]);
    expect(new Set(runner.lastWorkLabels).size).toBe(2);
    const after = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { pageOrder?: string[] }>;
    };
    expect(after.tasks[browseId]!.pageOrder).toEqual(["p2"]);
  });

  it("still rejects a genuinely missing label after a kept non-p1 round", async () => {
    const config = await makeConfig(dataDir);
    const runner = new LabelLifecycleRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openAndKeepPage(provider, runner, "p2");
    const before = runner.calls.length;

    await expect(provider.evaluate({ browseId, page: "p3", script: "document.title" })).rejects.toMatchObject({
      code: "EGO_PAGE_NOT_FOUND",
      options: { details: { requestedPage: "p3", availablePages: ["p2"] } },
    });
    expect(runner.calls.length).toBe(before);
  });

  it("accepts an exact available Page label", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTaskWithPages(provider, runner, ["p1", "p2"]);
    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent", ["p1", "p2"])),
      (request) => egoResult(request, { ...finishPayload(7), pages: ["p1", "p2"] }),
    );

    const output = await provider.browse({
      action: "call",
      browseId,
      page: "p2",
      method: "page.snapshot",
      args: [],
    });
    expect(output.status).toBe("ok");
    expect(output.pages).toEqual(["p2"]);
    expect(runner.calls).toHaveLength(2);
  });
});

describe("EgoProvider evaluate", () => {
  it("passes user script as JSON data to page.evaluate and serializes page errors", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    const script = '() => { globalThis.process = 1; return document.title; } // `"; process.exit(1); //';
    runner.queue(
      (request) =>
        egoResult(request, {
          ...taskPayload(7, "agent"),
          value: "title",
        }),
      (request) => egoResult(request, finishPayload(7)),
    );
    const output = await provider.evaluate({ browseId, page: "p1", script, argument: { limit: 3 } });
    expect(output).toMatchObject({ browseId, status: "ok", result: "title" });

    const generated = runner.calls[0].script;
    expect(generated).toContain(`const script = ${JSON.stringify(script)};`);
    expect(generated).toContain(`const argument = ${JSON.stringify({ limit: 3 })};`);
    expect(generated).toContain("await page.evaluate(expression)");
    expect(generated).toContain("JSON.stringify(argument)");
    expect(generated).not.toContain("page.evaluate(script, argument)");
    expect(generated).not.toMatch(/page\.evaluate\(\s*(?:['"`]|\(\s*\)=>)/);

    runner.reset();
    runner.queue((request) =>
      egoResult(request, {
        ...taskPayload(7, "agent"),
        ok: false,
        error: { name: "Error", message: "page blew up", code: "EGO_PAGE_EVALUATION_TIMED_OUT" },
      }),
    );
    const failed = await provider.evaluate({ browseId, page: "p1", script });
    expect(failed.status).toBe("error");
    expect(failed.result).toMatchObject({ error: { message: "page blew up" } });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].script).not.toContain("task.finish(");
  });
});

describe("EgoProvider navigation URL scheme", () => {
  it("rejects non-HTTP(S) page.goto targets, combined actions and file reads without running ego", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    const secretPath = join(dataDir, "secret.txt");
    await writeFile(secretPath, "TOP_SECRET", "utf8");

    const attempts: Array<{ method: string; args: unknown[]; options?: Record<string, unknown> }> = [
      { method: "page.goto", args: [`file://${secretPath}`] },
      { method: "page.goto", args: ["file:/etc/passwd"] },
      { method: "page.goto", args: ["data:text/html,<h1>pwned</h1>"] },
      { method: "page.goto", args: ["chrome://settings"] },
      { method: "page.goto", args: ["javascript:alert(1)"] },
      { method: "page.goto", args: ["//evil.example/path"] },
      { method: "page.waitForURL", args: ["file:///etc/passwd"] },
      {
        method: "page.waitForEvent",
        args: ["popup"],
        options: { action: { method: "page.goto", args: [`file://${secretPath}`] } },
      },
      {
        method: "page.waitForFileChooser",
        args: [{}],
        options: {
          action: { method: "page.goto", args: ["data:text/html,pwned"] },
          files: [join(dataDir, "uploads", "report.pdf")],
        },
      },
    ];

    for (const attempt of attempts) {
      await expect(
        provider.browse({
          action: "call",
          browseId,
          page: "p1",
          method: attempt.method,
          args: attempt.args,
          ...(attempt.options === undefined ? {} : { options: attempt.options }),
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    // The file scheme never reached the runner, so nothing could read the secret file.
    expect(runner.calls).toHaveLength(0);
    expect(await readFile(secretPath, "utf8")).toBe("TOP_SECRET");
  });

  it("still allows absolute HTTP(S) navigation and relative page.fetch paths", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.goto",
      args: ["https://93.184.216.34/report"],
    });
    expect(runner.calls[0].script).toContain("await page.goto(");

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.fetch",
      args: ["/api/items"],
    });
    expect(runner.calls[0].script).toContain('page.fetch("/api/items", undefined)');
  });
});

describe("EgoProvider URL parsing differential", () => {
  // Every one of these reaches a different URL once the real parser strips tabs/newlines,
  // folds backslashes into slashes or resolves a protocol-relative reference.
  const escaping = [
    "//evil.example/path",
    "///evil.example/path",
    "fi\nle:///etc/passwd",
    "fi\tle:///etc/passwd",
    "fi\rle:///etc/passwd",
    "file:///etc/passwd",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "javascript:alert(1)",
    "data:text/html,<h1>pwned</h1>",
    "chrome://settings",
    "\\127.0.0.1/",
    "/\\127.0.0.1/",
    "\\\\evil.example/path",
    " https://example.com/",
    "https://example.com/ ",
    "https://example.com/a b",
  ];

  it("closes the gap between a scheme regex and the URL parser", () => {
    // The previous check only looked for a leading `scheme:` and therefore waved CR/LF
    // obfuscation through as a relative URL, while the URL parser saw an absolute one.
    expect(/^[a-z][a-z0-9+.-]*:/i.test("fi\nle:///etc/passwd")).toBe(false);
    expect(/^[a-z][a-z0-9+.-]*:/i.test("java\tscript:alert(1)")).toBe(false);
    for (const value of escaping) {
      expect(isSafeNavigationUrl(value)).toBe(false);
      let failure: { code?: string } | undefined;
      try {
        parseEgoUrl(value);
      } catch (error) {
        failure = error as { code?: string };
      }
      expect(failure).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("classifies relative targets against the sentinel origin and keeps absolute ones absolute", () => {
    for (const value of ["/api/items", "api/items", "?q=1", "#fragment", "../up"]) {
      const target = parseEgoUrl(value);
      expect(target.kind).toBe("relative");
      // A relative URL can never move the origin it is resolved against.
      expect(target.url.origin).toBe("https://sentinel.invalid");
    }
    const absolute = parseEgoUrl("https://93.184.216.34/report");
    expect(absolute.kind).toBe("absolute");
    expect(absolute.url.href).toBe("https://93.184.216.34/report");
    const upper = parseEgoUrl("HTTPS://93.184.216.34/report");
    expect(upper.kind).toBe("absolute");
    expect(upper.url.href).toBe("https://93.184.216.34/report");
  });

  it("rejects scheme-only forms whose target depends on the page's own scheme", () => {
    // `https:host` is a same-scheme relative path on an https page and an absolute host on
    // an http one, so no sentinel-based classification can be trusted for it.
    for (const value of ["https:127.0.0.1/admin", "http:127.0.0.1/admin", "https:example.com"]) {
      let failure: { code?: string } | undefined;
      try {
        parseEgoUrl(value);
      } catch (error) {
        failure = error as { code?: string };
      }
      expect(failure).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("rejects every obfuscated form in goto, waitForURL and fetch before running ego", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    for (const value of escaping) {
      for (const method of ["page.goto", "page.waitForURL", "page.fetch"]) {
        await expect(
          provider.browse({ action: "call", browseId, page: "p1", method, args: [value] }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("applies the public URL check to the absolute targets the browser would request", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    for (const [method, value] of [
      ["page.goto", "HTTP://127.0.0.1/admin"],
      ["page.waitForURL", "http://[::1]/admin"],
      ["page.fetch", "https://127.0.0.1/admin"],
    ] as const) {
      await expect(
        provider.browse({ action: "call", browseId, page: "p1", method, args: [value] }),
      ).rejects.toMatchObject({ code: "PRIVATE_URL_BLOCKED" });
    }
    for (const value of ["http:127.0.0.1/admin", "https:127.0.0.1/admin"]) {
      await expect(
        provider.browse({ action: "call", browseId, page: "p1", method: "page.goto", args: [value] }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(runner.calls).toHaveLength(0);

    // The same-origin relative forms keep working.
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({ action: "call", browseId, page: "p1", method: "page.goto", args: ["/dashboard"] });
    expect(runner.calls[0].script).toContain('await page.goto("/dashboard"');
  });
});

describe("EgoProvider open retention", () => {
  it("keeps the real Space when open fails after the Space was created", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 60_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });

    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "TimeoutError", message: "page.goto timed out" },
      task: { spaceId: 7, name: "broken open", ownership: "agent" },
      created: true,
      pages: [],
      spaces: [{ id: 7, name: "broken open", ownership: "agent" }],
    }));
    await expect(provider.browse({ action: "open", page: "p1", name: "broken open" })).rejects.toMatchObject({
      code: "EGO_SCRIPT_ERROR",
    });

    // The Space exists, so the registration must survive with the real ID for close/reap.
    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number; name: string }>;
    };
    const pending = Object.values(registry.tasks);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ spaceId: 7, name: "broken open" });
    expect(runner.calls[0].script).toContain("created:");

    now += 20_000;
    runner.reset();
    runner.queue((request) => egoResult(request, finishPayload(7)));
    await provider.reapExpired();
    expect(runner.calls[0].script).toContain("const TASK_ID = 7;");
    expect(JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8"))).toMatchObject({ tasks: {} });
  });

  it("keeps a -1 placeholder when the emitted payload cannot confirm creation", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });

    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "listing failed" },
      task: null,
      created: null,
      pages: [],
      spaces: [],
    }));
    await expect(provider.browse({ action: "open", page: "p1", name: "unknown open" })).rejects.toMatchObject({
      code: "EGO_SCRIPT_ERROR",
    });

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number; name: string }>;
    };
    const pending = Object.values(registry.tasks);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ spaceId: -1, name: "unknown open" });
  });
});

describe("EgoProvider duplicate names", () => {
  it("refuses a second managed task with a registered name", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    await openTask(provider, runner, { name: "shared name" });
    runner.reset();

    // Reusing a name would make a by-name reap/close hit the wrong, healthy Space.
    await expect(provider.browse({ action: "open", page: "p1", name: "shared name" })).rejects.toMatchObject({
      code: "EGO_TASK_EXISTS",
    });
    expect(runner.calls).toHaveLength(0);

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number }>;
    };
    expect(Object.values(registry.tasks)).toHaveLength(1);
    expect(Object.values(registry.tasks)[0]).toMatchObject({ spaceId: 7 });
  });
});

describe("EgoProvider large managed payloads", () => {
  it("registers an oversized payload as an Artifact and returns only a summary", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    const big = { ok: true, blob: "x".repeat(2_100_000), pages: ["p1"] };
    const text = JSON.stringify(big);
    let declaredPath = "";
    runner.queue(
      async (request) => {
        declaredPath = /const RESULT_PATH = "([^"]+)"/.exec(request.script)?.[1] ?? "";
        if (!declaredPath) throw new Error("the managed script declared no result path");
        await mkdir(dirname(declaredPath), { recursive: true });
        await writeFile(declaredPath, text, { mode: 0o600 });
        return egoResult(request, {
          ok: true,
          task: { spaceId: 7, name: "large payload", ownership: "agent" },
          pages: ["p1"],
          truncated: true,
          artifactPath: declaredPath,
          artifactBytes: text.length,
        });
      },
      (request) => egoResult(request, finishPayload(7)),
    );

    const output = await provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] });
    const script = runner.calls[0].script;
    expect(script).toContain("managed-results");
    expect(script).toContain("RESULT_LIMIT = 2000000");
    expect(script).toContain("mode: 0o600");
    expect(script).toContain("await emitEgoResult(");
    // Only a small summary travels on stdout; the file path is how the full body escapes.
    expect(script).toContain("truncated: true");
    expect(script).toContain("artifactPath: RESULT_PATH");
    // The stdout payload stays small: the full body lives in the artifact instead.
    expect(text.length).toBeGreaterThan(2_000_000);

    expect(declaredPath.startsWith(join(dataDir, "managed-results"))).toBe(true);
    const artifactId = output.artifactId as string;
    expect(artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(output.result).toMatchObject({ truncated: true, artifactId });

    const contentPath = join(dataDir, "artifacts", artifactId, "content");
    expect(JSON.parse(await readFile(contentPath, "utf8"))).toEqual(big);
    expect((await stat(contentPath)).mode & 0o777).toBe(0o600);
    // The hand-off file is deleted once the Artifact owns the bytes.
    expect(await readdir(join(dataDir, "managed-results"))).toEqual([]);
  });

  it("rejects a result path the provider did not allocate", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    runner.queue((request) => egoResult(request, {
      ok: true,
      task: { spaceId: 7, ownership: "agent" },
      pages: ["p1"],
      truncated: true,
      artifactPath: join(dataDir, "..", "escaped.json"),
      artifactBytes: 2_000_001,
    }));

    await expect(
      provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] }),
    ).rejects.toMatchObject({ code: "EGO_INVALID_RESPONSE" });
  });
});

describe("EgoProcessRunner environment", () => {
  it("spawns ego with the provider whitelist so agent secrets never reach the child", async () => {
    const saved = {
      TINYFISH_API_KEY: process.env.TINYFISH_API_KEY,
      FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
      HTTP_PROXY: process.env.HTTP_PROXY,
    };
    process.env.TINYFISH_API_KEY = "tf-secret-value";
    process.env.FIRECRAWL_API_KEY = "fc-secret-value";
    process.env.HTTP_PROXY = "http://proxy.example:3128";
    try {
      const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
      const spawnFn: EgoSpawnFn = (command, args, spawnOptions) => {
        calls.push({ command, args, env: spawnOptions.env });
        return fakeEgoChild({ stdout: "done\n" });
      };
      const runner = new EgoProcessRunner({ binary: "ego-fake", spawnFn });
      const result = await runner.run({ script: "console.log(1)", timeoutMs: 2000, marker: "MARKER", kind: "node" });

      expect(result).toMatchObject({ exitCode: 0, stdout: "done\n", timedOut: false });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe("ego-fake");
      expect(calls[0].args).toEqual(["nodejs"]);
      const env = calls[0].env;
      expect(env).not.toBe(process.env);
      expect(env.TINYFISH_API_KEY).toBeUndefined();
      expect(env.FIRECRAWL_API_KEY).toBeUndefined();
      expect(env.HTTP_PROXY).toBe("http://proxy.example:3128");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("EgoProvider vanished Space recovery", () => {
  it("forgets a task whose Space vanished on close and reports alreadyClosed", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "space is gone", code: "EGO_SPACE_MISSING" },
      task: { spaceId: 7 },
      pages: [],
    }));
    const output = await provider.browse({ action: "close", browseId, page: "p1" });
    expect(output.status).toBe("alreadyClosed");

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks[browseId]).toBeUndefined();
    await expect(provider.browse({ action: "status", browseId, page: "p1" })).rejects.toMatchObject({
      code: "EGO_TASK_NOT_FOUND",
    });
  });

  it("keeps a task registered when close fails for an unrelated error", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "browser crashed" },
      task: { spaceId: 7 },
      pages: [],
    }));
    await expect(provider.browse({ action: "close", browseId, page: "p1" })).rejects.toMatchObject({
      code: "EGO_SCRIPT_ERROR",
    });

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number }>;
    };
    expect(registry.tasks[browseId]).toMatchObject({ spaceId: 7 });
  });

  it("drops vanished Spaces during reap so zombies no longer consume maxTasks", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { maxTasks: 1, taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 60_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    await openTask(provider, runner);

    now += 20_000;
    runner.reset();
    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "space is gone", code: "EGO_SPACE_MISSING" },
      task: { spaceId: 7 },
      pages: [],
    }));
    await provider.reapExpired();

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks).toEqual({});

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(8, "agent")),
      (request) => egoResult(request, finishPayload(8)),
    );
    await expect(provider.browse({ action: "open", page: "p1" })).resolves.toMatchObject({ spaceId: 8 });
  });

  it("drops vanished Spaces on provider close and keeps unrelated failures", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const gone = await openTask(provider, runner, { spaceId: 7, name: "gone task" });
    const kept = await openTask(provider, runner, { spaceId: 8, name: "kept task" });
    runner.reset();

    runner.queue(
      (request) => egoResult(request, {
        ok: false,
        error: { name: "Error", message: "space is gone", code: "EGO_SPACE_MISSING" },
        task: { spaceId: 7 },
        pages: [],
      }),
      (request) => egoResult(request, {
        ok: false,
        error: { name: "Error", message: "browser crashed" },
        task: { spaceId: 8 },
        pages: [],
      }),
    );
    await provider.close();

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number }>;
    };
    expect(registry.tasks[gone]).toBeUndefined();
    expect(registry.tasks[kept]).toMatchObject({ spaceId: 8 });
  });
});

describe("EgoProvider shutdown budget", () => {
  it("closes every registered Space concurrently with a short finish timeout", async () => {
    const config = await makeConfig(dataDir);
    const runner = new ParallelCloseRunner(3);
    const provider = new EgoProvider(config, { runner });

    const browseIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const output = await provider.browse({ action: "open", page: "p1", name: `task-${index}` });
      if (!output.browseId) throw new Error("expected browseId");
      browseIds.push(output.browseId);
    }
    const registryBefore = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number }>;
    };
    const registeredSpaceIds = Object.values(registryBefore.tasks)
      .map((task) => task.spaceId)
      .sort((left, right) => left - right);
    expect(registeredSpaceIds).toHaveLength(3);

    runner.resetTracking();
    await provider.close();

    // All three shutdown finishes were in flight at the same time.
    expect(runner.shutdownPeak).toBe(3);
    const shutdownCalls = runner.calls.filter((call) => call.kind === "finish" && call.timeoutMs <= 5_000);
    expect(shutdownCalls).toHaveLength(3);
    for (const call of shutdownCalls) expect(call.timeoutMs).toBeLessThanOrEqual(5_000);
    // Normal managed calls keep their 30s budget.
    expect(runner.calls.filter((call) => call.kind === "managed").every((call) => call.timeoutMs === 30_000)).toBe(true);
    // Only Spaces recorded in this provider's own registry were finished.
    expect([...runner.shutdownFinished].sort((left, right) => left - right)).toEqual(registeredSpaceIds);
    expect(runner.shutdownFinished).not.toContain(999);

    const registryAfter = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registryAfter.tasks).toEqual({});
    for (const browseId of browseIds) expect(registryAfter.tasks[browseId]).toBeUndefined();
  });

  it("closes no Space when the registry is empty", async () => {
    const config = await makeConfig(dataDir);
    const runner = new ParallelCloseRunner(1);
    const provider = new EgoProvider(config, { runner });
    await provider.close();
    expect(runner.calls).toHaveLength(0);
  });
});

describe("EgoProvider call planning", () => {
  it("does not mutate the caller's options and writes no dead registry fields", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, Record<string, unknown>>;
    };
    expect(registry.tasks[browseId]).not.toHaveProperty("createdByProvider");

    const options = Object.freeze({
      arm: Object.freeze({ saveAs: join(dataDir, "downloads", "report.pdf") }),
      action: Object.freeze({ method: "page.click", args: Object.freeze(["button.download"]) }),
    });
    const before = JSON.stringify(options);
    const plan = prepareEgoCall("page.waitForEvent", ["download"], options);
    expect(plan.saveAs).toBe(join(dataDir, "downloads", "report.pdf"));
    expect(JSON.stringify(options)).toBe(before);
  });
});

describe("EgoProvider node slots", () => {
  it("hands a released slot to the queued waiter without exceeding maxNodeProcesses", async () => {
    const config = await makeConfig(dataDir, { unrestricted: true, maxNodeProcesses: 1 });
    const runner = new ConcurrencyRunner();
    const artifacts = new HookedArtifactStore(dataDir);
    const provider = new EgoProvider(config, {
      runner,
      artifacts: artifacts as unknown as ArtifactStore,
    });

    const first = provider.node({ script: "first", timeoutMs: 1000 });
    await until(() => runner.started("first"), "first script to start");
    const second = provider.node({ script: "second", timeoutMs: 1000 });
    const third = provider.node({ script: "third", timeoutMs: 1000 });
    expect(runner.peak).toBe(1);

    // A finishing node call starts another node call in the window between
    // releasing its slot and the handed-off waiter resuming.
    const pending: { fourth?: ReturnType<EgoProvider["node"]> } = {};
    artifacts.onNextSave(() => {
      pending.fourth = provider.node({ script: "fourth", timeoutMs: 1000 });
    });
    runner.finish("first");
    await first;
    await until(() => runner.started("second"), "handed-off waiter to start");
    expect(runner.peak).toBe(1);

    runner.finish("second");
    await second;
    await until(() => runner.started("third"), "third script to start");
    runner.finish("third");
    await third;
    await until(() => runner.started("fourth"), "fourth script to start");
    runner.finish("fourth");
    if (!pending.fourth) throw new Error("fourth node call was never started");
    await pending.fourth;
    expect(runner.peak).toBe(1);
  });
});

describe("EgoProvider node", () => {
  it("is gated by unrestricted config and never auto-finishes", async () => {
    const lockedConfig = await makeConfig(dataDir, { unrestricted: false });
    const lockedRunner = new FakeRunner();
    const lockedProvider = new EgoProvider(lockedConfig, { runner: lockedRunner });
    await expect(
      lockedProvider.node({ script: "console.log('raw')", timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "EGO_UNRESTRICTED_DISABLED" });
    expect(lockedRunner.calls).toHaveLength(0);

    const config = await makeConfig(dataDir, { unrestricted: true });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const rawScript = "const task = await taskSpace('raw'); console.log(task.spaceId);";
    runner.queue((request) =>
      egoResult(request, {}, { exitCode: 0, stdout: "42\n", stderr: "", durationMs: 33 }),
    );
    const output = await provider.node({ script: rawScript, timeoutMs: 60_000 });
    expect(output).toMatchObject({
      exitCode: 0,
      stdout: "42\n",
      stderr: "",
      durationMs: 33,
      timedOut: false,
      // A clean exit still may leave child processes, sockets or files behind.
      mayHaveLateEffects: true,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].script).toBe(rawScript);
    expect(runner.calls[0].timeoutMs).toBe(60_000);
    expect(runner.calls[0].script).not.toContain("finish(");
  });

  it("saves complete stdout/stderr as an Artifact before inline truncation", async () => {
    const config = await makeConfig(dataDir, { unrestricted: true });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    runner.queue((request) =>
      egoResult(request, {}, {
        exitCode: null,
        signal: "SIGKILL",
        stdout: "x".repeat(5000),
        stderr: "y".repeat(5000),
        durationMs: 999,
        timedOut: true,
      }),
    );
    const output = await provider.node({ script: "await new Promise(() => {})", timeoutMs: 5000 });
    expect(output).toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      mayHaveLateEffects: true,
    });
    expect(output.stdout.length).toBeLessThan(1100);
    expect(output.stderr.length).toBeLessThan(1100);
    // stdout and stderr share one inline budget instead of each getting the full limit.
    expect(output.stdout.length + output.stderr.length).toBeLessThanOrEqual(1000);
    expect(output.stdout).toContain("[truncated]");
    expect(output.stderr).toContain("[truncated]");
    expect(runner.calls[0].timeoutMs).toBe(5000);

    const artifactId = output.artifactId as string;
    expect(artifactId).toMatch(/^[0-9a-f-]{36}$/);
    const artifact = JSON.parse(
      await readFile(join(dataDir, "artifacts", artifactId, "content"), "utf8"),
    ) as { stdout: string; stderr: string; timedOut: boolean };
    expect(artifact.stdout).toBe("x".repeat(5000));
    expect(artifact.stderr).toBe("y".repeat(5000));
    expect(artifact.timedOut).toBe(true);
  });

  it("hands unused inline budget from a short stream to a long one", async () => {
    const config = await makeConfig(dataDir, { unrestricted: true });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    runner.queue((request) =>
      egoResult(request, {}, { exitCode: 0, stdout: "ok\n", stderr: "y".repeat(4000) }),
    );
    const output = await provider.node({ script: "console.log(1)", timeoutMs: 5000 });
    expect(output.stdout).toBe("ok\n");
    expect(output.stderr).toContain("[truncated]");
    expect(output.stdout.length + output.stderr.length).toBeLessThanOrEqual(1000);
  });
});

describe("EgoProcessRunner stdio teardown", () => {
  it("returns on exit even when a grandchild keeps the stdio pipes open", async () => {
    const runner = new EgoProcessRunner({
      binary: "ego-fake",
      spawnFn: () => exitOnlyEgoChild({ stdout: "done\n" }),
    });
    const startedAt = Date.now();
    const result = await runner.run({ script: "console.log(1)", timeoutMs: 5_000, marker: "MARKER", kind: "node" });

    expect(result).toMatchObject({ exitCode: 0, stdout: "done\n", timedOut: false });
    // Waiting for `close` would never resolve because the grandchild owns the pipes.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("returns timedOut even when the killed child never closes its stdio", async () => {
    const runner = new EgoProcessRunner({ binary: "ego-fake", spawnFn: () => wedgedEgoChild() });
    const startedAt = Date.now();
    const result = await runner.run({ script: "await new Promise(() => {})", timeoutMs: 50, marker: "MARKER", kind: "node" });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("EgoProvider acquisition error path", () => {
  it("emits acquisition failures from inside the managed try block", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    const work = runner.calls[0].script;
    // The emit helper has its own try/catch, so anchor on the managed acquisition block.
    const workTry = work.indexOf("try {\nconst spacesBefore");
    const workAcquire = work.indexOf("await listTaskSpaces()");
    const workCatch = work.indexOf("} catch (error) {", workAcquire);
    expect(workTry).toBeGreaterThanOrEqual(0);
    expect(workAcquire).toBeGreaterThan(workTry);
    expect(workCatch).toBeGreaterThan(workAcquire);
    // Acquisition errors must reach the emitted payload instead of dying before the try.
    expect(work.slice(workCatch)).toContain("await emitEgoResult({");

    runner.reset();
    runner.queue((request) => egoResult(request, finishPayload(7)));
    await provider.browse({ action: "close", browseId, page: "p1" });
    const finish = runner.calls[0].script;
    const finishTry = finish.indexOf("try {\nconst spacesBefore");
    const finishAcquire = finish.indexOf("await listTaskSpaces()");
    const finishCatch = finish.indexOf("} catch (error) {", finishAcquire);
    expect(finishTry).toBeGreaterThanOrEqual(0);
    expect(finishAcquire).toBeGreaterThan(finishTry);
    expect(finishCatch).toBeGreaterThan(finishAcquire);
    expect(finish.slice(finishCatch)).toContain("await emitEgoResult({");
  });

  it("recognizes EGO_SPACE_MISSING from stderr without a marker and forgets the task", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    // Real runtime shape: the script threw during acquisition, so nothing was emitted.
    runner.queue(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "ego-cli: uncaught\nError: EGO_SPACE_MISSING\n    at acquisitionPrelude\n",
      durationMs: 9,
      timedOut: false,
    }));
    const output = await provider.browse({ action: "close", browseId, page: "p1" });
    expect(output.status).toBe("alreadyClosed");

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks[browseId]).toBeUndefined();
  });

  it("drops vanished Spaces reported only on stderr during reap", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 60_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    const browseId = await openTask(provider, runner);

    now += 20_000;
    runner.reset();
    runner.queue(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: EGO_SPACE_MISSING\n",
      durationMs: 9,
      timedOut: false,
    }));
    await provider.reapExpired();

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks[browseId]).toBeUndefined();
  });
});

describe("EgoProvider shutdown guard", () => {
  it("rejects new work after close instead of reviving the provider", async () => {
    const config = await makeConfig(dataDir, { unrestricted: true });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);

    runner.reset();
    runner.queue((request) => egoResult(request, finishPayload(7)));
    await provider.close();
    const callsAfterClose = runner.calls.length;

    await expect(provider.browse({ action: "status", browseId, page: "p1" })).rejects.toMatchObject({ code: "EGO_CLOSED" });
    await expect(provider.browse({ action: "open", page: "p1" })).rejects.toMatchObject({ code: "EGO_CLOSED" });
    await expect(provider.evaluate({ browseId, page: "p1", script: "1 + 1" })).rejects.toMatchObject({ code: "EGO_CLOSED" });
    await expect(provider.node({ script: "console.log(1)", timeoutMs: 1000 })).rejects.toMatchObject({ code: "EGO_CLOSED" });
    expect(runner.calls).toHaveLength(callsAfterClose);

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks).toEqual({});
  });

  it("finishes the snapshot Space even when the registry lock stays busy", async () => {
    const config = await makeConfig(dataDir);
    const runner = new WedgedRunner();
    const provider = new EgoProvider(config, { runner, registryLockTimeoutMs: 10 });

    const opened = await provider.browse({ action: "open", page: "p1" });
    expect(opened.spaceId).toBe(7);
    const before = await readFile(join(dataDir, "browse", "tasks.json"), "utf8");
    const callsBeforeClose = runner.calls.length;

    // A wedged managed call keeps the registry lock for as long as its runner hangs.
    runner.wedgeNextManaged();
    const wedged = provider.browse({ action: "status", browseId: opened.browseId, page: "p1" });
    await until(() => runner.calls.length === callsBeforeClose + 1, "wedged status call to start");

    await provider.close();

    // Shutdown read the registry without the lock and really finished the Space: a busy
    // lock must never make close() skip the Space cleanup it just observed.
    const finishes = runner.calls.slice(callsBeforeClose).filter((call) => call.kind === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0].timeoutMs).toBeLessThanOrEqual(5_000);
    // The busy lock still keeps shutdown from writing a stale snapshot back.
    expect(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")).toBe(before);
    await expect(provider.browse({ action: "status", page: "p1" })).rejects.toMatchObject({ code: "EGO_CLOSED" });
    // The wedged call is never revived by the shutdown guard.
    void wedged.catch(() => undefined);
  });

  it("never runs a queued registry request after close", async () => {
    const config = await makeConfig(dataDir);
    const runner = new GatedManagedRunner();
    const provider = new EgoProvider(config, { runner, registryLockTimeoutMs: 10 });

    const opened = await provider.browse({ action: "open", page: "p1" });
    runner.parkNextManaged();
    const inFlight = provider.browse({ action: "status", browseId: opened.browseId, page: "p1" });
    await until(() => runner.parked === 1, "in-flight status call to park");
    // This request queues behind the parked call, so it is still waiting when close() runs.
    const queued = provider.browse({ action: "status", page: "p1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const callsBeforeClose = runner.calls.length;

    await provider.close();

    runner.releaseParked();
    await inFlight;
    await expect(queued).rejects.toMatchObject({ code: "EGO_CLOSED" });
    // The queued request never reached the runtime.
    expect(runner.calls.slice(callsBeforeClose).filter((call) => call.kind === "managed")).toHaveLength(0);
  });

  it("stops reaping once the provider is closed", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 60_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    const browseId = await openTask(provider, runner);

    runner.reset();
    // A finish that fails keeps the registration, so a reap after close would still have
    // work to do if it were allowed to run.
    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "browser crashed" },
      task: { spaceId: 7 },
      pages: [],
    }));
    await provider.close();
    const callsAfterClose = runner.calls.length;
    expect(callsAfterClose).toBe(1);

    now += 20_000;
    await provider.reapExpired();
    expect(runner.calls).toHaveLength(callsAfterClose);
    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks[browseId]).toBeDefined();
  });
});

describe("EgoProvider close identity", () => {
  it("never deletes a record that changed after the close snapshot", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    const browseId = await openTask(provider, runner);
    const registryPath = join(dataDir, "browse", "tasks.json");
    const replacementId = "11111111-2222-4333-8444-555555555555";

    runner.reset();
    runner.queue(async (request) => {
      if (request.kind !== "finish") throw new Error("expected the close finish");
      const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      // Work that landed after the snapshot replaced the record under the same browseId...
      registry.tasks[browseId] = { ...registry.tasks[browseId], spaceId: 77, updatedAt: now + 5 };
      // ...and a brand new record must survive shutdown too.
      registry.tasks[replacementId] = {
        ...registry.tasks[browseId],
        browseId: replacementId,
        name: "registered after close",
        spaceId: 88,
        updatedAt: now + 6,
      };
      await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
      return egoResult(request, finishPayload(7));
    });
    await provider.close();

    // The finish succeeded for the snapshot identity only: a record whose identity moved on
    // belongs to newer work and must never be deleted by shutdown.
    const after = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { spaceId: number; updatedAt: number }>;
    };
    expect(after.tasks[browseId]).toMatchObject({ spaceId: 77, updatedAt: now + 5 });
    expect(after.tasks[replacementId]).toMatchObject({ spaceId: 88, updatedAt: now + 6 });
  });

  it("never writes an in-flight snapshot back into the closed registry", async () => {
    const config = await makeConfig(dataDir);
    const runner = new GatedManagedRunner({ ...taskPayload(7, "agent", ["p1", "p2"]) });
    const provider = new EgoProvider(config, { runner, registryLockTimeoutMs: 10 });
    const opened = await provider.browse({ action: "open", page: "p1" });
    const registryPath = join(dataDir, "browse", "tasks.json");
    const before = await readFile(registryPath, "utf8");
    expect(JSON.parse(before).tasks[opened.browseId as string]).toMatchObject({ pages: ["p1"] });

    runner.parkNextManaged();
    const inFlight = provider.browse({ action: "status", browseId: opened.browseId, page: "p1" });
    await until(() => runner.parked === 1, "in-flight status call to park");
    const callsBeforeClose = runner.calls.length;

    await provider.close();

    // Shutdown finished the snapshot Space although the parked call still held the lock.
    expect(runner.calls.slice(callsBeforeClose).filter((call) => call.kind === "finish")).toHaveLength(1);

    runner.releaseParked();
    await inFlight;

    // The in-flight call's stale snapshot (its own page list and timestamps) was refused, so
    // work that was already running cannot resurrect what shutdown observed.
    expect(await readFile(registryPath, "utf8")).toBe(before);
  });
});

describe("EgoProvider reap concurrency", () => {
  it("reaps expired Spaces in parallel with the close budget and releases the lock", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 600_000 });
    const runner = new GatedReapRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });

    await provider.browse({ action: "open", page: "p1", name: "first" });
    await provider.browse({ action: "open", page: "p1", name: "second" });
    now += 20_000;

    const reaping = provider.reapExpired();
    await until(() => runner.gatedCount === 2, "both reaps to be in flight");

    // Every shutdown finish is already in flight, so the registry lock is free while they run.
    const status = await provider.browse({ action: "status", page: "p1" });
    expect(status.status).toBe("ok");
    const shutdownCalls = runner.calls.filter((call) => call.kind === "finish" && call.timeoutMs <= 5_000);
    expect(shutdownCalls).toHaveLength(2);
    for (const call of shutdownCalls) expect(call.timeoutMs).toBeLessThanOrEqual(5_000);

    runner.releaseGates();
    await reaping;

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks).toEqual({});
  });
});

describe("EgoProvider open placeholder", () => {
  it("registers a spaceId -1 placeholder before opening and replaces it on success", async () => {
    // URL policy is covered elsewhere; allowPrivate keeps this focused on the placeholder.
    const config = await makeConfig(dataDir, { allowPrivate: true });
    const runner = new PlaceholderObserverRunner(join(dataDir, "browse", "tasks.json"));
    const provider = new EgoProvider(config, { runner });

    const output = await provider.browse({ action: "open", page: "p1", name: "placeholder task", url: "https://example.com/report" });
    expect(output.spaceId).toBe(7);

    const observed = Object.values(runner.observed?.tasks ?? {});
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ spaceId: -1, name: "placeholder task" });

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number }>;
    };
    expect(registry.tasks[output.browseId as string]).toMatchObject({ spaceId: 7 });

    const openScript = runner.calls[0].script;
    // The navigation budget stays below the runner budget so the script can emit its error.
    expect(openScript).toContain("await page.goto(");
    expect(openScript).toContain("timeout: 25000");
    expect(runner.calls[0].timeoutMs).toBe(30_000);
  });

  it("keeps a timed-out open reclaimable by name and reaps it", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 60_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });

    runner.queue(() => ({
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      durationMs: 30_000,
      timedOut: true,
    }));
    await expect(provider.browse({ action: "open", page: "p1", name: "timed out task" })).rejects.toMatchObject({
      code: "EGO_TIMEOUT",
    });

    const pending = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number; name: string }>;
    };
    const placeholders = Object.values(pending.tasks);
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({ spaceId: -1, name: "timed out task" });

    now += 20_000;
    runner.reset();
    runner.queue((request) => egoResult(request, finishPayload(7)));
    await provider.reapExpired();

    // A spaceId < 0 record resolves its Space by name instead of failing on -1.
    const finish = runner.calls[0].script;
    expect(finish).toContain("space.name === SPACE_NAME");
    expect(finish).toContain('"timed out task"');
    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks).toEqual({});
  });

  it("keeps an unknown open result registered so the reaper can reclaim the Space by name", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 60_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });

    runner.queue(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: boom\n",
      durationMs: 4,
      timedOut: false,
    }));
    await expect(provider.browse({ action: "open", page: "p1", name: "crashed task" })).rejects.toMatchObject({
      code: "EGO_RUN_FAILED",
    });

    // The runtime may have created the Space before it died, so the registration stays.
    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, { spaceId: number; name: string }>;
    };
    const pending = Object.values(registry.tasks);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ spaceId: -1, name: "crashed task" });

    now += 20_000;
    runner.reset();
    runner.queue((request) => egoResult(request, finishPayload(7)));
    await provider.reapExpired();
    const finish = runner.calls[0].script;
    expect(finish).toContain("space.name === SPACE_NAME");
    expect(finish).toContain('"crashed task"');
    expect(JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8"))).toMatchObject({ tasks: {} });
  });

  it("deletes the registration when the open payload confirms no Space was created", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });

    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "taskSpace failed" },
      task: null,
      created: false,
      pages: [],
      spaces: [],
    }));
    await expect(provider.browse({ action: "open", page: "p1" })).rejects.toMatchObject({ code: "EGO_SCRIPT_ERROR" });

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks).toEqual({});
  });

  it("deletes the placeholder when the runner never started", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });

    runner.queue(() => {
      throw new FreeWebError("EGO_SPAWN_FAILED", "Cannot start ego-browser");
    });
    await expect(provider.browse({ action: "open", page: "p1" })).rejects.toMatchObject({ code: "EGO_SPAWN_FAILED" });

    const registry = JSON.parse(await readFile(join(dataDir, "browse", "tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    expect(registry.tasks).toEqual({});
  });
});

describe("EgoProvider registry temp files", () => {
  it("prunes stale .tasks.*.tmp files without deleting an in-flight write", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });

    const directory = join(dataDir, "browse");
    await mkdir(directory, { recursive: true });
    const stale = join(directory, ".tasks.stale.tmp");
    const live = join(directory, ".tasks.live.tmp");
    await writeFile(stale, "{}\n", "utf8");
    await writeFile(live, "{}\n", "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, old, old);

    await openTask(provider, runner);

    expect(await readdir(directory)).not.toContain(".tasks.stale.tmp");
    expect(await readdir(directory)).toContain(".tasks.live.tmp");
  });
});

describe("EgoProvider path containment", () => {
  it("accepts not-yet-created download paths by resolving the nearest existing parent", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    const saveAs = join(dataDir, "downloads", "nested", "deeper", "report.pdf");
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.waitForEvent",
      args: ["download"],
      options: {
        action: { method: "page.click", args: ["button.download"] },
        saveAs,
      },
    });
    expect(runner.calls[0].script).toContain(JSON.stringify(saveAs));
  });

  it("rejects symlink escapes through an existing ancestor", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    const outside = await mkdtemp(join(tmpdir(), "freeweb-ego-outside-"));
    try {
      await mkdir(join(dataDir, "downloads"), { recursive: true });
      await symlink(outside, join(dataDir, "downloads", "escape"));
      await expect(
        provider.browse({
          action: "call",
          browseId,
          page: "p1",
          method: "page.screenshot",
          args: [{ path: join(dataDir, "downloads", "escape", "shot.png") }],
        }),
      ).rejects.toMatchObject({ code: "EGO_PATH_FORBIDDEN" });

      await mkdir(join(dataDir, "uploads"), { recursive: true });
      const leak = join(outside, "secret.txt");
      await writeFile(leak, "TOP_SECRET", "utf8");
      await symlink(leak, join(dataDir, "uploads", "leak.txt"));
      await expect(
        provider.browse({
          action: "call",
          browseId,
          page: "p1",
          method: "page.setInputFiles",
          args: ["input[type=file]", join(dataDir, "uploads", "leak.txt")],
        }),
      ).rejects.toMatchObject({ code: "EGO_PATH_FORBIDDEN" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("still realpaths existing in-root upload files", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    await mkdir(join(dataDir, "uploads"), { recursive: true });
    const upload = join(dataDir, "uploads", "report.pdf");
    await writeFile(upload, "pdf", "utf8");

    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await provider.browse({
      action: "call",
      browseId,
      page: "p1",
      method: "page.setInputFiles",
      args: ["input[type=file]", upload],
    });
    expect(runner.calls[0].script).toContain(JSON.stringify(upload));
  });
});

describe("EgoProvider placeholder spaceId output", () => {
  it("omits a -1 placeholder spaceId from status, evaluate and close outputs", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const registryPath = join(dataDir, "browse", "tasks.json");

    // An open whose creation cannot be confirmed keeps the by-name placeholder (-1).
    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "listing failed" },
      task: null,
      created: null,
      pages: [],
      spaces: [],
    }));
    await expect(provider.browse({ action: "open", page: "p1", name: "placeholder" })).rejects.toMatchObject({
      code: "EGO_SCRIPT_ERROR",
    });
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { spaceId: number }>;
    };
    const browseId = Object.keys(registry.tasks)[0];
    expect(registry.tasks[browseId]).toMatchObject({ spaceId: -1 });

    runner.reset();
    runner.queue(
      // A payload without a Space ID must not invent a positive one either.
      (request) => egoResult(request, { ok: true, value: { observed: true }, task: { name: "placeholder", ownership: "agent" }, pages: ["p1"] }),
      (request) => egoResult(request, { ok: true, task: { spaceId: -1 }, pages: ["p1"] }),
    );
    const status = await provider.browse({ action: "status", browseId, page: "p1" });
    expect(status).not.toHaveProperty("spaceId");
    expect(browseOutputSchema.safeParse(status).success).toBe(true);

    runner.reset();
    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "TypeError", message: "document is not defined" },
      task: { spaceId: -1 },
      pages: [],
    }));
    const evaluated = await provider.evaluate({ browseId, page: "p1", script: "document.title" });
    expect(evaluated.status).toBe("error");
    expect(evaluated).not.toHaveProperty("spaceId");
    expect(browseOutputSchema.safeParse(evaluated).success).toBe(true);

    runner.reset();
    runner.queue((request) => egoResult(request, finishPayload(-1)));
    const closed = await provider.browse({ action: "close", browseId, page: "p1" });
    expect(closed.status).toBe("closed");
    expect(closed).not.toHaveProperty("spaceId");
    expect(browseOutputSchema.safeParse(closed).success).toBe(true);
  });

  it("never exposes the -1 placeholder from a browse-less status listing", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });

    // An open whose creation cannot be confirmed keeps the by-name placeholder (-1).
    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "listing failed" },
      task: null,
      created: null,
      pages: [],
      spaces: [],
    }));
    await expect(provider.browse({ action: "open", page: "p1", name: "placeholder" })).rejects.toMatchObject({
      code: "EGO_SCRIPT_ERROR",
    });
    const known = await openTask(provider, runner, { spaceId: 7, name: "known task" });

    const listed = await provider.browse({ action: "status", page: "p1" });
    const tasks = (listed.result as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(2);
    // The listing never leaks the by-name placeholder as if it were a real Space ID.
    for (const task of tasks) {
      expect(typeof task.spaceId === "number" ? task.spaceId >= 0 : true).toBe(true);
    }
    const placeholder = tasks.find((task) => task.browseId !== known);
    expect(placeholder).toMatchObject({ status: "active", spaceIdKnown: false });
    expect(placeholder).not.toHaveProperty("spaceId");
    expect(tasks.find((task) => task.browseId === known)).toMatchObject({ spaceId: 7 });
  });
});

describe("EgoProvider artifact link provenance", () => {
  it("keeps a page-supplied artifactId as plain result data", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const browseId = await openTask(provider, runner);
    runner.reset();

    runner.queue(
      (request) => egoResult(request, {
        ok: true,
        value: { artifactId: "not-a-uuid" },
        task: { spaceId: 7, ownership: "agent" },
        pages: ["p1"],
        // A payload-level claim is not a resource link either: only a stored Artifact is.
        handoffArtifactId: "11111111-1111-4111-8111-111111111111",
      }),
      (request) => egoResult(request, finishPayload(7)),
    );
    const output = await provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] });
    expect(output.artifactId).toBeUndefined();
    expect(output.result).toEqual({ artifactId: "not-a-uuid" });
    expect(browseOutputSchema.safeParse(output).success).toBe(true);
  });
});

describe("EgoProvider reap identity", () => {
  it("never deletes a record whose reaping identity changed while the finish ran", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 600_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    const browseId = await openTask(provider, runner);
    const registryPath = join(dataDir, "browse", "tasks.json");
    now += 20_000;

    runner.reset();
    runner.queue(async (request) => {
      if (request.kind !== "finish") throw new Error("expected the reaping finish");
      const marked = JSON.parse(await readFile(registryPath, "utf8")) as {
        tasks: Record<string, { status: string; reapToken?: string; updatedAt: number; lastActiveAt: number }>;
      };
      // The claim lands before the runtime call, so no work can slip in behind it.
      expect(marked.tasks[browseId]).toMatchObject({ status: "reaping" });
      expect(typeof marked.tasks[browseId].reapToken).toBe("string");
      // A concurrent close+reopen replaced the record under the same browseId.
      marked.tasks[browseId] = {
        ...marked.tasks[browseId],
        status: "active",
        updatedAt: now + 5,
        lastActiveAt: now + 5,
      };
      delete marked.tasks[browseId].reapToken;
      await writeFile(registryPath, `${JSON.stringify(marked, null, 2)}\n`, { mode: 0o600 });
      return egoResult(request, finishPayload(7));
    });

    await provider.reapExpired();

    // The finish succeeded, but the record is no longer the one this reaper claimed.
    const after = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { status: string; updatedAt: number }>;
    };
    expect(after.tasks[browseId]).toMatchObject({ status: "active", updatedAt: now + 5 });
  });

  it("rejects call and resume while a task is claimed for reaping", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 600_000 });
    const runner = new GatedReapRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    const opened = await provider.browse({ action: "open", page: "p1", name: "gated" });
    const browseId = opened.browseId as string;
    now += 20_000;

    const reaping = provider.reapExpired();
    await until(() => runner.gatedCount === 1, "the reaping finish to park");
    const callsBefore = runner.calls.length;

    await expect(provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] }))
      .rejects.toMatchObject({ code: "EGO_TASK_REAPING" });
    await expect(provider.browse({ action: "resume", browseId, page: "p1" }))
      .rejects.toMatchObject({ code: "EGO_TASK_REAPING" });
    expect(runner.calls).toHaveLength(callsBefore);

    runner.releaseGates();
    await reaping;
  });

  it("releases the reaping claim when the finish fails for an unrelated reason", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 600_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    const browseId = await openTask(provider, runner);
    const registryPath = join(dataDir, "browse", "tasks.json");
    now += 20_000;

    runner.reset();
    runner.queue((request) => egoResult(request, {
      ok: false,
      error: { name: "Error", message: "browser crashed" },
      task: { spaceId: 7 },
      pages: [],
    }));
    await provider.reapExpired();

    const after = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { status: string; reapToken?: string }>;
    };
    // The Space is still ours, so the claim must not make it permanently unworkable.
    expect(after.tasks[browseId]).toMatchObject({ status: "active" });
    expect(after.tasks[browseId].reapToken).toBeUndefined();

    runner.reset();
    runner.queue(
      (request) => egoResult(request, taskPayload(7, "agent")),
      (request) => egoResult(request, finishPayload(7)),
    );
    await expect(provider.browse({ action: "status", browseId, page: "p1" })).resolves.toMatchObject({ spaceId: 7 });
  });
});

describe("EgoProvider oversized open summaries", () => {
  it("keeps a real Space when an oversized failed open only emits a summary", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const registryPath = join(dataDir, "browse", "tasks.json");

    const message = "x".repeat(2_100_000);
    const text = JSON.stringify({
      ok: false,
      error: { name: "Error", message },
      task: { spaceId: 7, name: "big open", ownership: "agent" },
      created: true,
      pages: [],
      spaces: [{ id: 7, name: "big open", ownership: "agent" }],
    });
    let declaredPath = "";
    runner.queue(async (request) => {
      declaredPath = /const RESULT_PATH = "([^"]+)"/.exec(request.script)?.[1] ?? "";
      if (!declaredPath) throw new Error("the managed script declared no result path");
      await mkdir(dirname(declaredPath), { recursive: true });
      await writeFile(declaredPath, text, { mode: 0o600 });
      // The shape the emit helper now prints for an oversized payload.
      return egoResult(request, {
        ok: false,
        error: { name: "Error", message },
        task: { spaceId: 7, name: "big open", ownership: "agent" },
        created: true,
        pages: [],
        spaces: [{ id: 7, name: "big open", ownership: "agent" }],
        truncated: true,
        artifactPath: declaredPath,
        artifactBytes: text.length,
      });
    });

    await expect(provider.browse({ action: "open", page: "p1", name: "big open" })).rejects.toMatchObject({
      code: "EGO_SCRIPT_ERROR",
    });

    // The Space exists, so its registration must survive with the real ID.
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { spaceId: number; name: string }>;
    };
    const pending = Object.values(registry.tasks);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ spaceId: 7, name: "big open" });
    // The oversized body moved into the Artifact store, not the hand-off directory.
    expect(await readdir(join(dataDir, "managed-results"))).toEqual([]);

    // The summary must keep the evidence the provider needs to judge creation.
    const script = runner.calls[0].script;
    expect(script).toContain("created: payload.created");
    expect(script).toContain("space.name === SPACE_NAME");
    // A huge error message must not push the summary itself past the stdout bound.
    expect(script).toContain("boundedSummaryError(payload.error)");
  });

  it("keeps a Space whose oversized summary lost the creation flag", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner });
    const registryPath = join(dataDir, "browse", "tasks.json");

    const text = JSON.stringify({
      ok: false,
      error: { name: "Error", message: "y".repeat(2_100_000) },
      task: { spaceId: 9, name: "flagless open" },
      pages: [],
      spaces: [],
    });
    runner.queue(async (request) => {
      const declaredPath = /const RESULT_PATH = "([^"]+)"/.exec(request.script)?.[1] ?? "";
      await mkdir(dirname(declaredPath), { recursive: true });
      await writeFile(declaredPath, text, { mode: 0o600 });
      // No `created` and no Space listing: the payload cannot prove a phantom entry.
      return egoResult(request, {
        ok: false,
        error: { name: "Error", message: "y".repeat(2_100_000) },
        task: { spaceId: 9, name: "flagless open" },
        pages: [],
        spaces: [],
        truncated: true,
        artifactPath: declaredPath,
        artifactBytes: text.length,
      });
    });

    await expect(provider.browse({ action: "open", page: "p1", name: "flagless open" })).rejects.toMatchObject({
      code: "EGO_SCRIPT_ERROR",
    });

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      tasks: Record<string, { spaceId: number; name: string }>;
    };
    const pending = Object.values(registry.tasks);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ spaceId: 9, name: "flagless open" });
  });
});

describe("EgoProvider hand-off cleanup", () => {
  it("removes the hand-off file when saving it as an Artifact fails", async () => {
    const config = await makeConfig(dataDir);
    const runner = new FakeRunner();
    const artifacts = {
      save: async () => {
        throw new Error("unused");
      },
      saveFile: async () => {
        throw new Error("disk full");
      },
    } as unknown as ArtifactStore;
    const provider = new EgoProvider(config, { runner, artifacts });
    const browseId = await openTask(provider, runner);
    runner.reset();

    const text = JSON.stringify({ ok: true, blob: "x".repeat(2_100_000), pages: ["p1"] });
    let declaredPath = "";
    runner.queue(async (request) => {
      declaredPath = /const RESULT_PATH = "([^"]+)"/.exec(request.script)?.[1] ?? "";
      await mkdir(dirname(declaredPath), { recursive: true });
      await writeFile(declaredPath, text, { mode: 0o600 });
      return egoResult(request, {
        ok: true,
        task: { spaceId: 7, ownership: "agent" },
        pages: ["p1"],
        truncated: true,
        artifactPath: declaredPath,
        artifactBytes: text.length,
      });
    });

    await expect(
      provider.browse({ action: "call", browseId, page: "p1", method: "page.snapshot", args: [] }),
    ).rejects.toMatchObject({ code: "EGO_ARTIFACT_FAILED" });

    // A failed registration must not leave the full payload behind on disk.
    expect(declaredPath).not.toBe("");
    await expect(stat(declaredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(dataDir, "managed-results"))).resolves.toEqual([]);
  });

  it("prunes expired hand-off files during reap without touching active writes", async () => {
    let now = 1_000_000;
    const config = await makeConfig(dataDir, { taskIdleTimeoutMs: 10_000, taskMaxAgeMs: 600_000 });
    const runner = new FakeRunner();
    const provider = new EgoProvider(config, { runner, now: () => now });
    const root = join(dataDir, "managed-results");
    await mkdir(root, { recursive: true });
    const stale = join(root, "stale.json");
    const active = join(root, "active.json");
    await writeFile(stale, "{}\n");
    await writeFile(active, "{}\n");
    const staleSeconds = (now - 11 * 60_000) / 1000;
    await utimes(stale, staleSeconds, staleSeconds);

    await provider.reapExpired();

    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    // A file that may still belong to a running script is never removed.
    expect((await stat(active)).size).toBe(3);
  });
});
