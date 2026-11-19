import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { FreeWebError } from "../errors.js";

export interface ArtifactDescriptor {
  id: string;
  uri: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: string;
  expiresAt: string;
}

interface ArtifactMetadata extends Omit<ArtifactDescriptor, "path"> {}

export class ArtifactStore {
  private readonly root: string;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();

  constructor(options: { root: string; retentionMs?: number; now?: () => number }) {
    this.root = resolve(options.root);
    this.retentionMs = options.retentionMs ?? 86_400_000;
    this.now = options.now ?? Date.now;
  }

  async save(options: {
    data: string | Buffer;
    mimeType: string;
    retentionMs?: number;
  }): Promise<ArtifactDescriptor> {
    const id = randomUUID();
    const data = Buffer.isBuffer(options.data) ? options.data : Buffer.from(options.data, "utf8");
    const created = this.now();
    // A directory that has no metadata yet is not a readable Artifact, so cleanup
    // must not mistake an in-progress save for an abandoned one.
    this.inFlight.add(id);
    try {
      const directory = await this.directory(id);
      const descriptor: ArtifactDescriptor = {
        id,
        uri: `freeweb://artifacts/${id}`,
        path: join(directory, "content"),
        mimeType: options.mimeType,
        size: data.byteLength,
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(created + (options.retentionMs ?? this.retentionMs)).toISOString(),
      };
      await writeFile(descriptor.path, data, { mode: 0o600 });
      const metadata: ArtifactMetadata = {
        id: descriptor.id,
        uri: descriptor.uri,
        mimeType: descriptor.mimeType,
        size: descriptor.size,
        createdAt: descriptor.createdAt,
        expiresAt: descriptor.expiresAt,
      };
      const metadataPath = join(directory, "metadata.json");
      const temporaryPath = join(directory, `metadata.tmp.${randomUUID()}.json`);
      try {
        await writeFile(temporaryPath, JSON.stringify(metadata), { mode: 0o600 });
        await rename(temporaryPath, metadataPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return descriptor;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async saveFile(options: {
    sourcePath: string;
    mimeType: string;
    retentionMs?: number;
  }): Promise<ArtifactDescriptor> {
    const id = randomUUID();
    const created = this.now();
    this.inFlight.add(id);
    try {
      const directory = await this.directory(id);
      const source = await stat(options.sourcePath);
      const descriptor: ArtifactDescriptor = {
        id,
        uri: `freeweb://artifacts/${id}`,
        path: join(directory, "content"),
        mimeType: options.mimeType,
        size: source.size,
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(created + (options.retentionMs ?? this.retentionMs)).toISOString(),
      };
      await copyFile(options.sourcePath, descriptor.path);
      await chmod(descriptor.path, 0o600);
      const metadataPath = join(directory, "metadata.json");
      const temporaryPath = join(directory, `metadata.tmp.${randomUUID()}.json`);
      try {
        await writeFile(temporaryPath, JSON.stringify({
          id: descriptor.id,
          uri: descriptor.uri,
          mimeType: descriptor.mimeType,
          size: descriptor.size,
          createdAt: descriptor.createdAt,
          expiresAt: descriptor.expiresAt,
        }), { mode: 0o600 });
        await rename(temporaryPath, metadataPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return descriptor;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async get(id: string): Promise<ArtifactDescriptor> {
    return this.descriptor(id);
  }

  async read(id: string): Promise<{ descriptor: ArtifactDescriptor; data: Buffer }> {
    const descriptor = await this.descriptor(id);
    try {
      return { descriptor, data: await readFile(descriptor.path) };
    } catch (error) {
      throw new FreeWebError("ARTIFACT_NOT_FOUND", "Artifact content does not exist", { cause: error });
    }
  }

  async readText(id: string): Promise<string> {
    return (await this.read(id)).data.toString("utf8");
  }

  async list(): Promise<ArtifactDescriptor[]> {
    const artifactsRoot = join(this.root, "artifacts");
    let entries;
    try { entries = await readdir(artifactsRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const descriptors = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try { return await this.descriptor(entry.name); }
        catch { return null; }
      }));
    return descriptors.filter((value): value is ArtifactDescriptor => value !== null);
  }

  async cleanup(): Promise<number> {
    const artifactsRoot = join(this.root, "artifacts");
    let entries;
    try { entries = await readdir(artifactsRoot, { withFileTypes: true }); }
    catch { return 0; }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (this.inFlight.has(entry.name)) continue;
      const directory = join(artifactsRoot, entry.name);
      let metadata: ArtifactMetadata | undefined;
      try {
        metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as ArtifactMetadata;
      } catch {
        metadata = undefined;
      }
      if (metadata && Number.isFinite(Date.parse(metadata.expiresAt))) {
        if (Date.parse(metadata.expiresAt) <= this.now()) {
          await rm(directory, { recursive: true, force: true });
          removed++;
        }
        continue;
      }
      // A directory without metadata is an abandoned write (crash or kill).
      // Age it by the directory mtime and give it a full retention window as
      // grace so a save that is still running is never deleted underneath.
      try {
        const info = await stat(directory);
        const age = this.now() - info.mtimeMs;
        if (age >= this.retentionMs) {
          await rm(directory, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // The directory disappeared while we were scanning; nothing to remove.
      }
    }
    return removed;
  }

  private async descriptor(id: string): Promise<ArtifactDescriptor> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new FreeWebError("ARTIFACT_NOT_FOUND", "Artifact does not exist");
    }
    const directory = join(this.root, "artifacts", id);
    let metadata: ArtifactMetadata;
    try { metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as ArtifactMetadata; }
    catch (error) { throw new FreeWebError("ARTIFACT_NOT_FOUND", "Artifact does not exist", { cause: error }); }
    if (
      metadata.id !== id
      || typeof metadata.mimeType !== "string"
      || !Number.isFinite(metadata.size)
      || !Number.isFinite(Date.parse(metadata.createdAt))
      || !Number.isFinite(Date.parse(metadata.expiresAt))
      || Date.parse(metadata.expiresAt) <= this.now()
    ) {
      throw new FreeWebError("ARTIFACT_NOT_FOUND", "Artifact metadata is invalid or the Artifact has expired");
    }
    try {
      const contentPath = await realpath(join(directory, "content"));
      const rootPath = await realpath(join(this.root, "artifacts"));
      if (basename(contentPath) !== "content" || !contentPath.startsWith(rootPath + sep)) {
        throw new FreeWebError("ARTIFACT_NOT_FOUND", "Artifact resolves outside its store");
      }
      return { ...metadata, path: contentPath };
    } catch (error) {
      if (error instanceof FreeWebError) throw error;
      throw new FreeWebError("ARTIFACT_NOT_FOUND", "Artifact content does not exist", { cause: error });
    }
  }

  private async directory(id: string): Promise<string> {
    const artifactsRoot = join(this.root, "artifacts");
    await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
    await chmod(artifactsRoot, 0o700);
    await stat(artifactsRoot);
    const directory = join(artifactsRoot, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return directory;
  }
}
