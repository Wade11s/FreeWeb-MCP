import { appendFileSync } from "node:fs";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const logPath = process.env.FREEWEB_TEST_FAKE_IP_LOG;
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";
const FAKE_V4 = "198.18.0.1";

function record(event) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function systemAnswers(hostname) {
  switch (hostname) {
    case "public.fake-ip.test":
    case "private-trusted.fake-ip.test":
    case "unverified.fake-ip.test":
    case "empty-trusted.fake-ip.test":
      return [FAKE_V4, "198.19.255.255"];
    case "mixed.fake-ip.test":
      return [FAKE_V4, PUBLIC_V4];
    case "ordinary.public.test":
      return [PUBLIC_V4, PUBLIC_V6];
    default: {
      const error = new Error(`Controlled DNS has no answer for ${hostname}`);
      error.code = "ENOTFOUND";
      throw error;
    }
  }
}

dnsPromises.lookup = async (hostname, options) => {
  record({ kind: "system-lookup", hostname });
  const addresses = systemAnswers(hostname).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  return options?.all ? addresses : addresses[0];
};

dnsPromises.Resolver = class ControlledResolver {
  setServers(servers) {
    this.servers = servers;
    record({ kind: "trusted-servers", servers });
  }

  async resolve4(hostname) {
    record({ kind: "trusted-a", hostname, servers: this.servers });
    if (hostname === "unverified.fake-ip.test") {
      const error = new Error("Controlled trusted resolver failure");
      error.code = "ECONNREFUSED";
      throw error;
    }
    if (hostname === "empty-trusted.fake-ip.test") return [];
    return [hostname === "private-trusted.fake-ip.test" ? "10.0.0.1" : PUBLIC_V4];
  }

  async resolve6(hostname) {
    record({ kind: "trusted-aaaa", hostname, servers: this.servers });
    if (hostname === "unverified.fake-ip.test") {
      const error = new Error("Controlled trusted resolver failure");
      error.code = "ECONNREFUSED";
      throw error;
    }
    if (hostname === "empty-trusted.fake-ip.test") return [];
    return [PUBLIC_V6];
  }
};
syncBuiltinESMExports();

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.fetch.tinyfish.ai/")) {
    const body = JSON.parse(String(init?.body));
    record({ kind: "tinyfish-fetch", urls: body.urls });
    return new Response(JSON.stringify({
      results: body.urls.map((url) => ({
        url,
        format: "markdown",
        text: `controlled TinyFish content for ${url}`,
        title: "Controlled TinyFish",
        final_url: url,
        description: "Controlled response",
        language: "en",
        author: "",
        published_date: "",
      })),
      errors: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("tinyfish.ai")) throw new Error(`Unexpected TinyFish request: ${url}`);
  return originalFetch(input, init);
};
