/** JavaScript-specific traps (planning: spillgate-languages.md) and resource bounds (SPEC section 10). */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { Decoder, OutputLimitError, SpillgateError, decodeAll, reader } from "../src/index.js";
import { LOOSE, Trickle, gz, outcome } from "./helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");
const sources = readdirSync(SRC).filter((f) => f.endsWith(".js")).map((f) => ({ name: f, text: readFileSync(join(SRC, f), "utf8") }));

test("Covers: SG-I-04 SG-R-CDC-07 - no unbounded platform decompression API is used", () => {
  // node:zlib streams and DecompressionStream cannot bound the output of one write, cannot report
  // the input they used and treat bytes after the stream differently per engine; the convenience
  // methods only honor maxOutputLength for one-shot calls. spillgate decodes DEFLATE itself.
  const banned = [/node:zlib/, /from "zlib"/, /require\(["']zlib["']\)/, /DecompressionStream/, /CompressionStream/, /\.inflateSync/, /\.gunzipSync/, /\.brotliDecompress/, /\.zstdDecompress/, /maxOutputLength/];
  for (const { name, text } of sources) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const pattern of banned) assert.ok(!pattern.test(code), `${name}: ${String(pattern)}`);
  }
});

test("Covers: SG-I-04 - the package has no runtime dependencies and no side effects at import", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies?: object; sideEffects?: boolean };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.equal(pkg.sideEffects, false);
  for (const { name, text } of sources) {
    assert.ok(!/process\.(env|on)\b/.test(text), `${name} reads the environment`);
    assert.ok(!/globalThis\.\w+\s*=/.test(text), `${name} writes a global`);
  }
});

v8.setFlagsFromString("--expose-gc");
const collect = vm.runInNewContext("gc") as () => void;

/** Peak of used memory (heap plus array buffers) while `work` runs, sampled between reads. */
async function peak(work: (sample: () => void) => Promise<void>): Promise<number> {
  // Garbage that was not collected yet is not retained memory: collect before every sample, so the
  // number is what the decoder keeps alive (the collector is exposed with v8.setFlagsFromString; no command line flag is needed).
  const measure = () => {
    collect();
    return process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  };
  const before = measure();
  let high = before;
  await work(() => { high = Math.max(high, measure()); });
  return high - before;
}

test("Covers: SG-R-MEM-02 SG-I-08 - memory stays bounded while the bomb is far larger", async () => {
  const bomb = gz(Buffer.alloc(200_000_000)); // 200 MB decoded, 200 KB compressed
  const growth = await peak(async (sample) => {
    const r = reader(bomb, "gzip", { maxOutput: 100_000_000, disableRatioLimit: true });
    await assert.rejects(async () => { for (let c = await r.read(2 ** 40); c !== null; c = await r.read(2 ** 40)) sample(); }, OutputLimitError);
  });
  assert.ok(growth < 16 * 1024 * 1024, `grew by ${growth}`);
});

test("Covers: SG-R-MEM-02 SG-I-08 SG-R-RDR-01 - one-byte reads cost constant memory", async () => {
  const stream = gz(Buffer.alloc(300_000));
  const growth = await peak(async (sample) => {
    const r = reader(stream, "gzip", LOOSE);
    let n = 0;
    for (let c = await r.read(1); c !== null; c = await r.read(1)) if (++n % 4096 === 0) sample();
  });
  assert.ok(growth < 8 * 1024 * 1024, `grew by ${growth}`);
});

test("Covers: SG-R-CDC-07 SG-R-MEM-01 SG-I-04 - declared sizes do not size allocations", async () => {
  const liar = Buffer.from(gz(Buffer.from("small")));
  liar.writeUInt32LE(2 ** 32 - 1, liar.length - 4); // ISIZE claims 4 GiB
  const growth = await peak(async () => { assert.equal((await outcome(liar, "gzip"))[0], "corrupt"); });
  assert.ok(growth < 4 * 1024 * 1024, `grew by ${growth}`);
});

test("Covers: SG-R-MEM-02 - readAll grows with the output, not with maxOutput", async () => {
  const growth = await peak(async () => { assert.equal(Buffer.from(await decodeAll(gz(Buffer.from("tiny")), "gzip", { maxOutput: 2n ** 62n })).toString(), "tiny"); });
  assert.ok(growth < 4 * 1024 * 1024);
});

test("Covers: SG-R-MEM-02 - a huge read size is capped to one step", async () => {
  const r = reader(gz(Buffer.alloc(1_000_000)), "gzip", LOOSE);
  const chunk = (await r.read(2 ** 40)) as Uint8Array;
  assert.ok(chunk.length > 0 && chunk.length <= 256 * 1024);
  assert.equal((await r.readAll()).length, 1_000_000 - chunk.length);
  const fresh = reader(gz(Buffer.alloc(10)), "gzip", LOOSE);
  await assert.rejects(fresh.read(-1), RangeError);
  await assert.rejects(fresh.read(NaN), RangeError);
});

test("Covers: SG-R-MEM-02 - small chunks do not pin the big buffer they were cut from", async () => {
  // One byte of output per call must not keep a 256 KiB buffer alive per chunk.
  const r = reader(gz(Buffer.alloc(50_000)), "gzip", LOOSE);
  const chunk = (await r.read(1)) as Uint8Array;
  assert.equal(chunk.buffer.byteLength, 1);
  const bigChunk = (await r.read(100_000)) as Uint8Array;
  assert.ok(bigChunk.buffer.byteLength <= 256 * 1024);
});

test("Covers: SG-R-RDR-03 - empty chunks from an iterable are skipped, not looped on", async () => {
  const stream = gz(Buffer.from("empty chunks between data"));
  const source = (async function* () {
    yield new Uint8Array(0);
    yield stream.subarray(0, 10);
    yield new Uint8Array(0);
    yield new Uint8Array(0);
    yield stream.subarray(10);
  })();
  assert.equal(Buffer.from(await decodeAll(source, "gzip", LOOSE)).toString(), "empty chunks between data");
  const forever = (async function* () { for (;;) yield new Uint8Array(0); })();
  await assert.rejects(decodeAll(forever, "gzip", LOOSE), SpillgateError);
});

test("Covers: SG-R-API-01 - views with a byte offset (Node pooled buffers) work", async () => {
  const stream = gz(Buffer.from("offset views"));
  const padded = Buffer.concat([Buffer.alloc(13), stream, Buffer.alloc(7)]);
  const view = padded.subarray(13, 13 + stream.length);
  assert.notEqual(view.byteOffset, 0);
  assert.equal(Buffer.from(await decodeAll(view, "gzip", LOOSE)).toString(), "offset views");
  assert.equal(Buffer.from(await decodeAll(new Trickle(view, 3) as never, "gzip", LOOSE)).toString(), "offset views");
});

test("Covers: SG-R-RDR-01 - a source that reuses its buffer after yielding is safe", async () => {
  const stream = gz(Buffer.from("reused buffer ".repeat(500)));
  const shared = new Uint8Array(64);
  const source = (async function* () {
    for (let pos = 0; pos < stream.length; pos += 64) {
      const n = Math.min(64, stream.length - pos);
      shared.set(stream.subarray(pos, pos + n));
      yield shared.subarray(0, n);
      shared.fill(0xee); // the producer overwrites its buffer as soon as it is asked for more
    }
  })();
  assert.equal(Buffer.from(await decodeAll(source, "gzip", LOOSE)).toString(), "reused buffer ".repeat(500));
});

test("Covers: SG-R-LIM-09 - a Decoder keeps working when the options object is changed later", async () => {
  const options = { strictZlib: false, codecs: {} as Record<string, never> };
  const decoder = new Decoder(LOOSE, options);
  options.strictZlib = true;
  assert.equal((await outcome(Buffer.from([0x03, 0x00]), "deflate", LOOSE))[0], "ok");
  assert.ok(decoder);
});

test("Covers: SG-R-MEM-03 SG-R-MEM-02 - the documented memory bounds match the code", async () => {
  const { MAX_STEP } = await import("../src/guard.js");
  const { BUFFER_SIZE } = await import("../src/meter.js");
  const text = readFileSync(join(ROOT, "docs", "memory.md"), "utf8");
  assert.ok(text.includes(`${BUFFER_SIZE / 1024} KiB`) && text.includes(`${MAX_STEP / 1024} KiB`));
  assert.ok(BUFFER_SIZE <= 4 * 1024 * 1024 && MAX_STEP <= 4 * 1024 * 1024);
});
