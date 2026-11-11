/** gzip (SG-R-CDC-02) and deflate (SG-R-CDC-03) framing, one rule at a time. */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { test } from "node:test";
import { isZlibHeader } from "../src/deflate.js";
import { crc32 } from "../src/checksum.js";
import { storedDeflate, zlibStored } from "spillgate-test-support";
import { LOOSE, Trickle, concat, gz, outcome, raw, zl } from "./helpers.js";

const DATA = Buffer.from(Array.from({ length: 5120 }, (_, i) => i & 255));

interface MemberOptions {
  flags?: number;
  extra?: Uint8Array;
  name?: Uint8Array;
  comment?: Uint8Array;
  hcrc?: boolean | number;
  crc?: number;
  isize?: number;
}

/** Build one gzip member with the requested header fields (stored DEFLATE body). */
function member(payload: Uint8Array, o: MemberOptions = {}): Buffer {
  const header = [0x1f, 0x8b, 8, o.flags ?? 0, 0, 0, 0, 0, 0, 255];
  const parts: number[] = [];
  if (o.extra !== undefined) {
    header[3] = (header[3] as number) | 4;
    parts.push(o.extra.length & 255, o.extra.length >> 8, ...o.extra);
  }
  if (o.name !== undefined) {
    header[3] = (header[3] as number) | 8;
    parts.push(...o.name, 0);
  }
  if (o.comment !== undefined) {
    header[3] = (header[3] as number) | 16;
    parts.push(...o.comment, 0);
  }
  let head = Buffer.from([...header, ...parts]);
  if (o.hcrc !== undefined && o.hcrc !== false) {
    head[3] = (head[3] as number) | 2;
    const value = o.hcrc === true ? crc32(head) & 0xffff : o.hcrc;
    head = Buffer.concat([head, Buffer.from([value & 255, value >> 8])]);
  }
  const crc = o.crc ?? crc32(payload);
  const isize = o.isize ?? payload.length;
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc >>> 0, 0);
  trailer.writeUInt32LE(isize % 2 ** 32, 4);
  return Buffer.concat([head, storedDeflate(payload), trailer]);
}

const kind = async (stream: Uint8Array, encoding = "gzip", ...rest: Parameters<typeof outcome> extends [unknown, unknown, ...infer R] ? R : never) =>
  (await outcome(stream, encoding, ...rest))[0];

// -- gzip ----------------------------------------------------------------------------------------

test("Covers: SG-R-CDC-02 - plain and library made gzip decode", async () => {
  assert.deepEqual(await outcome(member(DATA), "gzip"), ["ok", DATA]);
  assert.deepEqual(await outcome(gz(DATA), "gzip"), ["ok", DATA]);
  assert.deepEqual(await outcome(gz(Buffer.alloc(0)), "gzip"), ["ok", Buffer.alloc(0)]);
  assert.deepEqual(await outcome(member(Buffer.alloc(0)), "x-gzip"), ["ok", Buffer.alloc(0)]);
});

test("Covers: SG-R-CDC-02 - a bad magic or method is corrupt", async () => {
  const bad = [[], [0x1f], [0x1f, 0x8b], [0x1f, 0x8b, 8], [0x1f, 0x8c], [0x1e, 0x8b, 8], [0x1f, 0x8b, 7], [0x1f, 0x8b, 9], [0x50, 0x4b, 3, 4]];
  for (const prefix of bad) assert.equal(await kind(Buffer.concat([Buffer.from(prefix), Buffer.alloc(30)])), "corrupt", String(prefix));
});

test("Covers: SG-R-CDC-02 - reserved flag bits are corrupt, FTEXT is harmless", async () => {
  for (const bit of [5, 6, 7]) assert.equal(await kind(member(DATA, { flags: 1 << bit })), "corrupt");
  assert.deepEqual(await outcome(member(DATA, { flags: 1 }), "gzip"), ["ok", DATA]);
});

test("Covers: SG-R-CDC-02 - the header CRC is verified", async () => {
  assert.deepEqual(await outcome(member(DATA, { hcrc: true, name: Buffer.from("n") }), "gzip"), ["ok", DATA]);
  assert.equal(await kind(member(DATA, { hcrc: 0x1234, name: Buffer.from("n") })), "corrupt");
  assert.deepEqual(await outcome(member(DATA, { hcrc: true, extra: Buffer.alloc(10, 120), comment: Buffer.from("c") }), "gzip"), ["ok", DATA]);
});

test("Covers: SG-R-CDC-02 SG-R-MEM-01 - extra field sizes", async () => {
  for (const size of [0, 1, 511, 512, 513, 65535]) {
    assert.deepEqual(await outcome(member(DATA, { extra: Buffer.alloc(size, 101) }), "gzip"), ["ok", DATA], String(size));
  }
  assert.equal(await kind(member(DATA, { extra: Buffer.alloc(1000, 101) }).subarray(0, 600)), "corrupt");
});

for (const field of ["name", "comment"] as const) {
  test(`Covers: SG-R-CDC-02 SG-R-MEM-01 - ${field} is bounded at 512 bytes with the terminator`, async () => {
    const make = (n: number) => member(DATA, { [field]: Buffer.alloc(n, 110) });
    assert.deepEqual(await outcome(make(511), "gzip"), ["ok", DATA]);
    assert.equal(await kind(make(512)), "corrupt");
    assert.equal(await kind(make(100_000)), "corrupt");
    assert.deepEqual(await outcome(make(0), "gzip"), ["ok", DATA]);
  });
}

test("Covers: SG-R-CDC-02 SG-R-MEM-01 SG-I-04 - an endless name without terminator stops early", async () => {
  const source = new Trickle(Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 0]), Buffer.alloc(10_000_000, 110)]), 4096);
  assert.equal(await kind(source as never), "corrupt");
  assert.ok(source.total < 5000);
});

test("Covers: SG-R-CDC-02 SG-R-CDC-07 - CRC and ISIZE are checked, ISIZE modulo 2**32", async () => {
  assert.equal(await kind(member(DATA, { crc: 0 })), "corrupt");
  assert.equal(await kind(member(DATA, { isize: DATA.length + 1 })), "corrupt");
  assert.equal(await kind(member(DATA, { isize: 0 })), "corrupt");
  assert.deepEqual(await outcome(member(DATA, { isize: DATA.length }), "gzip"), ["ok", DATA]);
});

test("Covers: SG-R-CDC-07 SG-I-04 - a wrong ISIZE is never an allowance or an early rejection", async () => {
  assert.equal(await kind(member(DATA, { isize: 2 ** 32 - 1 }), "gzip", { maxOutput: 10 }), "output_limit"); // produced bytes decide
  assert.equal(await kind(member(Buffer.alloc(1000, 120), { isize: 1 }), "gzip", { maxOutput: 5000 }), "corrupt");
});

test("Covers: SG-R-CDC-02 - trailing bytes after a member are corrupt", async () => {
  const good = member(DATA);
  for (const tail of [[0], Array(16).fill(0), [103, 97, 114], [0x1f], [0x1f, 0x8b], [0x1f, 0x8b, 8]]) {
    assert.equal(await kind(Buffer.concat([good, Buffer.from(tail)])), "corrupt", String(tail));
  }
});

test("Covers: SG-R-CDC-02 SG-R-LAY-02 - multiple members share one budget", async () => {
  const two = concat(member(DATA), member(DATA));
  assert.deepEqual(await outcome(two, "gzip"), ["ok", concat(DATA, DATA)]);
  const [k, got] = await outcome(two, "gzip", { maxOutput: DATA.length + 5, disableRatioLimit: true });
  assert.equal(k, "output_limit");
  assert.equal(got.length, DATA.length + 5);
  const many = concat(...Array(50).fill(member(Buffer.alloc(0))), member(DATA));
  assert.deepEqual(await outcome(many, "gzip"), ["ok", DATA]);
});

test("Covers: SG-R-CDC-02 - errors in a later member are reported too", async () => {
  assert.equal(await kind(concat(member(DATA), member(DATA, { crc: 1 }))), "corrupt");
  assert.equal(await kind(concat(member(DATA), member(DATA).subarray(0, 20))), "corrupt");
});

test("Covers: SG-R-CDC-06 - every truncation of a gzip stream is corrupt", async () => {
  const stream = member(Buffer.from("hello truncation"), { name: Buffer.from("f"), comment: Buffer.from("c"), extra: Buffer.from("xy"), hcrc: true });
  for (let cut = 0; cut < stream.length; cut++) assert.equal(await kind(stream.subarray(0, cut)), "corrupt", String(cut));
  const real = gz(Buffer.from("hello world ".repeat(100)));
  for (let cut = 0; cut < real.length; cut++) assert.equal(await kind(real.subarray(0, cut)), "corrupt", String(cut));
});

test("Covers: SG-I-05 SG-R-CDC-08 - every bit flip gives ok or corrupt, never something else", async () => {
  const stream = gz(Buffer.from("flip every bit ".repeat(20)));
  for (let position = 0; position < stream.length; position++) {
    for (let bit = 0; bit < 8; bit++) {
      const damaged = Buffer.from(stream);
      damaged[position] = (damaged[position] as number) ^ (1 << bit);
      const k = await kind(damaged);
      assert.ok(k === "ok" || k === "corrupt", `${position}:${bit} ${k}`);
      if (position >= 4 && position <= 9 && k !== "ok") assert.fail(`MTIME/XFL/OS flip ${position}:${bit} must be harmless`);
    }
  }
});

// -- deflate -------------------------------------------------------------------------------------

test("Covers: SG-R-CDC-03 - zlib and raw deflate decode", async () => {
  for (const stream of [zl(DATA), raw(DATA), zlibStored(DATA), storedDeflate(DATA)]) {
    assert.deepEqual(await outcome(stream, "deflate"), ["ok", DATA]);
  }
  assert.deepEqual(await outcome(zl(Buffer.alloc(0)), "deflate"), ["ok", Buffer.alloc(0)]);
  assert.deepEqual(await outcome(raw(Buffer.alloc(0)), "deflate"), ["ok", Buffer.alloc(0)]);
});

test("Covers: SG-R-CDC-03 - the zlib header detection table", () => {
  for (const [cmf, flg] of [[0x78, 0x01], [0x78, 0x9c], [0x78, 0xda], [0x08, 0x1d]] as const) assert.ok(isZlibHeader(cmf, flg));
  for (const [cmf, flg] of [[0x78, 0x00], [0x79, 0x01], [0x88, 0x1c]] as const) assert.ok(!isZlibHeader(cmf, flg));
});

test("Covers: SG-R-CDC-03 - the preset dictionary flag is corrupt, not retried as raw", async () => {
  const fdict = Buffer.concat([Buffer.from([0x78, 0xbb]), Buffer.alloc(20)]);
  assert.equal((0x78 << 8 | 0xbb) % 31, 0);
  assert.equal(await kind(fdict, "deflate"), "corrupt");
});

test("Covers: SG-R-CDC-03 - the Adler-32 trailer and trailing bytes", async () => {
  const good = zlibStored(DATA);
  const flipped = Buffer.from(good);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
  assert.equal(await kind(flipped, "deflate"), "corrupt");
  assert.equal(await kind(concat(good, Buffer.from([0])), "deflate"), "corrupt");
  assert.equal(await kind(good.subarray(0, good.length - 2), "deflate"), "corrupt");
  assert.equal(await kind(concat(raw(DATA), Buffer.from([0])), "deflate"), "corrupt");
  assert.equal(await kind(concat(raw(DATA), Buffer.from([0x78, 0x9c])), "deflate"), "corrupt");
});

test("Covers: SG-R-CDC-03 - strictZlib disables the raw fallback", async () => {
  assert.equal(await kind(raw(DATA), "deflate", LOOSE, { strictZlib: true }), "corrupt");
  assert.deepEqual(await outcome(zl(DATA), "deflate", LOOSE, { strictZlib: true }), ["ok", DATA]);
});

test("Covers: SG-R-CDC-06 - every truncation of a deflate stream is corrupt", async () => {
  for (const stream of [zl(Buffer.from("zlib truncation ".repeat(50))), raw(Buffer.from("raw truncation ".repeat(50)))]) {
    for (let cut = 0; cut < stream.length; cut++) assert.equal(await kind(stream.subarray(0, cut), "deflate"), "corrupt", String(cut));
  }
});

test("Covers: SG-R-CDC-08 - invalid deflate blocks are corrupt", async () => {
  for (const body of [[0x07], [0x06], [1, 1, 0, 0, 0], Array(30).fill(0xff), [5, 0xff, 0xff]]) {
    assert.equal(await kind(Buffer.from(body), "deflate"), "corrupt", String(body));
  }
});

test("Covers: SG-I-05 SG-R-CDC-08 - every deflate bit flip gives ok or corrupt", async () => {
  for (const stream of [zl(Buffer.from("flip the bits ".repeat(15))), raw(Buffer.from("flip the bits ".repeat(15)))]) {
    for (let position = 0; position < stream.length; position++) {
      for (let bit = 0; bit < 8; bit++) {
        const damaged = Buffer.from(stream);
        damaged[position] = (damaged[position] as number) ^ (1 << bit);
        const k = await kind(damaged, "deflate");
        assert.ok(k === "ok" || k === "corrupt", `${position}:${bit} ${k}`);
      }
    }
  }
});

test("Covers: SG-R-RDR-01 SG-I-09 - pending match output is not lost when the buffer fills", async () => {
  const payload = Buffer.concat([Buffer.alloc(100_000, 97), Buffer.alloc(100_000, 98)]); // long matches span many small reads
  for (const stream of [zl(payload), raw(payload), gz(payload)]) {
    for (const size of [1, 7, 100, 4096]) {
      const encoding = stream[0] === 0x1f ? "gzip" : "deflate";
      const reader = (await import("../src/index.js")).reader(stream, encoding, LOOSE);
      const parts: Uint8Array[] = [];
      let total = 0;
      for (let c = await reader.read(size); c !== null; c = await reader.read(size)) {
        parts.push(c);
        total += c.length;
        if (size === 1 && total > 3000) break;
      }
      assert.ok(payload.subarray(0, total).equals(Buffer.concat(parts)));
    }
  }
});

test("Covers: SG-R-CDC-02 - the checksums agree with node:zlib", () => {
  for (const data of [Buffer.alloc(0), Buffer.from("a"), DATA, Buffer.alloc(100_000, 7)]) {
    assert.equal(crc32(data), zlib.crc32(data) >>> 0);
    assert.equal(crc32(Buffer.concat([data, DATA])), zlib.crc32(Buffer.concat([data, DATA])) >>> 0);
  }
});
