/**
 * spillgate: decode untrusted compressed data under mandatory limits.
 *
 * A decompression bomb is a small input that expands to an enormous output. spillgate stops it
 * at the gate: every decoding layer has a hard output limit, an expansion ratio limit and a
 * bounded chain length, and anything that exceeds a limit ends in a typed error, never in silent
 * truncation.
 *
 * ```ts
 * import { decodeAll } from "spillgate";
 * const body = await decodeAll(response.body, response.headers.get("content-encoding") ?? [], {
 *   maxOutput: 8 * 1024 * 1024,
 * });
 * ```
 *
 * The normative rules are in `spec/SPEC.md`; rule IDs such as `SG-R-LAY-03` in comments point
 * there. Design principle: when in doubt, refuse.
 */

export { Decoder, decodeAll, reader } from "./decoder.js";
export type { DecoderOptions, ReaderOptions } from "./decoder.js";
export { SpillgateReader } from "./reader.js";
export { statusFor } from "./status.js";
export type { Codec, CodecReader, Source as CodecSource } from "./codec.js";
export type { Source, PullSource } from "./source.js";
export {
  CanceledError,
  ClosedError,
  CorruptError,
  InputLimitError,
  InternalError,
  InvalidLimitsError,
  InvalidOptionError,
  LayerLimitError,
  MalformedEncodingError,
  MemoryLimitError,
  OutputLimitError,
  RatioLimitError,
  SourceError,
  SpillgateError,
  UnsupportedEncodingError,
  isSpillgateError,
} from "./errors.js";
export type { Kind } from "./errors.js";
export {
  DEFAULT_MAX_LAYERS,
  DEFAULT_MAX_RATIO,
  DEFAULT_RATIO_GRACE,
  HARD_MAX_LAYERS,
  HARD_MAX_RATIO,
} from "./limits.js";
export type { Limits } from "./limits.js";
