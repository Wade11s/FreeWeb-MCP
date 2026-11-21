import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { FreeWebError } from "./errors.js";
import { isTrustedDnsServer } from "./security/url.js";

const bool = z.boolean();
const trustedDnsServer = z.string().refine(isTrustedDnsServer, {
  message: "Trusted DNS servers must be public IPv4/IPv6 literals or HTTPS DoH endpoints with public IP-literal hosts and no credentials, query, or fragment",
});
export const configFileSchema = z.object({
  dataDir: z.string().min(1).optional(),
  network: z.object({
    trustedDnsServers: z.array(trustedDnsServer).default([]),
  }).strict().prefault({}),
  tinyfish: z.object({
    freeOnlyConfirmed: bool.default(false),
    searchTimeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
    fetchTimeoutMs: z.number().int().min(1000).max(180_000).default(150_000),
  }).strict().prefault({}),
  firecrawl: z.object({
    binary: z.string().min(1).default("firecrawl-local"),
    host: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(0),
    allowPrivate: bool.default(false),
    searchFallback: bool.default(false),
    startupTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    shutdownTimeoutMs: z.number().int().min(100).max(30_000).default(5000),
  }).strict().prefault({}),
  ego: z.object({
    binary: z.string().min(1).default("ego-browser"),
    unrestricted: bool.default(false),
    defaultProfile: z.string().min(1).max(100).default("Default"),
    allowedProfiles: z.array(z.string().min(1).max(100)).min(1).max(20).default(["Default"]),
    allowPrivate: bool.default(false),
    taskIdleTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(900_000),
    taskMaxAgeMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
    maxTasks: z.number().int().min(1).max(10).default(3),
    maxNodeProcesses: z.number().int().min(1).max(8).default(2),
  }).strict().prefault({}),
  limits: z.object({
    firecrawlConcurrency: z.number().int().min(1).max(32).default(4),
    maxCrawlJobs: z.number().int().min(1).max(10).default(3),
    tinyfishSearchConcurrency: z.number().int().min(1).max(20).default(5),
    tinyfishSearchPerMinute: z.number().int().min(1).max(30).default(25),
    tinyfishFetchConcurrency: z.number().int().min(1).max(10).default(3),
    tinyfishFetchUrlsPerMinute: z.number().int().min(1).max(150).default(100),
  }).strict().prefault({}),
  artifacts: z.object({
    retentionMs: z.number().int().min(60_000).max(604_800_000).default(86_400_000),
    inlineFetchPageChars: z.number().int().min(100).max(1_000_000).default(50_000),
    inlineFetchTotalChars: z.number().int().min(1000).max(5_000_000).default(100_000),
    inlineNodeChars: z.number().int().min(1000).max(20_000_000).default(1_000_000),
    screenshotMaxBytes: z.number().int().min(1024).max(50_000_000).default(5_000_000),
  }).strict().prefault({}),
}).strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
export type AppConfig = Omit<ConfigFile, "dataDir"> & {
  dataDir: string;
  tinyfish: ConfigFile["tinyfish"] & { apiKey?: string };
};

export type ConfigEnv = NodeJS.ProcessEnv;

function envBool(env: ConfigEnv, key: string): boolean | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new FreeWebError("INVALID_CONFIG", `${key} must be true or false`);
}

function envInt(env: ConfigEnv, key: string): number | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new FreeWebError("INVALID_CONFIG", `${key} must be an integer`);
  return Number(value);
}

function envTrustedDnsServers(env: ConfigEnv): string[] | undefined {
  const value = env.FREEWEB_TRUSTED_DNS_SERVERS;
  if (value === undefined) return undefined;
  if (value.trim() === "") return [];
  return value.split(",").map((server) => server.trim());
}

export function defaultConfigPath(env: ConfigEnv = process.env): string {
  if (env.FREEWEB_CONFIG) return env.FREEWEB_CONFIG;
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "FreeWeb-MCP", "config.json");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "freeweb-mcp", "config.json");
}

export async function loadConfig(options: { env?: ConfigEnv; configPath?: string } = {}): Promise<AppConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultConfigPath(env);
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new FreeWebError("INVALID_CONFIG", `Cannot read ${configPath}`, { cause: error });
    }
  }
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) throw new FreeWebError("INVALID_CONFIG", "Invalid FreeWeb-MCP configuration", { details: { issues: parsed.error.issues } });
  const file = parsed.data;
  const config: AppConfig = {
    ...file,
    dataDir: env.FREEWEB_DATA_DIR ?? file.dataDir ?? join(homedir(), ".freeweb-mcp"),
    network: {
      trustedDnsServers: envTrustedDnsServers(env) ?? file.network.trustedDnsServers,
    },
    tinyfish: {
      ...file.tinyfish,
      freeOnlyConfirmed: envBool(env, "FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED") ?? file.tinyfish.freeOnlyConfirmed,
      apiKey: env.TINYFISH_API_KEY,
    },
    firecrawl: {
      ...file.firecrawl,
      binary: env.FIRECRAWL_LOCAL_BIN ?? file.firecrawl.binary,
      port: envInt(env, "FIRECRAWL_PORT") ?? file.firecrawl.port,
      allowPrivate: envBool(env, "FREEWEB_FIRECRAWL_ALLOW_PRIVATE") ?? file.firecrawl.allowPrivate,
      searchFallback: envBool(env, "FREEWEB_FIRECRAWL_SEARCH_FALLBACK") ?? file.firecrawl.searchFallback,
    },
    ego: {
      ...file.ego,
      binary: env.EGO_BROWSER_BIN ?? file.ego.binary,
      unrestricted: envBool(env, "FREEWEB_EGO_UNRESTRICTED") ?? file.ego.unrestricted,
      allowPrivate: envBool(env, "FREEWEB_EGO_ALLOW_PRIVATE") ?? file.ego.allowPrivate,
    },
  };
  const { apiKey, ...tinyfishFile } = config.tinyfish;
  const parsedConfig = configFileSchema.safeParse({ ...config, tinyfish: tinyfishFile });
  if (!parsedConfig.success) {
    throw new FreeWebError("INVALID_CONFIG", "Invalid configuration after applying environment overrides", {
      details: { issues: parsedConfig.error.issues },
    });
  }
  const checked = parsedConfig.data;
  const validated: AppConfig = {
    ...checked,
    dataDir: checked.dataDir!,
    tinyfish: { ...checked.tinyfish, apiKey },
  };
  if (!validated.ego.allowedProfiles.includes(validated.ego.defaultProfile)) {
    throw new FreeWebError("INVALID_CONFIG", "ego.defaultProfile must be in ego.allowedProfiles");
  }
  return validated;
}

export function redactedConfig(config: AppConfig) {
  return { ...config, tinyfish: { ...config.tinyfish, apiKey: config.tinyfish.apiKey ? "[redacted]" : undefined } };
}
