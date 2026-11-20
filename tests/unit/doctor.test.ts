import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { runDoctor } from "../../src/doctor.js";
import { readPackageMetadata } from "../../src/package-metadata.js";

let root: string;
let previousKey: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-doctor-test-"));
  previousKey = process.env.TINYFISH_API_KEY;
  process.env.TINYFISH_API_KEY = "doctor-secret-key";
});
afterEach(async () => {
  if (previousKey === undefined) delete process.env.TINYFISH_API_KEY;
  else process.env.TINYFISH_API_KEY = previousKey;
  await rm(root, { recursive: true, force: true });
});

/** Configuration pointing at the temporary data directory, with no config file present. */
async function testConfig() {
  const config = await loadConfig({ configPath: join(root, "missing.json"), env: { FREEWEB_DATA_DIR: join(root, "data") } });
  return config;
}

describe("doctor provider environment", () => {
  it("does not forward the TinyFish API key to version-check binaries", async () => {
    const binary = join(root, "provider-version.sh");
    const environmentOutput = join(root, "environment.txt");
    await writeFile(binary, `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(environmentOutput)}\necho fake-provider 1.0\n`);
    await chmod(binary, 0o700);
    const config = await testConfig();
    config.firecrawl.binary = binary;
    config.ego.binary = binary;

    await runDoctor(config, { minimumNodeVersion: [22, 12, 0] });

    const environment = await readFile(environmentOutput, "utf8");
    expect(environment).not.toContain("TINYFISH_API_KEY");
    expect(environment).not.toContain("doctor-secret-key");
    expect(environment).toContain("PATH=");
  });
});

describe("doctor Node.js runtime floor", () => {
  it("fails the required node check below the package minimum", async () => {
    const config = await testConfig();
    const report = await runDoctor(config, { minimumNodeVersion: [22, 12, 0], nodeVersion: "22.11.9" });

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "node", ok: false, required: true, version: "v22.11.9" });
    expect(report.checks[0]?.message).toContain("22.12.0");
  });

  it("passes the required node check at and above the package minimum", async () => {
    const config = await testConfig();
    for (const nodeVersion of ["22.12.0", "22.12.1", "23.0.0"]) {
      const report = await runDoctor(config, { minimumNodeVersion: [22, 12, 0], nodeVersion });
      expect(report.checks[0]).toMatchObject({ name: "node", ok: true, required: true, version: `v${nodeVersion}` });
      expect(report.checks[0]?.message).toBeUndefined();
    }
  });

  it("marks only node, firecrawl-local, and data-directory as required", async () => {
    const config = await testConfig();
    const report = await runDoctor(config, { minimumNodeVersion: [22, 12, 0] });

    expect(report.checks[0]).toMatchObject({ name: "node", ok: true, version: process.version });
    expect(report.checks.filter((check) => check.required).map((check) => check.name))
      .toEqual(["node", "firecrawl-local", "data-directory"]);
  });
});

describe("doctor package metadata", () => {
  it("reads the runtime floor and version from package.json instead of duplicating them", async () => {
    const declared = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      version: string;
      engines: { node: string };
    };
    const metadata = await readPackageMetadata();

    expect(metadata.version).toBe(declared.version);
    expect(`>=${metadata.minimumNodeVersion.join(".")}`).toBe(declared.engines.node);
  });
});
