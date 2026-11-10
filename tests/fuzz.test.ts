/** Property and differential tests: invariants that must hold for any input, checked against node:zlib. */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { test } from "node:test";
import { Decoder, SpillgateError, type Limits } from "../src/index.js";
import { gz, prng, randomBytes, raw, zl } from "./helpers.js";

const ENCODINGS = ["gzip", "deflate", "identity", "gzip, gzip", "deflate, gzip", "x-gzip"];
const PERMITTED = new Set(["ok", "corrupt", "output_limit", "ratio_limit", "input_limit", "layer_limit", "unsupported_encoding", "malformed_encoding"]);

/** Decode with a cyclic read pattern; return the delivered bytes and the outcome class. */
async function run(source: Uint8Array, encodings: string, limits: Limits, sizes: number[]): Promise<[Buffer, string]> {
  const out: Buffer[] = [];
  let reader;
  try {
    reader = new Decoder(limits).reader(source, encodings);
  } catch (error) {
    assert.ok(error instanceof SpillgateError, String(error));
    return [Buffer.alloc(0), error.kind];
  }
  try {
    for (let i = 0; ; i++) {
      const chunk = await reader.read(sizes[i % sizes.length] as number);
      if (chunk === null) return [Buffer.concat(out), "ok"];
      out.push(Buffer.from(chunk));
    }
  } catch (error) {
    assert.ok(error instanceof SpillgateError, `foreign error ${String(error)}`);
    return [Buffer.concat(out), error.kind];
  } finally {
    reader.close();
  }
}

const rounds = Number(process.env["SPILLGATE_FUZZ_ROUNDS"] ?? 300);

test("Covers: SG-I-01 SG-I-02 SG-I-05 SG-R-CDC-08 - random bytes never break an invariant", async () => {
  const random = prng(1);
  for (let i = 0; i < rounds * 3; i++) {
    const source = randomBytes(random, Math.floor(random() * 600));
    // make some of them look like a real header so the codecs get past the first bytes
    if (source.length >= 3 && random() < 0.4) source.set([0x1f, 0x8b, 8], 0);
    if (source.length >= 2 && random() < 0.2) source.set([0x78, 0x9c], 0);
    const encodings = ENCODINGS[Math.floor(random() * ENCODINGS.length)] as string;
    const maxOutput = 1 + Math.floor(random() * 3000);
    const sizes = [1 + Math.floor(random() * 5000), 1 + Math.floor(random() * 50)];
    const [out, kind] = await run(source, encodings, { maxOutput }, sizes);
    assert.ok(out.length <= maxOutput);
    assert.ok(PERMITTED.has(kind), kind);
  }
});

test("Covers: SG-R-RDR-01 SG-I-09 - valid data round-trips whatever the read sizes, and equals node:zlib", async () => {
  const random = prng(2);
  const makers = { gzip: gz, deflate: zl, raw } as const;
  for (let i = 0; i < rounds; i++) {
    const payload = random() < 0.3 ? Buffer.alloc(Math.floor(random() * 4000), Math.floor(random() * 256)) : randomBytes(random, Math.floor(random() * 3000));
    const pick = (["gzip", "deflate", "raw"] as const)[Math.floor(random() * 3)] as keyof typeof makers;
    const stream = makers[pick](payload);
    const encoding = pick === "gzip" ? "gzip" : "deflate";
    const limits = { maxOutput: payload.length + 10, disableRatioLimit: true };
    const first = await run(stream, encoding, limits, [1 + Math.floor(random() * 700)]);
    assert.deepEqual([first[0].equals(payload), first[1]], [true, "ok"]);
    const second = await run(stream, encoding, limits, [1 + Math.floor(random() * 70000)]);
    assert.ok(second[0].equals(first[0]) && second[1] === "ok");
    if (pick === "raw") assert.ok(zlib.inflateRawSync(stream).equals(first[0])); // the oracle agrees
  }
});

test("Covers: SG-R-LAY-03 SG-I-01 - the output limit is exact for any payload", async () => {
  const random = prng(3);
  for (let i = 0; i < rounds; i++) {
    const payload = randomBytes(random, 1 + Math.floor(random() * 2000));
    const stream = [gz, zl, raw][i % 3]!(payload);
    const encoding = i % 3 === 0 ? "gzip" : "deflate";
    const n = payload.length;
    const at = await run(stream, encoding, { maxOutput: n + Math.floor(random() * 3), disableRatioLimit: true }, [97]);
    assert.deepEqual([at[0].equals(payload), at[1]], [true, "ok"]);
    if (n > 1) {
      const under = await run(stream, encoding, { maxOutput: n - 1, disableRatioLimit: true }, [97]);
      assert.equal(under[1], "output_limit");
      assert.ok(under[0].equals(payload.subarray(0, n - 1)));
    }
  }
});

test("Covers: SG-I-05 SG-R-CDC-02 SG-R-CDC-03 SG-R-CDC-06 - damaged streams are ok or corrupt, never something else", async () => {
  const random = prng(4);
  for (let i = 0; i < rounds * 2; i++) {
    const payload = randomBytes(random, 1 + Math.floor(random() * 800));
    const stream = Buffer.from([gz, zl, raw][i % 3]!(payload));
    const encoding = i % 3 === 0 ? "gzip" : "deflate";
    for (let flips = 1 + Math.floor(random() * 4); flips > 0; flips--) {
      const at = Math.floor(random() * stream.length);
      stream[at] = (stream[at] as number) ^ (1 << Math.floor(random() * 8));
    }
    const damaged = random() < 0.3 ? stream.subarray(0, Math.floor(random() * stream.length)) : stream;
    const [, kind] = await run(damaged, encoding, { maxOutput: 1e6, disableRatioLimit: true }, [4096]);
    assert.ok(kind === "ok" || kind === "corrupt", kind);
  }
});

test("Covers: SG-I-05 SG-I-06 SG-R-HDR-13 - arbitrary header text gives a typed error or a decoder", () => {
  const random = prng(5);
  const alphabet = ["gzip", "deflate", "identity", ",", " ", ";", "\n", "x-gzip", "é", "\u0000", "br", "q=1", "\"", "A", "-", "."];
  for (let i = 0; i < rounds * 5; i++) {
    const parts = Array.from({ length: Math.floor(random() * 6) }, () => Array.from({ length: Math.floor(random() * 8) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(""));
    try {
      new Decoder({ maxOutput: 10 }).reader(Buffer.alloc(0), parts);
    } catch (error) {
      assert.ok(error instanceof SpillgateError, String(error));
      assert.ok(["malformed_encoding", "unsupported_encoding", "layer_limit"].includes(error.kind));
      assert.ok(!/[\n\r]/.test(error.message) && error.message.length < 400);
    }
  }
});
