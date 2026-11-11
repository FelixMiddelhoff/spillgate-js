/** The public entry points: {@link Decoder}, {@link reader} and {@link decodeAll}. */

import type { Codec, CodecReader } from "./codec.js";
import { DeflateCodec } from "./deflate.js";
import { InternalError, InvalidOptionError, SpillgateError, quoteUntrusted } from "./errors.js";
import { GzipCodec } from "./gzip.js";
import { LayerGuard } from "./guard.js";
import { IDENTITY, parseContentEncoding } from "./header.js";
import { EffectiveLimits, type Limits } from "./limits.js";
import { InputMeter } from "./meter.js";
import { SpillgateReader } from "./reader.js";
import { toRawSource, type RawSource, type Source } from "./source.js";

const RESERVED_NAMES = new Set([IDENTITY, "gzip", "deflate", "x-gzip"]);
const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface DecoderOptions {
  /** Refuse `deflate` data that has no zlib header instead of trying raw DEFLATE (SG-R-CDC-03). */
  strictZlib?: boolean;
  /**
   * Extension codecs by name, for example brotli and zstd (SG-R-CDC-09). Names must be lower-case
   * tokens and must not replace `identity`, `gzip`, `deflate` or `x-gzip`.
   */
  codecs?: Record<string, Codec>;
}

export interface ReaderOptions {
  /** Cancels the reader: it fails with `CanceledError`, sticky (SG-R-API-04). */
  signal?: AbortSignal;
}

/**
 * Turns `Content-Encoding` chains into bounded readers.
 *
 * A decoder is immutable after construction and safe to share; the readers it returns are not
 * safe for concurrent reads (SG-R-RDR-07). All checks that depend only on the limits and options
 * happen in the constructor, before any byte is read (SG-R-LIM-08).
 *
 * @throws InvalidLimitsError the limits are invalid
 * @throws InvalidOptionError an extension codec name is invalid or reserved
 */
export class Decoder {
  private readonly limits: EffectiveLimits;
  private readonly codecs: ReadonlyMap<string, Codec>;

  constructor(limits: Limits, options: DecoderOptions = {}) {
    this.limits = EffectiveLimits.from(limits);
    const table = new Map<string, Codec>([
      ["gzip", new GzipCodec()],
      ["deflate", new DeflateCodec(options.strictZlib === true)],
    ]);
    for (const [name, codec] of Object.entries(options.codecs ?? {})) {
      if (!NAME.test(name)) {
        throw new InvalidOptionError(
          `codec name ${quoteUntrusted(name)} must be a lower-case token (SG-R-HDR-04)`,
        );
      }
      if (RESERVED_NAMES.has(name)) {
        throw new InvalidOptionError(`codec name "${name}" is reserved for a built-in encoding`);
      }
      if (typeof codec?.newReader !== "function") {
        throw new InvalidOptionError(`codec "${name}" has no newReader()`);
      }
      table.set(name, codec);
    }
    this.codecs = table;
  }

  /**
   * A reader of the decoded bytes of `source`. Every check that depends only on the header happens
   * here, before the source is touched (SG-R-HDR-09, SG-R-API-03).
   *
   * @param source bytes, an (async) iterable of byte chunks, a ReadableStream or a PullSource;
   *   never closed by spillgate
   * @param encodings the `Content-Encoding` field values as received
   * @throws MalformedEncodingError, LayerLimitError, UnsupportedEncodingError the header is refused
   */
  reader(
    source: Source,
    encodings: string | readonly string[] = [],
    options: ReaderOptions = {},
  ): SpillgateReader {
    // The header is judged first: a refused Content-Encoding must not touch (or lock) the source
    // (SG-R-HDR-09).
    const layers = parseContentEncoding(encodings, (name) => this.codecs.has(name), this.limits.maxLayers);
    const raw = toRawSource(source);
    return this.buildChain(raw, layers, options.signal);
  }

  /** Decode `source` completely: the whole body, or an error and no data (SG-R-API-02). */
  async readAll(
    source: Source,
    encodings: string | readonly string[] = [],
    options: ReaderOptions = {},
  ): Promise<Uint8Array> {
    const reader = this.reader(source, encodings, options);
    try {
      return await reader.readAll();
    } finally {
      reader.close();
    }
  }

  private buildChain(
    source: RawSource,
    layers: string[],
    signal: AbortSignal | undefined,
  ): SpillgateReader {
    let current: RawSource = source;
    let firstMeter: InputMeter | undefined;
    let guard: LayerGuard | undefined;
    const readers: CodecReader[] = [];
    try {
      for (let index = 1; index <= Math.max(layers.length, 1); index++) {
        // The input cap applies to the chain's source only.
        const cap = index === 1 ? this.limits.maxInput : 0;
        const meter = new InputMeter(current, cap, index, signal);
        firstMeter ??= meter;
        let codecReader: CodecReader = passthrough(meter); // identity: bytes pass through the guard
        if (layers.length > 0) {
          codecReader = this.newCodecReader(layers[index - 1] as string, meter, index);
          readers.push(codecReader);
        }
        const layerGuard = new LayerGuard(codecReader, meter, index, this.limits, signal);
        guard = layerGuard;
        current = {
          next: async (max) => {
            const data = await layerGuard.read(max);
            return data.length === 0 ? null : data;
          },
        };
      }
    } catch (error) {
      for (const reader of readers) {
        try {
          reader.close?.();
        } catch {
          // contained
        }
      }
      source.release?.();
      throw error;
    }
    return new SpillgateReader(guard as LayerGuard, firstMeter as InputMeter, this.limits, readers, source.release);
  }

  private newCodecReader(name: string, meter: InputMeter, layer: number): CodecReader {
    try {
      return (this.codecs.get(name) as Codec).newReader(meter);
    } catch (error) {
      if (error instanceof SpillgateError) throw error.withLayer(layer);
      throw new InternalError(`creating the ${quoteUntrusted(name)} decoder failed`, { layer, cause: error });
    }
  }
}

function passthrough(meter: InputMeter): CodecReader {
  return { read: (max) => meter.take(max, true) } // strict: identity passes every byte it takes;
}

/** Shorthand for `new Decoder(limits, options).reader(source, encodings)`. */
export function reader(
  source: Source,
  encodings: string | readonly string[],
  limits: Limits,
  options: DecoderOptions & ReaderOptions = {},
): SpillgateReader {
  const { signal, ...decoderOptions } = options;
  return new Decoder(limits, decoderOptions).reader(source, encodings, signal === undefined ? {} : { signal });
}

/** Decode `source` completely under `limits`: the whole body, or an error. No call omits the limits (SG-R-API-01). */
export function decodeAll(
  source: Source,
  encodings: string | readonly string[],
  limits: Limits,
  options: DecoderOptions & ReaderOptions = {},
): Promise<Uint8Array> {
  const { signal, ...decoderOptions } = options;
  return new Decoder(limits, decoderOptions).readAll(source, encodings, signal === undefined ? {} : { signal });
}
