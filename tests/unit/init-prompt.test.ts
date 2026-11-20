import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrompt } from "../../src/init/prompt.js";

function makePrompt(answers: readonly string[], interactive = true) {
  const input = new PassThrough();
  for (const answer of answers) input.write(`${answer}\n`);
  const written: string[] = [];
  return {
    prompt: createPrompt({ input, write: (chunk) => written.push(chunk), interactive }),
    input,
    written,
  };
}

describe("init prompt seam", () => {
  it("confirms y, Y, yes, and YES and declines everything else", async () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ["y", true], ["Y", true], ["yes", true], ["YES", true], ["Yes", true],
      ["n", false], ["no", false], ["N", false], ["", false], ["maybe", false],
    ];
    for (const [answer, expected] of cases) {
      const { prompt } = makePrompt([answer]);
      await expect(prompt.confirm("Proceed?"), `answer ${JSON.stringify(answer)}`).resolves.toBe(expected);
    }
  });

  it("answers sequential confirms from one buffered stream", async () => {
    const { prompt } = makePrompt(["n", "y"]);
    await expect(prompt.confirm("First?")).resolves.toBe(false);
    await expect(prompt.confirm("Second?")).resolves.toBe(true);
  });

  it("strips carriage returns from terminal input", async () => {
    const input = new PassThrough();
    const prompt = createPrompt({ input, write: () => {}, interactive: true });
    input.write("y\r\n");
    await expect(prompt.confirm("Proceed?")).resolves.toBe(true);
  });

  it("resolves pending and future confirms as declines when the stream ends", async () => {
    const { prompt, input } = makePrompt([]);
    const pending = prompt.confirm("Proceed?");
    input.end();
    await expect(pending).resolves.toBe(false);
    await expect(prompt.confirm("Another?")).resolves.toBe(false);
  });

  it("exposes the injected interactive flag without touching process streams", () => {
    expect(makePrompt([], false).prompt.interactive).toBe(false);
    expect(makePrompt([], true).prompt.interactive).toBe(true);
  });

  it("writes the question through the injected writer", async () => {
    const { prompt, written } = makePrompt(["y"]);
    await prompt.confirm("Proceed?");
    expect(written.join("")).toContain("Proceed?");
  });

  it("detaches from the input stream on close", async () => {
    const { prompt, input } = makePrompt(["y"]);
    await prompt.confirm("Proceed?");
    prompt.close();
    expect(input.listenerCount("data")).toBe(0);
    // A confirm after close can never hang: it resolves as a decline.
    await expect(prompt.confirm("After close?")).resolves.toBe(false);
  });
});
