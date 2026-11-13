# The WebAssembly decoder of spillgate-br (fork of brotli-dec-wasm 2.3.2)

`spillgate-br` ships `src/native/brotli_dec_wasm_bg.wasm` and its glue code, built from the sources
in this directory. It replaces the npm dependency `brotli-dec-wasm` 2.3.2 (kept as an exact-pinned
**dev** dependency: it is the reference of the differential tests). Reason: F3, the CPU cost of
hostile meta-blocks (see "Patches" and the threat model). Since 2026-11-13 the decoder is **unpatched
brotli-decompressor 6.3.1**; the F3 patch and the two backports of the 5.0.0 fork are gone (git history keeps them).

## Sources

| What | Where | Version / commit |
|---|---|---|
| Wrapper (`src/*.rs`, `Cargo.toml`, `Cargo.lock`, licenses) | https://github.com/ustclug-dev/brotli-dec-wasm | tag `v2.3.2`, commit `04947d5b2cbcf0487435d26d6598ea624a6b191b`. Changed: package name `spillgate-brotli-wasm` (lib name `brotli_dec_wasm` unchanged), `brotli-decompressor` as path dependency `=5.0.0`. No source change in `src/*.rs`. |
| `vendor/brotli-decompressor` | crates.io `brotli-decompressor` | **6.3.1**, upstream tag `6.3.1` = commit `26c38e2def3ad84f41a28d182d9ba41779a613c7` (the `sha1` in the archive's `.cargo_vcs_info.json`), crates.io archive sha256 `75c74c9c51b9140663e196b5fb88bc94c334d7a497c8311cb759d8557874747f`. **Unpatched**: the archive's files, except that `Cargo.toml.orig`, `Cargo.lock`, `tests/`, `examples/`, `scripts/`, `rustfmt.toml` and dotfiles are not copied (kept: `Cargo.toml`, `LICENSE`, `README.md`, `.cargo_vcs_info.json`, all of `src/`; `ffi/`, `bin/`, `reader.rs` and the other unused files are in the tree but not compiled into the wasm: no `ffi-api` or `unsafe` feature). Wrapper dependency: `brotli-decompressor = { version = "=6.3.1", path = "vendor/brotli-decompressor" }`. |
| Other crates | crates.io, `Cargo.lock` (checksums) | wasm-bindgen 0.2.114, alloc-no-stdlib **3.0.0**, alloc-stdlib **0.3.0** (the generation 6.3.1 asks for; 2.0.4 and 0.2.2 before), console_error_panic_hook 0.1.7, cfg-if 1.0.4, once_cell 1.21.4 (+ proc-macro crates, not linked) |

Version note: upstream's `Cargo.lock` at `v2.3.2` pins `brotli-decompressor` **5.0.0** (the npm package 2.3.2
contains that version), and the npm original used as the differential reference still contains 5.0.0. The wrapper
sources compile unchanged against 6.3.1. The Rust port of spillgate (repository spillgate-rust) vendors the same upstream version.

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
    the then-committed hash. Two Linux builds from different source paths and target directories were
    byte-identical, so the Linux build is deterministic and path-independent; the difference to the
    committed binary is the Windows paths above.
  - So the committed binary cannot be reproduced on Linux, and the Windows output is not
    OS-independent. See "Reproducing the binary in CI" below.
- Upstream builds with `wasm-pack build -t web`, which runs `wasm-opt` and then minifies the glue
  code with esbuild. **wasm-pack, wasm-opt and esbuild were not used here** (not installed; no tool
  was installed beyond rustc, the wasm32 target and wasm-bindgen-cli). So the module is not
  size-optimized: 271,636 bytes (245,100 with 5.0.0 plus patches; 6.x is a bigger decoder) instead of 208,439 bytes for the npm module (5.0.0); the glue is not
  minified (18.8 KB). The code is the same, behavior is compared by the differential tests, not by
  bytes. (A check build with `opt-level = 3` was not meaningfully faster on the hostile streams, so
  upstream's "s" was kept.)
- sha256 of `src/native/brotli_dec_wasm_bg.wasm`:
  - **shipped (2026-11-13): unpatched brotli-decompressor 6.3.1, built on Linux/WSL Ubuntu 24.04, rustc 1.98.1, wasm-bindgen 0.2.114: `8b49f416e688a237bf667fb59cfaa5e2d0ad6f172ea87b44bb8f12f35f26b88c`** (271,636 bytes; two builds from different source paths and target directories byte-identical; CI reproduces it on ubuntu-latest)
  - previously shipped, 5.0.0 with `spillgate.patch` + `spillgate-backport.patch`: `1e5d9cbe1d51f7729baf2a9248ec0e746162a094134f73bf107bbd2749a958e7`
  - 5.0.0 with `spillgate.patch` only (up to commit `479c631`): `3be7ab7252861c4e8625bbd04ff99b2755201e1ee292e522a85133c3287ef5ad`
  - 5.0.0 unpatched (commit `07c4b3f`): `e871a61cd56c9fd3f4e7eaae2dda28f58023c9ce83dfd5f6744b239fb1d1e29a`; 5.0.0 patched, built on Windows: `4a6f77a8563cf469bbb4db56ca746f54dcec92d665dc1593c0c38f2e73f03afe` (superseded)
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

**Status:** the committed binary was rebuilt on Linux (WSL Ubuntu 24.04, `git archive` of the commit, two source paths and
two target directories, byte-identical, wasm-bindgen glue and typings identical) on 2026-11-13 after the move to
brotli-decompressor 6.3.1 and is `8b49f416e688a237bf667fb59cfaa5e2d0ad6f172ea87b44bb8f12f35f26b88c`;
`git show HEAD:packages/br/src/native/brotli_dec_wasm_bg.wasm | sha256sum` gives the same. The JavaScript glue is byte-identical
to the 5.0.0 build; only the typings list two exports in another order. If a rebuild differs on
purpose (toolchain bump, vendor change): download the artifact `brotli-wasm-rebuilt-ubuntu`, copy its
four files over `packages/br/src/native/`, update `EXPECTED_SHA256` in `ci.yml` and the list above,
run `npm test`, add a CHANGELOG line, commit.

## Patches: none

The vendored brotli-decompressor 6.3.1 is **unpatched**; `build.sh` applies nothing. The fork of 5.0.0 carried two
patches (history: commit `07c4b3f` unpatched 5.0.0, the F3 patch, `ba36955` the backport; both patch files were
removed in the rebase to 6.3.1, commit `ffe59d7`):

- **The F3 patch (hostile meta-block CPU) is not needed.** On 5.0.0, `HuffmanTreeGroup::init` freed and re-allocated
  (and zeroed) `ntrees * 1080` table entries per meta-block, up to 1.1 MB per tree group, so thousands of tiny meta-blocks
  that each announce 256 trees cost 530-565 ns per input byte. 6.x grows the tables on demand and keeps buffers that are
  large enough in `init`. Measured on the unpatched 6.3.1 build (table below): 108-122 ns per input byte for the same
  streams, 4.6 to 5 times faster than the 5.0.0 original and faster than the patched 5.0.0 fork (231-242 ns). What is
  left is the work of reading the trees: linear in the input, no amplification. The Rust port found the same and tried
  removing `reset()` from the meta-block cleanup on 6.3.1 (no gain, dropped).
- **The strictness backports are in 6.x as they are:** upstream `8ed0d7d` (nonzero padding after the last meta-block is
  PADDING_2) and `693a4a1` (a non-last meta-block must not exceed MLEN: BLOCK_LENGTH_2). Upstream `677eef1` additionally splits
  PADDING_1 (-14: nonzero padding before a stored or metadata block, in an empty last block) from PADDING_2 (-15), as libbrotli does.

If the F3 test ever fails after a future vendor bump, retaining the tree memory between meta-blocks (not calling
`reset()` in `BrotliStateCleanupAfterMetablock`, releasing it in `BrotliStateCleanup`) is the first thing to try.

## Measured (Node 24, the author's machine, 2026-11-13, best of five, no wasm-opt)

| Stream | Original 2.3.2 (5.0.0, unpatched) | Fork before (5.0.0 + patches, 2026-11-12) | Fork now (6.3.1 unpatched) | libbrotli (Node) |
|---|---|---|---|---|
| 4000 meta-blocks x 256 literal trees (1.58 MB) | 872 ms, 553 ns/B | 381 ms, 242 ns/B | 170 ms, 108 ns/B | 121 ms, 77 ns/B |
| same + 256 distance trees (2.86 MB) | 1621 ms, 566 ns/B | 660 ms, 231 ns/B | 350 ms, 122 ns/B | 228 ms, 80 ns/B |
| 4000 x (256 literal + 256 distance trees, 4 symbols each) (6.1 MB) | 1726 ms, 285 ns/B | 796 ms, 131 ns/B | 323 ms, 53 ns/B | 1138 ms, 188 ns/B |
| 1000 x 256 complete 8-bit trees + 256 distance trees (9.5 MB) | 1219 ms, 129 ns/B | 888 ms, 94 ns/B | 626 ms, 66 ns/B | 575 ms, 61 ns/B |
| 4000 meta-blocks with 256 literal block types (0.31 MB) | 64 ms, 209 ns/B | 41 ms, 130 ns/B | 35 ms, 115 ns/B | 9 ms, 30 ns/B |

(The "before" column is from the earlier notes, taken in another session; the original's numbers vary 5 to 20 percent
between runs.) Module memory after these streams: 3-11 MiB (original 4-13 MiB). The 5 GiB zero stream (window 24, 4,053
input bytes, input step 4096, output step 65536) decodes exactly in 7 s with a module memory of at most 17.4 MiB (16 MiB
window plus 1.4 MiB).

The F3 test in `br.test.ts` keeps: absolute bound 300 ns per input byte (about 2.5 times the measurement; the original,
at 565, fails it), relative bound at least 3 times faster than the original in the same process (best of 5, alternating;
measured 4.6), linearity (a quarter of the stream costs about a quarter), `maxInput` stops it. The relative bound used to
be 1.5 (original 2.4 times slower than the patched fork); the original is still the slow side, so the check stays meaningful.

## Tests

`tests/native_diff.test.ts`: the fork, the npm original and Node's libbrotli, 22,409 comparisons
(20,411 identical to the original: 6,921 success, 8,419 error, 5,071 truncated; 1,998 with an allowed difference below):
valid streams (qualities 0-11, windows 10-24, three modes, nine payload kinds, 1-byte input and small output steps),
hand-built streams, many meta-blocks per stream, every truncation, every bit flip of small streams, byte edits, trailing
bytes, 4,300 random inputs. Fork and original must agree on verdict, output hash, consumed input and error text, with
exactly these allowed differences (all on damaged or random streams, none on a valid one), each of them confirmed by
libbrotli's own error code:

| Original (5.0.0) | Fork (6.3.1) | Count | libbrotli |
|---|---|---|---|
| accepts | refuses, -10 (MLEN overshoot) | 8 | BLOCK_LENGTH_2 |
| accepts | refuses, -15 (nonzero padding after the last meta-block) | 58 | PADDING_2 |
| refuses, -9 | refuses, -10, same input/output position | 1,196 | BLOCK_LENGTH_2 |
| refuses, -7 or -6 | refuses, -10, same position | 1 + 1 | BLOCK_LENGTH_2 (6.x checks the MLEN overshoot before the table checks) |
| refuses, -15 | refuses, -14 (PADDING_1), same position | 705 + 29 | PADDING_1 (705); WINDOW_BITS (29: random bodies behind a large-window header, which libbrotli refuses before it gets to the padding) |

In every case the fork's code is the one libbrotli names, never the reverse. Wherever the fork accepts a stream libbrotli
gives the same bytes, and a stream libbrotli accepts is never refused. Known difference, not changed: the Rust decoder (original
and fork) accepts 27 of the random streams that libbrotli refuses (all behind a large-window header).
(224 before the 5.0.0 backport, 27 after it, 27 now.) Everything else (about 20,400 comparisons) is identical.
`SG_BR_NATIVE=<file URL>` runs the tests against another build.

## Upstream fixes 5.0.1 .. 6.3.1 (probed against 5.0.0 first; 6.3.1 contains all of them)

`tests/upstream_fixes.test.ts` (+ `tests/upstream_streams.ts`, hand-built streams with one-symbol prefix
codes) probes each robustness fix of brotli-decompressor after 5.0.0 against the shipped decoder
through the public API (read sizes 1..65536, source chunkings whole / 1 / 3 / 4096 / "no progress"
pull source, limits), against libbrotli, and against the original 2.3.2. The vendored code is built
without the `unsafe` feature, so every index is bounds-checked: a bug of this kind is a Rust panic
(a WebAssembly `unreachable` trap), never an out-of-bounds write.

| Upstream | In 5.0.0 | Reachable here | Observed |
|---|---|---|---|
| 693a4a1 meta-block exceeds MLEN | yes | **yes** | accepted, the overshoot is delivered (12 bytes for MLEN 8; 1 MiB for MLEN 8); libbrotli: BLOCK_LENGTH_1/2. Only caught when the ring buffer is written (a last meta-block, or a copy across the ring end, is already `corrupt`). Same result for every read size/chunking; `maxOutput` and the ratio limit see every byte. |
| 8ed0d7d padding after the last meta-block | yes | **yes** | nonzero padding after a last, non-empty compressed meta-block is accepted, data intact; libbrotli: PADDING_2. (Empty last block, stored and metadata blocks: already `corrupt`.) |
| 677eef1 PADDING_1 vs PADDING_2 | error code only | n/a | both are `corrupt` (-15) here |
| cc7ee0e block switch with one block type | yes | no | needs a 2^24+1-th literal: the overlong insert exceeds MLEN and is refused (BLOCK_LENGTH_1) at the first ring-buffer write, for windows 10..24, last/not last, split over two commands; command/distance categories cannot get there (2 bytes per command). No hang, no trap. libbrotli not run on these shapes (the bug is in the C decoder). |
| 8cb69d1 unsigned clamp | yes | no | needs 2^31 unread input bytes in one call; the codec hands the decoder at most 4096 (output step at most 65536). Stored meta-blocks (4 MiB, windows 10/16/24, all chunkings) are exact. |
| c1f6944, c31d20b input/output cursor ranges | yes | no | same reason (2^32) |
| 79404c1 tree groups on FORMAT_DISTANCE | yes | no | the largest distance the format can write (NPOSTFIX 3, NDIRECT 120, 24 extra bits, about 5.4e8) is below 0x7FFFFFFC; only large-window mode gets there and that is refused. Error paths after 512 trees: module memory stays flat over 400 decoders. |
| b1d31a8 and the other panic fixes | internal invariants | no trap found | 40,000 mutated/random streams in the test, 1.6 million offline (4 seeds, header-valid random bodies, mutated real and hostile streams, truncations, raw steps 1..65536): no trap, no stall, module memory at most 30 MiB, public API only `ok`/`corrupt`. |
| 84930b7, 775b42b allocation failure checks | abort | not probed | an allocation failure in WebAssembly is an abort (trap); only memory exhaustion (many open decoders with a 16 MiB window against 4 GiB) could get there. 6.x reports ERROR_ALLOC_* instead. |

Other 6.x changes (dynamic ring buffer, tree storage grown on demand, command loop rewrites, custom
dictionary, metadata callbacks, FFI hardening) are not robustness fixes of this decoder, but they
replace the code the F3 patch changes: step 2 has to re-apply and re-measure it.

**Two real bugs of 5.0.0, both strictness (parser differential, no memory or CPU effect):**
693a4a1 and 8ed0d7d. The libbrotli, andybalholm/brotli and 6.3.1 decoders rejected what 5.0.0
delivers. Severity low to medium. Fixed 2026-11-12 by a backport patch, since 2026-11-13 by 6.3.1 itself (see "Patches: none");
the strict tests (`corrupt` expected) run unconditionally and pass. The "Observed" column above
describes 5.0.0 (the npm original still behaves so).

**What a trap costs, and what is done about it (hardening, 2026-11-12):** none is reachable (measured
with an artificial one: output step 4 GiB - 1, a `capacity overflow` panic). The panic aborts without
unwinding, so the shadow stack of the call is never given back, the trapped decoder object stays
"borrowed" (`free()` throws), and after about 3,230 traps every call fails with "memory access out of
bounds" and the glue's finalizers throw uncaught exceptions. `src/index.ts` now: reports a trap as
`internal` (SG-R-CDC-08; it was `memory_limit`), marks the reader dead (further reads: `internal`),
detaches the glue's finalizer of the lost handle (`__destroy_into_raw`, so garbage collection never
throws) and leaks the handle, makes `close()` never throw, counts traps per module instance and, after
`TRAPS_PER_INSTANCE` (256) traps, gives new streams a fresh instance (the glue keeps its instance in
module state, so it is imported again under another URL and initialised from the compiled module;
streams already open keep their instance). Cost: a replaced instance stays referenced by its module
record (one per 256 traps; Node does not unload modules), so the leak is bounded to about one
instance per 256 traps instead of a dead process. Needs dynamic `import()` with a query string
(Node, Deno, Bun; a bundler that rewrites it gets `internal` "could not be replaced" at the 256th trap
instead). `tests/trap.test.ts` simulates traps (test hook `_test.outputStep`): 5,000 traps with a
decoder open across them, then normal decoding, no uncaught exception; without the replacement it fails
(checked).

**Output beyond 4 GiB (checked on 6.3.1, 2026-11-13):** 5 GiB + 12,345 bytes of zeros (`SG_BR_LONG=1`, window 24)
decode exactly, block by block identical to zeros, module memory at most 17.4 MiB. 6.0.0 (b1d31a8) introduced checked
`usize` arithmetic, which would refuse such streams on wasm32 (32-bit `usize`); 6.3.1 keeps the position counters
(`partial_pos_out` and friends) in `u64`, and the test confirms it. Keep this test for every vendor bump.

## Maintenance

- Advisories for `brotli-decompressor`, `brotli-dec-wasm` and wasm-bindgen are **not** tracked by
  `npm audit` any more (the code is compiled in). Watch the RustSec database and the upstream
  repositories manually; on a fix, update `vendor/` (to the next upstream release, unpatched), rebuild on Linux, update
  `EXPECTED_SHA256`, re-run the tests including `SG_BR_LONG=1`.
- `cargo audit` was not run (not installed).
