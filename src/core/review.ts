// Team review — the management layer on top of the work ledger (work.ts),
// after Paperclip's heartbeat: a lead (anyone with reports) periodically
// looks at its team's work against the goals it serves and re-plans,
// instead of the operator having to notice a stuck item.
//
// The digest below is plain code — no model call. A lead only gets a turn
// when something actually needs it (blocked, handed back, gone quiet) AND
// that differs from what it saw at its last review; an unchanged team
// costs nothing. The lead acts through the `work` tool (reopen with
// guidance, reassign, escalate to the operator) and `delegate`. It decides
// nothing outward-facing, and board controls stay the operator's.
//
// Running reviews on a schedule is the gateway's job (gateway/review-loop.ts).

import { appendEvent, project } from "./eventlog.js";
import { listAgentIdentities, type AgentIdentity } from "./identity.js";
import { loadSnapshot } from "./basespace.js";
import { agentIsBlocked } from "./controls.js";
import { listWork, type WorkView } from "./work.js";

const REVIEW_STREAM = "reviews";

/** Hours without any change before open or running work counts as gone quiet. */
export function staleHours(): number {
  const h = Number(process.env.AGENT_OS_STALE_HOURS ?? 24);
  return Number.isFinite(h) && h > 0 ? h : 24;
}

export interface ReviewItem {
  id: string;
  title: string;
  assignee: string;
  status: string;
  /** Why it's listed: the blocked reason, the hand-back reason, or how long it's been quiet. */
  why: string;
  goal?: string;
}

export interface ReviewDigest {
  agentId: string;
  reports: string[];
  blocked: ReviewItem[];
  handedBack: ReviewItem[];
  stale: ReviewItem[];
  /** Waiting on the operator already — shown, not re-reviewed. */
  escalated: ReviewItem[];
  doneSinceLastReview: ReviewItem[];
  /** Active goals no open work serves. */
  idleGoals: string[];
  /** blocked + handedBack + stale. Zero → no review turn. */
  attention: number;
  /** Changes whenever an attention item changes; same → no new review. */
  fingerprint: string;
}

export interface ReviewRecord {
  agentId: string;
  sessionId: string;
  at: string;
  fingerprint: string;
  attention: number;
  tokens: number;
  summary: string;
  stopReason?: string;
  trigger: "schedule" | "event" | "operator";
}

interface ReviewState {
  sessions: Map<string, string>;
  runs: ReviewRecord[];
}

async function projectReviews(): Promise<ReviewState> {
  return project<ReviewState>(REVIEW_STREAM, { sessions: new Map(), runs: [] }, (state, event) => {
    const p = event.payload as any;
    if (event.type === "review.session") state.sessions.set(p.agentId, p.sessionId);
    if (event.type === "review.ran") state.runs.push({ ...p, at: event.timestamp });
    return state;
  });
}

/** Agents with at least one report. */
export async function listLeads(): Promise<AgentIdentity[]> {
  const all = await listAgentIdentities();
  return all.filter((a) => all.some((b) => b.reportsTo === a.id));
}

export async function getReviewSessionId(agentId: string): Promise<string | undefined> {
  return (await projectReviews()).sessions.get(agentId);
}

export async function setReviewSessionId(agentId: string, sessionId: string): Promise<void> {
  await appendEvent(REVIEW_STREAM, "review.session", { agentId, sessionId });
}

export async function recordReview(record: Omit<ReviewRecord, "at">): Promise<void> {
  await appendEvent(REVIEW_STREAM, "review.ran", record);
}

/** Newest first. */
export async function listReviews(agentId?: string, limit = 20): Promise<ReviewRecord[]> {
  const runs = (await projectReviews()).runs.filter((r) => !agentId || r.agentId === agentId);
  return runs.reverse().slice(0, limit);
}

function age(iso: string, now: number): string {
  const h = Math.floor((now - Date.parse(iso)) / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} hours`;
}

export async function reviewDigest(agentId: string, now = Date.now()): Promise<ReviewDigest> {
  const all = await listAgentIdentities();
  const reports = all.filter((a) => a.reportsTo === agentId).map((a) => a.id);
  const snap = (await loadSnapshot()) ?? {};
  const goals: any[] = Array.isArray(snap.goals) ? snap.goals : [];
  const projects: any[] = Array.isArray(snap.projects) ? snap.projects : [];
  const goalOf = (w: WorkView): string | undefined => {
    if (!w.focus) return undefined;
    if (w.focus.kind === "goal") return goals.find((g) => g.id === w.focus!.id)?.title;
    const p = projects.find((x) => x.id === w.focus!.id);
    return p ? `${p.name ?? p.title} (project)` : undefined;
  };
  const item = (w: WorkView, why: string): ReviewItem => {
    const goal = goalOf(w);
    return { id: w.id, title: w.title, assignee: w.assignee, status: w.status, why, ...(goal ? { goal } : {}) };
  };

  // The lead's team work: what its reports are doing, and what it asked for.
  const work = (await listWork()).filter((w) => reports.includes(w.assignee) || w.requestedBy === agentId || w.assignee === agentId);
  const active = (w: WorkView) => w.status === "open" || w.status === "in_progress" || w.status === "blocked";
  const staleMs = staleHours() * 3_600_000;
  const lastReview = (await listReviews(agentId, 1))[0];

  const blocked: ReviewItem[] = [];
  const handedBack: ReviewItem[] = [];
  const stale: ReviewItem[] = [];
  const escalated: ReviewItem[] = [];
  for (const w of work.filter(active)) {
    if (w.escalation) {
      escalated.push(item(w, w.escalation.reason));
      continue;
    }
    const last = w.notes.at(-1);
    if (w.assignee === agentId) {
      // Handed back to this lead by one of its reports, not yet picked up.
      if (w.status === "open" && last && reports.includes(last.by) && last.text.startsWith(`handed to ${agentId}:`)) {
        handedBack.push(item(w, `${last.by}: ${last.text.slice(`handed to ${agentId}: `.length)}`));
      }
      continue;
    }
    if (w.status === "blocked") blocked.push(item(w, w.blockedReason ?? "no reason given"));
    else if (now - Date.parse(w.updatedAt) > staleMs) {
      const paused = await agentIsBlocked(w.assignee);
      stale.push(item(w, `${w.status === "open" ? "not started" : "running"} for ${age(w.updatedAt, now)}${paused ? ` (${w.assignee} is paused or over budget)` : ""}`));
    }
  }
  const since = lastReview ? Date.parse(lastReview.at) : now - 7 * 24 * 3_600_000;
  const doneSinceLastReview = work
    .filter((w) => w.status === "done" && w.assignee !== agentId && Date.parse(w.updatedAt) > since)
    .slice(0, 8)
    .map((w) => item(w, (w.result ?? "").slice(0, 140)));

  const served = new Set<string>();
  for (const w of (await listWork()).filter(active)) {
    if (w.focus?.kind === "goal") served.add(w.focus.id);
    if (w.focus?.kind === "project") for (const g of goals) if ((g.projectIds ?? []).includes(w.focus.id)) served.add(g.id);
  }
  const idleGoals = goals.filter((g) => (g.status ?? "active") === "active" && !served.has(g.id)).map((g) => String(g.title)).slice(0, 6);

  const attentionItems = [...blocked, ...handedBack, ...stale];
  const byId = new Map(work.map((w) => [w.id, w]));
  const fingerprint = attentionItems
    .map((i) => `${i.id}:${i.status}:${byId.get(i.id)?.updatedAt ?? ""}`)
    .sort()
    .join("|");
  return { agentId, reports, blocked, handedBack, stale, escalated, doneSinceLastReview, idleGoals, attention: attentionItems.length, fingerprint };
}

/** The review turn's message: the digest, compact, plus what to do with it. */
export function renderReviewPrompt(d: ReviewDigest): string {
  const line = (i: ReviewItem, who = true) => `- ${i.id} "${i.title}"${who ? ` (${i.assignee})` : ""}${i.goal ? ` for ${i.goal}` : ""}: ${i.why}`;
  const parts = [
    d.attention
      ? `[Review] Team review: ${d.attention} item${d.attention === 1 ? "" : "s"} need${d.attention === 1 ? "s" : ""} you.`
      : "[Review] Team review, asked for by the operator. Nothing is blocked or stuck.",
  ];
  if (d.blocked.length) parts.push(`Blocked:\n${d.blocked.map((i) => line(i)).join("\n")}`);
  if (d.handedBack.length) parts.push(`Handed back to you:\n${d.handedBack.map((i) => line(i, false)).join("\n")}`);
  if (d.stale.length) parts.push(`No movement for ${staleHours()}+ hours:\n${d.stale.map((i) => line(i)).join("\n")}`);
  if (d.escalated.length) parts.push(`Already escalated, waiting on the operator (leave these): ${d.escalated.map((i) => `"${i.title}"`).join(", ")}`);
  if (d.doneSinceLastReview.length) parts.push(`Finished since your last review: ${d.doneSinceLastReview.map((i) => `"${i.title}" (${i.assignee})`).join(", ")}`);
  if (d.idleGoals.length) parts.push(`Active goals with no work on them: ${d.idleGoals.map((g) => `"${g}"`).join(", ")}`);
  parts.push(
    "For each item that needs you, pick one: reopen it with guidance (`work` reopen {id, text}); give it to a better-placed teammate " +
      "(`work` reassign {id, to, text}); split or redo it (`delegate`); or, when only the operator can decide (money, publishing, " +
      "a missing asset, a change of plan), escalate it (`work` escalate {id, text}). Don't cancel work unless it's truly moot. " +
      "Then answer with a two-line summary for the operator: what you did, and what needs them.",
  );
  return parts.join("\n\n");
}
