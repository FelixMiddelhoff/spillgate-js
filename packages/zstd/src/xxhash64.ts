/** XXH64, the hash behind the zstd content checksum (the low 32 bits of the digest are stored). */

const MASK = (1n << 64n) - 1n;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK;
const round = (acc: bigint, input: bigint): bigint => (rotl((acc + input * P2) & MASK, 31n) * P1) & MASK;
const merge = (acc: bigint, value: bigint): bigint => (((acc ^ round(0n, value)) * P1) + P4) & MASK;

export class XXH64 {
  private v1 = (P1 + P2) & MASK;
  private v2 = P2;
  private v3 = 0n;
  private v4 = (0n - P1) & MASK;
  private readonly tail = new Uint8Array(32);
  private tailLength = 0;
  private total = 0;

  update(data: Uint8Array): void {
    this.total += data.length;
    let pos = 0;
    if (this.tailLength > 0) {
      const take = Math.min(32 - this.tailLength, data.length);
      this.tail.set(data.subarray(0, take), this.tailLength);
      this.tailLength += take;
      pos = take;
      if (this.tailLength < 32) return;
      this.stripe(this.tail, 0);
      this.tailLength = 0;
    }
    while (pos + 32 <= data.length) {
      this.stripe(data, pos);
      pos += 32;
    }
    this.tail.set(data.subarray(pos), 0);
    this.tailLength = data.length - pos;
  }

  /** The low 32 bits of the digest: what a zstd frame stores. */
  digest32(): number {
    let h: bigint;
    if (this.total >= 32) {
      h = (rotl(this.v1, 1n) + rotl(this.v2, 7n) + rotl(this.v3, 12n) + rotl(this.v4, 18n)) & MASK;
      h = merge(merge(merge(merge(h, this.v1), this.v2), this.v3), this.v4);
    } else {
      h = P5;
    }
    h = (h + BigInt(this.total)) & MASK;
    const view = new DataView(this.tail.buffer, 0, this.tailLength);
    let at = 0;
    while (at + 8 <= this.tailLength) {
      h = (rotl(h ^ round(0n, view.getBigUint64(at, true)), 27n) * P1 + P4) & MASK;
      at += 8;
    }
    if (at + 4 <= this.tailLength) {
      h = (rotl(h ^ ((BigInt(view.getUint32(at, true)) * P1) & MASK), 23n) * P2 + P3) & MASK;
      at += 4;
    }
    while (at < this.tailLength) {
      h = (rotl(h ^ ((BigInt(view.getUint8(at)) * P5) & MASK), 11n) * P1) & MASK;
      at++;
    }
    h ^= h >> 33n;
    h = (h * P2) & MASK;
    h ^= h >> 29n;
    h = (h * P3) & MASK;
    h ^= h >> 32n;
    return Number(h & 0xffffffffn);
  }

  private stripe(bytes: Uint8Array, at: number): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, 32);
    this.v1 = round(this.v1, view.getBigUint64(0, true));
    this.v2 = round(this.v2, view.getBigUint64(8, true));
    this.v3 = round(this.v3, view.getBigUint64(16, true));
    this.v4 = round(this.v4, view.getBigUint64(24, true));
  }
}
