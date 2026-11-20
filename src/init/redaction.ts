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
  let remaining = text;
  let result = "";
  while (remaining.length > 0) {
    let match: { readonly phrase: string; readonly index: number } | undefined;
    for (const phrase of publicPhrases) {
      if (!phrase) continue;
      const index = remaining.indexOf(phrase);
      if (index < 0) continue;
      if (!match || index < match.index || (index === match.index && phrase.length > match.phrase.length)) {
        match = { phrase, index };
      }
    }
    if (!match) {
      result += redactSegment(remaining);
      break;
    }
    result += redactSegment(remaining.slice(0, match.index));
    result += match.phrase;
    remaining = remaining.slice(match.index + match.phrase.length);
  }
  return result;
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
      confirm: (question) => io.prompt.confirm(redact(question)),
      close: () => io.prompt.close(),
    },
    writeLine: (line) => io.writeLine(redact(line)),
    errorLine: (line) => io.errorLine(redact(line)),
  };
}
