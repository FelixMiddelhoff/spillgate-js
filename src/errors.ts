/**
 * Errors thrown by spillgate.
 *
 * Every refusal is a {@link SpillgateError} whose `kind` is one of the outcome classes of the
 * specification (section 2). There is one subclass per kind, so callers can use either
 * `error instanceof OutputLimitError` or `error.kind === "output_limit"`.
 *
 * Error messages never contain more than 32 bytes of attacker-controlled data, and that data is
 * quoted and escaped (SG-R-HDR-13).
 */

/** The outcome classes of SPEC section 2. */
export type Kind =
  | "invalid_limits"
  | "output_limit"
  | "ratio_limit"
  | "layer_limit"
  | "input_limit"
  | "memory_limit"
  | "unsupported_encoding"
  | "malformed_encoding"
  | "corrupt"
  | "internal"
  | "canceled"
  | "source_error";

export interface ErrorDetails {
  /** 1-based index of the failing layer (layer 1 reads from the source); 0 if none. */
  layer?: number;
  /** The limit that was exceeded; 0 if the kind has none. */
  limit?: number;
  /** The underlying exception, for `source_error` the source's own. */
  cause?: unknown;
}

/** Base class of every error that spillgate throws about the data. */
export abstract class SpillgateError extends Error {
  abstract readonly kind: Kind;
  layer: number;
  readonly limit: number;

  constructor(message: string, details: ErrorDetails = {}) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = new.target.name;
    this.layer = details.layer ?? 0;
    this.limit = details.limit ?? 0;
  }

  override toString(): string {
    let text = `spillgate: ${this.kind}`;
    if (this.layer > 0) text += ` in layer ${this.layer}`;
    if (this.limit > 0) text += ` (limit ${this.limit})`;
    return this.message ? `${text}: ${this.message}` : text;
  }

  /** Name the layer if the error does not name one yet (the lowest layer wins). */
  withLayer(layer: number): this {
    if (this.layer <= 0 && layer > 0) this.layer = layer;
    return this;
  }
}

/** A limit parameter is missing, out of range or contradicts another one. */
export class InvalidLimitsError extends SpillgateError {
  readonly kind = "invalid_limits";
}
/** A layer would have produced more than `maxOutput` bytes. */
export class OutputLimitError extends SpillgateError {
  readonly kind = "output_limit";
}
/** A layer (or the whole chain) expanded its input by more than `maxRatio`. */
export class RatioLimitError extends SpillgateError {
  readonly kind = "ratio_limit";
}
/** The Content-Encoding chain has too many layers or elements. */
export class LayerLimitError extends SpillgateError {
  readonly kind = "layer_limit";
}
/** The codec asked for more than `maxInput` bytes of the source. */
export class InputLimitError extends SpillgateError {
  readonly kind = "input_limit";
}
/** The stream needs a decoder window larger than the configured cap. */
export class MemoryLimitError extends SpillgateError {
  readonly kind = "memory_limit";
}
/** A Content-Encoding token is well formed but not supported (fail closed). */
export class UnsupportedEncodingError extends SpillgateError {
  readonly kind = "unsupported_encoding";
}
/** The Content-Encoding header is not valid under the strict grammar. */
export class MalformedEncodingError extends SpillgateError {
  readonly kind = "malformed_encoding";
}
/** The compressed stream is invalid, truncated or has trailing data. */
export class CorruptError extends SpillgateError {
  readonly kind = "corrupt";
}
/** A codec or a source broke its contract, or a codec threw unexpectedly. */
export class InternalError extends SpillgateError {
  readonly kind = "internal";
}
/** Decoding was canceled through the `AbortSignal`. */
export class CanceledError extends SpillgateError {
  readonly kind = "canceled";
}
/** The caller's source failed. The original error is `cause`. */
export class SourceError extends SpillgateError {
  readonly kind = "source_error";
}

/** A decoder option is invalid, such as a bad extension-codec name. A programming error. */
export class InvalidOptionError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOptionError";
  }
}

/** The reader was used after `close()` (SG-R-RDR-06). A programming error. */
export class ClosedError extends Error {
  constructor() {
    super("I/O operation on a closed spillgate reader");
    this.name = "ClosedError";
  }
}

/** True for any error that spillgate throws about data. */
export function isSpillgateError(value: unknown): value is SpillgateError {
  return value instanceof SpillgateError;
}

export const MAX_QUOTED_BYTES = 32;

/**
 * Render attacker-controlled text for an error message (SG-R-HDR-13): at most
 * {@link MAX_QUOTED_BYTES} bytes of the UTF-8 form are shown, quoted, with every control or
 * non-ASCII character escaped, so it cannot forge log lines.
 */
export function quoteUntrusted(text: string): string {
  const raw = new TextEncoder().encode(text);
  const shown = new TextDecoder("utf-8").decode(raw.subarray(0, MAX_QUOTED_BYTES));
  let out = '"';
  for (const ch of shown) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else if (code <= 0xffff) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += "\\u{" + code.toString(16) + "}";
  }
  return out + '"' + (raw.length > MAX_QUOTED_BYTES ? "..." : "");
}
