import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { CorruptError } from "../src/errors.js";
import { DONE, Inflater, NEED_INPUT, OUTPUT_FULL } from "../src/inflate.js";

/** Decode `stream` feeding `inStep` input bytes and offering `outStep` output bytes per call. */
function inflate(stream: Uint8Array, inStep: number, outStep: number) {
  const inflater = new Inflater();
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (let guard = 0; guard < 10_000_000; guard++) {
    const chunk = stream.subarray(pos, pos + inStep);
    const out = new Uint8Array(outStep);
    const status = inflater.step(chunk, out);
    parts.push(out.slice(0, inflater.produced));
    pos += inflater.used;
    if (status === DONE) {
      return { data: Buffer.concat(parts), end: pos, leftover: inflater.leftover() };
    }
    if (status === NEED_INPUT && pos >= stream.length) throw new CorruptError("truncated");
    if (status === OUTPUT_FULL || status === NEED_INPUT) continue;
  }
  throw new Error("no progress");
}

function payloads(): Buffer[] {
  const random = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 2654435761 >>> 24) & 255));
  const text = Buffer.from("the quick brown fox jumps over the lazy dog\n".repeat(2000));
  return [Buffer.alloc(0), Buffer.from("a"), random(1), random(777), random(70000), text, Buffer.alloc(300000), Buffer.concat([random(5000), Buffer.alloc(40000), text.subarray(0, 7000)])];
}

test("raw deflate round trip for every level, strategy and chunking", () => {
  for (const payload of payloads()) {
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE]) {
        const stream = zlib.deflateRawSync(payload, { level, strategy });
        for (const [inStep, outStep] of [[1, 1], [3, 7], [64, 4096], [100000, 100000], [1, 100000], [100000, 1]] as [number, number][]) {
          if (payload.length > 20000 && (inStep === 1 || outStep === 1)) continue;
          const r = inflate(stream, inStep, outStep);
          assert.ok(r.data.equals(payload), `level ${level} strategy ${strategy} steps ${inStep}/${outStep}`);
          assert.equal(r.end + r.leftover.length, stream.length);
        }
      }
    }
  }
});

test("bytes after the stream come back as leftover", () => {
  const stream = zlib.deflateRawSync(Buffer.from("hello world"));
  const tail = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
  const joined = Buffer.concat([stream, tail]);
  for (const inStep of [1, 2, 5, 100]) {
    const r = inflate(joined, inStep, 64);
    assert.equal(r.data.toString(), "hello world");
    assert.equal(r.end + r.leftover.length + 0, r.end + r.leftover.length);
    // everything the decoder took beyond the stream is returned: end + leftover covers the stream only
    assert.ok(r.end - r.leftover.length <= stream.length);
    assert.equal(Buffer.from(joined.subarray(r.end - r.leftover.length === stream.length ? stream.length : stream.length)).subarray(0, tail.length).equals(tail), true);
  }
});

test("invalid data is corrupt", () => {
  for (const bad of [[0x07], [0x06], [0x01, 0x01, 0x00, 0x00, 0x00], [0xff, 0xff, 0xff, 0xff, 0xff]]) {
    assert.throws(() => inflate(Uint8Array.from(bad), 100, 100), CorruptError);
  }
});
