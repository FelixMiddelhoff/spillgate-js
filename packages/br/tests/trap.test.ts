/**
 * A WebAssembly trap inside the decoder (SG-R-CDC-08): reported as `internal`, never as
 * `memory_limit`; the trapped decoder can be closed without a foreign error; repeated traps do not
 * poison the process (a trap leaks the shadow stack of the call, so the module is replaced before
 * that matters). No trap is reachable with real input (rust/NOTES.md), so it is simulated: the
 * test hook asks the decoder for an output step of 4 GiB - 1, whose buffer allocation panics.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Decoder, SpillgateError, type Limits } from "spillgate";
import { brotliStored } from "spillgate-test-support";
import { _test, codec, initBrotli } from "../src/index.js";

await initBrotli();

const LOOSE: Limits = { maxOutput: 2 ** 30, disableRatioLimit: true };
const decoder = (): Decoder => new Decoder(LOOSE, { codecs: { br: codec() } });
const good = brotliStored(Buffer.from("hello, brotli"), 16);

const uncaught: unknown[] = [];
process.on("uncaughtException", (error) => uncaught.push(error));

/** Run `fn` with the panic hook's console.error output of the module muted. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

async function trapOnce(): Promise<unknown> {
  _test.outputStep = 2 ** 32 - 1;
  const reader = decoder().reader(good, "br");
  try {
    await reader.read(100);
    assert.fail("the simulated trap did not happen");
  } catch (error) {
    _test.outputStep = undefined;
    reader.close(); // must not throw
    reader.close();
    return error;
  }
  return undefined;
}

async function decodesFine(): Promise<void> {
  const chunks: Buffer[] = [];
  const reader = decoder().reader(good, "br");
  try {
    for (let c = await reader.read(100); c !== null; c = await reader.read(100)) chunks.push(Buffer.from(c));
  } finally {
    reader.close();
  }
  assert.equal(Buffer.concat(chunks).toString(), "hello, brotli");
}

test("Covers: SG-R-CDC-08 - a WebAssembly trap is internal, not memory_limit", async () => {
  const error = await quietly(trapOnce);
  assert.ok(error instanceof SpillgateError, String(error));
  assert.equal(error.kind, "internal");
  await decodesFine();
});

test("Covers: SG-R-CDC-08 - reading again after a trap fails the same way, close never throws", async () => {
  _test.outputStep = 2 ** 32 - 1;
  const reader = decoder().reader(good, "br");
  const errors: unknown[] = [];
  await quietly(async () => {
    for (let i = 0; i < 2; i++) await reader.read(100).catch((e: unknown) => errors.push(e));
  });
  _test.outputStep = undefined;
  assert.deepEqual(errors.map((e) => (e as SpillgateError).kind), ["internal", "internal"]);
  assert.doesNotThrow(() => reader.close());
  assert.doesNotThrow(() => reader.close());
});

test("Covers: SG-R-CDC-08 - a trap does not disturb an open decoder, and traps do not accumulate (5000 traps, then everything still works)", async () => {
  // a stored block of 100 KiB read in small steps while traps happen in between
  const payload = Buffer.alloc(100 * 1024, 7);
  const reader = decoder().reader(brotliStored(payload, 16), "br");
  let total = 0;
  const first = await reader.read(10);
  assert.ok(first !== null);
  total += first.length;
  await quietly(async () => {
    for (let i = 0; i < 5000; i++) {
      const error = await trapOnce();
      if (!(error instanceof SpillgateError) || error.kind !== "internal") assert.fail(`trap ${i}: ${String(error)}`);
      if (i % 500 === 0) await decodesFine();
    }
  });
  for (let c = await reader.read(4096); c !== null; c = await reader.read(4096)) total += c.length;
  reader.close();
  assert.equal(total, payload.length);
  assert.ok(_test.instances > 1, "the module was replaced");
  await decodesFine();
  // finalizers of the leaked decoders must not throw later
  if (global.gc) {
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(uncaught, []);
});
