export type ErrorDetails = Record<string, unknown>;

export class FreeWebError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly options: {
      provider?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      details?: ErrorDetails;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "FreeWebError";
  }
}

export function errorInfo<P extends string = string>(error: unknown, provider?: P) {
  if (error instanceof FreeWebError) {
    return {
      code: error.code,
      message: error.message,
      provider: (error.options.provider ?? provider) as P | undefined,
      retryable: error.options.retryable ?? false,
      ...(error.options.retryAfterMs === undefined ? {} : { retryAfterMs: error.options.retryAfterMs }),
      ...(error.options.details ?? {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL_ERROR", message, provider, retryable: false };
}
