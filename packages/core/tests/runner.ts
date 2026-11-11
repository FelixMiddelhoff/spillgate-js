/** Runs the shared conformance corpus (conformance/SCHEMA.md) against this implementation. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Decoder, SpillgateError, type Codec, type Limits, type PullSource } from "../src/index.js";
import { NotImplemented, generate, sha256Hex, type GeneratorSpec } from "spillgate-test-support";

/** What the runner needs to know about the world around it. */
export interface ConformanceConfig {
  /** The repository root, which holds `conformance/` and `spec/`. */
  root: string;
  /**
   * The optional codecs that exist, by name ("br", "zstd"). The function receives the vector's
   * `options.memory_cap` in bytes (0 for the default) and returns the codec. A vector tagged
   * `needs-br` runs only if "br" is here.
   */
  codecs?: Record<string, (memoryCap: number) => Codec>;
  /** A vector that needs a codec that is not here fails instead of being skipped. */
  noSkips?: boolean;
}

let ROOT = "";
let MANIFEST: Manifest;
let CODECS: Record<string, (memoryCap: number) => Codec> = {};

interface Expect {
  outcome: string;
  phase?: "construct" | "read";
  length?: number;
  sha256?: string;
  delivered_at_most?: number;
  delivered_exactly?: number;
  layer?: number;
}

interface Vector {
  id: string;
  description: string;
  rules: string[];
  tags?: string[];
  tier: "small" | "large";
  encodings: string[];
  input: { file?: string; generator?: GeneratorSpec; sha256: string };
  limits: Record<string, number | string>;
  read_pattern?: number[];
  options?: { strict_zlib?: boolean; memory_cap?: number };
  expect: Expect;
}

interface Manifest {
  schema_version: number;
  corpus_version: string;
  vectors: Vector[];
}

let STRICT = false;

// Every vector must give the same result for these read sizes (SG-R-RDR-01).
const ALTERNATIVE_PATTERNS = [[1], [3], [4096], [-1], [1, 7, 4096, 1]];

function neededCodecs(vector: Vector): string[] {
  return (vector.tags ?? []).filter((t) => t.startsWith("needs-")).map((t) => t.slice("needs-".length));
}

function buildInput(vector: Vector): Uint8Array {
  const spec = vector.input;
  const stream = spec.file !== undefined
    ? new Uint8Array(readFileSync(join(ROOT, "conformance", spec.file)))
    : generate(spec.generator as GeneratorSpec);
  assert.equal(sha256Hex(stream), spec.sha256, `${vector.id}: the input differs from the manifest (generator or file drift)`);
  return stream;
}

/** Limits above 2**53 are written as decimal strings in the manifest. */
function number(value: number | string): number | bigint {
  return typeof value === "string" ? BigInt(value) : value;
}

function buildCodecs(vector: Vector): Record<string, Codec> {
  const cap = vector.options?.memory_cap ?? 0;
  const codecs: Record<string, Codec> = {};
  for (const name of neededCodecs(vector)) codecs[name] = (CODECS[name] as (memoryCap: number) => Codec)(cap);
  return codecs;
}

function buildLimits(vector: Vector): Limits {
  const raw = vector.limits;
  const limits: Record<string, unknown> = {};
  if ("max_output" in raw) limits["maxOutput"] = number(raw["max_output"] as number | string);
  if ("max_layers" in raw) limits["maxLayers"] = raw["max_layers"];
  if ("ratio_grace" in raw) limits["ratioGrace"] = number(raw["ratio_grace"] as number | string);
  if ("max_input" in raw) limits["maxInput"] = number(raw["max_input"] as number | string);
  if ("max_ratio" in raw) {
    if (raw["max_ratio"] === "none") limits["disableRatioLimit"] = true;
    else limits["maxRatio"] = raw["max_ratio"];
  }
  return limits as unknown as Limits;
}

/** A source that counts reads and bytes, to prove what was taken (SG-R-INP-02, SG-R-HDR-09). */
class SpySource implements PullSource {
  reads = 0;
  total = 0;
  private pos = 0;
  constructor(private readonly payload: Uint8Array) {}
  read(max: number): Uint8Array | null {
    this.reads++;
    if (this.pos >= this.payload.length) return null;
    const chunk = this.payload.subarray(this.pos, this.pos + max);
    this.pos += chunk.length;
    this.total += chunk.length;
    return chunk;
  }
}

function outcomeOf(error: unknown): string {
  if (error === undefined) return "ok";
  if (error instanceof SpillgateError) return error.kind;
  return `other: ${String(error)}`;
}

interface Result {
  delivered: number;
  digest: string;
  error: unknown;
}

async function readWithPattern(
  reader: { read(max: number): Promise<Uint8Array | null> },
  pattern: number[],
  maxOutput: number,
): Promise<Result> {
  const digest = createHash("sha256");
  let delivered = 0;
  for (let i = 0; ; i++) {
    let size = pattern[i % pattern.length] as number;
    if (size < 0) size = Math.min(maxOutput, 32 * 2 ** 20 - 1) + 1;
    let chunk: Uint8Array | null;
    try {
      chunk = await reader.read(size);
    } catch (error) {
      return { delivered, digest: digest.digest("hex"), error };
    }
    if (chunk === null) return { delivered, digest: digest.digest("hex"), error: undefined };
    digest.update(chunk);
    delivered += chunk.length;
  }
}

function skipTiny(vector: Vector, pattern: number[]): boolean {
  const e = vector.expect;
  const expected = e.length ?? e.delivered_exactly ?? e.delivered_at_most ?? 0;
  return expected > 4 * 2 ** 20 && pattern.some((size) => size >= 0 && size < 64);
}

async function runPattern(vector: Vector, stream: Uint8Array, pattern: number[]): Promise<void> {
  const expect = vector.expect;
  const label = `${vector.id} read pattern [${pattern}]`;
  const source = new SpySource(stream);

  let constructionError: unknown;
  let reader: Awaited<ReturnType<Decoder["reader"]>> | undefined;
  let maxOutput = 0;
  try {
    const decoder = new Decoder(buildLimits(vector), { strictZlib: vector.options?.strict_zlib === true, codecs: buildCodecs(vector) });
    reader = decoder.reader(source, vector.encodings);
    maxOutput = Number(number(vector.limits["max_output"] as number | string));
  } catch (error) {
    constructionError = error;
  }

  if (constructionError !== undefined || expect.phase === "construct") {
    assert.equal(expect.phase, "construct", `${label}: unexpected construction error ${String(constructionError)}`);
    assert.notEqual(constructionError, undefined, `${label}: expected ${expect.outcome} at construction`);
    assert.equal(outcomeOf(constructionError), expect.outcome, `${label}: ${String(constructionError)}`);
    assert.equal(source.reads, 0, `${label}: the source was read before the construction error`);
    return;
  }

  const live = reader as NonNullable<typeof reader>;
  try {
    const { delivered, digest, error } = await readWithPattern(live, pattern, maxOutput);
    assert.ok(delivered <= maxOutput, `${label}: delivered ${delivered} > maxOutput`);
    checkOutcome(vector, label, delivered, digest, error);
    // Sticky (SG-R-LAY-05): further reads return the same outcome and no data.
    for (let i = 0; i < 3; i++) {
      let again: Uint8Array | null = null;
      let failure: unknown;
      try {
        again = await live.read(16);
      } catch (e) {
        failure = e;
      }
      assert.equal(again, null, `${label}: not sticky`);
      assert.equal(outcomeOf(failure), outcomeOf(error), `${label}: not sticky`);
    }
  } finally {
    live.close();
  }
  if ("max_input" in vector.limits) {
    const cap = Number(number(vector.limits["max_input"] as number | string));
    assert.ok(source.total <= cap + 1, `${label}: took ${source.total} bytes from the source (SG-R-INP-02)`);
  }
}

function checkOutcome(vector: Vector, label: string, delivered: number, digest: string, error: unknown): void {
  const expect = vector.expect;
  const got = outcomeOf(error);
  assert.equal(got, expect.outcome, `${label}: outcome ${got}, want ${expect.outcome} (delivered ${delivered}; ${String(error)})`);
  if (expect.outcome === "ok") {
    assert.equal(delivered, expect.length, `${label}: delivered ${delivered}, want ${String(expect.length)}`);
    assert.equal(digest, expect.sha256, `${label}: wrong data`);
    return;
  }
  assert.equal(expect.phase, "read", `${label}: a read error but a construction error was expected`);
  if (expect.delivered_exactly !== undefined) {
    assert.equal(delivered, expect.delivered_exactly, `${label}: delivered ${delivered}, want exactly ${expect.delivered_exactly}`);
  }
  if (expect.delivered_at_most !== undefined) {
    assert.ok(delivered <= expect.delivered_at_most, `${label}: delivered ${delivered}, want at most ${expect.delivered_at_most}`);
  }
  if (expect.layer !== undefined && error instanceof SpillgateError) {
    assert.equal(error.layer, expect.layer, `${label}: error in layer ${error.layer}, want ${expect.layer}`);
  }
}

function skipReason(vector: Vector): string | undefined {
  const missing = neededCodecs(vector).filter((c) => !(c in CODECS));
  return missing.length > 0 && !STRICT ? `needs the optional codec ${missing[0]}` : undefined;
}

/** Register one test per vector (and a manifest check) for the given configuration. */
export function runConformance(config: ConformanceConfig): void {
  ROOT = config.root;
  CODECS = config.codecs ?? {};
  STRICT = config.noSkips === true;
  MANIFEST = JSON.parse(readFileSync(join(ROOT, "conformance", "manifest.json"), "utf8")) as Manifest;

  for (const vector of MANIFEST.vectors) {
    test(vector.id, { skip: skipReason(vector) }, async () => {
      const missing = neededCodecs(vector).filter((c) => !(c in CODECS));
      if (missing.length > 0 && STRICT) assert.fail(`needs the optional codec ${missing[0]}, which is not installed`);
      const stream = (() => {
        try {
          return buildInput(vector);
        } catch (error) {
          if (error instanceof NotImplemented) return undefined;
          throw error;
        }
      })();
      if (stream === undefined) return;
      const first = vector.read_pattern ?? [4096];
      for (const pattern of [first, ...ALTERNATIVE_PATTERNS]) {
        if (!skipTiny(vector, pattern)) await runPattern(vector, stream, pattern);
      }
    });
  }

  test("the manifest is well formed", () => {
    const spec = readFileSync(join(ROOT, "spec", "SPEC.md"), "utf8");
    const rules = new Set([...spec.matchAll(/^(?:- )?\*\*(SG-(?:R-[A-Z]+-[0-9]{2}|I-[0-9]{2}))\*\*/gm)].map((m) => m[1]));
    assert.equal(MANIFEST.schema_version, 1);
    assert.ok(MANIFEST.vectors.length >= 200);
    const seen = new Set<string>();
    for (const vector of MANIFEST.vectors) {
      assert.match(vector.id, /^SG-V-[A-Z]+-[0-9]{4}$/);
      assert.ok(!seen.has(vector.id), `duplicate ${vector.id}`);
      seen.add(vector.id);
      assert.ok(vector.description && vector.rules.length > 0);
      for (const rule of vector.rules) assert.ok(rules.has(rule), `${vector.id} names an undefined rule ${rule}`);
      assert.match(vector.input.sha256, /^[0-9a-f]{64}$/);
    }
  });

}
