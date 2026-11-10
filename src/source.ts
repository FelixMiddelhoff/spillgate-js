/** Turning whatever the caller hands in into one pull interface. */

import { InternalError } from "./errors.js";

/**
 * A source that is asked for at most `max` bytes at a time. Return a `Uint8Array` of 1 to `max`
 * bytes, or `null` at the end. An empty array means "no progress" and is tried again a bounded
 * number of times (SG-R-RDR-03). Throwing is a source failure (`source_error`).
 */
export interface PullSource {
  read(max: number): Promise<Uint8Array | null | undefined> | Uint8Array | null | undefined;
}

/**
 * Everything that can be decoded: bytes, an (async) iterable of byte chunks (a Node `Readable`, a
 * `fetch` body), a web `ReadableStream`, or a {@link PullSource}. Only a {@link PullSource} and plain
 * bytes can honor `maxInput` to the byte (SG-R-INP-02): an iterable decides its own chunk size, so
 * with `maxInput` set at most one chunk beyond the cap is taken from it.
 */
export type Source =
  | Uint8Array
  | ArrayBuffer
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>
  | PullSource;

/** The internal form: `next(max)` resolves to bytes, `null` (end) or an empty array (no progress). */
export interface RawSource {
  next(max: number): Promise<Uint8Array | null>;
}

export function toRawSource(source: unknown): RawSource {
  if (source instanceof Uint8Array) return fromBytes(source);
  if (source instanceof ArrayBuffer) return fromBytes(new Uint8Array(source));
  if (source === null || typeof source !== "object") {
    throw new TypeError("source must be bytes, an (async) iterable of bytes, a ReadableStream or an object with read(max)");
  }
  const candidate = source as Record<PropertyKey, unknown>;
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    return fromIterator((candidate as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]());
  }
  if (typeof candidate[Symbol.iterator] === "function") {
    return fromIterator((candidate as unknown as Iterable<Uint8Array>)[Symbol.iterator]());
  }
  if (typeof (candidate as { getReader?: unknown }).getReader === "function") {
    return fromStream(source as ReadableStream<Uint8Array>);
  }
  if (typeof candidate["read"] === "function") {
    const pull = source as PullSource;
    return { next: async (max) => (await pull.read(max)) ?? null };
  }
  throw new TypeError("source must be bytes, an (async) iterable of bytes, a ReadableStream or an object with read(max)");
}

function fromBytes(bytes: Uint8Array): RawSource {
  let pos = 0;
  return {
    next(max) {
      if (pos >= bytes.length) return Promise.resolve(null);
      const chunk = bytes.subarray(pos, pos + max);
      pos += chunk.length;
      return Promise.resolve(chunk);
    },
  };
}

/** A chunk-based source: the chunk size is the producer's choice, so it is sliced to `max`. */
function fromIterator(iterator: Iterator<Uint8Array> | AsyncIterator<Uint8Array>): RawSource {
  let current: Uint8Array = new Uint8Array(0);
  let pos = 0;
  let done = false;
  return {
    async next(max) {
      if (pos < current.length) {
        const chunk = current.subarray(pos, pos + max);
        pos += chunk.length;
        return chunk;
      }
      if (done) return null;
      const result = await iterator.next();
      if (result.done) {
        done = true;
        return null;
      }
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) {
        throw new InternalError(`the source yielded ${describe(value)}, not bytes`);
      }
      current = value;
      pos = Math.min(max, current.length);
      return current.subarray(0, pos);
    },
  };
}

function fromStream(stream: ReadableStream<Uint8Array>): RawSource {
  const reader = stream.getReader();
  return fromIterator({
    async next() {
      const result = await reader.read();
      return result.done ? { done: true, value: undefined } : { done: false, value: result.value };
    },
  });
}

function describe(value: unknown): string {
  return value === null ? "null" : typeof value;
}
