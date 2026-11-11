/**
 * One zstd frame body: blocks, literals, sequences (RFC 8878 sections 3.1.1.2 to 3.1.1.4).
 *
 * The decoder keeps what the format lets blocks share: the window of recent output, the three
 * repeat offsets, the last Huffman table and the last sequence tables. It decodes one block at a
 * time, and a block never regenerates more than 128 KiB, so memory per step is constant.
 */

import { CorruptError } from "spillgate";
import { BackwardBits } from "./bits.js";
import { buildTable, readTable, rleTable, type FseTable } from "./fse.js";
import { decodeStream, readHuffmanTable, type HuffmanTable } from "./huffman.js";

export const BLOCK_MAX = 128 * 1024;

const LL_BASE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192,
  16384, 32768, 65536,
];
const LL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
const ML_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41,
  43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539,
];
const ML_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9,
  10, 11, 12, 13, 14, 15, 16,
];

const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
const ML_DEFAULT = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  -1, -1, -1, -1, -1, -1, -1,
];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];

let defaults: { ll: FseTable; ml: FseTable; of: FseTable } | undefined;
function predefined(): { ll: FseTable; ml: FseTable; of: FseTable } {
  defaults ??= { ll: buildTable(LL_DEFAULT, 6), ml: buildTable(ML_DEFAULT, 6), of: buildTable(OF_DEFAULT, 5) };
  return defaults;
}

export class FrameBody {
  /** Bytes regenerated so far in this frame. */
  total = 0;

  private readonly window: Uint8Array;
  private windowPos = 0;
  private repeat: [number, number, number] = [1, 4, 8];
  private huffman: HuffmanTable | undefined;
  private ll: FseTable | undefined;
  private of: FseTable | undefined;
  private ml: FseTable | undefined;

  /**
   * @param windowSize the window the frame declared (already checked against the cap)
   */
  constructor(private readonly windowSize: number) {
    this.window = new Uint8Array(Math.max(windowSize, 1));
  }

  /** Largest block this frame may contain: min(window, 128 KiB) (RFC 8878 3.1.1.2.3). */
  get blockMax(): number {
    return Math.min(this.windowSize, BLOCK_MAX);
  }

  raw(content: Uint8Array): Uint8Array {
    this.push(content);
    return content;
  }

  rle(byte: number, size: number): Uint8Array {
    const out = new Uint8Array(size).fill(byte);
    this.push(out);
    return out;
  }

  private push(bytes: Uint8Array): void {
    const win = this.window;
    const n = win.length;
    if (bytes.length >= n) {
      win.set(bytes.subarray(bytes.length - n), 0);
      this.windowPos = (this.windowPos + bytes.length) % n;
    } else {
      const start = this.windowPos;
      const first = Math.min(bytes.length, n - start);
      win.set(bytes.subarray(0, first), start);
      win.set(bytes.subarray(first), 0);
      this.windowPos = (start + bytes.length) % n;
    }
    this.total += bytes.length;
  }

  /** Decode a compressed block (type 2). */
  compressed(content: Uint8Array): Uint8Array {
    const literals = this.readLiterals(content);
    return this.readSequences(content.subarray(literals.used), literals.bytes);
  }

  // -- literals -------------------------------------------------------------------

  private readLiterals(block: Uint8Array): { bytes: Uint8Array; used: number } {
    if (block.length < 1) throw new CorruptError("zstd: an empty compressed block");
    const b0 = block[0] as number;
    const type = b0 & 3;
    const sizeFormat = (b0 >> 2) & 3;
    const need = (n: number): void => {
      if (block.length < n) throw new CorruptError("zstd: a literals section ends too early");
    };

    if (type === 0 || type === 1) {
      let regen: number;
      let header: number;
      if (sizeFormat === 0 || sizeFormat === 2) {
        regen = b0 >> 3;
        header = 1;
      } else if (sizeFormat === 1) {
        need(2);
        regen = (b0 >> 4) + ((block[1] as number) << 4);
        header = 2;
      } else {
        need(3);
        regen = (b0 >> 4) + ((block[1] as number) << 4) + ((block[2] as number) << 12);
        header = 3;
      }
      if (regen > this.blockMax) throw new CorruptError("zstd: a literals section is larger than a block");
      if (type === 0) {
        need(header + regen);
        return { bytes: block.subarray(header, header + regen), used: header + regen };
      }
      need(header + 1);
      return { bytes: new Uint8Array(regen).fill(block[header] as number), used: header + 1 };
    }

    // compressed (2) or treeless (3): sizes of 10, 10, 14 or 18 bits
    let regen: number;
    let compressedSize: number;
    let header: number;
    let streams: 1 | 4;
    if (sizeFormat === 0 || sizeFormat === 1) {
      need(3);
      const v = b0 + ((block[1] as number) << 8) + ((block[2] as number) << 16);
      regen = (v >> 4) & 0x3ff;
      compressedSize = (v >> 14) & 0x3ff;
      header = 3;
      streams = sizeFormat === 0 ? 1 : 4;
    } else if (sizeFormat === 2) {
      need(4);
      const v = (b0 + ((block[1] as number) << 8) + ((block[2] as number) << 16) + (block[3] as number) * 2 ** 24) >>> 0;
      regen = (v >>> 4) & 0x3fff;
      compressedSize = v >>> 18;
      header = 4;
      streams = 4;
    } else {
      need(5);
      const v = b0 + ((block[1] as number) << 8) + ((block[2] as number) << 16) + (block[3] as number) * 2 ** 24 + (block[4] as number) * 2 ** 32;
      regen = Math.floor(v / 16) % 2 ** 18;
      compressedSize = Math.floor(v / 2 ** 22) % 2 ** 18;
      header = 5;
      streams = 4;
    }
    if (regen > this.blockMax) throw new CorruptError("zstd: a literals section is larger than a block");
    need(header + compressedSize);
    let body = block.subarray(header, header + compressedSize);

    if (type === 2) {
      const tree = readHuffmanTable(body);
      this.huffman = tree.table;
      body = body.subarray(tree.used);
    } else if (this.huffman === undefined) {
      throw new CorruptError("zstd: treeless literals without an earlier Huffman table");
    }
    const table = this.huffman as HuffmanTable;
    const out = new Uint8Array(regen);
    if (streams === 1) {
      decodeStream(table, body, regen, out, 0);
    } else {
      if (body.length < 6) throw new CorruptError("zstd: a literals jump table ends too early");
      const s1 = (body[0] as number) | ((body[1] as number) << 8);
      const s2 = (body[2] as number) | ((body[3] as number) << 8);
      const s3 = (body[4] as number) | ((body[5] as number) << 8);
      const rest = body.length - 6 - s1 - s2 - s3;
      if (rest < 0) throw new CorruptError("zstd: literal stream sizes exceed the section");
      const part = Math.floor((regen + 3) / 4);
      const last = regen - 3 * part;
      if (last < 0) throw new CorruptError("zstd: a literals section is too small for four streams");
      let at = 6;
      let written = 0;
      for (const [size, count] of [[s1, part], [s2, part], [s3, part], [rest, last]] as const) {
        decodeStream(table, body.subarray(at, at + size), count, out, written);
        at += size;
        written += count;
      }
    }
    return { bytes: out, used: header + compressedSize };
  }

  // -- sequences ------------------------------------------------------------------

  private readSequences(section: Uint8Array, literals: Uint8Array): Uint8Array {
    if (section.length < 1) throw new CorruptError("zstd: a sequences section is missing");
    let at = 0;
    const b0 = section[at++] as number;
    let count: number;
    if (b0 === 0) {
      this.push(literals); // no sequences: the literals are the whole block
      return literals;
    } else if (b0 < 128) {
      count = b0;
    } else if (b0 < 255) {
      if (section.length < 2) throw new CorruptError("zstd: a sequences header ends too early");
      count = ((b0 - 128) << 8) + (section[at++] as number);
    } else {
      if (section.length < 3) throw new CorruptError("zstd: a sequences header ends too early");
      count = (section[at] as number) + ((section[at + 1] as number) << 8) + 0x7f00;
      at += 2;
    }
    if (section.length < at + 1) throw new CorruptError("zstd: a sequences header ends too early");
    const modes = section[at++] as number;
    if (modes & 3) throw new CorruptError("zstd: reserved bits are set in the symbol compression modes");

    const read = (mode: number, maxLog: number, maxSymbol: number, fallback: FseTable, previous: FseTable | undefined): FseTable => {
      if (mode === 0) return fallback;
      if (mode === 1) {
        if (at >= section.length) throw new CorruptError("zstd: an RLE table ends too early");
        const symbol = section[at++] as number;
        if (symbol > maxSymbol) throw new CorruptError("zstd: an RLE table names an impossible symbol");
        return rleTable(symbol);
      }
      if (mode === 2) {
        const result = readTable(section.subarray(at), maxLog, maxSymbol);
        at += result.used;
        return result.table;
      }
      if (previous === undefined) throw new CorruptError("zstd: a repeated table without an earlier one");
      return previous;
    };
    const defaults = predefined();
    this.ll = read(modes >> 6, 9, 35, defaults.ll, this.ll);
    this.of = read((modes >> 4) & 3, 8, 31, defaults.of, this.of);
    this.ml = read((modes >> 2) & 3, 9, 52, defaults.ml, this.ml);
    return this.execute(section.subarray(at), count, literals);
  }

  private execute(stream: Uint8Array, count: number, literals: Uint8Array): Uint8Array {
    const ll = this.ll as FseTable;
    const of = this.of as FseTable;
    const ml = this.ml as FseTable;
    const bits = new BackwardBits(stream);
    let llState = bits.read(ll.accuracyLog);
    let ofState = bits.read(of.accuracyLog);
    let mlState = bits.read(ml.accuracyLog);

    const limit = this.blockMax;
    const out = new Uint8Array(limit);
    let outPos = 0;
    let litPos = 0;
    const win = this.window;
    const n = win.length;
    let wpos = this.windowPos;
    let produced = this.total; // bytes of this frame before this block, for offset validation

    for (let i = 0; i < count; i++) {
      const ofCode = of.symbol[ofState] as number;
      const mlCode = ml.symbol[mlState] as number;
      const llCode = ll.symbol[llState] as number;
      if (ofCode > 31 || mlCode > 52 || llCode > 35) throw new CorruptError("zstd: a sequence names an impossible code");

      const offsetValue = 2 ** ofCode + bits.read(ofCode);
      const matchLength = (ML_BASE[mlCode] as number) + bits.read(ML_BITS[mlCode] as number);
      const literalLength = (LL_BASE[llCode] as number) + bits.read(LL_BITS[llCode] as number);

      // repeat offsets (RFC 8878 3.1.1.5)
      let offset: number;
      const rep = this.repeat;
      if (offsetValue > 3) {
        offset = offsetValue - 3;
        rep[2] = rep[1];
        rep[1] = rep[0];
        rep[0] = offset;
      } else {
        let index = offsetValue;
        if (literalLength === 0) index++;
        if (index === 1) {
          offset = rep[0];
        } else if (index === 2) {
          offset = rep[1];
          rep[1] = rep[0];
          rep[0] = offset;
        } else if (index === 3) {
          offset = rep[2];
          rep[2] = rep[1];
          rep[1] = rep[0];
          rep[0] = offset;
        } else {
          offset = rep[0] - 1;
          if (offset === 0) throw new CorruptError("zstd: a repeat offset of zero");
          rep[2] = rep[1];
          rep[1] = rep[0];
          rep[0] = offset;
        }
      }

      if (outPos + literalLength + matchLength > limit) throw new CorruptError("zstd: a block regenerates more than its maximum");
      if (litPos + literalLength > literals.length) throw new CorruptError("zstd: a sequence uses more literals than the block has");

      // literals
      for (let k = 0; k < literalLength; k++) {
        const byte = literals[litPos + k] as number;
        out[outPos + k] = byte;
        win[(wpos + k) % n] = byte;
      }
      litPos += literalLength;
      outPos += literalLength;
      wpos = (wpos + literalLength) % n;
      produced += literalLength;

      // match
      if (offset > produced || offset > this.windowSize) throw new CorruptError("zstd: a match reaches before the start of the window");
      for (let k = 0; k < matchLength; k++) {
        const byte = win[(wpos - offset + n + n) % n] as number;
        out[outPos + k] = byte;
        win[wpos] = byte;
        wpos = wpos + 1 === n ? 0 : wpos + 1;
      }
      outPos += matchLength;
      produced += matchLength;

      if (i + 1 < count) {
        llState = (ll.baseline[llState] as number) + bits.read(ll.nbBits[llState] as number);
        mlState = (ml.baseline[mlState] as number) + bits.read(ml.nbBits[mlState] as number);
        ofState = (of.baseline[ofState] as number) + bits.read(of.nbBits[ofState] as number);
      }
    }
    if (bits.remaining !== 0) throw new CorruptError("zstd: the sequence bit stream was not consumed exactly");

    // the literals that no sequence used come last
    const tail = literals.length - litPos;
    if (outPos + tail > limit) throw new CorruptError("zstd: a block regenerates more than its maximum");
    for (let k = 0; k < tail; k++) {
      const byte = literals[litPos + k] as number;
      out[outPos + k] = byte;
      win[(wpos + k) % n] = byte;
    }
    outPos += tail;
    wpos = (wpos + tail) % n;
    this.windowPos = wpos;
    this.total += outPos;
    return out.slice(0, outPos);
  }
}

