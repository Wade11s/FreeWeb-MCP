import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { ArtifactOutput } from "../artifacts/output.js";
import { configFileSchema, type AppConfig } from "../config.js";
import { FreeWebError } from "../errors.js";
import { assertPublicHttpUrl } from "../security/url.js";
import {
  browseEvaluateInputSchema,
  browseInputSchema,
  browseNodeInputSchema,
  type BrowseEvaluateInput,
  type BrowseInput,
  type BrowseNodeInput,
  type BrowseNodeOutput,
  type BrowseOutput,
} from "../types.js";
import {
  collectEgoNavigationUrls,
  collectEgoPaths,
  collectEgoUrls,
  isSafeNavigationUrl,
  prepareEgoCall,
  renderEgoCall,
} from "./ego-methods.js";
import { childProcessEnv } from "./firecrawl-process.js";

export interface EgoRunRequest {
  readonly script: string;
  readonly timeoutMs: number;
  readonly marker: string;
  readonly kind: "managed" | "evaluate" | "finish" | "node";
}

export interface EgoRunResult {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** Optional direct payload for injected test runners. */
  readonly value?: unknown;
}

export interface EgoRunner {
  run(request: EgoRunRequest): Promise<EgoRunResult>;
}

export interface EgoProviderOptions {
  runner?: EgoRunner;
  /** Alias accepted for callers that prefer an explicit provider name. */
  egoRunner?: EgoRunner;
  artifacts?: ArtifactStore;
  /** Shared output seam; defaults to one built on `artifacts`. */
  output?: ArtifactOutput;
  now?: () => number;
  uuid?: () => string;
  lookupFn?: typeof lookup;
  /** Test seam for bounded lock waits; production defaults to REGISTRY_LOCK_TIMEOUT_MS. */
  registryLockTimeoutMs?: number;
}

type EgoPayload = Record<string, unknown>;

interface EgoTaskRecord {
  browseId: string;
  spaceId: number;
  name: string;
  profileId: string;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  status: "active" | "handoff" | "reaping";
  ownership: string;
  pages: string[];
  /** Page labels in Tab order at the last finish, used to restore labels on claim. */
  pageOrder?: string[];
  /**
   * Present only while a reap finish is in flight. The value is written under the registry
   * lock before the runtime call, so the later delete can prove the record is still the
   * exact one this reaper claimed.
   */
  reapToken?: string;
  /** Status to restore if the reaping finish fails for an unrelated reason. */
  reapPreviousStatus?: "active" | "handoff";
}

interface EgoRegistry {
  version: 1;
  tasks: Record<string, EgoTaskRecord>;
}

/** A record this reaper claimed, plus the identity that later proves the claim survived. */
interface ReapCandidate {
  task: EgoTaskRecord;
  token: string;
  updatedAt: number;
  previousStatus: "active" | "handoff";
}

interface ManagedScriptOptions {
  taskId: number | null;
  name: string;
  profileId: string | null;
  pageLabel: string;
  keepCount: number;
  /** Labels this round may keep; used only as the legacy fallback mapping. */
  keptPages: readonly string[];
  /** Page labels in Tab order from the previous finish. */
  pageOrder: readonly string[];
  operationCode: string;
  marker: string;
  /** Absolute path the script uses when the payload is too large for stdout. */
  artifactPath: string;
  requiresPage?: boolean;
}

interface FinishScriptOptions {
  task: EgoTaskRecord;
  keep: string[];
  marker: string;
  artifactPath: string;
}

interface Invocation {
  result: EgoRunResult;
  payload?: EgoPayload;
}

const PROVIDER = "ego-lite";
const MANAGED_TIMEOUT_MS = 30_000;
/** Shutdown runs every registered finish concurrently inside one short budget. */
const CLOSE_TIMEOUT_MS = 5_000;
/**
 * Shutdown must never queue behind a wedged registry operation for a whole managed call.
 * close()/reapExpired() wait at most this long for the lock and then use a degraded fast path.
 */
export const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
/** A `.tasks.*.tmp` file older than this belongs to a write that already died. */
const REGISTRY_TEMP_STALE_MS = 60_000;
/**
 * page.goto shares the managed 30s budget. Leaving headroom means a slow navigation fails
 * inside the script, so the error payload (and with it the Space ID) still gets emitted.
 */
const OPEN_GOTO_TIMEOUT_MS = 25_000;
/** After the child exits, only drain stdio this long: a grandchild can hold the pipes open. */
const STDIO_DRAIN_MS = 100;
/**
 * A managed payload larger than this cannot survive the runner's bounded stdout buffer, so
 * the script writes the full JSON to disk and emits only a summary. The provider then
 * registers that file as an Artifact. Keep in sync with EgoProcessRunner's 2M default.
 */
const MANAGED_RESULT_LIMIT = 2_000_000;
/** Hand-off directory for oversized payloads, inside the provider's data directory. */
const MANAGED_RESULT_DIR = "managed-results";
/**
 * A hand-off file older than this belongs to a run that died before the provider could
 * register it as an Artifact. Only files older than the budget are removed, so an in-flight
 * script write is never pruned.
 */
const MANAGED_RESULT_STALE_MS = 10 * 60_000;
/**
 * How long a `reaping` claim may stand before another reap may steal it. Squeezing a reap
 * finish (5s) plus both lock waits makes a lost mark unambiguous, and stealing changes the
 * token so the dead reaper's delete is still rejected.
 */
const REAP_CLAIM_STALE_MS = 60_000;
const DEFAULT_EGO = configFileSchema.parse({}).ego;
const DEFAULT_INLINE_CHARS = configFileSchema.parse({}).artifacts.inlineNodeChars;
const MISSING_SPACE_CODE = "EGO_SPACE_MISSING";
/**
 * ego-lite ends a handed-off round by discarding all script output and printing this owned
 * guidance instead. The leading line is specific to user control (permission-prompt hard
 * stops word it differently), and the resume hint proves the diagnostic is the terminal
 * handoff contract rather than an arbitrary failure message.
 */
const HANDOFF_HARD_STOP_LINE = "Control of this task space is with the user";
const HANDOFF_RESUME_HINT = "takeOverTaskSpace(spaceId)";

function isRecord(value: unknown): value is EgoPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePageOrder(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const order: string[] = [];
  for (const label of value) {
    if (typeof label !== "string" || !label || order.includes(label)) continue;
    order.push(label);
    if (order.length === 20) break;
  }
  return order.length ? order : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function asError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: (error as Error & { code?: string }).code };
  }
  return { name: "Error", message: String(error) };
}

function invalidInput(prefix: string, error: unknown): never {
  const issues = isRecord(error) && Array.isArray(error.issues) ? error.issues : [];
  throw new FreeWebError("INVALID_INPUT", prefix, {
    provider: PROVIDER,
    details: { issues },
    cause: error,
  });
}

function payloadError(payload: EgoPayload): FreeWebError {
  const detail = isRecord(payload.error) ? payload.error : { message: String(payload.error ?? "ego script failed") };
  return new FreeWebError(typeof detail.code === "string" ? detail.code : "EGO_SCRIPT_ERROR", String(detail.message ?? "ego script failed"), {
    provider: PROVIDER,
    details: { error: detail },
  });
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

/**
 * True while `current` is still the exact registry entry that was read into a snapshot.
 * A later open or reap changes at least one of these fields, so an identity mismatch is
 * proof that the record now belongs to newer work.
 */
function sameTaskIdentity(current: EgoTaskRecord, snapshot: EgoTaskRecord): boolean {
  return current.updatedAt === snapshot.updatedAt
    && current.spaceId === snapshot.spaceId
    && current.reapToken === snapshot.reapToken;
}

class LimitedBuffer {
  private head = "";
  private tail = "";

  constructor(private readonly limit: number) {}

  push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.head.length < this.limit) {
      const room = this.limit - this.head.length;
      this.head += text.slice(0, room);
      const rest = text.slice(room);
      if (rest) this.tail = (this.tail + rest).slice(-this.limit);
    } else {
      this.tail = (this.tail + text).slice(-this.limit);
    }
  }

  toString(): string {
    return this.head + (this.tail ? `\n[output truncated]\n${this.tail}` : "");
  }
}

export interface EgoSpawnOptions {
  readonly shell: false;
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
  readonly env: NodeJS.ProcessEnv;
}

export type EgoSpawnFn = (command: string, args: string[], options: EgoSpawnOptions) => ReturnType<typeof spawn>;

export class EgoProcessRunner implements EgoRunner {
  constructor(private readonly options: { binary?: string; maxOutputChars?: number; spawnFn?: EgoSpawnFn } = {}) {}

  async run(request: EgoRunRequest): Promise<EgoRunResult> {
    const binary = this.options.binary ?? DEFAULT_EGO.binary;
    const spawnFn = this.options.spawnFn ?? spawn;
    const maxOutputChars = this.options.maxOutputChars ?? 2_000_000;
    const stdout = new LimitedBuffer(maxOutputChars);
    const stderr = new LimitedBuffer(maxOutputChars);
    const startedAt = Date.now();
    let timedOut = false;
    let child: ReturnType<EgoSpawnFn>;

    try {
      child = spawnFn(binary, ["nodejs"], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Reuse the provider child whitelist so agent secrets (TINYFISH_API_KEY and
        // friends) never reach the ego runtime, while proxies and locale survive.
        env: childProcessEnv({}),
      });
    } catch (error) {
      throw new FreeWebError("EGO_SPAWN_FAILED", `Cannot start ${binary}`, { provider: PROVIDER, cause: error });
    }

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (!stdoutStream || !stderrStream || !stdinStream) {
      child.kill("SIGKILL");
      throw new FreeWebError("EGO_SPAWN_FAILED", `${binary} did not expose stdio pipes`, { provider: PROVIDER });
    }

    return await new Promise<EgoRunResult>((resolve, reject) => {
      let settled = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let sawExit = false;
      let killTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;

      const settle = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (drainTimer) clearTimeout(drainTimer);
        detach();
        resolve({
          exitCode,
          signal: exitSignal ?? undefined,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          durationMs: Math.max(0, Date.now() - startedAt),
          timedOut,
        });
      };

      // `close` only fires once every stdio pipe is closed, and a grandchild that inherited
      // them can keep them open forever. After `exit` we therefore drain for a short window
      // and then report what we have instead of hanging on the child handle.
      const scheduleDrain = (delayMs = STDIO_DRAIN_MS) => {
        if (settled || drainTimer) return;
        drainTimer = setTimeout(settle, delayMs);
      };

      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        // Independent hard deadline: even a child that ignores the signal must return.
        scheduleDrain();
      }, request.timeoutMs + 250);

      const onStdout = (chunk: Buffer) => stdout.push(chunk);
      const onStderr = (chunk: Buffer) => stderr.push(chunk);
      const detach = () => {
        // A grandchild can outlive this call: drop the pipes instead of buffering forever.
        stdoutStream.removeListener("data", onStdout);
        stderrStream.removeListener("data", onStderr);
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        sawExit = true;
        exitCode = code;
        exitSignal = signal;
        scheduleDrain();
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (!sawExit) {
          exitCode = code;
          exitSignal = signal;
        }
        settle();
      };

      stdoutStream.on("data", onStdout);
      stderrStream.on("data", onStderr);
      stdinStream.on("error", () => {
        // EPIPE is normal when the runtime rejects a script before reading all stdin.
      });
      stdinStream.end(request.script, "utf8");

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (drainTimer) clearTimeout(drainTimer);
        detach();
        reject(new FreeWebError("EGO_SPAWN_FAILED", `Cannot run ${binary}`, { provider: PROVIDER, cause: error }));
      });
      child.on("exit", onExit);
      child.on("close", onClose);
    });
  }
}

function serializeScriptError(): string {
  return `const serializeEgoError = (error) => {
  const value = { name: error?.name ?? "Error", message: error?.message ?? String(error) };
  for (const key of ["code", "details", "executionStopped", "pageResponsive", "mayHaveLateEffects", "stopped"]) {
    if (error && key in error) value[key] = error[key];
  }
  return value;
};`;
}

function emitHelper(marker: string, artifactPath: string): string {
  return `const RESULT_MARKER = ${json(marker)};
const RESULT_LIMIT = ${MANAGED_RESULT_LIMIT};
const RESULT_PATH = ${json(artifactPath)};
const RESULT_DIR = ${json(dirname(artifactPath))};
const emitEgoResult = async (payload) => {
  let text;
  try {
    text = JSON.stringify(payload) ?? "undefined";
  } catch (error) {
    text = JSON.stringify({ ok: false, error: serializeEgoError(error) });
  }
  if (text.length > RESULT_LIMIT) {
    const fs = await import("node:fs/promises");
    await fs.mkdir(RESULT_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(RESULT_PATH, text, { encoding: "utf8", mode: 0o600 });
    // A huge error message would push the summary itself past the runner's stdout bound,
    // which would hide the marker line the provider needs. The full text stays in the file.
    const boundedSummaryError = (error) => {
      const message = String(error && typeof error === "object" ? error.message ?? "" : error ?? "").slice(0, 400);
      return error && typeof error === "object" ? { ...error, message } : message;
    };
    console.log(RESULT_MARKER + JSON.stringify({
      ok: payload.ok,
      ...(payload.ok === false ? { error: boundedSummaryError(payload.error) } : {}),
      task: payload.task,
      pages: payload.pages,
      // The summary is all the provider sees for an oversized run, so it must carry the
      // same evidence as the full payload: dropping created/spaces would make a
      // failed open that really did create a Space look like a phantom one.
      created: payload.created,
      spaces: Array.isArray(payload.spaces)
        ? payload.spaces.filter((space) => space && space.name === SPACE_NAME)
        : payload.spaces,
      truncated: true,
      artifactPath: RESULT_PATH,
      artifactBytes: text.length,
    }));
    return;
  }
  console.log(RESULT_MARKER + text);
};
${serializeScriptError()}`;
}

/** Managed Page labels in stable Tab order, independent of url/title and keep order. */
function pageOrderHelper(): string {
  return `const managedPageOrder = (tabs) => tabs
  .filter((tab) => typeof tab.label === "string" && tab.label && tab.openedBy !== "user" && tab.openedBy !== "unknown")
  .map((tab) => tab.label);`;
}

interface AcquisitionScript {
  /** Constants declared before the try so the catch block can still report the task. */
  readonly constants: string;
  /** Everything that can throw, so acquisition errors reach the emitted payload. */
  readonly body: string;
}

function acquisitionScript(options: Pick<ManagedScriptOptions, "taskId" | "name" | "profileId" | "keepCount" | "keptPages" | "pageOrder" | "pageLabel" | "requiresPage">, withPage: boolean): AcquisitionScript {
  const createCall = options.profileId === null
    ? "await taskSpace(SPACE_NAME)"
    : `await taskSpace(SPACE_NAME, { profileId: ${json(options.profileId)} })`;
  // finish(keep) retains tab objects in their own order but ends their labels. Restore
  // only from the label list recorded in that same Tab order, or (for legacy rows) from
  // the single unambiguous saved label. Never invent labels, never repeat an `as` label,
  // and never adopt a tab without a label. The exact-label check below decides whether
  // the requested Page exists after restoration.
  const adoptBlock = options.keptPages.length > 0 || options.pageOrder.length > 0
    ? `if (wasClaimed) {
  const tabs = await task.tabs();
  const candidates = tabs.filter((tab) => !tab.label && tab.openedBy !== "user" && tab.openedBy !== "unknown");
  const labels = [...new Set(PAGE_ORDER.length ? PAGE_ORDER : KEPT_PAGES)];
  for (const [index, tab] of candidates.slice(0, labels.length).entries()) {
    await task.adopt(tab.page, { as: labels[index] });
  }
}
`
    : "";
  // A legacy row has no recorded Tab-order mapping. Its saved `pages` list is the last
  // keep preference, not Tab order, so it is trustworthy only with one saved label and
  // one surviving managed tab. Fail before claiming in every other case so the Space
  // stays exactly as it was and the caller gets a concrete recovery step.
  const legacyGuard = withPage && options.pageOrder.length === 0
    ? `if (wasClaimed) {
  const preview = await taskSpace(RESOLVED_ID);
  const previewTabs = await preview.tabs();
  const candidates = previewTabs.filter((tab) => !tab.label && tab.openedBy !== "user" && tab.openedBy !== "unknown");
  const saved = [...new Set(KEPT_PAGES)];
  if (candidates.length !== 1 || saved.length !== 1) {
    const missing = new Error("EGO_PAGE_NOT_FOUND: legacy Page label mapping is ambiguous; close and reopen the managed Task Space");
    missing.code = "EGO_PAGE_NOT_FOUND";
    missing.details = { requestedPage: PAGE_LABEL, availablePages: KEPT_PAGES, reason: "legacy-page-mapping-ambiguous", recovery: "close and reopen the managed Task Space" };
    throw missing;
  }
}
`
    : "";
  // A negative ID is a placeholder written before the Space was known (open()), so the
  // registry can still reclaim the Space by name after a timeout. Real IDs resolve by id.
  const spaceLookup = `const spaceEntry = TASK_ID === null
  ? undefined
  : TASK_ID >= 0
    ? spacesBefore.find((space) => space.id === TASK_ID)
    : spacesBefore.find((space) => space.name === SPACE_NAME);`;
  const constants = `const TASK_ID = ${json(options.taskId)};
const SPACE_NAME = ${json(options.name)};
const KEEP_COUNT = ${options.keepCount};
const KEPT_PAGES = ${json(options.keptPages)};
const PAGE_ORDER = ${json(options.pageOrder)};
let RESOLVED_ID = TASK_ID === null ? -1 : TASK_ID;
let task = null;
${withPage ? `const PAGE_LABEL = ${json(options.pageLabel)};\n` : ""}`;
  const body = `const spacesBefore = await listTaskSpaces();
${spaceLookup}
if (spaceEntry) RESOLVED_ID = spaceEntry.id;
const wasClaimed = !!spaceEntry && (spaceEntry.ownership === "user" || spaceEntry.ownership === "inactive");
${legacyGuard}task = !spaceEntry
  ? TASK_ID === null
    ? ${createCall}
    : (() => { const missing = new Error("EGO_SPACE_MISSING"); missing.code = "EGO_SPACE_MISSING"; throw missing; })()
  : wasClaimed
    ? await claimTaskSpace(RESOLVED_ID)
    : spaceEntry.ownership === "agentDelegatedToUser"
      ? await takeOverTaskSpace(RESOLVED_ID)
      : await taskSpace(RESOLVED_ID);
${adoptBlock}${withPage ? `const managedPages = await task.pages();
const page = managedPages.find((item) => item.label === PAGE_LABEL);
${options.requiresPage === false ? "" : `if (!page) {
  const availablePages = managedPages.map((item) => item.label);
  const missing = new Error("EGO_PAGE_NOT_FOUND: Page " + PAGE_LABEL + " was not found; available Page labels: " + (availablePages.length ? availablePages.join(", ") : "none"));
  missing.code = "EGO_PAGE_NOT_FOUND";
  missing.details = { requestedPage: PAGE_LABEL, availablePages };
  throw missing;
}`}` : ""}`;
  return { constants, body };
}

function buildManagedScript(options: ManagedScriptOptions): string {
  const pageGuard = options.requiresPage === false
    ? ""
    : `  if (!page && TASK_ID !== null) {
    const missing = new Error("EGO_PAGE_MISSING");
    missing.code = "EGO_PAGE_MISSING";
    throw missing;
  }
`;
  const acquisition = acquisitionScript(options, true);
  return `${emitHelper(options.marker, options.artifactPath)}
${pageOrderHelper()}
${acquisition.constants}let egoCallValue;
try {
${acquisition.body}
${pageGuard}${options.operationCode}
  const pagesAfter = await task.pages();
  await emitEgoResult({
    ok: true,
    value: egoCallValue,
    task: { spaceId: task.spaceId ?? RESOLVED_ID, name: task.name, ownership: task.ownership },
    pages: pagesAfter.map((item) => item.label),
    pageOrder: managedPageOrder(await task.tabs()),
    spaces: await listTaskSpaces(),
  });
} catch (error) {
  // Acquisition failures (including EGO_SPACE_MISSING) must still emit a payload so the
  // provider can tell a vanished Space apart from an opaque runtime crash.
  const failedTask = task
    ? { spaceId: task.spaceId ?? RESOLVED_ID, name: task.name, ownership: task.ownership }
    : null;
  const spacesAfter = await listTaskSpaces().catch(() => undefined);
  await emitEgoResult({
    ok: false,
    error: serializeEgoError(error),
    task: failedTask,
    // Tri-state so open() can tell a created-but-broken Space (keep its registration) from
    // a phantom entry (safe to drop) from a state it cannot judge (keep, reap by name).
    created: failedTask !== null || (Array.isArray(spacesAfter)
      ? spacesAfter.some((space) => space.name === SPACE_NAME)
      : null),
    pages: [],
    spaces: Array.isArray(spacesAfter) ? spacesAfter : [],
  });
}
`;
}

function buildFinishScript(options: FinishScriptOptions): string {
  const keep = options.keep.map((label) => json(label)).join(", ");
  // Adopt only the unlabeled tabs this finish keeps, restoring each label before
  // finish({ keep }) selects it. Deriving the count from stale `task.pages` would
  // adopt pages that `finish({ keep: [] })` is about to release (close/reap).
  const keepCount = options.keep.length;
  const acquisition = acquisitionScript(
    { taskId: options.task.spaceId, name: options.task.name, profileId: options.task.profileId, keepCount, keptPages: options.keep, pageOrder: options.task.pageOrder ?? [], pageLabel: options.task.pages[0] ?? "p1" },
    false,
  );
  return `${emitHelper(options.marker, options.artifactPath)}
${pageOrderHelper()}
${acquisition.constants}try {
${acquisition.body}
  const tabsBeforeFinish = await task.tabs();
  const receipt = await task.finish({ keep: [${keep}] });
  await emitEgoResult({
    ok: true,
    value: { finished: true, receipt },
    task: { spaceId: RESOLVED_ID, name: SPACE_NAME, ownership: "user" },
    pages: [${keep}],
    pageOrder: managedPageOrder(tabsBeforeFinish).filter((label) => KEPT_PAGES.includes(label)),
    receipt,
    spaces: await listTaskSpaces(),
  });
} catch (error) {
  await emitEgoResult({
    ok: false,
    error: serializeEgoError(error),
    task: { spaceId: task ? task.spaceId ?? RESOLVED_ID : RESOLVED_ID, name: SPACE_NAME },
    pages: [],
    spaces: await listTaskSpaces().catch(() => []),
  });
}
`;
}

function extractPayload(request: EgoRunRequest, result: EgoRunResult): EgoPayload | undefined {
  if (isRecord(result.value)) return result.value;
  for (const stream of [result.stderr, result.stdout]) {
    if (typeof stream !== "string") continue;
    const lines = stream.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const position = lines[index].indexOf(request.marker);
      if (position < 0) continue;
      try {
        const parsed = JSON.parse(lines[index].slice(position + request.marker.length));
        if (isRecord(parsed)) return parsed;
      } catch {
        // Other CLI output can share the line; keep scanning.
      }
    }
  }
  return undefined;
}

export class EgoProvider {
  private readonly ego: AppConfig["ego"];
  private readonly dataDir: string;
  private readonly inlineNodeChars: number;
  private readonly runner: EgoRunner;
  private readonly artifacts: ArtifactStore;
  private readonly output: ArtifactOutput;
  private readonly nowFn: () => number;
  private readonly uuidFn: () => string;
  private readonly lookupFn: typeof lookup;
  /**
   * Registry critical sections are short: read-modify-write, never a runtime call. The
   * hand-off mutex lets shutdown time out instead of queueing behind a wedged operation.
   */
  private lockBusy = false;
  private readonly lockWaiters: Array<() => void> = [];
  private readonly registryLockTimeoutMs: number;
  private closed = false;
  private nodeActive = 0;
  private readonly nodeWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(config: AppConfig, options: EgoProviderOptions | EgoRunner = {}) {
    const resolved: EgoProviderOptions = typeof (options as EgoRunner).run === "function"
      ? { runner: options as EgoRunner }
      : options as EgoProviderOptions;
    this.ego = { ...DEFAULT_EGO, ...(config.ego ?? {}) };
    this.dataDir = config.dataDir ?? join(homedir(), ".freeweb-mcp");
    this.inlineNodeChars = config.artifacts?.inlineNodeChars ?? DEFAULT_INLINE_CHARS;
    this.runner = resolved.runner ?? resolved.egoRunner ?? new EgoProcessRunner({ binary: this.ego.binary });
    this.artifacts = resolved.artifacts ?? new ArtifactStore({
      root: this.dataDir,
      retentionMs: config.artifacts?.retentionMs,
    });
    this.output = resolved.output ?? new ArtifactOutput(this.artifacts);
    this.nowFn = resolved.now ?? Date.now;
    this.uuidFn = resolved.uuid ?? randomUUID;
    this.lookupFn = resolved.lookupFn ?? lookup;
    this.registryLockTimeoutMs = resolved.registryLockTimeoutMs ?? REGISTRY_LOCK_TIMEOUT_MS;
    if (!this.ego.allowedProfiles.includes(this.ego.defaultProfile)) {
      throw new FreeWebError("INVALID_CONFIG", "ego.defaultProfile must be in ego.allowedProfiles", { provider: PROVIDER });
    }
  }

  async browse(input: BrowseInput): Promise<BrowseOutput> {
    this.assertOpen();
    const parsed = browseInputSchema.safeParse(input);
    if (!parsed.success) invalidInput("Invalid browse input", parsed.error);
    // Re-check inside the critical section: a request queued behind a wedged call must not
    // start work once close() has already begun.
    return this.withRegistryLock(() => {
      this.assertOpen();
      return this.browseLocked(parsed.data);
    });
  }

  async evaluate(input: BrowseEvaluateInput): Promise<BrowseOutput> {
    this.assertOpen();
    const parsed = browseEvaluateInputSchema.safeParse(input);
    if (!parsed.success) invalidInput("Invalid evaluate input", parsed.error);
    return this.withRegistryLock(() => {
      this.assertOpen();
      return this.evaluateLocked(parsed.data);
    });
  }

  async node(input: BrowseNodeInput): Promise<BrowseNodeOutput> {
    // Shutdown must not be reopened by a late caller, even before the config gate runs.
    this.assertOpen();
    if (!this.ego.unrestricted) {
      throw new FreeWebError("EGO_UNRESTRICTED_DISABLED", "node requires ego.unrestricted", { provider: PROVIDER });
    }
    const parsed = browseNodeInputSchema.safeParse(input);
    if (!parsed.success) invalidInput("Invalid node input", parsed.error);

    await this.acquireNodeSlot();
    let invocation: Invocation;
    try {
      invocation = await this.invoke(parsed.data.script, parsed.data.timeoutMs, "node");
    } finally {
      this.releaseNodeSlot();
    }
    const { result } = invocation;
    const timedOut = result.timedOut;
    const exitCode = result.exitCode;
    const published = await this.output.publish({
      kind: "unrestricted-output",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut,
      inlineNodeChars: this.inlineNodeChars,
    });
    return {
      exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      stdout: published.stdout,
      stderr: published.stderr,
      durationMs: result.durationMs,
      timedOut,
      // An unrestricted Node script always may outlive the runner (orphaned child
      // processes, sockets, timers or files), even when it exits 0.
      mayHaveLateEffects: true,
      artifactId: published.artifactId,
    };
  }

  async close(): Promise<void> {
    // Set synchronously so no new work can slip in while shutdown runs, and so queued node
    // callers are rejected instead of resurrecting the provider.
    this.closed = true;
    this.rejectNodeWaiters();
    // Read the registry *without* the lock: writes are atomic renames, so this snapshot is
    // consistent even while an in-flight call holds the lock. Waiting for the lock first is
    // what used to let one wedged browse eat the whole shutdown budget and skip every
    // finish, leaking every registered Space.
    const snapshot = await this.readRegistry();
    // Ownership scope: the registry is this provider's own Space ledger, so close never
    // finishes a Space it did not create (for example Spaces reported by the runtime).
    const tasks = Object.values(snapshot.tasks);
    if (tasks.length === 0) return;
    // Start every finish at once: serial finishes would multiply the shutdown budget by
    // the number of managed tasks. Each finish still fails on its own.
    const results = await Promise.allSettled(
      tasks.map((task) => this.finishTask(task, [], CLOSE_TIMEOUT_MS)),
    );

    // Only now take the lock, and delete against the registry as it is *now*: a record that
    // a later open or reap replaced proves by its identity that it is no longer the entry
    // this shutdown finished, so deleting it would destroy live work.
    await this.tryRegistryLock(async () => {
      const registry = await this.readRegistry();
      let changed = false;
      tasks.forEach((task, index) => {
        const current = registry.tasks[task.browseId];
        if (!current || !sameTaskIdentity(current, task)) return;
        const result = results[index];
        // A Space that is already gone can never be closed again: forget it instead of
        // retrying forever. Everything else stays registered for a later retry.
        if (result.status !== "fulfilled" && !this.isMissingSpace(result.reason)) return;
        delete registry.tasks[task.browseId];
        changed = true;
      });
      // Shutdown is the one writer a closed provider still accepts: skipping this delete
      // would leave finished Spaces registered forever.
      if (changed) await this.writeRegistry(registry, { allowClosed: true });
    }, this.registryLockTimeoutMs);
  }

  async reapExpired(): Promise<void> {
    // Shutdown already ran (or is running): reaping after close would reopen closed work.
    if (this.closed) return;
    await this.pruneManagedResults();
    const candidates = await this.tryRegistryLock(async () => {
      const registry = await this.readRegistry();
      const now = this.nowFn();
      const expired: ReapCandidate[] = [];
      for (const task of Object.values(registry.tasks)) {
        // Another call already claimed this record: its token authorizes the delete, and a
        // second claim would strand that bookkeeping and double-finish the Space. A claim
        // that outlived every budget belongs to a dead reaper and may be taken over.
        if (task.status === "reaping" && now - task.updatedAt <= REAP_CLAIM_STALE_MS) continue;
        const idleExpired = now - task.lastActiveAt > this.ego.taskIdleTimeoutMs;
        const ageExpired = now - task.createdAt > this.ego.taskMaxAgeMs;
        // A stolen claim is reaped regardless of expiry: its Space is already being finished.
        const claimedAgain = task.status === "reaping";
        if (!claimedAgain && !idleExpired && !ageExpired) continue;
        // A handed-off task is left alone until its absolute maximum age passes.
        if (!claimedAgain && task.status === "handoff" && !ageExpired) continue;
        const previousStatus = task.status === "reaping"
          ? task.reapPreviousStatus === "handoff" ? "handoff" : "active"
          : task.status;
        // Claim the record before touching the runtime so no work can start on a Space that
        // is being finished, and so the delete below can prove it still owns this record.
        task.status = "reaping";
        task.reapToken = this.uuidFn();
        task.reapPreviousStatus = previousStatus;
        task.updatedAt = now;
        expired.push({ task, token: task.reapToken, updatedAt: now, previousStatus });
      }
      if (expired.length === 0) return expired;
      await this.writeRegistry(registry);
      return expired;
    }, this.registryLockTimeoutMs);
    if (!candidates || candidates.length === 0) return;

    // Finish outside the lock: the runtime call is the slow part and other registry work
    // must not queue behind it. Expiry was decided from the snapshot above.
    const results = await Promise.allSettled(
      candidates.map((candidate) => this.finishTask(candidate.task, [], CLOSE_TIMEOUT_MS)),
    );
    await this.tryRegistryLock(async () => {
      const registry = await this.readRegistry();
      let changed = false;
      candidates.forEach((candidate, index) => {
        const current = registry.tasks[candidate.task.browseId];
        // Only the exact record this reaper claimed may be removed. A close or a fresh open
        // that reused the browseId replaced it, and deleting that would destroy live work.
        if (
          !current ||
          current.status !== "reaping" ||
          current.reapToken !== candidate.token ||
          current.updatedAt !== candidate.updatedAt
        ) {
          return;
        }
        changed = true;
        const result = results[index];
        // Registry ownership is retained on failure; a vanished Space is dropped so the
        // dead entry stops counting against maxTasks.
        if (result.status === "fulfilled" || this.isMissingSpace(result.reason)) {
          delete registry.tasks[candidate.task.browseId];
          return;
        }
        // An unrelated failure must not leave the Space permanently unworkable: release the
        // claim so the next reap (or a caller) can retry it.
        current.status = candidate.previousStatus;
        delete current.reapToken;
        delete current.reapPreviousStatus;
        current.updatedAt = this.nowFn();
      });
      if (changed) await this.writeRegistry(registry);
      // Reaping is background maintenance: if the lock cannot be taken it stops here and
      // never writes back a snapshot that another holder has already superseded.
    }, this.registryLockTimeoutMs);
  }

  /**
   * Reachability cleanup for the oversized-payload hand-off directory: a script that is
   * killed between `writeFile` and the provider's `saveFile` leaves its JSON behind. Fresh
   * files are kept because they may still belong to a run that is writing them right now.
   */
  private async pruneManagedResults(): Promise<void> {
    const root = join(this.dataDir, MANAGED_RESULT_DIR);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    const cutoff = this.nowFn() - MANAGED_RESULT_STALE_MS;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.endsWith(".json")) return;
      const path = join(root, entry);
      try {
        const info = await stat(path);
        if (info.mtimeMs > cutoff) return;
        await unlink(path);
      } catch {
        // Another run may have registered or removed the same hand-off file first.
      }
    }));
  }

  private assertOpen(): void {
    if (this.closed) throw this.closedError();
  }

  private async browseLocked(input: BrowseInput): Promise<BrowseOutput> {
    const registry = await this.readRegistry();
    switch (input.action) {
      case "open":
        return this.openTask(registry, input);
      case "status":
        return this.statusTask(registry, input);
      case "call":
        return this.callTask(registry, input);
      case "handoff":
        return this.handoffTask(registry, input);
      case "resume":
        return this.resumeTask(registry, input);
      case "close":
        return this.closeTask(registry, input);
      default:
        throw new FreeWebError("INVALID_INPUT", "Unsupported browse action", { provider: PROVIDER });
    }
  }

  private validateProfile(profileId?: string): string {
    const selected = profileId ?? this.ego.defaultProfile;
    if (!this.ego.allowedProfiles.includes(selected)) {
      throw new FreeWebError("EGO_PROFILE_NOT_ALLOWED", `ego profile is not allowed: ${selected}`, { provider: PROVIDER });
    }
    return selected;
  }

  private async openTask(registry: EgoRegistry, input: BrowseInput): Promise<BrowseOutput> {
    const profileId = this.validateProfile(input.profileId);
    if (Object.keys(registry.tasks).length >= this.ego.maxTasks) {
      throw new FreeWebError("EGO_TASK_LIMIT", `at most ${this.ego.maxTasks} managed tasks are allowed`, { provider: PROVIDER });
    }
    const url = input.url
      ? (await assertPublicHttpUrl(input.url, { allowPrivate: this.ego.allowPrivate, lookupFn: this.lookupFn })).toString()
      : undefined;
    const browseId = input.browseId ?? this.uuidFn();
    if (registry.tasks[browseId]) {
      throw new FreeWebError("EGO_TASK_EXISTS", "browseId already exists", { provider: PROVIDER });
    }
    const name = input.name ?? `freeweb-${browseId.slice(0, 8)}`;
    // A duplicate name would make a by-name reap hit a healthy Space that happens to share
    // it, so names are unique per registry entry.
    if (Object.values(registry.tasks).some((task) => task.name === name)) {
      throw new FreeWebError("EGO_TASK_EXISTS", `a managed task named ${name} is already registered`, {
        provider: PROVIDER,
        details: { name },
      });
    }
    const operationCode = `${url ? `egoCallValue = await page.goto(${json(url)}, { waitUntil: "load", timeout: ${OPEN_GOTO_TIMEOUT_MS} });\n` : ""}egoCallValue = { ...(typeof egoCallValue === "object" && egoCallValue ? egoCallValue : {}), opened: true };`;

    // Register a spaceId -1 placeholder before the runtime starts. If the runtime is killed
    // mid-open the Space may exist without ever being reported, so close()/reapExpired()
    // need a registry entry that can resolve the Space by name.
    const now = this.nowFn();
    const placeholder: EgoTaskRecord = {
      browseId,
      spaceId: -1,
      name,
      profileId,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      status: "active",
      ownership: "agent",
      pages: [input.page ?? "p1"],
    };
    registry.tasks[browseId] = placeholder;
    await this.writeRegistry(registry);

    let payload: EgoPayload;
    try {
      ({ payload } = await this.runManaged({
        taskId: null,
        name,
        profileId,
        pageLabel: input.page,
        keepCount: 1,
        keptPages: [input.page ?? "p1"],
        pageOrder: [],
        operationCode,
        kind: "managed",
      }));
    } catch (error) {
      // A runner that never started a runtime is the only failure that confirms no Space
      // was created. Everything else (timeout, crash, opaque exit) may have created one
      // already, so the placeholder stays and the reaper resolves the Space by name.
      if (error instanceof FreeWebError && error.code === "EGO_SPAWN_FAILED") {
        delete registry.tasks[browseId];
        await this.writeRegistry(registry);
      }
      throw error;
    }

    const task = this.recordFromPayload(browseId, name, profileId, payload);
    // Only a payload that proves the runtime never reached taskSpace() may drop the entry:
    // a Space that exists but failed mid-open must stay registered (with its real ID) so a
    // later close/reap can finish it instead of orphaning it.
    if (this.confirmedNoSpace(payload, name)) {
      delete registry.tasks[browseId];
      await this.writeRegistry(registry);
      if (payload.ok === false) throw payloadError(payload);
      throw new FreeWebError("EGO_INVALID_RESPONSE", "ego open returned no Space ID", { provider: PROVIDER });
    }
    // Replace the placeholder with whatever the runtime reported: the real Space ID when it
    // knows it, otherwise -1 so the record keeps resolving the Space by name.
    registry.tasks[browseId] = task;
    await this.writeRegistry(registry);
    if (payload.ok === false) throw payloadError(payload);
    if (task.spaceId < 0) {
      throw new FreeWebError("EGO_INVALID_RESPONSE", "ego open returned no Space ID", { provider: PROVIDER });
    }

    const keep = this.requiredKeep(input.page, payload);
    const warnings = await this.finishAndUpdate(registry, task, keep);
    return this.outputFor(task, payload, keep, warnings);
  }

  /**
   * Tri-state reading of the managed payload's `created` flag. `true` means the Space exists
   * (or was already claimed), `false` means the runtime proved it never created one, and
   * `undefined` means the script could not tell us.
   */
  private confirmedNoSpace(payload: EgoPayload, name: string): boolean {
    if (payload.created === true) return false;
    if (payload.created === false) return true;
    if (payload.created === null) return false;
    // Payloads from before the flag existed fall back to the post-failure Space listing.
    if (payload.ok === true) return false;
    // A summary or truncated payload can drop the listing entirely; the absence of evidence
    // is not evidence of absence, so a payload that identifies a task is always kept.
    if (this.reportsTask(payload)) return false;
    if (!Array.isArray(payload.spaces)) return false;
    return !payload.spaces.some((space) => isRecord(space) && space.name === name);
  }

  /**
   * True when the payload carries an identified task instead of the null an early failure
   * emits. The name/spaceId pair is what the managed script always reports for a task, so
   * an empty object (`task: {}`) is not treated as one.
   */
  private reportsTask(payload: EgoPayload): boolean {
    const taskInfo = payload.task;
    return isRecord(taskInfo) && (typeof taskInfo.spaceId === "number" || typeof taskInfo.name === "string");
  }

  private async statusTask(registry: EgoRegistry, input: BrowseInput): Promise<BrowseOutput> {
    if (!input.browseId) {
      return {
        status: "ok",
        result: {
          // A browse-less list is still an output: the -1 by-name placeholder is a registry
          // detail, so an unknown Space ID is omitted instead of being published as -1.
          tasks: Object.values(registry.tasks).map((task) => ({
            browseId: task.browseId,
            ...(task.spaceId >= 0 ? { spaceId: task.spaceId } : { spaceIdKnown: false }),
            status: task.status,
            ownership: task.ownership,
            pages: task.pages,
            createdAt: task.createdAt,
            lastActiveAt: task.lastActiveAt,
          })),
        },
      };
    }
    const task = this.requireTask(registry, input.browseId);
    // A handed-off Space belongs to the user. Inspecting its persisted state must not run
    // an ego call (which would be a hard stop), finish the Space, or take ownership back, so
    // status reports the serialized registry record instead of touching the runtime.
    if (task.status === "handoff") {
      return {
        browseId: task.browseId,
        ...this.spaceIdFields(task),
        status: "handoff",
        result: { status: task.status, ownership: task.ownership, pages: task.pages },
        pages: task.pages,
      };
    }
    this.requireWorkAllowed(task);
    const { payload } = await this.runManaged({
      ...this.managedBase(task, input.page),
      operationCode: `egoCallValue = {
    pages: (await task.pages()).map((item) => item.label),
    tabs: (await task.tabs()).map((tab) => ({ label: tab.label, title: tab.title, url: tab.url, openedBy: tab.openedBy, active: tab.active })),
  };`,
      kind: "managed",
      requiresPage: false,
    });
    if (payload.ok === false) throw payloadError(payload);
    this.updateRecord(task, payload);
    const keep = this.requiredKeep(input.page, payload);
    const warnings = await this.finishAndUpdate(registry, task, keep);
    await this.writeRegistry(registry);
    return this.outputFor(task, payload, keep, warnings);
  }

  private async callTask(registry: EgoRegistry, input: BrowseInput): Promise<BrowseOutput> {
    const task = this.requireTask(registry, input.browseId);
    this.requireWorkAllowed(task);
    const plan = prepareEgoCall(input.method ?? "", input.args ?? [], input.options);
    for (const ref of collectEgoPaths(plan)) await this.assertAllowedPath(ref);
    for (const url of collectEgoUrls(plan)) {
      await assertPublicHttpUrl(url, { allowPrivate: this.ego.allowPrivate, lookupFn: this.lookupFn });
    }
    // collectEgoUrls only sees absolute http(s) targets. Navigation-marked calls may also
    // carry relative targets, so re-check every navigation target for smuggled schemes.
    for (const url of collectEgoNavigationUrls(plan)) {
      if (!isSafeNavigationUrl(url)) {
        throw new FreeWebError("INVALID_URL_SCHEME", "Ego navigation only allows HTTP(S) or same-origin relative URLs", {
          provider: PROVIDER,
          details: { url },
        });
      }
    }
    if (plan.spec.target !== "task") this.requirePage(task, input.page);
    const { payload } = await this.runManaged({
      ...this.managedBase(task, input.page),
      operationCode: renderEgoCall(plan),
      kind: "managed",
      requiresPage: plan.spec.target !== "task",
    });
    if (payload.ok === false) throw payloadError(payload);
    this.updateRecord(task, payload);
    const keep = this.requiredKeep(input.page, payload);
    const warnings = await this.finishAndUpdate(registry, task, keep);
    await this.writeRegistry(registry);
    return this.outputFor(task, payload, keep, warnings);
  }

  private async handoffTask(registry: EgoRegistry, input: BrowseInput): Promise<BrowseOutput> {
    const task = this.requireTask(registry, input.browseId);
    this.requireWorkAllowed(task, true);
    const { payload } = await this.runManaged({
      ...this.managedBase(task, input.page),
      operationCode: "egoCallValue = await task.handOff();",
      kind: "managed",
      requiresPage: false,
      handoff: true,
    });
    if (payload.ok === false) throw payloadError(payload);
    this.updateRecord(task, payload);
    // A confirmed handoff is the only transition that delegates ownership. Applying it after
    // the payload update keeps a runtime-reported ownership from overwriting the handoff
    // state. The registry entry keeps the same browseId and Space, so no replacement Task
    // Space is created.
    task.status = "handoff";
    task.ownership = "agentDelegatedToUser";
    await this.writeRegistry(registry);
    return this.outputFor(task, payload, task.pages, [], "handoff");
  }

  private async resumeTask(registry: EgoRegistry, input: BrowseInput): Promise<BrowseOutput> {
    const task = this.requireTask(registry, input.browseId);
    // Resuming a handed-off Space is the whole point of this action, but a task another
    // reaper already claimed must not be steered back into work.
    this.requireWorkAllowed(task, true);
    const { payload } = await this.runManaged({
      ...this.managedBase(task, input.page),
      operationCode: `const userPage = typeof task.userPage === "function" ? task.userPage() : undefined;
egoCallValue = {
    pages: (await task.pages()).map((item) => item.label),
    userPageLabel: userPage ? userPage.label : null,
  };`,
      kind: "managed",
      requiresPage: false,
    });
    if (payload.ok === false) throw payloadError(payload);
    this.updateRecord(task, payload);
    // The take-over above returned control to the agent, and finishAndUpdate completes the
    // resumed round. Clearing handoff status is what makes further Page work legal again.
    task.status = "active";
    const keep = this.requiredKeep(input.page, payload);
    const warnings = await this.finishAndUpdate(registry, task, keep);
    await this.writeRegistry(registry);
    return this.outputFor(task, payload, keep, warnings);
  }

  private async closeTask(registry: EgoRegistry, input: BrowseInput): Promise<BrowseOutput> {
    const task = this.requireTask(registry, input.browseId);
    this.requireWorkAllowed(task, true);
    try {
      const payload = await this.finishTask(task, []);
      delete registry.tasks[task.browseId];
      await this.writeRegistry(registry);
      return { browseId: task.browseId, ...this.spaceIdFields(task), status: "closed", result: payload.value };
    } catch (error) {
      if (!this.isMissingSpace(error)) throw error;
      // The Space already vanished, so the managed registration is stale, not closable.
      delete registry.tasks[task.browseId];
      await this.writeRegistry(registry);
      return { browseId: task.browseId, ...this.spaceIdFields(task), status: "alreadyClosed" };
    }
  }

  private isMissingSpace(error: unknown): boolean {
    return error instanceof FreeWebError && error.code === MISSING_SPACE_CODE;
  }

  /**
   * A runtime that dies during acquisition never reaches the emit helper, so the only trace
   * of a vanished Space is the thrown error on stderr. Treat it like the emitted payload
   * instead of collapsing it into an opaque run failure.
   */
  private reportsMissingSpace(result: EgoRunResult): boolean {
    return [result.stderr, result.stdout].some(
      (stream) => typeof stream === "string" && stream.includes(MISSING_SPACE_CODE),
    );
  }

  private async evaluateLocked(input: BrowseEvaluateInput): Promise<BrowseOutput> {
    const registry = await this.readRegistry();
    const task = this.requireTask(registry, input.browseId);
    this.requireWorkAllowed(task);
    this.requirePage(task, input.page);
    const scriptLiteral = json(input.script);
    const argumentLiteral = input.argument === undefined ? "undefined" : json(input.argument);
    const { payload } = await this.runManaged({
      ...this.managedBase(task, input.page),
      operationCode: `const script = ${scriptLiteral};
const argument = ${argumentLiteral};
const expression = \`(() => {
  const candidate = (\${script}\n);
  return typeof candidate === "function" ? candidate(\${JSON.stringify(argument)}) : candidate;
})()\`;
egoCallValue = await page.evaluate(expression);`,
      kind: "evaluate",
    });
    if (payload.ok === false) {
      return {
        browseId: task.browseId,
        ...this.spaceIdFields(task),
        status: "error",
        result: { ok: false, error: isRecord(payload.error) ? payload.error : { message: String(payload.error ?? "page evaluation failed") } },
      };
    }
    this.updateRecord(task, payload);
    const keep = this.requiredKeep(input.page, payload);
    const warnings = await this.finishAndUpdate(registry, task, keep);
    await this.writeRegistry(registry);
    return this.outputFor(task, payload, keep, warnings);
  }

  private requirePage(task: EgoTaskRecord, requestedPage: string): void {
    const availablePages = [...task.pages];
    if (availablePages.includes(requestedPage)) return;
    const labels = availablePages.length ? availablePages.join(", ") : "none";
    throw new FreeWebError(
      "EGO_PAGE_NOT_FOUND",
      `Page "${requestedPage}" was not found; available Page labels: ${labels}`,
      { provider: PROVIDER, details: { requestedPage, availablePages } },
    );
  }

  private requireWorkAllowed(task: EgoTaskRecord, allowHandoff = false): void {
    // A reaping task is already owned by a shutdown finish. Letting work (or another
    // resume/call) touch it would race the delete that follows that finish.
    if (task.status === "reaping") {
      throw new FreeWebError("EGO_TASK_REAPING", "this managed Space is being reaped and cannot run work", {
        provider: PROVIDER,
        retryable: true,
      });
    }
    if (task.status === "handoff" && !allowHandoff) {
      throw new FreeWebError("EGO_USER_CONTROL_REQUIRED", "resume the handed-off Space after the user confirms", { provider: PROVIDER });
    }
  }

  /**
   * `spaceId` -1 is the by-name placeholder written before the real Space is known. It is a
   * registry detail, not a Space ID, so it must never reach the output schema.
   */
  private spaceIdFields(task: EgoTaskRecord): { spaceId?: number } {
    return task.spaceId >= 0 ? { spaceId: task.spaceId } : {};
  }

  private managedBase(task: EgoTaskRecord, pageLabel: string): Pick<ManagedScriptOptions, "taskId" | "name" | "profileId" | "pageLabel" | "keepCount" | "keptPages" | "pageOrder"> {
    return {
      taskId: task.spaceId,
      name: task.name,
      profileId: task.profileId,
      pageLabel,
      keepCount: task.pages.length,
      keptPages: [...task.pages],
      pageOrder: [...(task.pageOrder ?? [])],
    };
  }

  private requireTask(registry: EgoRegistry, browseId?: string): EgoTaskRecord {
    if (!browseId || !registry.tasks[browseId]) {
      throw new FreeWebError("EGO_TASK_NOT_FOUND", "managed browse task not found", { provider: PROVIDER });
    }
    return registry.tasks[browseId];
  }

  private recordFromPayload(browseId: string, name: string, profileId: string, payload: EgoPayload): EgoTaskRecord {
    const now = this.nowFn();
    const taskInfo = isRecord(payload.task) ? payload.task : {};
    const pageOrder = parsePageOrder(payload.pageOrder);
    return {
      browseId,
      spaceId: typeof taskInfo.spaceId === "number" ? taskInfo.spaceId : -1,
      name,
      profileId,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      status: "active",
      ownership: typeof taskInfo.ownership === "string" ? taskInfo.ownership : "agent",
      pages: Array.isArray(payload.pages) ? payload.pages.filter((page): page is string => typeof page === "string").slice(0, 20) : ["p1"],
      ...(pageOrder ? { pageOrder } : {}),
    };
  }

  private updateRecord(task: EgoTaskRecord, payload: EgoPayload): void {
    const now = this.nowFn();
    const taskInfo = isRecord(payload.task) ? payload.task : {};
    if (typeof taskInfo.spaceId === "number") task.spaceId = taskInfo.spaceId;
    if (typeof taskInfo.ownership === "string") task.ownership = taskInfo.ownership;
    if (Array.isArray(payload.pages)) {
      const pages = payload.pages.filter((page): page is string => typeof page === "string").slice(0, 20);
      if (pages.length) task.pages = pages;
    }
    const pageOrder = parsePageOrder(payload.pageOrder);
    if (pageOrder) task.pageOrder = pageOrder;
    task.updatedAt = now;
    task.lastActiveAt = now;
  }

  private requiredKeep(pageLabel: string, payload: EgoPayload): string[] {
    const pages = Array.isArray(payload.pages)
      ? payload.pages.filter((page): page is string => typeof page === "string")
      : [];
    if (!pages.length) return [];
    const preferred = pages.includes(pageLabel) ? pageLabel : pages[0];
    const keep = [preferred];
    const value = payload.value;
    if (isRecord(value) && isRecord(value.popup) && typeof value.popup.label === "string" && pages.includes(value.popup.label)) {
      keep.push(value.popup.label);
    }
    if (isRecord(value) && typeof value.label === "string" && pages.includes(value.label)) {
      keep.push(value.label);
    }
    return [...new Set(keep)];
  }

  private outputFor(task: EgoTaskRecord, payload: EgoPayload, keep: string[], warnings: string[], status = "ok"): BrowseOutput {
    const value = payload.value;
    // The resource link may only come from the Artifact this provider actually saved for an
    // oversized payload. `value.artifactId` is page-visible result data and can be any
    // string a site chooses, so it is never promoted to a top-level Artifact ID.
    const handoffArtifactId = typeof payload.handoffArtifactId === "string" ? payload.handoffArtifactId : undefined;
    return {
      browseId: task.browseId,
      ...(handoffArtifactId ? { artifactId: handoffArtifactId } : {}),
      ...this.spaceIdFields(task),
      status,
      ...(value === undefined ? {} : { result: value }),
      pages: keep,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  private async finishAndUpdate(registry: EgoRegistry, task: EgoTaskRecord, keep: string[]): Promise<string[]> {
    try {
      const payload = await this.finishTask(task, keep);
      this.updateRecord(task, payload);
      task.status = "active";
      await this.writeRegistry(registry);
      return [];
    } catch (error) {
      return [`finish failed: ${asError(error).message}`];
    }
  }

  private async finishTask(task: EgoTaskRecord, keep: string[], timeoutMs = MANAGED_TIMEOUT_MS): Promise<EgoPayload> {
    const { payload } = await this.runManaged({
      taskId: task.spaceId,
      name: task.name,
      profileId: task.profileId,
      pageLabel: task.pages[0] ?? "p1",
      keepCount: keep.length,
      keptPages: keep,
      pageOrder: [...(task.pageOrder ?? [])],
      operationCode: "",
      kind: "finish",
      timeoutMs,
      buildScript: (marker, artifactPath) => buildFinishScript({ task, keep, marker, artifactPath }),
    });
    if (payload.ok === false) throw payloadError(payload);
    return payload;
  }

  private async runManaged(options: Omit<ManagedScriptOptions, "marker" | "artifactPath"> & {
    kind: "managed" | "evaluate" | "finish";
    timeoutMs?: number;
    buildScript?: (marker: string, artifactPath: string) => string;
    /** Only the handoff action may reinterpret a recognized terminal hard stop as success. */
    handoff?: boolean;
  }): Promise<{ payload: EgoPayload }> {
    const marker = this.uuidFn();
    const artifactPath = join(this.dataDir, MANAGED_RESULT_DIR, `${this.uuidFn()}.json`);
    const script = options.buildScript
      ? options.buildScript(marker, artifactPath)
      : buildManagedScript({ ...options, marker, artifactPath });
    const invocation = await this.invoke(script, options.timeoutMs ?? MANAGED_TIMEOUT_MS, options.kind, marker);
    const payload = options.handoff ? this.requireHandoffPayload(invocation) : this.requirePayload(invocation);
    // Only consumeManagedResult may mint the resource link. Dropping anything the runtime
    // printed here keeps page-controlled data out of the Artifact ID position.
    delete payload.handoffArtifactId;
    await this.consumeManagedResult(payload, artifactPath);
    return { payload };
  }

  /**
   * A payload too large for the runner's bounded stdout is handed over as a file. This method
   * owns the provenance check; ArtifactOutput owns the storage mechanics and the summary
   * rewrite, and its save failures become EGO_ARTIFACT_FAILED here.
   */
  private async consumeManagedResult(payload: EgoPayload, expectedPath: string): Promise<void> {
    if (typeof payload.artifactPath !== "string") return;
    const declared = payload.artifactPath;
    const root = resolve(join(this.dataDir, MANAGED_RESULT_DIR));
    const candidate = resolve(declared);
    if (candidate !== resolve(expectedPath) || !isInside(root, candidate)) {
      throw new FreeWebError("EGO_INVALID_RESPONSE", "ego reported an unexpected result file", {
        provider: PROVIDER,
        details: { artifactPath: declared },
      });
    }
    try {
      await this.output.publish({ kind: "managed-handoff", payload, sourcePath: candidate });
    } catch (error) {
      throw new FreeWebError("EGO_ARTIFACT_FAILED", "Cannot store the managed ego result", {
        provider: PROVIDER,
        cause: error,
      });
    }
  }

  private async invoke(script: string, timeoutMs: number, kind: EgoRunRequest["kind"], marker = this.uuidFn()): Promise<Invocation> {
    const request: EgoRunRequest = { script, timeoutMs, marker, kind };
    const result = await this.runner.run(request);
    const payload = extractPayload(request, result);
    return { result, payload };
  }

  private requirePayload(invocation: Invocation): EgoPayload {
    if (invocation.payload) return invocation.payload;
    if (this.reportsMissingSpace(invocation.result)) {
      throw new FreeWebError(MISSING_SPACE_CODE, "managed ego Space is gone", { provider: PROVIDER });
    }
    if (invocation.result.timedOut) {
      throw new FreeWebError("EGO_TIMEOUT", "ego-browser timed out", { provider: PROVIDER });
    }
    if (invocation.result.exitCode !== 0) {
      throw new FreeWebError("EGO_RUN_FAILED", "ego-browser exited unsuccessfully", {
        provider: PROVIDER,
        details: { exitCode: invocation.result.exitCode, signal: invocation.result.signal },
      });
    }
    throw new FreeWebError("EGO_NO_RESULT", "ego-browser produced no result", { provider: PROVIDER });
  }

  /**
   * Handoff-specific payload adapter. ego-lite reports a transferred Space by exiting zero
   * with no marker payload and only the owned user-control hard-stop guidance, so that one
   * recognized shape becomes a synthetic success. Every other missing-payload case still
   * goes through requirePayload and keeps its original error, which also keeps the generic
   * handling for open, status, call, evaluate and finish untouched.
   */
  private requireHandoffPayload(invocation: Invocation): EgoPayload {
    if (invocation.payload) return invocation.payload;
    const result = invocation.result;
    const text = `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`;
    if (
      result.exitCode === 0 &&
      !result.timedOut &&
      text.includes(HANDOFF_HARD_STOP_LINE) &&
      text.includes(HANDOFF_RESUME_HINT)
    ) {
      return { ok: true, value: { handedOff: true } };
    }
    return this.requirePayload(invocation);
  }

  private async assertAllowedPath(ref: { kind: "upload" | "download"; path: string }): Promise<void> {
    if (!isAbsolute(ref.path)) {
      throw new FreeWebError("EGO_PATH_FORBIDDEN", "managed file paths must be absolute", { provider: PROVIDER });
    }
    const root = resolve(join(this.dataDir, ref.kind === "upload" ? "uploads" : "downloads"));
    const candidate = resolve(ref.path);
    if (!isInside(root, candidate)) {
      throw new FreeWebError("EGO_PATH_FORBIDDEN", `managed ${ref.kind} path is outside ${root}`, { provider: PROVIDER });
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const realRoot = await realpath(root);

    // realpath() only resolves existing paths, so downloads that do not exist yet are
    // checked by resolving their nearest existing ancestor: a lexical check alone would
    // let `downloads/link/evil.bin` escape through a symlinked directory or file.
    let probe = candidate;
    const missing: string[] = [];
    for (;;) {
      let realProbe: string | undefined;
      try {
        realProbe = await realpath(probe);
      } catch {
        realProbe = undefined;
      }
      if (realProbe !== undefined) {
        const resolved = missing.length === 0 ? realProbe : resolve(realProbe, ...missing);
        if (!isInside(realRoot, resolved)) {
          throw new FreeWebError("EGO_PATH_FORBIDDEN", `managed ${ref.kind} path escapes ${root}`, { provider: PROVIDER });
        }
        return;
      }
      const parent = dirname(probe);
      if (parent === probe || !isInside(root, parent)) {
        throw new FreeWebError("EGO_PATH_FORBIDDEN", `managed ${ref.kind} path cannot be resolved inside ${root}`, {
          provider: PROVIDER,
        });
      }
      missing.unshift(basename(probe));
      probe = parent;
    }
  }

  /**
   * Exclusive read-modify-write access. A bounded variant must never fall through to the
   * operation: replaying it on a snapshot the lock holder already superseded would lose or
   * resurrect registry entries, so a timed-out acquisition raises instead.
   */
  private async withRegistryLock<T>(operation: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const acquired = await this.acquireRegistryLock(timeoutMs);
    if (!acquired) {
      // Calling the operation here would replay a read-modify-write on a snapshot that the
      // lock holder may already have superseded. Fail loudly instead of writing stale data.
      throw new FreeWebError("EGO_LOCK_TIMEOUT", "ego registry lock is busy", { provider: PROVIDER, retryable: true });
    }
    try {
      return await operation();
    } finally {
      this.releaseRegistryLock();
    }
  }

  /**
   * Best-effort variant for shutdown and background maintenance: if the lock cannot be
   * taken within the budget, the caller skips its registry work entirely. Skipping is safe
   * because both callers retry later (next reap, next provider start); writing a stale
   * snapshot is not.
   */
  private async tryRegistryLock<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
    const acquired = await this.acquireRegistryLock(timeoutMs);
    if (!acquired) return undefined;
    try {
      return await operation();
    } finally {
      this.releaseRegistryLock();
    }
  }

  private async acquireRegistryLock(timeoutMs?: number): Promise<boolean> {
    if (!this.lockBusy) {
      this.lockBusy = true;
      return true;
    }
    if (timeoutMs === undefined) {
      await new Promise<void>((resolve) => this.lockWaiters.push(resolve));
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, timeoutMs);
      this.lockWaiters.push(() => {
        if (done) {
          // The timeout already gave up: keep the hand-off chain moving instead of
          // swallowing the free lock.
          this.releaseRegistryLock();
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private releaseRegistryLock(): void {
    const next = this.lockWaiters.shift();
    if (next) {
      // Hand ownership straight to the queued waiter.
      next();
      return;
    }
    this.lockBusy = false;
  }

  private get registryPath(): string {
    return join(this.dataDir, "browse", "tasks.json");
  }

  /**
   * A crashed writer can leave a `.tasks.*.tmp` behind forever. Only entries old enough to
   * belong to a dead write are removed, so an in-flight write is never disturbed.
   */
  private async pruneRegistryTemps(directory: string, activeTemp?: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    const cutoff = Date.now() - REGISTRY_TEMP_STALE_MS;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.startsWith(".tasks.") || !entry.endsWith(".tmp")) return;
      const path = join(directory, entry);
      if (activeTemp !== undefined && path === activeTemp) return;
      try {
        const info = await stat(path);
        if (info.mtimeMs > cutoff) return;
        await unlink(path);
      } catch {
        // Another writer may prune or finish the same temp first.
      }
    }));
  }

  private async readRegistry(): Promise<EgoRegistry> {
    await this.pruneRegistryTemps(dirname(this.registryPath));
    try {
      const raw = JSON.parse(await readFile(this.registryPath, "utf8")) as unknown;
      if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.tasks)) {
        throw new FreeWebError("EGO_REGISTRY_CORRUPT", "Invalid ego task registry", { provider: PROVIDER });
      }
      const tasks: Record<string, EgoTaskRecord> = {};
      for (const [browseId, value] of Object.entries(raw.tasks)) {
        if (!isRecord(value) || typeof value.spaceId !== "number" || typeof value.createdAt !== "number" || typeof value.lastActiveAt !== "number") {
          throw new FreeWebError("EGO_REGISTRY_CORRUPT", "Invalid ego task registry entry", { provider: PROVIDER });
        }
        const pageOrder = parsePageOrder(value.pageOrder);
        tasks[browseId] = {
          browseId,
          spaceId: value.spaceId,
          name: typeof value.name === "string" ? value.name : browseId,
          profileId: typeof value.profileId === "string" ? value.profileId : DEFAULT_EGO.defaultProfile,
          createdAt: value.createdAt,
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : value.createdAt,
          lastActiveAt: value.lastActiveAt,
          status: value.status === "handoff" ? "handoff" : value.status === "reaping" ? "reaping" : "active",
          ownership: typeof value.ownership === "string" ? value.ownership : "agent",
          pages: Array.isArray(value.pages) ? value.pages.filter((page): page is string => typeof page === "string") : ["p1"],
          ...(pageOrder ? { pageOrder } : {}),
          ...(typeof value.reapToken === "string" ? { reapToken: value.reapToken } : {}),
          ...(value.reapPreviousStatus === "handoff" || value.reapPreviousStatus === "active"
            ? { reapPreviousStatus: value.reapPreviousStatus }
            : {}),
        };
      }
      return { version: 1, tasks };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tasks: {} };
      throw error;
    }
  }

  private async writeRegistry(registry: EgoRegistry, options: { allowClosed?: boolean } = {}): Promise<void> {
    // A call that was already in flight when close() began holds a snapshot shutdown may
    // already have superseded. Writing it back would resurrect finished Spaces, so a closed
    // provider only accepts the writes shutdown itself performs (its own deletes).
    if (this.closed && options.allowClosed !== true) return;
    const directory = dirname(this.registryPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temp = join(directory, `.tasks.${this.uuidFn()}.tmp`);
    // Never prune the temp this write is about to create or an in-flight one.
    await this.pruneRegistryTemps(directory, temp);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temp, this.registryPath);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await chmod(this.registryPath, 0o600);
  }

  private acquireNodeSlot(): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError());
    if (this.nodeActive < this.ego.maxNodeProcesses) {
      this.nodeActive += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => this.nodeWaiters.push({ resolve, reject }));
  }

  private releaseNodeSlot(): void {
    const next = this.nodeWaiters.shift();
    if (next) {
      // Hand the token straight to the queued waiter: `nodeActive` is unchanged
      // because the waiter inherits the released slot instead of counting a new
      // one. Decrementing first and letting the waiter increment on wake would
      // leak the free slot to any caller that acquires in between and exceed
      // maxNodeProcesses.
      next.resolve();
      return;
    }
    this.nodeActive = Math.max(0, this.nodeActive - 1);
  }

  private rejectNodeWaiters(): void {
    // Queued node callers must observe shutdown instead of waking into a closed provider.
    for (const waiter of this.nodeWaiters.splice(0)) waiter.reject(this.closedError());
  }

  private closedError(): FreeWebError {
    return new FreeWebError("EGO_CLOSED", "ego provider is closed", { provider: PROVIDER });
  }
}
