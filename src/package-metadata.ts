import { readFile } from "node:fs/promises";

/** A parsed semantic version: major, minor, and patch, with any suffix dropped. */
export type Version = readonly [major: number, minor: number, patch: number];

/** A parsed version string: its numeric triple plus whether it is a prerelease. */
export interface ParsedVersion {
  readonly version: Version;
  /** True for a `-prerelease` suffix; `+build` metadata is not a prerelease. */
  readonly prerelease: boolean;
}

/**
 * The package's own declared identity. package.json is the single source of
 * truth: the CLI version and the Node.js runtime floor are read from it
 * rather than duplicated as constants in the code.
 */
export interface PackageMetadata {
  readonly version: string;
  /** Minimum Node.js runtime, parsed from the package's `engines.node` range. */
  readonly minimumNodeVersion: Version;
}

/** The only `engines.node` shape the package uses: a plain `>=x.y.z` floor. */
const MINIMUM_NODE_RANGE = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses `22.12.0`, `v22.12.0-nightly`, or `22.12.0+build.1` into a comparable version. */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION.exec(value.trim());
  if (!match) return undefined;
  return {
    version: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/** Negative when `a` precedes `b`, zero when they are equal, positive when `a` follows `b`. */
export function compareVersions(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * True when `actual` is a parseable release version at or above `minimum`.
 * The floor is release-only, matching npm's node-semver for `>=x.y.z` with
 * `includePrerelease` off: a prerelease such as `22.12.0-rc.1` never
 * satisfies it, while build metadata such as `22.12.0+build.1` is ignored
 * and compares equal to the bare triple.
 */
export function isAtLeast(actual: string, minimum: Version): boolean {
  const parsed = parseVersion(actual);
  return parsed !== undefined && !parsed.prerelease && compareVersions(parsed.version, minimum) >= 0;
}

/** Renders a version the way package.json writes it, e.g. `22.12.0`. */
export function formatVersion(version: Version): string {
  return version.join(".");
}

/**
 * Reads package.json relative to this module, so it resolves the same from
 * `src/` (tests) and `dist/` (the installed CLI). A package without a
 * version or without a `>=x.y.z` engines.node floor is a broken package, not
 * a runtime state the CLI can report its way out of, so it throws the
 * caller's controlled startup diagnostic.
 */
export async function readPackageMetadata(): Promise<PackageMetadata> {
  const parsed = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
    engines?: { node?: unknown };
  };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json does not declare a version");
  }
  const range = parsed.engines?.node;
  const match = typeof range === "string" ? MINIMUM_NODE_RANGE.exec(range.trim()) : null;
  if (!match) {
    throw new Error(`package.json engines.node must declare a ">=x.y.z" runtime floor, found ${JSON.stringify(range)}`);
  }
  return {
    version: parsed.version,
    minimumNodeVersion: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}
