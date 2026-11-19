import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/server";
import { errorInfo } from "../errors.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";

export async function toolSuccess(output: Record<string, unknown>, artifactIds: string[] = [], artifacts?: ArtifactStore): Promise<CallToolResult> {
  const serialized = JSON.stringify(output);
  const text = serialized.length <= 100_000
    ? serialized
    : JSON.stringify({
        summary: "Large result omitted from the text block; use structuredContent and the linked Artifact Resources",
        structuredContentIncluded: true,
        artifactIds,
      });
  const content: ContentBlock[] = [{ type: "text", text }];
  for (const artifactId of artifactIds) {
    const descriptor = artifacts ? await artifacts.get(artifactId).catch(() => undefined) : undefined;
    content.push({
      type: "resource_link",
      uri: `freeweb://artifacts/${artifactId}`,
      name: `FreeWeb Artifact ${artifactId}`,
      description: "Complete or checkpointed tool result",
      mimeType: descriptor?.mimeType ?? "application/octet-stream",
    });
  }
  return { content, structuredContent: output };
}

export function toolFailure(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: errorInfo(error) }) }],
    isError: true,
  };
}

export function artifactIdsOf(output: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (typeof output.artifactId === "string") ids.push(output.artifactId);
  if (Array.isArray(output.artifactIds)) {
    for (const id of output.artifactIds) if (typeof id === "string") ids.push(id);
  }
  return ids;
}
