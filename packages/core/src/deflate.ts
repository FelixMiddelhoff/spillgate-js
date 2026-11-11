/**
 * HTTP `deflate` (RFC 9110 section 8.4.1.2), SG-R-CDC-03.
 *
 * `deflate` in HTTP means the zlib format (RFC 1950 around RFC 1951 data), but some senders omit
 * the wrapper. The first two bytes decide: a valid zlib header means zlib, anything else is raw
 * DEFLATE, unless `strictZlib` forbids the fallback.
 */

import { adler32 } from "./checksum.js";
import type { Codec, CodecReader } from "./codec.js";
import { CorruptError } from "./errors.js";
import { MAX_STEP } from "./guard.js";
import { DONE, Inflater, NEED_INPUT } from "./inflate.js";
import type { InputMeter } from "./meter.js";

const CM_DEFLATE = 8;
const MAX_CINFO = 7;
const FLAG_DICT = 1 << 5;
const CHECK_MODULUS = 31;
const TRAILER = 4; // Adler-32, big-endian
const EMPTY = new Uint8Array(0);

/** RFC 1950: CM = 8, CINFO <= 7 and (CMF * 256 + FLG) divisible by 31. */
export function isZlibHeader(cmf: number, flg: number): boolean {
  return (cmf & 0x0f) === CM_DEFLATE && cmf >> 4 <= MAX_CINFO && ((cmf << 8) | flg) % CHECK_MODULUS === 0;
}

/** The built-in `deflate` codec. */
export class DeflateCodec implements Codec {
  constructor(private readonly strictZlib = false) {}

  newReader(source: InputMeter): CodecReader {
    return new DeflateReader(source, this.strictZlib);
  }
}

class DeflateReader implements CodecReader {
  private inflater: Inflater | undefined;
  private adler: number | undefined; // undefined for raw DEFLATE
  private ended = false;
  private bodyDone = false;

  constructor(
    private readonly meter: InputMeter,
    private readonly strict: boolean,
  ) {}

  async read(max: number): Promise<Uint8Array> {
    if (this.ended) return EMPTY;
    if (this.inflater === undefined) await this.start();
    if (!this.bodyDone) {
      const data = await this.inflateStep(Math.min(max, MAX_STEP));
      if (data.length > 0) {
        if (this.adler !== undefined) this.adler = adler32(data, this.adler);
        return data;
      }
    }
    await this.finish();
    this.ended = true;
    return EMPTY;
  }

  close(): void {
    this.inflater = undefined;
  }

  private async start(): Promise<void> {
    const header = await this.meter.takeExact(2, "deflate header");
    if (isZlibHeader(header[0] as number, header[1] as number)) {
      if ((header[1] as number) & FLAG_DICT) throw new CorruptError("deflate: preset dictionaries are not supported");
      this.adler = 1; // the Adler-32 of no data
    } else if (this.strict) {
      throw new CorruptError("deflate: not a zlib stream");
    } else {
      this.meter.unread(header); // raw DEFLATE: the two bytes are data
    }
    this.inflater = new Inflater();
  }

  private async inflateStep(max: number): Promise<Uint8Array> {
    const inflater = this.inflater as Inflater;
    const out = new Uint8Array(max);
    for (;;) {
      let view = this.meter.view();
      let ended = false;
      if (view.length === 0) {
        // The decoder may still have output pending from bits it already holds (the rest of a
        // match), so it gets a step with no new input before the stream counts as truncated.
        if (await this.meter.fill()) view = this.meter.view();
        else ended = true;
      }
      const status = inflater.step(view, out);
      this.meter.advance(inflater.used);
      if (status === DONE) {
        this.meter.unread(inflater.leftover());
        this.bodyDone = true;
      }
      if (inflater.produced > 0) {
        return inflater.produced === out.length ? out : out.slice(0, inflater.produced);
      }
      if (status === DONE) return EMPTY;
      if (status === NEED_INPUT) {
        if (ended) throw new CorruptError("deflate: the stream ends too early");
        continue;
      }
    }
  }

  /** The DEFLATE data ended: verify the Adler-32 and that nothing follows. */
  private async finish(): Promise<void> {
    if (this.adler !== undefined) {
      const trailer = await this.meter.takeExact(TRAILER, "deflate trailer");
      const value = new DataView(trailer.buffer, trailer.byteOffset, 4).getUint32(0, false);
      if (value !== this.adler) throw new CorruptError("deflate: checksum mismatch");
    }
    if (!(await this.meter.atEnd())) throw new CorruptError("deflate: unexpected data after the end of the stream");
  }
}
