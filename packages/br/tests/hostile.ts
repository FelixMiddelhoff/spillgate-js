/** Hostile brotli streams: many tiny meta-blocks, each announcing 256 literal prefix codes (F3). */

import { BitWriter } from "spillgate-test-support";

export type TreeShape = "single" | "four" | "all8";

const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function literalTree(w: BitWriter, shape: TreeShape): void {
  if (shape === "single") {
    w.bits(1, 2); // HSKIP = 1: simple prefix code
    w.bits(0, 2); // one symbol
    w.bits(0x41, 8);
  } else if (shape === "four") {
    w.bits(1, 2);
    w.bits(3, 2); // four symbols
    for (const s of [0x41, 0x42, 0x43, 0x44]) w.bits(s, 8);
    w.bits(0, 1); // lengths 2, 2, 2, 2
  } else {
    w.bits(0, 2); // HSKIP = 0: complex prefix code
    // code length code: two symbols (8 and 9) of length 1, every literal gets length 8 (a complete code)
    for (const symbol of CODE_LENGTH_ORDER) {
      if (symbol === 8 || symbol === 9) {
        w.bits(7, 4); // length 1
        if (symbol === 9) break; // the code is complete
      } else {
        w.bits(0, 2); // length 0
      }
    }
    for (let i = 0; i < 256; i++) w.bits(0, 1); // code length symbol 8, one bit each
  }
}

/**
 * `count` meta-blocks of one literal each, every one with NTREESL = 256 prefix codes of the given
 * shape. About 40 bytes (all8), 5 bytes (four) or 2 bytes (single) per tree... the point is the
 * work the decoder does per input byte.
 */
export function hostileBrotli(count: number, shape: TreeShape, distanceTrees = false): Uint8Array {
  const w = new BitWriter();
  w.bits(0, 1); // WBITS 16
  for (let i = 0; i < count; i++) {
    w.bits(0, 1); // ISLAST
    w.bits(0, 2); // MNIBBLES = 4
    w.bits(0, 16); // MLEN - 1 = 0
    w.bits(0, 1); // ISUNCOMPRESSED
    w.bits(0, 3); // NBLTYPESL, NBLTYPESI, NBLTYPESD = 1
    w.bits(0, 2); // NPOSTFIX
    w.bits(0, 4); // NDIRECT
    w.bits(0, 2); // context mode of the one literal block type
    w.bits(1, 1); // NTREESL - 1 = 255: VarLenUint8 with 7 extra bits
    w.bits(7, 3);
    w.bits(127, 7);
    // context map: 64 contexts, all tree 0
    w.bits(0, 1); // RLEMAX = 0
    w.bits(1, 2); // simple prefix code over 256 symbols, one symbol: 0
    w.bits(0, 2);
    w.bits(0, 8);
    w.bits(0, 1); // IMTF = 0
    if (distanceTrees) {
      w.bits(1, 1); // NTREESD = 256, as NTREESL
      w.bits(7, 3);
      w.bits(127, 7);
      w.bits(0, 1); // distance context map (4 contexts, all tree 0): RLEMAX = 0
      w.bits(1, 2);
      w.bits(0, 2);
      w.bits(0, 8);
      w.bits(0, 1); // IMTF = 0
    } else {
      w.bits(0, 1); // NTREESD = 1
    }
    for (let t = 0; t < 256; t++) literalTree(w, shape);
    w.bits(1, 2); // insert&copy code: one symbol, 8 = insert 1 literal
    w.bits(0, 2);
    w.bits(8, 10);
    for (let t = 0; t < (distanceTrees ? 256 : 1); t++) {
      w.bits(1, 2); // distance code: one symbol
      w.bits(0, 2);
      w.bits(0, 6);
    }
    // the command and the distance cost no bits (one-symbol codes); the literal costs its code length
    w.bits(0, shape === "single" ? 0 : shape === "four" ? 2 : 8);
  }
  w.bits(1, 1); // ISLAST
  w.bits(1, 1); // ISLASTEMPTY
  return w.finish();
}

/**
 * `count` meta-blocks of one literal each that announce 256 literal block types (context map of
 * 16 KiB, 64 context-mode bytes, 256 trees not needed: NTREESL = 1). With `dist` the distance side
 * announces 256 block types too (context map of 1 KiB). The work per input byte is the allocation
 * and clearing of the context maps (F3).
 */
export function hostileBlockTypes(count: number, dist = false): Uint8Array {
  const w = new BitWriter();
  w.bits(0, 1); // WBITS 16
  const blockTypes256 = (): void => {
    w.bits(1, 1); // NBLTYPES - 1 = 255: VarLenUint8 with 7 extra bits
    w.bits(7, 3);
    w.bits(127, 7);
    w.bits(1, 2); // block type code: simple, one symbol of 9 bits (alphabet 258)
    w.bits(0, 2);
    w.bits(0, 9);
    w.bits(1, 2); // block count code: simple, one symbol of 5 bits (alphabet 26)
    w.bits(0, 2);
    w.bits(0, 5);
    w.bits(0, 2); // first block count: symbol 0 costs no bits, 2 extra bits: length 1
  };
  for (let i = 0; i < count; i++) {
    w.bits(0, 1); // ISLAST
    w.bits(0, 2); // MNIBBLES = 4
    w.bits(0, 16); // MLEN - 1 = 0
    w.bits(0, 1); // ISUNCOMPRESSED
    blockTypes256(); // literals
    w.bits(0, 1); // NBLTYPESI = 1
    if (dist) blockTypes256();
    else w.bits(0, 1); // NBLTYPESD = 1
    w.bits(0, 2); // NPOSTFIX
    w.bits(0, 4); // NDIRECT
    for (let t = 0; t < 256; t++) w.bits(0, 2); // context mode of each literal block type
    w.bits(0, 1); // NTREESL = 1
    w.bits(0, 1); // NTREESD = 1
    w.bits(1, 2); // literal code: one symbol
    w.bits(0, 2);
    w.bits(0x41, 8);
    w.bits(1, 2); // insert&copy code: one symbol, 8 = insert 1 literal
    w.bits(0, 2);
    w.bits(8, 10);
    w.bits(1, 2); // distance code: one symbol
    w.bits(0, 2);
    w.bits(0, 6);
  }
  w.bits(1, 1); // ISLAST
  w.bits(1, 1); // ISLASTEMPTY
  return w.finish();
}
