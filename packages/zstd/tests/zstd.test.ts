/** The zstd decoder (SG-R-CDC-05), checked against node:zlib's zstd encoder and decoder. */

import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import zlib from "node:zlib";
import { Decoder, InvalidOptionError, SpillgateError, type Limits } from "spillgate";
import { data, zstdHeader, zstdRawBlocks, zstdRleBlocks, zstdSkippable, zstdStored, zstdZeros } from "spillgate-test-support";
import { codec, DEFAULT_MAX_WINDOW } from "../src/index.js";
import { XXH64 } from "../src/xxhash64.js";

// The reference encoder (zlib.zstd*) exists from Node 22.15; older Node runs only the package tests elsewhere.
const test = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function" ? nodeTest : nodeTest.skip;

const LOOSE: Limits = { maxOutput: 2 ** 30, disableRatioLimit: true };
const MIB = 2 ** 20;

const decoder = (limits: Limits = LOOSE, maxWindowBytes?: number): Decoder =>
  new Decoder(limits, { codecs: { zstd: codec(maxWindowBytes === undefined ? {} : { maxWindowBytes }) } });

async function run(stream: Uint8Array, limits: Limits = LOOSE, maxWindowBytes?: number): Promise<[string, Buffer]> {
  const out: Buffer[] = [];
  let reader;
  try {
    reader = decoder(limits, maxWindowBytes).reader(stream, "zstd");
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

const compress = (payload: Uint8Array, level = 3, params: Record<number, number> = {}): Buffer =>
  zlib.zstdCompressSync(payload, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level, ...params } });

/** What the reference decoder makes of a stream: its output, or undefined if it refuses. */
const oracle = (stream: Uint8Array): Buffer | undefined => {
  try {
    return zlib.zstdDecompressSync(stream);
  } catch {
    return undefined;
  }
};

const TEXT = Buffer.from("the quick brown fox jumps over the lazy dog. ".repeat(3000));
const NOISE = Buffer.from(data(5, 70_000));
const MIXED = Buffer.concat([TEXT.subarray(0, 20_000), NOISE, Buffer.alloc(100_000), TEXT]);
const PAYLOADS: [string, Buffer][] = [["empty", Buffer.alloc(0)], ["one byte", Buffer.from("a")], ["text", TEXT], ["noise", NOISE], ["zeros", Buffer.alloc(300_000)], ["mixed", MIXED]];

test("Covers: SG-R-CDC-05 SG-R-RDR-01 - round trip with the reference encoder at every level", async () => {
  for (const [name, payload] of PAYLOADS) {
    for (const level of [1, 2, 3, 5, 9, 12, 15, 19, 22]) {
      for (const checksum of [0, 1]) {
        const stream = compress(payload, level, { [zlib.constants.ZSTD_c_checksumFlag]: checksum });
        assert.deepEqual(await run(stream), ["ok", payload], `${name} level ${level} checksum ${checksum}`);
      }
    }
  }
});

test("Covers: SG-R-CDC-05 - every compression strategy and window of the reference encoder decodes", async () => {
  for (const strategy of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const windowLog of [10, 12, 15, 17, 20, 23]) {
      const stream = compress(MIXED, 6, { [zlib.constants.ZSTD_c_strategy]: strategy, [zlib.constants.ZSTD_c_windowLog]: windowLog });
      assert.deepEqual(await run(stream, LOOSE, 2 ** 24), ["ok", MIXED], `strategy ${strategy} window ${windowLog}`);
    }
  }
});

test("Covers: SG-R-CDC-05 - frames without content size, with content size, with long-distance matching", async () => {
  for (const params of [{ [zlib.constants.ZSTD_c_contentSizeFlag]: 0 }, { [zlib.constants.ZSTD_c_contentSizeFlag]: 1 }, { [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1, [zlib.constants.ZSTD_c_windowLog]: 23 }]) {
    assert.deepEqual(await run(compress(MIXED, 5, params), LOOSE, 2 ** 24), ["ok", MIXED], JSON.stringify(params));
  }
});

test("Covers: SG-R-CDC-05 - the content checksum hash agrees with the reference (XXH64, many sizes)", async () => {
  const empty = new XXH64();
  assert.equal(empty.digest32(), 0x51d8e999); // XXH64("") = 0xEF46DB3751D8E999, the low 32 bits
  for (const size of [0, 1, 3, 4, 7, 8, 9, 31, 32, 33, 63, 64, 65, 100, 1000, 4097, 131072, 131073, 300000]) {
    const payload = Buffer.from(data(size, size));
    const stream = compress(payload, 3, { [zlib.constants.ZSTD_c_checksumFlag]: 1 });
    assert.deepEqual(await run(stream), ["ok", payload], `size ${size}`);
  }
});

test("Covers: SG-R-CDC-05 - a damaged content checksum is corrupt", async () => {
  const stream = Buffer.from(compress(TEXT, 3, { [zlib.constants.ZSTD_c_checksumFlag]: 1 }));
  stream[stream.length - 1] = (stream[stream.length - 1] as number) ^ 1;
  assert.equal((await run(stream))[0], "corrupt");
});

test("Covers: SG-R-LAY-07 SG-R-CDC-05 - output beyond maxOutput comes before a bad checksum, exactly maxOutput then a bad checksum is corrupt", async () => {
  const stream = Buffer.from(compress(TEXT, 3, { [zlib.constants.ZSTD_c_checksumFlag]: 1 }));
  stream[stream.length - 1] = (stream[stream.length - 1] as number) ^ 1;
  const [kind, got] = await run(stream, { maxOutput: 100, disableRatioLimit: true });
  assert.deepEqual([kind, got.length], ["output_limit", 100]);
  const [kind2, got2] = await run(stream, { maxOutput: TEXT.length, disableRatioLimit: true });
  assert.equal(kind2, "corrupt");
  assert.ok(got2.equals(TEXT));
});

test("Covers: SG-R-CDC-05 SG-R-CDC-07 - the window cap is exact at every power of two", async () => {
  for (let windowLog = 10; windowLog <= 27; windowLog++) {
    const cap = 2 ** windowLog;
    const frame = zstdZeros(1000, windowLog);
    assert.equal((await run(frame, LOOSE, cap))[0], "ok", `window 2^${windowLog}`);
    if (windowLog > 10) assert.equal((await run(frame, LOOSE, cap - 1))[0], "memory_limit", `window 2^${windowLog} against ${cap - 1}`);
  }
});

test("Covers: SG-R-CDC-05 - windows with a mantissa are checked too", async () => {
  const frame = Buffer.concat([zstdHeader({ windowLog: 20, mantissa: 3 }), zstdRawBlocks(Buffer.from("abc"), 3, true)]);
  const window = 2 ** 20 + (2 ** 20 / 8) * 3;
  assert.equal((await run(frame, LOOSE, window))[0], "ok");
  assert.equal((await run(frame, LOOSE, window - 1))[0], "memory_limit");
});

test("Covers: SG-R-CDC-05 SG-R-CDC-07 SG-I-04 - single segment frames: the window is the declared content size, in every size form", async () => {
  for (const size of [0, 1, 255, 256, 300, 65791, 65792, 70_000, 2 ** 32 - 1, 2 ** 32, 2 ** 40]) {
    const frame = Buffer.concat([zstdHeader({ singleSegment: true, contentSize: size }), zstdRawBlocks(Buffer.from("x"), 1, true)]);
    const cap = Math.min(Math.max(size, 1024), 2 ** 30);
    assert.ok(["ok", "corrupt", "memory_limit"].includes((await run(frame, LOOSE, cap))[0]), String(size));
    if (size > DEFAULT_MAX_WINDOW) assert.equal((await run(frame))[0], "memory_limit", String(size));
    if (size >= 2048 && size <= 2 ** 30) assert.equal((await run(frame, LOOSE, size - 1))[0], "memory_limit", String(size));
  }
});

test("Covers: SG-R-CDC-05 SG-I-04 SG-R-MEM-01 - a hostile header allocates nothing before it is refused", async () => {
  const frame = Buffer.concat([zstdHeader({ singleSegment: true, contentSize: 2 ** 40 }), Buffer.alloc(20)]);
  const before = process.memoryUsage().arrayBuffers;
  assert.equal((await run(frame))[0], "memory_limit");
  assert.ok(process.memoryUsage().arrayBuffers - before < 1_000_000);
});

test("Covers: SG-R-CDC-05 - dictionaries, the reserved bit, reserved and oversized blocks are corrupt", async () => {
  const body = zstdRawBlocks(Buffer.from("abc"), 3, true);
  const frame = (fields: Parameters<typeof zstdHeader>[0]): Buffer => Buffer.concat([zstdHeader({ windowLog: 17, ...fields }), body]);
  assert.equal((await run(frame({ dictionaryId: 1 })))[0], "corrupt");
  assert.equal((await run(frame({ dictionaryId: 0 })))[0], "ok");
  assert.equal((await run(frame({ reservedBit: true })))[0], "corrupt");
  assert.equal((await run(Buffer.concat([zstdHeader({ windowLog: 17 }), Buffer.from([0b0000_0111, 0, 0])])))[0], "corrupt");
  assert.equal((await run(Buffer.concat([zstdHeader({ windowLog: 17 }), Buffer.from([((129 * 1024) << 3 | 1) & 0xff, 0x04, 0x10]), Buffer.alloc(10)])))[0], "corrupt");
  // a block larger than the window (window 1 KiB, block 2 KiB)
  assert.equal((await run(Buffer.concat([zstdHeader({ windowLog: 10 }), zstdRawBlocks(Buffer.alloc(2048), 2048, true)])))[0], "corrupt");
});

test("Covers: SG-R-LAY-02 SG-R-MEM-02 SG-I-08 - a 1 GiB bomb ends in output_limit with constant memory", async () => {
  const bomb = zstdZeros(2 ** 30, 23); // 1 GiB of zeros in 32 KiB
  const reader = decoder({ maxOutput: 64 * MIB, disableRatioLimit: true }).reader(bomb, "zstd");
  let delivered = 0;
  const before = process.memoryUsage().rss;
  await assert.rejects(async () => { for (let c = await reader.read(MIB); c !== null; c = await reader.read(MIB)) delivered += c.length; }, (e: SpillgateError) => e.kind === "output_limit");
  reader.close();
  assert.equal(delivered, 64 * MIB);
  assert.ok(process.memoryUsage().rss - before < 100 * MIB);
});

test("Covers: SG-R-RAT-01 - the ratio limit fires on a zstd bomb", async () => {
  assert.equal((await run(zstdZeros(2 ** 30, 23), { maxOutput: 2 ** 31 }))[0], "ratio_limit");
});

test("Covers: SG-R-CDC-06 - every truncation is corrupt", async () => {
  for (const stream of [compress(Buffer.concat([TEXT.subarray(0, 4000), NOISE.subarray(0, 4000)]), 3, { [zlib.constants.ZSTD_c_checksumFlag]: 1 }), zstdStored(Buffer.from(data(1, 600)), 17)]) {
    for (let cut = 0; cut < stream.length; cut++) assert.equal((await run(stream.subarray(0, cut)))[0], "corrupt", String(cut));
  }
});

test("Covers: SG-I-05 SG-R-CDC-08 - every bit flip: never a foreign error, and never data the reference would not produce", async () => {
  const stream = compress(Buffer.from("flip every bit of this zstd frame, with repeats, repeats, repeats. ".repeat(5)), 5, { [zlib.constants.ZSTD_c_checksumFlag]: 1 });
  for (let position = 0; position < stream.length; position++) {
    for (let bit = 0; bit < 8; bit++) {
      const damaged = Buffer.from(stream);
      damaged[position] = (damaged[position] as number) ^ (1 << bit);
      const [kind, out] = await run(damaged);
      assert.ok(["ok", "corrupt", "memory_limit", "output_limit"].includes(kind), `${position}:${bit} ${kind}`);
      if (kind === "ok") {
        const expected = oracle(damaged);
        assert.ok(expected !== undefined && expected.equals(out), `${position}:${bit} accepted a stream the reference refuses or decodes differently`);
      }
    }
  }
});

test("Covers: SG-I-05 SG-R-CDC-08 - random mutations of compressed frames agree with the reference", async () => {
  let seed = 12345;
  const next = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
  const rounds = Number(process.env["SPILLGATE_FUZZ_ROUNDS"] ?? 300);
  for (let i = 0; i < rounds; i++) {
    const base = [TEXT.subarray(0, 3000), MIXED.subarray(0, 8000), NOISE.subarray(0, 2000), Buffer.alloc(5000)][i % 4] as Buffer;
    const stream = Buffer.from(compress(base, 1 + (i % 12), { [zlib.constants.ZSTD_c_checksumFlag]: i % 2 }));
    for (let flips = 1 + Math.floor(next() * 4); flips > 0; flips--) stream[Math.floor(next() * stream.length)] = Math.floor(next() * 256);
    const damaged = next() < 0.2 ? stream.subarray(0, Math.floor(next() * stream.length)) : stream;
    const [kind, out] = await run(damaged, { maxOutput: 2 ** 24, disableRatioLimit: true });
    assert.ok(["ok", "corrupt", "memory_limit", "output_limit"].includes(kind), kind);
    if (kind === "ok") {
      const expected = oracle(damaged);
      assert.ok(expected !== undefined && expected.equals(out), `round ${i}: accepted what the reference refuses or decodes differently`);
    }
  }
});

test("Covers: SG-R-CDC-05 - concatenated and skippable frames share one budget", async () => {
  const a = compress(Buffer.from("first "));
  const b = compress(Buffer.from("second"));
  assert.deepEqual(await run(Buffer.concat([a, b])), ["ok", Buffer.from("first second")]);
  const skip = zstdSkippable(5);
  assert.deepEqual(await run(Buffer.concat([skip, a, skip, b, skip])), ["ok", Buffer.from("first second")]);
  const [kind, got] = await run(Buffer.concat([a, b]), { maxOutput: 8, disableRatioLimit: true });
  assert.deepEqual([kind, got.toString()], ["output_limit", "first se"]);
});

test("Covers: SG-R-CDC-05 SG-R-RAT-02 - many skippable frames are cheap", async () => {
  const stream = Buffer.concat([...Array<Buffer>(20_000).fill(Buffer.from(zstdSkippable(0))), compress(Buffer.from("end"))]);
  const started = performance.now();
  assert.deepEqual(await run(stream, { maxOutput: 100, disableRatioLimit: true }), ["ok", Buffer.from("end")]);
  assert.ok(performance.now() - started < 10_000);
});

test("Covers: SG-R-CDC-05 - data after the last frame is corrupt, an empty input too", async () => {
  const stream = compress(TEXT);
  for (const tail of [[0], [1, 2, 3], [0x28, 0xb5, 0x2f], [0x50, 0x2a, 0x4d, 0x18], Array(100).fill(0)]) {
    assert.equal((await run(Buffer.concat([stream, Buffer.from(tail)])))[0], "corrupt", String(tail));
  }
  assert.equal((await run(Buffer.alloc(0)))[0], "corrupt");
});

test("Covers: SG-R-CDC-07 SG-I-04 - a lying content size never raises an allowance and is checked at the end", async () => {
  const real = Buffer.alloc(1000, 120);
  const big = Buffer.concat([zstdHeader({ windowLog: 17, contentSize: 2 ** 40 }), zstdRawBlocks(real, 1000, true)]);
  const [kind, got] = await run(big, { maxOutput: 100, disableRatioLimit: true });
  assert.ok(kind === "output_limit" && got.length === 100, `${kind} ${got.length}`);
  assert.equal((await run(big))[0], "corrupt"); // 1000 produced, 2**40 declared
  const small = Buffer.concat([zstdHeader({ singleSegment: true, contentSize: 10 }), zstdRawBlocks(real, 1000, true)]);
  assert.equal((await run(small))[0], "corrupt");
});

test("Covers: SG-R-CDC-05 - an empty last block cannot hide a content size mismatch", async () => {
  const frame = Buffer.concat([zstdHeader({ singleSegment: true, contentSize: 128 }), Buffer.from([0x01, 0x00, 0x00])]);
  assert.equal((await run(frame))[0], "corrupt");
});

test("Covers: SG-R-CDC-05 - RLE and raw blocks inside a frame, and a compressed block of size zero", async () => {
  const frame = Buffer.concat([zstdHeader({ windowLog: 17 }), zstdRleBlocks(200_000, 131072, 7, false), zstdRawBlocks(Buffer.from("tail"), 131072, true)]);
  const [kind, out] = await run(frame);
  assert.equal(kind, "ok");
  assert.equal(out.length, 200_004);
  assert.ok(out.subarray(0, 200_000).every((b) => b === 7) && out.subarray(200_000).toString() === "tail");
  assert.equal((await run(Buffer.concat([zstdHeader({ windowLog: 17 }), Buffer.from([0x05, 0x00, 0x00])])))[0], "corrupt"); // type 2, size 0, last
});

test("Covers: SG-R-RDR-01 SG-I-09 - read sizes and source chunking do not change the result", async () => {
  const stream = compress(MIXED, 6, { [zlib.constants.ZSTD_c_checksumFlag]: 1 });
  for (const size of [1, 7, 4096, 1 << 20]) {
    const r = decoder(LOOSE, 2 ** 24).reader(stream, "zstd");
    const parts: Uint8Array[] = [];
    for (let c = await r.read(size); c !== null; c = await r.read(size)) {
      parts.push(c);
      if (size === 1 && parts.length > 3000) break;
    }
    assert.ok(MIXED.subarray(0, Buffer.concat(parts).length).equals(Buffer.concat(parts)), String(size));
  }
  for (const step of [1, 3, 100, 4096]) {
    let pos = 0;
    const source = { read: (max: number) => { if (pos >= stream.length) return null; const c = stream.subarray(pos, pos + Math.min(max, step)); pos += c.length; return c; } };
    assert.ok(Buffer.from(await decoder(LOOSE, 2 ** 24).readAll(source, "zstd")).equals(MIXED), `step ${step}`);
  }
});

test("Covers: SG-R-INP-01 SG-R-INP-02 - the input limit counts what the decoder takes", async () => {
  const stream = compress(TEXT);
  assert.equal((await run(stream, { ...LOOSE, maxInput: stream.length }))[0], "ok");
  assert.equal((await run(stream, { ...LOOSE, maxInput: stream.length - 1 }))[0], "input_limit");
});

test("Covers: SG-R-LAY-01 SG-R-HDR-12 - chains with zstd", async () => {
  const d = decoder(LOOSE, 2 ** 24);
  assert.deepEqual(Buffer.from(await d.readAll(zlib.gzipSync(compress(TEXT)), "zstd, gzip")), TEXT);
  assert.deepEqual(Buffer.from(await d.readAll(compress(zlib.gzipSync(TEXT)), "gzip, zstd")), TEXT);
});

test("Covers: SG-R-CDC-09 - cap settings are validated", () => {
  for (const bad of [0, 1023, 2 ** 30 + 1, -1, 1.5, NaN, "8"]) assert.throws(() => codec({ maxWindowBytes: bad as number }), InvalidOptionError, String(bad));
  assert.ok(codec({ maxWindowBytes: 1024 }) && codec({ maxWindowBytes: 2 ** 30 }));
});

test("Covers: SG-R-RAT-02 SG-R-MEM-02 - frames without output cost bounded CPU per input byte", async () => {
  const frame = Buffer.concat([zstdHeader({ windowLog: 23 }), zstdRawBlocks(Buffer.alloc(0), 1024, true)]);
  const stream = Buffer.concat(Array<Buffer>(20_000).fill(frame));
  const started = performance.now();
  assert.deepEqual(await run(stream, { maxOutput: 100, disableRatioLimit: true }), ["ok", Buffer.alloc(0)]);
  assert.ok(performance.now() - started < 10_000, `${performance.now() - started} ms`);
  assert.equal((await run(stream, { maxOutput: 100, disableRatioLimit: true, maxInput: stream.length >> 1 }))[0], "input_limit");
});

test("Covers: SG-R-CDC-05 - a block as large as the window keeps the ring consistent for later matches", async () => {
  // Found by the independent review: after a block of exactly the window size the write position must be 0.
  const blockHeader = (last: number, type: number, size: number): Buffer => {
    const v = (size << 3) | (type << 1) | last;
    return Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255]);
  };
  const big = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 13 + 7) & 255));
  const sequence = Buffer.from([0x00, 0x01, 0x00, 0, 0, 2]);
  const frame = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]), blockHeader(0, 0, 3), Buffer.from("XYZ"), blockHeader(0, 0, 1024), big, blockHeader(1, 2, sequence.length), sequence]);
  const [kind, out] = await run(frame);
  assert.equal(kind, "ok");
  assert.ok(out.equals(zlib.zstdDecompressSync(frame)));
});

test("Covers: SG-R-RAT-02 SG-R-MEM-02 - compressed blocks with tiny output do not cost a full block each", async () => {
  const block = Buffer.from(compress(Buffer.from("abcabcabc")));
  const stream = Buffer.concat(Array<Buffer>(30_000).fill(block));
  const started = performance.now();
  const [kind] = await run(stream, { maxOutput: 2 ** 30, disableRatioLimit: true });
  assert.equal(kind, "ok");
  assert.ok(performance.now() - started < 10_000, `${performance.now() - started} ms`);
});

test("Covers: SG-R-CDC-05 - a compressed block without sequences must end after the count byte", async () => {
  // Found by the differential bit-flip test of the Rust port: libzstd refuses trailing bytes here.
  const blockHeader = (last: number, type: number, size: number): Buffer => {
    const v = (size << 3) | (type << 1) | last;
    return Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255]);
  };
  const literals = Buffer.concat([Buffer.from([(3 << 3) | 0]), Buffer.from("abc")]); // raw literals, size 3
  const build = (tail: number[]): Buffer => {
    const body = Buffer.concat([literals, Buffer.from([0x00, ...tail])]);
    return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58]), blockHeader(1, 2, body.length), body]);
  };
  assert.deepEqual(await run(build([])), ["ok", Buffer.from("abc")]);
  assert.equal((await run(build([0x01])))[0], "corrupt");
  assert.equal((await run(build([0, 0, 0])))[0], "corrupt");
  assert.equal(oracle(build([0x01])), undefined);
});

test("Covers: SG-R-CDC-05 - a Huffman tree without two weight-one symbols is corrupt", async () => {
  // Found by the review of the Rust port: weights [2,2,3]; libzstd refuses the frame.
  const frame = Buffer.from("28b52ffd00003d000042c00081226300", "hex");
  assert.equal(oracle(frame), undefined);
  assert.equal((await run(frame))[0], "corrupt");
});
