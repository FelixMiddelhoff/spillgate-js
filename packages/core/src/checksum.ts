/** CRC-32 (IEEE, as in gzip) and Adler-32 (as in zlib), incremental. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of `data` continuing from `previous` (0 to start); the same convention as `zlib.crc32`. */
export function crc32(data: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return ~c >>> 0;
}

const ADLER_MOD = 65521;

/** Adler-32 of `data` continuing from `previous` (1 to start). */
export function adler32(data: Uint8Array, previous = 1): number {
  let a = previous & 0xffff;
  let b = (previous >>> 16) & 0xffff;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length); // the largest block that cannot overflow 2**32
    for (; i < end; i++) {
      a += data[i] as number;
      b += a;
    }
    a %= ADLER_MOD;
    b %= ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}
