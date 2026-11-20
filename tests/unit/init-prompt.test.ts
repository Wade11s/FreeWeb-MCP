import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrompt, type InitChoice } from "../../src/init/prompt.js";

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

const runOrQuit: readonly InitChoice[] = [{ id: "run", label: "Run" }, { id: "quit", label: "Quit" }];

describe("init prompt seam", () => {
  it("answers sequential numbered choices from one buffered stream", async () => {
    const { prompt } = makePrompt(["n", "y"]);
    await expect(prompt.choose("First?", runOrQuit, "quit")).resolves.toBe("quit");
    await expect(prompt.choose("Second?", runOrQuit, "quit")).resolves.toBe("run");
  });

  it("supports case-insensitive legacy yes/no answers", async () => {
    for (const answer of ["y", "Y", "yes", "YES", "Yes"]) {
      await expect(makePrompt([answer]).prompt.choose("Continue?", runOrQuit, "quit")).resolves.toBe("run");
    }
    for (const answer of ["n", "N", "no", "NO", ""]) {
      await expect(makePrompt([answer]).prompt.choose("Continue?", runOrQuit, "quit")).resolves.toBe("quit");
    }
  });

  it("strips carriage returns from terminal input", async () => {
    const input = new PassThrough();
    const prompt = createPrompt({ input, write: () => {}, interactive: true });
    input.write("y\r\n");
    await expect(prompt.choose("Continue?", runOrQuit, "quit")).resolves.toBe("run");
  });

  it("exposes the injected interactive flag without touching process streams", () => {
    expect(makePrompt([], false).prompt.interactive).toBe(false);
    expect(makePrompt([], true).prompt.interactive).toBe(true);
  });

  it("writes the question through the injected writer", async () => {
    const { prompt, written } = makePrompt(["y"]);
    await prompt.choose("Proceed?", runOrQuit, "quit");
    expect(written.join("")).toContain("Proceed?");
  });

  it("detaches from the input stream on close", async () => {
    const { prompt, input } = makePrompt(["y"]);
    await prompt.choose("Proceed?", runOrQuit, "quit");
    prompt.close();
    expect(input.listenerCount("data")).toBe(0);
    // A choice after close can never hang: it resolves as the safe default.
    await expect(prompt.choose("After close?", runOrQuit, "quit")).resolves.toBe("quit");
  });

  it("renders numbered choices and returns stable ids", async () => {
    const { prompt, written } = makePrompt(["2"]);
    const choices = [{ id: "run", label: "Run setup" }, { id: "skip", label: "Skip safely" }];
    await expect(prompt.choose("TinyFish", choices, "skip")).resolves.toBe("skip");
    const output = written.join("");
    expect(output).toContain("1) Run setup");
    expect(output).toContain("2) Skip safely [default]");
    expect(output).toContain("Choose [1-2] (2):");
  });

  it("uses the safe default for empty input, EOF, and after close", async () => {
    const blank = makePrompt([""]);
    await expect(blank.prompt.choose("Continue?", runOrQuit, "quit")).resolves.toBe("quit");

    const ended = makePrompt([]);
    const pending = ended.prompt.choose("Continue?", runOrQuit, "quit");
    ended.input.end();
    await expect(pending).resolves.toBe("quit");
    ended.prompt.close();
    await expect(ended.prompt.choose("After close?", runOrQuit, "quit")).resolves.toBe("quit");
  });

  it("explains invalid choices and asks again without losing buffered answers", async () => {
    const { prompt, written } = makePrompt(["maybe", "1"]);
    await expect(prompt.choose("Continue?", runOrQuit, "quit")).resolves.toBe("run");
    expect(written.join("")).toContain("Please enter a number from 1 to 2");
  });

  it("supports q and legacy y/n without changing the safe default", async () => {
    await expect(makePrompt(["q"]).prompt.choose("Continue?", runOrQuit, "quit")).resolves.toBe("quit");
    await expect(makePrompt(["y"]).prompt.choose("Continue?", runOrQuit, "quit")).resolves.toBe("run");
    await expect(makePrompt(["n"]).prompt.choose("Continue?", runOrQuit, "quit")).resolves.toBe("quit");
  });

  it("maps legacy y to Continue instead of Retry on failure menus", async () => {
    const choices: readonly InitChoice[] = [
      { id: "retry", label: "Retry this step" },
      { id: "continue", label: "Continue safely" },
      { id: "quit", label: "Quit" },
    ];
    const { prompt } = makePrompt(["y"]);
    await expect(prompt.choose("This step failed", choices, "continue", { legacyYes: "default" }))
      .resolves.toBe("continue");
  });
});
