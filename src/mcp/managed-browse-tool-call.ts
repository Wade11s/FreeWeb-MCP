import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/server";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { FreeWebError } from "../errors.js";
import { resolveEgoMethod } from "../providers/ego-methods.js";
import type { BrowseInput, BrowseOutput } from "../types.js";
import { artifactIdsOf, toolFailure, toolSuccess } from "./results.js";

export class ManagedBrowseToolCall {
  private readonly browse: (input: BrowseInput) => Promise<BrowseOutput>;
  private readonly artifacts: ArtifactStore;
  private readonly dataDir: string;
  private readonly screenshotMaxBytes: number;

  constructor(options: {
    browse: (input: BrowseInput) => Promise<BrowseOutput>;
    artifacts: ArtifactStore;
    dataDir: string;
    screenshotMaxBytes: number;
  }) {
    this.browse = options.browse;
    this.artifacts = options.artifacts;
    this.dataDir = options.dataDir;
    this.screenshotMaxBytes = options.screenshotMaxBytes;
  }

  async run(input: BrowseInput): Promise<CallToolResult> {
    try {
      const output = await this.browse(input);
      let image: ContentBlock | undefined;
      if (input.action === "call" && input.method && resolveEgoMethod(input.method)?.canonical === "page.screenshot") {
        try {
          image = await this.screenshot(output.result);
        } catch (error) {
          output.warnings = [
            ...(output.warnings ?? []),
            `Screenshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
          ];
        }
      }
      const result = await toolSuccess(output, artifactIdsOf(output), this.artifacts);
      if (image) result.content.push(image);
      return result;
    } catch (error) {
      return toolFailure(error);
    }
  }

  private async screenshot(result: unknown): Promise<ContentBlock | undefined> {
    const candidate = typeof result === "string"
      ? result
      : typeof result === "object" && result !== null && "path" in result && typeof result.path === "string"
        ? result.path
        : undefined;
    if (!candidate?.endsWith(".png")) return undefined;
    const resolved = await realpath(candidate);
    const inside = (root: string, path: string) => {
      const rel = relative(root, path);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    const downloads = await realpath(join(this.dataDir, "downloads")).catch(() => undefined);
    const temporary = await realpath(tmpdir());
    const allowed = (downloads && inside(downloads, resolved))
      || (dirname(resolved) === temporary && basename(resolved).startsWith("ego-browser-shot-"));
    if (!allowed) {
      throw new FreeWebError("EGO_PATH_FORBIDDEN", "Screenshot path is outside managed downloads and ego temporary screenshots", { provider: "ego-lite" });
    }
    const info = await stat(resolved);
    if (info.size <= this.screenshotMaxBytes) {
      const data = await readFile(resolved);
      return { type: "image", data: data.toString("base64"), mimeType: "image/png" };
    }
    const artifact = await this.artifacts.saveFile({ sourcePath: resolved, mimeType: "image/png" });
    return {
      type: "resource_link",
      uri: artifact.uri,
      name: "ego-lite screenshot",
      description: "Screenshot exceeded the inline image budget",
      mimeType: "image/png",
    };
  }
}
