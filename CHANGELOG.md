# Changelog

Versions below 1.0 may still change the API.

## 0.1.3 - 2026-11-11

- `spillgate` (gzip, deflate): DEFLATE decoding tables are built with a small root table (10 bits for literals and lengths, 8 for distances) and a canonical slow path for the rare longer codes. Before, every dynamic block rebuilt tables of up to 32768 entries, so a stream of many empty blocks with 15-bit codes cost seconds of CPU per few megabytes while producing no output (the ratio and output limits cannot fire on that). Building is now O(symbols), about 20 times cheaper on that worst case (200000 empty blocks: 11 s to 0.55 s), ordinary decoding is as fast as before, and the decoder state shrinks from about 160 KiB to about 50 KiB. Found by the review of the Rust port.

## 0.1.2 - 2026-11-11

Fixes found by the independent review of the Rust port, which differential-fuzzed the same algorithms.

- `spillgate` (gzip, deflate): a dynamic block whose code lengths use "repeat previous length" (16) right after a run of zeros (17, 18) repeated the length from before the run instead of 0. Valid streams were refused as `corrupt`, and a crafted stream could build different tables than zlib. Fixed.
- `spillgate` (deflate, gzip): the bytes a failing step had already produced were dropped, so the data delivered before a `corrupt` error depended on the read size (SG-R-RDR-01). They are delivered now and the error follows on the next read.
- `spillgate-zstd`: a Huffman tree must have an even number, at least two, of weight-1 symbols (as libzstd requires); other trees were accepted before.

## 0.1.1 - 2026-11-11 (core only on npm; superseded by 0.1.2)

- `spillgate-zstd`: a compressed block without sequences must end right after the sequence count byte; bytes after it are now `corrupt` (they were skipped before; libzstd refuses them). Found by differential testing for the Rust port.

## 0.1.0 - 2026-11-11

First version. The TypeScript implementation of the spillgate specification.

- `Limits` with a required `maxOutput`, ratio, layer and input limits; typed, sticky errors (one class per outcome kind); `statusFor` for HTTP servers.
- gzip, deflate and identity with an own resumable DEFLATE decoder (exact input accounting, bounded steps), no dependencies, standard APIs only.
- Passes the full conformance corpus of the reference implementation: 264 of 354 vectors with the core alone, all 354 with `spillgate-br` and `spillgate-zstd` (integration suite, no skips).
- `spillgate-br`: brotli through brotli-dec-wasm (pinned exactly); window parsed from the first byte and capped before allocation, large-window streams refused as `memory_limit`.
- `spillgate-zstd`: own pure-TypeScript decoder; header, window and dictionary checks before allocation, 128 KiB block steps, XXH64 checksum, differential tests against node:zlib. The window grows with the output, and one scratch buffer serves all blocks, so frames that produce little cost little.
- Integration guide in `docs/how-to.md`.
