/** Shared helpers for the unit tests. */

import zlib from "node:zlib";
import { Decoder, SpillgateError, type DecoderOptions, type Limits, type Source } from "../src/index.js";

export const LOOSE: Limits = { maxOutput: 2 ** 30, disableRatioLimit: true };

export const gz = (payload: Uint8Array): Buffer => zlib.gzipSync(payload, { level: 9 });
export const zl = (payload: Uint8Array): Buffer => zlib.deflateSync(payload);
export const raw = (payload: Uint8Array): Buffer => zlib.deflateRawSync(payload);

export function bytes(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

export function concat(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts);
}

/** Decode completely; return the outcome class and the bytes delivered before it. */
export async function outcome(
  source: Source,
  encodings: string | readonly string[],
  limits: Limits = LOOSE,
  options: DecoderOptions = {},
  readSize = 4096,
): Promise<[string, Buffer]> {
  const delivered: Buffer[] = [];
  let reader;
  try {
    reader = new Decoder(limits, options).reader(source, encodings);
  } catch (error) {
    if (error instanceof SpillgateError) return [error.kind, Buffer.alloc(0)];
    throw error;
  }
  try {
    for (;;) {
      let chunk: Uint8Array | null;
      try {
        chunk = await reader.read(readSize);
      } catch (error) {
        if (error instanceof SpillgateError) return [error.kind, Buffer.concat(delivered)];
        throw error;
      }
      if (chunk === null) return ["ok", Buffer.concat(delivered)];
      delivered.push(Buffer.from(chunk));
    }
  } finally {
    reader.close();
  }
}

/** A source that hands out at most `step` bytes per read and counts them. */
export class Trickle {
  total = 0;
  private pos = 0;
  constructor(
    private readonly payload: Uint8Array,
    private readonly step = 1,
  ) {}
  read(max: number): Uint8Array | null {
    if (this.pos >= this.payload.length) return null;
    const chunk = this.payload.subarray(this.pos, this.pos + Math.min(max, this.step));
    this.pos += chunk.length;
    this.total += chunk.length;
    return chunk;
  }
}

/** Small deterministic PRNG (mulberry32) so tests are reproducible without dependencies. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(random: () => number, n: number): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(random() * 256);
  return out;
}
