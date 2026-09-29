// Watchdog — "trust, but verify" for handed-off work, after Paperclip's
// verifier: when every item under a watch has stopped (done, blocked or
// cancelled), a named verifier agent (Argus by default) checks what each
// agent CLAIMED against what actually happened, and reports.
//
//   - Opt-in per watch: a work item and everything it was split into, or
//     the items of an approved plan (governance.ts).
//   - The evidence is assembled here, in code, not left to the verifier to
//     go digging: each item's brief and claimed result next to the tool
//     calls that really ran in its session (event log) and the text of what
//     it added to BaseSpace.
//   - The verifier gets a verification work item (work.ts, kind
//     "verification"), run by the normal work runner with only `work` and
//     `basespace` — it can reopen an item with a reason or escalate it, and
//     it can't do the work itself. Report problems; don't silently fix them.
//   - Reopened items re-run; when they stop again the watch is verified
//     again, up to MAX_ROUNDS, after which it's left for the operator.
//   - The verdict goes back to the conversation the watch came from, as a
//     `[Work]` note (the verification item is requested from there).

import { appendEvent, project, readStream } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { generateId } from "./id.js";
import { getAgentIdentity } from "./identity.js";
import { loadOverlay } from "./basespace.js";
import { createWork, getWork, listWork, OPERATOR, type WorkView } from "./work.js";
import type { SessionFocus } from "./types.js";

const STREAM = "watchdog";
export const MAX_ROUNDS = 2;
const EVIDENCE_CAP = 9000;

export function verifierId(): string {
  return process.env.AGENT_OS_VERIFIER || "argus";
}

export type WatchStatus = "watching" | "verifying" | "verified" | "reopened" | "needs-operator" | "closed";

export interface Watch {
  id: string;
  label: string;
  rootIds: string[];
  verifier: string;
  createdBy: string;
  originSessionId?: string;
  focus?: SessionFocus;
  status: WatchStatus;
  /** Verifications run so far. */
  rounds: number;
  verificationIds: string[];
  /** The last verifier's summary. */
  verdict?: string;
  /** Items the last verification sent back. */
  reopened?: string[];
  createdAt: string;
  updatedAt: string;
}

async function projectWatches(): Promise<Map<string, Watch>> {
  return project<Map<string, Watch>>(STREAM, new Map(), (state, e) => {
    const p = e.payload as any;
    const w = p.id ? state.get(p.id) : undefined;
    const touch = (patch: Partial<Watch>) => w && state.set(w.id, { ...w, ...patch, updatedAt: e.timestamp });
    if (e.type === "watch.created") state.set(p.watch.id, { ...p.watch, status: "watching", rounds: 0, verificationIds: [], createdAt: e.timestamp, updatedAt: e.timestamp });
    else if (e.type === "watch.verifying") touch({ status: "verifying", rounds: (w?.rounds ?? 0) + 1, verificationIds: [...(w?.verificationIds ?? []), p.verificationId] });
    else if (e.type === "watch.settled") touch({ status: p.status, verdict: p.verdict, reopened: p.reopened ?? [] });
    return state;
  });
}

export async function listWatches(): Promise<Watch[]> {
  return [...(await projectWatches()).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getWatch(id: string): Promise<Watch | undefined> {
  return (await projectWatches()).get(id);
}

/** A root and everything handed off from it (verification items excluded). */
function treeOf(rootIds: string[], all: WorkView[]): WorkView[] {
  const byId = new Map(all.map((w) => [w.id, w]));
  const under = (w: WorkView): boolean => {
    for (let cur: WorkView | undefined = w, hops = 0; cur && hops < 20; cur = cur.parentId ? byId.get(cur.parentId) : undefined, hops++) {
      if (rootIds.includes(cur.id)) return true;
    }
    return false;
  };
  return all.filter((w) => w.kind !== "verification" && under(w));
}

/** Puts a watch on items (and what they get split into). Idempotent: an
 *  open watch on the same roots is returned as is. */
export async function watchWork(input: { rootIds: string[]; label?: string; createdBy: string; originSessionId?: string; focus?: SessionFocus }): Promise<Watch> {
  const verifier = verifierId();
  if (!(await getAgentIdentity(verifier))) throw new Error(`no verifier agent "${verifier}" (AGENT_OS_VERIFIER)`);
  const roots: WorkView[] = [];
  for (const id of input.rootIds) {
    const w = await getWork(id);
    if (!w) throw new Error(`no work item ${id}`);
    roots.push(w);
  }
  if (!roots.length) throw new Error("watch what? give at least one work item");
  const key = [...input.rootIds].sort().join();
  const open = (await listWatches()).find((w) => [...w.rootIds].sort().join() === key && !["verified", "needs-operator", "closed"].includes(w.status));
  if (open) return open;
  const watch = {
    id: generateId(),
    label: input.label?.trim() || (roots.length === 1 ? roots[0]!.title : `${roots.length} items`),
    rootIds: input.rootIds,
    verifier,
    createdBy: input.createdBy,
    ...(input.originSessionId ?? roots[0]!.requestedFromSessionId ? { originSessionId: input.originSessionId ?? roots[0]!.requestedFromSessionId } : {}),
    ...(input.focus ?? roots[0]!.focus ? { focus: input.focus ?? roots[0]!.focus } : {}),
  };
  await appendEvent(STREAM, "watch.created", { watch });
  await publishEvent("watch.created", { id: watch.id });
  return (await getWatch(watch.id))!;
}

/** Which watch covers this item, if any. */
export async function watchForWork(itemId: string): Promise<Watch | undefined> {
  const all = await listWork();
  return (await listWatches()).find((w) => treeOf(w.rootIds, all).some((i) => i.id === itemId));
}

// ---- Evidence ------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What actually ran while the item was worked: tool calls from its
 *  session, and the full text of anything it added to BaseSpace. */
async function evidenceFor(item: WorkView, overlay: Awaited<ReturnType<typeof loadOverlay>>): Promise<string> {
  if (!item.sessionId) return "  (it never ran)";
  // `work` calls are bookkeeping (marking it done IS the claim), not evidence.
  const calls = (await readStream(`session:${item.sessionId}`)).filter((e) => e.type === "tool.call.end" && (e.payload as { name?: string }).name !== "work");
  if (!calls.length) return "  (no tool calls — nothing ran besides the claim itself)";
  const lines: string[] = [];
  for (const e of calls) {
    const p = e.payload as { name?: string; args?: Record<string, unknown>; result?: { ok?: boolean; output?: string; error?: string } };
    const args = clip(JSON.stringify(p.args ?? {}), 160);
    const out = p.result?.ok ? clip(p.result.output ?? "", 200) : `error: ${clip(p.result?.error ?? "", 160)}`;
    lines.push(`  - ${p.name} ${args} → ${out}`);
    // Show what an added item really says, not just that it was added.
    const id = /id (agent-[\w-]+)/.exec(p.result?.output ?? "")?.[1];
    if (p.name === "basespace-add" && id) {
      const added = [...overlay.notes, ...overlay.tasks].find((x) => x.id === id) as Record<string, unknown> | undefined;
      if (added) lines.push(`    it says: ${clip(String(added.body ?? added.notes ?? added.title ?? ""), 500).replace(/\n+/g, " ⏎ ")}`);
      else lines.push("    (no longer in BaseSpace — removed since)");
    }
  }
  return lines.join("\n");
}

async function evidencePack(watch: Watch, items: WorkView[]): Promise<string> {
  const overlay = await loadOverlay();
  const parts: string[] = [];
  for (const i of items) {
    const claim = i.status === "done" ? `claims: ${i.result ?? "(no result)"}` : i.status === "blocked" ? `blocked: ${i.blockedReason ?? ""}` : "cancelled";
    parts.push(
      `### ${i.id} "${i.title}" — ${i.assignee}, ${i.status}\n` +
        (i.detail ? `  asked: ${clip(i.detail, 300)}\n` : "") +
        `  ${clip(claim, 600)}\n  what actually ran:\n${await evidenceFor(i, overlay)}`,
    );
  }
  let text = parts.join("\n\n");
  if (text.length > EVIDENCE_CAP) text = `${text.slice(0, EVIDENCE_CAP)}\n… (cut; ask with the basespace tool for more)`;
  return (
    `Verify "${watch.label}" (round ${watch.rounds + 1} of ${MAX_ROUNDS}). For each item, compare what it claims with what actually ran.\n` +
    "- Claim matches the evidence: accept it (say so in your result).\n" +
    "- Claim isn't backed (nothing was added, the text doesn't do what was asked, a made-up number or fact): `work` reopen {id, text: what's missing}.\n" +
    "- Needs a decision only the operator can make: `work` escalate {id, text}.\n" +
    "Report problems — don't fix them yourself. Finish with `work` done {text: one line per item: accepted / reopened / escalated, and why}.\n\n" +
    text
  );
}

// ---- The check -------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Looks at every open watch and moves it on: starts a verification when
 *  all its items have stopped, and settles it when the verification is
 *  over. Idempotent — safe to call on every work event. */
export function checkWatches(): Promise<void> {
  const next = chain.then(checkWatchesNow, checkWatchesNow);
  chain = next.catch(() => {});
  return next;
}

async function checkWatchesNow(): Promise<void> {
  const all = await listWork();
  const byId = new Map(all.map((w) => [w.id, w]));
  for (const watch of await listWatches()) {
    if (watch.status === "watching" || watch.status === "reopened") {
      const items = treeOf(watch.rootIds, all);
      if (items.some((i) => i.status === "open" || i.status === "in_progress")) continue;
      if (!items.some((i) => i.status === "done" || i.status === "blocked")) {
        await appendEvent(STREAM, "watch.settled", { id: watch.id, status: "closed", verdict: "everything under it was cancelled — nothing to verify" });
        continue;
      }
      if (watch.rounds >= MAX_ROUNDS) {
        await appendEvent(STREAM, "watch.settled", {
          id: watch.id,
          status: "needs-operator",
          verdict: `still not right after ${MAX_ROUNDS} verifications — ${watch.verdict ?? ""}`.trim(),
          reopened: watch.reopened,
        });
        await publishEvent("watch.settled", { id: watch.id, status: "needs-operator" });
        continue;
      }
      const checked = items.filter((i) => i.status !== "cancelled");
      const requestedBy = watch.createdBy === watch.verifier ? OPERATOR : watch.createdBy;
      const verification = await createWork({
        title: `Verify: ${watch.label}`.slice(0, 120),
        detail: await evidencePack(watch, checked),
        assignee: watch.verifier,
        requestedBy,
        ...(watch.originSessionId ? { requestedFromSessionId: watch.originSessionId } : {}),
        ...(watch.focus ? { focus: watch.focus } : {}),
        kind: "verification",
        verifies: checked.map((i) => i.id),
        watchId: watch.id,
      });
      await appendEvent(STREAM, "watch.verifying", { id: watch.id, verificationId: verification.id });
      await publishEvent("watch.verifying", { id: watch.id, verificationId: verification.id });
    } else if (watch.status === "verifying") {
      const v = byId.get(watch.verificationIds.at(-1) ?? "");
      if (!v || v.status === "open" || v.status === "in_progress") continue;
      const since = v.createdAt;
      // What the verifier sent back: items reopened by it during the check.
      const reopened = (v.verifies ?? []).filter((id) =>
        (byId.get(id)?.notes ?? []).some((n) => n.by === watch.verifier && n.text.startsWith("reopened:") && n.at >= since),
      );
      const status: WatchStatus =
        v.status !== "done" ? "needs-operator"
        : reopened.length ? "reopened"
        : "verified";
      const verdict = v.status === "done" ? (v.result ?? "") : v.status === "blocked" ? `the verifier couldn't finish: ${v.blockedReason ?? ""}` : "the verification was cancelled";
      await appendEvent(STREAM, "watch.settled", { id: watch.id, status, verdict, reopened });
      await publishEvent("watch.settled", { id: watch.id, status });
    }
  }
}
