/** Shared by the SG-R-INP-01 tests of the core package and of the integration package. */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { Decoder, SpillgateError, type Source } from "../src/index.js";
import { concat, gz, prng, raw, zl } from "./helpers.js";

export interface Handed {
  source: Source;
  handed: () => number;
  /** How far past MaxInput+1 the source may be asked (a chunked iterable decides its own chunk size). */
  slack: number;
}

export interface Shape {
  name: string;
  make(data: Uint8Array): Handed;
}

function pull(name: string, cap: (max: number) => number): Shape {
  return {
    name,
    make(data) {
      let pos = 0;
      let handed = 0;
      return {
        source: {
          read(max: number) {
            if (pos >= data.length) return null;
            const chunk = data.subarray(pos, pos + Math.max(1, Math.min(max, cap(max))));
            pos += chunk.length;
            handed += chunk.length;
            return chunk;
          },
        },
        handed: () => handed,
        slack: 0,
      };
    },
  };
}

export const SHAPES: Shape[] = [
  pull("whole", (max) => max),
  pull("one-byte", () => 1),
  pull("half", (max) => Math.ceil(max / 2)),
  pull("chunks-of-7", () => 7),
  {
    // an async iterable whose last chunk comes together with the end of the data
    name: "iterable-chunks-of-7",
    make(data) {
      let handed = 0;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (let at = 0; at < data.length; at += 7) {
          const chunk = data.subarray(at, at + 7);
          handed += chunk.length;
          yield chunk;
        }
      }
      return { source: chunks(), handed: () => handed, slack: 6 };
    },
  },
];

export const PATTERNS: number[][] = [[1], [3], [4096], [1 << 20], [1, 7, 4096, 1]];

export const LIMITS = { maxOutput: 2 ** 30, disableRatioLimit: true };

export interface Run {
  kind: string;
  got: Buffer;
  handed: number;
}

export async function decodeProbe(
  stream: Uint8Array,
  maxInput: number,
  shape: Shape,
  pattern: number[],
  encodings: string | string[],
  options: ConstructorParameters<typeof Decoder>[1] = {},
): Promise<Run> {
  const decoder = new Decoder({ ...LIMITS, maxInput }, options);
  const made = shape.make(stream);
  const reader = decoder.reader(made.source, encodings);
  const got: Buffer[] = [];
  try {
    for (let i = 0; ; i++) {
      let chunk: Uint8Array | null;
      try {
        chunk = await reader.read(pattern[i % pattern.length] as number);
      } catch (error) {
        if (!(error instanceof SpillgateError)) throw error;
        const again = await reader.read(1).then(
          () => "no error",
          (e: unknown) => (e instanceof SpillgateError ? e.kind : "other"),
        );
        assert.equal(again, error.kind, "the terminal condition is sticky");
        return { kind: error.kind, got: Buffer.concat(got), handed: made.handed() - made.slack };
      }
      if (chunk === null) return { kind: "ok", got: Buffer.concat(got), handed: made.handed() - made.slack };
      got.push(Buffer.from(chunk));
    }
  } finally {
    reader.close();
  }
}

export interface Stream {
  name: string;
  encoding: string;
  plain: Buffer;
  stream: Buffer;
}

export function coreStreams(): Stream[] {
  const text = Buffer.from("probe the byte after the limit. ".repeat(100));
  const random = Buffer.alloc(300);
  const rand = prng(5);
  for (let i = 0; i < random.length; i++) random[i] = Math.floor(rand() * 256);
  const stored: zlib.ZlibOptions = { level: 0 };
  return [
    { name: "gzip", encoding: "gzip", plain: text, stream: gz(text) },
    { name: "gzip stored", encoding: "gzip", plain: random, stream: zlib.gzipSync(random, stored) },
    { name: "gzip two members", encoding: "gzip", plain: concat(text, random), stream: concat(gz(text), gz(random)) },
    { name: "zlib", encoding: "deflate", plain: text, stream: zl(text) },
    { name: "zlib stored", encoding: "deflate", plain: random, stream: zlib.deflateSync(random, stored) },
    { name: "raw deflate", encoding: "deflate", plain: text, stream: raw(text) },
    { name: "raw deflate stored", encoding: "deflate", plain: random, stream: zlib.deflateRawSync(random, stored) },
  ];
}

export async function forEachRun(fn: (shape: Shape, pattern: number[]) => Promise<void>): Promise<void> {
  for (const shape of SHAPES) for (const pattern of PATTERNS) await fn(shape, pattern);
}

