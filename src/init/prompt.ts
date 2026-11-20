/**
 * All interactive Initialization IO lives behind these injected-stream
 * seams, so tests drive choices without a real TTY. The real terminal
 * decision (`process.stdin` plus the selected human-output stream's isTTY) is
 * made exactly once, at the CLI command boundary, and injected here as a plain boolean; nothing in
 * `src/init/` touches the real process streams.
 */

/** One numbered choice. Ids are stable within a question; labels are human text. */
export interface InitChoice {
  readonly id: string;
  readonly label: string;
}

/** Optional compatibility behavior for one numbered question. */
export interface InitChoiceOptions {
  /** Legacy y/yes selects the first action by default, or the safe default on failure menus. */
  readonly legacyYes?: "first" | "default";
}

/** Numbered-choice seam backed by an injected input stream. */
export interface InitPrompt {
  /** True only when the command boundary decided both ends are a terminal. */
  readonly interactive: boolean;
  /**
   * Asks a numbered question. Empty input and EOF select the caller's safe
   * default; invalid input is explained and asked again. `q` selects a choice
   * whose id is `quit`, when present. Legacy n/no selects the safe default;
   * y/yes selects the first or safe-default choice as specified by options.
   */
  choose(
    question: string,
    choices: readonly InitChoice[],
    defaultId: string,
    options?: InitChoiceOptions,
  ): Promise<string>;
  /** Detaches from the input stream so the process can exit when done. */
  close(): void;
}

/** Everything the prompt needs; no member touches the real process streams. */
export interface PromptDeps {
  readonly input: NodeJS.ReadableStream;
  readonly write: (text: string) => void;
  readonly interactive: boolean;
}

/** Human-facing output seams for one Initialization run. */
export interface InitIo {
  readonly prompt: InitPrompt;
  /** Progress, current-step, and summary lines (stdout in text mode). */
  writeLine(line: string): void;
  /** Diagnostics (stderr in the real CLI). */
  errorLine(line: string): void;
}

/**
 * Reads newline-delimited answers from one stream across many questions,
 * buffering leftover input so consecutive questions each get their own line.
 */
class LineReader {
  private buffer = "";
  private readonly waiters: Array<(line: string) => void> = [];
  private started = false;
  private ended = false;
  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString();
    this.drain();
  };
  private readonly onFinish = (): void => this.finish();

  constructor(private readonly input: NodeJS.ReadableStream) {}

  read(): Promise<string> {
    if (this.ended) return Promise.resolve("");
    this.start();
    return new Promise<string>((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  /** Detaches listeners and pauses/unrefs the stream so the owning process can exit. */
  stop(): void {
    this.finish();
    if (!this.started) return;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onFinish);
    this.input.removeListener("close", this.onFinish);
    this.input.removeListener("error", this.onFinish);
    this.input.pause();
    (this.input as NodeJS.ReadableStream & { unref?(): void }).unref?.();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("end", this.onFinish);
    this.input.on("close", this.onFinish);
    this.input.on("error", this.onFinish);
    this.input.resume();
  }

  /**
   * A closed stream answers the pending question with any leftover partial
   * line and every later question with "" — which every prompt reads as its
   * safe default, so a closed terminal can never be mistaken for consent.
   */
  private finish(): void {
    this.ended = true;
    const leftover = this.buffer;
    this.buffer = "";
    const waiters = [...this.waiters];
    this.waiters.length = 0;
    for (const [index, resolve] of waiters.entries()) resolve(index === 0 ? leftover : "");
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.waiters.shift()!(line);
    }
  }
}

function normalized(line: string): string {
  return line.replace(/\r+$/, "").trim().toLowerCase();
}

function renderChoices(
  question: string,
  choices: readonly InitChoice[],
  defaultId: string,
): string {
  const lines = [question];
  for (const [index, choice] of choices.entries()) {
    lines.push(`  ${index + 1}) ${choice.label}${choice.id === defaultId ? " [default]" : ""}`);
  }
  lines.push(`Choose [1-${choices.length}] (${choices.findIndex((choice) => choice.id === defaultId) + 1}): `);
  return `${lines.join("\n")}\n`;
}

export function createPrompt(deps: PromptDeps): InitPrompt {
  const reader = new LineReader(deps.input);
  return {
    interactive: deps.interactive,
    async choose(question, choices, defaultId, options): Promise<string> {
      if (choices.length === 0 || !choices.some((choice) => choice.id === defaultId)) {
        throw new Error("A prompt needs at least one choice and a valid default choice");
      }
      for (;;) {
        deps.write(renderChoices(question, choices, defaultId));
        const answer = normalized(await reader.read());
        if (answer === "") return defaultId;
        if (answer === "q" && choices.some((choice) => choice.id === "quit")) return "quit";
        if (answer === "y" || answer === "yes") {
          return options?.legacyYes === "default" ? defaultId : choices[0]!.id;
        }
        if (answer === "n" || answer === "no") return defaultId;
        const index = Number(answer);
        if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1]!.id;
        deps.write(`Please enter a number from 1 to ${choices.length}, or press Enter for the default.\n`);
      }
    },
    close(): void {
      reader.stop();
    },
  };
}
