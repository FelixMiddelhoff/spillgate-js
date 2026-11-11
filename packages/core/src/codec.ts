/**
 * The codec interface, for extension codecs such as brotli and zstd (SG-R-CDC-09).
 *
 * A codec is registered on one decoder instance (`new Decoder(limits, { codecs: { snappy } })`);
 * there is no global registry. Every codec, built in or not, runs behind the same limiter, ratio
 * meter and input meter (SG-R-CDC-01), so a sloppy codec is still bounded.
 *
 * Contract for the object returned by {@link Codec.newReader}:
 *
 * - `read(max)` resolves to between 1 and `max` bytes of decoded data, or to an empty array at the
 *   clean end of the stream. It never returns more than `max` bytes, and the array it returns is
 *   its own (the caller may keep it).
 * - It takes its compressed input only from the {@link Source} it was given.
 * - To report a broken stream it throws {@link CorruptError}, or another {@link SpillgateError}
 *   for a limit of its own (a window cap throws {@link MemoryLimitError}). Any other exception is a
 *   bug in the codec and becomes {@link InternalError} (SG-R-CDC-08).
 * - `close()` is optional and releases decoder state.
 */

export type { InputMeter as Source } from "./meter.js";
import type { InputMeter } from "./meter.js";

export interface CodecReader {
  read(max: number): Promise<Uint8Array>;
  close?(): void;
}

export interface Codec {
  newReader(source: InputMeter): CodecReader;
}
