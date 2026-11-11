/** Bit readers for zstd (RFC 8878): forward for table descriptions, backward for the data. */

import { CorruptError } from "spillgate";

/** Little-endian value of `n <= 32` bits starting at bit `pos` of `bytes`; bits past the end read as 0. */
function bitsAt(bytes: Uint8Array, pos: number, n: number): number {
  if (n === 0) return 0;
  const first = pos >> 3;
  const shift = pos & 7;
  // up to 5 bytes: 40 bits, exact in a double
  let value = 0;
  let scale = 1;
  const last = Math.min(bytes.length - 1, first + ((shift + n - 1) >> 3));
  for (let i = first; i <= last; i++) {
    value += (bytes[i] as number) * scale;
    scale *= 256;
  }
  return Math.floor(value / 2 ** shift) % 2 ** n;
}

/** Reads bits starting at the least significant bit of the first byte (FSE table descriptions). */
export class ForwardBits {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  read(n: number): number {
    const value = bitsAt(this.bytes, this.pos, n);
    this.pos += n;
    return value;
  }

  /** Put back `n` bits just read. */
  unread(n: number): void {
    this.pos -= n;
  }

  /** The number of bytes touched so far (the position rounded up to a whole byte). */
  bytesUsed(): number {
    return (this.pos + 7) >> 3;
  }

  /** True if more bits were read than the buffer holds. */
  get overrun(): boolean {
    return this.pos > this.bytes.length * 8;
  }
}

/**
 * Reads bits from the end of a buffer towards its start (Huffman streams and sequences). The last
 * byte holds a padding sentinel: its highest set bit marks where the data ends. Reading past the
 * start yields zero bits, and {@link remaining} goes negative so the caller can tell.
 */
export class BackwardBits {
  /** Bits left to read. Negative after reading past the start. */
  remaining: number;

  constructor(private readonly bytes: Uint8Array) {
    const last = bytes[bytes.length - 1];
    if (last === undefined || last === 0) throw new CorruptError("zstd: a bit stream ends without its end mark");
    this.remaining = (bytes.length - 1) * 8 + (31 - Math.clz32(last));
  }

  /** Read `n <= 32` bits and move back. */
  read(n: number): number {
    if (n === 0) return 0;
    const pos = this.remaining - n;
    this.remaining = pos;
    if (pos >= 0) return bitsAt(this.bytes, pos, n);
    // some of the bits lie before the start: they read as zeros at the low end
    return bitsAt(this.bytes, 0, n + pos) * 2 ** -pos;
  }

  /** Look at the next `n` bits without moving. */
  peek(n: number): number {
    const saved = this.remaining;
    const value = this.read(n);
    this.remaining = saved;
    return value;
  }
}
