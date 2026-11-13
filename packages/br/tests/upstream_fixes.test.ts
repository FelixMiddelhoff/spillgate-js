/**
 * The robustness fixes that brotli-decompressor made after 5.0.0 (the version vendored in
 * `rust/`), probed against the shipped WebAssembly decoder through the public API, with hostile
 * hand-built streams (`upstream_streams.ts`, `hostile.ts`). Step 1 of the rebase to 6.3.1: which of
 * these are reachable here, and what happens. The findings are in `rust/NOTES.md`.
 *
 * Two of them (693a4a1, 8ed0d7d) were real bugs of 5.0.0 and are backported in
 * `rust/spillgate-backport.patch`; their strict tests (`corrupt` expected) now run unconditionally.
 *
 * `SG_BR_NATIVE=<file URL of a brotli_dec_wasm.js>` runs the raw-decoder probes against another
 * build (as in `native_diff.test.ts`); the public-API probes always use the shipped module.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import zlib from "node:zlib";
import * as original from "brotli-dec-wasm/web";
import { Decoder, SpillgateError, type Limits, type PullSource, type Source } from "spillgate";
import { brotliStored, data } from "spillgate-test-support";
import { hostileBlockTypes, hostileBrotli } from "./hostile.js";
import { codec, initBrotli } from "../src/index.js";
import { Bits, compressedBlock, copyLong, endOfStream, insertCopy, insertLong, stream, uncompressedBlock } from "./upstream_streams.js";

await initBrotli();

const require_ = createRequire(import.meta.url);
original.initSync({ module: readFileSync(require_.resolve("brotli-dec-wasm/web/bg.wasm")) });
const nativeUrl = process.env["SG_BR_NATIVE"] ?? new URL("../src/native/brotli_dec_wasm.js", import.meta.url).href;
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
  initSync(options: { module: BufferSource }): { memory: WebAssembly.Memory };
}
const fork = (await import(nativeUrl)) as Module;
const forkExports = fork.initSync({ module: readFileSync(new URL("brotli_dec_wasm_bg.wasm", nativeUrl)) });

const LONG: { skip?: string } = process.env["SG_BR_LONG"] ? {} : { skip: "long run: SG_BR_LONG=1" };
const MIB = 1 << 20;
const M = 1 << 24; // largest MLEN, and the initial block length of a category with one block type

// -- drivers ----------------------------------------------------------------------------------------

interface Verdict {
  verdict: "success" | "truncated" | "error" | "trap" | "noprogress";
  length: number;
  hash: string;
  consumed: number;
  message: string;
}

/** A streaming decode with the raw module that never throws; a WebAssembly trap is its own verdict. */
function raw(mod: Module, input: Uint8Array, inStep: number, outStep: number): Verdict {
  const stream_ = new mod.DecompressStream();
  const hash = createHash("sha256");
  let length = 0;
  let consumed = 0;
  let idle = 0;
  const done = (verdict: Verdict["verdict"], message = ""): Verdict => ({ verdict, length, hash: hash.digest("hex"), consumed, message });
  try {
    for (let rounds = 0; rounds < 1_000_000; rounds++) {
      const slice = input.subarray(consumed, Math.min(input.length, consumed + inStep));
      let result: Result;
      try {
        result = stream_.decompress(slice.slice(), outStep);
      } catch (error) {
        return done(error instanceof WebAssembly.RuntimeError ? "trap" : "error", String((error as Error).message));
      }
      const buf = result.buf.slice();
      const { code, input_offset } = result;
      result.free();
      hash.update(buf);
      length += buf.length;
      consumed += input_offset;
      if (code === 1) return done("success");
      if (code === 2 && consumed >= input.length) return done("truncated");
      idle = buf.length === 0 && input_offset === 0 ? idle + 1 : 0;
      if (idle > 1000) return done("noprogress");
    }
    return done("noprogress", "too many rounds");
  } finally {
    stream_.free();
  }
}

const libbrotli = (input: Uint8Array): { ok: true; out: Buffer } | { ok: false; code: string } => {
  try {
    return { ok: true, out: zlib.brotliDecompressSync(input) };
  } catch (error) {
    return { ok: false, code: String((error as { code?: string }).code) };
  }
};

const LOOSE: Limits = { maxOutput: 2 ** 30, disableRatioLimit: true };
const decoder = (limits: Limits = LOOSE): Decoder => new Decoder(limits, { codecs: { br: codec() } });

type Chunking = "whole" | number | "pull-empty";

function sourceOf(bytes: Uint8Array, chunking: Chunking): Source {
  if (chunking === "whole") return bytes;
  if (typeof chunking === "number") {
    return (async function* () {
      for (let at = 0; at < bytes.length; at += chunking) yield bytes.subarray(at, at + chunking);
    })();
  }
  // a pull source that answers "no progress" before every chunk, and never more than 5 bytes
  let pos = 0;
  let skip = 0;
  const pull: PullSource = {
    read(max: number) {
      if (pos >= bytes.length) return null;
      if (skip++ % 3 !== 2) return new Uint8Array(0);
      const chunk = bytes.subarray(pos, pos + Math.min(max, 5));
      pos += chunk.length;
      return chunk;
    },
  };
  return pull;
}

interface Outcome {
  kind: string; // "ok" or the spillgate error kind
  length: number;
  hash: string;
}

/** The public API: decode `bytes`, never throw anything but a typed error. */
async function api(bytes: Uint8Array, readSize = 4096, chunking: Chunking = "whole", limits: Limits = LOOSE): Promise<Outcome> {
  const hash = createHash("sha256");
  let length = 0;
  const reader = decoder(limits).reader(sourceOf(bytes, chunking), "br");
  try {
    for (let chunk = await reader.read(readSize); chunk !== null; chunk = await reader.read(readSize)) {
      hash.update(chunk);
      length += chunk.length;
    }
    return { kind: "ok", length, hash: hash.digest("hex") };
  } catch (error) {
    assert.ok(error instanceof SpillgateError, `a foreign error escaped: ${String(error)}`);
    return { kind: error.kind, length, hash: hash.digest("hex") };
  } finally {
    reader.close();
  }
}

/** The same outcome for every read size and source chunking. */
async function everyWay(bytes: Uint8Array, forceBig = false): Promise<Outcome[]> {
  const big = forceBig || raw(fork, bytes, 1 << 30, 65536).length > 50_000;
  const sizes = big ? [4096, 65536] : [1, 7, 4096, 65536];
  const chunkings: Chunking[] = big ? ["whole", 1, "pull-empty"] : ["whole", 1, 3, 4096, "pull-empty"];
  const outcomes: Outcome[] = [];
  for (const readSize of sizes) for (const chunking of chunkings) outcomes.push(await api(bytes, readSize, chunking));
  return outcomes;
}

const unique = (outcomes: Outcome[]): string[] => [...new Set(outcomes.map((o) => `${o.kind}:${o.length}:${o.hash.slice(0, 8)}`))];

// deterministic pseudo random numbers
let seed = 0x9e3779b1;
const rnd = (): number => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed;
};

const wasmBytes = (): number => forkExports.memory.buffer.byteLength;

// -- streams ------------------------------------------------------------------------------------------

/** Insert 5 literals (A), copy 7 from distance 4: 12 bytes, MLEN says `mlen`. */
const copyOverrun = (mlen: number, wbits = 16, last = false): Uint8Array =>
  stream(wbits, (w) => {
    compressedBlock(w, { mlen, command: insertCopy(5, 5), last });
    if (!last) endOfStream(w);
  });
/** Insert 1 literal, copy a 4-byte dictionary word: 5 bytes, MLEN says 2. */
const dictionaryOverrun = (): Uint8Array => stream(16, (w) => { compressedBlock(w, { mlen: 2, command: insertCopy(1, 2) }); endOfStream(w); });
/** Insert 5 literals, copy `copy` bytes from distance 4, MLEN 8. */
const longCopyOverrun = (copy: number, wbits: number): Uint8Array =>
  stream(wbits, (w) => { compressedBlock(w, { mlen: 8, command: copyLong(5, 23), extra: [[copy - 2118, 24]] }); endOfStream(w); });
/** One command that inserts `insert` literals (a one-symbol code: no input bits), then copies 2. */
const insertOnly = (mlen: number, insert: number, wbits: number, last = false): Uint8Array =>
  stream(wbits, (w) => {
    compressedBlock(w, { mlen, command: insertLong(23, 0), extra: [[insert - 22594, 24]], last });
    if (!last) endOfStream(w);
  });
const padded = (build: (w: Bits) => void, padding: number): Uint8Array => stream(16, (w) => { build(w); w.pad(padding); });

// ==================================================================================================
// 693a4a1: meta-blocks that exceed their declared MLEN
// ==================================================================================================

const OVERRUNS: Array<[string, Uint8Array]> = [
  ["copy overshoots MLEN by 4 (window 10)", copyOverrun(8, 10)],
  ["copy overshoots MLEN by 4 (window 16)", copyOverrun(8, 16)],
  ["copy overshoots MLEN by 1 (window 24)", copyOverrun(11, 24)],
  ["dictionary word overshoots MLEN", dictionaryOverrun()],
  ["1 MiB copy in a meta-block of 8 (window 24)", longCopyOverrun(MIB, 24)],
  ["two meta-blocks, the first overshoots", stream(16, (w) => { compressedBlock(w, { mlen: 8, command: insertCopy(5, 5) }); compressedBlock(w, { mlen: 3, command: insertCopy(3, 0) }); endOfStream(w); })],
];

test("Covers: SG-I-05 SG-R-CDC-08 - 693a4a1: a meta-block that exceeds its declared MLEN is corrupt", async () => {
  const accepted: string[] = [];
  for (const [name, bytes] of OVERRUNS) {
    assert.equal(libbrotli(bytes).ok, false, `${name}: libbrotli accepts it`);
    if ((await everyWay(bytes)).some((outcome) => outcome.kind !== "corrupt")) accepted.push(name);
  }
  assert.deepEqual(accepted, [], "accepted, though libbrotli refuses them");
});

test("Covers: SG-I-05 SG-I-09 - 693a4a1: an overshoot is refused the same way for every read size and chunking, nothing of it is delivered, and the original 2.3.2 still accepts it", async () => {
  for (const [name, bytes] of OVERRUNS) {
    assert.equal(libbrotli(bytes).ok, false, name);
    const outcomes = await everyWay(bytes);
    assert.deepEqual(unique(outcomes).length, 1, `${name}: ${unique(outcomes).join(" | ")}`);
    assert.equal(outcomes[0]?.kind, "corrupt", name);
    assert.equal(raw(fork, bytes, 1 << 30, 65536).verdict, "error", name);
    assert.match(raw(fork, bytes, 1 << 30, 65536).message, /Error code -(9|10)$/, name); // upstream's BLOCK_LENGTH_1/2
  }
  // the one allowed difference to the npm original: it delivers the overshoot
  const orig = raw(original as unknown as Module, OVERRUNS[0]![1], 1 << 30, 65536);
  assert.equal(orig.verdict, "success");
  // the limits still win over the format error where they trigger first
  const big = longCopyOverrun(4 * MIB, 24);
  const capped = await api(big, 65536, "whole", { maxOutput: MIB, disableRatioLimit: true });
  assert.ok(["output_limit", "corrupt"].includes(capped.kind), capped.kind);
  const ratio = await api(big, 65536, "whole", { maxOutput: 2 ** 30 });
  assert.ok(["ratio_limit", "corrupt"].includes(ratio.kind), ratio.kind);
  assert.ok(ratio.length <= 1000 * big.length + 64 * 1024 + 65536, String(ratio.length));
});

test("Covers: SG-I-05 SG-R-CDC-08 - 693a4a1: overshoots that cross a ring-buffer write or end the stream are already corrupt", async () => {
  const already: Array<[string, Uint8Array]> = [
    ["overshooting last meta-block", copyOverrun(8, 16, true)],
    ["copy across the ring buffer end (window 10)", stream(10, (w) => { compressedBlock(w, { mlen: 8, command: copyLong(5, 23), extra: [[3000, 24]] }); endOfStream(w); })],
    ["insert beyond MLEN, window 16", insertOnly(M, M + 1, 16)],
    ["insert beyond MLEN, window 24", insertOnly(M, M + 1, 24)],
  ];
  for (const [name, bytes] of already) {
    assert.equal(libbrotli(bytes).ok, false, name);
    for (const outcome of await everyWay(bytes, true)) assert.equal(outcome.kind, "corrupt", name);
    assert.equal(raw(fork, bytes, 1 << 30, 65536).verdict, "error", name);
  }
  // the valid neighbours of these shapes still decode, to the byte
  const valid = stream(10, (w) => { compressedBlock(w, { mlen: 5 + 2118 + 3000, command: copyLong(5, 23), extra: [[3000, 24]] }); endOfStream(w); });
  const lib = libbrotli(valid);
  assert.ok(lib.ok);
  const outcome = await api(valid);
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.hash, createHash("sha256").update((lib as { out: Buffer }).out).digest("hex"));
});

// ==================================================================================================
// 8ed0d7d, 677eef1: padding
// ==================================================================================================

const hello = new TextEncoder().encode("hello");
const metadata = (w: Bits, padding: number): void => {
  w.bits(0, 1); // ISLAST
  w.bits(3, 2); // MNIBBLES = 0: metadata block
  w.bits(0, 1); // reserved
  w.bits(1, 2); // MSKIPBYTES = 1
  w.bits(2, 8); // 3 bytes
  w.pad(padding);
  w.raw(Uint8Array.of(1, 2, 3));
};

test("Covers: SG-I-05 SG-R-CDC-08 - 8ed0d7d: nonzero padding bits after the last compressed meta-block are corrupt", async () => {
  for (const padding of [1, 0xff]) {
    const bytes = padded((w) => compressedBlock(w, { mlen: 2, command: insertCopy(2, 0), last: true }), padding);
    assert.equal(libbrotli(bytes).ok, false);
    for (const outcome of await everyWay(bytes)) assert.equal(outcome.kind, "corrupt", `padding ${padding}`);
  }
});

test("Covers: SG-I-05 SG-I-09 - 8ed0d7d: zero padding after a last compressed meta-block is valid, nonzero is refused with PADDING_2 and nothing is delivered after it", async () => {
  const valid = padded((w) => compressedBlock(w, { mlen: 2, command: insertCopy(2, 0), last: true }), 0);
  assert.equal(libbrotli(valid).ok, true);
  const expected = await api(valid);
  assert.equal(expected.kind, "ok");
  assert.equal(expected.length, 2);
  for (const padding of [1, 0xff]) {
    const bytes = padded((w) => compressedBlock(w, { mlen: 2, command: insertCopy(2, 0), last: true }), padding);
    assert.equal(libbrotli(bytes).ok, false, "libbrotli: PADDING_2");
    assert.match(raw(fork, bytes, 1 << 30, 65536).message, /Error code -15$/);
    assert.equal(raw(original as unknown as Module, bytes, 1 << 30, 65536).verdict, "success", "the npm original accepts it");
  }
});

test("Covers: SG-I-05 SG-R-CDC-08 - 8ed0d7d 677eef1: nonzero padding before a stored or metadata block and in an empty last block is corrupt", async () => {
  const cases: Array<[string, Uint8Array]> = [];
  for (const padding of [1, 0xff]) {
    cases.push([`stored, padding ${padding}`, stream(16, (w) => { uncompressedBlock(w, hello, padding); endOfStream(w); })]);
    cases.push([`metadata, padding ${padding}`, stream(16, (w) => { metadata(w, padding); endOfStream(w); })]);
    cases.push([`empty last, padding ${padding}`, padded((w) => endOfStream(w), padding)]);
  }
  for (const [name, bytes] of cases) {
    assert.equal(libbrotli(bytes).ok, false, name);
    for (const outcome of await everyWay(bytes)) assert.deepEqual([outcome.kind, outcome.length], ["corrupt", 0], name);
    // 677eef1 (in 6.x) splits the error: PADDING_1 is -14, PADDING_2 is -15; libbrotli is the oracle
    const lib = libbrotli(bytes);
    const expected = lib.ok ? "" : lib.code === "ERR_BROTLI_DECODER_ERROR_FORMAT_PADDING_1" ? "-14" : lib.code === "ERR_BROTLI_DECODER_ERROR_FORMAT_PADDING_2" ? "-15" : lib.code;
    assert.match(expected, /^-1[45]$/, `${name}: libbrotli: ${lib.ok ? "ok" : lib.code}`);
    assert.ok(raw(fork, bytes, 1 << 30, 65536).message.endsWith(`Error code ${expected}`), name);
  }
  // and the same shapes with zero padding are valid
  for (const bytes of [stream(16, (w) => { uncompressedBlock(w, hello); endOfStream(w); }), stream(16, (w) => { metadata(w, 0); endOfStream(w); })]) {
    const lib = libbrotli(bytes);
    assert.ok(lib.ok);
    const outcome = await api(bytes);
    assert.deepEqual([outcome.kind, outcome.length], ["ok", (lib as { out: Buffer }).out.length]);
  }
});

// ==================================================================================================
// cc7ee0e: block switch in a category with a single block type
// ==================================================================================================

test("Covers: SG-I-05 SG-R-CDC-08 SG-I-09 - cc7ee0e: a block switch with one block type is unreachable (an overlong insert is refused at the first ring-buffer write); no hang, no trap", { timeout: 300_000 }, async () => {
  // The literal block length of a category with one block type starts at 2**24, MLEN is at most
  // 2**24, so a switch needs a 2**24+1-th literal. The insert length of a command is subtracted from
  // MLEN first, so the literals of such a command exceed MLEN, and the ring buffer (at most 2**24
  // bytes) is written out before the 2**24+1-th literal is decoded: BLOCK_LENGTH_1. The command
  // categories cannot get there at all (at least 2 bytes per command).
  const shapes: Array<[string, Uint8Array]> = [];
  for (const wbits of [10, 16, 24]) {
    for (const last of [false, true]) {
      shapes.push([`insert M+1, window ${wbits}, last ${last}`, insertOnly(M, M + 1, wbits, last)]);
      shapes.push([`insert M+1000, window ${wbits}, last ${last}`, insertOnly(M, M + 1000, wbits, last)]);
    }
  }
  shapes.push(["insert M-1 then a copy of 2", insertOnly(M, M - 1, 16)]);
  shapes.push(["two commands, M/2+1 literals each", stream(16, (w) => { compressedBlock(w, { mlen: M, command: insertLong(23, 0), extra: [[M / 2 + 1 - 22594, 24]], repeat: 2 }); endOfStream(w); })]);
  for (const [name, bytes] of shapes) {
    // libbrotli is not run on these: the C decoder has the bug this commit is about
    const first = raw(fork, bytes, 1 << 30, 65536);
    assert.equal(first.verdict, "error", name);
    assert.match(first.message, /Error code -\d+$/, name);
    for (const [inStep, outStep] of [[1, 4096], [3, 65536], [4096, 1]] as const) {
      if (outStep === 1) continue; // 16 MiB in one-byte steps: not worth it
      assert.equal(raw(fork, bytes, inStep, outStep).verdict, "error", `${name} ${inStep}/${outStep}`);
    }
    for (const outcome of await everyWay(bytes, true)) assert.equal(outcome.kind, "corrupt", name);
  }
});

test("Covers: SG-I-04 SG-I-09 - cc7ee0e: the extremes next to the block-switch shapes are valid and decode to the byte (M literals, M-1 literals + copy, millions of commands)", { timeout: 300_000 }, async () => {
  const valid: Array<[string, Uint8Array]> = [
    ["M literals, window 16", insertOnly(M, M, 16)],
    ["M literals, window 24", insertOnly(M, M, 24)],
    ["M literals as the last meta-block", insertOnly(M, M, 24, true)],
    // 4 literals + 2 copied per command: 2.8 million commands in one meta-block, the command block
    // length (2**24) is never used up
    ["2.8 million commands", stream(16, (w) => {
      const commands = Math.floor(M / 6);
      compressedBlock(w, { mlen: commands * 6, command: insertCopy(4, 0) });
      endOfStream(w);
    })],
  ];
  for (const [name, bytes] of valid) {
    const lib = libbrotli(bytes);
    assert.ok(lib.ok, name);
    const expected = createHash("sha256").update((lib as { out: Buffer }).out).digest("hex");
    for (const outcome of await everyWay(bytes, true)) assert.deepEqual([outcome.kind, outcome.hash], ["ok", expected], name);
    const forkVerdict = raw(fork, bytes, 1 << 30, 65536);
    assert.deepEqual([forkVerdict.verdict, forkVerdict.hash], ["success", expected], name);
  }
});

// ==================================================================================================
// c1f6944, c31d20b, 8cb69d1: ranges of input and output, uncompressed meta-blocks
// ==================================================================================================

test("Covers: SG-I-05 SG-R-INP-02 - c1f6944 c31d20b 8cb69d1: the codec never hands the decoder a range anywhere near 2**31 (input at most 4 KiB, output at most 64 KiB)", async () => {
  // 8cb69d1 needs 2**31 unread input bytes in one call, c31d20b/c1f6944 need 2**32 bytes or an
  // output size near usize::MAX. The codec passes the meter's view (at most 4096 bytes, the buffer
  // size of the source adapter) and an output step of at most 65536 bytes.
  const payload = new Uint8Array(3 * MIB).map((_, i) => (i * 31) & 255);
  const bytes = brotliStored(payload, 16);
  let largestAsked = 0;
  let pos = 0;
  const asking: PullSource = {
    read(max) {
      largestAsked = Math.max(largestAsked, max);
      if (pos >= bytes.length) return null;
      const chunk = bytes.subarray(pos, pos + max);
      pos += chunk.length;
      return chunk;
    },
  };
  const reader = decoder().reader(asking, "br");
  let produced = 0;
  let largestOut = 0;
  for (let chunk = await reader.read(1 << 30); chunk !== null; chunk = await reader.read(1 << 30)) {
    produced += chunk.length;
    largestOut = Math.max(largestOut, chunk.length);
  }
  reader.close();
  assert.equal(produced, payload.length);
  assert.ok(largestAsked <= 4096, `the source was asked for ${largestAsked} bytes`);
  assert.ok(largestOut <= 65536, `a read returned ${largestOut} bytes`);
});

test("Covers: SG-I-04 SG-I-09 - 8cb69d1: stored meta-blocks (up to 4 MiB in one meta-block, ring buffer of 1 KiB to 16 MiB) are copied exactly for every read size and chunking", { timeout: 300_000 }, async () => {
  for (const [size, combos] of [
    [4 * MIB, [[65536, "whole"], [4096, 4096]]],
    [30_000, [[1, 1], [7, 3], [4096, "pull-empty"], [65536, "whole"]]],
  ] as const) {
    const payload = Buffer.from(data(11, size));
    const expected = createHash("sha256").update(payload).digest("hex");
    for (const wbits of [10, 16, 24]) {
      const bytes = brotliStored(payload, wbits);
      assert.deepEqual(libbrotli(bytes).ok, true);
      for (const [readSize, chunking] of combos) {
        const outcome = await api(bytes, readSize, chunking);
        assert.deepEqual([outcome.kind, outcome.length, outcome.hash], ["ok", size, expected], `${size} bytes, window ${wbits}, ${readSize}/${chunking}`);
      }
    }
  }
  // and a stored block that is cut anywhere is corrupt, never a clean end
  const small = brotliStored(Buffer.from(data(12, 3000)), 10);
  for (let cut = 1; cut < small.length; cut += 37) assert.equal((await api(small.subarray(0, cut))).kind, "corrupt", `cut ${cut}`);
});

// ==================================================================================================
// 79404c1: Huffman groups on an error path; the module is shared by all decoders
// ==================================================================================================

test("Covers: SG-I-08 SG-R-MEM-02 - 79404c1: FORMAT_DISTANCE (the error path that dropped the tree groups) is unreachable; error paths after 256 trees give the memory back", async () => {
  // FORMAT_DISTANCE needs a distance code above 0x7FFFFFFC: the largest the format can write
  // (NPOSTFIX 3, NDIRECT 120, 24 extra bits) is about 5.4e8, so only the large-window mode could
  // get there, and that is refused. Build the largest one and see which error comes.
  const largest = stream(24, (b) => {
    b.bits(0, 1); // ISLAST
    b.bits(0, 2); // MNIBBLES = 4
    b.bits(9, 16); // MLEN = 10
    b.bits(0, 1); // ISUNCOMPRESSED
    b.bits(0, 3); // one block type each
    b.bits(3, 2); // NPOSTFIX = 3
    b.bits(15, 4); // NDIRECT = 15 << 3 = 120
    b.bits(0, 2); // literal context mode
    b.bits(0, 2); // one tree each
    for (const [symbol, bits] of [[0x41, 8], [128 + (1 << 3) + 2, 10], [16 + 120 + (48 << 3) - 1, 10]] as const) {
      b.bits(1, 2);
      b.bits(0, 2);
      b.bits(symbol, bits);
    }
    b.bits(0xffffff, 24); // the 24 extra bits of the largest distance code
  });
  const farthest = raw(fork, largest, 1 << 30, 65536);
  assert.equal(farthest.verdict, "error");
  assert.doesNotMatch(farthest.message, /Error code -16$/); // not FORMAT_DISTANCE
  assert.equal(libbrotli(largest).ok, false);
  const hostile = Uint8Array.from(hostileBrotli(1, "all8", true));
  hostile[0] = (hostile[0] as number) | 0x10; // MLEN 2: the copy of 2 from distance 4 fails after the 512 trees were read
  const failing = raw(fork, hostile, 1 << 30, 65536);
  assert.equal(failing.verdict, "error");
  assert.match(failing.message, /Error code -12$/); // FORMAT_DICTIONARY
  assert.equal(libbrotli(hostile).ok, false);
  // many decoders that fail after reading 512 trees: the memory of the module stays flat
  for (let i = 0; i < 20; i++) raw(fork, hostile, 1 << 30, 65536);
  const before = wasmBytes();
  for (let i = 0; i < 400; i++) assert.equal(raw(fork, hostile, i % 2 === 0 ? 1 << 30 : 100, 65536).verdict, "error");
  assert.ok(wasmBytes() - before <= 4 * MIB, `the module grew by ${(wasmBytes() - before) >> 20} MiB over 400 failing decoders`);
  for (let i = 0; i < 20; i++) assert.equal((await api(hostile)).kind, "corrupt");
});

test("Covers: SG-I-05 SG-R-CDC-08 - the module instance is shared: decoders do not disturb each other, an error in one leaves the others and the module usable", async () => {
  const good = zlib.brotliCompressSync(Buffer.from(data(3, 200_000)), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  const expected = zlib.brotliDecompressSync(good);
  const bad = [copyOverrun(8), hostileBlockTypes(3, true), insertOnly(M, M + 1, 16), Uint8Array.from(good).fill(0xa5, 20, 60), good.subarray(0, 1000)];
  const readers = bad.map((bytes) => decoder().reader(bytes, "br"));
  const healthy = decoder().reader(good, "br");
  const out: Buffer[] = [];
  const kinds: string[] = readers.map(() => "ok");
  const alive = new Set(readers.keys());
  let healthyDone = false;
  while (!healthyDone || alive.size > 0) {
    if (!healthyDone) {
      const chunk = await healthy.read(3000);
      if (chunk === null) healthyDone = true;
      else out.push(Buffer.from(chunk));
    }
    for (const i of [...alive]) {
      try {
        if ((await (readers[i] as (typeof readers)[number]).read(500)) === null) alive.delete(i);
      } catch (error) {
        assert.ok(error instanceof SpillgateError);
        kinds[i] = error.kind;
        alive.delete(i);
      }
    }
  }
  healthy.close();
  for (const r of readers) r.close();
  assert.equal(Buffer.compare(Buffer.concat(out), expected), 0);
  assert.equal(kinds[1], "ok"); // hostileBlockTypes is a valid stream
  assert.equal(kinds[2], "corrupt");
  assert.equal(kinds[4], "corrupt");
  assert.ok(kinds[3] === "ok" || kinds[3] === "corrupt");
});

test("Covers: SG-I-05 SG-R-CDC-08 - a WebAssembly trap leaves the module usable for other decoders and loses only the trapped one; about 3,200 traps poison the module (a trap is not reachable through the API; this is the price if one is)", { timeout: 120_000 }, async () => {
  // Artificial trap: an output step of 4 GiB makes the Rust side panic (capacity overflow); the
  // codec never asks for more than 64 KiB. The panic aborts (WebAssembly has no unwinding here), so
  // the shadow stack of the panicking call is never given back: after about 3,250 traps every call
  // of the module fails with "memory access out of bounds", even the finalizers of the glue code
  // (an uncaught exception that ends the process). That is why the poisoning is measured in a
  // child process.
  const url = nativeUrl;
  const script = `
    import { readFileSync } from "node:fs";
    import zlib from "node:zlib";
    console.error = () => {};
    const mod = await import(${JSON.stringify(url)});
    mod.initSync({ module: readFileSync(new URL("brotli_dec_wasm_bg.wasm", ${JSON.stringify(url)})) });
    const good = zlib.brotliCompressSync(Buffer.from("hello world ".repeat(1000)));
    const decode = () => {
      const s = new mod.DecompressStream();
      const r = s.decompress(good, 65536);
      const n = r.buf.length;
      r.free();
      s.free();
      return n;
    };
    const report = { traps: 0, usableAfterFirst: false, freeAfterTrapThrows: false, poisonedAfter: -1 };
    for (let i = 1; i <= 6000; i++) {
      let s;
      try { s = new mod.DecompressStream(); } catch { report.poisonedAfter = report.traps; break; }
      try { s.decompress(good, 0xfffffff0); } catch (e) { if (e instanceof WebAssembly.RuntimeError) report.traps++; }
      if (i === 1) {
        try { s.free(); } catch { report.freeAfterTrapThrows = true; }
        report.usableAfterFirst = decode() === 12000;
      }
    }
    console.log(JSON.stringify(report));
    process.exit(0); // the finalizers of the dead objects would throw
  `;
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
  const lines = child.stdout.trim().split(/\r?\n/);
  const report = JSON.parse(lines[lines.length - 1] as string) as { traps: number; usableAfterFirst: boolean; freeAfterTrapThrows: boolean; poisonedAfter: number };
  assert.ok(report.traps >= 100, JSON.stringify(report));
  assert.ok(report.usableAfterFirst, "the module is not usable after a trap");
  assert.ok(report.freeAfterTrapThrows, "a trapped decoder can be freed (the wrapper's close() would not throw)");
  console.log(`# trap probe: ${JSON.stringify(report)}`);
});

// ==================================================================================================
// b1d31a8 and the rest: panics on malformed streams; hangs; memory
// ==================================================================================================

function seedStreams(): Uint8Array[] {
  const text = Buffer.from("the quick brown fox ".repeat(30) + "information development ".repeat(10));
  const out: Uint8Array[] = [];
  for (const quality of [0, 1, 5, 9, 11]) {
    for (const lgwin of [10, 16, 22]) out.push(zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin } }));
  }
  out.push(hostileBrotli(2, "all8", true), hostileBrotli(3, "four"), hostileBlockTypes(2, true), hostileBlockTypes(3, false));
  out.push(copyOverrun(8), dictionaryOverrun(), brotliStored(text.subarray(0, 500), 10));
  return out;
}

function mutant(seeds: Uint8Array[]): Uint8Array {
  let input: Uint8Array;
  const kind = rnd() % 5;
  if (kind === 0) {
    input = Uint8Array.from({ length: 1 + (rnd() % 200) }, () => rnd() & 255);
  } else if (kind === 1) {
    // a valid meta-block header (no uncompressed block), random rest: random trees and commands
    const header = stream(16, (w) => { w.bits(0, 1); w.bits(0, 2); w.bits(rnd() & 0xffff, 16); w.bits(0, 1); });
    input = Uint8Array.from([...header, ...Array.from({ length: 1 + (rnd() % 300) }, () => rnd() & 255)]);
  } else {
    const copy = Uint8Array.from(seeds[rnd() % seeds.length] as Uint8Array);
    for (let k = 1 + (rnd() % 4); k > 0; k--) {
      const at = rnd() % copy.length;
      const how = rnd() % 3;
      copy[at] = how === 0 ? (copy[at] as number) ^ (1 << (rnd() & 7)) : how === 1 ? rnd() & 255 : 0xff;
    }
    input = kind === 3 ? copy.subarray(0, 1 + (rnd() % copy.length)) : copy;
  }
  const first = input[0] as number;
  if ((first & 1) !== 0 && ((first >> 1) & 7) === 0 && ((first >> 4) & 7) === 1) {
    input = Uint8Array.from(input); // the large-window marker: refused by the codec before the decoder sees a byte
    input[0] = 0x21;
  }
  return input;
}

test("Covers: SG-I-05 SG-R-CDC-08 - b1d31a8 and the other panic fixes: 40,000 mutated and random streams never trap the decoder, never stall, and the memory stays small", { timeout: 600_000 }, () => {
  const seeds = seedStreams();
  const counts: Record<string, number> = {};
  const startMemory = wasmBytes();
  for (let i = 0; i < 40_000; i++) {
    const input = mutant(seeds);
    const [inStep, outStep] = [[1 << 30, 65536], [1, 1 + (rnd() % 50)], [1 + (rnd() % 9), 4096]][rnd() % 3] as [number, number];
    const verdict = raw(fork, input, inStep, outStep);
    counts[verdict.verdict] = (counts[verdict.verdict] ?? 0) + 1;
    assert.ok(verdict.verdict !== "trap" && verdict.verdict !== "noprogress", `${verdict.verdict} (${verdict.message}) on ${Buffer.from(input).toString("hex")} in ${inStep}/${outStep}`);
    assert.ok(verdict.length < 100 * MIB);
  }
  assert.ok((counts["error"] ?? 0) > 5000 && (counts["success"] ?? 0) > 500 && (counts["truncated"] ?? 0) > 500, JSON.stringify(counts));
  assert.ok(wasmBytes() - startMemory <= 64 * MIB, `the module grew by ${(wasmBytes() - startMemory) >> 20} MiB`);
  console.log(`# panic fuzz: ${JSON.stringify(counts)}`);
});

test("Covers: SG-I-05 SG-R-CDC-08 - the public API gives only ok, corrupt or output_limit for 2,000 mutated streams, never memory_limit (that is how a trap would show) or internal", { timeout: 300_000 }, async () => {
  const seeds = seedStreams();
  const kinds: Record<string, number> = {};
  for (let i = 0; i < 2_000; i++) {
    const input = mutant(seeds);
    const outcome = await api(input, [1, 7, 4096, 65536][rnd() % 4] as number, ["whole", 1, 3, 4096, "pull-empty"][rnd() % 5] as Chunking, { maxOutput: 64 * MIB, disableRatioLimit: true });
    kinds[outcome.kind] = (kinds[outcome.kind] ?? 0) + 1;
    assert.ok(outcome.kind === "ok" || outcome.kind === "corrupt" || outcome.kind === "output_limit", `${outcome.kind} on ${Buffer.from(input).toString("hex")}`);
  }
  assert.ok((kinds["ok"] ?? 0) > 100 && (kinds["corrupt"] ?? 0) > 800, JSON.stringify(kinds));
});

test("Covers: SG-R-INP-01 SG-R-CDC-06 SG-I-09 - a source that never ends, or ends early, cannot hang a decoder on any of the probed shapes", { timeout: 300_000 }, async () => {
  const shapes: Array<[string, Uint8Array]> = [
    ["copy overrun", copyOverrun(8)],
    ["insert beyond MLEN", insertOnly(M, M + 1, 16)],
    ["bad padding", padded((w) => compressedBlock(w, { mlen: 2, command: insertCopy(2, 0), last: true }), 1)],
    ["hostile trees", hostileBrotli(3, "four", true)],
    ["block types", hostileBlockTypes(3, true)],
    ["truncated trees", hostileBrotli(3, "all8", true).subarray(0, 700)],
    ["truncated stored", brotliStored(hello, 16).subarray(0, 4)],
  ];
  for (const [name, bytes] of shapes) {
    const ends = await api(bytes, 4096, "pull-empty");
    // the same stream followed by zero bytes forever: the input cap ends it (or the decoder does)
    let sent = 0;
    const endless: PullSource = {
      read(max) {
        const chunk = new Uint8Array(Math.min(max, 1000));
        const head = bytes.subarray(sent, sent + chunk.length);
        chunk.set(head);
        sent += chunk.length;
        return chunk;
      },
    };
    const reader = decoder({ maxOutput: 64 * MIB, disableRatioLimit: true, maxInput: 256 * 1024 }).reader(endless, "br");
    let kind = "ok";
    try {
      for (let c = await reader.read(65536); c !== null; c = await reader.read(65536));
    } catch (error) {
      assert.ok(error instanceof SpillgateError, name);
      kind = error.kind;
    } finally {
      reader.close();
    }
    assert.ok(sent <= 256 * 1024 + 1000, `${name}: ${sent} bytes taken`);
    assert.ok(["corrupt", "input_limit", "ok"].includes(kind), `${name}: ${kind}`);
    assert.ok(["corrupt", "ok"].includes(ends.kind), `${name}: ${ends.kind}`);
  }
});

test("Covers: SG-I-08 SG-R-MEM-02 SG-R-CDC-04 - the module's memory after a hostile stream is bounded by the window cap plus a few MiB, whatever the shape", { timeout: 300_000 }, async () => {
  // run in order of growth: the module never shrinks, so measure the growth of each shape against
  // what the module already holds
  const shapes: Array<[string, Uint8Array]> = [
    ["256 literal and 256 distance trees x 25 meta-blocks", hostileBrotli(25, "all8", true)],
    ["256 block types x 50 meta-blocks", hostileBlockTypes(50, true)],
    ["copy overshoot", longCopyOverrun(4 * MIB, 24)],
    ["16 MiB stored, window 24", brotliStored(new Uint8Array(M), 24)],
  ];
  for (const [name, bytes] of shapes) {
    await api(bytes, 65536);
    const base = wasmBytes();
    await api(bytes, 65536);
    await api(bytes, 4096, 4096);
    assert.equal(wasmBytes(), base, `${name}: a repeated decode grew the module`);
    assert.ok(base <= 64 * MIB, `${name}: the module holds ${base >> 20} MiB`);
  }
});

test("Covers: SG-R-CDC-04 SG-I-04 - brotli output beyond 4 GiB (32-bit counters of the WebAssembly decoder) is exact", { ...LONG, timeout: 600_000 }, async () => {
  // brotli-decompressor 6.0.0 (b1d31a8) checks ring-buffer counters with usize arithmetic, which is
  // 32 bits wide in WebAssembly; 5.0.0 wraps and works. 6.3.1 uses u64. Check what a build does.
  const { brotliZeros } = await import("spillgate-test-support");
  const size = 5 * 2 ** 30 + 12345;
  const bytes = brotliZeros(size, 24);
  const reader = decoder({ maxOutput: 2 ** 34, disableRatioLimit: true }).reader(bytes, "br");
  const zeros = Buffer.alloc(65536);
  let produced = 0;
  for (let chunk = await reader.read(65536); chunk !== null; chunk = await reader.read(65536)) {
    produced += chunk.length;
    assert.equal(Buffer.compare(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length), zeros.subarray(0, chunk.length)), 0);
  }
  reader.close();
  assert.equal(produced, size);
});
