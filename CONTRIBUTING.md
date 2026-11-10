# Contributing

## Run the checks

```
npm ci
npm test                 # build, then every test: all 354 conformance vectors (90 need brotli/zstd and are skipped), differential tests, memory tests
npm run spectrace        # every rule of the specification is named by a test or vector
npx tsc --noEmit         # strict type check
```

`SPILLGATE_NO_SKIPS=1 npm test` makes a vector that needs a missing codec fail instead of being
skipped. `SPILLGATE_FUZZ_ROUNDS=20000 npm test` runs the property tests with a large budget.

## Rules

- The specification comes first. Behavior that the spec does not describe is not added here: change `spec/SPEC.md` in the reference repository, add vectors there, then sync.
- A test names the rules it protects in its title after `Covers:` (`test("Covers: SG-R-LAY-03 - ...")`); `tools/spectrace.ts` reads that. It is a checklist, not proof that the test asserts everything the rule says. Review the assertions too.
- Test first for every bug. Never weaken a test or a conformance vector to make code pass.
- `conformance/` and `spec/` are copies. Do not edit them here; update them from the reference repository and record the release in `conformance/SOURCE`.
- No runtime dependencies, no Node-specific modules in `src/`, no `node:zlib` or `DecompressionStream` (`tests/js_traps.test.ts` fails if the source uses them).
- Code is read by people: short functions, a doc comment that explains why, rule IDs where a rule applies.
