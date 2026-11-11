/** Runs the shared conformance corpus with the codecs this package provides (gzip, deflate). */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runConformance } from "./runner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
runConformance({ root, noSkips: !["", "0", "false", "no"].includes(process.env["SPILLGATE_NO_SKIPS"] ?? "") });
