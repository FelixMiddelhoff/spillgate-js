# The WebAssembly decoder of spillgate-br (fork of brotli-dec-wasm 2.3.2)

`spillgate-br` ships `src/native/brotli_dec_wasm_bg.wasm` and its glue code, built from the sources
in this directory. It replaces the npm dependency `brotli-dec-wasm` 2.3.2 (kept as an exact-pinned
**dev** dependency: it is the reference of the differential tests). Reason: F3, the CPU cost of
hostile meta-blocks (see "Patch" and the threat model).

## Sources

| What | Where | Version / commit |
|---|---|---|
| Wrapper (`src/*.rs`, `Cargo.toml`, `Cargo.lock`, licenses) | https://github.com/ustclug-dev/brotli-dec-wasm | tag `v2.3.2`, commit `04947d5b2cbcf0487435d26d6598ea624a6b191b`. Changed: package name `spillgate-brotli-wasm` (lib name `brotli_dec_wasm` unchanged), `brotli-decompressor` as path dependency `=5.0.0`. No source change in `src/*.rs`. |
| `vendor/brotli-decompressor` | crates.io `brotli-decompressor` | **5.0.0**, upstream commit `a91c112180789502cdb9bf9e87f9546dd9a970fd` (from `.cargo_vcs_info.json`), registry checksum `874bb8112abecc98cbd6d81ea4fa7e94fb9449648c93cc89aa40c81c24d7de03`. Unpatched copy committed first (`07c4b3f`), the patch is a separate commit. |
| Other crates | crates.io, `Cargo.lock` (checksums) | wasm-bindgen 0.2.114, alloc-no-stdlib 2.0.4, alloc-stdlib 0.2.2, console_error_panic_hook 0.1.7, cfg-if 1.0.4, once_cell 1.21.4 (+ proc-macro crates, not linked) |

Version note: upstream's `Cargo.lock` at `v2.3.2` pins `brotli-decompressor` **5.0.0** (the npm
package 2.3.2 contains that version). Upstream's current `master` pins 5.0.3; that was not used,
because the released npm module 2.3.2 is what the differential tests compare against and what the
Rust port's patch (vendored 5.0.0) was written for. Moving to a newer brotli-decompressor means
re-applying `spillgate.patch`, re-running the differential tests and re-checking the numbers.

## Toolchain and build

- rustc 1.98.1 (48a229cea 2026-09-01), cargo 1.98.1, target `wasm32-unknown-unknown`
  (build host: Linux, Ubuntu 24.04 under WSL, x86_64-unknown-linux-gnu; CI builds on ubuntu-latest), wasm-bindgen CLI 0.2.114 (equal to the locked crate).
- Release profile as upstream (`opt-level = "s"`, `lto = true`).
- Command (`npm run build:wasm -w spillgate-br`, i.e. `bash rust/build.sh`):

  ```
  RUSTFLAGS="--remap-path-prefix=<this dir>=/spillgate-br-rust --remap-path-prefix=<CARGO_HOME>=/cargo --remap-path-prefix=<rustc sysroot>=/rustc" \
    cargo build --release --locked --target wasm32-unknown-unknown
  wasm-bindgen --target web --out-dir src/native --out-name brotli_dec_wasm \
    target/wasm32-unknown-unknown/release/brotli_dec_wasm.wasm
  ```

  The path remapping is meant to make the output independent of the checkout location. Repeated
  builds on the build machine gave the same hash; a build from another directory, another OS or
  another rustc was not checked.

  **Checked on 2026-11-12, and it is less than that sentence suggests:**
  - Windows (the build machine), copy of this directory at another path with another target
    directory: byte-identical to the committed files (wasm, glue, typings). Repository paths are
    remapped.
  - `CARGO_HOME` is **not** remapped on Windows: `build.sh` passes `$HOME/.cargo` in Git Bash form
    (`/c/Users/...`), cargo embeds `C:\Users\...\.cargo\registry\src\...`. The committed binary still
    contains those Windows paths, and the vendored crate's paths keep backslashes
    (`vendor\brotli-decompressor\src\...`). A changed remap would change the shipped bytes; not done.
  - Linux (Ubuntu 24.04 under WSL, clean clone of `b23e41a`, rustc 1.98.1 linux-gnu, wasm-bindgen
    0.2.114 `--locked`): `3be7ab7252861c4e8625bbd04ff99b2755201e1ee292e522a85133c3287ef5ad`, **not**
    the committed hash. Two Linux builds from different source paths and target directories were
    byte-identical, so the Linux build is deterministic and path-independent; the difference to the
    committed binary is the Windows paths above.
  - So the committed binary cannot be reproduced on Linux, and the Windows output is not
    OS-independent. See "Reproducing the binary in CI" below.
- Upstream builds with `wasm-pack build -t web`, which runs `wasm-opt` and then minifies the glue
  code with esbuild. **wasm-pack, wasm-opt and esbuild were not used here** (not installed; no tool
  was installed beyond rustc, the wasm32 target and wasm-bindgen-cli). So the module is not
  size-optimized: 245,459 bytes instead of 208,439 bytes for the npm module; the glue is not
  minified (18.8 KB). The code is the same, behavior is compared by the differential tests, not by
  bytes. (A check build with `opt-level = 3` was not meaningfully faster on the hostile streams, so
  upstream's "s" was kept.)
- sha256 of `src/native/brotli_dec_wasm_bg.wasm`:
  - unpatched build of the vendored sources: `e871a61cd56c9fd3f4e7eaae2dda28f58023c9ce83dfd5f6744b239fb1d1e29a` (commit `07c4b3f`)
  - patched (shipped, built on Linux/WSL Ubuntu 24.04, reproduced by CI on ubuntu-latest): `3be7ab7252861c4e8625bbd04ff99b2755201e1ee292e522a85133c3287ef5ad`
  - patched, built on Windows: `4a6f77a8563cf469bbb4db56ca746f54dcec92d665dc1593c0c38f2e73f03afe` (**superseded**, no longer shipped)
  - for reference, the npm `brotli-dec-wasm` 2.3.2 module: 208,439 bytes (different toolchain and wasm-opt, different bytes expected)

The committed binary is the release artifact. `npm run build` copies `src/native` to `dist/src/native`;
nothing is compiled at install time and the package has no runtime dependencies. To check a
checkout: run `build:wasm` on Linux or WSL (same rustc and wasm-bindgen versions needed) and compare the hash.
**Windows builds are not byte-reproducible against the shipped binary**: cargo embeds the Windows
CARGO_HOME and backslash paths that `--remap-path-prefix` does not map (Git Bash path form), so a
Windows build has another hash with identical behavior. Use Linux/WSL or the CI artifact.

## Reproducing the binary in CI (job `brotli-wasm`, `.github/workflows/ci.yml`)

The job pins rustc 1.98.1 (rustup, wasm32 target) and `wasm-bindgen-cli` `=0.2.114 --locked`, then:

1. builds `build.sh` into a fresh target directory (`wasm-1`),
2. builds again from a copy of `packages/br/rust` at another path, with another target directory
   (`wasm-2`),
3. fails unless: the committed binary's hash is the `EXPECTED_SHA256` constant in `ci.yml`;
   build 1 and build 2 are identical (determinism); build 1 equals the committed binary; the glue
   and typings are identical too.

It never continues on error. The files of build 1 are uploaded as the artifact
`brotli-wasm-rebuilt-ubuntu` (kept 14 days) on every run, pass or fail.

**Status:** the committed binary was rebuilt on Linux (WSL Ubuntu 24.04, clean clone, two paths,
byte-identical) on 2026-11-12 and is `3be7ab7252861c4e8625bbd04ff99b2755201e1ee292e522a85133c3287ef5ad`. The earlier Windows-built binary
(`4a6f77a8...`) is superseded; the shipped bytes changed, the behavior did not (br tests and the
differential tests were re-run). The job compares against this hash. If a rebuild differs on
purpose (toolchain bump, patch change): download the artifact `brotli-wasm-rebuilt-ubuntu`, copy its
four files over `packages/br/src/native/`, update `EXPECTED_SHA256` in `ci.yml` and the list above,
run `npm test`, add a CHANGELOG line, commit.

## Patch (`spillgate.patch`, 2 files, +32 -10 lines, taken from the Rust port's patch of 5.0.0)

`HuffmanTreeGroup::init` (huffman/mod.rs) used to free the table memory of the previous meta-block
and allocate and zero `ntrees * 1080` entries (up to 256 trees: 1.1 MB per tree group) for every
meta-block. A stream of thousands of tiny meta-blocks that each announce 256 trees therefore made the
decoder allocate and clear gigabytes per megabyte of input. Now the table memory is kept between
meta-blocks (reallocated only when a meta-block needs more), a new `retire` replaces `reset` in
`BrotliStateMetablockBegin`/`CleanupAfterMetablock` (state.rs), and `BrotliStateCleanup` releases it
when the stream state ends. Stale entries are never read: every tree is built before it is used.
Output is bit-identical (differential tests below).

Tried and dropped: reusing the two context-map buffers (16 KiB literal, 1 KiB distance at 256 block
types) between meta-blocks. A hostile shape for it (`hostileBlockTypes`) costs 130 ns per input byte
before and after the change, i.e. less than the tree shape; the allocation is not where the time
goes, so the change was not kept (smaller patch to review).

## Measured (Node 24, the author's machine, 2026-11-12, best of three, no wasm-opt)

| Stream | Original 2.3.2 (self-built, unpatched) | Fork |
|---|---|---|
| 4000 meta-blocks x 256 literal trees (1.58 MB) | 838 ms, 531 ns/B | 381 ms, 242 ns/B |
| same + 256 distance trees (2.86 MB) | 1590 ms, 555 ns/B | 660 ms, 231 ns/B |
| 4000 x (256 literal + 256 distance trees, 4 symbols each) (6.1 MB) | 1708 ms, 282 ns/B | 796 ms, 131 ns/B |
| 1000 x 256 complete 8-bit trees + 256 distance trees (9.5 MB) | 1009 ms, 106 ns/B | 888 ms, 94 ns/B |
| 4000 meta-blocks with 256 literal block types (0.31 MB) | - | 41 ms, 130 ns/B |

What remains is the cost of reading the trees (about 290 ns per tree in the decoder itself,
390 bytes of input per 256 one-symbol trees): linear in the input, no amplification beyond a
constant. The Rust port measured 0.28 s for 4000 blocks (native), the Java port 0.09 s.

## Tests

`tests/native_diff.test.ts`: the fork, the npm original and Node's libbrotli, 22,164 comparisons
(all verdicts: 7,146 success, 10,624 error, 4,394 truncated): valid streams (qualities 0-11, windows
10-24, three modes, nine payload kinds, 1-byte input and small output steps), hand-built streams, many
meta-blocks per stream, every truncation, every bit flip of small streams, byte edits, trailing
bytes, 4,300 random inputs. Fork and original must agree on verdict, output hash, consumed input
and error text; wherever the fork accepts a stream libbrotli must give the same bytes, and a stream
libbrotli accepts may not be refused. The same tests passed for the **unpatched** build of these
sources against the original (same 22,164 comparisons), then for the patched build.
Known difference, not changed: the Rust decoder (original and fork) accepts 224 of the damaged
streams that libbrotli refuses (padding bits and similar leniency).
`SG_BR_NATIVE=<file URL>` runs the tests against another build.

## Maintenance

- Advisories for `brotli-decompressor`, `brotli-dec-wasm` and wasm-bindgen are **not** tracked by
  `npm audit` any more (the code is compiled in). Watch the RustSec database and the upstream
  repositories manually; on a fix, update `vendor/` and re-apply `spillgate.patch`.
- `cargo audit` was not run (not installed).
