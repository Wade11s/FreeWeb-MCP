import type { InitIo } from "./prompt.js";
import { environmentCredentialValues } from "./secrets.js";

const INLINE_SECRET = /\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*[^\s,;]+/gi;

/**
 * Redacts environment credentials from every component-controlled init
 * display field. Longest values are replaced first so overlapping credentials
 * cannot leave a suffix visible.
 */
export function redactInitText(
  text: string,
  env: NodeJS.ProcessEnv,
  publicPhrases: readonly string[] = [],
): string {
  const secrets = environmentCredentialValues(env);
  const redactSegment = (segment: string): string => {
    let result = segment;
    for (const secret of secrets) result = result.split(secret).join("[redacted]");
    return result.replace(INLINE_SECRET, "$1=[redacted]");
  };

  // Components may declare fixed, non-secret legal/attestation language that
  // must remain verbatim even when a credential happens to be a substring.
  // Only those exact public phrases bypass redaction; all surrounding text
  // still crosses the central secret boundary.
  //
  // A phrase is only exempt where no credential straddles its edge: if a
  // credential starts inside the phrase and continues past it (or starts
  // before and ends inside), printing the phrase verbatim would split that
  // credential into two pieces that no longer match. Such an occurrence is
  // not exempt, and an empty phrase or a phrase that is itself a credential
  // value is never exempt.
  const secretsCrossing = (start: number, end: number): boolean =>
    secrets.some((secret) => {
      let index = text.indexOf(secret);
      while (index >= 0) {
        const secretEnd = index + secret.length;
        const overlaps = index < end && secretEnd > start;
        const contained = index >= start && secretEnd <= end;
        if (overlaps && !contained) return true;
        index = text.indexOf(secret, index + 1);
      }
      return false;
    });
  const exemptPhrases = publicPhrases.filter((phrase) => phrase.length > 0 && !secrets.includes(phrase));

  let cursor = 0;
  let result = "";
  while (cursor < text.length) {
    let match: { readonly phrase: string; readonly index: number } | undefined;
    for (const phrase of exemptPhrases) {
      let index = text.indexOf(phrase, cursor);
      while (index >= 0 && secretsCrossing(index, index + phrase.length)) {
        index = text.indexOf(phrase, index + 1);
      }
      if (index < 0) continue;
      if (!match || index < match.index || (index === match.index && phrase.length > match.phrase.length)) {
        match = { phrase, index };
      }
    }
    if (!match) {
      result += redactSegment(text.slice(cursor));
      break;
    }
    result += redactSegment(text.slice(cursor, match.index));
    result += match.phrase;
    cursor = match.index + match.phrase.length;
  }
  return result;
}

/**
 * Redacts structured values before JSON serialization. Redacting serialized
 * JSON would miss credentials whose quotes, backslashes, or control
 * characters are escaped by JSON.stringify.
 */
export function redactInitValue<T>(
  value: T,
  env: NodeJS.ProcessEnv,
  publicPhrases: readonly string[] = [],
): T {
  if (typeof value === "string") return redactInitText(value, env, publicPhrases) as T;
  if (Array.isArray(value)) return value.map((item) => redactInitValue(item, env, publicPhrases)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactInitValue(item, env, publicPhrases)]),
    ) as T;
  }
  return value;
}

/** Wraps all init output and prompts so no component rendering path bypasses redaction. */
export function redactInitIo(
  io: InitIo,
  env: NodeJS.ProcessEnv,
  publicPhrases: readonly string[] = [],
): InitIo {
  const redact = (text: string): string => redactInitText(text, env, publicPhrases);
  return {
    prompt: {
      interactive: io.prompt.interactive,
      choose: (question, choices, defaultId, options) => io.prompt.choose(
        redact(question),
        choices.map((choice) => ({ ...choice, label: redact(choice.label) })),
        defaultId,
        options,
      ),
      close: () => io.prompt.close(),
    },
    writeLine: (line) => io.writeLine(redact(line)),
    errorLine: (line) => io.errorLine(redact(line)),
  };
}
