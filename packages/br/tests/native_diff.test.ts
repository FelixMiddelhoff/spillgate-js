/**
 * Differential tests of the forked WebAssembly decoder (see rust/NOTES.md): the decoder built from
 * this repository, the original `brotli-dec-wasm` 2.3.2 from npm (dev dependency, exact version) and
 * Node's libbrotli must agree. Original and fork: identical verdict, output, consumed input and
 * error message for every input, with ONE allowed difference: the fork backports upstream 693a4a1
 * (meta-block longer than MLEN) and 8ed0d7d (nonzero padding after the last meta-block), so it
 * refuses (error -9/-10/-15) streams the original accepts, and only when libbrotli refuses the same
 * stream with BLOCK_LENGTH_1/2 or PADDING_2. libbrotli: same output wherever the fork accepts a stream, and no
 * stream that libbrotli accepts may be refused by the fork.
 *
 * `SG_BR_NATIVE=<file URL of a brotli_dec_wasm.js>` runs the same tests against another build
 * (used to check the unpatched build of the fork against the original).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import zlib from "node:zlib";
import * as original from "brotli-dec-wasm/web";
import { brotliLargeWindowPrefix, brotliStored, brotliZeros } from "spillgate-test-support";
import { hostileBrotli } from "./hostile.js";

interface Result {
  code: number;
  buf: Uint8Array;
  input_offset: number;
  free(): void;
}
interface Stream {
  decompress(input: Uint8Array, outputSize: number): Result;
  free(): void;
}
interface Module {
  DecompressStream: new () => Stream;
  initSync(options: { module: BufferSource }): unknown;
}

const require_ = createRequire(import.meta.url);
original.initSync({ module: readFileSync(require_.resolve("brotli-dec-wasm/web/bg.wasm")) });
const nativeUrl = process.env["SG_BR_NATIVE"] ?? new URL("../src/native/brotli_dec_wasm.js", import.meta.url).href;
const fork = (await import(nativeUrl)) as Module;
fork.initSync({ module: readFileSync(new URL("brotli_dec_wasm_bg.wasm", nativeUrl)) });

/** What a streaming decode of an input ends in (never throws). */
interface Verdict {
  verdict: "success" | "truncated" | "error";
  out: string; // sha256 of the output
  length: number;
  consumed: number;
  message: string;
}

function drive(mod: Module, input: Uint8Array, inStep: number, outStep: number): Verdict {
  const stream = new mod.DecompressStream();
  const hash = createHash("sha256");
  let length = 0;
  let consumed = 0;
  try {
    for (let rounds = 0; rounds < 10_000_000; rounds++) {
      const slice = input.subarray(consumed, Math.min(input.length, consumed + inStep));
      let result: Result;
      try {
        result = stream.decompress(slice.slice(), outStep);
      } catch (error) {
        return { verdict: "error", out: hash.digest("hex"), length, consumed, message: String((error as Error).message) };
      }
      const buf = result.buf.slice();
      const code = result.code;
      const used = result.input_offset;
      result.free();
      hash.update(buf);
      length += buf.length;
      consumed += used;
      if (code === 1) return { verdict: "success", out: hash.digest("hex"), length, consumed, message: "" };
      if (code === 2 && consumed >= input.length) return { verdict: "truncated", out: hash.digest("hex"), length, consumed, message: "" };
      if (code === 3 && buf.length === 0 && used === 0) throw new Error("no progress");
    }
    throw new Error("too many rounds");
  } finally {
    stream.free();
  }
}

function libbrotli(input: Uint8Array): Buffer | undefined {
  try {
    return zlib.brotliDecompressSync(input);
  } catch {
    return undefined;
  }
}

/** libbrotli's error code of a stream it refuses. */
function libbrotliCode(input: Uint8Array): string {
  try {
    zlib.brotliDecompressSync(input);
    return "";
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}

const stats = { compared: 0, success: 0, error: 0, truncated: 0, libbrotliRefusesWeAccept: 0, backported: 0 };
const WHOLE: Array<[number, number]> = [[1 << 30, 65536]];
const BOTH: Array<[number, number]> = [[1 << 30, 65536], [7, 33]];

/** Compare original, fork and libbrotli on one input, with the given (input step, output step) pairs. */
function compare(input: Uint8Array, label: string, steps: Array<[number, number]> = BOTH): void {
  for (const [index, [inStep, outStep]] of steps.entries()) {
    const a = drive(original as unknown as Module, input, inStep, outStep);
    const b = drive(fork, input, inStep, outStep);
    const sameKindOfError = a.verdict === "error" && b.verdict === "error" && b.message !== a.message && /Error code -(9|10|15)$/.test(b.message);
    if (sameKindOfError) {
      // both refuse it, the fork names the backported reason (the original noticed later, other code)
      assert.deepEqual({ ...b, message: "" }, { ...a, message: "" }, `${label}: the fork refuses at another place or with another output`);
      assert.match(libbrotliCode(input), /BLOCK_LENGTH_[12]|PADDING_[12]/, `${label}: libbrotli: ${libbrotliCode(input)}`);
      stats.backported++;
      continue;
    }
    if (a.verdict === "success" && b.verdict === "error") {
      // the only allowed difference: a stream refused for the two backported reasons
      assert.match(b.message, /Error code -(9|10|15)$/, `${label}: the fork refuses a stream the original accepts, for another reason`);
      assert.match(libbrotliCode(input.subarray(0, a.consumed)), /BLOCK_LENGTH_[12]|PADDING_2/, `${label}: libbrotli does not refuse it for the same reason`);
      assert.ok(b.consumed <= a.consumed, label);
      stats.backported++;
      continue;
    }
    assert.deepEqual(b, a, `${label} (in ${inStep}, out ${outStep}): fork differs from the original`);
    stats.compared++;
    stats[a.verdict]++;
    if (index === 0) {
      const ref = libbrotli(input.subarray(0, a.verdict === "success" ? a.consumed : input.length));
      if (a.verdict === "success") {
        if (ref === undefined) stats.libbrotliRefusesWeAccept++; // known leniency of the Rust decoder
        else assert.equal(createHash("sha256").update(ref).digest("hex"), a.out, `${label}: output differs from libbrotli`);
      } else if (ref !== undefined && a.verdict === "error") {
        assert.fail(`${label}: libbrotli accepts a stream the decoder refuses`);
      }
    }
  }
}

// deterministic pseudo random numbers
let seed = 0x2545f491;
const rnd = (): number => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed;
};
const randomBytes = (n: number): Buffer => Buffer.from(Array.from({ length: n }, () => rnd() & 255));
const text = (n: number): Buffer => {
  const words = ["spill", "gate", "brotli", "meta-block", "huffman", "tree", "window", "the", "a", "of", "stream", "bomb", "\n"];
  let s = "";
  while (s.length < n) s += words[rnd() % words.length] + " ";
  return Buffer.from(s.slice(0, n));
};
const enc = (payload: Uint8Array, quality: number, lgwin: number, mode = 0): Buffer =>
  zlib.brotliCompressSync(payload, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
      [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin,
      [zlib.constants.BROTLI_PARAM_MODE]: mode,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: payload.length,
    },
  });

const payloads: Array<[string, Buffer]> = [
  ["empty", Buffer.alloc(0)],
  ["one byte", Buffer.from("x")],
  ["text 20k", text(20_000)],
  ["text 300k", text(300_000)],
  ["random 5k", randomBytes(5_000)],
  ["zeros 200k", Buffer.alloc(200_000)],
  ["ramp 70k", Buffer.from(Array.from({ length: 70_000 }, (_, i) => i & 255))],
  ["mixed", Buffer.concat([text(40_000), randomBytes(3_000), Buffer.alloc(20_000, 7), text(40_000)])],
  ["dictionary words", Buffer.from("information the development of government international ".repeat(300))],
];

test("Covers: SG-I-04 - valid streams: fork, original and libbrotli give the same bytes (qualities 0-11, windows 10-24, modes)", () => {
  let n = 0;
  for (const [name, payload] of payloads) {
    for (let quality = 0; quality <= 11; quality += quality < 4 ? 1 : 3) {
      for (const lgwin of [10, 16, 22, 24]) {
        const stream = enc(payload, quality, lgwin, (quality + lgwin) % 3);
        compare(stream, `${name} q${quality} w${lgwin}`);
        const verdict = drive(fork, stream, 1 << 30, 65536);
        assert.equal(verdict.verdict, "success");
        assert.equal(verdict.length, payload.length);
        n++;
      }
    }
  }
  assert.ok(n > 100);
});

test("Covers: SG-I-04 - hand-built valid streams (stored, zeros, hostile meta-block shapes)", () => {
  compare(brotliStored(Buffer.from("hello"), 16), "stored");
  compare(brotliZeros(1 << 20, 16), "zeros 1 MiB");
  for (const shape of ["single", "four", "all8"] as const) {
    for (const distanceTrees of [false, true]) {
      const stream = hostileBrotli(40, shape, distanceTrees);
      compare(stream, `hostile ${shape} ${distanceTrees}`);
      assert.equal(drive(fork, stream, 1 << 30, 65536).verdict, "success");
    }
  }
});

test("Covers: SG-I-04 - many meta-blocks of different kinds in one stream (table memory reused between meta-blocks)", () => {
  const parts: Buffer[] = [];
  for (let i = 0; i < 40; i++) {
    parts.push(i % 4 === 0 ? text(30_000) : i % 4 === 1 ? randomBytes(9_000) : i % 4 === 2 ? Buffer.alloc(5_000, i) : Buffer.from(Array.from({ length: 20_000 }, (_, k) => (k * (i + 3)) & 255)));
  }
  const payload = Buffer.concat(parts);
  for (const [quality, lgwin] of [[1, 10], [3, 16], [5, 16], [9, 18], [11, 16], [11, 24]] as const) {
    const stream = enc(payload, quality, lgwin);
    compare(stream, `many meta-blocks q${quality} w${lgwin}`, WHOLE);
    const verdict = drive(fork, stream, 1 << 30, 65536);
    assert.equal(verdict.verdict, "success");
    assert.equal(verdict.length, payload.length);
    // damaged late in the stream, after table memory has been reused many times
    for (let i = 0; i < 40; i++) {
      const copy = Buffer.from(stream);
      const at = Math.floor(copy.length / 2) + (rnd() % Math.floor(copy.length / 2));
      copy[at] = (copy[at] as number) ^ (1 << (rnd() & 7));
      compare(copy, `many meta-blocks q${quality} w${lgwin} flip ${at}`, WHOLE);
    }
  }
});

test("Covers: SG-I-05 - damaged streams: every truncation, every bit flip, byte edits, trailing bytes", () => {
  const seeds = [
    enc(text(1500), 5, 16),
    enc(text(1500), 11, 22),
    enc(Buffer.concat([text(600), randomBytes(200)]), 9, 18),
    enc(Buffer.from("information the development of government ".repeat(20)), 11, 20),
    hostileBrotli(2, "all8", true),
    hostileBrotli(4, "four"),
  ];
  for (const [index, stream] of seeds.entries()) {
    const label = `seed ${index}`;
    for (let cut = 0; cut < stream.length; cut += stream.length > 2000 ? 29 : 1) compare(stream.subarray(0, cut), `${label} cut ${cut}`, WHOLE);
    // small seeds: every bit; the large hostile seeds: every 61st bit (a flip costs three decodes)
    const stride = stream.length > 2000 ? 61 : 1;
    for (let bit = 0; bit < stream.length * 8; bit += stride) {
      const copy = Buffer.from(stream);
      copy[bit >> 3] = (copy[bit >> 3] as number) ^ (1 << (bit & 7));
      compare(copy, `${label} flip ${bit}`, bit % 5 === 0 ? BOTH : WHOLE);
    }
    for (let i = 0; i < 150; i++) {
      const copy = Buffer.from(stream);
      const at = rnd() % copy.length;
      const kind = rnd() % 4;
      let edited: Buffer = copy;
      if (kind === 0) edited[at] = rnd() & 255;
      else if (kind === 1) edited = Buffer.concat([copy.subarray(0, at), copy.subarray(at + 1)]);
      else if (kind === 2) edited = Buffer.concat([copy.subarray(0, at), Buffer.from([rnd() & 255]), copy.subarray(at)]);
      else edited = Buffer.concat([copy, randomBytes(1 + (rnd() % 8))]);
      compare(edited, `${label} edit ${i}`, WHOLE);
    }
  }
});

test("Covers: SG-I-05 - random bytes and window-bit patterns", () => {
  for (let i = 0; i < 4000; i++) compare(randomBytes(rnd() % 300), `random ${i}`, WHOLE);
  for (let i = 0; i < 300; i++) {
    const body = randomBytes(40 + (rnd() % 100));
    body[0] = (body[0] as number) & 0xf0 ? 0x11 : 0x0b; // includes the large-window marker (the codec refuses it earlier)
    compare(body, `random wbits ${i}`, WHOLE);
  }
  assert.ok(brotliLargeWindowPrefix().length > 0);
});

test("Covers: SG-I-04 - the comparison covered every verdict", () => {
  assert.ok(stats.success > 200 && stats.error > 2000 && stats.truncated > 200, JSON.stringify(stats));
  assert.ok(stats.backported > 0, "the bit-flip sweeps must hit the backported checks: " + JSON.stringify(stats));
  console.log(`# differential: ${JSON.stringify(stats)}`);
});
