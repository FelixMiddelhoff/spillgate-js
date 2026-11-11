/**
 * Check that every rule and invariant of spec/SPEC.md is covered.
 *
 * A rule counts as covered if a conformance vector names it in `rules`, or if the title of a test
 * names it after "Covers:" (a stray mention elsewhere does not count). It is a checklist, not proof
 * that the test asserts everything the rule says.
 *
 * Usage: node dist/tools/spectrace.js [--allow-uncovered]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const RULE = /SG-(?:R-[A-Z]+-[0-9]{2}|I-[0-9]{2})/g;
const DEFINITION = /^(?:- )?\*\*(SG-(?:R-[A-Z]+-[0-9]{2}|I-[0-9]{2}))\*\*/gm;

const spec = readFileSync(join(root, "spec", "SPEC.md"), "utf8");
const defined = new Set([...spec.matchAll(DEFINITION)].map((m) => m[1] as string));

const manifest = JSON.parse(readFileSync(join(root, "conformance", "manifest.json"), "utf8")) as {
  vectors: { rules: string[] }[];
};
const covered = new Set<string>(manifest.vectors.flatMap((v) => v.rules));

const testFiles = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const dir = join(root, "packages", entry.name, "tests");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => join(dir, f)) : [];
  });
for (const file of testFiles) {
  const text = readFileSync(file, "utf8");
  for (const title of text.matchAll(/test\(\s*[`"']Covers:([^`"'\n]*)/g)) {
    for (const id of (title[1] as string).matchAll(RULE)) covered.add(id[0]);
  }
}

const missing = [...defined].filter((id) => !covered.has(id)).sort();
const unknown = [...covered].filter((id) => !defined.has(id)).sort();
console.log(`defined: ${defined.size}, covered: ${defined.size - missing.length}, uncovered: ${missing.length}`);
for (const id of missing) console.log("uncovered:", id);
for (const id of unknown) console.log("names a rule the spec does not define:", id);
if ((missing.length > 0 && !process.argv.includes("--allow-uncovered")) || unknown.length > 0) process.exit(1);
