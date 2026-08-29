// Test isolation helper — import this as the FIRST import in every
// standalone test-*.ts file, before any import from "./core/*" (or
// "./core/index.js"). core/eventlog.ts reads AGENT_OS_DATA_DIR exactly
// once, at module-evaluation time, into a top-level DATA_DIR constant —
// so the env var must be set before that module is ever evaluated. ES
// module semantics guarantee sibling imports run in source order, so:
//
//   import "./test-helpers/isolate.js";   // <- first, sets env var
//   import { ... } from "./core/index.js"; // <- eventlog.ts loads after
//
// Effect: each test FILE gets its own deterministic scratch directory
// under ./data-test/<test-name>/, wiped at the start of every run. That
// means:
//   - standalone tests never see leftover event-log state from
//     `npm run demo` (which still defaults to ./data/ untouched — this
//     module only ever affects processes that import it), and
//   - standalone tests never see leftover state from each other, even
//     when run back to back in the same `npm test-*` sequence, because
//     each test file's directory name is derived from its own filename.
//
// Deliberately NOT node:fs/promises mkdtemp: a deterministic per-file
// path is easier to inspect after a failing run (ls ./data-test/<name>)
// than a randomly-suffixed temp dir that's gone by the time you look.

import { rmSync, mkdirSync } from "node:fs";
import path from "node:path";

const entryScript = process.argv[1] ?? "test";
const testName = path.basename(entryScript).replace(/\.(js|ts)$/, "");

const dir = path.join(process.cwd(), "data-test", testName);

// Wipe first so a previous failed run of THIS SAME test file can't leak
// state into the current one either — only isolation from demo/other
// tests is required, but a clean start for re-runs is free and correct.
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

process.env.AGENT_OS_DATA_DIR = dir;
