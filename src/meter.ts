/**
 * The input meter: counts what a codec takes, and guards the source.
 *
 * A codec never talks to the caller's source directly. It takes its compressed bytes from an
 * {@link InputMeter}, which
 *
 * - counts the bytes the codec actually *takes* (not the bytes it fetched from the source), so a
 *   read-ahead buffer never gives free ratio credit (SG-R-RAT-02);
 * - lets a codec hand back bytes it took but did not need ({@link InputMeter.unread}), which also
 *   lowers the count again;
 * - enforces the optional `maxInput` cap (SG-R-INP-01, INP-02);
 * - defends against misbehaving sources: one that makes no progress is `internal`
 *   (SG-R-RDR-03), one that throws is `source_error` (SG-R-RDR-05).
 */

import {
  CanceledError,
  CorruptError,
  InputLimitError,
  InternalError,
  SourceError,
  SpillgateError,
} from "./errors.js";
import type { RawSource } from "./source.js";

export const BUFFER_SIZE = 4096; // well below the 64 KiB look-ahead tolerance of SG-R-RAT-02
export const MAX_EMPTY_READS = 100; // SG-R-RDR-03

export class InputMeter {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private fetched = 0; // bytes obtained from the source, probe included
  private _consumed = 0; // bytes taken by the codec
  private sourceEnded = false;
  private failure: SpillgateError | undefined;
  /** The source's own error, if it threw. */
  sourceError: unknown;

  constructor(
    private readonly source: RawSource,
    private readonly maxInput: number, // 0 means no cap
    private readonly layer: number,
    private readonly signal?: AbortSignal,
  ) {}

  /** Bytes the codec has taken so far (the `C(k)` of the specification). */
  get consumed(): number {
    return this._consumed;
  }

  /** The `source_error` this meter raised, if the source failed. */
  get sourceFailure(): SourceError | undefined {
    return this.failure instanceof SourceError ? this.failure : undefined;
  }

  /** Bytes fetched and not yet taken. */
  get buffered(): number {
    return this.buf.length - this.pos;
  }

  /**
   * The buffered bytes, limited to what `maxInput` still allows. Take them with {@link advance}.
   * Throws if the allowance is used up and a further byte exists (the probe byte, SG-R-INP-01).
   */
  view(): Uint8Array {
    if (this.failure) throw this.failure;
    const available = this.buf.length - this.pos;
    if (available === 0) return EMPTY;
    if (this.maxInput === 0) return this.buf.subarray(this.pos);
    const allowance = this.maxInput - this._consumed;
    if (allowance <= 0) throw this.fail(new InputLimitError(`the stream needs more than ${this.maxInput} input bytes`, { layer: this.layer, limit: this.maxInput }));
    return this.buf.subarray(this.pos, this.pos + Math.min(available, allowance));
  }

  /** Mark `n` bytes of the current view as taken. */
  advance(n: number): void {
    this.pos += n;
    this._consumed += n;
  }

  /**
   * Make at least one byte available if the source has one. Returns false at the clean end of the
   * source.
   */
  async fill(): Promise<boolean> {
    if (this.failure) throw this.failure;
    if (this.pos < this.buf.length) return true;
    if (this.sourceEnded) return false;
    if (this.signal?.aborted) throw this.fail(new CanceledError("canceled by the caller", { layer: this.layer, cause: this.signal.reason }));
    const want = this.fetchSize();
    if (want < 1) {
      throw this.fail(new InputLimitError(`the stream needs more than ${this.maxInput} input bytes`, { layer: this.layer, limit: this.maxInput }));
    }
    for (let attempt = 0; attempt < MAX_EMPTY_READS; attempt++) {
      const chunk = await this.readSource(want);
      if (chunk === null) {
        this.sourceEnded = true;
        return false;
      }
      if (chunk.length === 0) continue; // no progress yet, try again (bounded)
      if (chunk.length > want) {
        throw this.fail(new InternalError("the source returned more bytes than requested", { layer: this.layer }));
      }
      this.buf = chunk;
      this.pos = 0;
      this.fetched += chunk.length;
      return true;
    }
    throw this.fail(new InternalError("the source made no progress", { layer: this.layer }));
  }

  /** Return up to `n` bytes; an empty array means the source has ended cleanly. */
  async take(n: number): Promise<Uint8Array> {
    if (n <= 0) return EMPTY;
    if (!(await this.fill())) return EMPTY;
    const view = this.view();
    const chunk = view.subarray(0, Math.min(n, view.length));
    this.advance(chunk.length);
    return chunk;
  }

  /** Exactly `n` bytes, or {@link CorruptError} if the input ends first. */
  async takeExact(n: number, what: string): Promise<Uint8Array> {
    if (n === 0) return EMPTY;
    const first = await this.take(n);
    if (first.length === n) return first;
    const out = new Uint8Array(n);
    let have = 0;
    let chunk = first;
    for (;;) {
      if (chunk.length === 0) throw new CorruptError(`${what}: the stream ends too early`, { layer: this.layer });
      out.set(chunk, have);
      have += chunk.length;
      if (have === n) return out;
      chunk = await this.take(n - have);
    }
  }

  /** True if no byte is left. Takes nothing: a byte found is handed back. */
  async atEnd(): Promise<boolean> {
    const chunk = await this.take(1);
    if (chunk.length === 0) return true;
    this.unread(chunk);
    return false;
  }

  /** Hand back bytes just taken, in order, so the next take returns them first. */
  unread(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (bytes.length > this._consumed) {
      throw new InternalError("unread of more bytes than were taken", { layer: this.layer });
    }
    // Usual case: the bytes are the ones just before the cursor in the same chunk. Step back
    // instead of copying the whole look-ahead (a gzip stream of many tiny members hands back its
    // trailer-adjacent bytes at every member boundary).
    if (this.pos >= bytes.length && sameBytes(this.buf, this.pos - bytes.length, bytes)) {
      this.pos -= bytes.length;
      this._consumed -= bytes.length;
      return;
    }
    const rest = this.buf.subarray(this.pos);
    const joined = new Uint8Array(bytes.length + rest.length);
    joined.set(bytes, 0);
    joined.set(rest, bytes.length);
    this.buf = joined;
    this.pos = 0;
    this._consumed -= bytes.length;
  }

  /** With a cap, never ask for more than `maxInput + 1` bytes in total (SG-R-INP-02). */
  private fetchSize(): number {
    if (this.maxInput === 0) return BUFFER_SIZE;
    const room = this.maxInput - this.fetched; // still allowed before the probe byte
    return room >= BUFFER_SIZE ? BUFFER_SIZE : room + 1;
  }

  private async readSource(want: number): Promise<Uint8Array | null> {
    try {
      const pending = this.source.next(want);
      // A source that never answers must not outlive an abort (SG-R-API-04).
      const chunk: unknown = await (this.signal === undefined ? pending : this.raceAbort(pending, this.signal));
      if (chunk === null || chunk === undefined) return null;
      if (!(chunk instanceof Uint8Array)) {
        throw this.fail(new InternalError("the source returned something that is not bytes", { layer: this.layer }));
      }
      return chunk;
    } catch (error) {
      let ours = false;
      try {
        ours = error instanceof SpillgateError;
      } catch {
        // a hostile thrown value (a revoked Proxy) can make even this check throw: it is a source failure
      }
      if (ours) {
        // The source is the previous layer of a chain, or an abort: its error passes through.
        this.failure = error as SpillgateError;
        throw error;
      }
      this.sourceError = error;
      throw this.fail(new SourceError("the source failed", { layer: this.layer, cause: error }));
    }
  }

  private raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    const canceled = (): CanceledError => new CanceledError("canceled by the caller", { layer: this.layer, cause: signal.reason });
    if (signal.aborted) return Promise.reject(canceled());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(canceled());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private fail(error: SpillgateError): SpillgateError {
    this.failure = error;
    return error;
  }
}

function sameBytes(buffer: Uint8Array, at: number, bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (buffer[at + i] !== bytes[i]) return false;
  return true;
}

const EMPTY = new Uint8Array(0);
