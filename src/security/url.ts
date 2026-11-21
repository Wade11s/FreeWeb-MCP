import { lookup, Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { FreeWebError } from "../errors.js";
import { resolveDoh, type DohFetchFn } from "./doh.js";
import { canonicalizeIpAddress } from "./ip-address.js";

/**
 * Address space that must never be reachable through a "public" URL.
 * Matching is delegated to net.BlockList so IPv4/IPv6 parsing and prefix
 * arithmetic stay in Node's hands instead of hand-rolled regexes.
 */
const BLOCKED = new BlockList();
const IPV6_RESERVED = new BlockList();
IPV6_RESERVED.addSubnet("::", 8, "ipv6");
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
  const address = canonicalizeIpAddress(hostnameInput);
  return address !== undefined && !isPrivateHostname(address.address);
}

/** A DoH endpoint must not need system DNS or carry credentials/query data. */
export function isDohEndpoint(server: string): boolean {
  if (server !== server.trim()) return false;
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && !server.includes("?")
    && !server.includes("#")
    && isPublicIpLiteral(hostname);
}

export function isTrustedDnsServer(server: string): boolean {
  return isPublicIpLiteral(server) || isDohEndpoint(server);
}

function isFakeIpAddress(input: string): boolean {
  const address = canonicalizeIpAddress(normalizeHostname(input));
  if (!address) return false;
  if (address.family === 4) return FAKE_IP.check(address.address, "ipv4");
  if (address.embeddedIpv4 && FAKE_IP.check(address.embeddedIpv4, "ipv4")) return true;
  return FAKE_IP.check(address.address, "ipv6");
}

export function isPrivateHostname(hostnameInput: string): boolean {
  const hostname = normalizeHostname(hostnameInput);
  if (hostname === "") return true;
  if (LOCAL_HOSTNAMES.has(hostname) || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }

  const address = canonicalizeIpAddress(hostname);
  if (!address) return false;
  if (address.family === 4) return BLOCKED.check(address.address, "ipv4");
  if (address.embeddedIpv4) {
    // Only ::ffff/96 delegates to the IPv4 policy. Compatible, translated and
    // every other 0000::/8 form remain reserved even when their tail is public.
    return address.ipv4Mapped ? BLOCKED.check(address.embeddedIpv4, "ipv4") : true;
  }
  // Keep 0000::/8 in an IPv6-only BlockList: adding it to the shared list
  // would fold into IPv4 and incorrectly block ordinary public IPv4 addresses.
  return IPV6_RESERVED.check(address.address, "ipv6") || BLOCKED.check(address.address, "ipv6");
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

function fakeIpUnverified(hostname: string, cause?: unknown, dohEndpoint?: string): FreeWebError {
  const resolver = dohEndpoint ? ` through DoH endpoint ${dohEndpoint}` : " through trusted DNS";
  return new FreeWebError(
    "FAKE_IP_DNS_UNVERIFIED",
    `Cannot verify ${hostname}${resolver} after system DNS returned only fake-ip addresses; check trusted DNS availability and retry. Configuration changes require MCP restart or session reload`,
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
    dohFetchFn?: DohFetchFn;
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
        `System DNS returned only fake-ip addresses (198.18.0.0/15) for ${hostname}. Configure network.trustedDnsServers or FREEWEB_TRUSTED_DNS_SERVERS with public DNS server IP literals or explicit HTTPS DoH endpoints, then restart the MCP server or reload the session`,
        { retryable: false },
      );
    }

    const plainServers = trustedDnsServers.filter((server) => !isDohEndpoint(server));
    const dohEndpoints = trustedDnsServers.filter(isDohEndpoint);
    let trustedAddresses: Array<{ address: string }> = [];
    if (plainServers.length > 0) {
      try {
        trustedAddresses.push(...await (options.trustedLookupFn ?? resolveTrusted)(hostname, plainServers));
      } catch (error) {
        throw fakeIpUnverified(hostname, error);
      }
    }
    const dohAnswers = await Promise.all(dohEndpoints.map(async (endpoint) => {
      let addresses: ReadonlyArray<{ address: string }>;
      try {
        addresses = await resolveDoh(hostname, endpoint, options.dohFetchFn ?? fetch);
      } catch (error) {
        throw fakeIpUnverified(hostname, error, endpoint);
      }
      // Use the same public-address policy as system and plain trusted DNS. DoH
      // failures remain retryable and identify only the credential-free endpoint.
      if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpLiteral(address))) {
        throw fakeIpUnverified(hostname, undefined, endpoint);
      }
      return addresses;
    }));
    for (const addresses of dohAnswers) trustedAddresses.push(...addresses);
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
