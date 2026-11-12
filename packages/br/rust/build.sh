#!/usr/bin/env bash
# Build the WebAssembly decoder of spillgate-br. See NOTES.md for the toolchain and for what is
# (not) done compared with upstream's `wasm-pack build -t web` (no wasm-opt).
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd -W 2>/dev/null || pwd)"
OUT="${1:-../src/native}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HERE/target}"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
# Path-independent output: embedded source paths are remapped, so the hash does not depend on where
# the repository is checked out.
export RUSTFLAGS="--remap-path-prefix=$HERE=/spillgate-br-rust --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$(rustc --print sysroot)=/rustc"
cargo build --release --locked --target wasm32-unknown-unknown
rm -rf "$OUT"
wasm-bindgen --target web --out-dir "$OUT" --out-name brotli_dec_wasm \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/brotli_dec_wasm.wasm"
sha256sum "$OUT/brotli_dec_wasm_bg.wasm"
