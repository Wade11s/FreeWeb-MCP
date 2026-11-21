import { isIP } from "node:net";

export interface CanonicalIpAddress {
  /** Dotted IPv4 or lowercase RFC 5952-compressed IPv6. */
  address: string;
  family: 4 | 6;
  /** IPv4 embedded in compatible, mapped, or SIIT/translated IPv6. */
  embeddedIpv4?: string;
  /** Only ::ffff/96 is exempt from the reserved 0000::/8 block. */
  ipv4Mapped?: boolean;
}

function dottedIpv4(groups: readonly number[]): string {
  return [groups[6] >>> 8, groups[6] & 255, groups[7] >>> 8, groups[7] & 255].join(".");
}

function embeddedIpv4(groups: readonly number[]): { address: string; mapped: boolean } | undefined {
  const compatible = groups.slice(0, 6).every((group) => group === 0);
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const siit = groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0;
  return compatible || mapped || siit ? { address: dottedIpv4(groups), mapped } : undefined;
}

/** RFC 5952: lowercase hextets and the first longest run of at least two zero hextets. */
function canonicalIpv6(groups: readonly number[]): string {
  const hextets = groups.map((group) => group.toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart === -1) return hextets.join(":");
  return `${hextets.slice(0, bestStart).join(":")}::${hextets.slice(bestStart + bestLength).join(":")}`;
}

function ipv6Groups(input: string): number[] {
  // Node has already validated the address. Convert a dotted tail into its two
  // hextets before expanding :: so every textual spelling shares one parser.
  let expanded = input;
  const lastColon = input.lastIndexOf(":");
  const lastPart = input.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    const bytes = lastPart.split(".").map(Number);
    expanded = `${input.slice(0, lastColon + 1)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const [head = "", tail = "", ...rest] = expanded.split("::");
  if (rest.length > 0) throw new Error("Invalid IPv6 address");
  const headGroups = head ? head.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const tailGroups = tail ? tail.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array(Math.max(0, missing)).fill(0), ...tailGroups];
}

/** Parse and normalize an IP literal; return undefined for non-IP input. */
export function canonicalizeIpAddress(input: string): CanonicalIpAddress | undefined {
  const family = isIP(input);
  if (family === 4) return { address: input, family };
  if (family !== 6) return undefined;
  const groups = ipv6Groups(input);
  const embedded = embeddedIpv4(groups);
  return {
    address: canonicalIpv6(groups),
    family,
    ...(embedded ? { embeddedIpv4: embedded.address, ipv4Mapped: embedded.mapped } : {}),
  };
}
