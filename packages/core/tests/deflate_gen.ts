/**
 * A hand-written DEFLATE encoder for tests: it writes exactly the blocks it is told to, with code
 * lengths up to 15, every run-length code (16, 17, 18) in any position, and any HLIT/HDIST/HCLEN.
 * It is not a compressor; it exists to produce streams that zlib itself would never write.
 */

import { CorruptError } from "../src/errors.js";
import { DONE, Inflater, NEED_INPUT, OUTPUT_FULL } from "../src/inflate.js";

export type Random = () => number;
export const int = (random: Random, n: number): number => Math.floor(random() * n);

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private count = 0;
  bits(value: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.acc |= ((value >> i) & 1) << this.count;
      if (++this.count === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.count = 0;
      }
    }
  }
  /** A Huffman code: most significant bit first. */
  code(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits((value >> i) & 1, 1);
  }
  align(): void {
    if (this.count > 0) this.bits(0, 8 - this.count);
  }
  rawBytes(data: Uint8Array): void {
    for (const b of data) this.bytes.push(b);
  }
  finish(): Buffer {
    this.align();
    return Buffer.from(this.bytes);
  }
}

/** Canonical codes for the given lengths (RFC 1951 section 3.2.2). */
export function canonical(lengths: number[]): number[] {
  const perLength = new Array<number>(17).fill(0);
  for (const l of lengths) perLength[l] = (perLength[l] as number) + 1;
  perLength[0] = 0;
  const next = new Array<number>(17).fill(0);
  let code = 0;
  for (let l = 1; l <= 16; l++) {
    code = (code + (perLength[l - 1] as number)) << 1;
    next[l] = code;
  }
  return lengths.map((l) => (l === 0 ? 0 : (next[l] = (next[l] as number) + 1) - 1));
}

function huffman(freq: number[]): number[] {
  const lengths = new Array<number>(freq.length).fill(0);
  type Node = { weight: number; symbols: number[] };
  let nodes: Node[] = [];
  freq.forEach((w, s) => {
    if (w > 0) nodes.push({ weight: w, symbols: [s] });
  });
  if (nodes.length === 1) {
    lengths[(nodes[0] as Node).symbols[0] as number] = 1;
    return lengths;
  }
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.weight - b.weight);
    const a = nodes.shift() as Node;
    const b = nodes.shift() as Node;
    for (const s of a.symbols) lengths[s] = (lengths[s] as number) + 1;
    for (const s of b.symbols) lengths[s] = (lengths[s] as number) + 1;
    nodes.push({ weight: a.weight + b.weight, symbols: a.symbols.concat(b.symbols) });
  }
  return lengths;
}

/** Huffman code lengths no longer than `limit` (flattening the weights until the tree fits). */
export function limitedLengths(freq: number[], limit: number): number[] {
  let used = freq.filter((f) => f > 0).length;
  while (1 << limit < used) limit++;
  let f = freq.slice();
  for (;;) {
    const lengths = huffman(f);
    if (Math.max(0, ...lengths) <= limit) return lengths;
    f = f.map((w) => (w > 0 ? Math.ceil(w / 2) : 0));
    used = 0;
  }
}

export type Token = { literal: number } | { lengthSymbol: number; lengthExtra: number; distanceSymbol: number; distanceExtra: number };

export interface DynamicStats {
  repeat16: number;
  repeat17: number;
  repeat18: number;
  sixteenAfterZeroRun: number;
  maxLength: number;
}

function writeTokens(w: BitWriter, tokens: Token[], litLengths: number[], distLengths: number[]): void {
  const litCodes = canonical(litLengths);
  const distCodes = canonical(distLengths);
  for (const t of tokens) {
    if ("literal" in t) {
      w.code(litCodes[t.literal] as number, litLengths[t.literal] as number);
    } else {
      const ls = 257 + t.lengthSymbol;
      w.code(litCodes[ls] as number, litLengths[ls] as number);
      w.bits(t.lengthExtra, LENGTH_EXTRA[t.lengthSymbol] as number);
      w.code(distCodes[t.distanceSymbol] as number, distLengths[t.distanceSymbol] as number);
      w.bits(t.distanceExtra, DISTANCE_EXTRA[t.distanceSymbol] as number);
    }
  }
  w.code(litCodes[256] as number, litLengths[256] as number);
}

export function writeFixedBlock(w: BitWriter, final: boolean, tokens: Token[]): void {
  const lit = new Array<number>(288).fill(8);
  lit.fill(9, 144, 256);
  lit.fill(7, 256, 280);
  w.bits(final ? 1 : 0, 1);
  w.bits(1, 2);
  writeTokens(w, tokens, lit, new Array<number>(30).fill(5));
}

export function writeStoredBlock(w: BitWriter, final: boolean, data: Uint8Array): void {
  w.bits(final ? 1 : 0, 1);
  w.bits(0, 2);
  w.align();
  w.bits(data.length, 16);
  w.bits(~data.length & 0xffff, 16);
  w.rawBytes(data);
}

/**
 * A dynamic block. `litLengths` (up to 286) and `distLengths` (up to 30) are the code lengths to
 * announce; the run-length coding of the sequence is chosen at random when `random` is given
 * (all of 16, 17 and 18, anywhere they apply) and is literal otherwise. `extraLit`/`extraDist`
 * announce that many trailing unused symbols; `extraClen` that many unused code-length entries.
 */
export function writeDynamicBlock(
  w: BitWriter,
  final: boolean,
  litLengths: number[],
  distLengths: number[],
  tokens: Token[],
  random?: Random,
  stats?: DynamicStats,
  pad: { lit: number; dist: number; clen: number } = { lit: 0, dist: 0, clen: 0 },
  greedy = false,
): void {
  const rnd: Random | undefined = greedy ? () => 0.9999 : random;
  let hlit = 257;
  for (let i = 0; i < litLengths.length; i++) if (litLengths[i]) hlit = Math.max(hlit, i + 1);
  let hdist = 1;
  for (let i = 0; i < distLengths.length; i++) if (distLengths[i]) hdist = Math.max(hdist, i + 1);
  hlit = Math.min(286, hlit + pad.lit);
  hdist = Math.min(30, hdist + pad.dist);
  const lens: number[] = [];
  for (let i = 0; i < hlit; i++) lens.push(litLengths[i] ?? 0);
  for (let i = 0; i < hdist; i++) lens.push(distLengths[i] ?? 0);

  // run-length coding: (symbol, extra value) pairs
  const syms: Array<[number, number]> = [];
  let i = 0;
  let lastWasZeroRun = false;
  while (i < lens.length) {
    const v = lens[i] as number;
    let run = 1;
    while (i + run < lens.length && lens[i + run] === v) run++;
    const options: Array<() => void> = [];
    if (rnd !== undefined) {
      if (v === 0 && run >= 3) {
        if (run >= 11) {
          options.push(() => {
            const n = 11 + int(rnd, Math.min(138, run) - 10);
            syms.push([18, n - 11]);
            i += n;
            lastWasZeroRun = true;
            if (stats) stats.repeat18++;
          });
        }
        options.push(() => {
          const n = 3 + int(rnd, Math.min(10, run) - 2);
          syms.push([17, n - 3]);
          i += n;
          lastWasZeroRun = true;
          if (stats) stats.repeat17++;
        });
      }
      if (i > 0 && lens[i - 1] === v && run >= 3) {
        options.push(() => {
          const n = 3 + int(rnd, Math.min(6, run) - 2);
          syms.push([16, n - 3]);
          i += n;
          if (stats) {
            stats.repeat16++;
            if (lastWasZeroRun && v === 0) stats.sixteenAfterZeroRun++;
          }
          lastWasZeroRun = false;
        });
      }
      if (!greedy) options.push(() => {});
    }
    const pick = options.length > 0 && !greedy ? int(random as Random, options.length) : 0;
    const before = i;
    options[pick]?.();
    if (i === before) {
      syms.push([v, 0]);
      i++;
      lastWasZeroRun = false;
    }
  }

  const clFreq = new Array<number>(19).fill(0);
  for (const [s] of syms) clFreq[s] = (clFreq[s] as number) + 1;
  if (clFreq.filter((f) => f > 0).length < 2) clFreq[clFreq[0] ? 1 : 0] = 1; // a lone code would be incomplete
  const clLengths = limitedLengths(clFreq, 7);
  let hclen = 4;
  for (let k = 0; k < 19; k++) if (clLengths[CL_ORDER[k] as number]) hclen = Math.max(hclen, k + 1);
  hclen = Math.min(19, hclen + pad.clen);

  w.bits(final ? 1 : 0, 1);
  w.bits(2, 2);
  w.bits(hlit - 257, 5);
  w.bits(hdist - 1, 5);
  w.bits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.bits(clLengths[CL_ORDER[k] as number] as number, 3);
  const clCodes = canonical(clLengths);
  for (const [s, extra] of syms) {
    w.code(clCodes[s] as number, clLengths[s] as number);
    if (s === 16) w.bits(extra, 2);
    else if (s === 17) w.bits(extra, 3);
    else if (s === 18) w.bits(extra, 7);
  }
  if (stats) stats.maxLength = Math.max(stats.maxLength, ...lens);
  writeTokens(w, tokens, litLengths, distLengths);
}

/** Tokens drawn from the given symbol sets, for an output that already has `have` bytes. */
export function genTokens(random: Random, count: number, litSet: number[], lengthSet: number[], distSet: number[], have: number): { tokens: Token[]; have: number } {
  const tokens: Token[] = [];
  for (let k = 0; k < count; k++) {
    const wantMatch = lengthSet.length > 0 && distSet.length > 0 && random() < 0.4 && have > 0;
    if (wantMatch) {
      const ds = distSet[int(random, distSet.length)] as number;
      const base = DISTANCE_BASE[ds] as number;
      const maxDistance = Math.min(32768, have);
      if (base <= maxDistance) {
        const top = Math.min(maxDistance, base + (1 << (DISTANCE_EXTRA[ds] as number)) - 1);
        const distance = base + int(random, top - base + 1);
        const ls = lengthSet[int(random, lengthSet.length)] as number;
        const lengthExtra = int(random, 1 << (LENGTH_EXTRA[ls] as number));
        tokens.push({ lengthSymbol: ls, lengthExtra, distanceSymbol: ds, distanceExtra: distance - base });
        have += (LENGTH_BASE[ls] as number) + lengthExtra;
        continue;
      }
    }
    if (litSet.length > 0) {
      tokens.push({ literal: litSet[int(random, litSet.length)] as number });
      have++;
    }
  }
  return { tokens, have };
}

function sampleSubset(random: Random, from: number[], size: number): number[] {
  const pool = from.slice();
  const out: number[] = [];
  while (out.length < size && pool.length > 0) out.push(pool.splice(int(random, pool.length), 1)[0] as number);
  return out;
}

function skewedFreq(random: Random, n: number, symbols: number[]): number[] {
  const freq = new Array<number>(n).fill(0);
  const mode = int(random, 3);
  const rate = 1.3 + random() * 0.6;
  for (const s of symbols) {
    freq[s] = mode === 0 ? 1 + int(random, 20) : mode === 1 ? Math.max(1, Math.floor(Math.pow(rate, int(random, 40)))) : 1 + int(random, 1 << 20);
  }
  return freq;
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);

/** A random stream of stored, fixed and dynamic blocks. Returns the bytes and bookkeeping. */
export function randomStream(random: Random, stats: DynamicStats): Buffer {
  const w = new BitWriter();
  const blocks = 1 + int(random, 5);
  let have = 0;
  for (let b = 0; b < blocks; b++) {
    const final = b === blocks - 1;
    const kind = random();
    if (kind < 0.15) {
      const data = Buffer.alloc(int(random, 200));
      for (let i = 0; i < data.length; i++) data[i] = int(random, 256);
      writeStoredBlock(w, final, data);
      have += data.length;
    } else if (kind < 0.3) {
      const r = genTokens(random, int(random, 300), range(0, 256), range(0, 29), range(0, 30), have);
      writeFixedBlock(w, final, r.tokens);
      have = r.have;
    } else {
      // the symbols that get a code: a random subset, with the end-of-block code always in it
      const size = [1, 2, 5, 20, 60, 286][int(random, 6)] as number;
      const litSyms = sampleSubset(random, range(0, 286), size);
      if (!litSyms.includes(256)) litSyms.push(256);
      const distSize = [0, 1, 2, 6, 30][int(random, 5)] as number;
      const distSyms = sampleSubset(random, range(0, 30), distSize);
      const limit = [15, 15, 15, 12, 9, 7][int(random, 6)] as number;
      const litLengths = limitedLengths(skewedFreq(random, 286, litSyms), limit);
      const distLengths = limitedLengths(skewedFreq(random, 30, distSyms), limit);
      const r = genTokens(
        random,
        int(random, 400),
        litSyms.filter((s) => s < 256),
        litSyms.filter((s) => s > 256).map((s) => s - 257),
        distSyms,
        have,
      );
      writeDynamicBlock(w, final, litLengths, distLengths, r.tokens, random, stats, {
        lit: random() < 0.3 ? int(random, 10) : 0,
        dist: random() < 0.3 ? int(random, 5) : 0,
        clen: random() < 0.3 ? int(random, 8) : 0,
      });
      have = r.have;
    }
  }
  return w.finish();
}

export function newStats(): DynamicStats {
  return { repeat16: 0, repeat17: 0, repeat18: 0, sixteenAfterZeroRun: 0, maxLength: 0 };
}

/** Decode `stream` through our decoder; throws CorruptError for corrupt or truncated input. */
export function inflateOurs(stream: Uint8Array, inStep: number, outStep: number): { data: Buffer; end: number; leftover: Uint8Array } {
  const inflater = new Inflater();
  const parts: Uint8Array[] = [];
  let pos = 0;
  const out = new Uint8Array(outStep);
  for (let guard = 0; guard < 100_000_000; guard++) {
    const status = inflater.step(stream.subarray(pos, pos + inStep), out);
    parts.push(out.slice(0, inflater.produced));
    pos += inflater.used;
    if (status === DONE) return { data: Buffer.concat(parts), end: pos, leftover: inflater.leftover() };
    if (status === NEED_INPUT && pos >= stream.length) throw new CorruptError("truncated");
    if (status !== OUTPUT_FULL && status !== NEED_INPUT) throw new Error("bad status");
  }
  throw new Error("no progress");
}
