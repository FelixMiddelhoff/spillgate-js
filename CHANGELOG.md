# Changelog

Versions below 1.0 may still change the API.

## Unreleased (intended as 0.1.0)

First version. The TypeScript implementation of the spillgate specification.

- `Limits` with a required `maxOutput`, ratio, layer and input limits; typed, sticky errors (one class per outcome kind); `statusFor` for HTTP servers.
- gzip, deflate and identity with an own resumable DEFLATE decoder (exact input accounting, bounded steps), no dependencies, standard APIs only.
- Passes the full conformance corpus of the reference implementation (264 of 354 vectors run; the 90 that need brotli or zstd are skipped until those codecs exist).
- Integration guide in `docs/how-to.md`.
