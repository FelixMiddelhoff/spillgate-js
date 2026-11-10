/**
 * The layer guard: everything the specification demands of one layer.
 *
 * Whatever the codec does, the guard never hands out more than `maxOutput` bytes in total
 * (SG-I-01), never turns a limit hit into a clean end (SG-I-02), and keeps failing with the same
 * error once one occurred (SG-I-03).
 */

import type { CodecReader } from "./codec.js";
import {
  CanceledError,
  InternalError,
  OutputLimitError,
  RatioLimitError,
  SpillgateError,
} from "./errors.js";
import type { EffectiveLimits } from "./limits.js";
import type { InputMeter } from "./meter.js";

/**
 * The most a guard asks a codec for in one call. It bounds the memory of one step (SG-R-MEM-02)
 * whatever size of buffer the caller reads with; callers get short reads, which every reader
 * contract allows.
 */
export const MAX_STEP = 256 * 1024;

const EMPTY = new Uint8Array(0);

export interface Readable {
  /** Up to `max` bytes; an empty array is the clean end. */
  read(max: number): Promise<Uint8Array>;
}

export class LayerGuard implements Readable {
  private produced = 0;
  private done: "end" | SpillgateError | undefined;

  constructor(
    private readonly codec: CodecReader,
    private readonly meter: InputMeter,
    private readonly layer: number,
    private readonly limits: EffectiveLimits,
    private readonly signal?: AbortSignal,
  ) {}

  /** True once the layer has a terminal error (a clean end is not a failure). */
  get failed(): boolean {
    return this.done instanceof SpillgateError;
  }

  async read(max: number): Promise<Uint8Array> {
    if (this.done !== undefined) return this.replay();
    if (max <= 0) return EMPTY; // SG-R-RDR-02: a zero-length read changes nothing
    if (this.signal?.aborted) {
      this.done = new CanceledError("canceled by the caller", { layer: this.layer, cause: this.signal.reason });
      return this.replay();
    }
    const remaining = this.limits.maxOutput - this.produced;
    if (remaining <= 0) return this.probe();
    const data = await this.callCodec(Math.min(max, remaining, MAX_STEP));
    if (data.length === 0) {
      this.done = "end";
      return EMPTY;
    }
    this.produced += data.length;
    // The bytes that broke the ratio were produced first, so they are still delivered; the error
    // follows on the next read (SG-R-LAY-07).
    if (this.limits.ratioExceeded(this.produced, this.meter.consumed)) {
      this.done = new RatioLimitError(
        `output of ${this.produced} bytes from ${this.meter.consumed} input bytes`,
        { layer: this.layer, limit: this.limits.maxRatio },
      );
    }
    return data;
  }

  private replay(): Uint8Array {
    if (this.done === "end") return EMPTY;
    throw this.done;
  }

  /**
   * The budget is used up: is there one more byte? (SG-R-LAY-03) If the codec yields a byte, the
   * limit is exceeded and the byte is thrown away. If the stream ends cleanly the output was
   * exactly at the limit and all is well. The codec's own validation, such as a trailer checksum,
   * still runs inside this call and can still report corruption.
   */
  private async probe(): Promise<Uint8Array> {
    const data = await this.callCodec(1);
    this.done =
      data.length > 0
        ? new OutputLimitError(`the layer would produce more than ${this.limits.maxOutput} bytes`, {
            layer: this.layer,
            limit: this.limits.maxOutput,
          })
        : "end";
    return this.replay();
  }

  /** One codec read, with its failures contained (SG-R-CDC-08). */
  private async callCodec(max: number): Promise<Uint8Array> {
    try {
      const data: unknown = await this.codec.read(max);
      if (!(data instanceof Uint8Array)) {
        throw new InternalError(`codec returned ${data === null ? "null" : typeof data}, not bytes`, { layer: this.layer });
      }
      if (data.length > max) {
        throw new InternalError("codec returned more bytes than requested", { layer: this.layer });
      }
      return data;
    } catch (error) {
      this.done = this.classify(error);
      throw this.done;
    }
  }

  /** An unexpected exception is a codec bug, unless the source caused it. */
  private classify(error: unknown): SpillgateError {
    if (error instanceof SpillgateError) return error.withLayer(this.layer);
    const sourceFailure = this.meter.sourceFailure;
    if (sourceFailure !== undefined) return sourceFailure.withLayer(this.layer);
    const name = error instanceof Error ? error.constructor.name : typeof error;
    return new InternalError(`codec threw ${name}`, { layer: this.layer, cause: error });
  }
}
