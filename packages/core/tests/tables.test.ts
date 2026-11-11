/** The two-level decoding tables: structured generator vs node:zlib, long codes, and the CPU bound. */

import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { CorruptError } from "../src/errors.js";
import { BitWriter, genTokens, inflateOurs, int, newStats, randomStream, writeDynamicBlock, writeFixedBlock, writeStoredBlock, type Token } from "./deflate_gen.js";
import { prng } from "./helpers.js";

const scale = Number(process.env["SPILLGATE_FUZZ_ROUNDS"] ?? 300) / 300;
const STEPS: Array<[number, number]> = [[1, 1], [1, 4096], [3, 7], [5, 100000], [64, 31], [1 << 20, 1 << 20]];

function flip(buffer: Buffer, index: number, bit: number): void {
  buffer[index] = (buffer[index] as number) ^ (1 << bit);
}

function zlibRaw(stream: Uint8Array): Buffer | null {
  try {
    return zlib.inflateRawSync(stream);
  } catch {
    return null;
  }
}

function ours(stream: Uint8Array, inStep: number, outStep: number): { data: Buffer; end: number; leftover: Uint8Array } | null {
  try {
    return inflateOurs(stream, inStep, outStep);
  } catch (error) {
    if (error instanceof CorruptError) return null;
    throw error;
  }
}

test("structured random dynamic streams decode like node:zlib, intact and mutated", () => {
  const random = prng(20261111);
  const streams = Math.max(50, Math.round(5000 * scale));
  const stats = newStats();
  let accepted = 0;
  let rejected = 0;
  for (let n = 0; n < streams; n++) {
    const stream = randomStream(random, stats);
    const expected = zlibRaw(stream);
    assert.ok(expected !== null, `stream ${n}: zlib rejects a stream we built`);
    const garbage = Buffer.from([1, 2, 3, int(random, 256)]);
    const [inStep, outStep] = STEPS[int(random, STEPS.length)] as [number, number];
    const r = ours(Buffer.concat([stream, garbage]), inStep, outStep);
    assert.ok(r !== null, `stream ${n}: we reject (steps ${inStep}/${outStep})`);
    assert.ok(r.data.equals(expected), `stream ${n}: output differs (steps ${inStep}/${outStep})`);
    assert.equal(r.end - r.leftover.length, stream.length, `stream ${n}: input accounting`);
    assert.deepEqual(Buffer.from(r.leftover), garbage.subarray(0, r.leftover.length));

    // mutated variants: accept/reject and output must match zlib
    for (let m = 0; m < 2; m++) {
      const mutated = Buffer.from(stream);
      const kind = int(random, 4);
      let candidate: Buffer = mutated;
      if (kind === 0) flip(mutated, int(random, mutated.length), int(random, 8));
      else if (kind === 1) {
        for (let k = 0; k < 3; k++) mutated[int(random, mutated.length)] = int(random, 256);
      } else if (kind === 2) {
        candidate = mutated.subarray(0, int(random, mutated.length));
      } else {
        flip(mutated, int(random, Math.min(mutated.length, 40)), int(random, 8)); // the header region
      }
      const want = zlibRaw(candidate);
      const [i2, o2] = STEPS[int(random, STEPS.length)] as [number, number];
      const got = ours(candidate, i2, o2);
      assert.equal(got !== null, want !== null, `stream ${n} mutation ${m} kind ${kind}: accept/reject differs (ours ${got !== null})`);
      if (got !== null && want !== null) {
        assert.ok(got.data.equals(want), `stream ${n} mutation ${m}: output differs`);
        accepted++;
      } else {
        rejected++;
      }
    }
  }
  // the generator really exercised what it claims to
  assert.ok(stats.repeat16 > streams / 4 && stats.repeat17 > streams / 4 && stats.repeat18 > streams / 8, JSON.stringify(stats));
  assert.ok(stats.sixteenAfterZeroRun > 20, JSON.stringify(stats));
  assert.equal(stats.maxLength, 15);
  assert.ok(accepted > 0 && rejected > streams / 4, `accepted ${accepted} rejected ${rejected}`);
});

/** A complete code with a depth-15 spine: lengths 1..14 for the first 14 symbols, 15 for the last two. */
function spine(symbols: number[], size: number): number[] {
  assert.equal(symbols.length, 16);
  const lengths = new Array<number>(size).fill(0);
  symbols.forEach((s, i) => {
    lengths[s] = i < 14 ? i + 1 : 15;
  });
  return lengths;
}

/** Moves the bit position by `shift` (0..7) bits: a non-final fixed block of `shift` nine-bit literals comes first. */
function shifted(shift: number, body: (w: BitWriter) => void): Buffer {
  const w = new BitWriter();
  const tokens: Token[] = [];
  for (let i = 0; i < shift; i++) tokens.push({ literal: 200 });
  writeFixedBlock(w, false, tokens);
  body(w);
  return w.finish();
}

test("codes of length 11..15 for literals, lengths and distances through the slow path, at every alignment and byte by byte", () => {
  const random = prng(77);
  const A = spine([97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 256, 111], 286);
  const B = spine([97, 98, 99, 100, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 256, 267], 286);
  const dist = spine([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 30);
  const none = new Array<number>(30).fill(0);
  for (const [lengths, distLengths] of [[A, none], [B, dist]] as Array<[number[], number[]]>) {
    const literals = [97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111].filter((s) => lengths[s]);
    const lengthSet = distLengths === dist ? range(0, 11) : [];
    const distSet = distLengths === dist ? range(0, 16) : [];
    // every symbol at least once, then random use (matches need output to refer to, so literals come first)
    const prefix: Token[] = literals.map((literal) => ({ literal }));
    const r = genTokens(random, 3000, literals, lengthSet, distSet, prefix.length);
    const tokens = prefix.concat(r.tokens);
    for (const s of lengthSet) assert.ok(tokens.some((t) => "lengthSymbol" in t && t.lengthSymbol === s) || s === 10, `length symbol ${s}`);
    assert.ok(tokens.filter((t) => (lengths["literal" in t ? t.literal : 257 + t.lengthSymbol] as number) >= 11).length > 50);
    if (distSet.length) assert.ok(tokens.filter((t) => "distanceSymbol" in t && (dist[t.distanceSymbol] as number) >= 11).length > 20);
    for (let shift = 0; shift < 8; shift++) {
      const stream = shifted(shift, (w) => writeDynamicBlock(w, true, lengths, distLengths, tokens, random));
      const expected = zlib.inflateRawSync(stream);
      for (const [inStep, outStep] of [[1, 1], [1, 1000], [2, 3], [1 << 20, 1 << 20]] as Array<[number, number]>) {
        const got = inflateOurs(stream, inStep, outStep);
        assert.ok(got.data.equals(expected), `shift ${shift} steps ${inStep}/${outStep}`);
        assert.equal(got.end, stream.length);
      }
    }
  }
});

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);

test("a truncated long code asks for more input instead of failing", () => {
  const lengths = new Array<number>(286).fill(0);
  [97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 256, 111].forEach((s, i) => {
    lengths[s] = i < 14 ? i + 1 : 15;
  });
  const w = new BitWriter();
  writeDynamicBlock(w, true, lengths, new Array<number>(30).fill(0), [{ literal: 111 }]);
  const stream = w.finish();
  assert.equal(zlib.inflateRawSync(stream).toString("latin1"), "o");
  assert.ok(ours(stream.subarray(0, stream.length - 1), 1, 10) === null);
  assert.equal(inflateOurs(stream, 1, 10).data.toString("latin1"), "o");
});

/** One empty dynamic block whose literal and distance codes both reach depth 15; `variant` moves the spine so that neighbours differ. */
function emptyDeepBlock(w: BitWriter, variant: number, final: boolean): void {
  const symbols = range(240 - variant, 255 - variant);
  symbols.push(256);
  const lit = new Array<number>(286).fill(0);
  symbols.forEach((s, i) => {
    lit[s] = i < 14 ? i + 1 : 15;
  });
  const dist = new Array<number>(30).fill(0);
  for (let i = 0; i < 16; i++) dist[(i + variant) % 16] = i < 14 ? i + 1 : 15;
  writeDynamicBlock(w, final, lit, dist, [], undefined, undefined, undefined, true);
}

test("200000 empty dynamic blocks with depth-15 codes cost bounded CPU", () => {
  const blocks = 200000;
  const w = new BitWriter();
  for (let i = 0; i < blocks; i++) emptyDeepBlock(w, i % 2, false);
  writeStoredBlock(w, true, Buffer.from("end"));
  const stream = w.finish();
  assert.ok(stream.length < blocks * 40, `stream ${stream.length} bytes`);
  const started = process.hrtime.bigint();
  const r = inflateOurs(stream, 1 << 16, 1 << 16);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.data.toString(), "end");
  console.log(`# 200000 empty depth-15 dynamic blocks: ${stream.length} bytes, ${ms.toFixed(0)} ms`);
  const bound = Number(process.env["SPILLGATE_EMPTY_BLOCKS_MS"] ?? 3000);
  assert.ok(ms < bound, `${ms.toFixed(0)} ms, bound ${bound} ms`);
});
