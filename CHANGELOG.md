# Changelog

Versions below 1.0 may still change the API.

## 0.1.1 - 2026-11-11

- `spillgate-zstd`: a compressed block without sequences must end right after the sequence count byte; bytes after it are now `corrupt` (they were skipped before; libzstd refuses them). Found by differential testing for the Rust port.

## 0.1.0 - 2026-11-11

First version. The TypeScript implementation of the spillgate specification.

- `Limits` with a required `maxOutput`, ratio, layer and input limits; typed, sticky errors (one class per outcome kind); `statusFor` for HTTP servers.
- gzip, deflate and identity with an own resumable DEFLATE decoder (exact input accounting, bounded steps), no dependencies, standard APIs only.
- Passes the full conformance corpus of the reference implementation: 264 of 354 vectors with the core alone, all 354 with `spillgate-br` and `spillgate-zstd` (integration suite, no skips).
- `spillgate-br`: brotli through brotli-dec-wasm (pinned exactly); window parsed from the first byte and capped before allocation, large-window streams refused as `memory_limit`.
- `spillgate-zstd`: own pure-TypeScript decoder; header, window and dictionary checks before allocation, 128 KiB block steps, XXH64 checksum, differential tests against node:zlib. The window grows with the output, and one scratch buffer serves all blocks, so frames that produce little cost little.
- Integration guide in `docs/how-to.md`.
