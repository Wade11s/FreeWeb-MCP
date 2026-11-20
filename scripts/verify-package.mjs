#!/usr/bin/env node
// Release verification for the published artifact.
//
// This script does not trust package.json: it builds the real tarball, inspects
// what it actually contains, installs it into a throwaway prefix outside the
// repository, runs the installed executable through the final command surface,
// and proves that the removed ESM library entry no longer resolves for a
// consumer.
//
// It is offline by construction. `npm pack` is local, and the throwaway install
// runs with `--offline`, resolving the package's dependencies from the local npm
// cache that this repository's `npm install` populated. A cold cache fails the
// run loudly instead of reaching the network.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pathSeparator = process.platform === "win32" ? ";" : ":";

/** Runs a command, returning its captured output and status. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
    shell: options.shell ?? false,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Fails the verification with one readable diagnostic. */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** Files the package must ship: the executable, runtime modules, and public docs. */
const requiredEntries = [
  "package.json",
  "dist/cli.js",
  "README.md",
  "LICENSE",
  "GLOSSARY.md",
  "config.example.json",
  "docs/architecture.md",
  "docs/security.md",
  "docs/testing.md",
  "docs/providers/firecrawl-local.md",
  "docs/adr/0001-provider-boundaries-and-fallback.md",
];

/** Entries that must never reach a published tarball. */
const forbidden = [
  { label: "source file", test: (path) => path.startsWith("src/") || path.startsWith("tests/") },
  { label: "TypeScript source", test: (path) => path.endsWith(".ts") },
  { label: "build or editor config", test: (path) => /^(vitest\.config\.ts|tsconfig(\.[a-z]+)?\.json|\.npmignore|\.gitignore)$/.test(path) },
  { label: "editor or OS artifact", test: (path) => path.split("/").includes(".DS_Store") || /^\.(vscode|idea|git)\//.test(path) },
  { label: "installed dependency", test: (path) => path.split("/").includes("node_modules") },
  { label: "tarball", test: (path) => path.endsWith(".tgz") },
  { label: "agent instruction", test: (path) => path.split("/").includes("AGENTS.md") },
];

/** Lists every file in a tree as POSIX paths relative to `base`. */
async function walk(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else files.push(relative(base, full).split(sep).join("/"));
  }
  return files;
}

/**
 * Lists the tarball's own contents (not npm's report about them) with the
 * `package/` prefix stripped. The `tar` listing is authoritative; npm's
 * `--json` file list is the fallback for platforms without a `tar` binary.
 */
function tarballEntries(tarball, reported) {
  const listed = run("tar", ["-tzf", tarball]);
  if (listed.error || listed.status !== 0) {
    check(reported.length > 0, `cannot list ${tarball}: tar unavailable and npm reported no files\n${listed.stderr}`);
    return reported;
  }
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package/"))
    .map((line) => line.slice("package/".length))
    .filter((line) => line.length > 0 && !line.endsWith("/"));
}

/** Runs the installed executable through its PATH name, as an MCP client would. */
function runInstalled(args, env) {
  return run(["freeweb-mcp", ...args].join(" "), [], { env, shell: true });
}

/** Runs the installed executable and asserts its exit status. */
function expectInstalled(args, expected, env) {
  const result = runInstalled(args, env);
  check(
    result.status === expected,
    `expected \`freeweb-mcp ${args.join(" ")}\` to exit ${expected}, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

async function main() {
  const packDir = await mkdtemp(join(tmpdir(), "freeweb-pack-"));
  const installDir = await mkdtemp(join(tmpdir(), "freeweb-install-"));
  const homeDir = join(installDir, "home");
  const consumerDir = join(installDir, "consumer");
  try {
    // 1. Build the artifact a release would publish.
    const build = run(npm, ["run", "build"]);
    check(build.status === 0, `npm run build failed:\n${build.stdout}${build.stderr}`);
    const packed = run(npm, ["pack", "--pack-destination", packDir, "--json"]);
    check(packed.status === 0, `npm pack failed:\n${packed.stderr}`);
    const [packReport] = JSON.parse(packed.stdout);
    const tarball = join(packDir, packReport.filename);
    const reported = packReport.files.map((entry) => entry.path);

    // 2. Inspect the tarball itself, not package.json's intent.
    const entries = tarballEntries(tarball, reported);
    check(entries.length === reported.length, `tar listed ${entries.length} files but npm reported ${reported.length}`);
    for (const required of requiredEntries) {
      check(entries.includes(required), `the packed tarball is missing ${required}`);
    }
    check(
      !entries.some((entry) => entry.startsWith("dist/index.")),
      "the packed tarball still ships the removed library barrel (dist/index.*)",
    );
    for (const entry of entries) {
      for (const rule of forbidden) {
        check(!rule.test(entry), `the packed tarball ships a forbidden ${rule.label}: ${entry}`);
      }
    }
    console.log(`tarball ${packReport.filename}: ${entries.length} files, no source/test/editor artifacts`);

    // 3. Install that tarball into a prefix outside the repository, offline.
    const installed = run(npm, ["install", "--prefix", installDir, "--offline", "--no-audit", "--no-fund", tarball]);
    check(
      installed.status === 0,
      `offline install failed:\n${installed.stderr}\n(populate the local npm cache with \`npm install\` first; this verification never uses the network)`,
    );

    const packageDir = join(installDir, "node_modules", "freeweb-mcp");
    const packageFile = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    for (const field of ["main", "module", "types", "typings", "exports", "imports"]) {
      check(packageFile[field] === undefined, `the installed package still declares the library entry metadata \`${field}\``);
    }
    check(
      JSON.stringify(packageFile.bin) === JSON.stringify({ "freeweb-mcp": "./dist/cli.js" }),
      `the executable is not the sole package entry point: ${JSON.stringify(packageFile.bin)}`,
    );

    const installedFiles = await walk(packageDir);
    check(
      installedFiles.every((file) => !file.startsWith("tests/") && !file.startsWith("src/") && !file.endsWith(".ts")),
      "the installed package contains source or test files",
    );

    // 4. The executable is installed, linked, and runs the final command surface.
    const binDir = join(installDir, "node_modules", ".bin");
    const binPath = join(binDir, process.platform === "win32" ? "freeweb-mcp.cmd" : "freeweb-mcp");
    await stat(binPath);
    if (process.platform !== "win32") {
      const link = await readlink(binPath);
      check(
        resolve(binDir, link) === join(packageDir, "dist", "cli.js"),
        `the installed executable links to ${link}, not the packed dist/cli.js`,
      );
    }
    const cliPath = join(packageDir, "dist", "cli.js");
    const cliSource = await readFile(cliPath, "utf8");
    check(cliSource.startsWith("#!/usr/bin/env node\n"), "the packed dist/cli.js lost its executable shebang");
    if (process.platform !== "win32") {
      const mode = (await stat(cliPath)).mode & 0o777;
      check(mode === 0o755, `the installed executable is not executable (mode ${mode.toString(8)})`);
    }

    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
      PATH: [binDir, process.env.PATH ?? ""].join(pathSeparator),
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CONFIG_HOME: join(homeDir, ".config"),
      FREEWEB_CONFIG: join(homeDir, "missing-config.json"),
      FREEWEB_DATA_DIR: join(homeDir, "data"),
      FREEWEB_TINYFISH_FREE_ONLY_CONFIRMED: "false",
      TINYFISH_API_KEY: "",
    };
    await mkdir(homeDir, { recursive: true });

    for (const flag of ["--version", "-v"]) {
      const version = expectInstalled([flag], 0, env);
      check(
        version.stdout.trim() === packageFile.version,
        `\`freeweb-mcp ${flag}\` printed ${JSON.stringify(version.stdout)}, expected ${packageFile.version}`,
      );
    }

    const noArgs = expectInstalled([], 0, env);
    check(noArgs.stdout.includes("Usage: freeweb-mcp"), "no-argument invocation did not print help");
    for (const command of ["doctor", "init", "mcp", "print-config"]) {
      check(noArgs.stdout.includes(command), `the help output is missing the ${command} command`);
    }

    for (const [args, usage] of [
      [["help"], "Usage: freeweb-mcp"],
      [["--help"], "Usage: freeweb-mcp"],
      [["help", "mcp"], "Usage: freeweb-mcp mcp"],
      [["mcp", "--help"], "Usage: freeweb-mcp mcp"],
    ]) {
      const help = expectInstalled(args, 0, env);
      check(help.stdout.includes(usage), `\`freeweb-mcp ${args.join(" ")}\` did not print ${JSON.stringify(usage)}`);
    }

    const printConfig = expectInstalled(["print-config"], 0, env);
    const expectedConfig = { mcpServers: { freeweb: { command: "freeweb-mcp", args: ["mcp"] } } };
    check(
      printConfig.stdout === `${JSON.stringify(expectedConfig, null, 2)}\n`,
      `print-config emitted unexpected configuration:\n${printConfig.stdout}`,
    );

    // `doctor` runs against this machine's provider binaries, so its result
    // depends on the host; its contract does not: pure JSON on stdout, one
    // entry per check, and a status that matches the report.
    const doctor = runInstalled(["doctor", "--json"], env);
    const report = JSON.parse(doctor.stdout);
    check(Array.isArray(report.checks) && report.checks.length > 0, "doctor --json did not emit a report");
    for (const name of ["node", "firecrawl-local", "ego-browser", "tinyfish", "ego-platform", "data-directory"]) {
      check(report.checks.some((entry) => entry.name === name), `doctor --json is missing the ${name} check`);
    }
    check(
      report.checks.every((entry) => Object.hasOwn(entry, "ok") && Object.hasOwn(entry, "required")),
      "doctor --json emitted a check without its status",
    );
    check(
      report.checks.some((entry) => entry.name === "node" && entry.ok === true),
      "doctor --json did not accept the running Node.js version",
    );
    const doctorStatus = report.ok ? 0 : 1;
    check(doctor.status === doctorStatus, `doctor --json exited ${doctor.status} but reported ok=${report.ok}`);

    const doctorText = expectInstalled(["doctor"], doctorStatus, env);
    check(
      doctorText.stdout.includes(`Result: ${report.ok ? "ok" : "failed"}`),
      "doctor text output disagrees with the JSON report",
    );

    const secret = "freeweb-verify-secret";
    const secretDoctor = runInstalled(["doctor"], { ...env, TINYFISH_API_KEY: secret });
    check(!secretDoctor.stdout.includes(secret), "doctor printed the TinyFish key instead of redacting it");
    check(!secretDoctor.stderr.includes(secret), "doctor diagnostics printed the TinyFish key");
    check(secretDoctor.stdout.includes("[redacted]"), "doctor did not report a redacted TinyFish key");

    const unknown = expectInstalled(["nope"], 1, env);
    check(unknown.stdout === "", "an unknown command wrote to stdout");
    check(unknown.stderr.length > 0, "an unknown command wrote no diagnostic");

    // 5. The removed ESM library entry must not resolve. The consumer is a
    // project beside the installed package and never sees the repository.
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      join(consumerDir, "package.json"),
      `${JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2)}\n`,
    );
    const consumerEnv = { ...env, PATH: process.env.PATH ?? "" };
    const esmImport = run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "await import('freeweb-mcp').then(() => { console.log('RESOLVED'); }, (error) => { console.log(`FAILED ${error.code}: ${error.message}`); process.exitCode = 3; });",
      ],
      { cwd: consumerDir, env: consumerEnv },
    );
    check(
      esmImport.status === 3,
      `a consumer import of the package name still resolves:\n${esmImport.stdout}\n${esmImport.stderr}`,
    );
    check(
      /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_DIR_IMPORT/.test(esmImport.stdout),
      `unexpected library-import failure: ${esmImport.stdout}`,
    );

    const cjsRequire = run(
      process.execPath,
      [
        "-e",
        "try { require.resolve('freeweb-mcp'); console.log('RESOLVED'); } catch (error) { console.log(`FAILED ${error.code}`); process.exitCode = 3; }",
      ],
      { cwd: consumerDir, env: consumerEnv },
    );
    check(cjsRequire.status === 3, `require.resolve still finds a package entry:\n${cjsRequire.stdout}${cjsRequire.stderr}`);

    console.log(`library import of "freeweb-mcp": ${esmImport.stdout.trim()}`);
    console.log(`require.resolve("freeweb-mcp"): ${cjsRequire.stdout.trim()}`);
    console.log("verify:pack passed: packed tarball, offline install, CLI surface, and absent library entry all verified");
  } finally {
    await rm(packDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  }
}

await main();
