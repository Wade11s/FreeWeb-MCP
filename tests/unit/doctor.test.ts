import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { runDoctor } from "../../src/doctor.js";

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

describe("doctor provider environment", () => {
  it("does not forward the TinyFish API key to version-check binaries", async () => {
    const binary = join(root, "provider-version.sh");
    const environmentOutput = join(root, "environment.txt");
    await writeFile(binary, `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(environmentOutput)}\necho fake-provider 1.0\n`);
    await chmod(binary, 0o700);
    const config = await loadConfig({ configPath: join(root, "missing.json"), env: { FREEWEB_DATA_DIR: join(root, "data") } });
    config.firecrawl.binary = binary;
    config.ego.binary = binary;

    await runDoctor(config);

    const environment = await readFile(environmentOutput, "utf8");
    expect(environment).not.toContain("TINYFISH_API_KEY");
    expect(environment).not.toContain("doctor-secret-key");
    expect(environment).toContain("PATH=");
  });
});
