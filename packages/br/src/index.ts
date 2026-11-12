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
 * The decoder is the Rust `brotli-decompressor` compiled to WebAssembly (a fork of
 * `brotli-dec-wasm` 2.3.2 built from the sources in `rust/`, see `rust/NOTES.md`), treated as
 * untrusted code:
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
 * - A WebAssembly trap (a Rust panic: none is known to be reachable) is `internal`, not
 *   `memory_limit`. The trapped decoder is abandoned (its handle cannot be freed), `close` stays
 *   silent, and because every trap leaks the shadow stack of the call, the module instance is
 *   replaced by a fresh one after {@link TRAPS_PER_INSTANCE} traps (streams already open keep
 *   the instance they started on).
 *
 * WebAssembly memory only grows: after a hostile stream with a 16 MiB window the module keeps that
 * memory for later streams. Lower the cap (`maxWindowBits`) on servers that decode many streams.
 */

import { CorruptError, InternalError, InvalidOptionError, MemoryLimitError } from "spillgate";
import type { Codec, CodecReader, CodecSource } from "spillgate";
import * as wasm from "./native/brotli_dec_wasm.js";

export const DEFAULT_MAX_WINDOW_BITS = 24;
export const MIN_WINDOW_BITS = 10;
export const MAX_OUTPUT_STEP = 64 * 1024;

/** Traps after which new streams get a fresh module instance (the shadow stack leaks ~KiB per trap; poisoned at ~3200). */
export const TRAPS_PER_INSTANCE = 256;

/** Hooks for the tests, not part of the API. */
export const _test: { outputStep: number | undefined; trapsPerInstance: number; instances: number } = {
  outputStep: undefined,
  trapsPerInstance: TRAPS_PER_INSTANCE,
  instances: 1,
};

type Glue = typeof wasm;
/** One instance of the module (glue + WebAssembly instance) and the traps it has seen. */
interface Instance {
  glue: Glue;
  traps: number;
}

const EMPTY = new Uint8Array(0);
let initialized = false;
let compiled: WebAssembly.Module | undefined;
let current: Instance | undefined;
let renewing: Promise<Instance> | undefined;

/** A fresh instance of the module: the glue keeps one instance in module state, so it is loaded again under another URL. */
function renew(): Promise<Instance> {
  renewing ??= (async () => {
    try {
      const glue = (await import(new URL(`./native/brotli_dec_wasm.js?instance=${++_test.instances}`, import.meta.url).href)) as Glue;
      glue.initSync({ module: compiled as WebAssembly.Module });
      current = { glue, traps: 0 };
      return current;
    } catch {
      throw new InternalError("brotli: the WebAssembly module could not be replaced after traps; restart the process");
    } finally {
      renewing = undefined;
    }
  })();
  return renewing;
}

/**
 * Load the WebAssembly module. Call it once before the first {@link codec}.
 *
 * @param module the compiled module or its bytes; without it the module is read from the
 *   module shipped in this package (Node, Deno and Bun). In a browser pass the bytes you
 *   fetched, for example `await (await fetch(url)).arrayBuffer()`.
 */
export async function initBrotli(module?: BufferSource | WebAssembly.Module): Promise<void> {
  if (initialized) return;
  let source: BufferSource | WebAssembly.Module;
  if (module !== undefined) {
    source = module;
  } else {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    source = await readFile(fileURLToPath(new URL("./native/brotli_dec_wasm_bg.wasm", import.meta.url)));
  }
  compiled = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source);
  wasm.initSync({ module: compiled });
  current = { glue: wasm, traps: 0 };
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
  private instance: Instance | undefined;
  private ended = false;
  private trapped = false;

  constructor(
    private readonly meter: CodecSource,
    private readonly maxWindowBits: number,
  ) {}

  async read(max: number): Promise<Uint8Array> {
    if (this.ended) return EMPTY;
    if (this.trapped) throw new InternalError("brotli: the WebAssembly decoder trapped");
    if (this.stream === undefined) await this.start();
    const stream = this.stream as wasm.DecompressStream;
    const outputSize = _test.outputStep ?? Math.min(max, MAX_OUTPUT_STEP);
    let sourceEnded = false;
    for (;;) {
      // The decoder may hold output for bytes it already took: it gets a step with the bytes at
      // hand, even none, before the source is asked again, so what a read delivers before a
      // source error does not depend on the read size.
      const view = this.meter.view();

      let result: wasm.BrotliStreamResult;
      try {
        result = stream.decompress(view, outputSize);
      } catch (error) {
        // A trap (a Rust panic) is a bug, not bad data and not a limit: `internal`.
        if (error instanceof WebAssembly.RuntimeError) {
          this.abandon();
          throw new InternalError("brotli: the WebAssembly decoder trapped");
        }
        // An out-of-range allocation is memory running out (the module's memory is shared by all
        // open streams and never shrinks), not bad data.
        if (error instanceof RangeError) {
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
      if (code === wasm.BrotliStreamResultCode.NeedsMoreInput && view.length === 0) {
        if (sourceEnded) throw new CorruptError("brotli: the stream ends too early");
        if (!(await this.meter.fill())) sourceEnded = true;
      }
      // NeedsMoreInput with more to fetch, or NeedsMoreOutput that produced nothing yet: go on.
    }
  }

  close(): void {
    const stream = this.stream;
    this.stream = undefined;
    try {
      stream?.free();
    } catch {
      // never a foreign error from close: the handle is lost, the instance is replaced when needed
    }
  }

  /** After a trap the handle is still "borrowed" inside the module: it can neither be used nor freed. */
  private abandon(): void {
    this.trapped = true;
    const stream = this.stream as unknown as { __destroy_into_raw?: () => number } | undefined;
    this.stream = undefined;
    try {
      stream?.__destroy_into_raw?.(); // detaches the glue's finalizer: it would throw at garbage collection
    } catch {
      // nothing more to do
    }
    const instance = this.instance;
    if (instance !== undefined && ++instance.traps >= _test.trapsPerInstance && current === instance) {
      current = undefined; // the next stream renews it
    }
  }

  private async start(): Promise<void> {
    if (!(await this.meter.fill())) throw new CorruptError("brotli: an empty input is not a brotli stream");
    const { bits, largeWindow } = windowBits(this.meter.view()[0] as number);
    if (largeWindow) throw new MemoryLimitError("brotli stream asks for a large window (not supported)");
    if (bits > this.maxWindowBits) {
      throw new MemoryLimitError(`brotli stream asks for a window of 2**${bits} bytes (the cap is 2**${this.maxWindowBits})`);
    }
    this.instance = current ?? (await renew());
    this.stream = new this.instance.glue.DecompressStream();
  }
}
