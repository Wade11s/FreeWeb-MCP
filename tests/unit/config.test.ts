import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, redactedConfig } from "../../src/config.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "freeweb-config-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("trusted DNS configuration", () => {
  it("defaults to no trusted servers", async () => {
    const config = await loadConfig({ configPath: join(root, "missing.json"), env: {} });
    expect(config.network.trustedDnsServers).toEqual([]);
  });

  it("accepts public IP literals and explicit HTTPS DoH endpoints side by side", async () => {
    const path = join(root, "config.json");
    const servers = [
      "1.1.1.1",
      "2606:4700:4700::1111",
      "https://1.1.1.1/dns-query",
      "https://[2606:4700:4700::1111]:8443/resolve",
    ];
    await writeFile(path, JSON.stringify({ network: { trustedDnsServers: servers } }));
    const config = await loadConfig({ configPath: path, env: {} });
    expect(config.network.trustedDnsServers).toEqual(servers);
  });

  it("applies the comma-separated environment override and permits an explicit empty override", async () => {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ network: { trustedDnsServers: ["9.9.9.9"] } }));
    const config = await loadConfig({
      configPath: path,
      env: { FREEWEB_TRUSTED_DNS_SERVERS: " 1.1.1.1, 2606:4700:4700::1111, https://1.1.1.1/dns-query " },
    });
    expect(config.network.trustedDnsServers).toEqual([
      "1.1.1.1",
      "2606:4700:4700::1111",
      "https://1.1.1.1/dns-query",
    ]);

    const disabled = await loadConfig({ configPath: path, env: { FREEWEB_TRUSTED_DNS_SERVERS: "" } });
    expect(disabled.network.trustedDnsServers).toEqual([]);
  });

  it.each([
    "dns.example",
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "198.18.0.1",
    "::1",
    "fd00::1",
    "http://1.1.1.1/dns-query",
    "https://dns.example/dns-query",
    "https://127.0.0.1/dns-query",
    "https://198.18.0.1/dns-query",
    "https://[fd00::1]/dns-query",
    "https://user:pass@1.1.1.1/dns-query",
    "https://1.1.1.1/dns-query?name=example.com",
    "https://1.1.1.1/dns-query?",
    "https://1.1.1.1/dns-query#fragment",
    "https://1.1.1.1/dns-query#",
    "user@1.1.1.1",
    "[2606:4700:4700::1111]",
    "1.1.1.1%eth0",
  ])("rejects non-public or non-literal trusted server %s", async (server) => {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ network: { trustedDnsServers: [server] } }));
    await expect(loadConfig({ configPath: path, env: {} })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(loadConfig({
      configPath: join(root, "missing.json"),
      env: { FREEWEB_TRUSTED_DNS_SERVERS: server },
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("rejects empty entries in a non-empty environment list", async () => {
    await expect(loadConfig({
      configPath: join(root, "missing.json"),
      env: { FREEWEB_TRUSTED_DNS_SERVERS: "1.1.1.1,,8.8.8.8" },
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});

describe("wrapper-validated Firecrawl target trust configuration", () => {
  it("defaults off and applies the single-value boolean environment override", async () => {
    const missing = join(root, "missing.json");
    const initial = await loadConfig({ configPath: missing, env: {} });
    expect(initial.firecrawl.trustWrapperTargetPolicy).toBe(false);

    const enabled = await loadConfig({
      configPath: missing,
      env: {
        FREEWEB_TRUSTED_DNS_SERVERS: "https://1.1.1.1/dns-query",
        FREEWEB_FIRECRAWL_TRUST_WRAPPER_TARGET_POLICY: "true",
      },
    });
    expect(enabled.firecrawl.trustWrapperTargetPolicy).toBe(true);
    expect(enabled.firecrawl.allowPrivate).toBe(false);

    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({
      network: { trustedDnsServers: ["1.1.1.1"] },
      firecrawl: { trustWrapperTargetPolicy: true },
    }));
    const disabled = await loadConfig({
      configPath: path,
      env: { FREEWEB_FIRECRAWL_TRUST_WRAPPER_TARGET_POLICY: "false" },
    });
    expect(disabled.firecrawl.trustWrapperTargetPolicy).toBe(false);
  });

  it("rejects wrapper target trust without trusted DNS", async () => {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ firecrawl: { trustWrapperTargetPolicy: true } }));

    await expect(loadConfig({ configPath: path, env: {} })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("network.trustedDnsServers"),
    });
    await expect(loadConfig({
      configPath: join(root, "missing.json"),
      env: { FREEWEB_FIRECRAWL_TRUST_WRAPPER_TARGET_POLICY: "yes" },
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("rejects wrapper target trust together with Firecrawl private access", async () => {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({
      network: { trustedDnsServers: ["1.1.1.1"] },
      firecrawl: { allowPrivate: true, trustWrapperTargetPolicy: true },
    }));

    await expect(loadConfig({ configPath: path, env: {} })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("firecrawl.allowPrivate"),
    });
  });

  it("keeps the opt-in visible and allowPrivate unchanged in redacted configuration", async () => {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({
      network: { trustedDnsServers: ["1.1.1.1"] },
      firecrawl: { trustWrapperTargetPolicy: true },
    }));
    const config = await loadConfig({
      configPath: path,
      env: { TINYFISH_API_KEY: "wrapper-trust-redaction-key" },
    });

    const redacted = redactedConfig(config);
    expect(redacted.firecrawl).toMatchObject({ allowPrivate: false, trustWrapperTargetPolicy: true });
    expect(JSON.stringify(redacted)).not.toContain("wrapper-trust-redaction-key");
  });
});

describe("configuration environment overrides", () => {
  it("revalidates port ranges after applying environment overrides", async () => {
    await expect(loadConfig({ configPath: join(root, "missing.json"), env: { FIRECRAWL_PORT: "70000" } }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("rejects an empty data directory after applying environment overrides", async () => {
    await expect(loadConfig({ configPath: join(root, "missing.json"), env: { FREEWEB_DATA_DIR: "" } }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("keeps API keys out of redacted configuration output", async () => {
    const config = await loadConfig({
      configPath: join(root, "missing.json"),
      env: {
        FREEWEB_DATA_DIR: join(root, "data"),
        TINYFISH_API_KEY: "secret-test-key",
        FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "true",
      },
    });

    expect(config.tinyfish.freeOnlyConfirmed).toBe(true);
    expect(JSON.stringify(redactedConfig(config))).not.toContain("secret-test-key");
  });
});
