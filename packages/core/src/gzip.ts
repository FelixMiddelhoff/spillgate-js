/**
 * gzip (RFC 1952), SG-R-CDC-02.
 *
 * The framing is parsed here, so every size is bounded and every rule of the specification is
 * explicit; the DEFLATE body is decoded by {@link Inflater}.
 */

import type { Codec, CodecReader } from "./codec.js";
import { CorruptError } from "./errors.js";
import { DONE, Inflater, NEED_INPUT } from "./inflate.js";
import { MAX_STEP } from "./guard.js";
import type { InputMeter } from "./meter.js";
import { crc32 } from "./checksum.js";

const ID1 = 0x1f;
const ID2 = 0x8b;
const CM_DEFLATE = 8;
const FLAG_HCRC = 1 << 1;
const FLAG_EXTRA = 1 << 2;
const FLAG_NAME = 1 << 3;
const FLAG_COMMENT = 1 << 4;
const RESERVED_FLAGS = 0xe0; // RFC 1952 requires an error if any is set
const FIXED_HEADER = 10;
const TRAILER = 8;
const MAX_STRING = 512; // FNAME and FCOMMENT, terminator included
const EMPTY = new Uint8Array(0);

/** The built-in `gzip` codec. */
export class GzipCodec implements Codec {
  newReader(source: InputMeter): CodecReader {
    return new GzipReader(source);
  }
}

class GzipReader implements CodecReader {
  private inflater: Inflater | undefined;
  private crc = 0;
  private size = 0; // modulo 2**32
  private bodyEnded = false; // the body ended; its trailer is checked on the next read
  private finished = false;

  constructor(private readonly meter: InputMeter) {}

  async read(max: number): Promise<Uint8Array> {
    if (this.finished) return EMPTY;
    if (this.inflater === undefined) await this.startMember(true); // the first member is mandatory
    for (;;) {
      if (this.bodyEnded) {
        this.bodyEnded = false;
        if (!(await this.finishMember())) {
          this.finished = true;
          return EMPTY; // clean end after the last member
        }
      }
      const data = await this.inflateStep(Math.min(max, MAX_STEP));
      if (data.length > 0) return data;
      // The body ended without output; its trailer is checked now (bytes already produced were
      // delivered first, as in the reference implementation).
    }
  }

  close(): void {
    this.inflater = undefined;
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
        this.meter.unread(inflater.leftover()); // the trailer starts at the first unused byte
        this.bodyEnded = true;
      }
      if (inflater.produced > 0) {
        // A copy when the buffer is mostly unused: a retained small chunk must not pin a whole step buffer.
        const data = inflater.produced === out.length ? out : out.slice(0, inflater.produced);
        this.crc = crc32(data, this.crc);
        this.size = (this.size + data.length) >>> 0;
        return data;
      }
      if (status === DONE) return EMPTY;
      if (status === NEED_INPUT) {
        if (ended) throw new CorruptError("gzip: the stream ends too early");
        continue;
      }
    }
  }

  /** Check the trailer; start the next member. False means a clean end. */
  private async finishMember(): Promise<boolean> {
    const trailer = await this.meter.takeExact(TRAILER, "gzip trailer");
    const view = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
    if (view.getUint32(0, true) !== this.crc) throw new CorruptError("gzip: checksum mismatch");
    if (view.getUint32(4, true) !== this.size) throw new CorruptError("gzip: size mismatch"); // ISIZE is checked, never trusted
    this.crc = 0;
    this.size = 0;
    return this.startMember(false);
  }

  /** Parse a member header. False means no further member (clean end). */
  private async startMember(first: boolean): Promise<boolean> {
    if (!first) {
      const probe = await this.meter.take(1);
      if (probe.length === 0) return false;
      this.meter.unread(probe);
    }
    const fixed = await this.meter.takeExact(FIXED_HEADER, "gzip header");
    if (fixed[0] !== ID1 || fixed[1] !== ID2 || fixed[2] !== CM_DEFLATE) {
      throw new CorruptError("gzip: invalid header");
    }
    const flags = fixed[3] as number;
    if (flags & RESERVED_FLAGS) throw new CorruptError("gzip: reserved header flags are set");

    let headerCrc = crc32(fixed, 0);
    if (flags & FLAG_EXTRA) headerCrc = await this.skipExtra(headerCrc);
    if (flags & FLAG_NAME) headerCrc = await this.skipString(headerCrc, "name");
    if (flags & FLAG_COMMENT) headerCrc = await this.skipString(headerCrc, "comment");
    if (flags & FLAG_HCRC) {
      const stored = await this.meter.takeExact(2, "gzip header checksum");
      if (((stored[0] as number) | ((stored[1] as number) << 8)) !== (headerCrc & 0xffff)) {
        throw new CorruptError("gzip: header checksum mismatch");
      }
    }
    // One decoder serves all members of the stream: a fresh one per member would allocate its
    // window and tables again for every tiny member.
    if (this.inflater === undefined) this.inflater = new Inflater();
    else this.inflater.reset();
    return true;
  }

  /** FEXTRA: at most 65535 bytes by format, read in small pieces (SG-R-MEM-01). */
  private async skipExtra(headerCrc: number): Promise<number> {
    const lengthBytes = await this.meter.takeExact(2, "gzip extra field");
    headerCrc = crc32(lengthBytes, headerCrc);
    let remaining = (lengthBytes[0] as number) | ((lengthBytes[1] as number) << 8);
    while (remaining > 0) {
      const chunk = await this.meter.takeExact(Math.min(remaining, MAX_STRING), "gzip extra field");
      headerCrc = crc32(chunk, headerCrc);
      remaining -= chunk.length;
    }
    return headerCrc;
  }

  /** FNAME / FCOMMENT: zero-terminated, at most 512 bytes including the terminator. */
  private async skipString(headerCrc: number, what: string): Promise<number> {
    let taken = 0;
    while (taken < MAX_STRING) {
      const chunk = await this.meter.take(MAX_STRING - taken);
      if (chunk.length === 0) throw new CorruptError(`gzip: header ${what} ends too early`);
      const end = chunk.indexOf(0);
      if (end >= 0) {
        this.meter.unread(chunk.subarray(end + 1));
        return crc32(chunk.subarray(0, end + 1), headerCrc);
      }
      headerCrc = crc32(chunk, headerCrc);
      taken += chunk.length;
    }
    throw new CorruptError(`gzip: header ${what} is longer than ${MAX_STRING - 1} bytes`);
  }
}
