/** Runs the whole conformance corpus with every optional codec installed. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codec as brotli, initBrotli, DEFAULT_MAX_WINDOW_BITS, MIN_WINDOW_BITS } from "spillgate-br";
import { codec as zstd } from "spillgate-zstd";
import { runConformance } from "../../core/dist/tests/runner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The largest brotli window bits (10..24) whose window, 2**n - 16 bytes, fits `limit`. */
function windowBitsWithin(limit: number): number {
  let bits = MIN_WINDOW_BITS;
  while (bits < DEFAULT_MAX_WINDOW_BITS && 2 ** (bits + 1) - 16 <= limit) bits++;
  return bits;
}

await initBrotli();

runConformance({
  root,
  noSkips: true, // every vector runs: a missing codec fails
  codecs: {
    br: (memoryCap) => (memoryCap === 0 ? brotli() : brotli({ maxWindowBits: windowBitsWithin(memoryCap) })),
    zstd: (memoryCap) => (memoryCap === 0 ? zstd() : zstd({ maxWindowBytes: memoryCap })),
  },
});
