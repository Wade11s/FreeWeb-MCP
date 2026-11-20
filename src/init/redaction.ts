import type { InitIo } from "./prompt.js";

const SECRET_ENV = /(API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|AUTH)/i;
const INLINE_SECRET = /\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*[^\s,;]+/gi;

/**
 * Redacts environment credentials from every component-controlled init
 * display field. Longest values are replaced first so overlapping credentials
 * cannot leave a suffix visible.
 */
export function redactInitText(text: string, env: NodeJS.ProcessEnv): string {
  const secrets = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .filter(([key]) => SECRET_ENV.test(key))
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  let result = text;
  for (const secret of secrets) result = result.split(secret).join("[redacted]");
  return result.replace(INLINE_SECRET, "$1=[redacted]");
}

/** Wraps all init output and prompts so no component rendering path bypasses redaction. */
export function redactInitIo(io: InitIo, env: NodeJS.ProcessEnv): InitIo {
  return {
    prompt: {
      interactive: io.prompt.interactive,
      confirm: (question) => io.prompt.confirm(redactInitText(question, env)),
      close: () => io.prompt.close(),
    },
    writeLine: (line) => io.writeLine(redactInitText(line, env)),
    errorLine: (line) => io.errorLine(redactInitText(line, env)),
  };
}
