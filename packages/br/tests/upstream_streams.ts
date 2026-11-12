/**
 * Hand-built hostile brotli streams for the upstream-fix probes (`upstream_fixes.test.ts`): the
 * robustness fixes of brotli-decompressor 5.0.0 .. 6.3.1, as streams. Every meta-block uses
 * one-symbol prefix codes (they cost no input bits), so the commands can be chosen freely.
 */

/** LSB-first bit writer that knows how many bits are pending (the padding to the byte boundary). */
export class Bits {
  private out: number[] = [];
  private acc = 0;
  private count = 0;

  bits(value: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.acc |= ((value >>> i) & 1) << this.count;
      if (++this.count === 8) {
        this.out.push(this.acc);
        this.acc = 0;
        this.count = 0;
      }
    }
  }

  /** The bits up to the next byte boundary (none when aligned). */
  pad(value: number): void {
    if (this.count > 0) this.bits(value, 8 - this.count);
  }

  raw(bytes: Uint8Array): void {
    if (this.count !== 0) throw new Error("not aligned");
    for (const b of bytes) this.out.push(b);
  }

  finish(): Uint8Array {
    this.pad(0);
    return Uint8Array.from(this.out);
  }
}

/** One meta-block of the compressed kind. */
export interface Block {
  /** MLEN as declared in the header, 1 .. 2**24. */
  mlen: number;
  last?: boolean;
  /** Insert-and-copy symbol, 0 .. 703 (10 bits). */
  command: number;
  /** Extra bits after the command symbol, in the order they are read: `[value, bits]`. */
  extra?: Array<[number, number]>;
  /** The one literal (a one-symbol code, costs no bits). */
  literal?: number;
  /** The distance symbol (a one-symbol code; the command may not read it). */
  distance?: number;
  /** Number of commands: all of them are the same symbol and cost no bits except `extra`. */
  repeat?: number;
}

function windowBits(w: Bits, wbits: number): void {
  if (wbits === 16) w.bits(0, 1);
  else if (wbits >= 18 && wbits <= 24) {
    w.bits(1, 1);
    w.bits(wbits - 17, 3);
  } else if (wbits >= 10 && wbits <= 15) {
    w.bits(1, 1);
    w.bits(0, 3);
    w.bits(wbits - 8, 3);
  } else throw new RangeError("wbits");
}

function mlenField(w: Bits, mlen: number, last: boolean): void {
  w.bits(last ? 1 : 0, 1); // ISLAST
  if (last) w.bits(0, 1); // ISLASTEMPTY = 0
  const value = mlen - 1;
  if (value < 1 << 16) {
    w.bits(0, 2);
    w.bits(value, 16);
  } else if (value < 1 << 20) {
    w.bits(1, 2);
    w.bits(value, 20);
  } else {
    w.bits(2, 2);
    w.bits(value, 24);
  }
}

function simpleCode(w: Bits, symbol: number, symbolBits: number): void {
  w.bits(1, 2); // HSKIP = 1: simple prefix code
  w.bits(0, 2); // one symbol
  w.bits(symbol, symbolBits);
}

export function compressedBlock(w: Bits, b: Block): void {
  const last = b.last === true;
  mlenField(w, b.mlen, last);
  if (!last) w.bits(0, 1); // ISUNCOMPRESSED
  w.bits(0, 3); // NBLTYPESL, NBLTYPESI, NBLTYPESD = 1
  w.bits(0, 2); // NPOSTFIX
  w.bits(0, 4); // NDIRECT
  w.bits(0, 2); // context mode
  w.bits(0, 2); // NTREESL = 1, NTREESD = 1
  simpleCode(w, b.literal ?? 0x41, 8);
  simpleCode(w, b.command, 10);
  simpleCode(w, b.distance ?? 0, 6);
  for (let i = 0; i < (b.repeat ?? 1); i++) for (const [value, bits] of b.extra ?? []) w.bits(value, bits);
}

/** An uncompressed meta-block; `padding` are the bits skipped to the byte boundary (0 = valid). */
export function uncompressedBlock(w: Bits, payload: Uint8Array, padding = 0, last = false): void {
  mlenField(w, payload.length, last);
  w.bits(1, 1); // ISUNCOMPRESSED
  w.pad(padding);
  w.raw(payload);
}

export function endOfStream(w: Bits): void {
  w.bits(1, 1); // ISLAST
  w.bits(1, 1); // ISLASTEMPTY
}

export function stream(wbits: number, build: (w: Bits) => void): Uint8Array {
  const w = new Bits();
  windowBits(w, wbits);
  build(w);
  return w.finish();
}

// Insert-and-copy symbols (RFC 7932 section 5): cell 0 = insert codes 0-7 and copy codes 0-7 with the
// implicit "last distance" (no distance symbol read), cell 384 = insert 0-7 / copy 16-23, 448 =
// insert 16-23 / copy 0-7.
export const insertCopy = (insertCode: number, copyCode: number): number => (insertCode << 3) | copyCode;
export const copyLong = (insertCode: number, copyCode: number): number => 384 + (insertCode << 3) + (copyCode - 16);
export const insertLong = (insertCode: number, copyCode: number): number => 448 + ((insertCode - 16) << 3) + copyCode;
