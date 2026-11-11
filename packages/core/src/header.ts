/**
 * Strict parsing of `Content-Encoding` field values (SPEC section 4).
 *
 * The evaluation order is normative because it decides the outcome class when several faults are
 * present: total length, then per-element grammar left to right, then element count, then
 * support, then layer count.
 */

import {
  LayerLimitError,
  MalformedEncodingError,
  UnsupportedEncodingError,
  quoteUntrusted,
} from "./errors.js";

export const MAX_HEADER_LENGTH = 1024; // SG-R-HDR-02, in bytes of the joined list
export const MAX_ELEMENTS = 16; // SG-R-HDR-06, counting identity
export const IDENTITY = "identity";

// SG-R-HDR-04. Anchored on both ends; ASCII only (no `u` flag, no \w, no case folding tricks).
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const encoder = new TextEncoder();

/**
 * Return the layers to decode, in decoding order (layer 1 first).
 *
 * @param values the field values as received; one string is one field value
 * @param supported tells whether a (lower-case, alias-resolved) token has a codec
 * @param maxLayers the `maxLayers` limit
 * @throws MalformedEncodingError the list is too long or an element breaks the grammar
 * @throws LayerLimitError more than 16 elements, or more than `maxLayers` layers
 * @throws UnsupportedEncodingError a well-formed token has no codec
 * @throws TypeError `values` is not a string or an array of strings
 */
export function parseContentEncoding(
  values: string | readonly string[],
  supported: (name: string) => boolean,
  maxLayers: number,
): string[] {
  const fields = asFields(values);
  checkLength(fields);
  const elements = split(fields);
  if (elements.length > MAX_ELEMENTS) {
    throw new LayerLimitError(
      `${elements.length} encodings listed, at most ${MAX_ELEMENTS} are accepted`,
      { limit: MAX_ELEMENTS },
    );
  }
  const names = elements.map((name) => resolve(name, supported));
  const layers = names.filter((name) => name !== IDENTITY);
  if (layers.length > maxLayers) {
    throw new LayerLimitError(
      `${layers.length} encoding layers, at most ${maxLayers} are accepted`,
      { limit: maxLayers },
    );
  }
  return layers.reverse(); // SG-R-HDR-12: the last listed token is layer 1
}

function asFields(values: string | readonly string[]): string[] {
  if (typeof values === "string") return [values];
  if (!Array.isArray(values)) {
    throw new TypeError("Content-Encoding values must be a string or an array of strings");
  }
  for (const value of values) {
    if (typeof value !== "string") {
      throw new TypeError(`Content-Encoding values must be strings, got ${typeof value}`);
    }
  }
  return [...values];
}

/** SG-R-HDR-02: the joined list may be at most 1024 bytes long. */
function checkLength(fields: string[]): void {
  let total = 0;
  for (const field of fields) total += encoder.encode(field).length;
  total += Math.max(fields.length - 1, 0); // the joining commas
  if (total > MAX_HEADER_LENGTH) {
    throw new MalformedEncodingError(
      `Content-Encoding is ${total} bytes long, at most ${MAX_HEADER_LENGTH} are accepted`,
      { limit: MAX_HEADER_LENGTH },
    );
  }
}

/** SG-R-HDR-01, HDR-03, HDR-04, HDR-05: join, split, trim, validate, lower-case. */
function split(fields: string[]): string[] {
  const elements: string[] = [];
  for (const raw of fields.join(",").split(",")) {
    const part = trimSpaceAndTab(raw); // only SP and HTAB, never other Unicode whitespace
    if (part === "") continue; // empty elements are ignored (RFC 9110 section 5.6.1.2)
    if (!TOKEN.test(part)) {
      throw new MalformedEncodingError(`invalid encoding name ${quoteUntrusted(part)}`);
    }
    elements.push(part.toLowerCase()); // safe: only ASCII passed the grammar
  }
  return elements;
}

function trimSpaceAndTab(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charCodeAt(start) === 0x20 || text.charCodeAt(start) === 0x09)) start++;
  while (end > start && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) end--;
  return text.slice(start, end);
}

/** SG-R-HDR-07, HDR-08: apply the x-gzip alias and require support. */
function resolve(name: string, supported: (name: string) => boolean): string {
  if (name === "x-gzip") name = "gzip";
  if (name !== IDENTITY && !supported(name)) {
    throw new UnsupportedEncodingError(`encoding ${quoteUntrusted(name)} is not supported`);
  }
  return name;
}
