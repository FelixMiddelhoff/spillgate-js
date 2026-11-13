/** The brotli codec (SG-R-CDC-04). */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import zlib from "node:zlib";
import { Decoder, InvalidOptionError, SpillgateError, type Limits } from "spillgate";
import { brotliLargeWindowPrefix, brotliStored, brotliZeros, data } from "spillgate-test-support";
import { createRequire } from "node:module";
import * as originalWasm from "brotli-dec-wasm/web";
import { hostileBlockTypes, hostileBrotli } from "./hostile.js";
import { DEFAULT_MAX_WINDOW_BITS, MIN_WINDOW_BITS, codec, initBrotli, windowBits } from "../src/index.js";

await initBrotli();

// The original decoder, the reference of the relative timing test: decode a whole stream once.
const requireHere = createRequire(import.meta.url);
originalWasm.initSync({ module: readFileSync(requireHere.resolve("brotli-dec-wasm/web/bg.wasm")) });
async function originalOnce(stream: Uint8Array): Promise<number> {
  const started = performance.now();
  const decoder = new originalWasm.DecompressStream();
  const result = decoder.decompress(stream, 65536);
  assert.equal(result.code, originalWasm.BrotliStreamResultCode.ResultSuccess);
  result.free();
  decoder.free();
  return performance.now() - started;
}

const LOOSE: Limits = { maxOutput: 2 ** 30, disableRatioLimit: true };
const DATA = Buffer.from(Array.from({ length: 10240 }, (_, i) => i & 255));

const decoder = (limits: Limits = LOOSE, maxWindowBits?: number): Decoder =>
  new Decoder(limits, { codecs: { br: codec(maxWindowBits === undefined ? {} : { maxWindowBits }) } });

async function run(stream: Uint8Array, encodings = "br", limits: Limits = LOOSE, maxWindowBits?: number): Promise<[string, Buffer]> {
  const out: Buffer[] = [];
  let reader;
  try {
    reader = decoder(limits, maxWindowBits).reader(stream, encodings);
  } catch (error) {
    if (error instanceof SpillgateError) return [error.kind, Buffer.alloc(0)];
    throw error;
  }
  try {
    for (let chunk = await reader.read(4096); chunk !== null; chunk = await reader.read(4096)) out.push(Buffer.from(chunk));
    return ["ok", Buffer.concat(out)];
  } catch (error) {
    if (error instanceof SpillgateError) return [error.kind, Buffer.concat(out)];
    throw error;
  } finally {
    reader.close();
  }
}

const compress = (payload: Uint8Array, quality = 5, lgwin = 22): Buffer =>
  zlib.brotliCompressSync(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin } });

test("Covers: SG-R-CDC-04 SG-R-RDR-01 - round trip with the reference encoder", async () => {
  for (const quality of [0, 1, 5, 9, 11]) {
    for (const payload of [Buffer.alloc(0), Buffer.from("a"), DATA, Buffer.alloc(100_000), Buffer.from(data(5, 70_000))]) {
      assert.deepEqual(await run(compress(payload, quality)), ["ok", payload], `${quality}/${payload.length}`);
    }
  }
});

test("Covers: SG-R-CDC-04 - the window bits table (RFC 7932 section 9.1)", () => {
  assert.deepEqual(windowBits(0b0), { bits: 16, largeWindow: false });
  for (let n = 1; n < 8; n++) assert.deepEqual(windowBits(1 | (n << 1)), { bits: 17 + n, largeWindow: false });
  assert.deepEqual(windowBits(0b0000_0001), { bits: 17, largeWindow: false });
  assert.deepEqual(windowBits(0b0001_0001), { bits: 0, largeWindow: true });
  for (let m = 2; m < 8; m++) assert.deepEqual(windowBits(1 | (m << 4)), { bits: 8 + m, largeWindow: false });
});

test("Covers: SG-R-CDC-04 SG-R-CDC-07 - the window cap is exact for every size", async () => {
  for (let wbits = MIN_WINDOW_BITS; wbits <= DEFAULT_MAX_WINDOW_BITS; wbits++) {
    const stream = brotliStored(DATA.subarray(0, 300), wbits);
    assert.deepEqual(await run(stream, "br", LOOSE, wbits), ["ok", DATA.subarray(0, 300)], `window ${wbits}`);
    if (wbits > MIN_WINDOW_BITS) assert.equal((await run(stream, "br", LOOSE, wbits - 1))[0], "memory_limit", `window ${wbits} against cap ${wbits - 1}`);
  }
});

test("Covers: SG-R-CDC-04 - the large-window marker is memory_limit whatever the cap", async () => {
  for (const cap of [10, 17, 24]) {
    assert.equal((await run(Buffer.concat([brotliLargeWindowPrefix(), Buffer.alloc(50)]), "br", LOOSE, cap))[0], "memory_limit");
  }
  // a real large-window stream from the reference encoder (lgwin 30), 300 MiB of zeros in a few hundred bytes
  const real = zlib.brotliCompressSync(Buffer.alloc(300 * 2 ** 20), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_LARGE_WINDOW]: 1, [zlib.constants.BROTLI_PARAM_LGWIN]: 30 },
  });
  assert.ok(real.length < 1000, `the stream is ${real.length} bytes`);
  assert.equal((await run(real))[0], "memory_limit");
});

test("Covers: SG-R-CDC-04 SG-R-CDC-07 SG-I-04 - a hostile window is refused before anything is decoded", async () => {
  let reads = 0;
  const source = { read: (max: number) => { reads++; return reads === 1 ? brotliZeros(2 ** 30, 24).subarray(0, max) : null; } };
  await assert.rejects(decoder(LOOSE, 16).readAll(source, "br"), (e: SpillgateError) => e.kind === "memory_limit");
  assert.equal(reads, 1);
});

test("Covers: SG-R-CDC-09 - cap settings are validated", () => {
  for (const bad of [9, 25, 0, -1, 16.5, NaN, "16", true]) assert.throws(() => codec({ maxWindowBits: bad as number }), InvalidOptionError, String(bad));
  assert.ok(codec({ maxWindowBits: 10 }) && codec({ maxWindowBits: 24 }));
});

test("Covers: SG-R-LAY-02 SG-R-MEM-02 SG-I-08 - a 1 GiB bomb ends in output_limit with constant memory", async () => {
  const bomb = brotliZeros(2 ** 30, 24); // 1 GiB of zeros in 809 bytes
  const before = process.memoryUsage().rss;
  const reader = decoder({ maxOutput: 64 * 2 ** 20, disableRatioLimit: true }).reader(bomb, "br");
  let delivered = 0;
  await assert.rejects(async () => { for (let c = await reader.read(1 << 20); c !== null; c = await reader.read(1 << 20)) delivered += c.length; }, (e: SpillgateError) => e.kind === "output_limit");
  reader.close();
  assert.equal(delivered, 64 * 2 ** 20);
  assert.ok(process.memoryUsage().rss - before < 120 * 2 ** 20, "the 16 MiB window is the only thing that grows");
});

test("Covers: SG-R-RAT-01 SG-R-CDC-01 - the ratio limit fires on a brotli bomb", async () => {
  assert.equal((await run(brotliZeros(2 ** 30, 24), "br", { maxOutput: 2 ** 31 }))[0], "ratio_limit");
});

test("Covers: SG-R-RDR-06 SG-I-10 - repeated decodes do not leak WebAssembly memory", async () => {
  const bomb = brotliZeros(2 ** 28, 24);
  const reps = async (n: number): Promise<number> => {
    for (let i = 0; i < n; i++) {
      const r = decoder({ maxOutput: 8 * 2 ** 20, disableRatioLimit: true }).reader(bomb, "br");
      await assert.rejects(async () => { while (await r.read(1 << 20)) { /* drain */ } }, SpillgateError);
      r.close();
    }
    return process.memoryUsage().rss;
  };
  await reps(3); // let the module reach its working size
  const base = await reps(1);
  const after = await reps(25);
  assert.ok(after - base < 64 * 2 ** 20, `rss grew by ${(after - base) / 2 ** 20} MiB over 25 decodes`);
});

test("Covers: SG-R-CDC-06 - every truncation is corrupt", async () => {
  const stream = compress(DATA);
  for (let cut = 0; cut < stream.length; cut++) assert.equal((await run(stream.subarray(0, cut)))[0], "corrupt", String(cut));
});

test("Covers: SG-I-05 SG-R-CDC-08 - every bit flip is ok or a typed error", async () => {
  const stream = compress(Buffer.from("flip every bit of this brotli stream ".repeat(8)));
  for (let position = 0; position < stream.length; position++) {
    for (let bit = 0; bit < 8; bit++) {
      const damaged = Buffer.from(stream);
      damaged[position] = (damaged[position] as number) ^ (1 << bit);
      const [kind] = await run(damaged);
      assert.ok(["ok", "corrupt", "memory_limit"].includes(kind), `${position}:${bit} ${kind}`);
    }
  }
});

test("Covers: SG-R-CDC-04 - bytes after the last meta-block are corrupt", async () => {
  const stream = compress(DATA);
  for (const tail of [[0], Array(100).fill(120), Array(5000).fill(0)]) {
    assert.equal((await run(Buffer.concat([stream, Buffer.from(tail)])))[0], "corrupt");
  }
});

test("Covers: SG-R-LAY-01 SG-R-HDR-12 - chains with brotli", async () => {
  assert.deepEqual(await run(zlib.gzipSync(compress(DATA)), "br, gzip"), ["ok", DATA]);
  assert.deepEqual(await run(compress(zlib.gzipSync(DATA)), "gzip, br"), ["ok", DATA]);
});

test("Covers: SG-R-RDR-01 SG-I-09 - read sizes and source chunking do not change the result", async () => {
  const payload = Buffer.concat(Array(20).fill(DATA));
  const stream = compress(payload, 4);
  for (const size of [1, 7, 4096, 1 << 20]) {
    const r = decoder().reader(stream, "br");
    const parts: Uint8Array[] = [];
    for (let c = await r.read(size); c !== null; c = await r.read(size)) {
      parts.push(c);
      if (size === 1 && parts.length > 3000) break;
    }
    assert.ok(payload.subarray(0, Buffer.concat(parts).length).equals(Buffer.concat(parts)), String(size));
  }
  for (const step of [1, 3, 100, 4096]) {
    let pos = 0;
    const source = { read: (max: number) => { if (pos >= stream.length) return null; const c = stream.subarray(pos, pos + Math.min(max, step)); pos += c.length; return c; } };
    assert.ok(Buffer.from(await decoder().readAll(source, "br")).equals(payload), `step ${step}`);
  }
});

test("Covers: SG-R-INP-01 SG-R-INP-02 - the input limit counts what the decoder takes", async () => {
  const stream = compress(DATA);
  const n = stream.length;
  assert.equal((await run(stream, "br", { ...LOOSE, maxInput: n }))[0], "ok");
  assert.equal((await run(stream, "br", { ...LOOSE, maxInput: n - 1 }))[0], "input_limit");
});

test("Covers: SG-R-HDR-08 SG-I-06 - a decoder without the codec refuses br as unsupported", async () => {
  await assert.rejects(new Decoder(LOOSE).readAll(compress(DATA), "br"), (e: SpillgateError) => e.kind === "unsupported_encoding");
});

test("Covers: SG-I-04 - no runtime dependency; the original decoder (differential reference) is pinned to an exact version", () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies, undefined, "the WebAssembly decoder is built from rust/, nothing is installed at runtime");
  assert.match(pkg.devDependencies["brotli-dec-wasm"] as string, /^\d+\.\d+\.\d+$/, "no range: the exact audited version");
});

test("Covers: SG-R-CDC-09 - the codec needs initBrotli first", async () => {
  // a fresh module instance has not been initialized
  const fresh = await import(`../src/index.js?fresh=${Date.now()}`);
  assert.throws(() => fresh.codec(), InvalidOptionError);
});

test("Covers: SG-R-RDR-01 SG-I-09 - a source error late in the stream gives the same prefix for every read size and source chunking", async () => {
  const stream = compress(Buffer.from(data(9, 60_000)));
  const outer = zlib.gzipSync(stream);
  for (const [encodings, bytes] of [["br", stream], ["br, gzip", outer]] as const) {
    for (const fraction of [0.4, 0.95]) {
      const failAt = Math.floor(bytes.length * fraction);
      const results = new Set<string>();
      for (const readSize of [1, 5, 4096, 1 << 20]) {
        for (const step of [3, 700, 70_000]) {
          if (readSize === 1 && failAt > 6_000) continue; // keep the run time sane
          let pos = 0;
          const source = { read: (max: number) => {
            if (pos >= failAt) throw new Error("boom");
            const end = Math.min(pos + Math.min(max, step), failAt);
            const chunk = bytes.subarray(pos, end);
            pos = end;
            return chunk;
          } };
          const reader = decoder().reader(source, encodings);
          const parts: Buffer[] = [];
          let kind = "ok";
          try {
            for (let c = await reader.read(readSize); c !== null; c = await reader.read(readSize)) parts.push(Buffer.from(c));
          } catch (error) {
            kind = error instanceof SpillgateError ? error.kind : "foreign";
          } finally {
            reader.close();
          }
          const all = Buffer.concat(parts);
          results.add(`${kind}:${all.length}:${zlib.crc32(all)}`);
        }
      }
      assert.equal(results.size, 1, `${encodings} @${fraction}: ${[...results].join(" | ")}`);
      assert.match([...results][0] as string, /^source_error:/);
    }
  }
});

test("Covers: SG-R-CDC-04 SG-R-LAY-02 - CPU of many tiny hostile meta-blocks with 256 literal and 256 distance prefix codes each stays linear and below the original decoder (F3)", async () => {
  // 4000 meta-blocks of one byte each, 716 input bytes each (2.9 MB in all). The original decoder
  // (brotli-dec-wasm 2.3.2) allocated and cleared 1.1 MB of table memory per meta-block: 1.59 s,
  // about 555 ns per input byte. The fork keeps the table memory between meta-blocks: 0.66 s,
  // about 230 ns per input byte (best of three on the author's machine, 2026-11-12, no wasm-opt).
  // What is left is the work of reading the trees themselves, linear in the input. Neither the
  // ratio nor the output limit bounds it (4000 bytes out); only maxInput and the caller's
  // AbortSignal do.
  const stream = hostileBrotli(4000, "single", true);
  assert.deepEqual(Buffer.from(zlib.brotliDecompressSync(stream)), Buffer.alloc(4000, 0x41), "the stream is valid");
  const limits: Limits = { maxOutput: 1 << 20, disableRatioLimit: true };
  // Fork and original are timed alternately (5 rounds after one warm-up round of each) and the
  // best of each side is compared, so a noisy shared runner slows both sides alike and a single
  // slow run cannot decide. Costs about 5 x (0.7 s + 1.6 s) + warm-up = about 14 s on the author's machine.
  const once = async (): Promise<number> => {
    const started = performance.now();
    const [kind, out] = await run(stream, "br", limits);
    const elapsed = performance.now() - started;
    assert.deepEqual([kind, out.length], ["ok", 4000]);
    return elapsed;
  };
  await once();
  await originalOnce(stream);
  let ms = Infinity;
  let originalMs = Infinity;
  for (let i = 0; i < 5; i++) {
    ms = Math.min(ms, await once());
    originalMs = Math.min(originalMs, await originalOnce(stream));
  }
  const nsPerByte = (ms * 1e6) / stream.length;
  // absolute: 2.5 times the measurement (the unpatched build measures 555 ns per byte here)
  assert.ok(nsPerByte < 600, `${ms.toFixed(0)} ms for ${stream.length} input bytes (${nsPerByte.toFixed(0)} ns per byte)`);
  // relative to the original decoder in the same process: at least 1.5 times faster (measured 2.4)
  assert.ok(ms * 1.5 < originalMs, `fork ${ms.toFixed(0)} ms, original ${originalMs.toFixed(0)} ms`);
  // linear: a quarter of the stream costs about a quarter (generous factor 2 for noise and warm-up)
  const quarter = hostileBrotli(1000, "single", true);
  const quarterStarted = performance.now();
  await run(quarter, "br", limits);
  const quarterMs = performance.now() - quarterStarted;
  assert.ok(quarterMs * 4 < ms * 2 + 100, `quarter ${quarterMs.toFixed(0)} ms, whole ${ms.toFixed(0)} ms`);
  // maxInput bounds it: the same stream with a small cap stops early.
  assert.equal((await run(stream, "br", { ...limits, maxInput: 100_000 }))[0], "input_limit");
  // the ratio limit does not (output is tiny): documented, see docs/memory.md and the threat model
  assert.equal((await run(stream, "br", { maxOutput: 1 << 20 }))[0], "ok");
});

test("Covers: SG-R-CDC-04 SG-R-LAY-02 - meta-blocks with 256 literal block types (16 KiB context map each) cost no more per byte than the tree shape (F3)", async () => {
  // measured 130 ns per input byte, with and without the distance side (reusing the map memory
  // between meta-blocks was tried and measured no faster: the allocation is not the cost)
  for (const dist of [false, true]) {
    const stream = hostileBlockTypes(4000, dist);
    assert.equal(zlib.brotliDecompressSync(stream).length, 4000, "the stream is valid");
    const started = performance.now();
    const [kind, out] = await run(stream, "br", { maxOutput: 1 << 20, disableRatioLimit: true });
    const ns = ((performance.now() - started) * 1e6) / stream.length;
    assert.deepEqual([kind, out.length], ["ok", 4000]);
    assert.ok(ns < 600, `${ns.toFixed(0)} ns per input byte (dist ${dist})`);
  }
});
