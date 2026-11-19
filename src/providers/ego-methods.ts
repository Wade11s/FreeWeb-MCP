import { FreeWebError } from "../errors.js";

export type EgoMethodTarget = "task" | "page" | "mouse" | "keyboard" | "chooser" | "download";

export interface EgoMethodSpec {
  readonly canonical: string;
  readonly target: EgoMethodTarget;
  readonly method: string;
  readonly validate: (args: unknown[]) => unknown[];
  readonly pathKind?: "upload" | "download";
  readonly pathSelector?: (args: unknown[]) => string[];
  readonly navigation?: boolean;
  readonly armOnly?: boolean;
}

export interface EgoCallPlan {
  readonly spec: EgoMethodSpec;
  readonly args: unknown[];
  readonly armKind?: "popup" | "download" | "fileChooser";
  readonly action?: EgoCallPlan;
  readonly followUps: EgoFollowUpPlan[];
  readonly saveAs?: string;
  readonly files?: string[];
}

export interface EgoFollowUpPlan {
  readonly spec: EgoMethodSpec;
  readonly args: unknown[];
}

export interface EgoPathRef {
  readonly kind: "upload" | "download";
  readonly path: string;
}

type Validator = (value: unknown, path: string) => unknown;
type Shape = Record<string, Validator>;

const INVALID = "INVALID_INPUT";

function invalid(path: string, message: string): never {
  throw new FreeWebError(INVALID, `Invalid ego method arguments at ${path}: ${message}`);
}

/**
 * Relative targets are classified against a sentinel origin: `new URL(value, base)` keeps
 * that origin for every relative form, so the classifier never has to trust a scheme regex.
 * Absolute targets must spell out `http(s)://`, because a scheme-only form such as
 * `https:host` means "same scheme relative path" on an https page and "absolute host" on
 * an http one: its meaning depends on the Space's current page and cannot be judged here.
 */
const URL_SENTINEL = "https://sentinel.invalid/";
const URL_SENTINEL_ORIGIN = new URL(URL_SENTINEL).origin;
/**
 * The URL parser silently strips tab/CR/LF and browsers fold `\` into `/`, so `fi\nle:`
 * and `\\127.0.0.1` reach the network as `file:` / `//127.0.0.1` even though no scheme
 * regex can see it. Whitespace and control characters are rejected before parsing.
 */
const URL_FORBIDDEN_CHARS = /[\u0000-\u0020\u007f\\]/;
const URL_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const URL_ABSOLUTE_PREFIX = /^https?:\/\//i;

export interface EgoUrlTarget {
  readonly kind: "relative" | "absolute";
  /** The resolved URL. Relative targets stay on the sentinel origin by construction. */
  readonly url: URL;
}

/**
 * The one place that decides whether a navigation/fetch target is same-origin relative or
 * absolute http(s). Absolute targets are returned normalized so the provider can run the
 * existing public URL policy on what the browser would really request.
 */
export function parseEgoUrl(value: string, path = "url"): EgoUrlTarget {
  if (value.length === 0) invalid(path, "expected a non-empty URL");
  if (URL_FORBIDDEN_CHARS.test(value)) {
    invalid(path, "expected a URL without whitespace, control characters or backslashes");
  }
  if (URL_SCHEME_PREFIX.test(value)) {
    if (!URL_ABSOLUTE_PREFIX.test(value)) {
      invalid(path, "expected an absolute http(s):// URL or a relative URL");
    }
    let absolute: URL;
    try {
      absolute = new URL(value);
    } catch {
      invalid(path, "expected an absolute http(s):// URL or a relative URL");
    }
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      invalid(path, "expected an http(s) URL");
    }
    if (absolute.username || absolute.password) invalid(path, "credentialed URLs are not allowed");
    return { kind: "absolute", url: absolute };
  }
  // Protocol-relative `//host` would keep the scheme but replace the origin.
  if (value.startsWith("//")) invalid(path, "expected a relative URL that keeps the current origin");
  let relative: URL;
  try {
    relative = new URL(value, URL_SENTINEL);
  } catch {
    invalid(path, "expected an absolute http(s):// URL or a relative URL");
  }
  // The sentinel origin is the invariant that makes `relative` safe to run unchecked.
  if (relative.origin !== URL_SENTINEL_ORIGIN) {
    invalid(path, "expected a relative URL that keeps the current origin");
  }
  return { kind: "relative", url: relative };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Referer/referrer values are header-bound, so the same tab/CR/LF/backslash obfuscation
 * that confuses URL parsing must not slip through them either.
 */
function refererValidator(min: number): Validator {
  return (value, path) => {
    const text = stringValidator(2000, min)(value, path) as string;
    if (URL_FORBIDDEN_CHARS.test(text)) {
      invalid(path, "expected a URL without whitespace, control characters or backslashes");
    }
    return text;
  };
}

function stringValidator(max = 4000, min = 1): Validator {
  return (value, path) => {
    if (typeof value !== "string") invalid(path, "expected string");
    if (value.length < min) invalid(path, `expected at least ${min} character(s)`);
    if (value.length > max) invalid(path, `expected at most ${max} characters`);
    return value;
  };
}

const shortString = stringValidator(200);
const selector = stringValidator(4000);
const filePath = stringValidator(4096);

function numberValidator(options: { integer?: boolean; min?: number; max?: number } = {}): Validator {
  return (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "expected finite number");
    if (options.integer && !Number.isInteger(value)) invalid(path, "expected integer");
    if (options.min !== undefined && (value as number) < options.min) invalid(path, `expected >= ${options.min}`);
    if (options.max !== undefined && (value as number) > options.max) invalid(path, `expected <= ${options.max}`);
    return value;
  };
}

const nonNegativeInt = numberValidator({ integer: true, min: 0 });
const finiteNumber = numberValidator();
const booleanValidator: Validator = (value, path) => {
  if (typeof value !== "boolean") invalid(path, "expected boolean");
  return value;
};

function literalValidator<T extends string | number>(values: readonly T[]): Validator {
  return (value, path) => {
    if (!values.includes(value as T)) invalid(path, `expected one of ${values.join(", ")}`);
    return value;
  };
}

function optional(validator: Validator): Validator {
  return (value, path) => (value === undefined ? undefined : validator(value, path));
}

const nullValidator: Validator = (value, path) => {
  if (value !== null) invalid(path, "expected null");
  return null;
};

function union(...validators: Validator[]): Validator {
  return (value, path) => {
    for (const validator of validators) {
      try {
        return validator(value, path);
      } catch (error) {
        if (!(error instanceof FreeWebError) || error.code !== INVALID) throw error;
      }
    }
    return invalid(path, "no matching alternative");
  };
}

function arrayValidator(item: Validator, max = 100, min = 0): Validator {
  return (value, path) => {
    if (!Array.isArray(value)) invalid(path, "expected array");
    if (value.length < min) invalid(path, `expected at least ${min} item(s)`);
    if (value.length > max) invalid(path, `expected at most ${max} item(s)`);
    return value.map((entry, index) => item(entry, `${path}[${index}]`));
  };
}

function objectValidator(shape: Shape, pathLabel = "object"): Validator {
  return (value, path) => {
    if (!isPlainObject(value)) invalid(path, `expected ${pathLabel}`);
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!(key in shape)) invalid(`${path}.${key}`, "unknown field");
    }
    const output: Record<string, unknown> = {};
    for (const [key, validator] of Object.entries(shape)) {
      if (!(key in input)) continue;
      const parsed = validator(input[key], `${path}.${key}`);
      if (parsed !== undefined) output[key] = parsed;
    }
    return output;
  };
}

function selectorOptions(extra: Shape = {}): Validator {
  return objectValidator({
    force: optional(booleanValidator),
    timeout: optional(nonNegativeInt),
    ...extra,
  });
}

const positionValidator = objectValidator({ x: finiteNumber, y: finiteNumber }, "position");

const clickOptions = selectorOptions({
  button: optional(literalValidator(["left", "middle", "right"])),
  clickCount: optional(numberValidator({ integer: true, min: 1, max: 10 })),
  delay: optional(nonNegativeInt),
  position: optional(positionValidator),
  label: optional(stringValidator(60, 3)),
});

const hoverOptions = selectorOptions({
  position: optional(positionValidator),
  label: optional(stringValidator(60, 3)),
});

const dragOptions = selectorOptions({
  button: optional(literalValidator(["left", "middle", "right"])),
  sourcePosition: optional(positionValidator),
  targetPosition: optional(positionValidator),
  label: optional(stringValidator(60, 3)),
});

const waitOptions = objectValidator({ timeout: optional(nonNegativeInt) });
const navigationWaitUntil = literalValidator(["commit", "domcontentloaded", "load", "networkidle"]);
const navigationOptions = objectValidator({
  referer: optional(refererValidator(1)),
  timeout: optional(nonNegativeInt),
  waitUntil: optional(navigationWaitUntil),
});

const selectValue = union(shortString, objectValidator({
  value: optional(shortString),
  label: optional(shortString),
  index: optional(nonNegativeInt),
}, "select option"), arrayValidator(union(shortString, objectValidator({
  value: optional(shortString),
  label: optional(shortString),
  index: optional(nonNegativeInt),
}, "select option")), 100), nullValidator);

const trueValidator: Validator = (value, path) => {
  if (value !== true) invalid(path, "expected true");
  return true;
};

function adoptTargetValidator(): Validator {
  const shape = objectValidator({
    active: optional(trueValidator),
    index: optional(nonNegativeInt),
    label: optional(stringValidator(30)),
    as: optional(stringValidator(30)),
  }, "adopt target");
  return (value, path) => {
    const target = shape(value, path) as Record<string, unknown>;
    const selectors = ["active", "index", "label"].filter((key) => key in target);
    if (selectors.length !== 1) invalid(path, "exactly one of active, index or label is required");
    return target;
  };
}

function recordValidator(item: Validator, max = 100): Validator {
  return (value, path) => {
    if (!isPlainObject(value)) invalid(path, "expected object");
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > max) invalid(path, `expected at most ${max} fields`);
    const output: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) invalid(`${path}.${key}`, "invalid header name");
      output[key] = item(entry, `${path}.${key}`);
    }
    return output;
  };
}

function fetchUrlValidator(): Validator {
  return (value, path) => {
    const url = stringValidator(10_000)(value, path) as string;
    // A relative fetch may not leave the Space's origin, and an absolute one is checked
    // against the public URL policy by the provider. Both go through the same parser.
    parseEgoUrl(url, path);
    return url;
  };
}

/** Boolean form kept for the provider's final navigation re-check. */
export function isSafeNavigationUrl(value: string): boolean {
  try {
    parseEgoUrl(value);
    return true;
  } catch {
    return false;
  }
}

function navigationUrlValidator(): Validator {
  return (value, path) => {
    const url = stringValidator(10_000)(value, path) as string;
    parseEgoUrl(url, path);
    return url;
  };
}

function httpMethodValidator(): Validator {
  return (value, path) => {
    const method = stringValidator(32)(value, path) as string;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method)) invalid(path, "expected an HTTP method token");
    return method;
  };
}

const fetchOptions = objectValidator({
  method: optional(httpMethodValidator()),
  headers: optional(recordValidator(stringValidator(4000, 0))),
  body: optional(union(stringValidator(1_000_000, 0), nullValidator)),
  timeout: optional(nonNegativeInt),
  saveAs: optional(filePath),
  cache: optional(literalValidator(["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"])),
  credentials: optional(literalValidator(["omit", "same-origin", "include"])),
  integrity: optional(stringValidator(4000, 0)),
  keepalive: optional(booleanValidator),
  mode: optional(literalValidator(["cors", "no-cors", "same-origin"])),
  redirect: optional(literalValidator(["follow", "error", "manual"])),
  referrer: optional(refererValidator(0)),
  referrerPolicy: optional(literalValidator([
    "",
    "no-referrer",
    "no-referrer-when-downgrade",
    "origin",
    "origin-when-cross-origin",
    "same-origin",
    "strict-origin",
    "strict-origin-when-cross-origin",
    "unsafe-url",
  ])),
}, "fetch options");

const clipboardContent = union(shortString, objectValidator({
  text: shortString,
  html: optional(stringValidator(100_000)),
}, "clipboard content"));

const safeWaitConditionValidator = objectValidator({
  selector: optional(stringValidator(4000)),
  text: optional(stringValidator(1000)),
  state: optional(literalValidator(["present", "visible", "hidden", "text"])),
  urlIncludes: optional(stringValidator(2000)),
  titleIncludes: optional(stringValidator(1000)),
}, "wait condition");

const safeWaitCondition: Validator = (value, path) => {
  const condition = safeWaitConditionValidator(value, path) as Record<string, unknown>;
  if (!("selector" in condition) && !("urlIncludes" in condition) && !("titleIncludes" in condition)) {
    invalid(path, "selector, urlIncludes or titleIncludes is required");
  }
  return condition;
};

function tuple(...validators: Validator[]): (args: unknown[]) => unknown[] {
  return (args, path = "args") => {
    if (!Array.isArray(args)) invalid(path, "expected array");
    if (args.length > validators.length) invalid(path, `expected at most ${validators.length} argument(s)`);
    const requiredCount = validators.filter((validator) => !isOptionalValidator(validator)).length;
    if (args.length < requiredCount) invalid(path, `expected at least ${requiredCount} argument(s)`);
    return validators.map((validator, index) =>
      index < args.length ? validator(args[index], `${path}[${index}]`) : undefined,
    );
  };
}

// Optional validators are marked by wrapping them with `optional`; tracking is by function identity.
const optionalValidators = new WeakSet<Validator>();
function opt(validator: Validator): Validator {
  const wrapped = optional(validator);
  optionalValidators.add(wrapped);
  return wrapped;
}
function isOptionalValidator(validator: Validator): boolean {
  return optionalValidators.has(validator);
}

function noArgs(): (args: unknown[]) => unknown[] {
  return tuple();
}

function pathsFromIndex(index: number): (args: unknown[]) => string[] {
  return (args) => collectPathStrings(args[index]);
}

function pathsFromScreenshotOptions(): (args: unknown[]) => string[] {
  return (args) => (isPlainObject(args[0]) && typeof args[0].path === "string" ? [args[0].path] : []);
}

function spec(
  canonical: string,
  target: EgoMethodTarget,
  method: string,
  validate: (args: unknown[]) => unknown[],
  extra: Partial<EgoMethodSpec> = {},
): EgoMethodSpec {
  return { canonical, target, method, validate, ...extra };
}

export const EGO_METHOD_SPECS: Readonly<Record<string, EgoMethodSpec>> = Object.freeze({
  "task.pages": spec("task.pages", "task", "pages", noArgs()),
  "task.tabs": spec("task.tabs", "task", "tabs", noArgs()),
  "task.newPage": spec("task.newPage", "task", "newPage", noArgs()),
  "task.adopt": spec("task.adopt", "task", "adopt", tuple(adoptTargetValidator())),
  "task.release": spec("task.release", "task", "release", tuple(stringValidator(30))),

  "page.url": spec("page.url", "page", "url", noArgs()),
  "page.title": spec("page.title", "page", "title", noArgs()),
  "page.info": spec("page.info", "page", "info", noArgs()),
  "page.snapshot": spec("page.snapshot", "page", "snapshot", tuple(opt(objectValidator({
    scope: optional(literalValidator(["full_page", "only_within_viewport", "subtree"])),
    root: optional(stringValidator(50)),
    includeActionMarks: optional(booleanValidator),
    includeStableLocator: optional(booleanValidator),
  })))),
  "page.screenshot": spec("page.screenshot", "page", "screenshot", tuple(opt(objectValidator({
    path: optional(filePath),
    fullPage: optional(booleanValidator),
    clip: optional(objectValidator({ x: finiteNumber, y: finiteNumber, width: finiteNumber, height: finiteNumber }, "clip")),
    scale: optional(literalValidator(["css"])),
    raw: optional(booleanValidator),
  }))), { pathKind: "download", pathSelector: pathsFromScreenshotOptions() }),
  "page.goto": spec("page.goto", "page", "goto", tuple(navigationUrlValidator(), opt(navigationOptions)), {
    navigation: true,
  }),
  "page.reload": spec("page.reload", "page", "reload", tuple(opt(navigationOptions))),
  "page.fetch": spec("page.fetch", "page", "fetch", tuple(fetchUrlValidator(), opt(fetchOptions)), {
    pathKind: "download",
    pathSelector: (args) => (isPlainObject(args[1]) && typeof args[1].saveAs === "string" ? [args[1].saveAs] : []),
  }),
  "page.events": spec("page.events", "page", "events", noArgs()),
  "page.waitForURL": spec("page.waitForURL", "page", "waitForURL", tuple(navigationUrlValidator(), opt(waitOptions)), {
    navigation: true,
  }),
  "page.waitForEvent": spec("page.waitForEvent", "page", "waitForEvent", tuple(
    literalValidator(["popup", "download"]),
    opt(waitOptions),
  ), { armOnly: true }),
  "page.waitForSelector": spec("page.waitForSelector", "page", "waitForSelector", tuple(selector, opt(objectValidator({
    timeout: optional(nonNegativeInt),
    state: optional(literalValidator(["attached", "detached", "visible", "hidden"])),
  })))),
  "page.waitForLoadState": spec("page.waitForLoadState", "page", "waitForLoadState", tuple(
    opt(literalValidator(["load", "domcontentloaded", "networkidle"])),
    opt(objectValidator({ timeout: optional(nonNegativeInt), idleMs: optional(nonNegativeInt) })),
  )),
  "page.waitForFunction": spec("page.waitForFunction", "page", "waitForFunction", tuple(
    safeWaitCondition,
    opt(objectValidator({ timeout: optional(nonNegativeInt), polling: optional(numberValidator({ integer: true, min: 1 })) })),
  )),
  "page.waitForTimeout": spec("page.waitForTimeout", "page", "waitForTimeout", tuple(nonNegativeInt)),
  "page.click": spec("page.click", "page", "click", tuple(selector, opt(clickOptions))),
  "page.dblclick": spec("page.dblclick", "page", "dblclick", tuple(selector, opt(clickOptions))),
  "page.hover": spec("page.hover", "page", "hover", tuple(selector, opt(hoverOptions))),
  "page.dragAndDrop": spec("page.dragAndDrop", "page", "dragAndDrop", tuple(selector, selector, opt(dragOptions))),
  "page.fill": spec("page.fill", "page", "fill", tuple(selector, stringValidator(100_000), opt(selectorOptions({
    clearFirst: optional(booleanValidator),
  })))),
  "page.selectOption": spec("page.selectOption", "page", "selectOption", tuple(selector, selectValue, opt(waitOptions))),
  "page.focus": spec("page.focus", "page", "focus", tuple(selector, opt(waitOptions))),
  "page.press": spec("page.press", "page", "press", tuple(selector, shortString, opt(objectValidator({
    delay: optional(nonNegativeInt),
    timeout: optional(nonNegativeInt),
  })))),
  "page.setInputFiles": spec("page.setInputFiles", "page", "setInputFiles", tuple(selector, union(filePath, arrayValidator(filePath, 30, 1))), {
    pathKind: "upload",
    pathSelector: pathsFromIndex(1),
  }),
  "page.waitForFileChooser": spec("page.waitForFileChooser", "page", "waitForFileChooser", tuple(opt(waitOptions)), {
    armOnly: true,
  }),
  "page.close": spec("page.close", "page", "close", noArgs()),
  "page.acceptDialog": spec("page.acceptDialog", "page", "acceptDialog", tuple(opt(stringValidator(1000)))),
  "page.dismissDialog": spec("page.dismissDialog", "page", "dismissDialog", noArgs()),

  "mouse.click": spec("mouse.click", "mouse", "click", tuple(finiteNumber, finiteNumber, opt(objectValidator({
    button: optional(literalValidator(["left", "middle", "right"])),
    clickCount: optional(numberValidator({ integer: true, min: 1, max: 10 })),
    delay: optional(nonNegativeInt),
    label: optional(stringValidator(60, 3)),
  })))),
  "mouse.move": spec("mouse.move", "mouse", "move", tuple(finiteNumber, finiteNumber, opt(objectValidator({
    steps: optional(numberValidator({ integer: true, min: 1, max: 100 })),
    label: optional(stringValidator(60, 3)),
  })))),
  "mouse.down": spec("mouse.down", "mouse", "down", tuple(opt(objectValidator({
    button: optional(literalValidator(["left", "middle", "right"])),
    clickCount: optional(numberValidator({ integer: true, min: 1, max: 10 })),
  })))),
  "mouse.up": spec("mouse.up", "mouse", "up", tuple(opt(objectValidator({
    button: optional(literalValidator(["left", "middle", "right"])),
    clickCount: optional(numberValidator({ integer: true, min: 1, max: 10 })),
  })))),
  "mouse.wheel": spec("mouse.wheel", "mouse", "wheel", tuple(finiteNumber, finiteNumber, opt(objectValidator({
    label: optional(stringValidator(60, 3)),
  })))),

  "keyboard.down": spec("keyboard.down", "keyboard", "down", tuple(shortString)),
  "keyboard.up": spec("keyboard.up", "keyboard", "up", tuple(shortString)),
  "keyboard.press": spec("keyboard.press", "keyboard", "press", tuple(shortString, opt(objectValidator({ delay: optional(nonNegativeInt) })))),
  "keyboard.type": spec("keyboard.type", "keyboard", "type", tuple(stringValidator(100_000), opt(objectValidator({ delay: optional(nonNegativeInt) })))),
  "keyboard.insertText": spec("keyboard.insertText", "keyboard", "insertText", tuple(stringValidator(100_000))),
  "keyboard.paste": spec("keyboard.paste", "keyboard", "paste", tuple(clipboardContent)),

  "chooser.isMultiple": spec("chooser.isMultiple", "chooser", "isMultiple", noArgs(), { armOnly: true }),
  "chooser.setFiles": spec("chooser.setFiles", "chooser", "setFiles", tuple(union(filePath, arrayValidator(filePath, 30, 1))), {
    armOnly: true,
    pathKind: "upload",
    pathSelector: pathsFromIndex(0),
  }),

  "download.url": spec("download.url", "download", "url", noArgs(), { armOnly: true }),
  "download.suggestedFilename": spec("download.suggestedFilename", "download", "suggestedFilename", noArgs(), { armOnly: true }),
  "download.saveAs": spec("download.saveAs", "download", "saveAs", tuple(filePath), {
    armOnly: true,
    pathKind: "download",
    pathSelector: pathsFromIndex(0),
  }),
  "download.path": spec("download.path", "download", "path", noArgs(), { armOnly: true }),
  "download.failure": spec("download.failure", "download", "failure", noArgs(), { armOnly: true }),
  "download.cancel": spec("download.cancel", "download", "cancel", noArgs(), { armOnly: true }),
  "download.delete": spec("download.delete", "download", "delete", noArgs(), { armOnly: true }),
});

const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  pages: "task.pages",
  tabs: "task.tabs",
  newPage: "task.newPage",
  adopt: "task.adopt",
  release: "task.release",
  url: "page.url",
  title: "page.title",
  info: "page.info",
  snapshot: "page.snapshot",
  screenshot: "page.screenshot",
  goto: "page.goto",
  reload: "page.reload",
  fetch: "page.fetch",
  events: "page.events",
  waitForURL: "page.waitForURL",
  waitForEvent: "page.waitForEvent",
  waitForSelector: "page.waitForSelector",
  waitForLoadState: "page.waitForLoadState",
  waitForFunction: "page.waitForFunction",
  waitForTimeout: "page.waitForTimeout",
  click: "page.click",
  dblclick: "page.dblclick",
  hover: "page.hover",
  dragAndDrop: "page.dragAndDrop",
  fill: "page.fill",
  selectOption: "page.selectOption",
  focus: "page.focus",
  press: "page.press",
  setInputFiles: "page.setInputFiles",
  waitForFileChooser: "page.waitForFileChooser",
  close: "page.close",
  acceptDialog: "page.acceptDialog",
  dismissDialog: "page.dismissDialog",
  fileChooser: "chooser.setFiles",
  "fileChooser.setFiles": "chooser.setFiles",
  "fileChooser.isMultiple": "chooser.isMultiple",
  "page.mouse.click": "mouse.click",
  "page.mouse.move": "mouse.move",
  "page.mouse.down": "mouse.down",
  "page.mouse.up": "mouse.up",
  "page.mouse.wheel": "mouse.wheel",
  "page.keyboard.down": "keyboard.down",
  "page.keyboard.up": "keyboard.up",
  "page.keyboard.press": "keyboard.press",
  "page.keyboard.type": "keyboard.type",
  "page.keyboard.insertText": "keyboard.insertText",
  "page.keyboard.paste": "keyboard.paste",
});

export function resolveEgoMethod(method: string): EgoMethodSpec | undefined {
  const canonical = ALIASES[method] ?? method;
  return EGO_METHOD_SPECS[canonical];
}

function methodNotAllowed(method: string): never {
  throw new FreeWebError("EGO_METHOD_NOT_ALLOWED", `ego method is not allowed: ${method}`);
}

function collectPathStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function parseCall(method: string, args: unknown, allowArmed = false): EgoCallPlan {
  if (typeof method !== "string" || method.length > 100) methodNotAllowed(String(method));
  const found = resolveEgoMethod(method);
  if (!found) methodNotAllowed(method);
  if (!allowArmed && found.armOnly && found.target !== "page") methodNotAllowed(method);
  if (!Array.isArray(args) || args.length > 30) invalid("args", "expected array with at most 30 items");
  return { spec: found, args: found.validate(args), followUps: [] };
}

const OPTION_KEYS = new Set(["action", "then", "trigger", "saveAs", "files", "file", "paths", "followUp", "followUps", "arm"]);

function parseFollowUps(value: unknown, allowedTarget: EgoMethodTarget, path: string): EgoFollowUpPlan[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 10) invalid(path, "expected at most 10 follow-ups");
  return list.map((entry, index) => {
    if (!isPlainObject(entry)) invalid(`${path}[${index}]`, "expected object");
    const plan = parseCall(String(entry.method), entry.args ?? [], true);
    if (plan.spec.target !== allowedTarget || !plan.spec.armOnly) {
      methodNotAllowed(String(entry.method));
    }
    return { spec: plan.spec, args: plan.args };
  });
}

function parseAction(value: unknown, path: string): EgoCallPlan | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) invalid(path, "expected object");
  const plan = parseCall(String(value.method), value.args ?? []);
  if (plan.spec.target !== "page" || plan.spec.armOnly || plan.spec.canonical === "page.waitForFunction") {
    methodNotAllowed(String(value.method));
  }
  return plan;
}

export function prepareEgoCall(method: string, args: unknown, options: unknown): EgoCallPlan {
  const plan = parseCall(method, args);
  if (options !== undefined && !isPlainObject(options)) invalid("options", "expected object");
  // Clone so arming shorthand can be expanded without mutating the caller's object.
  const resolved: Record<string, unknown> = options === undefined ? {} : { ...options };
  for (const key of Object.keys(resolved)) {
    if (!OPTION_KEYS.has(key)) invalid(`options.${key}`, "unknown field");
  }

  const rawArm = resolved.arm;
  if (rawArm !== undefined) {
    if (!isPlainObject(rawArm)) invalid("options.arm", "expected object");
    for (const [key, value] of Object.entries(rawArm)) {
      if (!(key in resolved)) resolved[key] = value;
    }
  }

  if (!plan.spec.armOnly) {
    if (resolved.action !== undefined || resolved.then !== undefined || resolved.trigger !== undefined) {
      throw new FreeWebError("EGO_METHOD_NOT_ALLOWED", "follow-up actions require an arming method");
    }
    return plan;
  }

  if (plan.spec.canonical === "page.waitForEvent") {
    const event = plan.args[0] as "popup" | "download";
    const action = parseAction(resolved.action ?? resolved.then ?? resolved.trigger, "options.action");
    if (!action) invalid("options.action", "required for page.waitForEvent");
    const saveAs = event === "download" ? resolved.saveAs : undefined;
    if (event === "download" && typeof saveAs !== "string") invalid("options.saveAs", "required for downloads");
    const allowedTarget: EgoMethodTarget = event === "download" ? "download" : "page";
    const followUps = parseFollowUps(resolved.followUp ?? resolved.followUps, allowedTarget, "options.followUp");
    return {
      ...plan,
      armKind: event,
      action,
      followUps,
      ...(typeof saveAs === "string" ? { saveAs: filePath(saveAs, "options.saveAs") as string } : {}),
    };
  }

  if (plan.spec.canonical === "page.waitForFileChooser") {
    const action = parseAction(resolved.action ?? resolved.then ?? resolved.trigger, "options.action");
    if (!action) invalid("options.action", "required for page.waitForFileChooser");
    const rawFiles = resolved.files ?? resolved.file ?? resolved.paths;
    if (rawFiles === undefined) invalid("options.files", "required for page.waitForFileChooser");
    const parsedFiles = union(filePath, arrayValidator(filePath, 30, 1))(rawFiles, "options.files");
    const files = typeof parsedFiles === "string" ? [parsedFiles] : parsedFiles as string[];
    const followUps = parseFollowUps(resolved.followUp ?? resolved.followUps, "chooser", "options.followUp");
    return { ...plan, armKind: "fileChooser", action, files, followUps };
  }

  methodNotAllowed(method);
}

export function collectEgoPaths(plan: EgoCallPlan): EgoPathRef[] {
  const found: EgoPathRef[] = [];
  const add = (kind: "upload" | "download", value: unknown) => {
    for (const path of collectPathStrings(value)) found.push({ kind, path });
  };
  if (plan.spec.pathKind && plan.spec.pathSelector) {
    for (const path of plan.spec.pathSelector(plan.args)) found.push({ kind: plan.spec.pathKind, path });
  }
  if (plan.saveAs) found.push({ kind: "download", path: plan.saveAs });
  if (plan.files) for (const path of plan.files) found.push({ kind: "upload", path });
  if (plan.action) found.push(...collectEgoPaths(plan.action));
  for (const followUp of plan.followUps) {
    if (followUp.spec.pathKind && followUp.spec.pathSelector) {
      for (const path of followUp.spec.pathSelector(followUp.args)) {
        found.push({ kind: followUp.spec.pathKind, path });
      }
    }
  }
  return found;
}

/** Specs whose first argument is a URL rather than a selector, path or payload. */
const URL_TARGET_SPECS = new Set(["page.goto", "page.waitForURL", "page.fetch"]);

/**
 * Absolute targets the browser would really request, normalized by `parseEgoUrl` so the
 * regex-visible and parser-visible forms cannot diverge. Relative targets need no DNS
 * check: they cannot leave the Space's origin.
 */
export function collectEgoUrls(plan: EgoCallPlan): string[] {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    let target: EgoUrlTarget;
    try {
      target = parseEgoUrl(value);
    } catch {
      // Argument validation already rejected these; never treat a failed parse as safe.
      return;
    }
    if (target.kind === "absolute") urls.add(target.url.href);
  };
  const visit = (current: EgoCallPlan) => {
    if (URL_TARGET_SPECS.has(current.spec.canonical)) {
      add(current.args[0]);
      const options = current.args[1];
      if (isPlainObject(options)) {
        if (current.spec.canonical === "page.goto") add(options.referer);
        if (current.spec.canonical === "page.fetch") add(options.referrer);
      }
    }
    if (current.spec.navigation) add(current.args[0]);
    if (current.action) visit(current.action);
    for (const followUp of current.followUps) {
      if (followUp.spec.navigation) add(followUp.args[0]);
    }
  };
  visit(plan);
  return [...urls];
}

/** Every navigation-marked target, including arming actions and follow-ups. */
export function collectEgoNavigationUrls(plan: EgoCallPlan): string[] {
  const urls = new Set<string>();
  const add = (current: EgoCallPlan) => {
    if (current.spec.navigation && typeof current.args[0] === "string") urls.add(current.args[0]);
  };
  add(plan);
  if (plan.action) add(plan.action);
  for (const followUp of plan.followUps) {
    if (followUp.spec.navigation && typeof followUp.args[0] === "string") urls.add(followUp.args[0]);
  }
  return [...urls];
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function targetExpression(target: EgoMethodTarget): string {
  switch (target) {
    case "task": return "task";
    case "page": return "page";
    case "mouse": return "page.mouse";
    case "keyboard": return "page.keyboard";
    default: throw new Error(`unreachable target ${target}`);
  }
}

function renderSimpleCall(plan: EgoCallPlan, index: number, targetOverride?: string): string {
  const target = targetOverride ?? targetExpression(plan.spec.target);
  const args = plan.args.map(json).join(", ");
  return `const egoCall${index} = await ${target}.${plan.spec.method}(${args});`;
}

function renderSafeWait(plan: EgoCallPlan, index: number): string {
  const condition = plan.args[0];
  const waitOptions = plan.args[1];
  return `const egoCondition${index} = ${json(condition)};
const egoWaitOptions${index} = ${json(waitOptions)};
const egoCall${index} = await page.waitForFunction((condition) => {
  if (condition.selector) {
    const node = document.querySelector(condition.selector);
    if (condition.state === "hidden") return !node;
    if (!node) return false;
    if (condition.text && !(node.textContent || "").includes(condition.text)) return false;
    if (condition.state === "visible") {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    return true;
  }
  if (condition.urlIncludes && !location.href.includes(condition.urlIncludes)) return false;
  if (condition.titleIncludes && !document.title.includes(condition.titleIncludes)) return false;
  return true;
}, egoCondition${index}, egoWaitOptions${index});`;
}

function renderFollowUps(followUps: EgoFollowUpPlan[], handle: string, start: number): string {
  return followUps.map((followUp, offset) => {
    const args = followUp.args.map(json).join(", ");
    const index = start + offset;
    return `const egoFollow${index} = await ${handle}.${followUp.spec.method}(${args});
egoCallValue.${followUp.spec.method} = egoFollow${index};`;
  }).join("\n");
}

export function renderEgoCall(plan: EgoCallPlan): string {
  if (plan.spec.canonical === "task.adopt") {
    const target = plan.args[0] as Record<string, unknown>;
    const finder = target.active === true
      ? "egoTabs0.find((tab) => tab.active)"
      : typeof target.index === "number"
        ? `egoTabs0[${target.index}]`
        : `egoTabs0.find((tab) => tab.label === ${json(target.label)})`;
    const adoptOptions = typeof target.as === "string" ? `, { as: ${json(target.as)} }` : "";
    return `const egoTabs0 = await task.tabs();
const egoTab0 = ${finder};
if (!egoTab0) {
  const missing = new Error("EGO_ADOPT_TARGET_MISSING");
  missing.code = "EGO_ADOPT_TARGET_MISSING";
  throw missing;
}
const egoCall0 = await task.adopt(egoTab0.page${adoptOptions});
egoCallValue = egoCall0;`;
  }

  if (plan.spec.canonical === "page.waitForFunction") {
    return `${renderSafeWait(plan, 0)}\negoCallValue = egoCall0;`;
  }

  if (plan.spec.canonical === "page.waitForEvent") {
    const event = plan.args[0];
    const action = plan.action!;
    const waitArgs = plan.args.map(json).join(", ");
    const lines = [
      `const egoArmed0 = page.waitForEvent(${waitArgs});`,
      renderSimpleCall(action, 1),
      "const egoHandle0 = await egoArmed0;",
      "egoCallValue = { event: " + json(event) + ", action: egoCall1 };",
    ];
    if (event === "download") {
      lines.push(
        "egoCallValue.download = {",
        "  url: egoHandle0.url(),",
        "  suggestedFilename: egoHandle0.suggestedFilename(),",
        `  savedTo: await egoHandle0.saveAs(${json(plan.saveAs)}),`,
        "};",
      );
    } else {
      lines.push("await egoHandle0.waitForLoadState();", "egoCallValue.popup = { label: egoHandle0.label, url: await egoHandle0.url() };");
    }
    lines.push(renderFollowUps(plan.followUps, "egoHandle0", 2));
    return lines.filter(Boolean).join("\n");
  }

  if (plan.spec.canonical === "page.waitForFileChooser") {
    const waitArgs = plan.args.map(json).join(", ");
    const action = plan.action!;
    return [
      `const egoArmed0 = page.waitForFileChooser(${waitArgs});`,
      renderSimpleCall(action, 1),
      "const egoHandle0 = await egoArmed0;",
      `const egoCall0 = await egoHandle0.setFiles(${json(plan.files)});`,
      "egoCallValue = { action: egoCall1, chooser: egoCall0 };",
      renderFollowUps(plan.followUps, "egoHandle0", 2),
    ].filter(Boolean).join("\n");
  }

  return `${renderSimpleCall(plan, 0)}\negoCallValue = egoCall0;`;
}
