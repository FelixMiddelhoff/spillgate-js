/** SG-R-INP-01 for the optional codecs: the byte after MaxInput is looked at, not taken. */

import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { codec as brotli, initBrotli } from "spillgate-br";
import { codec as zstd } from "spillgate-zstd";
import { SHAPES, PATTERNS, decodeProbe } from "../../core/dist/tests/probe_support.js";

await initBrotli();

const text = Buffer.from("the byte after the limit ".repeat(400));
const streams: { enc: string; stream: Buffer }[] = [{ enc: "br", stream: zlib.brotliCompressSync(text) }];
const zc = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
if (zc !== undefined) streams.push({ enc: "zstd", stream: zc(text) });
const options = { codecs: { br: brotli(), zstd: zstd() } };
const tails = [Buffer.from([0]), Buffer.alloc(1000)];

test("Covers: SG-R-INP-01 SG-R-INP-02 SG-R-CDC-04 SG-R-CDC-05 - br and zstd: probe byte looked at, not taken", async () => {
  for (const { enc, stream } of streams) {
    const L = stream.length;
    for (const shape of SHAPES) {
      for (const pattern of PATTERNS) {
        const where = `${enc} ${shape.name} read ${pattern.join(",")}`;
        for (const tail of tails) {
          for (const maxInput of [L, L + 1]) {
            const r = await decodeProbe(Buffer.concat([stream, tail]), maxInput, shape, pattern, enc, options);
            assert.equal(r.kind, "corrupt", `${where} tail ${tail.length} M ${maxInput}`);
            assert.ok(r.handed <= maxInput + 1, `${where}: handed ${r.handed}`);
          }
        }
        assert.equal((await decodeProbe(stream, L, shape, pattern, enc, options)).kind, "ok", `${where}: exact`);
        for (const k of [1, 5, Math.floor(L / 2), L - 1]) {
          assert.equal((await decodeProbe(stream.subarray(0, k), k, shape, pattern, enc, options)).kind, "corrupt", `${where}: source ends at ${k}`);
          const r = await decodeProbe(Buffer.concat([stream, Buffer.alloc(50)]), k, shape, pattern, enc, options);
          assert.equal(r.kind, "input_limit", `${where}: cut at ${k}`);
          assert.ok(r.handed <= k + 1);
        }
      }
    }
  }
});
