import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";

let root: string;
let store: ArtifactStore;
let now = 1_000_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "freeweb-artifacts-"));
  store = new ArtifactStore({ root, retentionMs: 1000, now: () => now });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ArtifactStore public seam", () => {
  it("writes and reads a private text Artifact by ID", async () => {
    const saved = await store.save({ data: "hello world", mimeType: "text/plain" });

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.uri).toBe(`freeweb://artifacts/${saved.id}`);
    expect(saved.size).toBe(11);
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "artifacts"))).mode & 0o777).toBe(0o700);
    expect((await store.readText(saved.id)).toString()).toBe("hello world");
    expect(await readFile(saved.path, "utf8")).toBe("hello world");
  });

  it("round-trips binary data without UTF-8 conversion", async () => {
    const bytes = Buffer.from([0, 255, 1, 128, 42]);
    const saved = await store.save({ data: bytes, mimeType: "application/octet-stream" });

    const loaded = await store.read(saved.id);
    expect(loaded.data).toEqual(bytes);
    expect(loaded.descriptor.mimeType).toBe("application/octet-stream");
  });

  it("copies a file-backed Artifact without changing its bytes or size metadata", async () => {
    const source = join(root, "source.png");
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    await writeFile(source, bytes);

    const saved = await store.saveFile({ sourcePath: source, mimeType: "image/png" });
    const loaded = await store.read(saved.id);
    expect(loaded.data).toEqual(bytes);
    expect(loaded.descriptor.size).toBe(bytes.byteLength);
    expect(loaded.descriptor.mimeType).toBe("image/png");
  });

  it("rejects malformed IDs and path traversal", async () => {
    await expect(store.read("../../etc/passwd")).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    await expect(store.read("not-a-uuid")).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });

  it("lists unexpired Artifacts and removes expired Artifacts", async () => {
    const saved = await store.save({ data: "short lived", mimeType: "text/plain" });
    expect(await store.list()).toHaveLength(1);

    now += 1001;
    expect(await store.list()).toEqual([]);
    expect(await store.cleanup()).toBe(1);
    await expect(stat(saved.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ArtifactStore orphan cleanup", () => {
  beforeEach(() => { now = Date.now(); });

  it("removes abandoned directories without metadata once they age past retention", async () => {
    const orphan = join(root, "artifacts", randomUUID());
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "content"), "partial write", { mode: 0o600 });
    const aged = new Date(Date.now() - 60_000);
    await utimes(join(orphan, "content"), aged, aged);
    await utimes(orphan, aged, aged);

    store = new ArtifactStore({ root, retentionMs: 5_000 });

    expect(await store.cleanup()).toBe(1);
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a freshly written directory that has no metadata yet", async () => {
    const fresh = join(root, "artifacts", randomUUID());
    await mkdir(fresh, { recursive: true });
    await writeFile(join(fresh, "content"), "just started", { mode: 0o600 });

    store = new ArtifactStore({ root, retentionMs: 5_000 });

    expect(await store.cleanup()).toBe(0);
    expect((await stat(fresh)).isDirectory()).toBe(true);
    expect(await readFile(join(fresh, "content"), "utf8")).toBe("just started");
  });

  it("does not create a directory when reading a missing Artifact", async () => {
    const id = randomUUID();
    await expect(store.read(id)).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    await expect(stat(join(root, "artifacts", id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an Artifact whose metadata has an invalid expiry", async () => {
    const saved = await store.save({ data: "valid bytes", mimeType: "text/plain" });
    await writeFile(join(saved.path, "..", "metadata.json"), JSON.stringify({
      id: saved.id,
      uri: saved.uri,
      mimeType: saved.mimeType,
      size: saved.size,
      createdAt: saved.createdAt,
      expiresAt: "not-a-date",
    }));

    await expect(store.read(saved.id)).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });

  it("uses mtime cleanup when metadata has an invalid expiry", async () => {
    const orphan = join(root, "artifacts", randomUUID());
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "metadata.json"), JSON.stringify({ expiresAt: "not-a-date" }));
    const aged = new Date(Date.now() - 60_000);
    await utimes(orphan, aged, aged);

    expect(await store.cleanup()).toBe(1);
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps unexpired Artifacts while removing orphaned siblings", async () => {
    const saved = await store.save({ data: "keep me", mimeType: "text/plain" });
    const orphan = join(root, "artifacts", randomUUID());
    await mkdir(orphan, { recursive: true });
    const aged = new Date(Date.now() - 60_000);
    await utimes(orphan, aged, aged);

    expect(await store.cleanup()).toBe(1);
    expect((await store.readText(saved.id)).toString()).toBe("keep me");
  });
});
