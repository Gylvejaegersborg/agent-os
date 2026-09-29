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

// Tests drive SCRIPTED models and assume no real provider answers. But when
// nothing names a model, the router falls back to whatever it finds — and on
// a machine that runs Ollama (the intended setup: local models) that's the
// live Ollama on :11434, which then quietly replaces the scripted model in
// anything that resolves a model per agent (the work runner, flows, crons):
// the test's own model is never called and the assertions fail for reasons
// that have nothing to do with the code. So the default Ollama port is
// unreachable here. A test that really wants it (a live-model check) sets
// AGENT_OS_TEST_ALLOW_OLLAMA=1 before importing this file.
if (!process.env.AGENT_OS_TEST_ALLOW_OLLAMA) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):11434(\/|$)/.test(url)) {
      return Promise.reject(new TypeError("fetch failed (default Ollama port is blocked in tests)"));
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
