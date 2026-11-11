/**
 * SG-R-INP-01 as written (corpus 0.2.0): a codec TAKING the MaxInput+1-th byte is `input_limit`;
 * looking at it is not. Every case runs against several source shapes and read patterns.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import {
  CorruptError,
  Decoder,
  InputLimitError,
  SpillgateError,
  type Codec,
  type CodecReader,
  type CodecSource,
} from "../src/index.js";
import { InputMeter } from "../src/meter.js";
import { concat, gz, prng, zl } from "./helpers.js";
import { PATTERNS, SHAPES, coreStreams, decodeProbe, forEachRun, LIMITS, type Shape, type Stream } from "./probe_support.js";

const label = (shape: Shape, pattern: number[]): string => `${shape.name} read ${pattern.join(",")}`;

// -- (1) and (3): a complete stream of exactly MaxInput bytes followed by data is corrupt ---------

test("Covers: SG-R-INP-01 SG-R-INP-02 SG-R-CDC-02 SG-R-CDC-03 - data after a complete stream is corrupt, not input_limit", async () => {
  for (const s of coreStreams()) {
    const L = s.stream.length;
    const tails = [Buffer.from([0]), Buffer.alloc(1000)];
    for (const tail of tails) {
      await forEachRun(async (shape, pattern) => {
        for (const maxInput of [L, L + 1]) {
          const { kind, handed } = await decodeProbe(concat(s.stream, tail), maxInput, shape, pattern, s.encoding);
          const where = `${s.name}, tail ${tail.length}, MaxInput ${maxInput}, ${label(shape, pattern)}`;
          assert.equal(kind, "corrupt", where);
          assert.ok(handed <= maxInput + 1, `${where}: source handed out ${handed} bytes`);
        }
      });
    }
  }
});

test("Covers: SG-R-INP-01 - a stream of exactly MaxInput bytes with nothing after it is fine", async () => {
  for (const s of coreStreams()) {
    await forEachRun(async (shape, pattern) => {
      for (const maxInput of [s.stream.length, s.stream.length + 1]) {
        const { kind, got } = await decodeProbe(s.stream, maxInput, shape, pattern, s.encoding);
        assert.equal(kind, "ok", `${s.name} MaxInput ${maxInput} ${label(shape, pattern)}`);
        assert.ok(got.equals(s.plain));
      }
    });
  }
});

// -- (2): a stream that needs byte MaxInput+1 is input_limit; if the source ends there it is truncated

test("Covers: SG-R-INP-01 SG-R-INP-02 SG-R-CDC-06 - a stream cut at the limit: input_limit if the source goes on, corrupt if it ends", async () => {
  for (const s of coreStreams()) {
    const L = s.stream.length;
    const cuts = [1, 5, 9, 10, 11, Math.floor(L / 3), Math.floor(L / 2), L - 9, L - 5, L - 1].filter((k) => k > 0 && k < L);
    await forEachRun(async (shape, pattern) => {
      for (const k of cuts) {
        const where = `${s.name}, cut ${k} of ${L}, ${label(shape, pattern)}`;
        assert.equal((await decodeProbe(s.stream.subarray(0, k), k, shape, pattern, s.encoding)).kind, "corrupt", `source ends at MaxInput: ${where}`);
        const more = await decodeProbe(concat(s.stream, Buffer.alloc(50)), k, shape, pattern, s.encoding);
        assert.equal(more.kind, "input_limit", `source goes on: ${where}`);
        assert.ok(more.handed <= k + 1, `${where}: source handed out ${more.handed} bytes`);
        const garbage = concat(s.stream.subarray(0, k), Buffer.alloc(50, 0xa5));
        assert.equal((await decodeProbe(garbage, k, shape, pattern, s.encoding)).kind, "input_limit", `garbage after the limit: ${where}`);
      }
    });
  }
});

test("Covers: SG-R-INP-01 - the byte after a gzip member that could begin another member (0x1f) is taken", async () => {
  const s = coreStreams()[0] as Stream;
  const L = s.stream.length;
  const input = concat(s.stream, Buffer.from([0x1f]));
  await forEachRun(async (shape, pattern) => {
    assert.equal((await decodeProbe(input, L, shape, pattern, "gzip")).kind, "input_limit", `MaxInput ${L} ${label(shape, pattern)}`);
    assert.equal((await decodeProbe(input, L + 1, shape, pattern, "gzip")).kind, "corrupt", `MaxInput ${L + 1} ${label(shape, pattern)}`);
  });
});

test("Covers: SG-R-INP-01 - a source that ends one byte before the stream does is truncated", async () => {
  const s = coreStreams()[0] as Stream;
  await forEachRun(async (shape, pattern) => {
    const k = s.stream.length - 1;
    assert.equal((await decodeProbe(s.stream.subarray(0, k), k, shape, pattern, "gzip")).kind, "corrupt");
  });
});

// -- identity keeps the strict behavior -----------------------------------------------------------

test("Covers: SG-R-INP-01 SG-R-CDC-10 - identity stops at the limit after exactly MaxInput delivered bytes", async () => {
  const body = Buffer.alloc(300);
  const rand = prng(9);
  for (let i = 0; i < body.length; i++) body[i] = Math.floor(rand() * 256);
  for (const encodings of [[], ["identity"]]) {
    await forEachRun(async (shape, pattern) => {
      const L = body.length - 1;
      const short = await decodeProbe(body, L, shape, pattern, encodings);
      assert.equal(short.kind, "input_limit");
      assert.ok(short.got.equals(body.subarray(0, L)), "delivered exactly MaxInput bytes");
      assert.ok(short.handed <= L + 1);
      const long = await decodeProbe(concat(body, Buffer.alloc(1000)), body.length, shape, pattern, encodings);
      assert.equal(long.kind, "input_limit");
      assert.equal(long.got.length, body.length);
      const exact = await decodeProbe(body, body.length, shape, pattern, encodings);
      assert.equal(exact.kind, "ok");
      assert.ok(exact.got.equals(body));
    });
  }
});

// -- chains: only layer 1 has MaxInput -------------------------------------------------------------

test("Covers: SG-R-INP-01 SG-R-INP-02 - in a chain only layer 1 carries MaxInput", async () => {
  const zeros = Buffer.alloc(8000);
  const inner = zlib.gzipSync(zeros, { level: 0 }); // about 8 KB
  const outer = gz(inner);
  assert.ok(outer.length * 10 < inner.length, "the outer layer expands a lot");
  const L = outer.length;
  await forEachRun(async (shape, pattern) => {
    const exact = await decodeProbe(outer, L, shape, pattern, ["gzip", "gzip"]);
    assert.equal(exact.kind, "ok", label(shape, pattern));
    assert.equal(exact.got.length, zeros.length);
    for (const tail of [Buffer.from([0]), Buffer.alloc(500)]) {
      for (const maxInput of [L, L + 1]) {
        const r = await decodeProbe(concat(outer, tail), maxInput, shape, pattern, ["gzip", "gzip"]);
        assert.equal(r.kind, "corrupt", `tail ${tail.length}, MaxInput ${maxInput}, ${label(shape, pattern)}`);
        assert.ok(r.handed <= maxInput + 1);
      }
    }
    assert.equal((await decodeProbe(outer, L - 1, shape, pattern, ["gzip", "gzip"])).kind, "input_limit");
  });
  assert.equal((await decodeProbe(concat(outer, Buffer.from([0])), L, SHAPES[0] as Shape, [4096], ["identity", "gzip", "gzip"])).kind, "corrupt");
});

// -- the end-of-step check, with a custom codec ----------------------------------------------------

test("Covers: SG-R-INP-01 SG-R-RAT-02 - taking is checked at the end of every codec step, whatever the codec returned", async () => {
  const M = 5;
  const source = Buffer.alloc(100, 1);
  type Step = (src: CodecSource) => Promise<Uint8Array>;
  const takeBytes = async (src: CodecSource, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) assert.equal((await src.take(1)).length, 1);
  };
  const steps: Record<string, [Step, string]> = {
    "takes MaxInput+1 bytes and returns data": [async (src) => (await takeBytes(src, M + 1), Buffer.from([7])), "input_limit"],
    "takes MaxInput+1 bytes and ends cleanly": [async (src) => (await takeBytes(src, M + 1), new Uint8Array(0)), "input_limit"],
    "takes MaxInput+1 bytes and reports corrupt": [
      async (src) => {
        await takeBytes(src, M + 1);
        throw new CorruptError("made up");
      },
      "input_limit",
    ],
    "takes MaxInput+1 bytes in one takeExact": [async (src) => (await src.takeExact(M + 1, "x"), new Uint8Array(0)), "input_limit"],
    "asks for a buffer much larger than MaxInput and keeps all it gets": [
      async (src) => {
        let total = 0;
        for (let chunk = await src.take(64); chunk.length > 0; chunk = await src.take(64)) {
          total += chunk.length;
          if (total > M) break;
        }
        assert.equal(total, M + 1);
        return new Uint8Array(0);
      },
      "input_limit",
    ],
    "takes MaxInput bytes and ends cleanly": [async (src) => (await takeBytes(src, M), new Uint8Array(0)), "ok"],
    "looks at the probe and gives it back": [
      async (src) => {
        await takeBytes(src, M);
        src.unread(await src.take(1));
        return new Uint8Array(0);
      },
      "ok",
    ],
    "looks at the probe with a bulk take and gives it back": [
      async (src) => {
        assert.equal((await src.takeExact(M, "x")).length, M); // the probe is never handed out with them
        const probe = await src.take(64);
        assert.equal(probe.length, 1);
        src.unread(probe);
        return new Uint8Array(0);
      },
      "ok",
    ],
    "finds trailing data behind the probe and reports it": [
      async (src) => {
        await takeBytes(src, M);
        src.unread(await src.take(1));
        throw new CorruptError("trailing data");
      },
      "corrupt",
    ],
    "cannot go on without the probe and asks for more": [
      async (src) => {
        await takeBytes(src, M + 1);
        return src.take(1); // MaxInput+2 is never available
      },
      "input_limit",
    ],
  };
  for (const [name, [step, want]] of Object.entries(steps)) {
    for (const shape of SHAPES) {
      const codec: Codec = {
        newReader(src): CodecReader {
          return { read: () => step(src) };
        },
      };
      const made = shape.make(source);
      const reader = new Decoder({ ...LIMITS, maxInput: M }, { codecs: { x: codec } }).reader(made.source, "x");
      const kind = await reader.readAll().then(
        () => "ok",
        (e: unknown) => (e instanceof SpillgateError ? e.kind : "other"),
      );
      reader.close();
      assert.equal(kind, want, `${name} / ${shape.name}`);
      assert.ok(made.handed() - made.slack <= M + 1, `${name} / ${shape.name}: source handed out ${made.handed()} bytes`);
    }
  }
});

// -- unit tests of the meter ----------------------------------------------------------------------

function counting(size: number): { next(max: number): Promise<Uint8Array | null>; handed: () => number } {
  let pos = 0;
  return {
    next(max) {
      if (pos >= size) return Promise.resolve(null);
      const n = Math.min(max, size - pos);
      pos += n;
      return Promise.resolve(Buffer.alloc(n, 9));
    },
    handed: () => pos,
  };
}

test("Covers: SG-R-INP-01 SG-R-INP-02 - the codec view hands out the probe alone, never more, and the strict view never", async () => {
  for (const maxInput of [1, 2, 4095, 4096, 4097, 5000]) {
    const src = counting(10000);
    const meter = new InputMeter(src, maxInput, 1);
    let taken = 0;
    let error: unknown;
    try {
      for (;;) {
        const chunk = await meter.take(333);
        if (chunk.length === 0) break;
        taken += chunk.length;
      }
    } catch (e) {
      error = e;
    }
    assert.equal(taken, maxInput + 1, `MaxInput ${maxInput}`);
    assert.ok(error instanceof InputLimitError);
    assert.equal(src.handed(), maxInput + 1);
    assert.throws(() => meter.checkTaken(), InputLimitError);

    const strictSrc = counting(10000);
    const strict = new InputMeter(strictSrc, maxInput, 1);
    let strictTaken = 0;
    await assert.rejects(async () => {
      for (;;) strictTaken += (await strict.take(333, true)).length;
    }, InputLimitError);
    assert.equal(strictTaken, maxInput, "the strict view never hands out the probe");
    strict.checkTaken(); // nothing over the limit was taken
  }
});

test("Covers: SG-R-INP-01 - unread gives the probe back and lowers the count", async () => {
  const meter = new InputMeter(counting(10), 4, 1);
  assert.equal((await meter.take(64)).length, 4);
  const probe = await meter.take(64);
  assert.equal(probe.length, 1);
  assert.equal(meter.consumed, 5);
  assert.throws(() => meter.checkTaken(), InputLimitError);
  const again = new InputMeter(counting(10), 4, 1);
  await again.take(64);
  again.unread(await again.take(64));
  assert.equal(again.consumed, 4);
  again.checkTaken();
  assert.equal((await again.take(64)).length, 1, "the probe can be taken again");
  assert.equal(again.consumed, 5);
});

test("Covers: SG-R-INP-01 - a source that ends at the limit has no probe", async () => {
  const meter = new InputMeter(counting(4), 4, 1);
  assert.equal((await meter.take(64)).length, 4);
  assert.equal((await meter.take(64)).length, 0);
  meter.checkTaken();
});
