import { lookup, Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { FreeWebError } from "../errors.js";

/**
 * Address space that must never be reachable through a "public" URL.
 * Matching is delegated to net.BlockList so IPv4/IPv6 parsing and prefix
 * arithmetic stay in Node's hands instead of hand-rolled regexes.
 */
const BLOCKED = new BlockList();
const FAKE_IP = new BlockList();
FAKE_IP.addSubnet("198.18.0.0", 15, "ipv4");

const IPV4_BLOCKED: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // RFC 6598 carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast
];

const IPV6_BLOCKED: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // well-known NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["2002::", 16], // 6to4
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // AS112-v6
  ["2001:10::", 28], // ORCHID / abandoned
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // reserved
  ["fc00::", 7], // unique local (fc00::/7)
  ["fec0::", 10], // deprecated site-local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];

for (const [address, prefix] of IPV4_BLOCKED) BLOCKED.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of IPV6_BLOCKED) BLOCKED.addSubnet(address, prefix, "ipv6");

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
const LOCAL_SUFFIXES = [".localhost", ".internal"];

/** Lowercase, drop IPv6 brackets/zone id and trailing root dots. */
function normalizeHostname(hostnameInput: string): string {
  const bare = hostnameInput.replace(/^\[|\]$/g, "");
  const zoneIndex = bare.indexOf("%");
  const withoutZone = zoneIndex === -1 ? bare : bare.slice(0, zoneIndex);
  return withoutZone.toLowerCase().replace(/\.+$/, "");
}

export function isPublicIpLiteral(hostnameInput: string): boolean {
  if (hostnameInput !== hostnameInput.trim() || /[\[\]%]/.test(hostnameInput)) return false;
  return isIP(hostnameInput) !== 0 && !isPrivateHostname(hostnameInput);
}

function isFakeIpAddress(address: string): boolean {
  const hostname = normalizeHostname(address);
  const family = isIP(hostname);
  if (family === 4) return FAKE_IP.check(hostname, "ipv4");
  // BlockList folds IPv4-mapped IPv6 addresses before matching, just as it
  // does for the private-address policy above.
  return family === 6 && FAKE_IP.check(hostname, "ipv6");
}

export function isPrivateHostname(hostnameInput: string): boolean {
  const hostname = normalizeHostname(hostnameInput);
  if (hostname === "") return true;
  if (LOCAL_HOSTNAMES.has(hostname) || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }

  const compatible = hostname.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (compatible) return BLOCKED.check(compatible[1], "ipv4");
  const compatibleHex = hostname.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (compatibleHex) {
    const value = ((Number.parseInt(compatibleHex[1], 16) << 16) | Number.parseInt(compatibleHex[2], 16)) >>> 0;
    const dotted = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
    return BLOCKED.check(dotted, "ipv4");
  }
  const compatibleSingle = hostname.match(/^::([0-9a-f]{1,4})$/i);
  if (compatibleSingle) {
    const value = Number.parseInt(compatibleSingle[1], 16) >>> 0;
    const dotted = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
    return BLOCKED.check(dotted, "ipv4");
  }
  // Translation-specific forms are rejected explicitly instead of using a
  // broad BlockList /96, which would fold and reject every IPv4 address.
  if (hostname.startsWith("::ffff:0:")) return true;
  const family = isIP(hostname);
  if (family === 4) return BLOCKED.check(hostname, "ipv4");
  if (family === 6) {
    // BlockList folds IPv4-mapped IPv6 addresses (::ffff:0:0/96, dotted or hex
    // form) into the IPv4 space before matching, so this also covers
    // ::ffff:127.0.0.1 and ::ffff:7f00:1.
    return BLOCKED.check(hostname, "ipv6");
  }
  return false;
}

export type TrustedLookupFn = (
  hostname: string,
  trustedDnsServers: readonly string[],
) => Promise<ReadonlyArray<{ address: string }>>;

function isNoDnsAnswer(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENODATA" || code === "ENOTFOUND";
}

/** Resolve both address families through only the explicitly configured servers. */
const resolveTrusted: TrustedLookupFn = async (hostname, trustedDnsServers) => {
  const resolver = new Resolver();
  resolver.setServers([...trustedDnsServers]);
  const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  const addresses: Array<{ address: string }> = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      addresses.push(...result.value.map((address) => ({ address })));
    } else if (!isNoDnsAnswer(result.reason)) {
      throw result.reason;
    }
  }
  return addresses;
};

function fakeIpUnverified(hostname: string, cause?: unknown): FreeWebError {
  return new FreeWebError(
    "FAKE_IP_DNS_UNVERIFIED",
    `Cannot verify ${hostname} through trusted DNS after system DNS returned only fake-ip addresses; check trusted DNS availability and retry. Configuration changes require MCP restart or session reload`,
    { cause, retryable: true },
  );
}

export async function assertPublicHttpUrl(
  input: string,
  options: {
    allowPrivate?: boolean;
    lookupFn?: typeof lookup;
    trustedDnsServers?: readonly string[];
    trustedLookupFn?: TrustedLookupFn;
  } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FreeWebError("INVALID_URL", "Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FreeWebError("INVALID_URL_SCHEME", "Only HTTP(S) URLs are allowed");
  }
  if (url.username || url.password) {
    throw new FreeWebError("INVALID_URL", "Credentialed URLs are not allowed");
  }
  if (options.allowPrivate) return url;

  const hostname = normalizeHostname(url.hostname);
  if (isPrivateHostname(hostname)) {
    throw new FreeWebError("PRIVATE_URL_BLOCKED", "Local and private-network URLs are blocked");
  }
  // Public IP literals need no resolution; private ones were rejected above.
  if (isIP(hostname) !== 0) return url;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await (options.lookupFn ?? lookup)(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new FreeWebError("DNS_LOOKUP_FAILED", `Cannot resolve ${hostname}`, {
      cause: error,
      retryable: true,
    });
  }

  if (addresses.length === 0) {
    throw new FreeWebError("PRIVATE_URL_BLOCKED", `${hostname} does not resolve to any address`);
  }
  if (addresses.every(({ address }) => isFakeIpAddress(address))) {
    const trustedDnsServers = options.trustedDnsServers ?? [];
    if (trustedDnsServers.length === 0) {
      throw new FreeWebError(
        "FAKE_IP_DNS_DETECTED",
        `System DNS returned only fake-ip addresses (198.18.0.0/15) for ${hostname}. Configure network.trustedDnsServers or FREEWEB_TRUSTED_DNS_SERVERS with public DNS server IP literals, then restart the MCP server or reload the session`,
        { retryable: false },
      );
    }

    let trustedAddresses: ReadonlyArray<{ address: string }>;
    try {
      trustedAddresses = await (options.trustedLookupFn ?? resolveTrusted)(hostname, trustedDnsServers);
    } catch (error) {
      throw fakeIpUnverified(hostname, error);
    }
    if (trustedAddresses.length === 0) throw fakeIpUnverified(hostname);
    if (trustedAddresses.some(({ address }) => !isPublicIpLiteral(address))) {
      throw new FreeWebError("PRIVATE_URL_BLOCKED", "URL resolves to a local or private-network address through trusted DNS");
    }
    return url;
  }

  // Mixed fake-ip/public and fake-ip/private answers are ambiguous and never
  // qualify for trusted resolution.
  if (addresses.some(({ address }) => isPrivateHostname(address))) {
    throw new FreeWebError("PRIVATE_URL_BLOCKED", "URL resolves to a local or private-network address");
  }
  return url;
}
