/** The limits a decoder enforces (SPEC section 3). */

import { InvalidLimitsError } from "./errors.js";

export const DEFAULT_MAX_LAYERS = 5;
export const DEFAULT_MAX_RATIO = 1000;
export const DEFAULT_RATIO_GRACE = 64 * 1024;
export const HARD_MAX_LAYERS = 16;
export const HARD_MAX_RATIO = 2 ** 31 - 1;

const MAX_INT64 = (1n << 63n) - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * What a decoder enforces. All fields are integers; `number` and `bigint` are accepted.
 *
 * Values up to 2**63-1 are valid for the byte limits (SG-R-LIM-02). Byte counts in this library
 * are JavaScript numbers, exact up to 2**53-1; a limit above that can never be reached in
 * practice and behaves like 2**53-1. The documented maximum for exact counting is
 * `Number.MAX_SAFE_INTEGER`.
 */
export interface Limits {
  /** Bytes one layer may produce, `1 .. 2**63-1`. Required, no default, no "unlimited". */
  maxOutput: number | bigint;
  /** Longest chain of non-identity encodings, `1 .. 16`. Default 5. An explicit 0 is invalid. */
  maxLayers?: number;
  /** Output bytes per input byte the codec consumed, `1 .. 2**31-1`. Default 1000. */
  maxRatio?: number;
  /** Output size below which the ratio is not checked, `0 ..`. Default 64 KiB. */
  ratioGrace?: number | bigint;
  /** Optional cap on compressed bytes taken from the source, `1 .. 2**63-1`. */
  maxInput?: number | bigint;
  /** The one named opt-out of the ratio check. Cannot be combined with `maxRatio`. */
  disableRatioLimit?: boolean;
}

/** The limits with defaults filled in and byte counts as numbers. `maxRatio` 0 means off. */
export class EffectiveLimits {
  constructor(
    readonly maxOutput: number,
    readonly maxLayers: number,
    readonly maxRatio: number,
    readonly ratioGrace: number,
    readonly maxInput: number, // 0 means no cap
  ) {}

  /**
   * Validate `limits` completely, from the raw values (SG-R-LIM-08, LIM-09). The result is a
   * snapshot: later changes to the caller's object do not affect it.
   *
   * @throws InvalidLimitsError
   */
  static from(limits: Limits): EffectiveLimits {
    if (typeof limits !== "object" || limits === null) {
      throw new InvalidLimitsError("limits must be an object");
    }
    const { maxOutput, maxLayers, maxRatio, ratioGrace, maxInput, disableRatioLimit } = limits;
    if (maxOutput === undefined || maxOutput === null) {
      throw new InvalidLimitsError("maxOutput is required (it has no default and no unlimited value)");
    }
    const output = integer("maxOutput", maxOutput, 1n, MAX_INT64);
    const layers = maxLayers === undefined ? DEFAULT_MAX_LAYERS : integerNumber("maxLayers", maxLayers, 1, HARD_MAX_LAYERS);
    if (disableRatioLimit !== undefined && typeof disableRatioLimit !== "boolean") {
      throw new InvalidLimitsError("disableRatioLimit must be a boolean");
    }
    if (disableRatioLimit === true && maxRatio !== undefined) {
      throw new InvalidLimitsError("maxRatio contradicts disableRatioLimit; set only one");
    }
    const ratio =
      disableRatioLimit === true
        ? 0
        : maxRatio === undefined
          ? DEFAULT_MAX_RATIO
          : integerNumber("maxRatio", maxRatio, 1, HARD_MAX_RATIO);
    const grace = ratioGrace === undefined ? BigInt(DEFAULT_RATIO_GRACE) : integer("ratioGrace", ratioGrace, 0n, MAX_INT64);
    const input = maxInput === undefined ? 0n : integer("maxInput", maxInput, 1n, MAX_INT64);
    return new EffectiveLimits(clampSafe(output), layers, ratio, clampSafe(grace), clampSafe(input));
  }

  /**
   * SG-R-RAT-01: `produced > maxRatio * max(consumed, 1)`, past the grace. Exact: if the product
   * exceeds 2**53 it exceeds every possible `produced`.
   */
  ratioExceeded(produced: number, consumed: number): boolean {
    if (this.maxRatio === 0 || produced <= this.ratioGrace) return false;
    const allowed = this.maxRatio * Math.max(consumed, 1);
    return allowed <= Number.MAX_SAFE_INTEGER && produced > allowed;
  }
}

function clampSafe(value: bigint): number {
  return Number(value > MAX_SAFE ? MAX_SAFE : value);
}

/** A real integer in `low..high` as a bigint; rejects everything that is not number or bigint. */
function integer(name: string, value: unknown, low: bigint, high: bigint): bigint {
  let big: bigint;
  if (typeof value === "bigint") {
    big = value;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new InvalidLimitsError(`${name} must be an integer, got ${String(value)}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new InvalidLimitsError(`${name} must be a safe integer (use a bigint for larger values)`);
    }
    big = BigInt(value);
  } else {
    throw new InvalidLimitsError(`${name} must be an integer, got ${typeof value}`);
  }
  if (big < low || big > high) {
    throw new InvalidLimitsError(`${name} must be in ${low}..${high}, got ${big}`);
  }
  return big;
}

function integerNumber(name: string, value: unknown, low: number, high: number): number {
  return Number(integer(name, value, BigInt(low), BigInt(high)));
}
