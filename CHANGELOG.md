# Changelog

Versions below 1.0 may still change the API.

## Unreleased

- `spillgate-br`: **the WebAssembly decoder is now the unpatched upstream brotli-decompressor 6.3.1** (was 5.0.0 with two patches; wrapper still brotli-dec-wasm 2.3.2, rustc 1.98.1, wasm-bindgen 0.2.114, alloc-no-stdlib 3.0.0, alloc-stdlib 0.3.0). Both patch files (`spillgate.patch`, `spillgate-backport.patch`) are removed; `vendor/` is the crates.io archive (upstream tag 26c38e2). New WebAssembly sha256 `8b49f416e688a237bf667fb59cfaa5e2d0ad6f172ea87b44bb8f12f35f26b88c` (271,636 bytes, was 245,100; CI updated, rebuilt twice on Linux from different paths, identical). Details in `rust/NOTES.md`.
- `spillgate-br`, F3 (CPU of hostile meta-blocks): **no patch is needed on 6.x.** 6.x grows the prefix-code tables on demand instead of allocating and clearing them per meta-block. Same streams, best of five: 4000 meta-blocks with 256 literal and 256 distance codes (2.86 MB in) 350 ms, 122 ns per input byte (5.0.0 original 1,621 ms, 566 ns; 5.0.0 with our patch 660 ms, 231 ns); literal-only shape 170 ms (original 872 ms, patched 381 ms); 4-symbol shape 323 ms (1,726 / 796 ms); 8-bit complete trees 626 ms (1,219 / 888 ms). Linear in the input, output bit-identical. The regression test now requires at least 3 times faster than the original decoder in the same process (was 1.5) and below 300 ns per input byte (was 600).
- `spillgate-br`: behavior on damaged streams. Valid streams decode identically. 22,409 comparisons of the new decoder, the npm original and libbrotli found these differences, all on damaged or random streams and all in the direction libbrotli takes: the strictness of the 0.1.4 backports stays (nonzero end padding and an MLEN overshoot are `corrupt`); error codes changed (`-14` PADDING_1 for nonzero padding before a stored or metadata block or in an empty last block, was `-15`; `-10` BLOCK_LENGTH_2 where an MLEN overshoot is now noticed before a table error); streams are refused at the same input and output position. The public API (`ok` / `corrupt`) does not change. The decoder still accepts 27 random streams behind a large-window header that libbrotli refuses (the codec refuses the large-window marker earlier).
- `spillgate-br`: output beyond 4 GiB re-checked on 6.3.1 (brotli-decompressor 6.0.0 introduced checked `usize` arithmetic, 32 bits on wasm32): 5 GiB of zeros decode exactly, module memory at most 17.4 MiB.

## 0.1.4 - 2026-11-12

All three packages (`spillgate`, `spillgate-br`, `spillgate-zstd`).

- `spillgate-br`: **stricter brotli parsing, two upstream fixes backported** into the vendored decoder (`rust/spillgate-backport.patch`, brotli-decompressor `8ed0d7d` and `693a4a1`): a stream whose last meta-block is followed by nonzero padding bits, or whose non-last meta-block produces more than its declared MLEN, is now `corrupt` (it was accepted before; libbrotli refuses both). Valid streams are unaffected. Differential tests: the only allowed difference to the npm original is a stream refused for these two reasons, and libbrotli agrees (leniency against libbrotli 224 -> 27 damaged streams). New WebAssembly sha256 `1e5d9cbe...` (CI updated).
- `spillgate-br`: a WebAssembly trap (a Rust panic; none is known to be reachable) is now reported as `internal` (SG-R-CDC-08), not `memory_limit`; `close()` after a trap never throws; after 256 traps new streams get a fresh module instance instead of the process dying after about 3,230 traps.

- `spillgate`, `spillgate-br`: the bytes delivered before a source error late in the stream no longer depend on the caller's read size or the source's chunking. A codec used to ask the source for more input before it had emitted the output it could already produce from bytes it held, so a small read could lose up to a few bytes the same stream would deliver with a larger read (found by the new F1 test, cross-port finding from the Java review). `spillgate-zstd` was already independent (block-granular).
- `spillgate-br`: **the WebAssembly decoder is now a fork built from vendored sources** (`packages/br/rust`, notes in `rust/NOTES.md`): `brotli-dec-wasm` 2.3.2 wrapper, `brotli-decompressor` 5.0.0 with a small patch, rustc 1.98.1 + wasm-bindgen 0.2.114, no wasm-opt; the binary is committed and shipped, the package has no runtime dependencies (`brotli-dec-wasm` 2.3.2 stays as an exact-pinned dev dependency, the reference of the differential tests). Advisories for the Rust code are no longer reported by `npm audit`; they are tracked manually (RustSec, upstream repositories).
- `spillgate-br`, F3 (CPU of hostile meta-blocks): the decoder used to allocate and clear the Huffman tables of every meta-block anew (up to 1.1 MB per tree group), so thousands of tiny meta-blocks that each declare 256 prefix codes cost 530-555 ns per input byte (4000 meta-blocks with 256 literal and 256 distance codes: 2.9 MB in, 4000 bytes out, 1.59 s). The patch keeps the table memory between meta-blocks: 231-242 ns per input byte (0.66 s for that stream; 0.38 s for the literal-only shape), 2.2 to 2.4 times faster, output bit-identical. What remains is the work of reading the trees, linear in the input with a constant factor. The output and ratio limits still cannot fire on such a stream (a few bytes out); `maxInput` and the caller's `AbortSignal` bound it. Regression tests: absolute bound, at least 1.5 times faster than the original decoder in the same process (fails on the unpatched build), linearity, plus a block-type shape. Differential tests: 22,164 comparisons of fork, original and libbrotli (valid, damaged, random and hostile streams) all agree.
- `spillgate-br`: the committed WebAssembly decoder is rebuilt on Linux (Ubuntu 24.04, same sources and toolchain, sha256 `3be7ab72...`) so that CI (`brotli-wasm` job, ubuntu-latest) can reproduce it byte for byte; the Windows-built binary embedded Windows paths. Behavior unchanged (tests and differential tests re-run).
- `maxInput` (SG-R-INP-01, corpus 0.2.0): only taking the byte after `maxInput` is `input_limit`; looking at it is not. A complete stream of exactly `maxInput` bytes followed by more data is now `corrupt` (gzip, deflate, brotli, zstd: trailing data, as without a limit), where it used to be `input_limit`. A codec that needs the byte after the limit to go on still ends in `input_limit` (the count of consumed bytes is checked at the end of every codec step); only a source that really ends there is a truncated stream (`corrupt`). Identity keeps the strict behavior. A byte that could start another gzip member (0x1f) or zstd frame (0x28, 0x50..0x5f) is taken, so it is `input_limit` at `maxInput` = stream length. Conformance corpus 0.2.0 (vectors SG-V-BND-0041 to 0057) is included.

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
