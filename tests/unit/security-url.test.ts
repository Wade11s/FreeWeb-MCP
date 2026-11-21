import { describe, expect, it, vi } from "vitest";
import { FreeWebError } from "../../src/errors.js";
import { assertPublicHttpUrl, isPrivateHostname } from "../../src/security/url.js";

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

type AssertOptions = NonNullable<Parameters<typeof assertPublicHttpUrl>[1]>;
type LookupFn = NonNullable<AssertOptions["lookupFn"]>;
type LookupCall = { hostname: string; options: unknown };
type TrustedLookupFn = NonNullable<AssertOptions["trustedLookupFn"]>;
type TrustedLookupCall = { hostname: string; servers: readonly string[] };
type DohFetchFn = NonNullable<AssertOptions["dohFetchFn"]>;
type DohCall = { endpoint: string; query: Uint8Array; init?: RequestInit };

/** Fake resolver: never touches the network, records every call. */
function fakeLookup(addresses: Array<string | { address: string; family: number }>) {
  const calls: LookupCall[] = [];
  const lookupFn = (async (hostname: string, options: unknown) => {
    calls.push({ hostname, options });
    return addresses.map((entry) =>
      typeof entry === "string" ? { address: entry, family: entry.includes(":") ? 6 : 4 } : entry,
    );
  }) as unknown as LookupFn;
  return { lookupFn, calls };
}

function fakeTrustedLookup(addresses: string[]) {
  const calls: TrustedLookupCall[] = [];
  const trustedLookupFn: TrustedLookupFn = async (hostname, servers) => {
    calls.push({ hostname, servers });
    return addresses.map((address) => ({ address }));
  };
  return { trustedLookupFn, calls };
}

function ipv6Bytes(address: string): number[] {
  let expanded = address;
  const lastColon = address.lastIndexOf(":");
  const lastPart = address.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    const bytes = lastPart.split(".").map(Number);
    expanded = `${address.slice(0, lastColon + 1)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const [head = "", tail = ""] = expanded.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups];
  return groups.flatMap((group) => {
    const value = Number.parseInt(group || "0", 16);
    return [value >>> 8, value & 255];
  });
}

function encodeDnsName(hostname: string): Buffer {
  return Buffer.concat([
    ...hostname.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
}

function addressData(type: number, address: string): number[] {
  return type === 1 ? address.split(".").map(Number) : ipv6Bytes(address);
}

function dnsAnswer(owner: string, type: number, data: number[] | Buffer): Buffer {
  const name = encodeDnsName(owner);
  const answer = Buffer.alloc(name.length + 10 + data.length);
  name.copy(answer, 0);
  answer.writeUInt16BE(type, name.length);
  answer.writeUInt16BE(1, name.length + 2);
  answer.writeUInt16BE(data.length, name.length + 8);
  answer.set(data, name.length + 10);
  return answer;
}

/** Build a controlled DNS response using the query's ID and complete question. */
function dnsMessage(queryInput: Uint8Array, answers: Buffer[], flags = 0x8180): Uint8Array {
  const query = Buffer.from(queryInput);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, query.subarray(12), ...answers]);
}

function dnsResponse(query: Uint8Array, addresses: string[], flags = 0x8180): Uint8Array {
  const type = Buffer.from(query).readUInt16BE(query.length - 4);
  return dnsMessage(query, addresses.map((address) => dnsAnswer("proxy.example", type, addressData(type, address))), flags);
}

function fakeDoh(respond: (call: DohCall) => Response | Promise<Response>) {
  const calls: DohCall[] = [];
  const dohFetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { endpoint: String(input), query: new Uint8Array(init?.body as ArrayBuffer), init };
    calls.push(call);
    return respond(call);
  }) as unknown as DohFetchFn;
  return { dohFetchFn, calls };
}

function dohResponse(call: DohCall, addresses: string[], status = 200): Response {
  return new Response(dnsResponse(call.query, addresses), {
    status,
    headers: { "content-type": "application/dns-message" },
  });
}

function queryType(call: DohCall): number {
  return Buffer.from(call.query).readUInt16BE(call.query.length - 4);
}

async function rejection(promise: Promise<unknown>): Promise<FreeWebError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FreeWebError);
    return error as FreeWebError;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

async function expectCode(
  input: string,
  code: string,
  options: AssertOptions = {},
): Promise<FreeWebError> {
  const error = await rejection(assertPublicHttpUrl(input, options));
  expect(error.code, `expected ${input} to fail with ${code}`).toBe(code);
  return error;
}

describe("assertPublicHttpUrl: URL shape", () => {
  it.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "ws://example.com/socket",
    "wss://example.com/socket",
    "gopher://example.com/",
  ])("rejects non-HTTP(S) URL %s", async (input) => {
    await expectCode(input, "INVALID_URL_SCHEME");
  });

  it.each(["", "not a url", "example.com", "http://", "//example.com", "https://exa mple.com/"])(
    "rejects malformed URL %j",
    async (input) => {
      await expectCode(input, "INVALID_URL");
    },
  );

  it.each([
    "https://user:pass@example.com/",
    "https://user@example.com/",
    "http://:pass@example.com/",
    "http://example.com@169.254.169.254/",
  ])("rejects credentialed URL %s", async (input) => {
    await expectCode(input, "INVALID_URL");
  });

  it("accepts a public HTTPS URL and normalizes it", async () => {
    const { lookupFn, calls } = fakeLookup([PUBLIC_V4]);
    const url = await assertPublicHttpUrl("https://Example.COM/path?q=1", { lookupFn });
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe("https://example.com/path?q=1");
    expect(calls).toEqual([{ hostname: "example.com", options: { all: true, verbatim: true } }]);
  });

  it("accepts plain HTTP on a public address", async () => {
    const { lookupFn } = fakeLookup([PUBLIC_V4]);
    const url = await assertPublicHttpUrl("http://example.org/", { lookupFn });
    expect(url.protocol).toBe("http:");
  });

  it("does not resolve public IP literals through DNS", async () => {
    const { lookupFn, calls } = fakeLookup([PUBLIC_V4]);
    await expect(assertPublicHttpUrl(`https://${PUBLIC_V4}/`, { lookupFn })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpUrl(`https://[${PUBLIC_V6}]/`, { lookupFn })).resolves.toBeInstanceOf(URL);
    expect(calls).toEqual([]);
  });
});

describe("assertPublicHttpUrl: local names", () => {
  it.each([
    "http://localhost/",
    "http://localhost:3000/x",
    "http://LOCALHOST/",
    "http://localhost./",
    "http://a.localhost/",
    "http://a.b.localhost:8080/",
    "http://localhost.localdomain/",
    "http://metadata.google.internal/computeMetadata/v1/",
  ])("blocks %s", async (input) => {
    const { lookupFn, calls } = fakeLookup([PUBLIC_V4]);
    await expectCode(input, "PRIVATE_URL_BLOCKED", { lookupFn });
    expect(calls, "local names must not reach DNS").toEqual([]);
  });
});

describe("assertPublicHttpUrl: IPv4 literals", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "192.0.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "198.18.0.1",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
  ])("blocks %s", async (host) => {
    const { lookupFn, calls } = fakeLookup([PUBLIC_V4]);
    await expectCode(`http://${host}/`, "PRIVATE_URL_BLOCKED", { lookupFn });
    expect(calls, "IP literals must not reach DNS").toEqual([]);
  });

  it.each(["http://0x7f000001/", "http://2130706433/", "http://0177.0.0.1/", "http://127.1/"])(
    "blocks obfuscated loopback form %s",
    async (input) => {
      await expectCode(input, "PRIVATE_URL_BLOCKED");
    },
  );

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
  ])("allows public address %s", async (host) => {
    const { lookupFn, calls } = fakeLookup([PUBLIC_V4]);
    const url = await assertPublicHttpUrl(`http://${host}/`, { lookupFn });
    expect(url.hostname).toBe(host);
    expect(calls).toEqual([]);
  });
});

describe("assertPublicHttpUrl: IPv6 literals", () => {
  it.each([
    "::1",
    "::",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:0a01:203",
    "0:0:0:0:0:ffff:7f00:0001",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "::ffff:0:7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "3fff::1",
    "fec0::1",
    "::2",
  ])("blocks [%s]", async (host) => {
    const { lookupFn, calls } = fakeLookup([PUBLIC_V4]);
    await expectCode(`http://[${host}]/`, "PRIVATE_URL_BLOCKED", { lookupFn });
    expect(calls, "IP literals must not reach DNS").toEqual([]);
  });

  it.each([PUBLIC_V6, "2001:4860:4860::8888", "2a00:1450:4001:80f::200e"])(
    "allows public IPv6 %s",
    async (host) => {
      const { lookupFn, calls } = fakeLookup([PUBLIC_V4]);
      const url = await assertPublicHttpUrl(`https://[${host}]/`, { lookupFn });
      expect(url.hostname).toBe(`[${host}]`);
      expect(calls).toEqual([]);
    },
  );
});

describe("assertPublicHttpUrl: DNS resolution", () => {
  it("blocks when a resolved IPv4 address is private", async () => {
    const { lookupFn } = fakeLookup([PUBLIC_V4, "10.0.0.5"]);
    await expectCode("https://mixed.example/", "PRIVATE_URL_BLOCKED", { lookupFn });
  });

  it("blocks when a resolved IPv6 address is link-local", async () => {
    const { lookupFn } = fakeLookup([PUBLIC_V6, "fe80::1"]);
    await expectCode("https://mixed.example/", "PRIVATE_URL_BLOCKED", { lookupFn });
  });

  it("blocks when a resolved address is IPv4-mapped in hex form", async () => {
    const { lookupFn } = fakeLookup(["::ffff:7f00:1"]);
    await expectCode("https://mapped.example/", "PRIVATE_URL_BLOCKED", { lookupFn });
  });

  it("blocks when resolution returns no addresses", async () => {
    const { lookupFn } = fakeLookup([]);
    await expectCode("https://empty.example/", "PRIVATE_URL_BLOCKED", { lookupFn });
  });

  it("allows when every resolved address is public", async () => {
    const { lookupFn } = fakeLookup([PUBLIC_V4, PUBLIC_V6]);
    const url = await assertPublicHttpUrl("https://public.example/", { lookupFn });
    expect(url.hostname).toBe("public.example");
  });

  it("fails with DNS_LOOKUP_FAILED and keeps the cause when resolution rejects", async () => {
    const cause = new Error("ENOTFOUND");
    const lookupFn = (async () => {
      throw cause;
    }) as unknown as LookupFn;
    const error = await expectCode("https://broken.example/", "DNS_LOOKUP_FAILED", { lookupFn });
    expect(error.options.retryable).toBe(true);
    expect(error.options.cause).toBe(cause);
  });
});

describe("assertPublicHttpUrl: fake-ip DNS", () => {
  const servers = ["1.1.1.1", "2606:4700:4700::1111"];

  it("never contacts trusted DNS for ordinary public system answers", async () => {
    const { lookupFn } = fakeLookup([PUBLIC_V4, PUBLIC_V6]);
    const { trustedLookupFn, calls } = fakeTrustedLookup(["10.0.0.1"]);
    await expect(assertPublicHttpUrl("https://public.example/", {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    })).resolves.toBeInstanceOf(URL);
    expect(calls).toEqual([]);
  });

  it("never contacts trusted DNS for direct public or fake-ip literals", async () => {
    const { lookupFn, calls: systemCalls } = fakeLookup([PUBLIC_V4]);
    const { trustedLookupFn, calls: trustedCalls } = fakeTrustedLookup([PUBLIC_V4]);
    await expect(assertPublicHttpUrl(`https://${PUBLIC_V4}/`, {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    })).resolves.toBeInstanceOf(URL);
    await expectCode("https://198.19.255.255/", "PRIVATE_URL_BLOCKED", {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    });
    expect(systemCalls).toEqual([]);
    expect(trustedCalls).toEqual([]);
  });

  it("returns actionable FAKE_IP_DNS_DETECTED without trusted configuration", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1", "198.19.255.255"]);
    const { trustedLookupFn, calls } = fakeTrustedLookup([PUBLIC_V4]);
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_DETECTED", {
      lookupFn,
      trustedLookupFn,
    });
    expect(error.message).toContain("network.trustedDnsServers");
    expect(error.message).toContain("FREEWEB_TRUSTED_DNS_SERVERS");
    expect(error.message).toMatch(/restart the MCP server or reload the session/);
    expect(error.options.retryable).toBe(false);
    expect(calls).toEqual([]);
  });

  it("verifies an all-fake-ip hostname through both configured trusted servers", async () => {
    const { lookupFn, calls: systemCalls } = fakeLookup(["198.18.0.1", "198.19.255.255"]);
    const { trustedLookupFn, calls } = fakeTrustedLookup([PUBLIC_V4, PUBLIC_V6]);
    const url = await assertPublicHttpUrl("https://proxy.example/", {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    });
    expect(url.hostname).toBe("proxy.example");
    expect(systemCalls).toHaveLength(1);
    expect(calls).toEqual([{ hostname: "proxy.example", servers }]);
  });

  it("treats an IPv4-mapped fake-ip answer as fake-ip", async () => {
    const { lookupFn } = fakeLookup(["::ffff:198.18.0.1"]);
    const { trustedLookupFn, calls } = fakeTrustedLookup([PUBLIC_V4]);
    await expect(assertPublicHttpUrl("https://proxy.example/", {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    })).resolves.toBeInstanceOf(URL);
    expect(calls).toHaveLength(1);
  });

  it.each([["198.18.0.1", PUBLIC_V4], ["198.18.0.1", "10.0.0.1"]])(
    "blocks mixed system answers without trusted resolution: %j",
    async (...addresses) => {
      const { lookupFn } = fakeLookup(addresses);
      const { trustedLookupFn, calls } = fakeTrustedLookup([PUBLIC_V4]);
      await expectCode("https://mixed.example/", "PRIVATE_URL_BLOCKED", {
        lookupFn,
        trustedLookupFn,
        trustedDnsServers: servers,
      });
      expect(calls).toEqual([]);
    },
  );

  it("does not turn an empty system result into a fake-ip exception", async () => {
    const { lookupFn } = fakeLookup([]);
    const { trustedLookupFn, calls } = fakeTrustedLookup([PUBLIC_V4]);
    await expectCode("https://empty.example/", "PRIVATE_URL_BLOCKED", {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    });
    expect(calls).toEqual([]);
  });

  it("returns retryable FAKE_IP_DNS_UNVERIFIED when trusted resolution fails", async () => {
    const cause = new Error("resolver unavailable");
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const trustedLookupFn: TrustedLookupFn = async () => { throw cause; };
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    });
    expect(error.options.retryable).toBe(true);
    expect(error.options.cause).toBe(cause);
    expect(error.message).toMatch(/retry/);
  });

  it("returns retryable FAKE_IP_DNS_UNVERIFIED when trusted DNS has no answers", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { trustedLookupFn } = fakeTrustedLookup([]);
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    });
    expect(error.options.retryable).toBe(true);
  });

  it.each(["10.0.0.1", "127.0.0.1", "198.18.0.2", "fd00::1", "not-an-ip"] )(
    "blocks unsafe trusted answer %s",
    async (address) => {
      const { lookupFn } = fakeLookup(["198.18.0.1"]);
      const { trustedLookupFn } = fakeTrustedLookup([PUBLIC_V4, address]);
      await expectCode("https://proxy.example/", "PRIVATE_URL_BLOCKED", {
        lookupFn,
        trustedLookupFn,
        trustedDnsServers: servers,
      });
    },
  );

  it("does not contact trusted DNS when the system lookup fails", async () => {
    const lookupFn = (async () => { throw new Error("ENOTFOUND"); }) as unknown as LookupFn;
    const { trustedLookupFn, calls } = fakeTrustedLookup([PUBLIC_V4]);
    await expectCode("https://broken.example/", "DNS_LOOKUP_FAILED", {
      lookupFn,
      trustedLookupFn,
      trustedDnsServers: servers,
    });
    expect(calls).toEqual([]);
  });
});

describe("assertPublicHttpUrl: DNS-over-HTTPS", () => {
  const endpoint = "https://1.1.1.1/dns-query";

  it("verifies an all-fake-ip hostname through one bounded A and AAAA query", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1", "198.19.255.255"]);
    const { trustedLookupFn, calls: plainCalls } = fakeTrustedLookup([]);
    const { dohFetchFn, calls } = fakeDoh((call) => {
      const type = call.query[call.query.length - 4] << 8 | call.query[call.query.length - 3];
      return dohResponse(call, [type === 1 ? PUBLIC_V4 : PUBLIC_V6]);
    });

    await expect(assertPublicHttpUrl("https://proxy.example/", {
      lookupFn,
      trustedDnsServers: [endpoint],
      trustedLookupFn,
      dohFetchFn,
    })).resolves.toBeInstanceOf(URL);

    expect(plainCalls).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.endpoint)).toEqual([endpoint, endpoint]);
    for (const call of calls) {
      expect(call.init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { accept: "application/dns-message", "content-type": "application/dns-message" },
      });
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("combines explicitly configured plain DNS and DoH answers", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { trustedLookupFn, calls: plainCalls } = fakeTrustedLookup([PUBLIC_V4]);
    const { dohFetchFn, calls } = fakeDoh((call) => {
      const type = call.query[call.query.length - 4] << 8 | call.query[call.query.length - 3];
      return dohResponse(call, type === 1 ? [] : [PUBLIC_V6]);
    });

    await expect(assertPublicHttpUrl("https://proxy.example/", {
      lookupFn,
      trustedDnsServers: ["9.9.9.9", endpoint],
      trustedLookupFn,
      dohFetchFn,
    })).resolves.toBeInstanceOf(URL);
    expect(plainCalls).toEqual([{ hostname: "proxy.example", servers: ["9.9.9.9"] }]);
    expect(calls).toHaveLength(2);
  });

  it("returns retryable FAKE_IP_DNS_UNVERIFIED for non-2xx without leaking its body", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const sensitiveBody = "controlled sensitive resolver response";
    const { dohFetchFn, calls } = fakeDoh(() => new Response(sensitiveBody, {
      status: 503,
      headers: { "content-type": "application/dns-message" },
    }));
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(error.options.retryable).toBe(true);
    expect(error.message).toContain(endpoint);
    expect(JSON.stringify(error)).not.toContain(sensitiveBody);
    expect(calls).toHaveLength(2);
  });

  it("returns retryable FAKE_IP_DNS_UNVERIFIED for a malformed DNS body", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const sensitiveBody = "not a DNS message and not for diagnostics";
    const { dohFetchFn } = fakeDoh(() => new Response(sensitiveBody, {
      headers: { "content-type": "application/dns-message" },
    }));
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(error.options.retryable).toBe(true);
    expect(error.message).toContain(endpoint);
    expect(error.message).not.toContain(sensitiveBody);
  });

  it("returns retryable FAKE_IP_DNS_UNVERIFIED for an empty answer set", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { dohFetchFn } = fakeDoh((call) => dohResponse(call, []));
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(error.options.retryable).toBe(true);
    expect(error.message).toContain(endpoint);
  });

  it.each(["10.0.0.1", "127.0.0.1", "198.18.0.2"])(
    "fails closed with FAKE_IP_DNS_UNVERIFIED for non-public DoH answer %s",
    async (address) => {
      const { lookupFn } = fakeLookup(["198.18.0.1"]);
      const { dohFetchFn } = fakeDoh((call) => dohResponse(call, [address]));
      const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
        lookupFn,
        trustedDnsServers: [endpoint],
        dohFetchFn,
      });
      expect(error.options.retryable).toBe(true);
      expect(error.message).toContain(endpoint);
    },
  );

  it.each([
    "::10.0.0.1",
    "::169.254.169.254",
    "::ffff:0:169.254.169.254",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:0:A00:0001",
    "0:0:0:0:0:0:A9FE:A9FE",
    "0:0:0:0:FFFF:0:A9FE:A9FE",
    "0:0:0:0:0:FFFF:7F00:0001",
  ])("rejects decoded IPv4-embedding IPv6 DoH answer %s", async (address) => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { dohFetchFn } = fakeDoh((call) => dohResponse(call, queryType(call) === 1 ? [] : [address]));
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(error.options.retryable).toBe(true);
  });

  it("rejects an unrelated-owner address even beside a valid direct answer", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { dohFetchFn, calls } = fakeDoh((call) => {
      const type = queryType(call);
      const answers = type === 1 ? [
        dnsAnswer("proxy.example", type, addressData(type, PUBLIC_V4)),
        dnsAnswer("unrelated.example", type, addressData(type, "8.8.8.8")),
      ] : [];
      return new Response(dnsMessage(call.query, answers), {
        headers: { "content-type": "application/dns-message" },
      });
    });
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(error.options.retryable).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("accepts an address owned by a CNAME target reachable from the query", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { dohFetchFn } = fakeDoh((call) => {
      const type = queryType(call);
      const answers = type === 1 ? [
        dnsAnswer("proxy.example", 5, encodeDnsName("alias.example")),
        dnsAnswer("alias.example", type, addressData(type, PUBLIC_V4)),
      ] : [];
      return new Response(dnsMessage(call.query, answers), {
        headers: { "content-type": "application/dns-message" },
      });
    });
    await expect(assertPublicHttpUrl("https://proxy.example/", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    })).resolves.toBeInstanceOf(URL);
  });

  it("aborts an oversized streaming body with no Content-Length while reading", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { dohFetchFn, calls } = fakeDoh(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65_536));
        },
      });
      return new Response(body, { headers: { "content-type": "application/dns-message" } });
    });
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(error.options.retryable).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.init?.signal?.aborted)).toBe(true);
  });

  it("rejects a mix of public and private DoH answers", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { dohFetchFn } = fakeDoh((call) => {
      const type = call.query[call.query.length - 4] << 8 | call.query[call.query.length - 3];
      return dohResponse(call, type === 1 ? [PUBLIC_V4, "10.0.0.1"] : [PUBLIC_V6, "fd00::1"]);
    });
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(error.options.retryable).toBe(true);
  });

  it("returns retryable FAKE_IP_DNS_UNVERIFIED when the endpoint is unreachable", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { dohFetchFn, calls } = fakeDoh(() => { throw new Error("controlled connection failure"); });
    const error = await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(error.options.retryable).toBe(true);
    expect(error.message).toContain(endpoint);
    expect(calls).toHaveLength(2);
  });

  it("fails closed for an unsuccessful DNS response", async () => {
    const { lookupFn } = fakeLookup(["198.18.0.1"]);
    const { dohFetchFn } = fakeDoh((call) => new Response(dnsResponse(call.query, [], 0x8183), {
      headers: { "content-type": "application/dns-message" },
    }));
    await expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
      lookupFn,
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
  });

  it("aborts slow queries once without retrying", async () => {
    vi.useFakeTimers();
    try {
      const { lookupFn } = fakeLookup(["198.18.0.1"]);
      const { dohFetchFn, calls } = fakeDoh((call) => new Promise<Response>((_resolve, reject) => {
        call.init?.signal?.addEventListener("abort", () => reject(call.init?.signal?.reason), { once: true });
      }));
      const pending = expectCode("https://proxy.example/", "FAKE_IP_DNS_UNVERIFIED", {
        lookupFn,
        trustedDnsServers: [endpoint],
        dohFetchFn,
      });
      await vi.advanceTimersByTimeAsync(3001);
      const error = await pending;
      expect(error.options.retryable).toBe(true);
      expect(error.message).toContain(endpoint);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never uses DoH for ordinary, mixed, empty, or direct fake-ip targets", async () => {
    const { dohFetchFn, calls } = fakeDoh((call) => dohResponse(call, [PUBLIC_V4]));
    for (const addresses of [[PUBLIC_V4], ["198.18.0.1", PUBLIC_V4], []]) {
      const { lookupFn } = fakeLookup(addresses);
      await assertPublicHttpUrl("https://target.example/", {
        lookupFn,
        trustedDnsServers: [endpoint],
        dohFetchFn,
      }).catch(() => undefined);
    }
    await expectCode("https://198.18.0.1/", "PRIVATE_URL_BLOCKED", {
      trustedDnsServers: [endpoint],
      dohFetchFn,
    });
    expect(calls).toEqual([]);
  });
});

describe("assertPublicHttpUrl: allowPrivate", () => {
  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[fd12::1]/",
    "http://169.254.169.254/",
    "http://10.0.0.9/",
  ])("allows %s without consulting DNS", async (input) => {
    const { lookupFn, calls } = fakeLookup(["10.0.0.7"]);
    const url = await assertPublicHttpUrl(input, { allowPrivate: true, lookupFn });
    expect(url).toBeInstanceOf(URL);
    expect(calls).toEqual([]);
  });

  it("allows a hostname that would resolve to a private address", async () => {
    const { lookupFn, calls } = fakeLookup(["127.0.0.1"]);
    const url = await assertPublicHttpUrl("https://internal.example/", { allowPrivate: true, lookupFn });
    expect(url.hostname).toBe("internal.example");
    expect(calls).toEqual([]);
  });

  it("still rejects non-HTTP(S) schemes", async () => {
    await expectCode("ftp://localhost/", "INVALID_URL_SCHEME", { allowPrivate: true });
  });

  it("still rejects credentialed URLs", async () => {
    await expectCode("http://user:pass@localhost/", "INVALID_URL", { allowPrivate: true });
  });

  it("does not change behavior when explicitly false", async () => {
    const { lookupFn } = fakeLookup(["127.0.0.1"]);
    await expectCode("https://internal.example/", "PRIVATE_URL_BLOCKED", {
      allowPrivate: false,
      lookupFn,
    });
  });
});

describe("isPrivateHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "a.localhost",
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "[::1]",
    "::",
    "FD00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::10.0.0.1",
    "::169.254.169.254",
    "::ffff:0:169.254.169.254",
    "0:0:0:0:0:0:A00:0001",
    "0:0:0:0:0:0:A9FE:A9FE",
    "0:0:0:0:FFFF:0:A9FE:A9FE",
    "0:0:0:0:0:FFFF:7F00:0001",
    "::FFFF:0:169.254.169.254",
  ])("treats %s as private", (hostname) => {
    expect(isPrivateHostname(hostname)).toBe(true);
  });

  it.each([
    "example.com",
    "public.example",
    "93.184.216.34",
    PUBLIC_V6,
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "::8.8.8.8",
    "::FFFF:0:8.8.8.8",
  ])("treats %s as public", (hostname) => {
    expect(isPrivateHostname(hostname)).toBe(false);
  });
});
