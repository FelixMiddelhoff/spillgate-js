/**
 * Zstandard (RFC 8878, RFC 9659) for spillgate: `npm install spillgate-zstd`.
 *
 * ```ts
 * import { Decoder } from "spillgate";
 * import { codec } from "spillgate-zstd";
 *
 * const decoder = new Decoder({ maxOutput: 8 * 1024 * 1024 }, { codecs: { zstd: codec() } });
 * ```
 *
 * This is an own decoder in TypeScript, written for hostile input. The libraries available for
 * JavaScript give no hard bound on the output of one call, no cap on the window before it is
 * allocated, and no count of the input they used. Here:
 *
 * - The frame header is validated before anything is allocated: the reserved bit, a dictionary
 *   (refused as `corrupt`), and the window, including the window a single-segment frame gets from
 *   its declared content size, against the cap (SG-R-CDC-05). The default cap is 8 MiB, the 8 MB
 *   that RFC 9659 requires decoders to support.
 * - The decoder works one block at a time. A block regenerates at most 128 KiB, so memory per
 *   step is constant: the window plus a few block-sized buffers.
 * - A block larger than the window or 128 KiB, and the reserved block type, are `corrupt`.
 * - Skippable frames are skipped and count as consumed input only. Bytes that do not start a frame
 *   are `corrupt`. The content checksum is verified; a declared content size must match.
 * - Declared sizes are never used for any decision or allocation, except the window (SG-R-CDC-07).
 */

import { InvalidOptionError } from "spillgate";
import type { Codec } from "spillgate";
import { ZstdReader } from "./reader.js";

export const DEFAULT_MAX_WINDOW = 8 * 1024 * 1024;
export const MIN_WINDOW = 1 << 10;
export const MAX_WINDOW = 1 << 30;

export interface ZstdOptions {
  /** The largest window in bytes, `1 KiB .. 1 GiB`. Default 8 MiB. Memory per stream is this much at most. */
  maxWindowBytes?: number;
}

/**
 * The zstd codec for `Decoder`'s `codecs` option. Frames whose window exceeds `maxWindowBytes` are
 * refused as `memory_limit` before any memory is allocated for them.
 *
 * @throws InvalidOptionError the option is invalid
 */
export function codec(options: ZstdOptions = {}): Codec {
  const cap = options.maxWindowBytes ?? DEFAULT_MAX_WINDOW;
  if (!Number.isInteger(cap) || cap < MIN_WINDOW || cap > MAX_WINDOW) {
    throw new InvalidOptionError(`maxWindowBytes must be an integer in ${MIN_WINDOW}..${MAX_WINDOW}`);
  }
  return { newReader: (source) => new ZstdReader(source, cap) };
}
