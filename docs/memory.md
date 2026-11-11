# Memory bounds (SG-R-MEM-03)

spillgate never sizes an allocation from a value in the data (declared sizes, header fields,
lengths in the stream). What it does allocate is bounded by constants:

| Part | Bound |
| --- | --- |
| Input meter buffer, per layer | 4 KiB fetched at a time from a pull source (with `maxInput`, never more than `maxInput + 1` bytes in total); a chunk the producer yields (stream, iterable) is held until used |
| One decode step, per layer | 64 KiB (`MAX_STEP`), whatever buffer size the caller reads with |
| DEFLATE decoder state (gzip, deflate), per layer | about 50 KiB: 32 KiB window and small two-level code tables (about 2 KiB each) |
| gzip header fields | read in pieces of at most 512 bytes; FNAME and FCOMMENT are refused above 512 bytes |
| Whole-body functions (`decodeAll`, `Decoder.readAll`) | grow with the bytes actually produced; never preallocated from `maxOutput` |

Per layer that is well under 1 MiB; a chain of 16 layers stays under 16 MiB plus the output. A chunk
that is mostly unused is copied out of its step buffer, so a retained one-byte chunk does not pin
64 KiB. The tests (`tests/js_traps.test.ts`) measure retained memory with a forced garbage
collection before every sample: decoding a 200 MB bomb against a 100 MB limit grows the retained
memory by less than 16 MiB, and reading one byte at a time costs constant memory.

JavaScript numbers count bytes exactly up to 2\*\*53-1 (about 9 PB); a limit above that behaves like
2\*\*53-1.

The optional codecs add their decoder window, bounded by the window cap of the codec, not by
`maxOutput`:

| Codec | Default cap | Per stream |
| --- | --- | --- |
| `spillgate-br` | 24 window bits (16 MiB) | window plus up to 3.3 MiB of decoder tables that a hostile header can force (measured in the Rust port with the same decoder logic), freed when the reader closes |
| `spillgate-zstd` | 8 MiB (`maxWindowBytes`, 1 KiB to 1 GiB) | window ring plus a few buffers of at most 128 KiB |

The cap is checked from the header before anything is allocated; the tests measure that a hostile
header allocates nothing and that a 1 GiB bomb decodes with constant memory.

`spillgate-br` shares one WebAssembly module between all open streams. Its memory grows with the
streams open at the same time (up to about the window cap each) and does not shrink. When it runs
out, the stream fails as `memory_limit`. Bound the number of concurrent brotli streams in your
service (for example 16 MiB window x 64 streams is about 1 GiB) or lower `maxWindowBits`.
