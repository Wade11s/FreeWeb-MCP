import { randomBytes } from "node:crypto";
import { canonicalizeIpAddress } from "./ip-address.js";

const DNS_TIMEOUT_MS = 3000;
const MAX_DNS_MESSAGE_BYTES = 65_535;
const DNS_CLASS_IN = 1;
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;
const DNS_TYPE_CNAME = 5;

export type DohFetchFn = typeof fetch;

interface ParsedName {
  name: string;
  next: number;
}

function malformed(): Error {
  return new Error("Malformed DNS-over-HTTPS response");
}

/** Read a possibly compressed DNS name without following unbounded pointers. */
function readName(message: Uint8Array, start: number): ParsedName {
  const labels: string[] = [];
  const visited = new Set<number>();
  let offset = start;
  let next: number | undefined;

  while (true) {
    if (offset >= message.length) throw malformed();
    const length = message[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= message.length) throw malformed();
      const pointer = ((length & 0x3f) << 8) | message[offset + 1];
      if (pointer >= message.length || visited.has(pointer)) throw malformed();
      visited.add(pointer);
      next ??= offset + 2;
      offset = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0 || length > 63) throw malformed();
    if (length === 0) {
      return { name: labels.join("."), next: next ?? offset + 1 };
    }
    if (offset + 1 + length > message.length) throw malformed();
    labels.push(String.fromCharCode(...message.slice(offset + 1, offset + 1 + length)));
    if (labels.join(".").length > 253) throw malformed();
    offset += 1 + length;
  }
}

function encodeQuery(hostname: string, type: typeof DNS_TYPE_A | typeof DNS_TYPE_AAAA): Uint8Array {
  const labels = hostname.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63) || hostname.length > 253) {
    throw new Error("Cannot encode DNS-over-HTTPS query");
  }
  const questionLength = labels.reduce((length, label) => length + label.length + 1, 1) + 4;
  const query = new Uint8Array(12 + questionLength);
  const view = new DataView(query.buffer);
  randomBytes(2).forEach((byte, index) => { query[index] = byte; });
  view.setUint16(2, 0x0100); // Recursion desired.
  view.setUint16(4, 1); // One question.
  let offset = 12;
  for (const label of labels) {
    query[offset++] = label.length;
    for (let index = 0; index < label.length; index += 1) {
      const code = label.charCodeAt(index);
      if (code > 0x7f) throw new Error("Cannot encode DNS-over-HTTPS query");
      query[offset++] = code;
    }
  }
  query[offset++] = 0;
  view.setUint16(offset, type);
  view.setUint16(offset + 2, DNS_CLASS_IN);
  return query;
}

function parseResponse(
  message: Uint8Array,
  query: Uint8Array,
  hostname: string,
  type: typeof DNS_TYPE_A | typeof DNS_TYPE_AAAA,
): string[] {
  if (message.length < 12 || message.length > MAX_DNS_MESSAGE_BYTES) throw malformed();
  const queryView = new DataView(query.buffer, query.byteOffset, query.byteLength);
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const flags = view.getUint16(2);
  if (
    view.getUint16(0) !== queryView.getUint16(0)
    || (flags & 0x8000) === 0 // Not a response.
    || (flags & 0x7800) !== 0 // Not a standard query response.
    || (flags & 0x0200) !== 0 // Truncated.
    || (flags & 0x000f) !== 0 // DNS error, including NXDOMAIN.
    || view.getUint16(4) !== 1
  ) throw malformed();

  const question = readName(message, 12);
  if (question.next + 4 > message.length) throw malformed();
  if (
    question.name.toLowerCase() !== hostname
    || view.getUint16(question.next) !== type
    || view.getUint16(question.next + 2) !== DNS_CLASS_IN
  ) throw malformed();

  const addresses: Array<{ owner: string; address: string }> = [];
  const cnames = new Map<string, string>();
  let offset = question.next + 4;
  const answerCount = view.getUint16(6);
  for (let index = 0; index < answerCount; index += 1) {
    const parsedOwner = readName(message, offset);
    const owner = parsedOwner.name.toLowerCase();
    offset = parsedOwner.next;
    if (offset + 10 > message.length) throw malformed();
    const answerType = view.getUint16(offset);
    const answerClass = view.getUint16(offset + 2);
    const dataLength = view.getUint16(offset + 8);
    const dataStart = offset + 10;
    const dataEnd = dataStart + dataLength;
    if (dataEnd > message.length) throw malformed();
    if (answerClass === DNS_CLASS_IN && answerType === DNS_TYPE_CNAME) {
      const target = readName(message, dataStart);
      if (target.next !== dataEnd) throw malformed();
      cnames.set(owner, target.name.toLowerCase());
    } else if (answerClass === DNS_CLASS_IN && answerType === DNS_TYPE_A) {
      if (dataLength !== 4) throw malformed();
      const decoded = Array.from(message.slice(dataStart, dataEnd)).join(".");
      const address = canonicalizeIpAddress(decoded);
      if (!address) throw malformed();
      addresses.push({ owner, address: address.address });
    } else if (answerClass === DNS_CLASS_IN && answerType === DNS_TYPE_AAAA) {
      if (dataLength !== 16) throw malformed();
      const groups: string[] = [];
      for (let group = 0; group < 8; group += 1) {
        groups.push(view.getUint16(dataStart + group * 2).toString(16));
      }
      const address = canonicalizeIpAddress(groups.join(":"));
      if (!address) throw malformed();
      addresses.push({ owner, address: address.address });
    }
    offset = dataEnd;
  }

  const reachable = (owner: string): boolean => {
    let current = hostname;
    const visited = new Set<string>();
    while (current !== owner) {
      if (visited.has(current)) return false;
      visited.add(current);
      const target = cnames.get(current);
      if (!target) return false;
      current = target;
    }
    return true;
  };
  // A valid direct answer does not make an unrelated address answer safe.
  if (addresses.some(({ owner }) => !reachable(owner))) throw malformed();
  return addresses.map(({ address }) => address);
}

/** Read into a fixed-size buffer so absent or false Content-Length cannot bypass the cap. */
async function readResponseBody(response: Response, controller: AbortController): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const message = new Uint8Array(MAX_DNS_MESSAGE_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_DNS_MESSAGE_BYTES) {
        controller.abort(new Error("DNS-over-HTTPS response exceeded size limit"));
        void reader.cancel().catch(() => undefined);
        throw malformed();
      }
      message.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return message.slice(0, length);
}

async function query(
  endpoint: string,
  hostname: string,
  type: typeof DNS_TYPE_A | typeof DNS_TYPE_AAAA,
  fetchFn: DohFetchFn,
): Promise<string[]> {
  const request = encodeQuery(hostname, type);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("DNS-over-HTTPS query timed out")), DNS_TIMEOUT_MS);
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { accept: "application/dns-message", "content-type": "application/dns-message" },
      body: request,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DNS-over-HTTPS endpoint returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/dns-message") throw malformed();
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? 0 : Number(contentLengthHeader);
    if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > MAX_DNS_MESSAGE_BYTES) throw malformed();
    const message = await readResponseBody(response, controller);
    return parseResponse(message, request, hostname, type);
  } finally {
    clearTimeout(timeout);
  }
}

/** One bounded A query and one bounded AAAA query; there are no retries. */
export async function resolveDoh(
  hostname: string,
  endpoint: string,
  fetchFn: DohFetchFn = fetch,
): Promise<ReadonlyArray<{ address: string }>> {
  const [a, aaaa] = await Promise.all([
    query(endpoint, hostname, DNS_TYPE_A, fetchFn),
    query(endpoint, hostname, DNS_TYPE_AAAA, fetchFn),
  ]);
  return [...a, ...aaaa].map((address) => ({ address }));
}
