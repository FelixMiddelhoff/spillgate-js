/** Huffman-coded literals (RFC 8878 section 4.2). */

import { CorruptError } from "spillgate";
import { BackwardBits, ForwardBits } from "./bits.js";
import { readTable } from "./fse.js";

export const MAX_HUFFMAN_BITS = 11;

/** A decoding table: `entries[bits & mask]` is `symbol << 4 | length`. */
export interface HuffmanTable {
  readonly maxBits: number;
  readonly entries: Uint16Array;
}

/**
 * Read a Huffman tree description (RFC 8878 4.2.1) from the start of `bytes`.
 *
 * @returns the table and the number of bytes the description used
 */
export function readHuffmanTable(bytes: Uint8Array): { table: HuffmanTable; used: number } {
  if (bytes.length === 0) throw new CorruptError("zstd: an empty Huffman tree description");
  const header = bytes[0] as number;
  const weights: number[] = [];
  let used: number;
  if (header >= 128) {
    // direct representation: header - 127 weights of 4 bits each, two per byte (high nibble first)
    const count = header - 127;
    used = 1 + Math.ceil(count / 2);
    if (bytes.length < used) throw new CorruptError("zstd: a Huffman tree description ends too early");
    for (let i = 0; i < count; i++) {
      const byte = bytes[1 + (i >> 1)] as number;
      weights.push(i % 2 === 0 ? byte >> 4 : byte & 15);
    }
  } else {
    // FSE-compressed weights, `header` bytes
    used = 1 + header;
    if (header === 0 || bytes.length < used) throw new CorruptError("zstd: a Huffman tree description ends too early");
    decodeWeights(bytes.subarray(1, used), weights);
  }
  if (weights.length > 255) throw new CorruptError("zstd: too many Huffman weights");

  // the last weight is implied: the sum of 2**(w-1) must reach a power of two
  let total = 0;
  for (const w of weights) if (w > 0) total += 2 ** (w - 1);
  if (total === 0) throw new CorruptError("zstd: a Huffman tree has no codes");
  const maxBits = 32 - Math.clz32(total); // smallest b with 2**b > total
  const power = 2 ** maxBits;
  const rest = power - total;
  if (rest === 0 || (rest & (rest - 1)) !== 0) throw new CorruptError("zstd: Huffman weights do not complete a tree");
  weights.push(32 - Math.clz32(rest)); // log2(rest) + 1
  if (maxBits > MAX_HUFFMAN_BITS) throw new CorruptError("zstd: a Huffman code is too long");
  if (weights.length > 256) throw new CorruptError("zstd: too many Huffman symbols");
  return { table: buildHuffman(weights, maxBits), used };
}

/** FSE-compressed weights: two interleaved states over a backward bit stream. */
function decodeWeights(bytes: Uint8Array, weights: number[]): void {
  const { table, used } = readTable(bytes, 6, 15);
  const bits = new BackwardBits(bytes.subarray(used));
  let state1 = bits.read(table.accuracyLog);
  let state2 = bits.read(table.accuracyLog);
  for (;;) {
    weights.push(table.symbol[state1] as number);
    state1 = (table.baseline[state1] as number) + bits.read(table.nbBits[state1] as number);
    if (bits.remaining < 0) {
      weights.push(table.symbol[state2] as number);
      return;
    }
    weights.push(table.symbol[state2] as number);
    state2 = (table.baseline[state2] as number) + bits.read(table.nbBits[state2] as number);
    if (bits.remaining < 0) {
      weights.push(table.symbol[state1] as number);
      return;
    }
    if (weights.length > 255) throw new CorruptError("zstd: too many Huffman weights");
  }
}

function buildHuffman(weights: number[], maxBits: number): HuffmanTable {
  const size = 1 << maxBits;
  const entries = new Uint16Array(size);
  const lengths = weights.map((w) => (w === 0 ? 0 : maxBits + 1 - w));
  // canonical codes, shortest codes take the highest bit patterns (RFC 8878 4.2.1: symbols sorted by weight)
  let next = 0;
  for (let w = 1; w <= maxBits; w++) {
    for (let symbol = 0; symbol < weights.length; symbol++) {
      if (weights[symbol] !== w) continue;
      const length = lengths[symbol] as number;
      const span = 1 << (maxBits - length);
      for (let i = 0; i < span; i++) entries[next + i] = (symbol << 4) | length;
      next += span;
    }
  }
  if (next !== size) throw new CorruptError("zstd: a Huffman tree is not complete");
  return { maxBits, entries };
}

/** Decode `count` literals from one backward-coded stream. */
export function decodeStream(table: HuffmanTable, stream: Uint8Array, count: number, out: Uint8Array, at: number): void {
  const bits = new BackwardBits(stream);
  const maxBits = table.maxBits;
  for (let i = 0; i < count; i++) {
    const index = bits.peek(maxBits);
    const entry = table.entries[index] as number;
    const length = entry & 15;
    bits.remaining -= length;
    out[at + i] = entry >> 4;
  }
  if (bits.remaining !== 0) throw new CorruptError("zstd: a Huffman stream was not consumed exactly");
}

export { ForwardBits };
