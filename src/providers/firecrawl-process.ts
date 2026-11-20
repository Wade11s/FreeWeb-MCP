import { spawn as nodeSpawn } from "node:child_process";
import { connect, createServer } from "node:net";
import type { AppConfig } from "../config.js";
import { FreeWebError } from "../errors.js";

export type FirecrawlConfig = AppConfig["firecrawl"];

export interface HttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
}

export type HttpSender = (request: HttpRequest) => Promise<HttpResponse>;

export interface ChildStreamLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface ChildProcessLike {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  readonly killed?: boolean;
  readonly stdout?: ChildStreamLike | null;
  readonly stderr?: ChildStreamLike | null;
  on(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnCall {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdio?: Array<"ignore" | "pipe" | "inherit">;
}

export type Spawner = (call: SpawnCall) => ChildProcessLike;

export interface CommandCall {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export type CommandRunner = (call: CommandCall) => Promise<CommandResult>;

export interface ProcessDeps {
  readonly http?: HttpSender;
  readonly spawner?: Spawner;
  readonly commandRunner?: CommandRunner;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly reservePort?: (host: string) => Promise<number>;
  readonly probePort?: (host: string, port: number) => Promise<boolean>;
  readonly now?: () => number;
}

export interface FirecrawlRuntime {
  readonly baseUrl: string;
  isAlive(): boolean;
  /** Registers a one-shot notification for serve exit/close or an intentional shutdown. */
  onDead(listener: () => void): void;
  request(path: string, init: {
    method: "GET" | "POST" | "DELETE";
    body?: string;
    timeoutMs?: number;
  }): Promise<unknown>;
  close(): Promise<void>;
}

const LOCAL_PROVIDER = "firecrawl-local";
const START_ABORTED = "FIRECRAWL_START_ABORTED";

export const MAX_STARTUP_LOG_CHARS = 500;
export const MAX_COMMAND_STDOUT_CHARS = 256_000;
export const MAX_COMMAND_STDERR_CHARS = 8_000;
export const COMMAND_KILL_GRACE_MS = 500;
const COMMAND_HARD_DEADLINE_MARGIN_MS = 250;
const FAILURE_BODY_CHARS = 200;

const CHILD_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TZ", "LANG", "LANGUAGE",
  "TMPDIR", "TMP", "TEMP", "TMPPATH",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC", "USERPROFILE", "USERNAME", "USERDOMAIN",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
  "FIRECRAWL_LOCAL_BROWSER",
];
const CHILD_ENV_PREFIXES = ["LC_", "XDG_"];
const SECRET_ENV = /(API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|AUTH)/i;

/**
 * Builds the environment for a provider child process: only known-benign variables are
 * forwarded, so provider API keys and other agent secrets never reach the child.
 */
export function childProcessEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!CHILD_ENV_KEYS.includes(key) && !CHILD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function collectSecretValues(env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 6) continue;
    if (SECRET_ENV.test(key)) secrets.push(value);
  }
  return secrets;
}

function redactLogs(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join("[redacted]");
  return result.replace(
    /\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi,
    "$1=[redacted]",
  );
}

class BoundedText {
  private parts: string[] = [];
  private size = 0;

  constructor(private readonly limit: number, private readonly keep: "head" | "tail" = "tail") {}

  append(chunk: string): void {
    if (!chunk) return;
    if (this.keep === "head") {
      const remaining = this.limit - this.size;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      this.parts.push(slice);
      this.size += slice.length;
      return;
    }
    this.parts.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.parts.length > 0) {
      const overflow = this.size - this.limit;
      const first = this.parts[0]!;
      if (first.length <= overflow) {
        this.parts.shift();
        this.size -= first.length;
      } else {
        this.parts[0] = first.slice(overflow);
        this.size -= overflow;
      }
    }
  }

  text(): string {
    return this.parts.join("");
  }
}

interface ChildLogCapture {
  summary(): string;
}

/**
 * Drains both serve pipes so a chatty child can never block on a full pipe, keeping only
 * a bounded tail of output for startup diagnostics.
 */
function captureChildLogs(child: ChildProcessLike, secrets: readonly string[]): ChildLogCapture {
  const stdout = new BoundedText(MAX_STARTUP_LOG_CHARS, "tail");
  const stderr = new BoundedText(MAX_STARTUP_LOG_CHARS, "tail");
  const attach = (stream: ChildStreamLike | null | undefined, sink: BoundedText): void => {
    stream?.on("data", (chunk) => sink.append(typeof chunk === "string" ? chunk : chunk.toString()));
  };
  attach(child.stdout, stdout);
  attach(child.stderr, stderr);
  return {
    summary(): string {
      const joined = [stderr.text().trim(), stdout.text().trim()].filter(Boolean).join(" | ");
      return redactLogs(joined.replace(/\s+/g, " ").trim(), secrets);
    },
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return true;
  if (
    candidate.code === "ABORT_ERR" || candidate.code === "ETIMEDOUT" ||
    candidate.code === "UND_ERR_CONNECT_TIMEOUT" || candidate.code === "UND_ERR_HEADERS_TIMEOUT" ||
    candidate.code === "UND_ERR_BODY_TIMEOUT"
  ) return true;
  return candidate.cause !== undefined && candidate.cause !== error && isTimeoutError(candidate.cause);
}

export const nodeHttpSender: HttpSender = async (request) => {
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { "content-type": "application/json", ...request.headers },
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new FreeWebError(
        "UPSTREAM_TIMEOUT_UNCERTAIN",
        `Firecrawl Local request to ${request.url} timed out; its outcome is unknown`,
        { provider: LOCAL_PROVIDER, retryable: false, details: { timeoutMs: request.timeoutMs }, cause: error },
      );
    }
    throw new FreeWebError("FIRECRAWL_HTTP_FAILED", `Cannot reach ${request.url}`, {
      provider: LOCAL_PROVIDER,
      retryable: true,
      cause: error,
    });
  }
};

async function reserveEphemeralPort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new FreeWebError("PORT_ALLOCATION_FAILED", `Cannot allocate a local port on ${host}`, {
      provider: LOCAL_PROVIDER,
      cause: error,
    })));
    server.listen(0, host, () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(new FreeWebError("PORT_ALLOCATION_FAILED", `Cannot release the local port on ${host}`, {
            provider: LOCAL_PROVIDER,
            cause: error,
          }));
          return;
        }
        if (!address || typeof address === "string" || address.port <= 0) {
          reject(new FreeWebError("PORT_ALLOCATION_FAILED", `No local port was allocated on ${host}`, { provider: LOCAL_PROVIDER }));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function defaultProbePort(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function statusCode(status: number): string {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 405) return "METHOD_NOT_ALLOWED";
  if (status === 408) return "UPSTREAM_TIMEOUT_UNCERTAIN";
  if (status === 415) return "UNSUPPORTED_MEDIA_TYPE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 501) return "CLOUD_ONLY";
  if (status >= 500) return "FIRECRAWL_SERVER_ERROR";
  return `HTTP_${status}`;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseBody(body: string): unknown {
  if (!body.trim()) return undefined;
  try { return JSON.parse(body) as unknown; }
  catch (error) {
    throw new FreeWebError("INVALID_RESPONSE", "Firecrawl Local returned invalid JSON", {
      provider: LOCAL_PROVIDER,
      cause: error,
    });
  }
}

function tryParseBody(body: string): { ok: true; value: unknown } | { ok: false } {
  if (!body.trim()) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(body) as unknown }; }
  catch { return { ok: false }; }
}

function truncateBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > FAILURE_BODY_CHARS ? `${collapsed.slice(0, FAILURE_BODY_CHARS)}…` : collapsed;
}

function localFailure(payload: Record<string, unknown>, status: number): FreeWebError {
  const code = typeof payload.code === "string" && payload.code ? payload.code : statusCode(status);
  const message = typeof payload.error === "string" && payload.error
    ? payload.error
    : typeof payload.message === "string" && payload.message
      ? payload.message
      : `Firecrawl Local returned HTTP ${status}`;
  return new FreeWebError(code, message, {
    provider: LOCAL_PROVIDER,
    retryable: retryableStatus(status),
    details: { status },
  });
}

/**
 * Classifies a non-2xx response before any JSON parsing so HTML error pages keep their
 * status, retryability and a bounded body instead of collapsing into INVALID_RESPONSE.
 */
function responseFailure(status: number, body: string): FreeWebError {
  const parsed = tryParseBody(body);
  if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
    return localFailure(parsed.value as Record<string, unknown>, status);
  }
  const snippet = truncateBody(body);
  const message = snippet
    ? `Firecrawl Local returned HTTP ${status}: ${snippet}`
    : `Firecrawl Local returned HTTP ${status}`;
  return new FreeWebError(statusCode(status), message, {
    provider: LOCAL_PROVIDER,
    retryable: retryableStatus(status),
    details: { status, ...(snippet ? { body: snippet } : {}) },
  });
}

function isHealthy(body: string): boolean {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    return value?.status === "ok" && value?.engine === "firecrawl-local" && typeof value?.version === "string";
  } catch {
    return false;
  }
}

function startAbortedError(): FreeWebError {
  return new FreeWebError(START_ABORTED, "Firecrawl Local startup was cancelled", {
    provider: LOCAL_PROVIDER,
    retryable: false,
  });
}

/**
 * Rejects as soon as the signal aborts so a startup can never outlive the close()
 * that cancelled it. The returned promise is pre-handled: a watch that outlives a
 * successful start must not surface a late abort as an unhandled rejection.
 */
function watchAbort(signal?: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  if (!signal) return { promise: new Promise<never>(() => {}), dispose: () => {} };
  let dispose = (): void => {};
  const promise = new Promise<never>((_, reject) => {
    const cancel = (): void => { reject(startAbortedError()); };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    dispose = () => signal.removeEventListener("abort", cancel);
  });
  void promise.catch(() => {});
  return { promise, dispose };
}

async function stopChild(
  child: ChildProcessLike,
  isDead: () => boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  if (isDead()) return;
  child.kill("SIGTERM");
  const deadline = now() + timeoutMs;
  while (!isDead() && now() < deadline) {
    await sleep(Math.max(1, Math.min(25, deadline - now())));
  }
  if (!isDead()) {
    child.kill("SIGKILL");
    await sleep(0);
  }
}

class Runtime implements FirecrawlRuntime {
  private readonly deadListeners = new Set<() => void>();

  constructor(
    readonly baseUrl: string,
    private readonly http: HttpSender,
    private readonly shutdown: () => Promise<void>,
    private readonly alive: () => boolean,
  ) {}

  isAlive(): boolean {
    return this.alive();
  }

  onDead(listener: () => void): void {
    if (!this.alive()) {
      listener();
      return;
    }
    this.deadListeners.add(listener);
  }

  notifyDead(): void {
    for (const listener of [...this.deadListeners]) {
      this.deadListeners.delete(listener);
      try {
        listener();
      } catch {
        // A death listener must never break shutdown or another listener.
      }
    }
  }

  async request(path: string, init: { method: "GET" | "POST" | "DELETE"; body?: string; timeoutMs?: number }): Promise<unknown> {
    if (!this.alive()) {
      throw new FreeWebError(
        "FIRECRAWL_PROCESS_DEAD",
        "Firecrawl Local serve process is no longer running",
        { provider: LOCAL_PROVIDER, retryable: false },
      );
    }
    const response = await this.http({
      method: init.method,
      url: `${this.baseUrl}${path}`,
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      body: init.body,
      timeoutMs: init.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw responseFailure(response.status, response.body);
    }
    const payload = parseBody(response.body);
    if (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).success === false) {
      throw localFailure(payload as Record<string, unknown>, response.status);
    }
    return payload;
  }

  close(): Promise<void> {
    return this.shutdown();
  }
}

export async function startFirecrawlRuntime(
  config: FirecrawlConfig,
  deps: ProcessDeps = {},
  /** Cancels a startup in flight so close() never waits out the health deadline. */
  signal?: AbortSignal,
): Promise<FirecrawlRuntime> {
  if (signal?.aborted) throw startAbortedError();
  const host = config.host;
  const port = config.port === 0
    ? await (deps.reservePort ?? reserveEphemeralPort)(host)
    : config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FreeWebError("INVALID_CONFIG", `Invalid Firecrawl Local port ${port}`, { provider: LOCAL_PROVIDER });
  }
  if (await (deps.probePort ?? defaultProbePort)(host, port)) {
    throw new FreeWebError("PORT_IN_USE", `Port ${port} on ${host} is already in use`, {
      provider: LOCAL_PROVIDER,
    });
  }
  const baseUrl = `http://${host}:${port}`;
  const env = childProcessEnv({
    FIRECRAWL_CLOUD: "off",
    // firecrawl-local binds this variable to a clap bool flag, so it accepts
    // only the words true/false; "1"/"0" make serve exit with a usage error.
    FIRECRAWL_LOCAL_ALLOW_PRIVATE: config.allowPrivate ? "true" : "false",
  });
  const secrets = collectSecretValues(process.env);
  const args = ["serve", "--host", host, "--port", String(port)];
  if (config.allowPrivate) args.push("--allow-private");
  const call: SpawnCall = {
    command: config.binary,
    args,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  };

  // Never spend a serve process for a startup that was already cancelled.
  if (signal?.aborted) throw startAbortedError();

  let child: ChildProcessLike;
  try {
    child = deps.spawner ? deps.spawner(call) : nodeSpawn(call.command, call.args, {
      env: call.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new FreeWebError("FIRECRAWL_START_FAILED", `Cannot start ${config.binary}`, {
      provider: LOCAL_PROVIDER,
      retryable: true,
      cause: error,
    });
  }

  const logs = captureChildLogs(child, secrets);
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let spawnError: Error | undefined;
  let dead = false;
  let closed = false;
  const processDead = () => dead || child.exitCode !== null || child.signalCode !== null;

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      await stopChild(child, processDead, config.shutdownTimeoutMs, sleep, now);
      closed = true;
      runtime.notifyDead();
    })();
    return closing;
  };
  const http = deps.http ?? nodeHttpSender;
  const runtime = new Runtime(baseUrl, http, shutdown, () => !closed && !processDead());

  // A resolved Runtime must stop pretending to be usable as soon as its child exits;
  // the provider clears its cached promise through onDead and respawns on demand.
  child.on("error", (error: unknown) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
    dead = true;
    runtime.notifyDead();
  });
  child.on("exit", () => { dead = true; runtime.notifyDead(); });
  child.on("close", () => { dead = true; runtime.notifyDead(); });

  const deadline = now() + config.startupTimeoutMs;
  const watch = watchAbort(signal);
  let ready = false;
  let aborted = false;

  const probe = async (): Promise<boolean> => {
    try {
      const response = await http({
        method: "GET",
        url: `${baseUrl}/health`,
        timeoutMs: Math.max(1, Math.min(2000, deadline - now())),
      });
      return response.status === 200 && isHealthy(response.body) && !spawnError && !processDead();
    } catch {
      // The server may not be listening yet. Keep polling until the deadline.
      return false;
    }
  };

  try {
    while (now() < deadline) {
      if (signal?.aborted) throw startAbortedError();
      if (spawnError || processDead()) break;
      // Racing the health request keeps close() from waiting on a socket that a
      // hung serve may never answer.
      if (await Promise.race([probe(), watch.promise])) {
        ready = true;
        break;
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(100, remaining));
    }
  } catch (error) {
    if (!(error instanceof FreeWebError) || error.code !== START_ABORTED) {
      await shutdown();
      throw error;
    }
    aborted = true;
  } finally {
    watch.dispose();
  }

  if (aborted || signal?.aborted) {
    await shutdown();
    throw startAbortedError();
  }

  if (!ready) {
    await shutdown();
    const detail = spawnError?.message ?? (processDead() ? `process exited with ${child.exitCode ?? child.signalCode}` : "health check timed out");
    const tail = logs.summary();
    throw new FreeWebError(
      "FIRECRAWL_START_FAILED",
      `Cannot start Firecrawl Local: ${redactLogs(detail, secrets)}${tail ? ` (${tail})` : ""}`,
      { provider: LOCAL_PROVIDER, retryable: true, cause: spawnError },
    );
  }

  return runtime;
}

/**
 * Runs a provider CLI with bounded output and a bounded lifetime: SIGTERM at the timeout,
 * SIGKILL after the grace period, and an independent hard deadline that settles the promise
 * even if the child never emits close. Timers are cleared on settle so no handle is left.
 */
export const nodeCommandRunner: CommandRunner = async (call) => {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = nodeSpawn(call.command, call.args, { env: call.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = new BoundedText(MAX_COMMAND_STDOUT_CHARS, "head");
    const stderr = new BoundedText(MAX_COMMAND_STDERR_CHARS, "tail");
    let timedOut = false;
    let settled = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk.toString()));
    child.once("error", fail);
    child.once("close", (code, signal) => finish({
      exitCode: code,
      signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut,
    }));

    if (call.timeoutMs !== undefined) {
      termTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null || child.exitCode === undefined) child.kill("SIGKILL");
        }, COMMAND_KILL_GRACE_MS);
      }, call.timeoutMs);
      hardTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        finish({
          exitCode: child.exitCode ?? null,
          signal: "SIGKILL",
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut: true,
        });
      }, call.timeoutMs + COMMAND_KILL_GRACE_MS + COMMAND_HARD_DEADLINE_MARGIN_MS);
    }
  });
};
