/** The zstd stream: frames, skippable frames and the block loop. */

import { CorruptError, MemoryLimitError, SpillgateError } from "spillgate";
import type { CodecReader, CodecSource } from "spillgate";
import { BLOCK_MAX, FrameBody } from "./block.js";
import { XXH64 } from "./xxhash64.js";

const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIP_STEP = 4096;
const EMPTY = new Uint8Array(0);

const le = (bytes: Uint8Array): number => {
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i--) value = value * 256 + (bytes[i] as number);
  return value;
};

export class ZstdReader implements CodecReader {
  private frames = 0;
  private body: FrameBody | undefined;
  private hasher: XXH64 | undefined;
  private declared: number | undefined;
  private buffer: Uint8Array = EMPTY;
  private pos = 0;
  private deferred: SpillgateError | undefined;

  constructor(
    private readonly meter: CodecSource,
    private readonly maxWindow: number,
  ) {}

  async read(max: number): Promise<Uint8Array> {
    for (;;) {
      if (this.pos < this.buffer.length) {
        const chunk = this.buffer.slice(this.pos, this.pos + max);
        this.pos += chunk.length;
        return chunk;
      }
      if (this.deferred !== undefined) throw this.deferred;
      if (this.body === undefined) {
        if (!(await this.nextFrame())) return EMPTY;
      } else {
        await this.block(this.body);
      }
    }
  }

  close(): void {
    this.body = undefined;
    this.buffer = EMPTY;
  }

  // -- frames ---------------------------------------------------------------------

  /** Start the next frame. False means a clean end of the input. */
  private async nextFrame(): Promise<boolean> {
    const first = await this.meter.take(1);
    if (first.length === 0) {
      if (this.frames > 0) return false;
      throw new CorruptError("zstd: an empty input is not a zstd stream");
    }
    const rest = await this.meter.takeExact(3, "zstd magic number");
    const full = (first[0] as number) | ((rest[0] as number) << 8) | ((rest[1] as number) << 16) | ((rest[2] as number) * 2 ** 24);
    if ((full >>> 0) === FRAME_MAGIC) {
      await this.startFrame();
    } else if (((full & SKIPPABLE_MASK) >>> 0) === SKIPPABLE_MAGIC) {
      await this.skipFrame();
    } else {
      throw new CorruptError("zstd: data that is not a zstd frame follows the stream");
    }
    return true;
  }

  private async skipFrame(): Promise<void> {
    let size = le(await this.meter.takeExact(4, "zstd skippable frame"));
    while (size > 0) {
      const chunk = await this.meter.take(Math.min(size, SKIP_STEP));
      if (chunk.length === 0) throw new CorruptError("zstd: a skippable frame ends too early");
      size -= chunk.length;
    }
    this.frames++; // a skippable frame is a frame: the input may end after it
  }

  private async startFrame(): Promise<void> {
    const descriptor = (await this.meter.takeExact(1, "zstd frame header"))[0] as number;
    const singleSegment = (descriptor & (1 << 5)) !== 0;
    const checksum = (descriptor & (1 << 2)) !== 0;
    if (descriptor & (1 << 3)) throw new CorruptError("zstd: reserved bit set in the frame header");

    let window = 0;
    if (!singleSegment) {
      const wd = (await this.meter.takeExact(1, "zstd frame header"))[0] as number;
      const base = 2 ** (10 + (wd >> 3));
      window = base + (base / 8) * (wd & 7);
    }
    const dictionary = await this.meter.takeExact([0, 1, 2, 4][descriptor & 3] as number, "zstd frame header");
    if (dictionary.some((b) => b !== 0)) throw new CorruptError("zstd: the frame needs a dictionary");

    let fcsSize = [0, 2, 4, 8][descriptor >> 6] as number;
    if (descriptor >> 6 === 0 && singleSegment) fcsSize = 1;
    const fcs = await this.meter.takeExact(fcsSize, "zstd frame header");
    this.declared = fcs.length > 0 ? le(fcs) + (fcs.length === 2 ? 256 : 0) : undefined;
    if (singleSegment) window = this.declared ?? 0;

    if (window > this.maxWindow) {
      throw new MemoryLimitError(`zstd frame asks for a window of ${window} bytes (the cap is ${this.maxWindow})`);
    }
    this.body = new FrameBody(window);
    this.hasher = checksum ? new XXH64() : undefined;
  }

  // -- blocks ---------------------------------------------------------------------

  private async block(body: FrameBody): Promise<void> {
    const header = le(await this.meter.takeExact(3, "zstd block header"));
    const last = (header & 1) !== 0;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    if (type === 3) throw new CorruptError("zstd: reserved block type");
    if (size > BLOCK_MAX || size > body.blockMax) {
      throw new CorruptError(`zstd: block of ${size} bytes, the maximum is ${body.blockMax}`);
    }
    let out: Uint8Array;
    if (type === 1) {
      const byte = (await this.meter.takeExact(1, "zstd block"))[0] as number;
      out = body.rle(byte, size); // the size field is the regenerated size
    } else {
      const content = (await this.meter.takeExact(size, "zstd block")).slice(); // owned: the meter's chunk may be reused
      out = type === 0 ? body.raw(content) : body.compressed(content);
    }
    this.hasher?.update(out);
    this.buffer = out;
    this.pos = 0;
    if (last) await this.endFrame(body);
  }

  /**
   * The last block was decoded. A failure found here (checksum, declared size) is kept and raised
   * after the bytes of this block were delivered, as the output limit comes first in stream order
   * (SG-R-LAY-07).
   */
  private async endFrame(body: FrameBody): Promise<void> {
    try {
      if (this.hasher !== undefined) {
        const stored = le(await this.meter.takeExact(4, "zstd content checksum"));
        if (stored !== this.hasher.digest32()) throw new CorruptError("zstd: content checksum mismatch");
      }
      if (this.declared !== undefined && this.declared !== body.total) {
        // Only an integrity check; the declared size is never an allowance (SG-R-CDC-07).
        throw new CorruptError("zstd: the frame size differs from its declared size");
      }
    } catch (error) {
      if (!(error instanceof SpillgateError)) throw error;
      this.deferred = error;
    }
    this.body = undefined;
    this.hasher = undefined;
    this.frames++;
  }
}
