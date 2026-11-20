import { describe, expect, it } from "vitest";
import type { ConfigClassification } from "../../src/init/config-store.js";
import { createTinyFishComponent, TINYFISH_FREE_ATTESTATION } from "../../src/init/components/tinyfish.js";
import type { InitIo } from "../../src/init/prompt.js";
import { initRunSummary, type InitComponentResult } from "../../src/init/outcomes.js";

function fakeIo(answers: readonly boolean[]): InitIo & { readonly questions: readonly string[] } {
  const remaining = [...answers];
  const questions: string[] = [];
  return {
    prompt: {
      interactive: true,
      confirm: async (question) => {
        questions.push(question);
        return remaining.shift() ?? false;
      },
      close: () => {},
    },
    writeLine: () => {},
    errorLine: () => {},
    questions,
  };
}

async function executeTinyFish(
  env: NodeJS.ProcessEnv,
  classification: ConfigClassification,
  answers: readonly boolean[],
) {
  const component = createTinyFishComponent();
  const detection = await component.detect(env, classification);
  const io = fakeIo(answers);
  const result = await component.execute({ io, env, detection, appliedRepairs: [] });
  return { component, detection, io, result };
}

describe("TinyFish Initialization", () => {
  it("records only the explicit Free attestation when the environment key is present", async () => {
    const secret = "unit-tinyfish-key-must-never-be-rendered";
    const { result, io } = await executeTinyFish(
      { TINYFISH_API_KEY: secret },
      { status: "absent" },
      [true, true],
    );

    expect(result.outcome).toBe("Configured");
    expect(result.required).toBe(false);
    expect(result.selected).toBe(true);
    expect(result.configPatches).toEqual([{ setting: "tinyfish.freeOnlyConfirmed", value: true }]);
    expect(io.questions.some((question) => question.includes(TINYFISH_FREE_ATTESTATION))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(io.questions.join("\n")).not.toContain(secret);
  });

  it("shows the complete Free meaning in the plan and never derives attestation from detection", async () => {
    const component = createTinyFishComponent();
    const secret = "unit-tinyfish-plan-secret";
    const detection = await component.detect({ TINYFISH_API_KEY: secret }, { status: "absent" });
    const items = component.plan(detection);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ component: "tinyfish", required: false, selected: true });
    expect(items[0]!.description).toContain(TINYFISH_FREE_ATTESTATION);
    expect(items[0]!.description).toContain("never install or invoke the global TinyFish CLI");
    expect(items[0]!.description).toContain("never enable Firecrawl Search Fallback");
    expect(TINYFISH_FREE_ATTESTATION).toContain("no wallet spending capability");
    expect(TINYFISH_FREE_ATTESTATION).toContain("free credits, a zero balance, disabled auto-reload, and installation success are not substitutes");
    expect(detection.configPatches).toBeUndefined();
    expect(JSON.stringify({ detection, items })).not.toContain(secret);
  });

  it("keeps TinyFish Pending after attestation when the environment credential is missing", async () => {
    const { result } = await executeTinyFish({}, { status: "absent" }, [true, true]);

    expect(result.outcome).toBe("Pending");
    expect(result.detail).toContain("TINYFISH_API_KEY is not set");
    expect(result.detail).toContain("environment of the process that runs FreeWeb-MCP");
    expect(result.configPatches).toEqual([{ setting: "tinyfish.freeOnlyConfirmed", value: true }]);
  });

  it("does not enable TinyFish when the attestation is declined", async () => {
    const { result } = await executeTinyFish(
      { TINYFISH_API_KEY: "unit-tinyfish-declined-secret" },
      { status: "absent" },
      [true, false],
    );

    expect(result.outcome).toBe("Pending");
    expect(result.detail).toContain("attestation was not confirmed");
    expect(result.configPatches).toBeUndefined();
  });

  it("skips optional setup without changing configuration or blocking the required baseline", async () => {
    const { result } = await executeTinyFish(
      { TINYFISH_API_KEY: "unit-tinyfish-skipped-secret" },
      { status: "absent" },
      [false],
    );

    expect(result.outcome).toBe("Skipped");
    expect(result.required).toBe(false);
    expect(result.configPatches).toBeUndefined();
    expect(result.detail).toContain("Firecrawl Search Fallback was not enabled");
  });

  it("is idempotent when a previous run recorded the attestation", async () => {
    const { result, io } = await executeTinyFish(
      { TINYFISH_API_KEY: "unit-tinyfish-rerun-secret" },
      { status: "ok", raw: { tinyfish: { freeOnlyConfirmed: true } } },
      [],
    );

    expect(result.outcome).toBe("Configured");
    expect(result.configPatches).toBeUndefined();
    expect(io.questions).toEqual([]);
  });

  it("keeps an existing attestation Pending until the manual environment step is completed", async () => {
    const { result, io } = await executeTinyFish(
      {},
      { status: "ok", raw: { tinyfish: { freeOnlyConfirmed: true } } },
      [],
    );

    expect(result.outcome).toBe("Pending");
    expect(result.detail).toContain("TINYFISH_API_KEY is not set");
    expect(io.questions).toEqual([]);
  });

  it("classifies a setup prompt failure as Failed without a configuration patch", async () => {
    const component = createTinyFishComponent();
    const env = { TINYFISH_API_KEY: "unit-tinyfish-failure-secret" };
    const detection = await component.detect(env, { status: "absent" });
    let prompts = 0;
    const io: InitIo = {
      prompt: {
        interactive: true,
        confirm: async () => {
          prompts += 1;
          if (prompts === 2) throw new Error("simulated terminal failure");
          return true;
        },
        close: () => {},
      },
      writeLine: () => {},
      errorLine: () => {},
    };

    const result = await component.execute({ io, env, detection, appliedRepairs: [] });
    expect(result.outcome).toBe("Failed");
    expect(result.detail).toContain("simulated terminal failure");
    expect(result.configPatches).toBeUndefined();
    const requiredBaseline: InitComponentResult[] = [
      { component: "firecrawl", label: "Firecrawl Local", outcome: "Installed", required: true, selected: true, warnings: [], detail: "ready" },
      { component: "configuration", label: "Configuration", outcome: "Configured", required: true, selected: true, warnings: [], detail: "ready" },
    ];
    expect(initRunSummary([...requiredBaseline, result]).exitCode).toBe(1);
  });
});
