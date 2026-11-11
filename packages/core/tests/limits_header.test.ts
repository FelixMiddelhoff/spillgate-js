/**
 * Limits (SPEC section 3) and Content-Encoding parsing (section 4).
 *
 * Every test names the rules it protects after "Covers:" in its title; tools/spectrace.ts reads it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Decoder,
  InvalidLimitsError,
  LayerLimitError,
  MalformedEncodingError,
  UnsupportedEncodingError,
} from "../src/index.js";
import { quoteUntrusted } from "../src/errors.js";
import { parseContentEncoding } from "../src/header.js";
import { EffectiveLimits, type Limits } from "../src/limits.js";

const INT64 = (1n << 63n) - 1n;
const bad = (limits: unknown): void => {
  assert.throws(() => EffectiveLimits.from(limits as Limits), InvalidLimitsError);
};

// -- limits ------------------------------------------------------------------------------------

test("Covers: SG-R-LIM-01 SG-R-API-01 - maxOutput is required", () => {
  bad({});
  bad({ maxOutput: undefined });
  bad({ maxOutput: null });
  bad(undefined);
  bad(null);
  bad("limits");
  assert.throws(() => new Decoder({} as Limits), InvalidLimitsError);
});

test("Covers: SG-R-LIM-01 SG-R-LIM-02 SG-R-LIM-07 - maxOutput must be a positive integer up to 2**63-1", () => {
  for (const value of [0, -1, -(2 ** 53), 1.5, 0.1, NaN, Infinity, -Infinity, "1", true, false, [], {}, 2 ** 53, 2 ** 60, 0n, -1n, INT64 + 1n]) {
    bad({ maxOutput: value });
  }
  for (const value of [1, 2, 1 << 20, Number.MAX_SAFE_INTEGER, 1n, INT64]) {
    assert.doesNotThrow(() => EffectiveLimits.from({ maxOutput: value }));
  }
});

test("Covers: SG-R-LIM-02 - a limit above 2**53-1 behaves like 2**53-1", () => {
  const effective = EffectiveLimits.from({ maxOutput: INT64 });
  assert.equal(effective.maxOutput, Number.MAX_SAFE_INTEGER);
});

test("Covers: SG-R-LIM-03 SG-R-LIM-07 - maxLayers range", () => {
  for (const value of [0, -1, 17, 1.5, NaN, "5", true, 17n]) bad({ maxOutput: 1, maxLayers: value });
  for (const value of [1, 5, 16]) assert.equal(EffectiveLimits.from({ maxOutput: 1, maxLayers: value }).maxLayers, value);
  assert.equal(EffectiveLimits.from({ maxOutput: 1 }).maxLayers, 5);
});

test("Covers: SG-R-LIM-04 SG-R-LIM-07 - no numeric maxRatio disables the check", () => {
  for (const value of [0, -1, 2 ** 31, 1.5, NaN, Infinity, "1000", true, null]) bad({ maxOutput: 1, maxRatio: value });
  assert.equal(EffectiveLimits.from({ maxOutput: 1, maxRatio: 2 ** 31 - 1 }).maxRatio, 2 ** 31 - 1);
  assert.equal(EffectiveLimits.from({ maxOutput: 1 }).maxRatio, 1000);
});

test("Covers: SG-R-LIM-04 SG-R-RAT-04 - the opt-out is distinct and cannot be combined", () => {
  assert.equal(EffectiveLimits.from({ maxOutput: 1, disableRatioLimit: true }).maxRatio, 0);
  bad({ maxOutput: 1, maxRatio: 10, disableRatioLimit: true });
  bad({ maxOutput: 1, disableRatioLimit: 1 });
  bad({ maxOutput: 1, disableRatioLimit: "yes" });
  assert.equal(EffectiveLimits.from({ maxOutput: 1, disableRatioLimit: false }).maxRatio, 1000);
});

test("Covers: SG-R-LIM-05 - ratioGrace may be zero, never negative", () => {
  for (const value of [-1, -1n, 1.5, NaN, "0", true]) bad({ maxOutput: 1, ratioGrace: value });
  assert.equal(EffectiveLimits.from({ maxOutput: 1, ratioGrace: 0 }).ratioGrace, 0);
  assert.equal(EffectiveLimits.from({ maxOutput: 1 }).ratioGrace, 65536);
  const e = EffectiveLimits.from({ maxOutput: 10, maxRatio: 2, ratioGrace: 0 });
  assert.ok(e.ratioExceeded(3, 1));
  assert.ok(!e.ratioExceeded(2, 1));
});

test("Covers: SG-R-LIM-06 - maxInput zero does not mean unlimited", () => {
  for (const value of [0, -1, 1.5, NaN, "5", true, 0n]) bad({ maxOutput: 1, maxInput: value });
  assert.equal(EffectiveLimits.from({ maxOutput: 1 }).maxInput, 0);
  assert.equal(EffectiveLimits.from({ maxOutput: 1, maxInput: 7 }).maxInput, 7);
});

test("Covers: SG-R-LIM-08 SG-R-LIM-09 - validated at construction and captured by value", () => {
  const limits = { maxOutput: 100 };
  const decoder = new Decoder(limits);
  limits.maxOutput = -5; // later changes do not matter
  assert.ok(decoder);
  // a getter that lies on the second read cannot split validation from use
  let calls = 0;
  const tricky = { get maxOutput() { return calls++ === 0 ? 10 : -1; } } as Limits;
  assert.doesNotThrow(() => EffectiveLimits.from(tricky));
});

test("Covers: SG-R-RAT-01 - the ratio boundary is exact and cannot overflow", () => {
  const e = EffectiveLimits.from({ maxOutput: 2 ** 53 - 1, maxRatio: 10, ratioGrace: 100 });
  assert.ok(!e.ratioExceeded(100, 1)); // inside the grace
  assert.ok(!e.ratioExceeded(10 * 50, 50)); // exactly at the ratio
  assert.ok(e.ratioExceeded(10 * 50 + 1, 50)); // one byte over
  assert.ok(e.ratioExceeded(101, 0)); // consumed counts as at least 1
  assert.ok(!e.ratioExceeded(Number.MAX_SAFE_INTEGER, 2 ** 52)); // the product exceeds 2**53: never exceeded
  assert.ok(e.ratioExceeded(Number.MAX_SAFE_INTEGER, 1));
});

// -- header --------------------------------------------------------------------------------------

const ALL = new Set(["gzip", "deflate", "br", "zstd"]);
const parse = (values: string | readonly string[], maxLayers = 5): string[] =>
  parseContentEncoding(values, (name) => ALL.has(name), maxLayers);

test("Covers: SG-R-HDR-12 - decoding order is the reverse of the list", () => {
  assert.deepEqual(parse("gzip, deflate"), ["deflate", "gzip"]);
  assert.deepEqual(parse(["gzip", "br"]), ["br", "gzip"]);
});

test("Covers: SG-R-HDR-01 SG-R-HDR-03 SG-R-HDR-05 SG-R-HDR-14 - equivalent presentations give the same result", () => {
  for (const presentation of ["gzip,br", "GZIP, BR", ["gzip", "br"], [" gzip ", "\tbr\t"], ",,gzip,,br,,", ["", "gzip", " ", "br", ""], "gzip,\t,br"]) {
    assert.deepEqual(parse(presentation), ["br", "gzip"], JSON.stringify(presentation));
  }
});

test("Covers: SG-R-HDR-01 SG-R-HDR-03 SG-R-HDR-10 - an empty header is the empty chain", () => {
  for (const value of ["", " ", ",", ", ,\t,", [], [""], ["", " "], "identity, identity"]) assert.deepEqual(parse(value), []);
});

test("Covers: SG-R-HDR-07 - x-gzip is the only alias", () => {
  assert.deepEqual(parse("x-gzip"), ["gzip"]);
  assert.deepEqual(parse("X-GZIP"), ["gzip"]);
  for (const name of ["x-compress", "x-deflate", "x-br"]) assert.throws(() => parse(name), UnsupportedEncodingError);
});

test("Covers: SG-R-HDR-08 SG-R-HDR-09 SG-I-06 - unknown but well-formed tokens are unsupported", () => {
  for (const token of ["compress", "dcb", "dcz", "aes128gcm", "snappy", "deflate64", "bzip2"]) {
    assert.throws(() => parse(`gzip, ${token}`), UnsupportedEncodingError);
  }
});

test("Covers: SG-R-HDR-04 SG-R-HDR-05 - malformed elements are refused", () => {
  const evil = [
    "gzip;q=1.0", "gzip;", '"gzip"', "gz ip", "gzip br", "gzip\n", "gzip\r\n", "\0gzip", "gzip\0", "gézip", "gzip​", "-gzip", ".gzip", "_gzip", "gzip/br", "gzip:",
    "g".repeat(33), "gzip ", " gzip", "gzip\v", "gzip\f", "gzip\u0085", "\ud800", "gzip, br;x", "ﬁ", "ｇzip", "gzip ", "ｇzip",
  ];
  for (const token of evil) assert.throws(() => parse(token), MalformedEncodingError, JSON.stringify(token));
});

test("Covers: SG-R-HDR-04 - token length and alphabet edges", () => {
  const anything = () => true;
  assert.deepEqual(parseContentEncoding("a".repeat(32), anything, 5), ["a".repeat(32)]);
  assert.throws(() => parseContentEncoding("a".repeat(33), anything, 5), MalformedEncodingError);
  for (const token of ["a", "z", "A", "Z", "0", "9", "a.b_c-d", "9z"]) {
    assert.deepEqual(parseContentEncoding(token, anything, 5), [token.toLowerCase()]);
  }
  for (const first of "`{@[/:.-_") assert.throws(() => parseContentEncoding(`${first}x`, anything, 5), MalformedEncodingError);
});

test("Covers: SG-R-HDR-02 SG-I-07 - the header length cap counts bytes", () => {
  const ok = "gzip" + ",".repeat(1020);
  assert.equal(ok.length, 1024);
  assert.deepEqual(parse(ok), ["gzip"]);
  assert.throws(() => parse(ok + ","), MalformedEncodingError);
  assert.throws(() => parse(["," .repeat(512), ",".repeat(512), "gzip"]), MalformedEncodingError); // the joining commas count
  assert.throws(() => parse("é".repeat(600)), MalformedEncodingError); // 600 units, 1200 bytes
});

test("Covers: SG-R-HDR-02 SG-R-HDR-04 SG-R-HDR-06 SG-R-HDR-08 SG-R-HDR-11 - the evaluation order decides the outcome class", () => {
  assert.throws(() => parse("x;".repeat(600)), (e: Error) => e instanceof MalformedEncodingError && /long/.test(e.message)); // length beats grammar
  assert.throws(() => parse([...Array(20).fill("gzip"), "bad;"].join(", ")), MalformedEncodingError); // grammar beats count
  assert.throws(() => parse(Array(17).fill("compress").join(", ")), LayerLimitError); // count beats support
  assert.throws(() => parse([...Array(6).fill("gzip"), "compress"].join(", ")), UnsupportedEncodingError); // support beats layers
});

test("Covers: SG-R-HDR-06 SG-R-HDR-10 SG-I-07 - sixteen elements including identity", () => {
  assert.deepEqual(parse(Array(16).fill("identity").join(", "), 1), []);
  assert.throws(() => parse(Array(17).fill("identity").join(", "), 16), LayerLimitError);
  assert.throws(() => parse([...Array(16).fill("gzip"), "identity"].join(", "), 16), LayerLimitError);
});

test("Covers: SG-R-HDR-10 SG-R-HDR-11 - the layer count ignores identity", () => {
  assert.deepEqual(parse("identity, gzip, identity, gzip", 2), ["gzip", "gzip"]);
  assert.throws(() => parse("gzip, gzip, gzip", 2), LayerLimitError);
});

test("Covers: SG-R-HDR-09 SG-R-API-03 SG-I-06 - support is checked for the whole list before any read", () => {
  let reads = 0;
  const source = { read: () => { reads++; return null; } };
  assert.throws(() => new Decoder({ maxOutput: 10 }).reader(source, "gzip, compress"), UnsupportedEncodingError);
  assert.equal(reads, 0);
});

test("Covers: SG-R-HDR-13 - error messages quote and bound attacker data", () => {
  const text = quoteUntrusted("a\nb\r\0\u001b[31m" + "x".repeat(100));
  assert.ok(!/[\n\r\0\u001b]/.test(text));
  assert.ok((text.match(/x/g) ?? []).length <= 32);
  assert.equal(quoteUntrusted("é"), '"\\u00e9"');
  assert.equal(quoteUntrusted('quote"back\\slash'), '"quote\\"back\\\\slash"');
  for (const evil of ["evil\nSEVERITY=ALERT;", "x".repeat(5000), "\u001b]0;title\u0007"]) {
    try {
      parse(evil);
      assert.fail("accepted");
    } catch (error) {
      assert.ok(error instanceof MalformedEncodingError);
      assert.ok(!/[\n\u001b]/.test(error.message) && error.message.length < 300);
    }
  }
});

test("Covers: SG-R-API-03 - wrong value types are a programming error", () => {
  assert.throws(() => parse([Buffer.from("gzip")] as unknown as string[]), TypeError);
  assert.throws(() => parse([null] as unknown as string[]), TypeError);
  assert.throws(() => parse(42 as unknown as string), TypeError);
});
