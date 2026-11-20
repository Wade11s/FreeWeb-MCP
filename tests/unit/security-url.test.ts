import { describe, expect, it } from "vitest";
import { FreeWebError } from "../../src/errors.js";
import { assertPublicHttpUrl, isPrivateHostname } from "../../src/security/url.js";

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

type AssertOptions = NonNullable<Parameters<typeof assertPublicHttpUrl>[1]>;
type LookupFn = NonNullable<AssertOptions["lookupFn"]>;
type LookupCall = { hostname: string; options: unknown };
type TrustedLookupFn = NonNullable<AssertOptions["trustedLookupFn"]>;
type TrustedLookupCall = { hostname: string; servers: readonly string[] };

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
  ])("treats %s as public", (hostname) => {
    expect(isPrivateHostname(hostname)).toBe(false);
  });
});
