# spillgate (JavaScript / TypeScript)

Decode untrusted compressed data in JavaScript and TypeScript with mandatory limits. A
decompression bomb ends in a typed error instead of exhausting memory.

```ts
import { decodeAll, OutputLimitError } from "spillgate";

try {
  const body = await decodeAll(request.body, request.headers.get("content-encoding") ?? [], {
    maxOutput: 8 * 1024 * 1024,
  });
} catch (error) {
  if (error instanceof OutputLimitError) {
    /* refuse the request: 413 */
  }
}
```

- `Content-Encoding` chains: `gzip` (and `x-gzip`), `deflate`, `identity`. `br` and `zstd` come
  from the optional packages `spillgate-br` (a fork of
  brotli-dec-wasm built from vendored sources, with the unpatched brotli-decompressor 6.3.1) and `spillgate-zstd` (own
  bounded decoder); pass them via `new Decoder(limits, { codecs: { br: ..., zstd: ... } })`.
- `maxOutput` is required. There is no unlimited setting.
- Every layer is limited, including the intermediate layers of a chain.
- Expansion ratio and chain length are limited by default.
- Unknown, malformed or too deep `Content-Encoding` headers are refused, never passed through.
- No dependencies. Written in TypeScript, ESM only, types included.
- Uses only standard APIs (`Uint8Array`, `ReadableStream`, `AbortSignal`), no Node-specific
  module. Tested on Node 22 and 24 (Node 20 is end of life).

This is the TypeScript implementation of the language-neutral
[spillgate specification](https://github.com/FelixMiddelhoff/spillgate/blob/main/spec/SPEC.md).
It passes the same conformance corpus as the Go reference implementation. **Integrating it into
your service: [docs/how-to.md](docs/how-to.md).**

## Why its own DEFLATE decoder

`node:zlib` streams and `DecompressionStream` cannot bound the output of one write (800 bytes
can expand to gigabytes before the first byte is handed out), cannot say how many input bytes the
stream used, and handle bytes after the end of the stream differently per engine. The
`maxOutputLength` option of `node:zlib` only exists for one-shot calls. spillgate therefore
decodes DEFLATE itself, in a resumable state machine that works like zlib's `inflate()`: it stops
when the output buffer is full and counts exactly the input it took. The decoder is checked against
`node:zlib` with differential tests, and against the conformance corpus.

## Use

```ts
import { Decoder } from "spillgate";

const decoder = new Decoder({ maxOutput: 8 * 1024 * 1024 }); // build once, share everywhere

const reader = decoder.reader(source, "gzip", { signal });
try {
  for await (const chunk of reader) handle(chunk); // any exception: discard everything
} finally {
  reader.close();
}
```

`decodeAll` / `Decoder.readAll` return the whole body or throw, never partial data.
`Decoder.reader` streams; bytes can arrive before a later error, so treat any `SpillgateError` as
failure of the whole body. A reader is an `AsyncIterable<Uint8Array>` and has `toReadableStream()`.

`source` is bytes (`Uint8Array`, `ArrayBuffer`), an (async) iterable of byte chunks (a Node
`Readable`, a `fetch` body), a web `ReadableStream`, or an object with `read(max)`. It is not closed
by spillgate. The encodings are the `Content-Encoding` field values as received: one string, or an
array of strings for a repeated header.

### Limits

| Field | Meaning | Default |
| --- | --- | --- |
| `maxOutput` | bytes one layer may produce, `1 .. 2**63-1` (required) | none |
| `maxLayers` | longest chain, `1 .. 16` | 5 |
| `maxRatio` | output bytes per input byte the codec consumed | 1000 |
| `ratioGrace` | output below which the ratio is not checked | 64 KiB |
| `maxInput` | cap on compressed bytes taken from the source | none |
| `disableRatioLimit` | the one named opt-out of the ratio check | `false` |

Numbers and `bigint` are accepted. Byte counts are exact up to 2\*\*53-1; a larger limit behaves
like that. Nothing disables a limit: `0`, negative values, `NaN`, `Infinity`, strings and booleans
are all refused with `InvalidLimitsError`.

### Errors

Every refusal is a `SpillgateError` with a `kind`, a `layer` and a `limit`; there is one subclass
per kind: `OutputLimitError`, `RatioLimitError`, `LayerLimitError`, `InputLimitError`,
`MemoryLimitError`, `UnsupportedEncodingError`, `MalformedEncodingError`, `CorruptError`,
`InternalError`, `CanceledError`, `SourceError` (its `cause` is your source's own error),
`InvalidLimitsError`. Errors are sticky: after one, every later read throws the same error.
`statusFor(error)` gives the HTTP status a server should answer (413, 415, 400, 503, 500).
Messages never contain more than 32 bytes of attacker data, and that data is escaped.

`signal` (an `AbortSignal`) is checked before every read and every 4 KiB of input. It cannot
interrupt one step inside the decoder; the limits bound the work there.

## What it does not cover

Archives (zip,
tar), bounding the compressed input (use `maxInput` or your server's body limit), connection
timeouts, encrypted content. `fetch` decodes `Content-Encoding` itself before you see the body; see
[docs/how-to.md](docs/how-to.md) for what that means. See [docs/memory.md](docs/memory.md) for the
memory bounds.

## Specification and tests

`spec/SPEC.md` and `conformance/` are copies of the reference repository at the release named in
`conformance/SOURCE`. The suite runs all vectors (bombs, malformed streams, header attacks, lying
size fields), differential and property tests against `node:zlib`, a scan for unbounded platform
APIs, and memory measurements. `npm run spectrace` checks that every rule of the specification is
named by a test or vector.

## License

MIT, see [LICENSE](LICENSE). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
