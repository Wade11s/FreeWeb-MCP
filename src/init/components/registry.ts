import type { InitComponent } from "../component.js";
import { createEgoComponent } from "./ego.js";
import { createFirecrawlComponent } from "./firecrawl.js";

/**
 * Production Initialization registration. Adding a provider is a new module
 * plus one entry here; the orchestrator has no provider-specific write path.
 */
export function registeredInitComponents(): readonly InitComponent[] {
  return [createFirecrawlComponent(), createEgoComponent()];
}
