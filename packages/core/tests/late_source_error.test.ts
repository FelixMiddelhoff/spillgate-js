/** A source error late in the stream: the delivered prefix must not depend on the caller (SG-R-RDR-01). */

import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { Decoder, SpillgateError } from "../src/index.js";
import { gz, prng } from "./helpers.js";

/** Pull source that hands out at most `step` bytes per read, then fails after `failAt` bytes. */
class Failing {
  private pos = 0;
  constructor(
    private readonly payload: Uint8Array,
    private readonly failAt: number,
    private readonly step: number,
  ) {}
  read(max: number): Uint8Array | null {
    if (this.pos >= this.failAt) throw new Error("boom");
    const end = Math.min(this.pos + Math.min(max, this.step), this.failAt, this.payload.length);
    const chunk = this.payload.subarray(this.pos, end);
    this.pos = end;
    return chunk;
  }
}

async function run(stream: Uint8Array, encodings: string, failAt: number, readSize: number, step: number): Promise<string> {
  const reader = new Decoder({ maxOutput: 2 ** 30, disableRatioLimit: true }).reader(new Failing(stream, failAt, step), encodings);
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
  return `${kind}:${all.length}:${all.subarray(0, 64).toString("hex")}:${zlib.crc32(all)}`;
}

const noise = (n: number, seed: number): Buffer => {
  const r = prng(seed);
  return Buffer.from(Array.from({ length: n }, () => (r() < 0.7 ? 97 + ((r() * 4) | 0) : (r() * 256) | 0)));
};

test("Covers: SG-R-RDR-01 SG-I-09 - a source error late in the stream gives the same prefix for every read size and source chunking", async () => {
  const payload = noise(16_000, 1);
  const cases: [string, Buffer][] = [
    ["gzip", gz(payload)],
    ["deflate", zlib.deflateSync(payload)],
    ["gzip, gzip", gz(gz(payload))],
    ["gzip, gzip, gzip", gz(gz(gz(payload)))],
    ["identity, gzip", gz(payload)],
  ];
  for (const [encodings, stream] of cases) {
    for (const fraction of [0.3, 0.9, 0.999]) {
      const failAt = Math.floor(stream.length * fraction);
      const results = new Set<string>();
      for (const readSize of [1, 7, 4096, 65_536, 1 << 20]) {
        for (const step of [3, 700, 70_000]) {
          if (readSize === 1 && failAt > 4_000) continue; // keep the run time sane
          results.add(await run(stream, encodings, failAt, readSize, step));
        }
      }
      assert.equal(results.size, 1, `${encodings} @${fraction}: ${[...results].map((r) => r.slice(0, 40)).join(" | ")}`);
      assert.match([...results][0] as string, /^source_error:/);
    }
  }
});
