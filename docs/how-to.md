# How to use spillgate in your JavaScript / TypeScript service

This guide is for the developers who build the service: where to put spillgate, how to choose the
limits, how to wire it into HTTP clients, servers and other data paths, and what to do with the
results. The rules behind the library are in [spec/SPEC.md](../spec/SPEC.md); the API is documented
in the type declarations.

## 1. What spillgate protects you from

Any code that decompresses bytes someone else controls can be made to allocate gigabytes from a few
kilobytes (a decompression bomb): by one layer, by a chain of encodings
(`Content-Encoding: gzip, gzip, gzip, ...`), by lying size fields, or by exotic codecs. spillgate
sits in front of the decompressor and turns each of those into a typed error with bounded memory.
It does not replace limits on the compressed size, timeouts or authentication.

The rule of thumb: **every place where your service turns compressed bytes into plain bytes must go
through spillgate**. Section 6 shows how to find those places.

JavaScript makes this easy to get wrong:

- `fetch` decodes `Content-Encoding` for you, always, and leaves the header on the response.
- `zlib.gunzipSync(buf)` and `zlib.gunzip(buf, cb)` expand without a bound unless you pass
  `maxOutputLength`, which exists only on the one-shot methods, not on streams.
- `zlib.createGunzip()` and `DecompressionStream` cannot bound the output of one write: a few hundred
  bytes written to them can expand to gigabytes before the first byte is handed out.
- Many HTTP client libraries (axios, got, node-fetch, superagent) and body parsers decode by default.

## 2. Choose the limits

```ts
const limits = {
  maxOutput: 8 * 1024 * 1024, // required: bytes each layer may produce
  maxLayers: 3,               // default 5, range 1..16
  maxRatio: 1000,             // default 1000
  ratioGrace: 64 * 1024,      // default 64 KiB
  maxInput: 2 * 1024 * 1024,  // optional: compressed bytes taken from the source
};
```

| Field | What it bounds | Default |
| --- | --- | --- |
| `maxOutput` | bytes **each layer** may produce (required) | none |
| `maxLayers` | non-identity encodings in one chain (1..16) | 5 |
| `maxRatio` | output bytes per input byte the decoder consumed | 1000 |
| `ratioGrace` | output size below which the ratio is not checked | 64 KiB |
| `maxInput` | compressed bytes taken from the source | none |
| `disableRatioLimit` | named opt-out of the ratio check | `false` |

`maxOutput` and friends accept `number` and `bigint`. An invalid value (missing, zero, negative,
fractional, `NaN`, `Infinity`, a string, a boolean) throws `InvalidLimitsError` when you create the
`Decoder`.

### maxOutput: the memory you are willing to spend

Think of it as "the largest legitimate body this endpoint should ever see, after decompression".
Do not use one global number:

| Data path | Starting point |
| --- | --- |
| JSON API request bodies | 1 to 10 MiB |
| HTML or JSON fetched from third parties | 8 to 32 MiB |
| File upload processed in memory (`decodeAll`) | the largest file you accept, and no more |
| File upload streamed to disk | your storage quota per object |
| Message queue payloads | the broker's maximum message size times a small factor |

Look at the 99.9th percentile of real decoded sizes in production and add headroom. A limit 100 times
larger than anything legitimate only helps the attacker. `decodeAll` and `Decoder.readAll` hold the
whole body in memory, so `maxOutput` is also their peak memory per call; multiply by your
concurrency (in-flight requests). The default heap of a Node process is a few GiB; a 64 MiB limit with
100 parallel requests is already 6 GiB.

### maxRatio and ratioGrace

The ratio is checked per layer and end to end. The default of 1000 stops the classic bombs (zeros
compress to about 1030:1 in DEFLATE at best) while ordinary data stays far below it (typical JSON
about 350:1 at the extreme). Raise it only if a measured, legitimate data type needs it. Prefer
raising `maxRatio` for one endpoint over `disableRatioLimit: true`, which leaves only `maxOutput`
between you and a bomb. Leave `ratioGrace` alone; it keeps tiny messages from being refused.

### maxLayers and maxInput

Real traffic uses one layer, rarely two. The default of 5 is generous; use 2 or 3 for public
endpoints. Chains of more than 16 elements are refused whatever you set.

If the compressed size is not already bounded by your server, framework or broker, add `maxInput`.
spillgate bounds the output; it is not a substitute for limiting how many bytes you accept.

## 3. Wire it in

Create one `Decoder` at start-up and share it. It is immutable and safe to share; each reader it
returns is for one body and not for concurrent reads.

```ts
import { Decoder } from "spillgate";

export const decoder = new Decoder({ maxOutput: 8 * 1024 * 1024, maxLayers: 3, maxInput: 2 * 1024 * 1024 });
```

The constructor validates the limits and reads no data. Let a misconfiguration crash at start-up, not
on the first request.

`source` is `Uint8Array`/`ArrayBuffer`, an (async) iterable of byte chunks (a Node `Readable`, the
`req` of an HTTP server), a web `ReadableStream`, or an object with `read(max)`. spillgate never
closes it. The encodings are the `Content-Encoding` values as received: one string, or an array of
strings when the header was sent several times.

### 3.1 HTTP client with `node:http` or `node:https`

The Node HTTP modules never decode; the response is a `Readable` of the raw bytes:

```ts
import http from "node:http";
import { SpillgateError, statusFor } from "spillgate";

function get(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { "accept-encoding": "gzip, deflate" } }, (res) => {
      decoder
        .readAll(res, res.headersDistinct["content-encoding"] ?? [])
        .then(resolve, reject)
        .finally(() => res.destroy()); // stop reading the network once decoding ended
    });
  });
}
```

Set `Accept-Encoding` yourself and offer only what the decoder supports (`gzip, deflate`). Check
`res.statusCode` before decoding if you care about error bodies; they are decoded the same way.

### 3.2 `fetch`: the body is already decoded

`fetch` (Node, Deno, Bun, browsers) decodes `Content-Encoding` itself, before you see the body, and
leaves the `Content-Encoding` header on the response. Two consequences:

- **Do not pass the header to spillgate**: the body is plain data, and decoding it again fails as
  `corrupt`. Treat the body as identity.
- spillgate then only bounds the size. That still helps a lot, because the platform decodes lazily
  while you read and stops when you cancel (measured on Node 24: a 300 MB gzip bomb behind `fetch`
  was refused at 1 MiB of output after 49 ms and 7 MB of extra memory), but the ratio and layer
  protections do not apply and one chunk of compressed input can still expand a lot before you see it.

```ts
const response = await fetch(url);
const body = await decoder.readAll(response.body ?? new Uint8Array(0), []); // identity, bounded
```

For full protection use `node:http(s)` (section 3.1), or a client in which you can turn decoding off
(axios `decompress: false` with `responseType: "stream"`, node-fetch `compress: false`; check the
documentation of the version you use) and pass the raw stream and header to spillgate.

### 3.3 HTTP server: request bodies

Node's `http` server gives you the raw, still-compressed request as a `Readable`:

```ts
import http from "node:http";
import { SpillgateError, statusFor } from "spillgate";

http.createServer(async (req, res) => {
  try {
    const body = await decoder.readAll(req, req.headersDistinct["content-encoding"] ?? []);
    res.writeHead(200).end(await handle(body));
  } catch (error) {
    if (!(error instanceof SpillgateError)) throw error;
    log.warn({ kind: error.kind, layer: error.layer, limit: error.limit }, "request body refused");
    res.writeHead(statusFor(error)).end(error.kind); // a fixed text, nothing from the attacker
  }
}).listen(8080);
```

Frameworks that parse the body for you (Express `express.json()`, Fastify, Koa body parsers) decode
`Content-Encoding` in their parser, with their own limits. Do not put spillgate behind them: read the
raw `req` yourself in a route that needs it, or turn their inflation off (`inflate: false`) and decode
with spillgate first. Keep a limit on the compressed size in the server or parser.

### 3.4 Fetch API handlers (Workers, Deno, Bun, Next.js route handlers)

`request.body` is a `ReadableStream` of the raw bytes; the platform does not decode request bodies:

```ts
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await decoder.readAll(request.body ?? new Uint8Array(0), request.headers.get("content-encoding") ?? []);
    return new Response(await handle(body));
  } catch (error) {
    if (error instanceof SpillgateError) return new Response(error.kind, { status: statusFor(error) });
    throw error;
  }
}
```

### 3.5 Any other source: files, S3 objects, queues

```ts
const reader = decoder.reader(fileStream, "gzip");
try {
  for await (const chunk of reader) await out.write(chunk);
  await out.commit(); // only reached if no error came
} catch (error) {
  await out.discard();
  throw error;
}
```

For content stored with a known encoding pass it yourself (`"gzip"`). Pass `[]` for plain data that
should still be bounded. Reading a Node file as `fs.createReadStream(path)` works as a source.

### 3.6 Whole body versus streaming

- `decodeAll` / `Decoder.readAll`: simplest. You get the complete body or an error and **no data**.
  Peak memory is the decoded size, at most `maxOutput`.
- `Decoder.reader`: streaming; the reader is an `AsyncIterable<Uint8Array>` and has `read()`,
  `readAll()`, `toReadableStream()` and `close()`. **Bytes can be delivered before a later error.**
  Whatever you did with them (wrote to a file, fed a parser, stored in a database) must be undone when
  an error comes. Write to a temporary file and rename on success; never commit a partial body.

A single `read(n)` returns at most 64 KiB whatever `n` is. Loop until it resolves to `null`.
`for await` closes the reader for you, also when you leave the loop early.

### 3.7 Cancellation

`decoder.reader(source, encodings, { signal })` (and `decodeAll(..., { signal })`) checks the
`AbortSignal` before every read and every 4 KiB of input; when it is aborted the reader fails with
`CanceledError`, sticky. It cannot interrupt one step inside the decoder (the limits bound that), and
it does not interrupt a `read` of your source that is already waiting; use socket timeouts for that.

### 3.8 Your own codec

Register it on the decoder: `new Decoder(limits, { codecs: { snappy } })`. It runs behind the same
limiter, so even a careless codec cannot exceed `maxOutput`. See the `Codec` type for the contract.
Names must be lower-case tokens and must not reuse the built-in names.

## 4. Handle the results

Every refusal is a `SpillgateError` with a `kind`, the `layer` that failed (1 reads from the source)
and the `limit` that was exceeded. There is one subclass per kind, so you can use `instanceof` or
`kind`. `statusFor(error)` gives the HTTP status for a server.

```ts
import { SpillgateError } from "spillgate";

function recordRefusal(error: SpillgateError): void {
  metrics.decodeRefused.inc({ kind: error.kind });
  switch (error.kind) {
    case "internal":
    case "memory_limit":
      log.error({ kind: error.kind, layer: error.layer }, "decoder problem"); // look at these
      break;
    case "source_error":
    case "canceled":
      log.debug({ kind: error.kind }, "decode interrupted"); // not an attack signal
      break;
    default:
      log.warn({ kind: error.kind, layer: error.layer, limit: error.limit }, "refused");
  }
}
```

### What each outcome means and what to do

| Kind | Meaning | Server answers | Client side | Log / metric |
| --- | --- | --- | --- | --- |
| `output_limit` | the data decodes to more than `maxOutput` | 413 | treat the response as failed, do not retry | warn, count; a spike is an attack or a limit that is too low |
| `ratio_limit` | expansion over `maxRatio` | 413 | failed, do not retry | warn, count; check if a legitimate data type needs a higher ratio |
| `layer_limit` | more layers or elements than allowed | 413 (or 400) | failed, do not retry | warn, count |
| `input_limit` | more compressed bytes than `maxInput` | 413 | failed, do not retry | warn, count |
| `unsupported_encoding` | a valid token the decoder cannot handle (`compress`, `br`, `zstd`, `dcz`, ...) | 415 | failed; nothing was decoded | info; shows clients using something you do not offer |
| `malformed_encoding` | the header breaks the strict grammar | 400 | failed | info, bounded text only |
| `corrupt` | the stream is invalid, truncated or has trailing data | 400 | may retry once if the connection was cut; a repeat is a bad server | info |
| `memory_limit` | an optional codec needs a larger window than its cap | 413 | failed, do not retry | warn; check the cap |
| `source_error` | your source (network, disk) failed; the original error is `cause` | 5xx or 400 | retry by your usual policy | the cause is in `error.cause` |
| `canceled` | your `AbortSignal` fired | no response needed | no retry by itself | debug |
| `internal` | a codec or source broke its contract | 500 | failed | **error and alert**: please report it (see `SECURITY.md`) |
| `invalid_limits` | bad configuration | - | - | thrown by `new Decoder`, never during traffic |

A closed reader throws `ClosedError`, a bad extension-codec name `InvalidOptionError`; both are
programming errors, not data errors.

General rules:

1. **Any error means the whole body is unusable**, including the bytes you already received.
2. **Never retry a limit error.** The same input gives the same result and costs the same work.
3. **Check with `instanceof SpillgateError`, and rethrow everything else.** A blanket `catch` hides
   bugs in your code.
4. **Do not echo error details to the caller.** Return a fixed message and the status code. The
   library's own messages contain at most 32 bytes of attacker data, quoted and escaped, but your
   logs and responses are your decision; log the kind, layer, limit and a request ID, not the body.
5. **Treat repeated limit errors from one client as abuse**: rate-limit or block like other malformed
   input. One `ratio_limit` can be an accident; thousands from one address are not.
6. **Alert on `internal` and `memory_limit`** rather than on the limit errors you expect.
7. **Unhandled rejections**: an error thrown inside a stream callback that nobody awaits crashes a
   modern Node process. Await `readAll` and attach `.catch` to every promise you start.

### Tuning after launch

Run for a few days with the limits at their intended values and count refusals per endpoint. If
legitimate traffic is refused, raise the specific limit for that endpoint by the smallest amount that
fixes it and write down why. Do not switch limits off to make an alert go away.

## 5. Test your integration

1. **Build a bomb and see it refused.** 50 MB of zeros compress to about 50 KB:

   ```ts
   import zlib from "node:zlib";

   const gzipBomb = (size: number) => zlib.gzipSync(Buffer.alloc(size), { level: 9 });

   test("endpoint refuses bombs", async () => {
     const res = await fetch(url, { method: "POST", body: gzipBomb(50_000_000), headers: { "content-encoding": "gzip" } });
     assert.equal(res.status, 413);
   });
   ```

   For larger or exotic cases use the generated inputs of the conformance corpus
   ([conformance/](../conformance), built by `tests/corpus.ts`).
2. **Test every ingress.** Each endpoint and background consumer gets a bomb test, a test with
   `Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip, gzip`, one with an unknown encoding
   (`Content-Encoding: compress`) and one with a truncated body.
3. **Check memory.** Run the bomb test and compare `process.memoryUsage()` before and after (call
   `global.gc()` with `--expose-gc` first), or run it in a child process with `--max-old-space-size`
   set low and expect it to finish.
4. **Test the partial-data rule.** Make the downstream step fail midway and check that nothing from
   the failed body is committed.

## 6. Find and fix the places that decompress today

Search your code and your dependencies:

```
grep -rnE "zlib\.(gunzip|inflate|unzip|brotliDecompress|createGunzip|createInflate|createUnzip|createBrotliDecompress)|DecompressionStream|pako|fflate|decompress|inflate\b" src/
```

Then look at what decodes without you asking:

- HTTP clients: `fetch` (always), axios, got, node-fetch, superagent, undici-based SDKs, and the SDKs
  that wrap them (cloud SDKs, API clients). Turn decoding off where the client allows it and pass the
  raw stream to spillgate, or bound the already decoded body as identity.
- Servers and frameworks: Express/Fastify/Koa body parsers and compression middleware that inflate
  request bodies, reverse proxies that decompress for you, gRPC (`grpc-js` message compression).
- Object storage and file helpers: S3 `GetObject` helpers with auto-decompression, `tar`/`zip`/`adm-zip`
  (archives are out of scope for spillgate; bound them separately), `readline` over a gunzip stream.

For each, replace the decoder with spillgate or make sure it never sees unbounded data.

## 7. Pitfalls

- **Decoding in two places.** If a proxy, middleware or client library decodes before spillgate,
  spillgate only bounds the plain data and the bomb has already been expanded. Make sure spillgate is
  the first decoder in the path. With `fetch` the header is still there: do not pass it on.
- **Reading the body twice.** After an error the reader is spent. Do not fall back to "just read it plainly".
- **A huge `maxOutput` "to be safe".** It makes the guard useless. Size it from data.
- **`disableRatioLimit: true` as a first reaction.** See the tuning section.
- **Unbounded concurrency.** Each in-flight `decodeAll` may hold up to `maxOutput` bytes; limit
  parallel requests or stream.
- **Buffer reuse.** Chunks you receive from `reader.read()` are yours to keep; the library does not
  reuse them. Sources may reuse their own buffers; spillgate copes with that.
- **Forgetting to close a reader you stop reading.** `for await` closes it; a manual `read` loop must
  call `reader.close()` in a `finally`.
- **Treating `identity` as safe.** An unencoded body is bounded as well; that is deliberate.

## 8. Checklist before you ship

- [ ] One shared `Decoder`, created at start-up, limits chosen per data path from real sizes.
- [ ] Every ingress (HTTP client, server endpoint, queue consumer, file or object reader) goes through spillgate; no other decoder runs before it.
- [ ] HTTP clients are told not to decode, or the body is bounded as identity with the header ignored; `Accept-Encoding` is set explicitly to what the decoder supports.
- [ ] The compressed size is bounded separately (server body limit, `maxInput`).
- [ ] Streaming consumers discard or roll back partial data on any error.
- [ ] Limit errors map to 413, unsupported encodings to 415, malformed or corrupt data to 400 (`statusFor`).
- [ ] Metrics per `kind`; alerts on `internal` and `memory_limit`; refusals visible per endpoint.
- [ ] No retries of limit errors; no echoing of attacker-supplied text.
- [ ] Bomb, deep-chain, unknown-encoding and truncation tests exist for every ingress and run in CI.
- [ ] You know who gets the report if `internal` appears (see [SECURITY.md](../SECURITY.md)).
