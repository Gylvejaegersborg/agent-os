// Tests editing a note an agent wrote, in place (basespace-add with edit/append), instead of rewriting it.
// Proves: a replacement is applied and echoed; all-or-nothing when one edit doesn't match or is ambiguous; only the
// author can edit; append works; an unchanged note says so; it works on a note older than a day (a rewrite by title
// would have made a copy); the tool schema carries the new fields.
// Run with: node dist/test-note-edit.js

import "./test-helpers/isolate.js";
import { addOverlayItem, getToolDefinition, loadOverlay, toToolSpec } from "./core/index.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

const added = await addOverlayItem("note", { title: "Plan", folder: "Agents/Nyx", body: "Tags: isark, beats\n\nWe built and recorded it.\n\nPick one. Pick one." }, "nyx");
const id = /id (\S+?)[,.]/.exec(added.output)![1]!;
const body = async () => String((await loadOverlay()).notes.find((n) => n.id === id)!.body);

const one = await addOverlayItem("note", { id, edit: [{ find: "isark", replace: "ISARK" }, { find: "built and recorded", replace: "built October 2026" }] }, "nyx");
assert(one.ok && (await body()).includes("Tags: ISARK, beats") && (await body()).includes("built October 2026 it."), "two replacements are applied");
assert(/2 changes/.test(one.output) && /"isark" -> "ISARK"/.test(one.output) && /no need to read it back/.test(one.output), "the answer echoes what changed, so there is nothing to read back");

const snapshot = await body();
const bad = await addOverlayItem("note", { id, edit: [{ find: "Tags: ISARK", replace: "Tags: X" }, { find: "not in the note", replace: "y" }] }, "nyx");
assert(!bad.ok && /edit 2/.test(bad.error ?? "") && (await body()) === snapshot, "when the second edit does not match, nothing is changed (all or nothing) and it says which");
const twice = await addOverlayItem("note", { id, edit: [{ find: "Pick one.", replace: "Pick." }] }, "nyx");
assert(!twice.ok && /2 times/.test(twice.error ?? "") && (await body()) === snapshot, "text that appears twice is refused, with how to fix it");

const other = await addOverlayItem("note", { id, edit: [{ find: "ISARK", replace: "x" }] }, "aether");
assert(!other.ok && /only edit notes you wrote|no note of yours/.test(other.error ?? "") && (await body()) === snapshot, "another agent can not edit it");

const app = await addOverlayItem("note", { title: "Plan", append: "Open question: title case." }, "nyx");
assert(app.ok && (await body()).endsWith("Open question: title case.") && /appended/.test(app.output), "append adds text at the end (found by exact title)");
const same = await addOverlayItem("note", { id, edit: [{ find: "ISARK", replace: "ISARK" }] }, "nyx");
assert(same.ok && /No change/.test(same.output), "an edit that changes nothing says so");
const rm = await addOverlayItem("note", { id, edit: [{ find: "Pick one. Pick one.", replace: "" }] }, "nyx");
assert(rm.ok && !(await body()).includes("Pick one") && /\(removed\)/.test(rm.output), "an empty replace removes the text");
assert(!(await addOverlayItem("note", { id, edit: [] }, "nyx")).ok && !(await addOverlayItem("note", { edit: [{ find: "a", replace: "b" }] }, "nyx")).ok, "an empty edit list, or no id/title, is refused");

// older than a day: an edit still lands on the same note
const o = await loadOverlay();
const n = o.notes.find((x) => x.id === id)!;
n.created = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
const count = (await loadOverlay()).notes.length;
const old = await addOverlayItem("note", { title: "Plan", edit: [{ find: "ISARK", replace: "ISARK!" }] }, "nyx");
assert(old.ok && (await loadOverlay()).notes.length === count, "an edit never makes a copy of the note");

const spec = toToolSpec(getToolDefinition("basespace-add")!);
assert(!!(spec.parameters.properties as Record<string, unknown>).edit && !!(spec.parameters.properties as Record<string, unknown>).append && /CHANGE a note/.test(spec.description), "the tool schema offers edit and append and says when to use them");

console.log(failed ? "\nSome note-edit tests FAILED." : "\nAll note-edit tests passed.");
process.exit(failed ? 1 : 0);
