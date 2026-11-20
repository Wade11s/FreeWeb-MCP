import { unlink } from "node:fs/promises";
import type { BrowseOutput, CrawlOutput, FetchOutput, MapOutput } from "../types.js";
import { ArtifactStore, type ArtifactDescriptor } from "./artifact-store.js";

export interface FetchPublicationRequest {
  kind: "fetch";
  results: FetchOutput["results"];
  inlinePageChars: number;
  inlineTotalChars: number;
}

export interface FetchPublicationResult {
  results: FetchOutput["results"];
  artifactIds?: string[];
}

export interface MapPublicationRequest {
  kind: "map";
  links: MapOutput["links"];
  inlineTotalChars: number;
}

export interface MapPublicationResult {
  links: MapOutput["links"];
  truncated: boolean;
  artifactId?: string;
}

export interface CrawlPreviewRequest {
  kind: "crawl-preview";
  pages: CrawlOutput["pages"];
  offset: number;
  limit: number;
  maxCharsPerPage: number;
  inlineTotalChars: number;
}

export interface CrawlPreviewResult {
  pages: CrawlOutput["pages"];
  inlineBudgetHit: boolean;
}

export interface CrawlCheckpointRequest {
  kind: "crawl-checkpoint";
  source: unknown;
}

export type CrawlCheckpointResult = ArtifactDescriptor;

/**
 * A managed run too large for the runner's bounded stdout handed its payload over as a file.
 * The caller has already proven the path is the one it allocated, so only the storage
 * mechanics belong here: save, clean up, and rewrite the summary in place.
 */
export interface ManagedHandoffRequest {
  kind: "managed-handoff";
  /** The managed payload whose `artifactPath`/`artifactBytes` are consumed. */
  payload: Record<string, unknown>;
  /** Absolute hand-off file the caller validated against its allocation. */
  sourcePath: string;
}

export interface ManagedHandoffResult {
  /** The same payload object, rewritten with the provider-owned hand-off Artifact ID. */
  payload: Record<string, unknown>;
}

/** A complete Browse output that replaces its inline result when it exceeds the budget. */
export interface ManagedOutputRequest {
  kind: "managed-output";
  output: BrowseOutput;
  inlineTotalChars: number;
}

export interface ManagedOutputResult {
  output: BrowseOutput;
}

/**
 * A completed unrestricted Node run. The full runner output is always stored; only the
 * returned preview shares one inline budget across stdout and stderr.
 */
export interface UnrestrictedOutputRequest {
  kind: "unrestricted-output";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  durationMs: number;
  timedOut: boolean;
  inlineNodeChars: number;
}

export interface UnrestrictedOutputResult {
  stdout: string;
  stderr: string;
  artifactId: string;
}

export type ArtifactPublicationRequest =
  | FetchPublicationRequest
  | MapPublicationRequest
  | CrawlPreviewRequest
  | CrawlCheckpointRequest
  | ManagedHandoffRequest
  | ManagedOutputRequest
  | UnrestrictedOutputRequest;
export type ArtifactPublicationResult =
  | FetchPublicationResult
  | MapPublicationResult
  | CrawlPreviewResult
  | CrawlCheckpointResult
  | ManagedHandoffResult
  | ManagedOutputResult
  | UnrestrictedOutputResult;

const MANAGED_OUTPUT_SUMMARY = "Large Browse result is available as an Artifact";
const INLINE_TRUNCATION_MARKER = "\n[truncated]";

export class ArtifactOutput {
  constructor(private readonly artifacts: ArtifactStore) {}

  async publish(request: FetchPublicationRequest): Promise<FetchPublicationResult>;
  async publish(request: MapPublicationRequest): Promise<MapPublicationResult>;
  async publish(request: CrawlPreviewRequest): Promise<CrawlPreviewResult>;
  async publish(request: CrawlCheckpointRequest): Promise<CrawlCheckpointResult>;
  async publish(request: ManagedHandoffRequest): Promise<ManagedHandoffResult>;
  async publish(request: ManagedOutputRequest): Promise<ManagedOutputResult>;
  async publish(request: UnrestrictedOutputRequest): Promise<UnrestrictedOutputResult>;
  async publish(request: ArtifactPublicationRequest): Promise<ArtifactPublicationResult> {
    switch (request.kind) {
      case "fetch":
        return this.publishFetch(request);
      case "map":
        return this.publishMap(request);
      case "crawl-preview":
        return this.publishCrawlPreview(request);
      case "crawl-checkpoint":
        return this.publishCrawlCheckpoint(request);
      case "managed-handoff":
        return this.publishManagedHandoff(request);
      case "managed-output":
        return this.publishManagedOutput(request);
      case "unrestricted-output":
        return this.publishUnrestrictedOutput(request);
    }
  }

  private async publishFetch(request: FetchPublicationRequest): Promise<FetchPublicationResult> {
    const artifactIds: string[] = [];
    let remainingTotal = request.inlineTotalChars;
    const budgetedResults: FetchOutput["results"] = [];
    for (const originalPage of request.results) {
      let page = originalPage;
      const screenshot = this.decodeScreenshot(page.formats.screenshot);
      if (screenshot) {
        const artifact = await this.artifacts.save({ data: screenshot.data, mimeType: screenshot.mimeType });
        artifactIds.push(artifact.id);
        const formats = { ...page.formats };
        delete formats.screenshot;
        page = { ...page, formats, screenshotArtifactId: artifact.id };
      }
      const originalLength = Object.values(page.formats).reduce<number>((sum, value) => sum + this.fetchValueChars(value), 0)
        + (page.links ? this.fetchValueChars(page.links) : 0);
      const budget = Math.min(request.inlinePageChars, remainingTotal);
      if (originalLength > budget) {
        const artifact = await this.artifacts.save({ data: JSON.stringify(page), mimeType: "application/json" });
        artifactIds.push(artifact.id);
        let remaining = budget;
        let truncated = false;
        const formats: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(page.formats)) {
          if (typeof value === "string") {
            formats[key] = value.slice(0, remaining);
            truncated ||= value.length > remaining;
            remaining = Math.max(0, remaining - value.length);
          } else {
            const serialized = JSON.stringify(value) ?? "";
            if (serialized.length <= remaining) {
              formats[key] = value;
            } else {
              formats[key] = serialized.slice(0, remaining);
              truncated = true;
            }
            remaining = Math.max(0, remaining - serialized.length);
          }
        }
        let links = page.links;
        if (links) {
          const serializedLinks = JSON.stringify(links);
          if (serializedLinks.length <= remaining) {
            remaining -= serializedLinks.length;
          } else {
            const kept: string[] = [];
            let linkChars = 2;
            for (const link of links) {
              linkChars += link.length + 3;
              if (linkChars > remaining) break;
              kept.push(link);
            }
            links = kept;
            truncated = true;
          }
        }
        budgetedResults.push({ ...page, formats, ...(links ? { links } : { links: undefined }), truncated: true });
      } else {
        budgetedResults.push(page);
      }
      remainingTotal = Math.max(0, remainingTotal - Math.min(originalLength, budget));
    }
    return { results: budgetedResults, artifactIds: artifactIds.length ? artifactIds : undefined };
  }

  private fetchValueChars(value: unknown): number {
    return typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0);
  }

  private decodeScreenshot(value: unknown): { data: Buffer; mimeType: string } | undefined {
    if (typeof value !== "string") return undefined;
    const dataUrl = value.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s);
    const base64 = dataUrl?.[2] ?? value;
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64) || base64.length < 16) return undefined;
    const data = Buffer.from(base64, "base64");
    const mimeType = dataUrl?.[1]
      ?? (data[0] === 0x89 && data[1] === 0x50 ? "image/png"
        : data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg"
          : data.subarray(0, 4).toString() === "GIF8" ? "image/gif"
            : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP" ? "image/webp"
              : undefined);
    return mimeType ? { data, mimeType } : undefined;
  }

  private async publishMap(request: MapPublicationRequest): Promise<MapPublicationResult> {
    const inline: MapOutput["links"] = [];
    let size = 20;
    for (const link of request.links) {
      size += link.url.length + 20;
      if (size > request.inlineTotalChars) break;
      inline.push(link);
    }
    if (inline.length === request.links.length) {
      return { links: request.links, truncated: false };
    }
    const artifact = await this.artifacts.save({ data: JSON.stringify({ links: request.links }), mimeType: "application/json" });
    return { links: inline, artifactId: artifact.id, truncated: true };
  }

  private async publishCrawlPreview(request: CrawlPreviewRequest): Promise<CrawlPreviewResult> {
    const pages: CrawlOutput["pages"] = [];
    let remainingTotal = request.inlineTotalChars;
    let inlineBudgetHit = false;
    for (const page of request.pages.slice(request.offset, request.offset + request.limit)) {
      if (remainingTotal <= 0) {
        inlineBudgetHit = true;
        break;
      }
      const allowance = Math.min(request.maxCharsPerPage, remainingTotal);
      const truncatedPage = this.truncateCrawlPage(page, allowance);
      pages.push(truncatedPage);
      remainingTotal -= this.crawlInlineChars(truncatedPage);
      if (truncatedPage.truncated && allowance < request.maxCharsPerPage) inlineBudgetHit = true;
    }
    return { pages, inlineBudgetHit };
  }

  private crawlInlineChars(page: CrawlOutput["pages"][number]): number {
    let total = 0;
    for (const value of Object.values(page.formats)) {
      total += typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0);
    }
    if (page.links) total += JSON.stringify(page.links)?.length ?? 0;
    return total;
  }

  private truncateCrawlPage(page: CrawlOutput["pages"][number], maxChars: number): CrawlOutput["pages"][number] {
    let remaining = maxChars;
    let truncated = false;
    const formats: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(page.formats)) {
      if (typeof value !== "string") {
        const serialized = JSON.stringify(value) ?? "";
        if (serialized.length <= remaining) {
          formats[key] = value;
          remaining -= serialized.length;
        } else {
          formats[key] = serialized.slice(0, remaining);
          remaining = 0;
          truncated = true;
        }
      } else if (value.length <= remaining) {
        formats[key] = value;
        remaining -= value.length;
      } else {
        formats[key] = value.slice(0, remaining);
        remaining = 0;
        truncated = true;
      }
    }
    let links = page.links;
    if (links) {
      const serialized = JSON.stringify(links) ?? "";
      if (serialized.length <= remaining) {
        remaining -= serialized.length;
      } else {
        const kept: string[] = [];
        let linkChars = 2;
        for (const link of links) {
          linkChars += link.length + 3;
          if (linkChars > remaining) break;
          kept.push(link);
        }
        links = kept;
        remaining = 0;
        truncated = true;
      }
    }
    return {
      ...page,
      formats,
      ...(links ? { links } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  private async publishCrawlCheckpoint(request: CrawlCheckpointRequest): Promise<CrawlCheckpointResult> {
    return this.artifacts.save({ data: JSON.stringify(request.source), mimeType: "application/json" });
  }

  /**
   * Registers the hand-off file as a real Artifact and deletes the copy so the bytes live in
   * exactly one place with the usual retention rules. Save failures propagate raw: the caller
   * owns their error policy. The unlink never depends on success, because a failed save would
   * otherwise leave the full payload on disk forever.
   */
  private async publishManagedHandoff(request: ManagedHandoffRequest): Promise<ManagedHandoffResult> {
    const { payload } = request;
    const declaredBytes = typeof payload.artifactBytes === "number" ? payload.artifactBytes : undefined;
    try {
      const descriptor = await this.artifacts.saveFile({ sourcePath: request.sourcePath, mimeType: "application/json" });
      delete payload.artifactPath;
      delete payload.artifactBytes;
      // Provider-owned: set only after the bytes were really stored as an Artifact, so a
      // page-supplied `value.artifactId` is never promoted to a resource link.
      payload.handoffArtifactId = descriptor.id;
      payload.value = {
        truncated: payload.truncated === true,
        bytes: declaredBytes ?? descriptor.size,
        artifactId: descriptor.id,
      };
    } finally {
      await unlink(request.sourcePath).catch(() => undefined);
    }
    return { payload };
  }

  /**
   * A Browse output that would not fit the inline budget is stored complete, then replaced by
   * the usual summary. The saved bytes are the output as it stands, including a hand-off
   * Artifact ID the provider already published.
   */
  private async publishManagedOutput(request: ManagedOutputRequest): Promise<ManagedOutputResult> {
    const serialized = JSON.stringify(request.output);
    if (serialized.length <= request.inlineTotalChars) return { output: request.output };
    const artifact = await this.artifacts.save({ data: serialized, mimeType: "application/json" });
    return {
      output: {
        ...request.output,
        result: {
          summary: MANAGED_OUTPUT_SUMMARY,
          artifactId: artifact.id,
          originalChars: serialized.length,
        },
        artifactId: artifact.id,
      },
    };
  }

  /**
   * Save the complete run before computing any preview. A short run or a clean exit is still
   * an Artifact, and a save failure propagates before the caller can see a bounded result.
   */
  private async publishUnrestrictedOutput(request: UnrestrictedOutputRequest): Promise<UnrestrictedOutputResult> {
    const artifact = await this.artifacts.save({
      data: JSON.stringify({
        stdout: request.stdout,
        stderr: request.stderr,
        exitCode: request.exitCode,
        signal: request.signal ?? null,
        durationMs: request.durationMs,
        timedOut: request.timedOut,
      }),
      mimeType: "application/json",
    });
    return {
      ...this.inlineStreams(request.stdout, request.stderr, request.inlineNodeChars),
      artifactId: artifact.id,
    };
  }

  private truncateOutput(value: string, limit: number): string {
    if (value.length <= limit) return value;
    const room = Math.max(0, limit - INLINE_TRUNCATION_MARKER.length);
    return `${value.slice(0, room)}${INLINE_TRUNCATION_MARKER}`.slice(0, Math.max(0, limit));
  }

  /**
   * Splits one inline budget across stdout and stderr. The artifact keeps both streams
   * verbatim; only the returned preview is bounded, and it never exceeds `limit`.
   */
  private inlineStreams(stdout: string, stderr: string, limit: number): { stdout: string; stderr: string } {
    if (stdout.length + stderr.length <= limit) return { stdout, stderr };
    let stdoutLimit = Math.min(stdout.length, Math.floor(limit / 2));
    let stderrLimit = Math.min(stderr.length, limit - stdoutLimit);
    const spare = limit - stdoutLimit - stderrLimit;
    if (spare > 0) {
      const extraStdout = Math.min(stdout.length - stdoutLimit, spare);
      stdoutLimit += extraStdout;
      stderrLimit += Math.min(stderr.length - stderrLimit, spare - extraStdout);
    }
    return { stdout: this.truncateOutput(stdout, stdoutLimit), stderr: this.truncateOutput(stderr, stderrLimit) };
  }
}
