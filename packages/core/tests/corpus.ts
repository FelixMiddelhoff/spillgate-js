/**
 * Builds the generated conformance inputs (spec/generators.md) without a compressor.
 *
 * Every construction here is the one written down in `spec/generators.md`; the SHA-256 of each
 * generated stream in the manifest proves that this implementation builds the same bytes as the
 * reference. Only gzip, zlib and raw DEFLATE are implemented here: brotli and zstd generators
 * belong to the optional codecs.
 */

import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { adler32 } from "../src/checksum.js";

const MASK64 = (1n << 64n) - 1n;
const MAX_MATCH = 258;
const STORED_BLOCK_LIMIT = 65535;

/** Data(seed, size): xorshift64 bytes that do not compress. */
export function data(seed: number | bigint, size: number): Uint8Array {
  let state = (BigInt(seed) * 0x9e3779b97f4a7c15n + 1n) & MASK64;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    state ^= (state << 13n) & MASK64;
    state ^= state >> 7n;
    state ^= (state << 17n) & MASK64;
    out[i] = Number((state >> 24n) & 0xffn);
  }
  return out;
}

/** Writes DEFLATE fields: least significant bit first; Huffman codes most significant bit first. */
class BitWriter {
  private chunks: Uint8Array[] = [];
  private current: number[] = [];
  private acc = 0;
  private count = 0;

  bits(value: number, n: number): void {
    this.acc |= value << this.count;
    this.count += n;
    while (this.count >= 8) {
      this.current.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.count -= 8;
    }
  }

  code(code: number, n: number): void {
    let reversed = 0;
    for (let i = 0; i < n; i++) reversed = (reversed << 1) | ((code >> i) & 1);
    this.bits(reversed, n);
  }

  /** Write `n` zero bits; whole bytes in bulk, so billions of bits stay cheap. */
  zeroBits(n: number): void {
    const head = Math.min(n, (8 - this.count) % 8);
    this.bits(0, head);
    n -= head;
    this.flush();
    this.chunks.push(new Uint8Array(Math.floor(n / 8)));
    this.bits(0, n % 8);
  }

  private flush(): void {
    if (this.current.length > 0) {
      this.chunks.push(Uint8Array.from(this.current));
      this.current = [];
    }
  }

  finish(): Uint8Array {
    if (this.count > 0) {
      this.current.push(this.acc & 0xff);
      this.acc = 0;
      this.count = 0;
    }
    this.flush();
    return concat(this.chunks);
  }
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** StoredDeflate: stored blocks of at most 65535 bytes; empty data is one empty final block. */
export function storedDeflate(payload: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 0;
  do {
    const n = Math.min(payload.length - pos, STORED_BLOCK_LIMIT);
    const final = pos + n === payload.length ? 1 : 0;
    parts.push(Uint8Array.of(final, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff));
    parts.push(payload.subarray(pos, pos + n));
    pos += n;
  } while (pos < payload.length);
  return concat(parts);
}

/** ZerosDeflate: one dynamic Huffman block decoding to `1 + 258 * matches` zero bytes. */
export function zerosDeflate(matches: number): Uint8Array {
  const w = new BitWriter();
  w.bits(1, 1); // BFINAL
  w.bits(2, 2); // BTYPE 10: dynamic Huffman codes
  w.bits(29, 5); // HLIT: 286 literal/length symbols
  w.bits(1, 5); // HDIST: 2 distance symbols
  w.bits(14, 4); // HCLEN: 18 code-length code lengths
  for (const length of [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2]) w.bits(length, 3);
  const lengthIs1 = (): void => w.code(0b10, 2);
  const lengthIs2 = (): void => w.code(0b11, 2);
  const zeroRun = (count: number): void => {
    w.code(0b0, 1);
    w.bits(count - 11, 7);
  };
  lengthIs2(); // literal 0
  zeroRun(138); // symbols 1..138 unused
  zeroRun(117); // symbols 139..255 unused
  lengthIs2(); // symbol 256, end of block
  zeroRun(28); // symbols 257..284 unused
  lengthIs1(); // symbol 285 (length 258)
  lengthIs1(); // distance symbol 0
  lengthIs1(); // distance symbol 1
  w.code(0b10, 2); // literal 0
  w.zeroBits(2 * matches); // per match: length symbol 285 = '0', distance symbol 0 = '0'
  w.code(0b11, 2); // end of block
  return w.finish();
}

export function zerosDecodedSize(matches: number): number {
  return 1 + MAX_MATCH * matches;
}

function crcOfZeros(n: number): number {
  const chunk = new Uint8Array(1 << 20);
  let crc = 0;
  while (n > 0) {
    const take = Math.min(n, chunk.length);
    crc = zlib.crc32(take === chunk.length ? chunk : chunk.subarray(0, take), crc);
    n -= take;
  }
  return crc >>> 0;
}

/** The Adler-32 of n zero bytes: a stays 1, b counts the bytes. */
function adlerOfZeros(n: number): number {
  return ((n % 65521) * 65536 + 1) >>> 0;
}

function le32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function be32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

export function gzipMember(deflate: Uint8Array, crc: number, size: number): Uint8Array {
  const header = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255);
  return concat([header, deflate, le32(crc), le32(size % 2 ** 32)]);
}

export function zlibWrap(deflate: Uint8Array, adler: number): Uint8Array {
  return concat([Uint8Array.of(0x78, 0x01), deflate, be32(adler)]);
}

export function gzipStored(payload: Uint8Array): Uint8Array {
  return gzipMember(storedDeflate(payload), zlib.crc32(payload) >>> 0, payload.length);
}

export function zlibStored(payload: Uint8Array): Uint8Array {
  return zlibWrap(storedDeflate(payload), adler32(payload));
}

function zerosStream(codec: string, matches: number): Uint8Array {
  const size = zerosDecodedSize(matches);
  const deflate = zerosDeflate(matches);
  if (codec === "gzip") return gzipMember(deflate, crcOfZeros(size), size);
  if (codec === "zlib") return zlibWrap(deflate, adlerOfZeros(size));
  if (codec === "raw") return deflate;
  throw new NotImplemented(`zeros generator for codec ${codec}`);
}

function wrapOnce(codec: string, payload: Uint8Array): Uint8Array {
  if (codec === "gzip") return gzipStored(payload);
  if (codec === "zlib") return zlibStored(payload);
  if (codec === "raw") return storedDeflate(payload);
  throw new NotImplemented(`wrap generator for codec ${codec}`);
}

/** The spec needs a generator that this implementation does not have (brotli, zstd). */
export class NotImplemented extends Error {}

export interface GeneratorSpec {
  kind: string;
  params: Record<string, unknown>;
}

/** Build the compressed stream a generator spec describes. */
export function generate(spec: GeneratorSpec): Uint8Array {
  const { kind, params } = spec;
  if (kind === "zeros") return zerosStream(params["codec"] as string, (params["matches"] as number | undefined) ?? 0);
  if (kind === "data") {
    return wrapOnce(params["codec"] as string, data(params["seed"] as number, params["size"] as number));
  }
  if (kind === "wrap") {
    let stream = generate(params["inner"] as GeneratorSpec);
    for (let i = 0; i < (params["times"] as number); i++) stream = wrapOnce(params["codec"] as string, stream);
    return stream;
  }
  throw new Error(`unknown generator kind ${kind}`);
}

export function sha256Hex(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}
