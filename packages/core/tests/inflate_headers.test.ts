/**
 * Hand-built DEFLATE blocks with invalid (and a few unusual but valid) dynamic headers. Each case
 * is also fed to node:zlib as an oracle, so the expectation is not just our reading of RFC 1951.
 */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { test } from "node:test";
import { Decoder } from "../src/index.js";
import { SpillgateError } from "../src/errors.js";

class Bits {
  private readonly bits: number[] = [];
  /** A field: least significant bit first. */
  put(value: number, n: number): this {
    for (let i = 0; i < n; i++) this.bits.push((value >> i) & 1);
    return this;
  }
  /** A Huffman code: most significant bit first. */
  code(value: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
    return this;
  }
  bytes(): Buffer {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => { out[i >> 3] = (out[i >> 3] as number) | (bit << (i & 7)); });
    return out;
  }
}

/** Canonical codes (RFC 1951 3.2.2) for a list of code lengths. */
function canonical(lengths: number[]): { code: number; len: number }[] {
  const count = new Array<number>(16).fill(0);
  for (const l of lengths) count[l] = (count[l] as number) + 1;
  count[0] = 0;
  const next = new Array<number>(16).fill(0);
  let code = 0;
  for (let l = 1; l < 16; l++) {
    code = (code + (count[l - 1] as number)) << 1;
    next[l] = code;
  }
  return lengths.map((len) => (len === 0 ? { code: 0, len: 0 } : { code: (next[len] = (next[len] as number) + 1) - 1, len }));
}

const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Dynamic {
  hlit?: number; // field value, 257 + n symbols
  hdist?: number; // field value, 1 + n symbols
  /** code length code: length of each of the 19 symbols (0..18) */
  clen: number[];
  /** the sequence of code-length symbols with their extra bits */
  symbols: [symbol: number, extra?: number][];
  /** what follows the tables, using the literal code lengths given by the caller */
  tail: (w: Bits) => void;
  final?: boolean;
}

function dynamic(d: Dynamic): Buffer {
  const w = new Bits();
  w.put(d.final === false ? 0 : 1, 1).put(2, 2).put(d.hlit ?? 0, 5).put(d.hdist ?? 0, 5).put(15, 4);
  for (const symbol of ORDER) w.put(d.clen[symbol] as number, 3);
  const codes = canonical(d.clen);
  for (const [symbol, extra] of d.symbols) {
    const c = codes[symbol] as { code: number; len: number };
    w.code(c.code, c.len);
    if (symbol === 16) w.put(extra ?? 0, 2);
    if (symbol === 17) w.put(extra ?? 0, 3);
    if (symbol === 18) w.put(extra ?? 0, 7);
  }
  d.tail(w);
  return w.bytes();
}

/** Decode with spillgate: the outcome class and the output. */
async function ours(data: Buffer): Promise<[string, Buffer]> {
  try {
    return ["ok", Buffer.from(await new Decoder({ maxOutput: 1e6, disableRatioLimit: true }).readAll(data, "deflate"))];
  } catch (error) {
    if (error instanceof SpillgateError) return [error.kind, Buffer.alloc(0)];
    throw error;
  }
}

/** The oracle: does node:zlib accept it? */
function oracle(data: Buffer): Buffer | undefined {
  try {
    return zlib.inflateRawSync(data);
  } catch {
    return undefined;
  }
}

async function agree(name: string, data: Buffer): Promise<void> {
  const [kind, out] = await ours(data);
  const expected = oracle(data);
  if (expected === undefined) assert.equal(kind, "corrupt", `${name}: node:zlib refuses, spillgate said ${kind}`);
  else assert.deepEqual([kind, out.equals(expected)], ["ok", true], `${name}: node:zlib accepts`);
}

// A plain code-length code: symbols 0..15 get length 4 (16 codes), 16..18 get 0.
const flatClen = [...Array<number>(16).fill(4), 0, 0, 0];
// The literal tree "only symbol 256" needs the length sequence 0 x 256, 1, then the distance length.
const eobOnly = (w: Bits): void => {
  w.code(0, 1);
};

test("Covers: SG-R-CDC-08 SG-I-05 - a dynamic block with only an end-of-block code (one code of length 1) is valid", async () => {
  // code-length code: symbols 0 and 1 have length 1
  const clen = [1, 1, ...Array<number>(17).fill(0)];
  const symbols: [number, number?][] = [...Array<number>(256).fill(0).map((s): [number] => [s]), [1], [0]]; // 256 zeros, a one, one distance length 0
  const data = dynamic({ hlit: 0, hdist: 0, clen, symbols, tail: eobOnly });
  await agree("eob only", data);
  assert.deepEqual(await ours(data), ["ok", Buffer.alloc(0)]);
});

test("Covers: SG-R-CDC-08 SG-I-05 - an over-subscribed code-length code is corrupt", async () => {
  const clen = [1, 1, 1, ...Array<number>(16).fill(0)]; // three codes of length 1
  await agree("oversubscribed clen", dynamic({ clen, symbols: [[0]], tail: () => undefined }));
});

test("Covers: SG-R-CDC-08 SG-I-05 - an incomplete code-length code is corrupt", async () => {
  const clen = [1, ...Array<number>(18).fill(0)]; // a single code of length 1
  await agree("incomplete clen", dynamic({ clen, symbols: [[0]], tail: () => undefined }));
});

test("Covers: SG-R-CDC-08 SG-I-05 - a missing end-of-block code is corrupt", async () => {
  // literals 0..255 get length 8 (256 codes of length 8 is complete), symbol 256 gets none
  const clen = [...Array<number>(8).fill(0), 1, ...Array<number>(10).fill(0)]; // only symbol 8 has a code (length 1)
  const incomplete = dynamic({ hlit: 0, hdist: 0, clen: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, ...Array<number>(9).fill(0)], symbols: [], tail: () => undefined });
  void clen;
  await agree("truncated header", incomplete);
  // 256 literals of length 8, the end-of-block symbol (256) absent: HLIT=257 means index 256 is the 257th length
  const lens: [number, number?][] = [...Array<number>(256).fill(8), 0].map((l) => [l]);
  const twoCodes = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, ...Array<number>(9).fill(0)]; // symbols 8 and 9 -> codes 0 and 1
  const data = dynamic({ hlit: 0, hdist: 0, clen: twoCodes, symbols: [...lens.map(([l]): [number] => [l === 8 ? 8 : 9]), [9]], tail: () => undefined });
  await agree("no end-of-block", data);
});

test("Covers: SG-R-CDC-08 SG-I-05 - a repeat with no previous length, and a repeat past the table, are corrupt", async () => {
  const withRepeat = [...Array<number>(16).fill(0), 1, 0, 1]; // symbols 16 and 18 usable
  await agree("repeat 16 first", dynamic({ clen: withRepeat, symbols: [[16, 0]], tail: () => undefined }));
  const zeros = [1, ...Array<number>(15).fill(0), 0, 0, 1]; // symbols 0 and 18
  const overrun: [number, number?][] = Array(3).fill([18, 127]); // 3 x 138 zeros > 258 lengths
  await agree("repeat overrun", dynamic({ clen: zeros, symbols: overrun, tail: () => undefined }));
});

test("Covers: SG-R-CDC-08 SG-I-05 - too many length or distance symbols are corrupt", async () => {
  await agree("hlit 287", dynamic({ hlit: 30, hdist: 0, clen: flatClen, symbols: [], tail: () => undefined }));
  await agree("hdist 31", dynamic({ hlit: 0, hdist: 30, clen: flatClen, symbols: [], tail: () => undefined }));
  await agree("hlit 286 is the maximum", dynamic({ hlit: 29, hdist: 29, clen: flatClen, symbols: [], tail: () => undefined }));
});

test("Covers: SG-R-CDC-08 SG-I-05 - distances beyond the data written so far are corrupt, the exact distance is valid", async () => {
  const fixed = (distanceSymbol: number): Buffer => {
    const w = new Bits().put(1, 1).put(1, 2);
    w.code(0x30 + 0x61, 8); // literal 'a'
    w.code(1, 7); // length symbol 257 = 3 bytes
    w.code(distanceSymbol, 5); // distance symbol: 0 -> 1, 1 -> 2
    w.code(0, 7); // end of block
    return w.bytes();
  };
  assert.deepEqual(await ours(fixed(0)), ["ok", Buffer.from("aaaa")]); // distance 1 after one byte
  await agree("distance 1", fixed(0));
  assert.equal((await ours(fixed(1)))[0], "corrupt"); // distance 2 after one byte
  await agree("distance 2", fixed(1));
});

test("Covers: SG-R-CDC-08 SG-I-05 - reserved length and distance symbols are corrupt", async () => {
  const fixedWith = (lengthCode: number, distanceSymbol: number): Buffer => {
    const w = new Bits().put(1, 1).put(1, 2).code(0x30 + 0x61, 8);
    w.code(lengthCode, 8).code(distanceSymbol, 5);
    return w.bytes();
  };
  await agree("length symbol 286", fixedWith(0xc0 + 6, 0)); // 286 is the 8-bit code 11000110
  await agree("distance symbol 30", fixedWith(0xc0 + 0, 30)); // length symbol 280 first
});

test("Covers: SG-R-CDC-08 SG-I-05 - block type 3 and bad stored lengths are corrupt", async () => {
  await agree("type 3", new Bits().put(1, 1).put(3, 2).bytes());
  await agree("stored length mismatch", Buffer.from([0x01, 0x05, 0x00, 0x00, 0x00]));
});

// A complete code-length code for the tests below: 0, 1 and 16 have 2 bits, 17 and 18 have 3.
const mixedClen = [2, 2, ...Array<number>(14).fill(0), 2, 3, 3];
const endOfBlock = (w: Bits): void => {
  w.code(0, 1); // the single literal/length code of length 1 is the end of block
};

test("Covers: SG-R-CDC-08 SG-I-05 - HLIT above 286 is corrupt even when the rest would decode", async () => {
  const symbols: [number, number?][] = [[18, 127], [18, 107], [1], [18, 19], [0]]; // 256 zeros, EOB length 1, 30 zeros, one distance length
  const data = dynamic({ hlit: 30, hdist: 0, clen: mixedClen, symbols, tail: endOfBlock });
  assert.equal(oracle(data), undefined, "the oracle refuses 287 symbols");
  assert.equal((await ours(data))[0], "corrupt");
});

test("Covers: SG-R-CDC-08 SG-I-05 - a repeat that overruns the table by one length is corrupt", async () => {
  // HLIT 257 + HDIST 2 = 259 lengths; the last repeat (3 zeros at index 257) ends at 260.
  const symbols: [number, number?][] = [[18, 127], [18, 107], [1], [17, 0]];
  const data = dynamic({ hlit: 0, hdist: 1, clen: mixedClen, symbols, tail: endOfBlock });
  assert.equal(oracle(data), undefined, "the oracle refuses the overrun");
  assert.equal((await ours(data))[0], "corrupt");
});

test("Covers: SG-R-CDC-08 SG-I-05 - a repeat of the previous length as the very first symbol is corrupt", async () => {
  const symbols: [number, number?][] = [[16, 0], [18, 127], [18, 104], [1], [0]];
  const data = dynamic({ hlit: 0, hdist: 0, clen: mixedClen, symbols, tail: endOfBlock });
  assert.equal(oracle(data), undefined, "the oracle refuses a repeat with no previous length");
  assert.equal((await ours(data))[0], "corrupt");
});

test("Covers: SG-R-CDC-08 SG-I-05 - the same tables without the fault decode (the builder is sound)", async () => {
  const symbols: [number, number?][] = [[18, 127], [18, 107], [1], [0]]; // 256 zeros, EOB, one distance length
  const data = dynamic({ hlit: 0, hdist: 0, clen: mixedClen, symbols, tail: endOfBlock });
  assert.deepEqual(oracle(data)?.length, 0);
  assert.deepEqual(await ours(data), ["ok", Buffer.alloc(0)]);
});

test("Covers: SG-R-CDC-08 SG-I-05 - an over-subscribed literal/length code is corrupt even when the data would decode", async () => {
  // Four codes of length 1 (symbols 65, 66, 67 and the end of block) cannot exist: only two fit.
  const clen = [1, 1, ...Array<number>(17).fill(0)]; // symbols 0 and 1 of the code-length code
  const lengths: [number][] = [];
  for (let i = 0; i < 256; i++) lengths.push([i === 65 || i === 66 || i === 67 ? 1 : 0]);
  const symbols: [number, number?][] = [...lengths, [1], [0]]; // then the end of block (1) and one distance length (0)
  const data = dynamic({ hlit: 0, hdist: 0, clen, symbols, tail: (w) => { w.code(1, 1); } });
  assert.equal(oracle(data), undefined, "the oracle refuses an over-subscribed code");
  assert.equal((await ours(data))[0], "corrupt");
});

test("Covers: SG-R-CDC-03 - repeat-previous (16) after a run of zeros repeats the zero", async () => {
  // Found by the review of the Rust port: the previous length was not updated by codes 17 and 18.
  // Raw deflate, 15 bytes; zlib decodes it to "a".
  const stream = Buffer.from("05c0250100000000a0ad04f9ff0004", "hex");
  assert.deepEqual(zlib.inflateRawSync(stream), Buffer.from("a"));
  const out = await new Decoder({ maxOutput: 100 }).readAll(stream, "deflate");
  assert.deepEqual(Buffer.from(out), Buffer.from("a"));
});

test("Covers: SG-R-RDR-01 SG-I-09 - bytes delivered before a deflate error do not depend on the read size", async () => {
  // Found by the review of the Rust port: the bytes of the failing step used to be dropped.
  const stream = Buffer.from("4b4c4c043e00", "hex");
  const results: string[] = [];
  for (const size of [1, 2, 3, 4096]) {
    const reader = new Decoder({ maxOutput: 100, disableRatioLimit: true }).reader(stream, "deflate");
    const parts: Buffer[] = [];
    let kind = "ok";
    try {
      for (let c = await reader.read(size); c !== null; c = await reader.read(size)) parts.push(Buffer.from(c));
    } catch (error) {
      kind = error instanceof SpillgateError ? error.kind : "foreign";
    }
    results.push(`${Buffer.concat(parts).toString()}:${kind}`);
  }
  assert.deepEqual(results, ["aaa:corrupt", "aaa:corrupt", "aaa:corrupt", "aaa:corrupt"]);
});
