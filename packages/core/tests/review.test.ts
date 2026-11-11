/** Regression tests for the findings of the independent security review. */

import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { Decoder, SpillgateError } from "../src/index.js";
import { gz } from "./helpers.js";

const LOOSE = { maxOutput: 2 ** 30, disableRatioLimit: true };

test("Covers: SG-I-02 SG-R-RDR-01 - a fractional read size is never the end of the stream", async () => {
  const payload = Buffer.from("hello world, this is more than zero bytes");
  const r = new Decoder(LOOSE).reader(gz(payload), "gzip");
  const first = await r.read(0.5);
  assert.equal(first?.length, 0); // zero bytes asked, nothing consumed, state unchanged
  assert.equal(Buffer.from(await r.readAll()).length, payload.length);
});

test("Covers: SG-R-RDR-05 SG-I-05 - a revoked Proxy thrown by the source is a typed source_error", async () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const r = new Decoder(LOOSE).reader({ read(): never { throw proxy; } }, "gzip");
  await assert.rejects(r.read(), (e: unknown) => e instanceof SpillgateError && e.kind === "source_error");
});

test("Covers: SG-R-CDC-08 SG-I-05 SG-I-03 - a revoked Proxy thrown by a codec is internal and sticky", async () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const codec = { newReader: () => ({ read: async (): Promise<Uint8Array> => { throw proxy; } }) };
  const r = new Decoder(LOOSE, { codecs: { evil: codec } }).reader(new Uint8Array([1, 2, 3]), "evil");
  for (let i = 0; i < 2; i++) {
    await assert.rejects(r.read(), (e: unknown) => e instanceof SpillgateError && e.kind === "internal");
  }
});

test("Covers: SG-R-API-04 - an abort is honored while the source read is pending", async () => {
  const ac = new AbortController();
  const r = new Decoder(LOOSE).reader({ read: () => new Promise<never>(() => undefined) }, "gzip", { signal: ac.signal });
  const pending = r.read().then(() => "resolved", (e: unknown) => (e instanceof SpillgateError ? e.kind : "other"));
  setTimeout(() => ac.abort(), 20);
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 2000).unref());
  assert.equal(await Promise.race([pending, timeout]), "canceled");
});

test("Covers: SG-R-CDC-03 - a dynamic block whose only literal/length code is the end of block decodes", async () => {
  // Found by the review: zlib accepts one code of length 1 for the literal/length alphabet too.
  const bits: number[] = [];
  const put = (v: number, n: number): void => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  const code = (v: number, n: number): void => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(1, 1); put(2, 2); put(0, 5); put(0, 5); put(15, 4);
  for (const s of [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]) put(s === 0 || s === 1 ? 1 : 0, 3);
  for (let i = 0; i < 257; i++) code(i === 256 ? 1 : 0, 1);
  code(0, 1);
  code(0, 1);
  while (bits.length % 8) bits.push(0);
  const data = Buffer.alloc(bits.length / 8);
  bits.forEach((b, i) => { data[i >> 3] = (data[i >> 3] as number) | (b << (i & 7)); });
  assert.equal(zlib.inflateRawSync(data).length, 0);
  assert.equal((await new Decoder(LOOSE).readAll(data, "deflate")).length, 0);
});

test("Covers: SG-R-CDC-02 SG-R-RAT-02 - many tiny gzip members cost bounded CPU per input byte", async () => {
  const member = zlib.gzipSync(Buffer.alloc(0));
  const input = Buffer.concat(Array<Buffer>(20000).fill(member)); // 400 KB, zero output
  const started = performance.now();
  await new Decoder(LOOSE).readAll(input, "gzip");
  assert.ok(performance.now() - started < 10000, "one decoder is reused for all members, and the boundary does not copy the look-ahead");
});

test("Covers: SG-R-RDR-01 SG-R-RAT-02 - the prefix delivered before a ratio error is a prefix of the same stream and differs by a few steps at most", async () => {
  // The ratio is judged once per step, so a larger read can deliver more before the error. Near the
  // threshold the check flips on single input bytes (this bomb has a ratio of 1028 against a limit of
  // 1000), so the gap can reach two steps; it is never more than a few.
  const bomb = zlib.gzipSync(Buffer.alloc(50e6), { level: 9 });
  const delivered = async (size: number): Promise<number> => {
    const r = new Decoder({ maxOutput: 1e9 }).reader(bomb, "gzip");
    let n = 0;
    try {
      for (let c = await r.read(size); c !== null; c = await r.read(size)) {
        assert.ok(c.every((b) => b === 0), "the delivered bytes are the start of the same stream");
        n += c.length;
      }
    } catch (e) {
      assert.ok(e instanceof SpillgateError && e.kind === "ratio_limit");
    }
    return n;
  };
  const small = await delivered(1);
  const large = await delivered(1 << 20);
  assert.ok(Math.abs(large - small) <= 2 * 64 * 1024, `read(1) delivered ${small}, read(1 MiB) delivered ${large}`);
});

test("Covers: SG-R-HDR-09 SG-R-API-03 - a refused Content-Encoding does not lock the callers stream", () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
  assert.throws(() => new Decoder(LOOSE).reader(stream, "br"), (e: unknown) => e instanceof SpillgateError);
  assert.equal(stream.locked, false);
});

test("Covers: SG-R-RDR-06 SG-I-10 - closing the reader releases the lock it placed on a stream", async () => {
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(gz(Buffer.from("x"))); } });
  const r = new Decoder(LOOSE).reader(stream, "identity");
  await r.read(1);
  assert.equal(stream.locked, true);
  r.close();
  assert.equal(stream.locked, false);
});
