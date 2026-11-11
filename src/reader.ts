/** The reader returned to the caller: the last layer plus the end-to-end ratio check. */

import type { CodecReader } from "./codec.js";
import { ClosedError, RatioLimitError, SpillgateError } from "./errors.js";
import { MAX_STEP, type LayerGuard } from "./guard.js";
import type { EffectiveLimits } from "./limits.js";
import type { InputMeter } from "./meter.js";

const EMPTY = new Uint8Array(0);

/**
 * The decoded bytes of a source, read in chunks.
 *
 * Reading can deliver bytes and then fail: treat any {@link SpillgateError} as failure of the
 * whole body (SG-R-LAY-06). Errors are sticky: every later read fails with the same error
 * (SG-R-LAY-05). Closing does not touch the caller's source. Not safe for concurrent reads.
 *
 * It is an `AsyncIterable<Uint8Array>`: `for await (const chunk of reader)` reads to the end and
 * closes the reader, also when the loop is left early.
 */
export class SpillgateReader implements AsyncIterable<Uint8Array> {
  private produced = 0;
  private done: "end" | SpillgateError | undefined;
  private closed = false;
  private busy = false;

  /** @internal Use `Decoder.reader`. */
  constructor(
    private readonly top: LayerGuard,
    private readonly source: InputMeter,
    private readonly limits: EffectiveLimits,
    private codecs: CodecReader[],
    private readonly release?: () => void,
  ) {}

  /**
   * Read up to `maxBytes` (and at most one step of 64 KiB, whatever the size). Resolves to `null`
   * at the end of the data.
   */
  async read(maxBytes: number = MAX_STEP): Promise<Uint8Array | null> {
    if (this.closed) throw new ClosedError();
    if (this.busy) throw new Error("spillgate: concurrent reads on one reader are not supported");
    if (this.done !== undefined) return this.replay();
    if (typeof maxBytes !== "number" || Number.isNaN(maxBytes) || maxBytes < 0) {
      throw new RangeError("maxBytes must be a non-negative number");
    }
    const wanted = Math.min(Math.floor(maxBytes), MAX_STEP);
    if (wanted === 0) return EMPTY; // also 0.5: a fractional size must never look like the end
    this.busy = true;
    try {
      const data = await this.top.read(wanted);
      if (data.length === 0) {
        this.done = "end";
        return null;
      }
      this.produced += data.length;
      // SG-R-RAT-03: the same ratio test, end to end. The error follows these bytes. A layer that
      // already failed has the more specific error, so it wins.
      if (!this.top.failed && this.limits.ratioExceeded(this.produced, this.source.consumed)) {
        this.done = new RatioLimitError("end-to-end expansion over the whole chain", {
          limit: this.limits.maxRatio,
        });
      }
      return data;
    } catch (error) {
      if (error instanceof SpillgateError) this.done = error;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /** Read to the end. Memory grows with the bytes produced, never with a limit. */
  async readAll(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let chunk = await this.read(); chunk !== null; chunk = await this.read()) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  /** The decoded data as a web `ReadableStream`. Ending or cancelling the stream closes the reader. */
  toReadableStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await this.read();
          if (chunk === null) {
            controller.close();
            this.close();
          } else {
            controller.enqueue(chunk);
          }
        } catch (error) {
          this.close();
          controller.error(error);
        }
      },
      cancel: () => this.close(),
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, undefined> {
    try {
      for (let chunk = await this.read(); chunk !== null; chunk = await this.read()) yield chunk;
    } finally {
      this.close();
    }
  }

  /** Release codec state. Idempotent; the caller's source is left alone (SG-R-RDR-06). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const codecs = this.codecs;
    this.codecs = [];
    for (const codec of codecs) {
      try {
        codec.close?.();
      } catch {
        // one failing codec must not stop the others (SG-R-CDC-08)
      }
    }
    try {
      this.release?.();
    } catch {
      // releasing the source is best effort
    }
  }

  private replay(): Uint8Array | null {
    if (this.done === "end") return null;
    throw this.done;
  }
}
