/**
 * A resumable raw-DEFLATE decoder (RFC 1951) with exact input accounting.
 *
 * Why not `node:zlib` or `DecompressionStream`? Their streaming interfaces cannot bound the
 * output of one write (an 800 byte input can expand to gigabytes before the first byte is handed
 * out), cannot say how many input bytes the stream used, and handle bytes after the end of the
 * stream differently in different engines. This decoder works like zlib's `inflate()`: the caller
 * passes some input and an output buffer of any size; it stops when either is exhausted and
 * remembers where it was. It takes input one byte at a time into its bit buffer, so after the
 * final block it can hand back every whole byte it did not need (the trailer of a gzip or zlib
 * stream starts there).
 *
 * Memory: a 32 KiB window and three code tables, about 130 KiB, whatever the data.
 */

import { CorruptError } from "./errors.js";

export const NEED_INPUT = 0;
export const OUTPUT_FULL = 1;
export const DONE = 2;
export type Status = typeof NEED_INPUT | typeof OUTPUT_FULL | typeof DONE;

const WINDOW_SIZE = 32768;
const WINDOW_MASK = WINDOW_SIZE - 1;
const MAX_BITS = 15;

// states
const BLOCK_HEADER = 0;
const STORED_LENGTH = 1;
const STORED_COPY = 2;
const STORED_COMPLEMENT = 13;
const DYN_COUNTS = 3;
const DYN_CODE_LENGTHS = 4;
const DYN_SYMBOLS = 5;
const DYN_REPEAT = 6;
const LENGTH_SYMBOL = 7;
const LENGTH_EXTRA = 8;
const DISTANCE_SYMBOL = 9;
const DISTANCE_EXTRA = 10;
const COPY = 11;
const FINISHED = 12;

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA_BITS = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A decoding table: `table[bits & mask]` is `symbol << 4 | length`, or 0 for an invalid code. */
interface Table {
  readonly entries: Uint16Array;
  mask: number;
  /** The length of the longest code; an unassigned slot is invalid only once that many bits are real. */
  bits: number;
}

function newTable(bits: number): Table {
  return { entries: new Uint16Array(1 << bits), mask: 0, bits: 0 };
}

/**
 * Build a canonical Huffman decoding table from code lengths (RFC 1951 section 3.2.2).
 * Returns false for an over-subscribed set, and for an incomplete one unless it is the single
 * code of length 1 that zlib also accepts (`allowIncomplete`), or there are no codes at all.
 */
function buildTable(
  lengths: Uint8Array,
  start: number,
  count: number,
  table: Table,
  allowIncomplete: boolean,
): boolean {
  const perLength = new Uint16Array(MAX_BITS + 1);
  let maxLength = 0;
  for (let i = 0; i < count; i++) {
    const length = lengths[start + i] as number;
    perLength[length] = (perLength[length] as number) + 1;
    if (length > maxLength) maxLength = length;
  }
  table.mask = (1 << maxLength) - 1;
  table.bits = maxLength;
  table.entries.fill(0, 0, 1 << maxLength);
  if (maxLength === 0) return true; // no codes: any code decoded later is invalid

  let left = 1;
  const nextCode = new Uint16Array(MAX_BITS + 2);
  for (let length = 1; length <= MAX_BITS; length++) {
    left = (left << 1) - (perLength[length] as number);
    if (left < 0) return false; // over-subscribed
    nextCode[length + 1] = (nextCode[length] as number) + (perLength[length] as number);
  }
  if (left > 0 && !(allowIncomplete && maxLength === 1)) return false; // incomplete

  // first code of each length, then assign
  const firstCode = new Uint16Array(MAX_BITS + 2);
  let code = 0;
  for (let length = 1; length <= MAX_BITS; length++) {
    code = (code + (perLength[length - 1] as number)) << 1;
    firstCode[length] = code;
  }
  firstCode[0] = 0;
  const assigned = new Uint16Array(MAX_BITS + 2);
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[start + symbol] as number;
    if (length === 0) continue;
    const value = (firstCode[length] as number) + (assigned[length] as number);
    assigned[length] = (assigned[length] as number) + 1;
    // deflate packs Huffman codes most significant bit first into a least-significant-first stream
    let reversed = 0;
    for (let bit = 0; bit < length; bit++) reversed |= ((value >> bit) & 1) << (length - 1 - bit);
    const entry = (symbol << 4) | length;
    for (let index = reversed; index < 1 << maxLength; index += 1 << length) {
      table.entries[index] = entry;
    }
  }
  return true;
}

// Fixed Huffman tables (RFC 1951 section 3.2.6), built once.
let fixedLiteral: Table | undefined;
let fixedDistance: Table | undefined;
function fixedTables(): [Table, Table] {
  if (fixedLiteral === undefined || fixedDistance === undefined) {
    const lengths = new Uint8Array(288 + 32);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    lengths.fill(5, 288, 320); // 32 distance codes; symbols 30 and 31 are invalid when decoded
    fixedLiteral = newTable(MAX_BITS);
    fixedDistance = newTable(MAX_BITS);
    buildTable(lengths, 0, 288, fixedLiteral, false);
    buildTable(lengths, 288, 32, fixedDistance, false);
  }
  return [fixedLiteral, fixedDistance];
}

export class Inflater {
  /** Input bytes consumed by the last {@link step}. */
  used = 0;
  /** Output bytes written by the last {@link step}. */
  produced = 0;

  private state = BLOCK_HEADER;
  private final = false;
  private bitBuf = 0;
  private bitCount = 0;

  private readonly window = new Uint8Array(WINDOW_SIZE);
  private windowPos = 0; // total bytes written, modulo nothing: masked on use
  private windowFilled = 0;

  private storedLeft = 0;

  private readonly lengths = new Uint8Array(286 + 30);
  private literalCount = 0;
  private distanceCount = 0;
  private codeLengthCount = 0;
  private codeLengthIndex = 0;
  private lengthIndex = 0;
  private repeatSymbol = 0;
  private previousLength = 0;

  private readonly codeLengthTable = newTable(7);
  private readonly dynamicLiteral = newTable(MAX_BITS);
  private readonly dynamicDistance = newTable(MAX_BITS);
  private literalTable: Table = this.dynamicLiteral;
  private distanceTable: Table = this.dynamicDistance;

  private matchLength = 0;
  private matchDistance = 0;
  private lengthCode = 0;

  // The input of the current step, for the helpers below.
  private input: Uint8Array = new Uint8Array(0);
  private inPos = 0;

  /**
   * Decode as much as the input and the output buffer allow.
   *
   * @returns `NEED_INPUT` (all input used, more is needed), `OUTPUT_FULL` (the buffer is full and
   *   the stream continues) or `DONE` (the final block ended; see {@link leftover}).
   * @throws CorruptError invalid DEFLATE data
   */
  step(input: Uint8Array, out: Uint8Array): Status {
    if (this.pending !== undefined) {
      // An error found after bytes were already written: those were delivered, now it follows.
      const error = this.pending;
      this.pending = undefined;
      this.used = 0;
      this.produced = 0;
      throw error;
    }
    this.input = input;
    this.inPos = 0;
    this.partial = 0;
    let outPos = 0;
    try {
      outPos = this.run(out);
    } catch (error) {
      // What is delivered before an error must not depend on the size of the caller's buffer
      // (SG-R-RDR-01): keep the error for the next step and hand out the bytes now.
      if (error instanceof CorruptError && this.partial > 0) {
        this.pending = error;
        this.status = OUTPUT_FULL;
        outPos = this.partial;
      } else {
        throw error;
      }
    } finally {
      this.used = this.inPos;
      this.input = EMPTY;
    }
    this.produced = outPos;
    return this.status;
  }

  /** Bytes written by a `run` that ended with an error, and the error held back until the next step. */
  private partial = 0;
  private pending: CorruptError | undefined;

  private status: Status = NEED_INPUT;

  /** Start a new stream with the same memory (the next gzip member): no allocation. */
  reset(): void {
    this.state = BLOCK_HEADER;
    this.final = false;
    this.bitBuf = 0;
    this.bitCount = 0;
    this.windowPos = 0;
    this.windowFilled = 0;
    this.status = NEED_INPUT;
    this.pending = undefined;
  }

  /** Whole input bytes that were read into the bit buffer but are not part of the stream. */
  leftover(): Uint8Array {
    if (this.state !== FINISHED) return EMPTY;
    const bytes = this.bitCount >> 3;
    const skipped = this.bitCount & 7;
    const out = new Uint8Array(bytes);
    let buf = this.bitBuf >>> skipped;
    for (let i = 0; i < bytes; i++) {
      out[i] = buf & 0xff;
      buf >>>= 8;
    }
    this.bitBuf = 0;
    this.bitCount = 0;
    return out;
  }

  // -- bit input -----------------------------------------------------------------------

  /** Make `n` bits (n <= 24) available if the input allows. */
  private ensure(n: number): boolean {
    while (this.bitCount < n) {
      if (this.inPos >= this.input.length) return false;
      this.bitBuf = (this.bitBuf | ((this.input[this.inPos++] as number) << this.bitCount)) >>> 0;
      this.bitCount += 8;
    }
    return true;
  }

  private take(n: number): number {
    const value = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return value;
  }

  private corrupt(what: string): never {
    throw new CorruptError(`deflate: ${what}`);
  }

  // -- the state machine ---------------------------------------------------------------

  private run(out: Uint8Array): number {
    let outPos = 0;
    const win = this.window;
    try {
    for (;;) {
      switch (this.state) {
        case BLOCK_HEADER: {
          if (this.final) {
            this.state = FINISHED;
            break;
          }
          if (!this.ensure(3)) return this.need(outPos);
          this.final = this.take(1) === 1;
          const type = this.take(2);
          if (type === 0) {
            this.state = STORED_LENGTH;
          } else if (type === 1) {
            [this.literalTable, this.distanceTable] = fixedTables();
            this.state = LENGTH_SYMBOL;
          } else if (type === 2) {
            this.state = DYN_COUNTS;
          } else {
            this.corrupt("invalid block type");
          }
          break;
        }
        case STORED_LENGTH: {
          const skip = this.bitCount & 7;
          if (skip) this.take(skip); // padding to the byte boundary
          if (!this.ensure(16)) return this.need(outPos);
          this.storedLeft = this.take(16);
          this.state = STORED_COMPLEMENT;
          break;
        }
        case STORED_COMPLEMENT: {
          if (!this.ensure(16)) return this.need(outPos);
          if ((this.storedLeft ^ this.take(16)) !== 0xffff) this.corrupt("invalid stored block lengths");
          this.state = STORED_COPY;
          break;
        }
        case STORED_COPY: {
          while (this.storedLeft > 0 && this.bitCount >= 8) {
            if (outPos >= out.length) return this.full(outPos);
            const byte = this.take(8);
            out[outPos++] = byte;
            this.pushWindow(byte);
            this.storedLeft--;
          }
          if (this.storedLeft > 0) {
            if (outPos >= out.length) return this.full(outPos);
            const n = Math.min(this.storedLeft, this.input.length - this.inPos, out.length - outPos);
            if (n === 0) return this.need(outPos);
            const chunk = this.input.subarray(this.inPos, this.inPos + n);
            out.set(chunk, outPos);
            this.pushWindowBytes(chunk);
            this.inPos += n;
            outPos += n;
            this.storedLeft -= n;
            if (this.storedLeft > 0) continue;
          }
          this.state = BLOCK_HEADER;
          break;
        }
        case DYN_COUNTS: {
          if (!this.ensure(14)) return this.need(outPos);
          this.literalCount = this.take(5) + 257;
          this.distanceCount = this.take(5) + 1;
          this.codeLengthCount = this.take(4) + 4;
          if (this.literalCount > 286 || this.distanceCount > 30) {
            this.corrupt("too many length or distance symbols");
          }
          this.lengths.fill(0);
          this.codeLengthIndex = 0;
          this.state = DYN_CODE_LENGTHS;
          break;
        }
        case DYN_CODE_LENGTHS: {
          while (this.codeLengthIndex < this.codeLengthCount) {
            if (!this.ensure(3)) return this.need(outPos);
            this.lengths[CODE_LENGTH_ORDER[this.codeLengthIndex++] as number] = this.take(3);
          }
          const lengths = new Uint8Array(19);
          lengths.set(this.lengths.subarray(0, 19));
          this.lengths.fill(0);
          if (!buildTable(lengths, 0, 19, this.codeLengthTable, false)) {
            this.corrupt("invalid code lengths set");
          }
          this.lengthIndex = 0;
          this.previousLength = 0;
          this.state = DYN_SYMBOLS;
          break;
        }
        case DYN_SYMBOLS: {
          const total = this.literalCount + this.distanceCount;
          while (this.lengthIndex < total) {
            this.ensure(7); // fewer bits are fine if the code is short
            const entry = this.codeLengthTable.entries[this.bitBuf & this.codeLengthTable.mask] as number;
            const length = entry & 15;
            if (length === 0) this.corrupt("invalid code length code");
            if (length > this.bitCount) return this.need(outPos);
            const symbol = entry >> 4;
            this.take(length);
            if (symbol < 16) {
              this.lengths[this.lengthIndex++] = symbol;
              this.previousLength = symbol;
            } else {
              this.repeatSymbol = symbol;
              this.state = DYN_REPEAT;
              break;
            }
          }
          if (this.state === DYN_SYMBOLS) {
            this.finishDynamicTables();
          }
          break;
        }
        case DYN_REPEAT: {
          const symbol = this.repeatSymbol;
          const extraBits = symbol === 16 ? 2 : symbol === 17 ? 3 : 7;
          if (!this.ensure(extraBits)) return this.need(outPos);
          const extra = this.take(extraBits);
          let repeat: number;
          let value = 0;
          if (symbol === 16) {
            if (this.lengthIndex === 0) this.corrupt("repeat with no previous length");
            value = this.previousLength;
            repeat = 3 + extra;
          } else if (symbol === 17) {
            repeat = 3 + extra;
          } else {
            repeat = 11 + extra;
          }
          if (this.lengthIndex + repeat > this.literalCount + this.distanceCount) {
            this.corrupt("too many code lengths");
          }
          this.lengths.fill(value, this.lengthIndex, this.lengthIndex + repeat);
          this.lengthIndex += repeat;
          // A later "repeat previous" (16) repeats the last length written, which after 17 or 18 is 0.
          this.previousLength = value;
          this.state = DYN_SYMBOLS;
          break;
        }
        case LENGTH_SYMBOL: {
          // The literal/length symbol is peeked: a literal that cannot be written yet is not consumed.
          this.ensure(MAX_BITS);
          const table = this.literalTable;
          const entry = table.entries[this.bitBuf & table.mask] as number;
          const length = entry & 15;
          if (length === 0) {
            if (this.bitCount >= table.bits) this.corrupt("invalid literal/length code");
            return this.need(outPos);
          }
          if (length > this.bitCount) return this.need(outPos);
          const symbol = entry >> 4;
          if (symbol < 256) {
            if (outPos >= out.length) return this.full(outPos);
            this.take(length);
            out[outPos++] = symbol;
            this.pushWindow(symbol);
          } else if (symbol === 256) {
            this.take(length);
            this.state = BLOCK_HEADER;
          } else {
            if (symbol > 285) this.corrupt("invalid length symbol");
            this.take(length);
            this.lengthCode = symbol - 257;
            this.state = LENGTH_EXTRA;
          }
          break;
        }
        case LENGTH_EXTRA: {
          const extraBits = LENGTH_EXTRA_BITS[this.lengthCode] as number;
          if (!this.ensure(extraBits)) return this.need(outPos);
          this.matchLength = (LENGTH_BASE[this.lengthCode] as number) + this.take(extraBits);
          this.state = DISTANCE_SYMBOL;
          break;
        }
        case DISTANCE_SYMBOL: {
          this.ensure(MAX_BITS);
          const table = this.distanceTable;
          const entry = table.entries[this.bitBuf & table.mask] as number;
          const length = entry & 15;
          if (length === 0) {
            if (this.bitCount >= table.bits) this.corrupt("invalid distance code");
            return this.need(outPos);
          }
          if (length > this.bitCount) return this.need(outPos);
          const symbol = entry >> 4;
          if (symbol > 29) this.corrupt("invalid distance symbol");
          this.take(length);
          this.lengthCode = symbol; // reused for the distance symbol
          this.state = DISTANCE_EXTRA;
          break;
        }
        case DISTANCE_EXTRA: {
          const extraBits = DISTANCE_EXTRA_BITS[this.lengthCode] as number;
          if (!this.ensure(extraBits)) return this.need(outPos);
          this.matchDistance = (DISTANCE_BASE[this.lengthCode] as number) + this.take(extraBits);
          if (this.matchDistance > this.windowFilled) this.corrupt("distance too far back");
          this.state = COPY;
          break;
        }
        case COPY: {
          let remaining = this.matchLength;
          let pos = this.windowPos;
          const distance = this.matchDistance;
          const room = out.length - outPos;
          const n = remaining < room ? remaining : room;
          for (let i = 0; i < n; i++) {
            const byte = win[(pos - distance) & WINDOW_MASK] as number;
            out[outPos++] = byte;
            win[pos & WINDOW_MASK] = byte;
            pos++;
          }
          this.windowPos = pos;
          this.windowFilled = Math.min(WINDOW_SIZE, this.windowFilled + n);
          remaining -= n;
          this.matchLength = remaining;
          if (remaining > 0) return this.full(outPos);
          this.state = LENGTH_SYMBOL;
          break;
        }
        case FINISHED:
          this.status = DONE;
          return outPos;
      }
    }
    } catch (error) {
      // The bytes written before the error are still delivered (see step()).
      this.partial = outPos;
      throw error;
    }
  }

  private finishDynamicTables(): void {
    if ((this.lengths[256] as number) === 0) this.corrupt("missing end-of-block code");
    if (!buildTable(this.lengths, 0, this.literalCount, this.dynamicLiteral, true)) {
      this.corrupt("invalid literal/length code lengths");
    }
    if (!buildTable(this.lengths, this.literalCount, this.distanceCount, this.dynamicDistance, true)) {
      this.corrupt("invalid distance code lengths");
    }
    this.literalTable = this.dynamicLiteral;
    this.distanceTable = this.dynamicDistance;
    this.state = LENGTH_SYMBOL;
  }

  private need(outPos: number): number {
    this.status = NEED_INPUT;
    return outPos;
  }

  private full(outPos: number): number {
    this.status = OUTPUT_FULL;
    return outPos;
  }

  private pushWindow(byte: number): void {
    this.window[this.windowPos & WINDOW_MASK] = byte;
    this.windowPos++;
    if (this.windowFilled < WINDOW_SIZE) this.windowFilled++;
  }

  private pushWindowBytes(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.window[(this.windowPos + i) & WINDOW_MASK] = chunk[i] as number;
    }
    this.windowPos += chunk.length;
    this.windowFilled = Math.min(WINDOW_SIZE, this.windowFilled + chunk.length);
  }
}

const EMPTY = new Uint8Array(0);
