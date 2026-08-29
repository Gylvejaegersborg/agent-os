// Standalone smoke test for the cron parser/matcher — no event log, no
// disk I/O, just arithmetic. Run with: node dist/test-cron.js
import { cronMatches, parseCron } from "./core/scheduler.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

// "*/5 * * * *" -> every 5 minutes
assert(cronMatches("*/5 * * * *", new Date(2026, 0, 1, 10, 0)), "*/5 matches minute 0");
assert(cronMatches("*/5 * * * *", new Date(2026, 0, 1, 10, 5)), "*/5 matches minute 5");
assert(!cronMatches("*/5 * * * *", new Date(2026, 0, 1, 10, 7)), "*/5 does not match minute 7");

// "0 9 * * *" -> daily at 9:00
assert(cronMatches("0 9 * * *", new Date(2026, 0, 1, 9, 0)), "daily 9am matches 9:00");
assert(!cronMatches("0 9 * * *", new Date(2026, 0, 1, 9, 1)), "daily 9am does not match 9:01");
assert(!cronMatches("0 9 * * *", new Date(2026, 0, 1, 10, 0)), "daily 9am does not match 10:00");

// "0 9 * * 1-5" -> weekdays at 9am (Mon=1..Fri=5)
const monday9am = new Date(2026, 0, 5, 9, 0); // 2026-01-05 is a Monday
const sunday9am = new Date(2026, 0, 4, 9, 0); // 2026-01-04 is a Sunday
assert(cronMatches("0 9 * * 1-5", monday9am), "weekday 9am matches Monday");
assert(!cronMatches("0 9 * * 1-5", sunday9am), "weekday 9am does not match Sunday");

// Malformed expressions throw rather than silently matching nothing
try {
  parseCron("not a cron expr");
  assert(false, "malformed cron should throw");
} catch {
  assert(true, "malformed cron throws as expected");
}

if (process.exitCode === 1) {
  console.error("\nSome cron tests FAILED.");
} else {
  console.log("\nAll cron tests passed.");
}
