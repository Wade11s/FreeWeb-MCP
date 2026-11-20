const SECRET_ENV = /(API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|AUTH)/i;

/** Non-empty values of environment variables whose names mark them as credentials. */
export function environmentCredentialValues(env: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .filter(([key]) => SECRET_ENV.test(key))
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

/**
 * True for a string, or a string-array item, that exactly matches an
 * environment credential. Used to keep component patches from persisting it.
 */
export function containsEnvironmentCredential(value: unknown, env: NodeJS.ProcessEnv): boolean {
  const credentials = environmentCredentialValues(env);
  if (typeof value === "string") return credentials.includes(value);
  return Array.isArray(value) && value.some((item) => typeof item === "string" && credentials.includes(item));
}
