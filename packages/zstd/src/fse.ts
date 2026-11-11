/** Finite State Entropy tables (RFC 8878 section 4.1). */

import { CorruptError } from "spillgate";
import { ForwardBits } from "./bits.js";

export interface FseTable {
  readonly accuracyLog: number;
  readonly symbol: Uint8Array;
  readonly nbBits: Uint8Array;
  readonly baseline: Uint32Array;
}

/** `normalized[s]` is the probability of symbol s in units of 1/2**accuracyLog; -1 means "less than one". */
export function buildTable(normalized: readonly number[], accuracyLog: number): FseTable {
  const size = 1 << accuracyLog;
  const symbol = new Uint8Array(size);
  const nbBits = new Uint8Array(size);
  const baseline = new Uint32Array(size);
  const next = new Uint32Array(normalized.length);

  // symbols with probability "less than one" take the highest states
  let high = size - 1;
  for (let s = 0; s < normalized.length; s++) {
    if (normalized[s] === -1) {
      symbol[high--] = s;
      next[s] = 1;
    } else {
      next[s] = normalized[s] as number;
    }
  }
  // the others are spread over the remaining states with a fixed stride
  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let position = 0;
  for (let s = 0; s < normalized.length; s++) {
    for (let i = 0; i < (normalized[s] as number); i++) {
      symbol[position] = s;
      do {
        position = (position + step) & mask;
      } while (position > high);
    }
  }
  if (position !== 0) throw new CorruptError("zstd: the probabilities of a table do not add up");

  for (let state = 0; state < size; state++) {
    const s = symbol[state] as number;
    const nextState = next[s] as number;
    next[s] = nextState + 1;
    const bits = accuracyLog - (31 - Math.clz32(nextState));
    nbBits[state] = bits;
    baseline[state] = (nextState << bits) - size;
  }
  return { accuracyLog, symbol, nbBits, baseline };
}

/**
 * Read a table description from the start of `bytes` (RFC 8878 4.1.1).
 *
 * @returns the table and the number of bytes the description used
 */
export function readTable(bytes: Uint8Array, maxAccuracyLog: number, maxSymbol: number): { table: FseTable; used: number } {
  const bits = new ForwardBits(bytes);
  const accuracyLog = bits.read(4) + 5;
  if (accuracyLog > maxAccuracyLog) throw new CorruptError("zstd: a table asks for too large an accuracy");
  const total = 1 << accuracyLog;
  const normalized: number[] = [];
  let sum = 0;
  while (sum < total) {
    const maxValue = total - sum + 1; // the number of values still possible
    const bitCount = 32 - Math.clz32(maxValue);
    const raw = bits.read(bitCount);
    const lowThreshold = (1 << bitCount) - 1 - maxValue;
    const mask = (1 << (bitCount - 1)) - 1;
    const small = raw & mask;
    let value: number;
    if (small < lowThreshold) {
      bits.unread(1);
      value = small;
    } else if (raw > mask) {
      value = raw - lowThreshold;
    } else {
      value = raw;
    }
    const probability = value - 1;
    sum += probability < 0 ? 1 : probability;
    normalized.push(probability);
    if (normalized.length > maxSymbol + 1) throw new CorruptError("zstd: a table has too many symbols");
    if (probability === 0) {
      // a run of unused symbols
      for (;;) {
        const repeat = bits.read(2);
        for (let i = 0; i < repeat; i++) normalized.push(0);
        if (normalized.length > maxSymbol + 1) throw new CorruptError("zstd: a table has too many symbols");
        if (repeat !== 3) break;
      }
    }
    if (bits.overrun) throw new CorruptError("zstd: a table description ends too early");
  }
  if (sum !== total) throw new CorruptError("zstd: the probabilities of a table do not add up");
  return { table: buildTable(normalized, accuracyLog), used: bits.bytesUsed() };
}

/** A table that always yields `symbol` (the RLE mode of the sequence section). */
export function rleTable(symbol: number): FseTable {
  return { accuracyLog: 0, symbol: Uint8Array.of(symbol), nbBits: Uint8Array.of(0), baseline: Uint32Array.of(0) };
}
