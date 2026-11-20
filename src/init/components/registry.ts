import type { InitComponent } from "../component.js";
import { createFirecrawlComponent } from "./firecrawl.js";
import { createTinyFishComponent } from "./tinyfish.js";

/**
 * Production Initialization registration. Adding a provider is a new module
 * plus one entry here; the orchestrator has no provider-specific write path.
 */
export function registeredInitComponents(): readonly InitComponent[] {
  return [createFirecrawlComponent(), createTinyFishComponent()];
}
