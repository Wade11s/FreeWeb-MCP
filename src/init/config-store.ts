import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access as fsAccess,
  chmod as fsChmod,
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile as fsReadFile,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { configFileSchema, type ConfigFile } from "../config.js";
import { FreeWebError } from "../errors.js";
import type { InitWarning } from "./outcomes.js";

/**
 * Read-classification of the configuration file. A malformed or
 * schema-invalid file is never treated as absent; it requires an explicit
 * backup-and-rebuild decision before any installation or write.
 */
export type ConfigClassification =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly raw: Record<string, unknown> }
  | { readonly status: "malformed"; readonly message: string }
  | { readonly status: "schema-invalid"; readonly issues: readonly string[] };

/** The subset of file operations Initialization needs, injectable for tests. */
export interface InitFileHandle {
  write(data: string): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface InitFilesystem {
  mkdir(path: string, options: { recursive: boolean; mode?: number }): Promise<string | undefined>;
  open(path: string, flag: string, mode: number): Promise<InitFileHandle>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  copyFile(from: string, to: string, mode?: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  access(path: string, mode?: number): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean }>;
}

export const nodeInitFilesystem: InitFilesystem = {
  mkdir: (path, options) => fsMkdir(path, options),
  open: (path, flag, mode) => fsOpen(path, flag, mode),
  readFile: (path) => fsReadFile(path, "utf8"),
  rename: (from, to) => fsRename(from, to),
  unlink: (path) => fsUnlink(path),
  copyFile: (from, to, mode) => fsCopyFile(from, to, mode),
  chmod: (path, mode) => fsChmod(path, mode),
  access: (path, mode) => fsAccess(path, mode),
  stat: (path) => fsStat(path),
};

const SECTIONS = ["tinyfish", "firecrawl", "ego", "limits", "artifacts"] as const;
const MAX_BACKUP_ATTEMPTS = 100;

/** Full conservative schema defaults, exactly what an absent file would get. */
export function defaultConfigFile(): ConfigFile {
  return configFileSchema.parse({});
}

/**
 * New configuration with conservative schema defaults (no private-network
 * access, no Search Fallback, no Unrestricted Browse). Components contribute
 * provider settings separately through the generic init patch contract.
 */
export function newConfigFile(): ConfigFile {
  return defaultConfigFile();
}

export interface CompletedConfig {
  readonly merged: ConfigFile;
  /** Dotted paths of safe defaults that were missing from the explicit file. */
  readonly added: readonly string[];
}

/**
 * Completes an existing valid file: every explicit value is preserved and
 * only missing safe defaults are added. High-risk settings are never changed
 * here; callers surface them as warnings.
 */
export function completeExistingConfig(raw: Record<string, unknown>): CompletedConfig {
  const defaults = defaultConfigFile();
  const merged: Record<string, unknown> = {};
  const added: string[] = [];
  for (const section of SECTIONS) {
    const sectionDefaults = (defaults as Record<string, unknown>)[section] as Record<string, unknown>;
    const explicit = isRecord(raw[section]) ? (raw[section] as Record<string, unknown>) : undefined;
    merged[section] = { ...sectionDefaults, ...(explicit ?? {}) };
    for (const field of Object.keys(sectionDefaults)) {
      if (!explicit || !(field in explicit)) added.push(`${section}.${field}`);
    }
  }
  if (typeof raw.dataDir === "string") merged.dataDir = raw.dataDir;
  return { merged: configFileSchema.parse(merged), added };
}

const HIGH_RISK_SETTINGS: ReadonlyArray<{ readonly path: string; readonly risk: string }> = [
  { path: "tinyfish.freeOnlyConfirmed", risk: "TinyFish stays enabled by your explicit free-only attestation" },
  { path: "firecrawl.allowPrivate", risk: "Firecrawl private-network access stays enabled as you configured it" },
  { path: "firecrawl.searchFallback", risk: "keyless Firecrawl Search fallback stays enabled as you configured it" },
  { path: "ego.allowPrivate", risk: "ego private-network access stays enabled as you configured it" },
  { path: "ego.unrestricted", risk: "unrestricted browse_node execution stays enabled as you configured it" },
];

/** Warns about explicit high-risk values; never proposes changing them. */
export function highRiskSettingWarnings(raw: Record<string, unknown>): InitWarning[] {
  const warnings: InitWarning[] = [];
  for (const setting of HIGH_RISK_SETTINGS) {
    if (getPath(raw, setting.path) === true) {
      warnings.push({
        code: "HighRiskSetting",
        message: `${setting.path}=true is preserved unchanged: ${setting.risk}`,
      });
    }
  }
  return warnings;
}

/** Returns the value at a dotted path, or undefined. */
function getPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Returns a copy of `value` with the dotted `path` set to `replacement`. */
export function setPath<T extends Record<string, unknown>>(value: T, path: string, replacement: unknown): T {
  const keys = path.split(".");
  const clone: Record<string, unknown> = { ...value };
  let cursor: Record<string, unknown> = clone;
  for (const key of keys.slice(0, -1)) {
    const nested = cursor[key];
    if (!isRecord(nested)) {
      throw new FreeWebError("INIT_REPAIR_FAILED", `Cannot set ${path}: ${key} is not a configuration section`);
    }
    const nestedClone = { ...nested };
    cursor[key] = nestedClone;
    cursor = nestedClone;
  }
  cursor[keys[keys.length - 1]!] = replacement;
  return clone as T;
}

/**
 * The only place Initialization writes configuration: read-classification,
 * non-overwriting backup, and the atomic write (same-directory temp file
 * with mode 0600, then rename, with directories created 0700 where
 * supported). An interrupted write can never leave partially written JSON
 * at the target path.
 */
export class ConfigStore {
  constructor(private readonly fs: InitFilesystem = nodeInitFilesystem) {}

  async classify(path: string): Promise<ConfigClassification> {
    let text: string;
    try {
      text = await this.fs.readFile(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) return { status: "absent" };
      return { status: "malformed", message: `cannot read ${path}: ${errorMessage(error)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Parser diagnostics differ by Node release and may include source
      // excerpts. Keep damaged-file contents, including keys, out of output.
      return { status: "malformed", message: "not valid JSON" };
    }
    const result = configFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      return { status: "schema-invalid", issues };
    }
    return { status: "ok", raw: parsed as Record<string, unknown> };
  }

  /** First backup name that does not exist yet, for honest plan display. */
  async proposedBackupPath(path: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt += 1) {
      const candidate = backupName(path, attempt);
      if (!(await exists(this.fs, candidate))) return candidate;
    }
    throw new FreeWebError("INIT_BACKUP_FAILED", `Cannot find a free backup name for ${path}`);
  }

  /** Copies the file to the first free backup name; existing backups are never clobbered. */
  async backup(path: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt += 1) {
      const candidate = backupName(path, attempt);
      try {
        await this.fs.copyFile(path, candidate, fsConstants.COPYFILE_EXCL);
        await this.fs.chmod(candidate, 0o600);
        return candidate;
      } catch (error) {
        if (!isCode(error, "EEXIST")) {
          throw new FreeWebError("INIT_BACKUP_FAILED", `Cannot back up ${path}`, { cause: error });
        }
      }
    }
    throw new FreeWebError("INIT_BACKUP_FAILED", `Cannot find a free backup name for ${path}`);
  }

  /** Re-asserts private modes without rewriting an already-complete file. */
  async enforcePermissions(path: string): Promise<void> {
    await this.fs.chmod(dirname(path), 0o700);
    await this.fs.chmod(path, 0o600);
  }

  /**
   * Atomic configuration write. The target path only ever holds the complete
   * JSON from before or after the write; a failure at any point removes the
   * temporary file and leaves the original untouched.
   */
  async write(path: string, value: unknown): Promise<void> {
    // Validate the fully patched object before even creating a directory.
    // Strict schema fields prevent credential/unknown-key persistence.
    const parsed = configFileSchema.parse(value);
    const directory = dirname(path);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.fs.chmod(directory, 0o700);
    const temp = join(directory, `.${basename(path)}.tmp-${randomUUID()}`);
    const data = `${JSON.stringify(parsed, null, 2)}\n`;
    try {
      const handle = await this.fs.open(temp, "wx", 0o600);
      try {
        await handle.write(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(temp, path);
    } catch (error) {
      await this.fs.unlink(temp).catch(() => undefined);
      throw new FreeWebError("INIT_WRITE_FAILED", `Cannot write ${path}`, { cause: error });
    }
  }
}

function backupName(path: string, attempt: number): string {
  const directory = dirname(path);
  const base = basename(path).replace(/\.json$/, "");
  return attempt === 0
    ? join(directory, `${base}.backup.json`)
    : join(directory, `${base}.backup.${attempt}.json`);
}

async function exists(fs: InitFilesystem, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
