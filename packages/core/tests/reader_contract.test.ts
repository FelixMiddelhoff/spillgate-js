/** Layers, limits and the reader contract with hostile sources and codecs (SPEC sections 5-9, 11). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CanceledError,
  ClosedError,
  CorruptError,
  Decoder,
  InputLimitError,
  InternalError,
  InvalidOptionError,
  OutputLimitError,
  RatioLimitError,
  SourceError,
  SpillgateError,
  UnsupportedEncodingError,
  decodeAll,
  reader,
  type Codec,
  type Limits,
} from "../src/index.js";
import { LOOSE, Trickle, gz, outcome, zl } from "./helpers.js";

const limits = (maxOutput: number, extra: Partial<Limits> = {}): Limits => ({ maxOutput, disableRatioLimit: true, ...extra });

// -- limits at the boundary ----------------------------------------------------------------------

test("Covers: SG-R-LAY-02 SG-R-LAY-03 SG-I-01 - the output limit at limit minus one, limit and limit plus one", async () => {
  const payload = Buffer.from(Array.from({ length: 1024 }, (_, i) => i & 255));
  for (const [codec, stream] of [["gzip", gz(payload)], ["deflate", zl(payload)]] as const) {
    const n = payload.length;
    assert.deepEqual(await outcome(stream, codec, limits(n + 1)), ["ok", payload]);
    assert.deepEqual(await outcome(stream, codec, limits(n)), ["ok", payload]);
    const [kind, got] = await outcome(stream, codec, limits(n - 1));
    assert.equal(kind, "output_limit");
    assert.ok(got.equals(payload.subarray(0, n - 1)));
  }
});

test("Covers: SG-R-LAY-01 - intermediate layers have their own budget", async () => {
  const inner = gz(Buffer.from("tiny")); // 24 bytes; the final output is only 4 bytes
  const outer = gz(inner);
  await assert.rejects(decodeAll(outer, "gzip, gzip", limits(10)), (e: OutputLimitError) => e instanceof OutputLimitError && e.layer === 1);
});

test("Covers: SG-R-CDC-10 SG-R-LAY-01 - identity is bounded too", async () => {
  assert.deepEqual(await outcome(Buffer.alloc(10, 120), "", limits(10)), ["ok", Buffer.alloc(10, 120)]);
  assert.equal((await outcome(Buffer.alloc(11, 120), "identity", limits(10)))[0], "output_limit");
  assert.deepEqual(await outcome(Buffer.alloc(0), [], limits(1)), ["ok", Buffer.alloc(0)]);
});

test("Covers: SG-R-RAT-01 SG-I-02 - the ratio limit fires and names the layer", async () => {
  const bomb = gz(Buffer.alloc(5_000_000));
  await assert.rejects(
    decodeAll(bomb, "gzip", { maxOutput: 1e9, maxRatio: 100, ratioGrace: 1000 }),
    (e: RatioLimitError) => e instanceof RatioLimitError && e.layer === 1 && e.limit === 100,
  );
});

test("Covers: SG-R-RAT-04 - the opt-out leaves the output limit in force", async () => {
  assert.equal((await outcome(gz(Buffer.alloc(5_000_000)), "gzip", { maxOutput: 1000, disableRatioLimit: true }))[0], "output_limit");
});

test("Covers: SG-R-RAT-01 - the grace is respected", async () => {
  const bomb = gz(Buffer.alloc(60_000)); // ratio about 1000, below the 64 KiB default grace
  assert.equal((await outcome(bomb, "gzip", { maxOutput: 1e6, maxRatio: 2 }))[0], "ok");
  assert.equal((await outcome(bomb, "gzip", { maxOutput: 1e6, maxRatio: 2, ratioGrace: 100 }))[0], "ratio_limit");
});

test("Covers: SG-R-RAT-03 - an end-to-end only ratio error has no layer", async () => {
  // Layer 1 expands about 109:1, layer 2 about 1027:1, the whole chain over 100000:1.
  const inner = gz(Buffer.alloc(20_000_000));
  const outer = gz(inner);
  await assert.rejects(
    decodeAll(outer, "gzip, gzip", { maxOutput: 1e9, maxRatio: 2000, ratioGrace: 1000 }),
    (e: RatioLimitError) => e instanceof RatioLimitError && e.layer === 0 && /end-to-end/.test(e.message),
  );
  assert.equal((await decodeAll(outer, "gzip, gzip", { maxOutput: 1e9, disableRatioLimit: true })).length, 20_000_000);
});

test("Covers: SG-R-RAT-01 SG-I-02 - a single layer ratio error names layer one, not the chain", async () => {
  const r = reader(gz(Buffer.alloc(5_000_000)), "gzip", { maxOutput: 1e9, maxRatio: 100, ratioGrace: 1000 });
  await assert.rejects(async () => { while (await r.read(100_000)) { /* drain */ } }, (e: RatioLimitError) => e.layer === 1);
});

test("Covers: SG-R-INP-01 SG-R-INP-02 - the input limit is exact and counts the source", async () => {
  const stream = gz(Buffer.from("hello world".repeat(50)));
  const n = stream.length;
  assert.equal((await outcome(stream, "gzip", limits(1e6, { maxInput: n })))[0], "ok");
  assert.equal((await outcome(stream, "gzip", limits(1e6, { maxInput: n - 1 })))[0], "input_limit");
  const source = new Trickle(Buffer.concat([stream, Buffer.from("extra bytes behind the stream")]), 7);
  await outcome(source, "gzip", limits(1e6, { maxInput: n }));
  assert.ok(source.total <= n + 1);
});

test("Covers: SG-R-INP-01 - the input limit applies to identity chains", async () => {
  assert.equal((await outcome(Buffer.alloc(100), "identity", limits(1000, { maxInput: 100 })))[0], "ok");
  assert.equal((await outcome(Buffer.alloc(101), "identity", limits(1000, { maxInput: 100 })))[0], "input_limit");
});

test("Covers: SG-R-INP-01 SG-R-LAY-01 - errors of a lower layer pass through with their layer", async () => {
  await assert.rejects(decodeAll(gz(gz(Buffer.alloc(1000, 120))), "gzip, gzip", limits(1e6, { maxInput: 20 })), (e: InputLimitError) => e instanceof InputLimitError && e.layer === 1);
});

// -- reader contract ----------------------------------------------------------------------------

test("Covers: SG-R-RDR-01 SG-I-09 - the result does not depend on read sizes", async () => {
  const payload = Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 7) & 255));
  const stream = gz(payload);
  for (const sizes of [[1], [3], [4096], [1 << 20], [1, 7, 4096, 1]]) {
    if (sizes[0] === 1 && sizes.length === 1) continue; // covered at smaller scale below
    const r = reader(stream, "gzip", LOOSE);
    const parts: Uint8Array[] = [];
    for (let i = 0; ; i++) {
      const chunk = await r.read(sizes[i % sizes.length] as number);
      if (chunk === null) break;
      parts.push(chunk);
    }
    assert.ok(Buffer.concat(parts).equals(payload), String(sizes));
  }
  const small = Buffer.from("one byte at a time ".repeat(200));
  const r = reader(gz(small), "gzip", LOOSE);
  const parts: Uint8Array[] = [];
  for (let c = await r.read(1); c !== null; c = await r.read(1)) parts.push(c);
  assert.ok(Buffer.concat(parts).equals(small));
});

test("Covers: SG-R-RDR-01 SG-I-09 - source chunking does not matter", async () => {
  const payload = Buffer.from("chunky".repeat(5000));
  for (const step of [1, 2, 3, 100, 4096, 70000]) {
    assert.ok(Buffer.from(await decodeAll(new Trickle(gz(payload), step), "gzip", LOOSE)).equals(payload), String(step));
  }
});

test("Covers: SG-R-LAY-05 SG-I-03 - errors and a clean end are sticky", async () => {
  const r = reader(gz(Buffer.alloc(100_000)), "gzip", limits(10));
  assert.equal((await r.read(100))?.length, 10); // the allowed bytes arrive first
  await assert.rejects(r.read(100), OutputLimitError);
  for (let i = 0; i < 3; i++) await assert.rejects(r.read(1), OutputLimitError);
  const ok = reader(gz(Buffer.from("abc")), "gzip", LOOSE);
  assert.equal(Buffer.from(await ok.readAll()).toString(), "abc");
  assert.equal(await ok.read(10), null);
  assert.equal(await ok.read(10), null);
});

test("Covers: SG-R-RDR-02 - a zero-length read changes nothing", async () => {
  const r = reader(gz(Buffer.from("abc")), "gzip", LOOSE);
  assert.equal((await r.read(0))?.length, 0);
  assert.equal(Buffer.from((await r.read(10)) as Uint8Array).toString(), "abc");
  assert.equal((await r.read(0))?.length, 0 as number | undefined);
});

test("Covers: SG-R-LAY-04 SG-I-02 - a limit hit never looks like the end of the stream", async () => {
  for (const size of [1, 100, 1 << 20]) {
    const r = reader(gz(Buffer.alloc(100_000)), "gzip", limits(1000));
    let total = 0;
    await assert.rejects(async () => { for (let c = await r.read(size); c !== null; c = await r.read(size)) total += c.length; }, OutputLimitError);
    assert.equal(total, 1000);
  }
});

test("Covers: SG-R-API-02 SG-R-LAY-06 - readAll returns no data on error", async () => {
  await assert.rejects(decodeAll(gz(Buffer.alloc(100_000)), "gzip", limits(1000)), OutputLimitError);
});

test("Covers: SG-R-LAY-06 - streaming may deliver bytes before a later error", async () => {
  const stream = Buffer.from(gz(Buffer.from(Array.from({ length: 25_600 }, (_, i) => i & 255))));
  stream[stream.length - 6] = (stream[stream.length - 6] as number) ^ 0xff; // damage the CRC
  const r = reader(stream, "gzip", LOOSE);
  let delivered = 0;
  await assert.rejects(async () => { for (let c = await r.read(64); c !== null; c = await r.read(64)) delivered += c.length; }, CorruptError);
  assert.equal(delivered, 25_600);
});

test("Covers: SG-R-RDR-06 SG-I-10 - close is idempotent, reads after close fail", async () => {
  const r = reader(gz(Buffer.from("abc")), "gzip", LOOSE);
  await r.read(1);
  r.close();
  r.close();
  await assert.rejects(r.read(1), ClosedError);
  await assert.rejects(r.readAll(), ClosedError);
});

test("Covers: SG-R-RDR-06 - the async iterator reads to the end and closes, also when left early", async () => {
  const chunks: Uint8Array[] = [];
  const r = reader(gz(Buffer.from("iterate".repeat(1000))), "gzip", LOOSE);
  for await (const chunk of r) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).length, 7000);
  await assert.rejects(r.read(1), ClosedError);
  const early = reader(gz(Buffer.alloc(1_000_000)), "gzip", LOOSE);
  for await (const chunk of early) { assert.ok(chunk.length > 0); break; }
  await assert.rejects(early.read(1), ClosedError);
});

test("Covers: SG-R-RDR-07 - concurrent reads on one reader are refused, distinct readers are independent", async () => {
  const dec = new Decoder(LOOSE);
  const a = dec.reader(gz(Buffer.alloc(1000, 65)), "gzip");
  const b = dec.reader(gz(Buffer.alloc(1000, 66)), "gzip");
  const pending = a.read(10);
  await assert.rejects(a.read(10), /concurrent/);
  assert.equal((await pending)?.[0], 65);
  assert.equal((await b.read(10))?.[0], 66);
  a.close();
  assert.equal((await b.readAll()).length, 990);
});

test("Covers: SG-R-RDR-01 - the stream interface delivers the same bytes", async () => {
  const payload = Buffer.from("web streams ".repeat(1000));
  const stream = reader(gz(payload), "gzip", LOOSE).toReadableStream();
  const parts: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(chunk);
  assert.ok(Buffer.concat(parts).equals(payload));
  const failing = reader(gz(Buffer.alloc(100_000)), "gzip", limits(10)).toReadableStream();
  await assert.rejects(async () => { for await (const _ of failing as unknown as AsyncIterable<Uint8Array>) { /* drain */ } }, OutputLimitError);
});

// -- hostile sources -----------------------------------------------------------------------------

test("Covers: SG-R-RDR-05 - a source that throws is source_error with the original as cause", async () => {
  const boom = new Error("connection reset");
  for (const encoding of ["gzip", "deflate", "identity"]) {
    const source = { read: (): never => { throw boom; } };
    await assert.rejects(decodeAll(source, encoding, LOOSE), (e: SourceError) => e instanceof SourceError && e.cause === boom && e.layer === 1, encoding);
  }
  const rejecting = { read: () => Promise.reject(boom) };
  await assert.rejects(decodeAll(rejecting, "gzip", LOOSE), SourceError);
  const asyncIterable = { async *[Symbol.asyncIterator]() { yield Buffer.from([0x1f]); throw boom; } };
  await assert.rejects(decodeAll(asyncIterable, "gzip", LOOSE), (e: SourceError) => e instanceof SourceError && e.cause === boom);
});

test("Covers: SG-R-RDR-05 SG-R-LAY-05 - a source error is sticky", async () => {
  const r = reader({ read: (): never => { throw new Error("x"); } }, "gzip", LOOSE);
  for (let i = 0; i < 3; i++) await assert.rejects(r.read(10), SourceError);
});

test("Covers: SG-R-CDC-06 SG-R-RDR-05 - a truncated source is corrupt, not source_error", async () => {
  const stream = gz(Buffer.from("abc".repeat(1000)));
  for (const cut of [0, 1, 5, 10, 12, stream.length >> 1, stream.length - 1]) {
    assert.equal((await outcome(stream.subarray(0, cut), "gzip"))[0], "corrupt", String(cut));
  }
});

test("Covers: SG-R-RDR-03 - a source that makes no progress is internal", async () => {
  let calls = 0;
  await assert.rejects(decodeAll({ read: () => { calls++; return new Uint8Array(0); } }, "gzip", LOOSE), InternalError);
  assert.equal(calls, 100);
});

test("Covers: SG-R-RDR-04 - a source that returns too much or the wrong type is internal", async () => {
  await assert.rejects(decodeAll({ read: (max: number) => new Uint8Array(max + 1) }, "identity", LOOSE), InternalError);
  await assert.rejects(decodeAll({ read: () => "text" as unknown as Uint8Array }, "identity", LOOSE), InternalError);
  const strings = { async *[Symbol.asyncIterator]() { yield "text" as unknown as Uint8Array; } };
  await assert.rejects(decodeAll(strings, "identity", LOOSE), InternalError);
});

test("Covers: SG-R-API-01 - every kind of source works", async () => {
  const payload = Buffer.from("sources".repeat(500));
  const stream = gz(payload);
  const chunks = [stream.subarray(0, 7), stream.subarray(7, 100), stream.subarray(100)];
  const sources = [
    stream,
    new Uint8Array(stream),
    stream.buffer.slice(stream.byteOffset, stream.byteOffset + stream.length) as ArrayBuffer,
    chunks,
    (async function* () { yield* chunks; })(),
    new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(new Uint8Array(chunk)); c.close(); } }),
    new Trickle(stream, 13),
  ];
  for (const source of sources) assert.ok(Buffer.from(await decodeAll(source as never, "gzip", LOOSE)).equals(payload));
  assert.throws(() => reader(42 as never, "gzip", LOOSE), TypeError);
  assert.throws(() => reader("text" as never, "gzip", LOOSE), TypeError);
  assert.throws(() => reader(null as never, "gzip", LOOSE), TypeError);
});

test("Covers: SG-R-API-04 - the AbortSignal is observed per read and sticky", async () => {
  const controller = new AbortController();
  const r = reader(gz(Buffer.alloc(2_000_000)), "gzip", LOOSE, { signal: controller.signal });
  assert.ok((await r.read(100))!.length > 0);
  controller.abort(new Error("stop"));
  for (let i = 0; i < 3; i++) await assert.rejects(r.read(100), CanceledError);
  const before = new AbortController();
  before.abort();
  const source = new Trickle(gz(Buffer.from("abc")));
  await assert.rejects(reader(source, "gzip", LOOSE, { signal: before.signal }).read(10), CanceledError);
  assert.equal(source.total, 0);
});

// -- extension codecs ------------------------------------------------------------------------------

const foreverZeros: Codec = { newReader: () => ({ read: async (n) => new Uint8Array(n) }) };

test("Covers: SG-R-CDC-01 SG-R-CDC-09 SG-I-01 - an extension codec is bounded by the same limiter", async () => {
  await assert.rejects(new Decoder(limits(1000), { codecs: { zeros: foreverZeros } }).readAll(Buffer.from("a"), "zeros"), OutputLimitError);
  await assert.rejects(new Decoder({ maxOutput: 1e9, maxRatio: 10, ratioGrace: 0 }, { codecs: { zeros: foreverZeros } }).readAll(Buffer.from("abc"), "zeros"), RatioLimitError);
});

test("Covers: SG-R-CDC-08 SG-I-05 - a misbehaving codec is internal and leaks no data", async () => {
  const behaviors: Record<string, () => unknown> = {
    throws: () => { throw new TypeError("secret attacker data"); },
    tooMuch: () => new Uint8Array(1 << 20),
    undefinedValue: () => undefined,
    nullValue: () => null,
    string: () => "abc",
    notUint8: () => new Uint16Array(4),
    rejects: () => Promise.reject(new RangeError("secret")),
  };
  for (const [name, read] of Object.entries(behaviors)) {
    const codec: Codec = { newReader: () => ({ read: read as never }) };
    await assert.rejects(new Decoder(LOOSE, { codecs: { bad: codec } }).readAll(Buffer.from("abc"), "bad"), (e: InternalError) => e instanceof InternalError && !/secret/.test(String(e)), name);
  }
});

test("Covers: SG-R-CDC-08 SG-I-05 - a codec that fails to construct or close is contained", async () => {
  const noConstruct: Codec = { newReader: () => { throw new Error("no"); } };
  assert.throws(() => new Decoder(LOOSE, { codecs: { bad: noConstruct } }).reader(Buffer.from("abc"), "bad"), InternalError);
  let closes = 0;
  const noClose: Codec = { newReader: () => ({ read: async () => new Uint8Array(0), close: () => { closes++; throw new Error("close failed"); } }) };
  const r = new Decoder(LOOSE, { codecs: { bad: noClose } }).reader(Buffer.from("abc"), "bad");
  assert.doesNotThrow(() => r.close());
  assert.equal(closes, 1);
});

test("Covers: SG-R-CDC-04 SG-R-CDC-09 - a codec can throw its own spillgate error", async () => {
  const refuses: Codec = { newReader: () => ({ read: async () => { throw new CorruptError("my format is broken"); } }) };
  await assert.rejects(new Decoder(LOOSE, { codecs: { mine: refuses } }).readAll(Buffer.from("x"), "mine"), (e: CorruptError) => e instanceof CorruptError && e.layer === 1);
});

test("Covers: SG-R-CDC-09 - codec names are checked", () => {
  for (const name of ["identity", "gzip", "deflate", "x-gzip", "GZIP", "Has Space", "", "x".repeat(40), "a;b"]) {
    assert.throws(() => new Decoder(LOOSE, { codecs: { [name]: foreverZeros } }), InvalidOptionError, name);
  }
  assert.throws(() => new Decoder(LOOSE, { codecs: { fine: {} as never } }), InvalidOptionError);
});

test("Covers: SG-R-CDC-09 - registered codecs are per decoder, not global", async () => {
  new Decoder(LOOSE, { codecs: { zeros: foreverZeros } });
  assert.throws(() => new Decoder(LOOSE).reader(Buffer.alloc(0), "zeros"), UnsupportedEncodingError);
});

test("Covers: SG-R-RDR-07 - a decoder can be shared by many concurrent readers", async () => {
  const dec = new Decoder(LOOSE);
  const payloads = Array.from({ length: 16 }, (_, i) => Buffer.alloc(2000 + i, i));
  const results = await Promise.all(payloads.map((p) => dec.readAll(gz(p), "gzip")));
  results.forEach((r, i) => assert.ok(Buffer.from(r).equals(payloads[i] as Buffer)));
});

test("Covers: SG-R-API-01 - a decoder needs limits", () => {
  assert.throws(() => new (Decoder as unknown as new () => Decoder)(), Error);
});

test("Covers: SG-R-LAY-09 - after a terminal condition the source is not read again", async () => {
  const source = new Trickle(Buffer.concat([gz(Buffer.alloc(100_000)), Buffer.alloc(1000, 120)]), 50);
  const r = reader(source, "gzip", limits(100));
  await assert.rejects(async () => { while (await r.read(64)) { /* drain */ } }, OutputLimitError);
  const taken = source.total;
  for (let i = 0; i < 5; i++) await assert.rejects(r.read(64), OutputLimitError);
  assert.equal(source.total, taken);
});

test("Covers: SG-R-LAY-09 SG-R-RAT-02 - look-ahead beyond what the codec needed is bounded", async () => {
  const stream = gz(Buffer.from("short"));
  const source = new Trickle(Buffer.concat([stream, Buffer.alloc(1_000_000)]), 1_000_000);
  await assert.rejects(decodeAll(source, "gzip", LOOSE), CorruptError);
  assert.ok(source.total <= stream.length + 64 * 1024);
});

test("Covers: SG-R-API-05 - every failure has a machine-checkable kind, layer and limit", async () => {
  await assert.rejects(decodeAll(gz(Buffer.alloc(1000)), "gzip", limits(10)), (e: OutputLimitError) => {
    assert.ok(e instanceof SpillgateError);
    assert.deepEqual([e.kind, e.layer, e.limit], ["output_limit", 1, 10]);
    return true;
  });
});

test("Covers: SG-R-API-05 - statusFor maps every outcome class to an HTTP status", async () => {
  const { statusFor, MemoryLimitError, LayerLimitError, InvalidLimitsError, MalformedEncodingError } = await import("../src/index.js");
  assert.equal(statusFor(undefined), 0);
  assert.equal(statusFor(new Error("boom")), 500);
  const expected: [SpillgateError, number][] = [
    [new OutputLimitError("x"), 413], [new RatioLimitError("x"), 413], [new InputLimitError("x"), 413], [new LayerLimitError("x"), 413],
    [new UnsupportedEncodingError("x"), 415], [new MalformedEncodingError("x"), 400], [new CorruptError("x"), 400], [new SourceError("x"), 400],
    [new MemoryLimitError("x"), 503], [new CanceledError("x"), 503], [new InternalError("x"), 500], [new InvalidLimitsError("x"), 500],
  ];
  for (const [error, status] of expected) assert.equal(statusFor(error), status, error.kind);
});
