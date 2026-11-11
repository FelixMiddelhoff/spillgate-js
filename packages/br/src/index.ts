/**
 * Brotli (RFC 7932) for spillgate: `npm install spillgate-br`.
 *
 * ```ts
 * import { Decoder } from "spillgate";
 * import { initBrotli, codec } from "spillgate-br";
 *
 * await initBrotli(); // once per process: loads the WebAssembly module
 * const decoder = new Decoder({ maxOutput: 8 * 1024 * 1024 }, { codecs: { br: codec() } });
 * ```
 *
 * The decoder is the Rust `brotli-decompressor` compiled to WebAssembly (package
 * `brotli-dec-wasm`, pinned to an exact version), treated as untrusted code:
 *
 * - The window size is read from the first byte of the stream and checked against the cap
 *   *before* the library sees a byte (SG-R-CDC-04). The default cap is 2**24 bytes, the RFC
 *   maximum; a lower cap saves memory on busy servers. The library itself accepts large-window
 *   streams (a 254-byte stream costs over 1 GiB), so the reserved marker is refused here, as
 *   `memory_limit`, whatever the cap is.
 * - Output is requested in steps of at most 64 KiB, and the library never returns more than it
 *   was asked for, so memory per step is constant.
 * - A stream that ends before its last meta-block is `corrupt` (the library only reports "needs
 *   more input"), and bytes after the last meta-block are `corrupt` (the library reports where the
 *   stream ended).
 * - Result objects of the library live in WebAssembly memory and are freed after every call.
 *
 * WebAssembly memory only grows: after a hostile stream with a 16 MiB window the module keeps that
 * memory for later streams. Lower the cap (`maxWindowBits`) on servers that decode many streams.
 */

import { CorruptError, InternalError, InvalidOptionError, MemoryLimitError } from "spillgate";
import type { Codec, CodecReader, CodecSource } from "spillgate";
import * as wasm from "brotli-dec-wasm/web";

export const DEFAULT_MAX_WINDOW_BITS = 24;
export const MIN_WINDOW_BITS = 10;
export const MAX_OUTPUT_STEP = 64 * 1024;

const EMPTY = new Uint8Array(0);
let initialized = false;

/**
 * Load the WebAssembly module. Call it once before the first {@link codec}.
 *
 * @param module the compiled module or its bytes; without it the module is read from the
 *   installed `brotli-dec-wasm` package (Node, Deno and Bun). In a browser pass the bytes you
 *   fetched, for example `await (await fetch(url)).arrayBuffer()`.
 */
export async function initBrotli(module?: BufferSource | WebAssembly.Module): Promise<void> {
  if (initialized) return;
  let source: BufferSource | WebAssembly.Module;
  if (module !== undefined) {
    source = module;
  } else {
    const url = import.meta.resolve("brotli-dec-wasm/web/bg.wasm");
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    source = await readFile(fileURLToPath(url));
  }
  wasm.initSync({ module: source });
  initialized = true;
}

export interface BrotliOptions {
  /** The largest window, as bits (`2**bits - 16` bytes), `10..24`. Default 24. */
  maxWindowBits?: number;
}

/**
 * The brotli codec for `Decoder`'s `codecs` option. Streams needing a larger window than
 * `maxWindowBits` are refused as `memory_limit`.
 *
 * @throws InvalidOptionError the option is invalid, or {@link initBrotli} was not called
 */
export function codec(options: BrotliOptions = {}): Codec {
  const bits = options.maxWindowBits ?? DEFAULT_MAX_WINDOW_BITS;
  if (!Number.isInteger(bits) || bits < MIN_WINDOW_BITS || bits > DEFAULT_MAX_WINDOW_BITS) {
    throw new InvalidOptionError(`maxWindowBits must be an integer in ${MIN_WINDOW_BITS}..${DEFAULT_MAX_WINDOW_BITS}`);
  }
  if (!initialized) throw new InvalidOptionError("call `await initBrotli()` before creating the brotli codec");
  return { newReader: (source) => new BrotliReader(source, bits) };
}

/**
 * RFC 7932 section 9.1: the window bits announced by the first byte, and whether the stream uses
 * the reserved large-window marker (WBITS pattern 1000001).
 */
export function windowBits(first: number): { bits: number; largeWindow: boolean } {
  if ((first & 1) === 0) return { bits: 16, largeWindow: false };
  const n = (first >> 1) & 7;
  if (n !== 0) return { bits: 17 + n, largeWindow: false };
  const m = (first >> 4) & 7;
  if (m === 0) return { bits: 17, largeWindow: false };
  if (m === 1) return { bits: 0, largeWindow: true };
  return { bits: 8 + m, largeWindow: false };
}

class BrotliReader implements CodecReader {
  private stream: wasm.DecompressStream | undefined;
  private ended = false;

  constructor(
    private readonly meter: CodecSource,
    private readonly maxWindowBits: number,
  ) {}

  async read(max: number): Promise<Uint8Array> {
    if (this.ended) return EMPTY;
    if (this.stream === undefined) await this.start();
    const stream = this.stream as wasm.DecompressStream;
    const outputSize = Math.min(max, MAX_OUTPUT_STEP);
    for (;;) {
      let view = this.meter.view();
      if (view.length === 0 && (await this.meter.fill())) view = this.meter.view();
      const sourceEnded = view.length === 0;

      let result: wasm.BrotliStreamResult;
      try {
        result = stream.decompress(view, outputSize);
      } catch (error) {
        // A trap or an out-of-range allocation inside WebAssembly is memory running out (the
        // module's memory is shared by all open streams and never shrinks), not bad data.
        if (error instanceof WebAssembly.RuntimeError || error instanceof RangeError) {
          throw new MemoryLimitError("brotli: the WebAssembly decoder ran out of memory");
        }
        throw new CorruptError("brotli: invalid data");
      }
      let output: Uint8Array;
      let code: wasm.BrotliStreamResultCode;
      try {
        output = Uint8Array.from(result.buf); // copy out of WebAssembly memory
        code = result.code;
        const used = result.input_offset;
        if (!Number.isInteger(used) || used < 0 || used > view.length) {
          throw new InternalError("brotli: the decoder reported an impossible input position");
        }
        this.meter.advance(used);
      } finally {
        result.free();
      }

      if (output.length > outputSize) throw new InternalError("brotli: the decoder returned more than requested");
      if (code === wasm.BrotliStreamResultCode.ResultSuccess) {
        this.ended = true;
        this.stream = undefined;
        stream.free();
        // The final meta-block is complete: nothing may follow it.
        if (!(await this.meter.atEnd())) throw new CorruptError("brotli: unexpected data after the end of the stream");
        return output;
      }
      if (output.length > 0) return output;
      if (code === wasm.BrotliStreamResultCode.NeedsMoreInput && sourceEnded) {
        throw new CorruptError("brotli: the stream ends too early");
      }
      // NeedsMoreInput with more to fetch, or NeedsMoreOutput that produced nothing yet: go on.
    }
  }

  close(): void {
    this.stream?.free();
    this.stream = undefined;
  }

  private async start(): Promise<void> {
    if (!(await this.meter.fill())) throw new CorruptError("brotli: an empty input is not a brotli stream");
    const { bits, largeWindow } = windowBits(this.meter.view()[0] as number);
    if (largeWindow) throw new MemoryLimitError("brotli stream asks for a large window (not supported)");
    if (bits > this.maxWindowBits) {
      throw new MemoryLimitError(`brotli stream asks for a window of 2**${bits} bytes (the cap is 2**${this.maxWindowBits})`);
    }
    this.stream = new wasm.DecompressStream();
  }
}
