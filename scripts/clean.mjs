#!/usr/bin/env node
// Removes the compiled output so a build can never ship modules whose sources
// are gone. `tsc` only writes files; it does not prune them, so without this
// step a deleted source module would keep living in `dist/` and reach the
// published tarball through the `files` list.
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

rmSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist"), { recursive: true, force: true });
