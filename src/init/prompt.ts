/**
 * All interactive Initialization IO lives behind these injected-stream
 * seams, so tests drive confirmations without a real TTY. The real terminal
 * decision (`process.stdin`/`process.stdout` isTTY) is made exactly once, at
 * the CLI command boundary, and injected here as a plain boolean; nothing in
 * `src/init/` touches the real process streams.
 */

/** Confirmation seam backed by an injected input stream. */
export interface InitPrompt {
  /** True only when the command boundary decided both ends are a terminal. */
  readonly interactive: boolean;
  /** Asks a yes/no question; only `y`/`yes` (case-insensitive) confirm. */
  confirm(question: string): Promise<boolean>;
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
  /** Progress, plan, and summary lines (stdout in the real CLI). */
  writeLine(line: string): void;
  /** Diagnostics (stderr in the real CLI). */
  errorLine(line: string): void;
}

/**
 * Reads newline-delimited answers from one stream across many confirms,
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
   * line and every later question with "" — which the prompt reads as a
   * decline, so a closed terminal can never be mistaken for consent.
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

export function createPrompt(deps: PromptDeps): InitPrompt {
  const reader = new LineReader(deps.input);
  return {
    interactive: deps.interactive,
    async confirm(question: string): Promise<boolean> {
      deps.write(`${question} `);
      const line = await reader.read();
      const normalized = line.replace(/\r+$/, "").trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    },
    close(): void {
      reader.stop();
    },
  };
}
