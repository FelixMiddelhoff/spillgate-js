/** Mapping a decoding error to the HTTP status a server should answer. */

import { SpillgateError } from "./errors.js";

/**
 * The HTTP status a server should answer for an error from decoding a request body:
 *
 * | status | outcome |
 * | --- | --- |
 * | 413 | output, ratio, input or layer limit exceeded |
 * | 415 | unsupported content encoding |
 * | 400 | malformed encoding header, corrupt data, failed read of the connection |
 * | 503 | memory limit, canceled |
 * | 500 | anything else, including `internal` |
 *
 * Returns 0 for `undefined` (no error).
 */
export function statusFor(error: unknown): number {
  if (error === undefined) return 0;
  if (!(error instanceof SpillgateError)) return 500;
  switch (error.kind) {
    case "output_limit":
    case "ratio_limit":
    case "input_limit":
    case "layer_limit":
      return 413;
    case "unsupported_encoding":
      return 415;
    case "malformed_encoding":
    case "corrupt":
    case "source_error":
      return 400;
    case "memory_limit":
    case "canceled":
      return 503;
    default:
      return 500;
  }
}
