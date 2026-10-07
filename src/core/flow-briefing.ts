// The briefing: what the operator reads first when a flow is done. Written by the flow's lead (the agent that designed it, else
// Hemera) from a packet of evidence the harness assembles, not from memory:
//   - what each step did and how it ended, and the notes the agents wrote (their text, capped),
//   - the open todos with the details the agents gave them (the options, the question),
//   - what was already decided (answers),
//   - the verifier's verdict, and anything that failed.
// It answers: what do I need to decide (with the options and facts to decide it), what did the agents do, what did they find, and
// what no longer matches (a todo that points at something that is gone). Counts in it are compared to the built pack by code
// (pack-check.ts); numbers that do not match are listed under it instead of being passed off as fact.
// It costs one model call per flow (AGENT_OS_FLOW_BRIEFING=off turns the automatic one off; the panel can write one on request).

import { appendEvent, project } from "./eventlog.js";
import { buildFlowReport } from "./flow-report.js";
import { getFlowDefinition } from "./flow-proposals.js";
import { loadOverlay } from "./basespace.js";
import { createModelForAgent } from "./models/real.js";
import { getAgentRecord } from "./agents.js";
import { checkTextAgainstPack, latestPackFacts } from "./pack-check.js";
import type { ModelAdapter } from "./model.js";

const STREAM = "flow-briefings";
const NOTE_CAP = 3000;
const PACKET_CAP = 30_000;

export interface FlowBriefing {
  flowId: string;
  text: string;
  by: string;
  generatedAt: string;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** Numbers in the text that do not match the pack (empty/absent when they all do). */
  unverified?: string[];
}

export async function getFlowBriefing(flowId: string): Promise<FlowBriefing | undefined> {
  return project<FlowBriefing | undefined>(STREAM, undefined, (state, e) =>
    e.type === "briefing.written" && (e.payload as { flowId?: string }).flowId === flowId ? (e.payload as unknown as FlowBriefing) : state,
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[cut: ${s.length - n} more characters]` : s);

/** The evidence, as plain text. Everything in it is a record the harness holds; nothing is summarised by a model. */
export async function buildBriefingPacket(flowId: string): Promise<string | undefined> {
  const report = await buildFlowReport(flowId);
  if (!report) return undefined;
  const overlay = await loadOverlay();
  const out: string[] = [];
  out.push(`FLOW: ${report.title ?? report.flowId} (${report.status})${report.summary ? `\nPurpose: ${report.summary}` : ""}`);

  out.push("\nSTEPS:");
  for (const s of report.steps) {
    const last = s.attempts.at(-1);
    out.push(`- ${s.id} (${s.agentId ?? "?"}): ${s.status}${s.attempts.length > 1 ? `, ${s.attempts.length} attempts` : ""}${last?.error ? ` — stopped: ${last.error}` : ""}`);
  }

  out.push("\nNOTES THE AGENTS WROTE OR CHANGED (their text):");
  const seen = new Set<string>();
  for (const a of report.outcome.byAgent)
    for (const n of a.notes) {
      if (seen.has(n.title)) continue;
      seen.add(n.title);
      const note = overlay.notes.find((x) => x.title === n.title);
      out.push(`\n### ${n.title} (by ${a.agentId}${n.folder ? `, ${n.folder}` : ""})\n${clip(String(note?.body ?? ""), NOTE_CAP)}`);
    }

  out.push("\nOPEN TODOS (what is still to do), with the details the agent gave each:");
  const open = overlay.tasks.filter((t) => report.outcome.toDo.some((d) => d.todoId === t.id));
  if (!open.length) out.push("(none)");
  for (const t of open) out.push(`\n- [${t.priority ?? "med"}] ${t.title}\n  ${String(t.notes ?? "").replace(/\s*\(added by [^)]*\)\s*$/, "").replace(/\n/g, "\n  ")}`);

  const answered = report.outcome.byAgent.flatMap((a) => a.todos.filter((t) => !t.open && t.answer));
  if (answered.length) {
    out.push("\nALREADY DECIDED BY THE OPERATOR:");
    for (const t of answered) out.push(`- ${t.title} → ${t.answer}`);
  }

  const other = report.outcome.toDo.filter((d) => d.kind !== "todo");
  if (other.length) {
    out.push("\nOTHER THINGS LEFT:");
    for (const d of other) out.push(`- ${d.text}${d.detail ? ` — ${d.detail}` : ""}`);
  }

  out.push(`\nVERIFIER (${report.verdict.agentId}): ${report.verdict.status}${report.verdict.text ? `\n${clip(report.verdict.text, 2500)}` : report.verdict.error ? ` — ${report.verdict.error}` : ""}`);

  const packet = out.join("\n");
  return packet.length > PACKET_CAP ? `${packet.slice(0, PACKET_CAP)}\n[the evidence was cut here]` : packet;
}

const SYSTEM =
  "You write the briefing the operator (ISARK) reads first when a team flow has finished. You are given the EVIDENCE: the records of what the agents did, the notes they wrote, the todos still open with the details the agents gave them, what the operator already decided, and the verifier's verdict. " +
  "Write ONLY from that evidence. Quote options, names and numbers exactly; never add a fact, number, price or opinion about how anything sounds (nobody here can hear audio). Anything you infer is labelled 'Assumption:'. Plain text and markdown; the artist is written ISARK. " +
  "Use exactly these sections, in this order, short and concrete:\n" +
  "## Bottom line\n2–3 sentences: is this ready, and what is the one thing holding it up.\n" +
  "## What you need to decide\nOne entry per open todo that is a decision or a question. For each: the question in plain words; THE OPTIONS OR FACTS NEEDED TO ANSWER IT, quoted from the evidence (list every option exactly as written); where they come from (the note title); and what waits on the answer. If the evidence lacks what is needed to decide, say exactly what is missing instead of guessing.\n" +
  "## Things only you can do\nOne line each for the open todos that are actions (record, upload, get approval, legal review), in the order they must happen.\n" +
  "## What the agents did\nOne or two lines per agent: what they produced (name the notes).\n" +
  "## What they found, and what to be careful about\nFindings, risks, anything the verifier flagged or that failed, and where agents disagreed.\n" +
  "## Out of date or contradictory\nAny todo or note whose text no longer matches the other notes or the facts in the evidence (for example a todo that points at options or a note that no longer exists). Say 'Nothing found' only if you checked.";

/** Writes (and stores) the briefing for a flow. `fallbackModel` is used when the lead has no model of its own. */
export async function generateFlowBriefing(flowId: string, fallbackModel: ModelAdapter): Promise<FlowBriefing | undefined> {
  const packet = await buildBriefingPacket(flowId);
  if (!packet) return undefined;
  const def = await getFlowDefinition(flowId);
  const lead = def?.proposedBy && def.proposedBy !== "operator" && (await getAgentRecord(def.proposedBy)) ? def.proposedBy : "hemera";
  const model = (await createModelForAgent(lead)) ?? fallbackModel;

  const ask = async (extra?: string) =>
    model.complete([{ role: "system", content: SYSTEM }, { role: "user", content: `EVIDENCE:\n${packet}${extra ? `\n\n${extra}` : ""}\n\nWrite the briefing now.` }], { tools: [] });
  let reply = await ask();
  let text = reply.content.trim();
  let usage = reply.usage;

  // Numbers are checked by code against the built pack; one correction round, then whatever is still wrong is listed under the text.
  const facts = await latestPackFacts();
  let unverified: string[] | undefined;
  if (facts) {
    let problems = checkTextAgainstPack(text, facts);
    if (problems.length) {
      reply = await ask(`A check run by code found numbers in your first draft that do not match the pack:\n${problems.map((p) => `- ${p}`).join("\n")}\nWrite the briefing again with exactly those corrected, changing nothing else.`);
      text = reply.content.trim();
      if (reply.usage && usage) usage = { inputTokens: usage.inputTokens + reply.usage.inputTokens, outputTokens: usage.outputTokens + reply.usage.outputTokens, ...(usage.cachedInputTokens || reply.usage.cachedInputTokens ? { cachedInputTokens: (usage.cachedInputTokens ?? 0) + (reply.usage.cachedInputTokens ?? 0) } : {}) };
      problems = checkTextAgainstPack(text, facts);
      if (problems.length) unverified = problems;
    }
  }
  if (!text) return undefined;
  const briefing: FlowBriefing = { flowId, text, by: lead, generatedAt: new Date().toISOString(), ...(usage ? { usage } : {}), ...(unverified ? { unverified } : {}) };
  await appendEvent(STREAM, "briefing.written", briefing as unknown as Record<string, unknown>);
  return briefing;
}

/** Worth an automatic briefing: a flow with real size, a failure, or something left for the operator. */
export async function worthBriefing(flowId: string): Promise<boolean> {
  const report = await buildFlowReport(flowId);
  if (!report) return false;
  return report.steps.length >= 3 || report.steps.some((s) => ["failed", "timed_out", "lost"].includes(s.status)) || report.outcome.toDo.some((t) => t.kind === "todo");
}
