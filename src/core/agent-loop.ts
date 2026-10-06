// The Agent Loop — deliberately thin, matching the convergent design
// across all six harnesses studied: "gather context -> take action ->
// verify," turn by turn, until the model stops requesting tool calls.
// Every turn is written to the session's event stream, so resume/replay/
// observability for free (see eventlog.ts).

import { blockWork, cancelWork, completeWork, createWork, escalateWork, handBackWork, listWork, noteWork, reassignWork, reopenWork, orgContext, recordWorkUsage, workForSession, type WorkView } from "./work.js";
import { AgentBlockedError, assertAgentMayRun, getAgentControlState, recordAgentUsage } from "./controls.js";
import { GATED_TOOLS, adoptPlan, checkProposal, gateToolCall, hireAgent } from "./governance.js";
import { watchWork } from "./watchdog.js";
import { hindsightConfigured, hindsightRecall, hindsightReflect, hindsightRetain } from "./hindsight.js";
import { addOverlayItem, focusContext, readSnapshotSection, type OverlayKind } from "./basespace.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendEvent, project } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { MAX_CALLS_PER_REPLY, type ModelAdapter, type ModelMessage, type ToolSpec } from "./model.js";
import type { Worker } from "./worker.js";
import { fireHook } from "./hooks.js";
import { generateId } from "./id.js";
import { SkillRegistry, renderSkillCatalog } from "./skills.js";
import { retrieveMemoryContext } from "./memory.js";
import { getAgentIdentity, listAgentIdentities } from "./identity.js";
import { beginTurnAbort, endTurnAbort, ensureSession, isSessionCancelled, getSession } from "./session.js";
import { getToolDefinition, listToolDefinitions, toToolSpec, toolVisibleTo, withTimeout } from "./tool-registry.js";
import type { ArtifactType } from "./artifacts.js";
import type { EpisodicKind } from "./types.js";
import { checkPathSandbox, type SandboxPolicy } from "./permissions.js";
import { recordFileRevision } from "./file-revisions.js";
import { dispatchAudio, dispatchLibrary, dispatchSoundlab } from "./library-tools.js";
import { renderDesktopReport } from "./desktop.js";
import { adoptFlow } from "./flow-proposals.js";

export interface AgentTurnResult {
  sessionId: string;
  finalContent: string;
  toolCalled?: string;
  /** True when this turn stopped early because the Session (session.ts)
   *  was cancelled mid-run rather than completing normally — see
   *  cancelSession()'s doc comment for how a caller triggers this. */
  cancelled?: boolean;
  /** Summed across every model call this turn made (a tool-calling turn
   *  makes several) — omitted entirely when the model adapter never
   *  reported usage at all (the stub model, or a provider response that
   *  didn't carry it), never a fabricated {0,0}. */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** How the turn ended: a real answer, a tool call the harness refused
   *  (plan mode, policy, an approval still pending), out of tool steps, or
   *  cancelled. Lets callers like the work runner tell "finished" from
   *  "stopped". */
  stopReason: "answered" | "tool-blocked" | "max-hops" | "cancelled";
}

export interface RunTurnOptions {
  sessionId: string;
  agentId: string;
  userMessage: string;
  model: ModelAdapter;
  worker: Worker;
  maxToolHops?: number;
  /** Overrides the per-run cap on tool executions (maxToolExecutionsPerRun) for this turn: a flow step that has a whole
   *  list to write needs more than a chat reply does. */
  maxToolExecutions?: number;
  /** Layer-1 progressive disclosure: when provided, every skill's
   *  name+description is injected as a system message each turn (not
   *  stored in the session log — the catalog is external state re-read
   *  fresh each time, mirroring how Claude Code re-injects CLAUDE.md from
   *  disk rather than trusting a stale in-history copy). The model can
   *  then request the `skill` tool to load a specific skill's full body
   *  (layer 2). */
  skills?: SkillRegistry;
  /** When provided, the model can call the `subagent` tool to delegate a
   *  focused sub-task to a fresh, isolated agent-loop session — same
   *  harness, same tools, own context window (see subagent.ts). Omit to
   *  disable delegation for this turn (e.g. a subagent run itself
   *  typically shouldn't recursively spawn more subagents unless you
   *  specifically want that — pass it through deliberately, not by
   *  default, to avoid uncontrolled fan-out). */
  enableSubagents?: boolean;
  /** When true (default), curated memory (MEMORY.md + USER.md,
   *  memory.ts's getCuratedMemory) is re-read from its event stream and
   *  injected as a system message every turn — the actual point of
   *  having a "dreaming"-gated permanent memory at all is that it gets
   *  used, not just computed and left unread. Re-read fresh each turn
   *  (not cached, not stored in session history) so a dreaming pass that
   *  runs mid-conversation is picked up on the very next turn, the same
   *  pattern the skill catalog already uses. Set false to run a turn
   *  with no memory context (e.g. testing eligibility scoring in
   *  isolation without it leaking into unrelated assertions). */
  injectMemory?: boolean;
  /** When provided, the model can call the `nominate-memory` tool to
   *  propose something worth remembering (see memory.ts's
   *  nominateAgentMemory). This is a BOUNDED voice, not a bypass: the
   *  nomination sits in "pending" state with zero effect on curated
   *  memory until a human explicitly calls approveAgentMemory() or
   *  rejectAgentMemory() — async, since this scaffold has no
   *  synchronous "ask the user right now" mechanism. Omit to disable
   *  nomination for this turn, same opt-in pattern as enableSubagents. */
  enableMemoryNominations?: boolean;
  /** When provided, the model can call the `record-artifact` tool to
   *  attach a produced output (a file it wrote via the shell tool, a
   *  report, a plan, ...) to this Task/Session — see artifacts.ts. The
   *  artifact itself is just a pointer (type + location + metadata);
   *  this scaffold doesn't manage blob storage, so the model is
   *  expected to have already produced the actual content some other
   *  way (typically via the shell tool) before recording it. Omit to
   *  disable artifact recording for this turn, same opt-in pattern as
   *  enableSubagents/enableMemoryNominations. */
  enableArtifacts?: boolean;
  /** Tell the agent about the BaseSpace bridge (basespace.ts) in its system
   *  message — on for the live gateway, off by default so a bare runTurn()
   *  keeps producing exactly the system message it always did. */
  enableBaseSpace?: boolean;
  /** Offer only these tools this turn (still subject to what's enabled and
   *  visible) — for turns with one job, like a lead's team review, where
   *  every other tool is prompt weight and a detour. */
  onlyTools?: string[];
  /** When provided, read_file/edit_file/write_file (and, independently,
   *  createSandboxedWorker-wrapped shell calls — see worker.ts) are
   *  confined to this policy's workspace roots via permissions.ts's
   *  checkPathSandbox(). Omitted means NO containment check runs for
   *  these three tools specifically — matches this scaffold's existing
   *  posture that sandboxing is something a caller (the gateway) opts
   *  into by constructing a policy, not an implicit default baked into
   *  agent-loop.ts itself. */
  sandboxPolicy?: SandboxPolicy;
  /** When true, the turn can inspect but not mutate anything —
   *  ROADMAP.md's "plan / read-only mode" item. Enforced in the hop loop
   *  itself (see PLAN_MODE_BLOCKED_TOOLS below), independent of and
   *  checked BEFORE Layer A's PermissionPolicy, so an "allow" rule never
   *  overrides it. Default false/omitted — every existing caller's
   *  behavior is unchanged. */
  planMode?: boolean;
}

/** Tools plan mode blocks outright, regardless of what Layer A's
 *  PermissionPolicy would otherwise decide. shell/edit_file/write_file
 *  can change the filesystem or run arbitrary commands; subagent can
 *  itself mutate files via a delegated turn, so blocking it too is what
 *  makes plan mode actually mean "nothing changes" rather than "nothing
 *  changes, except through one level of indirection." Deliberately NOT
 *  blocking read_file/skill/nominate-memory/record-artifact — none of
 *  them mutate anything a plan-mode turn shouldn't be allowed to do
 *  (a nomination has zero effect until a human approves it; recording
 *  an artifact just registers metadata about something already
 *  produced some other way). */
export const PLAN_MODE_BLOCKED_TOOLS = new Set(["shell", "edit_file", "write_file", "subagent"]);

/** `library` add/update and `audio` edit write something; their list/read/info don't, so plan mode allows those. */
/** Settles when `promise` does, or rejects the moment `signal` aborts (whichever comes first). The
 *  original promise is left to finish or fail on its own; its late result is ignored. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** A hard cap on tool EXECUTIONS in one run (one turn), however they are batched: several calls per reply could otherwise
 *  multiply the work a turn does. When it is reached the turn ends and says so. AGENT_OS_MAX_TOOL_EXECUTIONS overrides it. */
export function maxToolExecutionsPerRun(): number {
  const n = Number(process.env.AGENT_OS_MAX_TOOL_EXECUTIONS ?? 8);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

/** Model replies one flow step may take (AGENT_OS_FLOW_STEP_HOPS, default 25), wherever the flow came from. */
export function flowStepHops(): number {
  const n = Number(process.env.AGENT_OS_FLOW_STEP_HOPS ?? 25);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
}

/** The cap for one flow step (AGENT_OS_FLOW_STEP_EXECUTIONS, default 25). A step is a whole job, so it gets more room than
 *  a chat turn; it still ends, and says so, when it reaches it. */
export function flowStepExecutions(): number {
  const n = Number(process.env.AGENT_OS_FLOW_STEP_EXECUTIONS ?? 25);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
}

/** The calls in a model reply, in order: `toolCalls` when the adapter parsed several, else the single `toolCall`. */
function toolCallsOf(response: { toolCall?: { name: string; args: Record<string, unknown> }; toolCalls?: { name: string; args: Record<string, unknown> }[] }): { name: string; args: Record<string, unknown> }[] {
  const list = response.toolCalls?.length ? response.toolCalls : response.toolCall ? [response.toolCall] : [];
  return list.slice(0, MAX_CALLS_PER_REPLY);
}

export function changesLibraryOrAudio(call: { name: string; args: Record<string, unknown> }): boolean {
  const action = String(call.args.action ?? "");
  return (call.name === "library" && (action === "add" || action === "update")) || (call.name === "audio" && action === "edit");
}

function sessionStream(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Posts a note from the harness into a session without running a turn —
 *  e.g. "Nyx finished the work you handed over". Stored as a user-role
 *  message with a `[Tag] ` prefix (like approval decisions), so the agent
 *  sees it next turn and BaseSpace shows it as a system note. Publishes
 *  `session.note` so an open chat refreshes. */
export async function appendSessionNote(sessionId: string, tag: string, text: string): Promise<void> {
  await appendEvent(sessionStream(sessionId), "session.message", { role: "user", content: `[${tag}] ${text}` });
  await publishEvent("session.note", { sessionId, tag });
}

export async function getSessionHistory(sessionId: string): Promise<ModelMessage[]> {
  return project<ModelMessage[]>(sessionStream(sessionId), [], (state, event) => {
    if (event.type === "session.message") {
      state.push(event.payload as unknown as ModelMessage);
    }
    return state;
  });
}

// ---- Context compaction (ROADMAP.md's "context compaction" item) ----
//
// getSessionHistory() above is an unbounded, append-only projection — by
// design, and that design is NOT changed here: the durable log (and
// anything reading it directly, like a UI's full transcript view) keeps
// seeing every message that ever happened, forever. What changes is
// what gets FED TO THE MODEL on a long-running session: once history
// grows past a threshold, everything older than the most recent
// COMPACT_KEEP_RECENT messages is replaced, for the model's eyes only,
// by one summary the model itself wrote — summarized via a real call to
// the SAME model adapter already in use for the turn, not hardcoded
// truncation. A `session.compacted` event records WHEN and THROUGH
// WHICH message index compaction happened; it's additive, never
// rewriting or deleting the session.message events it summarizes —
// same "append, never mutate" posture as every other stream in this
// codebase.

/** Rough proxy for "getting close to a model's context window" — chars,
 *  not real tokens (this scaffold has no tokenizer dependency for any
 *  provider, and a rough proxy that's honest about being rough is better
 *  than a precise-looking number that's actually wrong for half the
 *  providers). Deliberately generous: triggering compaction too early
 *  would throw away useful context for no benefit; too late risks an
 *  actual provider error, which is the failure this exists to prevent. */
const COMPACTION_TRIGGER_CHARS = 24_000;
/** Never compact below this many messages — a short but verbose
 *  conversation (a few long messages) shouldn't get summarized away
 *  just because COMPACTION_TRIGGER_CHARS was crossed; compaction is for
 *  conversations that have genuinely gone on a while. */
const COMPACTION_MIN_MESSAGES = 12;
/** How many of the MOST RECENT messages stay verbatim, never folded into
 *  the summary — recent exchanges are exactly what a continuation needs
 *  word-for-word (the user's last few asks, the model's last few
 *  answers), unlike older context where a summary genuinely suffices. */
const COMPACTION_KEEP_RECENT = 8;

function totalChars(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

interface CompactionState {
  /** How many of the session's session.message events the most recent
   *  compaction already covers — 0 means "never compacted." */
  throughIndex: number;
  summary: string;
}

async function getCompactionState(sessionId: string): Promise<CompactionState> {
  return project<CompactionState>(sessionStream(sessionId), { throughIndex: 0, summary: "" }, (state, event) => {
    if (event.type === "session.compacted") {
      const p = event.payload as { summary: string; throughIndex: number };
      return { throughIndex: p.throughIndex, summary: p.summary };
    }
    return state;
  });
}

/** The model-facing counterpart to getSessionHistory() — same durable
 *  messages, but with anything already covered by a prior compaction
 *  collapsed into that compaction's summary (one synthetic system
 *  message) instead of being replayed in full. Falls back to the exact
 *  full history, byte-for-byte, when the session has never been
 *  compacted — so every existing caller/test that never triggers
 *  compaction at all sees zero behavior change. */
export async function getModelFacingHistory(sessionId: string): Promise<ModelMessage[]> {
  const [raw, compaction] = await Promise.all([getSessionHistory(sessionId), getCompactionState(sessionId)]);
  // Tool results carry the call that produced them — show it to the model.
  const full = raw.map((m) => {
    const call = (m as ModelMessage & { call?: string }).call;
    return m.role === "tool" && call ? { role: m.role, content: `[${call}]\n${m.content}` } : m;
  });
  if (compaction.throughIndex === 0) return full;
  const remaining = full.slice(compaction.throughIndex);
  return [{ role: "system", content: `[Summary of earlier conversation, compacted to stay within context limits]\n${compaction.summary}` }, ...remaining];
}

/** Checked once per turn (not per hop — a single turn's own tool-calling
 *  hops don't usually grow history enough within themselves to matter,
 *  and checking once keeps this cheap). If the model-facing history is
 *  still over threshold, asks the SAME model adapter the turn is already
 *  using to summarize everything except the most recent
 *  COMPACTION_KEEP_RECENT messages, then records a session.compacted
 *  event covering exactly what was summarized. A summarization call
 *  that itself fails (model/provider error) is logged and swallowed —
 *  compaction is a context-management nicety, not something that should
 *  ever be able to take down a turn that would otherwise have succeeded
 *  uncompacted (a provider that's already over its own limit will fail
 *  on the REAL call moments later anyway, with its own real error). */
async function maybeCompactSession(sessionId: string, model: ModelAdapter): Promise<void> {
  const full = await getSessionHistory(sessionId);
  if (full.length < COMPACTION_MIN_MESSAGES) return;
  const compaction = await getCompactionState(sessionId);
  const remaining = full.slice(compaction.throughIndex);
  if (remaining.length <= COMPACTION_KEEP_RECENT) return; // nothing old enough left to fold in
  if (totalChars(remaining) < COMPACTION_TRIGGER_CHARS) return;

  const toSummarize = remaining.slice(0, remaining.length - COMPACTION_KEEP_RECENT);
  const newThroughIndex = compaction.throughIndex + toSummarize.length;
  const priorSummaryPart = compaction.summary ? `Previous summary of even earlier context:\n${compaction.summary}\n\n` : "";
  const transcript = toSummarize.map((m) => `${m.role}: ${m.content}`).join("\n\n");

  try {
    const result = await model.complete([
      {
        role: "system",
        content:
          "Summarize the following conversation concisely but completely — preserve concrete facts, decisions, file paths, and anything a continuation would genuinely need. Prose is fine; do not editorialize or add commentary about the summarization itself.",
      },
      { role: "user", content: `${priorSummaryPart}Conversation to summarize:\n\n${transcript}` },
    ], { tools: [] });
    await appendEvent(sessionStream(sessionId), "session.compacted", { summary: result.content, throughIndex: newThroughIndex });
  } catch (err) {
    console.error(`[agent-loop] context compaction failed for session ${sessionId} (continuing uncompacted):`, err instanceof Error ? err.message : err);
  }
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Part of inputTokens that came from the provider's prompt cache (only when the provider says). */
  cachedInputTokens?: number;
  /** How many of this session's turns actually reported usage — lets a
   *  caller distinguish "zero tokens used" (impossible in practice) from
   *  "no turn in this session ever reported usage" (the honest default
   *  for the stub model, or before any real provider was configured). */
  turnsWithUsage: number;
}

/** Sums every agent.turn.end event's usage field across a session's whole
 *  history — ROADMAP.md's "cost/token usage tracking" item. Pure
 *  aggregation over durable events already being recorded (agent-loop.ts
 *  above); no new stream, no new write path. */
export async function getSessionUsage(sessionId: string): Promise<SessionUsage> {
  return project<SessionUsage>(sessionStream(sessionId), { inputTokens: 0, outputTokens: 0, turnsWithUsage: 0 }, (state, event) => {
    if (event.type === "agent.turn.end") {
      const usage = (event.payload as any).usage as { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined;
      if (usage) {
        if (usage.cachedInputTokens) state.cachedInputTokens = (state.cachedInputTokens ?? 0) + usage.cachedInputTokens;
        state.inputTokens += usage.inputTokens;
        state.outputTokens += usage.outputTokens;
        state.turnsWithUsage += 1;
      }
    }
    return state;
  });
}

/** Renders curated memory (MEMORY.md + USER.md) as system-prompt text —
 *  via RETRIEVAL (memory.ts's retrieveMemoryContext), not a full dump.
 *  Below RETRIEVAL_LINE_THRESHOLD lines, everything is still included
 *  (no point filtering a handful of lines, and this keeps a
 *  freshly-started agent's behavior unchanged); above it, only the
 *  lines most relevant to the CURRENT user message are injected. Empty
 *  documents produce empty sections rather than empty-but-labeled ones,
 *  so a fresh agent with no promoted memories yet doesn't inject a
 *  confusing "MEMORY.md: (nothing here)" block into every turn. */
async function renderMemoryContext(agentId: string, queryText: string, recalled: string[]): Promise<string> {
  const retrieved = await retrieveMemoryContext(agentId, queryText);
  const parts: string[] = [];
  if (retrieved.memoryLines.length > 0) {
    const note = retrieved.usedRetrieval
      ? ` (showing ${retrieved.memoryLines.length} of ${retrieved.memoryTotalLines} most relevant lines)`
      : "";
    parts.push(`# MEMORY.md (durable facts/procedures learned about this work)${note}\n${retrieved.memoryLines.join("\n")}`);
  }
  if (retrieved.userProfileLines.length > 0) {
    const note = retrieved.usedRetrieval
      ? ` (showing ${retrieved.userProfileLines.length} of ${retrieved.userProfileTotalLines} most relevant lines)`
      : "";
    parts.push(`# USER.md (user profile/preferences learned over time)${note}\n${retrieved.userProfileLines.join("\n")}`);
  }
  // Optional Hindsight layer (hindsight.ts) — empty unless HINDSIGHT_URL is
  // set and reachable. Fetched once per turn by runTurn(), not here: this
  // function runs on every tool hop, and the query (the user's message)
  // doesn't change between hops.
  if (recalled.length > 0) {
    parts.push(`# Recalled from long-term memory (Hindsight)\n${recalled.map((l) => `- ${l}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Renders the agent's registered identity (identity.ts's persona field)
 *  as system-prompt text — this is the one piece of "who is this agent"
 *  state that lives outside memory/skills/tools. Deliberately OPTIONAL
 *  and ADDITIVE: an agentId with no registered identity (identity.ts's
 *  getAgentIdentity returns undefined) just yields an empty string here,
 *  which systemParts.filter(Boolean) below drops entirely — so a turn
 *  for an unregistered agent produces byte-for-byte the same system
 *  message it did before this wiring existed. Looked up once per turn
 *  (not per hop, unlike memory/skills) since identity doesn't change
 *  mid-turn the way a dreaming pass or a skill file on disk might. */
async function renderIdentityContext(agentId: string): Promise<string> {
  const identity = await getAgentIdentity(agentId);
  if (!identity?.persona) return "";
  return `# Agent Identity\nYou are ${identity.name}. ${identity.persona}`;
}

/** Caps how much of a file read_file hands back to the model — without
 *  this, one call on a large generated file (a lockfile, a build
 *  artifact) could consume a huge share of the context window in one
 *  hop. Mirrors the spirit of memory.ts's own retrieval-over-full-dump
 *  posture, just as a blunt length cap rather than relevance ranking —
 *  there's no query to rank against here, just a file. */
const MAX_FILE_READ_CHARS = 100_000;

/** The structured alternative to editing files via raw shell redirection
 *  — read_file/edit_file/write_file, agent-loop.ts's own trio mirroring
 *  the same primitives every major coding harness (Claude Code, Codex)
 *  settled on independently. Unlike the shell tool (which delegates
 *  filesystem containment to whatever Worker is wired in — see
 *  worker.ts's createSandboxedWorker), these operate via direct fs
 *  calls in-process, so containment is checked HERE, explicitly, against
 *  the one sandboxPolicy the caller configured (no Worker layer to lean
 *  on for these). No sandboxPolicy configured means no check runs at all
 *  — same "opt-in, not implicit" posture as every other capability flag
 *  in RunTurnOptions. */
async function dispatchFileTool(
  name: "read_file" | "edit_file" | "write_file",
  args: Record<string, unknown>,
  sandboxPolicy: SandboxPolicy | undefined,
): Promise<ToolDispatchResult> {
  const targetPath = String(args.path ?? "");
  if (!targetPath) return { ok: false, output: "", error: `${name} tool call missing required 'path' argument` };

  if (sandboxPolicy) {
    const check = checkPathSandbox(sandboxPolicy, targetPath);
    if (!check.allowed) return { ok: false, output: "", error: `sandbox rejected ${name}: ${check.reason}` };
  }

  try {
    if (name === "read_file") {
      const content = await fs.readFile(targetPath, "utf8");
      const truncated = content.length > MAX_FILE_READ_CHARS;
      const output = truncated ? content.slice(0, MAX_FILE_READ_CHARS) : content;
      return { ok: true, output: truncated ? `${output}\n\n[...truncated — file is ${content.length} chars, showing first ${MAX_FILE_READ_CHARS}]` : output };
    }

    if (name === "write_file") {
      const content = String(args.content ?? "");
      // Recorded BEFORE the write — a revision captures what the file
      // looked like immediately before THIS mutation, so restoring it
      // later reverses exactly this write, not some other state.
      // existedBefore distinguishes "overwrite" (restore = write the old
      // content back) from "brand-new file" (restore = delete it).
      const previousContent = await fs.readFile(targetPath, "utf8").catch(() => undefined);
      await recordFileRevision({ path: targetPath, previousContent, existedBefore: previousContent !== undefined, tool: "write_file" });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
      return { ok: true, output: `Wrote ${content.length} chars to ${targetPath}.` };
    }

    // edit_file
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    const replaceAll = args.replace_all === true;
    if (!oldString) return { ok: false, output: "", error: "edit_file tool call missing required 'old_string' argument" };

    const current = await fs.readFile(targetPath, "utf8");
    const occurrences = current.split(oldString).length - 1;
    if (occurrences === 0) {
      return { ok: false, output: "", error: `old_string not found in ${targetPath} — no edit was made` };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        output: "",
        error: `old_string occurs ${occurrences} times in ${targetPath}, not exactly once — no edit was made. Pass replace_all:true, or include more surrounding context to make old_string unique.`,
      };
    }
    const updated = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
    // edit_file requires the file to already exist (it was just read
    // above), so existedBefore is always true here, unlike write_file.
    await recordFileRevision({ path: targetPath, previousContent: current, existedBefore: true, tool: "edit_file" });
    await fs.writeFile(targetPath, updated, "utf8");
    return { ok: true, output: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${targetPath}.` };
  } catch (err) {
    return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

interface ToolDispatchResult {
  ok: boolean;
  output: string;
  error?: string;
}

async function dispatchTool(
  toolCall: { name: string; args: Record<string, unknown> },
  ctx: {
    worker: Worker;
    skills?: SkillRegistry;
    agentId: string;
    sessionId: string;
    model: ModelAdapter;
    enableSubagents?: boolean;
    enableMemoryNominations?: boolean;
    enableArtifacts?: boolean;
    sandboxPolicy?: SandboxPolicy;
    /** Set only by executeApprovedCall — the operator approved this call. */
    approved?: boolean;
    /** Aborted when the session is cancelled; the shell worker stops its command. */
    signal?: AbortSignal;
  },
): Promise<ToolDispatchResult> {
  if (GATED_TOOLS.has(toolCall.name) && !ctx.approved) {
    const problem = await checkProposal(toolCall.name, toolCall.args, ctx.agentId, (await getSession(ctx.sessionId))?.focus);
    return { ok: false, output: "", error: problem ? `not filed — fix this and propose again: ${problem}` : `"${toolCall.name}" only runs once the operator approves it` };
  }
  if (toolCall.name === "propose-agent") return hireAgent(toolCall.args, ctx.agentId);
  if (toolCall.name === "propose-flow") {
    return adoptFlow(toolCall.args, ctx.agentId, ctx.sessionId, (await getSession(ctx.sessionId))?.focus, {
      model: ctx.model,
      worker: ctx.worker,
      skills: ctx.skills,
      enableSubagents: ctx.enableSubagents,
      enableMemoryNominations: ctx.enableMemoryNominations,
      enableArtifacts: ctx.enableArtifacts,
      sandboxPolicy: ctx.sandboxPolicy,
    });
  }
  if (toolCall.name === "propose-plan") return adoptPlan(toolCall.args, ctx.agentId, ctx.sessionId, (await getSession(ctx.sessionId))?.focus);
  if (toolCall.name === "shell") {
    return ctx.worker.run(String(toolCall.args.command), { signal: ctx.signal });
  }
  if (toolCall.name === "read_file" || toolCall.name === "edit_file" || toolCall.name === "write_file") {
    return dispatchFileTool(toolCall.name, toolCall.args, ctx.sandboxPolicy);
  }
  if (toolCall.name === "skill") {
    if (!ctx.skills) return { ok: false, output: "", error: "no skill registry configured for this session" };
    const skillName = String(toolCall.args.name);
    const body = await ctx.skills.loadBody(skillName, { agentId: ctx.agentId, sessionId: ctx.sessionId });
    return body !== undefined
      ? { ok: true, output: body }
      : { ok: false, output: "", error: `no such skill: ${skillName}` };
  }
  if (toolCall.name === "subagent") {
    if (!ctx.enableSubagents) {
      return { ok: false, output: "", error: "subagent delegation is not enabled for this session" };
    }
    // Dynamic import avoids a circular top-level import: subagent.ts
    // itself imports runTurn from this file. Since this is only resolved
    // at call time (not module-init time), the cycle never actually
    // matters at runtime.
    const { spawnSubagentTask } = await import("./subagent.js");
    const goal = String(toolCall.args.goal ?? "");
    if (!goal) return { ok: false, output: "", error: "subagent tool call missing required 'goal' argument" };
    const result = await spawnSubagentTask({
      agentId: ctx.agentId,
      goal,
      focus: (await getSession(ctx.sessionId))?.focus,
      model: ctx.model,
      worker: ctx.worker,
      skills: ctx.skills,
      // Subagents don't recursively spawn further subagents by default —
      // see enableSubagents's own doc comment for why.
    });
    return { ok: true, output: result.finalContent };
  }
  if (toolCall.name === "nominate-memory") {
    if (!ctx.enableMemoryNominations) {
      return { ok: false, output: "", error: "memory nomination is not enabled for this session" };
    }
    const content = String(toolCall.args.content ?? "");
    const kind = String(toolCall.args.kind ?? "fact") as EpisodicKind;
    if (!content) return { ok: false, output: "", error: "nominate-memory tool call missing required 'content' argument" };
    // Dynamic import mirrors the subagent.js pattern above — avoids
    // pulling memory.js's full surface into this file's top-level
    // imports beyond what's already needed for retrieval.
    const { nominateAgentMemory } = await import("./memory.js");
    const nomination = await nominateAgentMemory({ agentId: ctx.agentId, content, kind, sourceSessionId: ctx.sessionId });
    return {
      ok: true,
      output: `Nomination ${nomination.id} recorded as PENDING — it has no effect on memory until a human explicitly approves it.`,
    };
  }
  if (toolCall.name === "record-artifact") {
    if (!ctx.enableArtifacts) {
      return { ok: false, output: "", error: "artifact recording is not enabled for this session" };
    }
    const type = String(toolCall.args.type ?? "other") as ArtifactType;
    const location = String(toolCall.args.location ?? "");
    if (!location) return { ok: false, output: "", error: "record-artifact tool call missing required 'location' argument" };
    const description = typeof toolCall.args.description === "string" ? toolCall.args.description : undefined;
    // Dynamic import mirrors the subagent.js/memory.js pattern above.
    const { createArtifact } = await import("./artifacts.js");
    const session = await getSession(ctx.sessionId);
    const artifact = await createArtifact({
      type,
      location,
      producer: ctx.agentId,
      sessionId: ctx.sessionId,
      taskId: session?.taskId,
      metadata: description ? { description } : {},
    });
    return { ok: true, output: `Artifact ${artifact.id} (${type}) recorded at "${location}".` };
  }
  if (toolCall.name === "recall-memory") {
    if (!hindsightConfigured()) return { ok: false, output: "", error: "long-term memory (Hindsight) is not configured on this gateway" };
    const query = String(toolCall.args.query ?? "");
    if (!query) return { ok: false, output: "", error: "recall-memory needs a 'query'" };
    if (toolCall.args.deep === true) {
      const text = await hindsightReflect(ctx.agentId, query);
      return text ? { ok: true, output: text } : { ok: false, output: "", error: "reflect returned nothing (Hindsight unreachable or empty bank)" };
    }
    const lines = await hindsightRecall(ctx.agentId, query);
    return { ok: true, output: lines.length ? lines.map((l) => `- ${l}`).join("\n") : "Nothing relevant remembered." };
  }
  if (toolCall.name === "delegate") {
    const str = (k: string) => (typeof toolCall.args[k] === "string" ? (toolCall.args[k] as string).trim() : "");
    try {
      const current = await workForSession(ctx.sessionId);
      const item = await createWork({
        title: str("title"),
        detail: str("detail") || undefined,
        assignee: str("to"),
        requestedBy: ctx.agentId,
        requestedFromSessionId: ctx.sessionId,
        parentId: current?.id,
        focus: (await getSession(ctx.sessionId))?.focus,
      });
      const watched = toolCall.args.verify === true ? await watchWork({ rootIds: [item.id], createdBy: ctx.agentId, originSessionId: ctx.sessionId }) : undefined;
      const control = await getAgentControlState(item.assignee);
      const waiting = control.blocked ? ` Note: ${item.assignee} is ${control.blocked === "paused" ? "paused" : "over budget"}, so it waits until that lifts.` : "";
      return { ok: true, output: `Handed "${item.title}" to ${item.assignee} as work item ${item.id}. It runs in the background; the result will be posted back in this conversation.${watched ? ` ${watched.verifier} verifies it when it's finished.` : ""}${waiting}` };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (toolCall.name === "work") {
    const action = String(toolCall.args.action ?? "list");
    const text = typeof toolCall.args.text === "string" ? toolCall.args.text : "";
    try {
      if (action === "list") {
        const active = (w: { status: string }) => w.status === "open" || w.status === "in_progress" || w.status === "blocked";
        const mine = (await listWork({ assignee: ctx.agentId })).filter(active);
        const asked = (await listWork({ requestedBy: ctx.agentId })).filter((w) => active(w) || w.status === "done").slice(0, 10);
        // A lead also sees what its reports are doing, whoever asked for it.
        const reports = (await listAgentIdentities()).filter((a) => a.reportsTo === ctx.agentId).map((a) => a.id);
        const team = (await listWork()).filter((w) => active(w) && reports.includes(w.assignee) && w.requestedBy !== ctx.agentId);
        const line = (w: WorkView) => `- ${w.id}: "${w.title}" — ${w.status}${w.assignee !== ctx.agentId ? ` (${w.assignee})` : ` (from ${w.requestedBy})`}${w.result ? ` → ${w.result.slice(0, 160)}` : ""}${w.blockedReason ? ` — ${w.blockedReason}` : ""}`;
        const teamText = reports.length ? `\n\nYour reports' other work:\n${team.map(line).join("\n") || "- nothing"}` : "";
        return { ok: true, output: `Assigned to you:\n${mine.map(line).join("\n") || "- nothing"}\n\nYou asked for:\n${asked.map(line).join("\n") || "- nothing"}${teamText}` };
      }
      let id = typeof toolCall.args.id === "string" && toolCall.args.id ? toolCall.args.id : (await workForSession(ctx.sessionId))?.id;
      // A verifier reopening/escalating "this item" means the item it's
      // checking, not its own verification (seen live: it passed its own id).
      const current = await workForSession(ctx.sessionId);
      if (current?.kind === "verification" && id === current.id && (action === "reopen" || action === "escalate")) {
        const checked = current.verifies ?? [];
        if (checked.length !== 1) return { ok: false, output: "", error: `pass the id of the item you're sending back — one of: ${checked.join(", ")}` };
        id = checked[0]!;
      }
      if (!id) return { ok: false, output: "", error: "which work item? pass id (see action list)" };
      const item =
        action === "done" ? await completeWork(id, ctx.agentId, text)
        : action === "blocked" ? await blockWork(id, ctx.agentId, text)
        : action === "hand-back" ? await handBackWork(id, ctx.agentId, text)
        : action === "note" ? await noteWork(id, ctx.agentId, text)
        : action === "cancel" ? await cancelWork(id, ctx.agentId, text)
        : action === "reopen" ? await reopenWork(id, ctx.agentId, text)
        : action === "escalate" ? await escalateWork(id, ctx.agentId, text)
        : action === "reassign" ? await reassignWork(id, ctx.agentId, String(toolCall.args.to ?? "").trim(), text)
        : undefined;
      if (!item) return { ok: false, output: "", error: `unknown action "${action}" — use list, done, blocked, hand-back, note, cancel, reopen, reassign or escalate` };
      return { ok: true, output: `Work ${item.id} is now ${item.status}${item.assignee !== ctx.agentId ? ` (with ${item.assignee})` : ""}.` };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (toolCall.name === "basespace") {
    const section = String(toolCall.args.section ?? "summary");
    const query = typeof toolCall.args.query === "string" ? toolCall.args.query : undefined;
    const id = typeof toolCall.args.id === "string" ? toolCall.args.id : undefined;
    return readSnapshotSection(section, { query, id });
  }
  if (toolCall.name === "desktop") return { ok: true, output: await renderDesktopReport(typeof toolCall.args.day === "string" ? toolCall.args.day : undefined) };
  if (toolCall.name === "library") return dispatchLibrary(toolCall.args, ctx.agentId, ctx.sandboxPolicy);
  if (toolCall.name === "soundlab") return dispatchSoundlab(toolCall.args);
  if (toolCall.name === "audio") return dispatchAudio(toolCall.args, ctx.sandboxPolicy);
  if (toolCall.name === "basespace-add") {
    const kind = String(toolCall.args.kind ?? "") as OverlayKind;
    // Linked back to whatever this session's work serves (its focus).
    return addOverlayItem(kind, toolCall.args, ctx.agentId, (await getSession(ctx.sessionId))?.focus);
  }
  return { ok: false, output: "", error: `unknown tool: ${toolCall.name}` };
}

const FILE_TOOLS = new Set(["read_file", "edit_file", "write_file"]);
/** `work` actions that settle the item: once one succeeds the agent has
 *  nothing left to say, so the turn ends there instead of spending another
 *  full model call on "Done!". */
const SETTLING_WORK_ACTIONS = new Set(["done", "blocked", "hand-back"]);

/** User messages the harness itself wrote: the work runner's briefs, a lead's
 *  review digest, an approval decision, a team cron's standup prompt. What
 *  comes out of them already lives somewhere durable (work items, BaseSpace
 *  notes, approvals), and filing them as long-term memory records the
 *  harness's own bookkeeping as things "the user" said ("User assigned a work
 *  item…", seen live in Hindsight). */
const HARNESS_MESSAGE = /^\s*(\[(Work|Review|Approvals|Flow)\]|It's time for ")/;

/** Is this finished turn worth sending to Hindsight (each one costs an LLM
 *  extraction)? Only a real answer to something the operator wrote — not a
 *  blocked, out-of-steps or cancelled turn, and not the harness talking. */
function worthRetaining(userMessage: string, stopReason: AgentTurnResult["stopReason"]): boolean {
  return stopReason === "answered" && !HARNESS_MESSAGE.test(userMessage);
}

/** The tools this agent can actually use this turn: the ones the turn has
 *  switched on, minus the ones the gateway hides from this agent
 *  (tool-registry.ts's setToolVisibility). Everything offered is described
 *  in every model call, so offering a tool that can only fail is paid for
 *  on each hop. Hiding isn't the enforcement — dispatch and the tool.before
 *  hooks still refuse a hidden tool if it's called anyway. */
function offeredTools(
  agentId: string,
  on: { skills?: SkillRegistry; enableSubagents?: boolean; enableMemoryNominations?: boolean; enableArtifacts?: boolean; enableBaseSpace?: boolean; isLead?: boolean; recallFoundNothing?: boolean },
): ToolSpec[] {
  const enabled: Record<string, boolean | undefined> = {
    skill: !!on.skills && on.skills.listMetadata().length > 0,
    subagent: on.enableSubagents,
    "nominate-memory": on.enableMemoryNominations,
    "record-artifact": on.enableArtifacts,
    // What memory has on this message is already injected into the turn's
    // system prompt, so the tool would just repeat that search — and a small
    // local model handed it loops on it (seen live: 4 identical calls, then
    // out of steps, with the answer in every result). It's the fallback for
    // when that automatic recall found nothing: a chance to search differently.
    "recall-memory": hindsightConfigured() && on.recallFoundNothing,
    basespace: on.enableBaseSpace,
    "basespace-add": on.enableBaseSpace,
    library: on.enableBaseSpace,
    soundlab: on.enableBaseSpace,
    desktop: on.enableBaseSpace,
    delegate: on.enableBaseSpace,
    work: on.enableBaseSpace,
    // Growing the team and planning a goal are a lead's job (and always
    // go to the operator first — governance.ts).
    "propose-agent": on.enableBaseSpace && on.isLead,
    "propose-plan": on.enableBaseSpace && on.isLead,
    "propose-flow": on.enableBaseSpace && on.isLead,
  };
  return listToolDefinitions()
    .filter((d) => !(d.name in enabled) || !!enabled[d.name])
    .filter((d) => toolVisibleTo(agentId, d.name))
    .map(toToolSpec);
}

export async function runTurn(opts: RunTurnOptions): Promise<AgentTurnResult> {
  const { sessionId, agentId, userMessage, model, worker, skills, enableSubagents, enableMemoryNominations, enableArtifacts, enableBaseSpace, sandboxPolicy, planMode } = opts;
  const injectMemory = opts.injectMemory ?? true;
  const maxHops = opts.maxToolHops ?? 3;

  // Registers (or touches) this sessionId in the Session registry
  // (session.ts) — see ensureSession()'s doc comment: existing callers
  // that never pre-created a Session keep working unchanged, and now get
  // a real, listable/cancellable registry entry for free.
  await ensureSession(sessionId, agentId);

  // Board controls (controls.ts): a paused or over-budget agent takes no new
  // turns, whichever path the turn came from. Recorded in the session so the
  // conversation shows why instead of the message vanishing.
  try {
    await assertAgentMayRun(agentId);
  } catch (err) {
    if (err instanceof AgentBlockedError) {
      await appendEvent(sessionStream(sessionId), "session.message", { role: "user", content: userMessage });
      await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: err.message, blocked: err.blocked });
    }
    throw err;
  }

  await appendEvent(sessionStream(sessionId), "agent.turn.start", { agentId, userMessage });
  await fireHook("agent.turn.start", { agentId, sessionId, payload: { userMessage } });
  // Published on the real event bus (eventbus.ts), NOT a second/parallel
  // event system — this is what lets an external transport (the gateway,
  // still to be built) expose live runtime activity by subscribing to
  // the SAME event types already recorded in the session stream above,
  // rather than polling the filesystem for changes.
  await publishEvent("agent.turn.start", { sessionId, agentId, userMessage });

  await appendEvent(sessionStream(sessionId), "session.message", { role: "user", content: userMessage });

  let toolCalled: string | undefined;
  let hops = 0;
  let finalContent = "";
  let cancelled = false;
  // Tool executions so far in this run (a call that was skipped, blocked or refused doesn't count).
  let toolExecutions = 0;
  const executionCap = opts.maxToolExecutions && opts.maxToolExecutions > 0 ? Math.floor(opts.maxToolExecutions) : maxToolExecutionsPerRun();
  // Fired by cancelSession(): stops the in-flight model request and shell command now.
  const turnAbort = beginTurnAbort(sessionId);
  // Summed across every hop in this turn — a tool-calling turn makes
  // several model calls, and the cost/usage that matters is the whole
  // turn's total, not just the last hop's. Only ever reflects what the
  // provider actually reported (see ModelResponse.usage's own doc
  // comment) — stays {0,0} and is omitted from agent.turn.end entirely
  // when nothing ever reported usage (the stub model, or a provider that
  // doesn't report it), rather than claiming a fabricated zero.
  let stopReason: AgentTurnResult["stopReason"] = "answered";
  let usageInputTokens = 0;
  let usageOutputTokens = 0;
  let usageCachedTokens = 0;
  let sawUsage = false;

  // Fetched once per turn, outside the hop loop — see renderIdentityContext's
  // own doc comment for why (unlike memory/skills, identity isn't expected
  // to change mid-turn).
  const personaText = await renderIdentityContext(agentId);
  // Hindsight recall, also once per turn: the query is the user's message,
  // which doesn't change between hops. Recalling inside the hop loop used
  // to repeat the same HTTP call (up to 4s each) on every tool step.
  const recalled = injectMemory ? await hindsightRecall(agentId, userMessage) : [];
  // What this session's work serves (a BaseSpace goal or project, if the
  // session is focused on one): the chain up to the top goal, linked notes
  // and open todos. Once per turn — it's the same for every hop.
  const focusText = await focusContext((await getSession(sessionId))?.focus);
  // Reporting lines and open work (work.ts) — only for agents on the
  // operator's team (the same flag that turns on BaseSpace).
  const orgText = enableBaseSpace ? await orgContext(agentId) : "";
  const isLead = enableBaseSpace ? (await listAgentIdentities()).some((a) => a.reportsTo === agentId) : false;
  const tools = offeredTools(agentId, { skills, enableSubagents, enableMemoryNominations, enableArtifacts, enableBaseSpace, isLead, recallFoundNothing: recalled.length === 0 }).filter(
    (t) => !opts.onlyTools || opts.onlyTools.includes(t.name),
  );
  const offered = new Set(tools.map((t) => t.name));

  // Checked once per turn, BEFORE the hop loop builds its first set of
  // messages — so if this turn is the one that pushes history over
  // threshold, the compaction already applies to THIS turn's own model
  // calls via getModelFacingHistory() below, not just the next one.
  await maybeCompactSession(sessionId, model);

  // A model/provider error (rate limit, network blip, bad key, ...)
  // thrown anywhere in the hop loop below used to just propagate
  // straight out of runTurn(), skipping every event after it — the
  // gateway's turns route still reported the failure over HTTP, but
  // nothing durable ever recorded it, so a client that re-fetches
  // session history right after (as BaseOS's chat does) saw no trace it
  // ever happened: the turn silently vanished instead of explaining
  // itself. Caught here and durably recorded as a real session.message
  // before rethrowing — every existing caller's throw-on-failure
  // behavior (flow-engine.ts's retry logic, the gateway's error
  // response, any test asserting rejection) is unchanged; this only adds
  // a durable trail alongside it.
  try {
  turnLoop: while (hops < maxHops) {
    // Checked at the top of every hop (and again right after tool
    // dispatch below) rather than once before the loop — cancelSession()
    // (session.ts) can be called from a completely different process at
    // any point mid-turn, and this is what makes "cancel a session"
    // actually stop new model calls/tool executions instead of merely
    // being ignored until the turn would have finished anyway.
    if (await isSessionCancelled(sessionId)) {
      cancelled = true;
      break;
    }
    const history = await getModelFacingHistory(sessionId);
    const planModeText = planMode
      ? "PLAN MODE IS ACTIVE: you can inspect (read_file, shell commands that only read/list, skill) but calling shell/edit_file/write_file/subagent " +
        "will be blocked outright by the harness regardless of anything else — this is not a suggestion you can reason your way around. Investigate, " +
        "then describe the concrete plan (what you'd read/change/run and why) for the operator to review; they'll turn plan mode off to actually execute it."
      : "";
    const catalogText = skills && offered.has("skill") ? renderSkillCatalog(skills.listMetadata()) : "";
    const subagentText = enableSubagents && offered.has("subagent")
      ? "You can delegate a focused sub-task to an isolated subagent by calling the `subagent` tool with {goal}. The subagent runs independently and only its final result returns to you — its own reasoning and tool calls stay isolated."
      : "";
    const nominationText = enableMemoryNominations && offered.has("nominate-memory")
      ? "You can propose something worth remembering long-term by calling the `nominate-memory` tool with {content, kind}. This does NOT write to memory directly — it creates a pending nomination that a human must explicitly approve before it can ever influence curated memory."
      : "";
    const artifactText = enableArtifacts && offered.has("record-artifact")
      ? "When you produce a real output worth attaching to this task (a file you wrote, a report, a plan), call the `record-artifact` tool with {type, location, description?} to register it. This does not create the content itself — produce it first (e.g. via the shell tool), then record where it lives."
      : "";
    const baseSpaceText = !enableBaseSpace
      ? ""
      : "The operator runs a dashboard called BaseSpace (notes, projects, todos, calendar, cron jobs, teams). Read it with the `basespace` tool " +
      "(start with section \"summary\") before answering questions about their work, and use `basespace-add` to leave a note, a todo or a " +
      "project update there — that's how your work shows up for them. Only add things they'd want to see." +
      (offered.has("recall-memory") ? " Nothing relevant was recalled automatically; use `recall-memory` to search what you've learned in earlier conversations." : "");
    const fileToolsText = ![...FILE_TOOLS].some((t) => offered.has(t))
      ? ""
      : "Prefer `read_file`/`edit_file`/`write_file` over shell redirection or `sed` for reading or changing a file's content — " +
      "`edit_file` takes {path, old_string, new_string} and fails with no write made if old_string isn't found or isn't unique in the file " +
      "(pass replace_all:true to replace every occurrence instead), rather than silently touching the wrong spot." +
      (sandboxPolicy
        ? " These are confined to the same sandboxed workspace as the shell tool, and a mutating call (edit_file/write_file) still requires approval the same way a mutating shell command does."
        : "");
    // Re-read fresh every turn (not cached) — see injectMemory's own doc
    // comment for why. Only ever populated by the dreaming pass
    // (memory.ts), never by this turn's own conversation, so a chatty
    // session cannot inject its own unvetted "memory" into itself.
    const memoryText = injectMemory ? await renderMemoryContext(agentId, userMessage, recalled) : "";
    // personaText first — "who you are" precedes "what you remember/can do"
    // in the assembled system message, matching how a human-written system
    // prompt would order identity before capability context.
    // Stable parts first, the ones that change from turn to turn (focus, recalled memory) last: the provider caches a prompt by its
    // prefix, so this keeps the long unchanging part reusable.
    const systemParts = [personaText, orgText, catalogText, subagentText, nominationText, artifactText, baseSpaceText, fileToolsText, planModeText, focusText, memoryText].filter(
      Boolean,
    );
    const messages: ModelMessage[] = systemParts.length
      ? [{ role: "system", content: systemParts.join("\n\n") }, ...history]
      : history;
    // Prefer real incremental streaming when this model adapter supports
    // it (model.ts's ModelAdapter.completeStream) — publishes each chunk
    // on the real event bus AS IT ARRIVES, not just the final assembled
    // text once the whole call finishes. A model without completeStream
    // behaves exactly as before this existed (plain model.complete()).
    // Deltas are deliberately NOT appended to the durable session stream
    // — they're ephemeral live-progress signal; the one final assembled
    // "session.message" event below remains the durable record, same as
    // always, so the event log doesn't balloon with one entry per token.
    // Cancelling aborts this call for real (adapters cancel their fetch / child process via
    // `signal`), and raceAbort() makes sure the turn stops waiting even for an adapter that ignores it.
    let response: Awaited<ReturnType<ModelAdapter["complete"]>>;
    try {
      response = await raceAbort(
        model.completeStream
          ? model.completeStream(
              messages,
              (delta) => {
                publishEvent("agent.turn.delta", { sessionId, agentId, delta }).catch((err) => {
                  console.error("[agent-loop] failed to publish turn delta:", err instanceof Error ? err.message : err);
                });
              },
              { tools, signal: turnAbort.signal },
            )
          : model.complete(messages, { tools, signal: turnAbort.signal }),
        turnAbort.signal,
      );
    } catch (err) {
      if (turnAbort.signal.aborted) {
        cancelled = true;
        break;
      }
      throw err;
    }

    if (response.usage) {
      sawUsage = true;
      usageInputTokens += response.usage.inputTokens;
      usageOutputTokens += response.usage.outputTokens;
      usageCachedTokens += response.usage.cachedInputTokens ?? 0;
    }

    const calls = toolCallsOf(response);
    if (calls.length) {
      // Several calls in one reply (the model asked for independent things at once) run strictly in order. Each goes through
      // exactly the same checks as a lone call; anything that stops one (a failure, an approval, a plan-mode block, a
      // cancel) stops the ones after it, which are recorded as skipped so the model knows they didn't run.
      let skipReason: string | undefined;
      for (let ci = 0; ci < calls.length; ci++) {
        const call = calls[ci]!;
        toolCalled = call.name;
        const callLabel = `${call.name} ${JSON.stringify(call.args ?? {})}`.slice(0, 300);
        if (skipReason) {
          await appendEvent(sessionStream(sessionId), "session.message", { role: "tool", content: `skipped: ${skipReason}`, call: callLabel });
          continue;
        }
        if (toolExecutions >= executionCap) {
          // The run's budget is spent: this call and the rest of the reply are not run, and the turn ends saying so.
          for (const rest of calls.slice(ci)) {
            await appendEvent(sessionStream(sessionId), "session.message", { role: "tool", content: `skipped: this run reached its limit of ${executionCap} tool executions`, call: `${rest.name} ${JSON.stringify(rest.args ?? {})}`.slice(0, 300) });
          }
          stopReason = "max-hops";
          finalContent = `I reached this run's limit of ${executionCap} tool executions before finishing. What I did so far is in the results above; say "continue" and I'll pick up from there.`;
          await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: finalContent });
          break turnLoop;
        }

        // Plan mode is a HARD harness-level override, not a prompt
        // suggestion — checked before Layer A's own PermissionPolicy, and
        // not overridable by it (an "allow" rule for e.g. read_file still
        // has no bearing here). This is what ROADMAP.md's "plan / read-only
        // mode" item actually asked for: a mode the model is IN, not one
        // it's merely told about. subagent is blocked too — a delegated
        // subagent can itself mutate files, so plan mode has to cover it
        // too to mean anything.
        if (planMode && (PLAN_MODE_BLOCKED_TOOLS.has(call.name) || changesLibraryOrAudio(call))) {
          stopReason = "tool-blocked";
          finalContent = `Tool call blocked: plan mode is active — "${call.name}" would change something, and plan mode only allows read-only inspection. Describe what you'd do instead; the operator can turn plan mode off to actually execute it.`;
          await appendEvent(sessionStream(sessionId), "session.message", {
            role: "assistant",
            content: finalContent,
          });
          break turnLoop;
        }

        // Governance gates (governance.ts): hiring and goal plans never run
        // from a turn — they're filed for the operator's approval, whatever
        // any hook or allow rule would say.
        // A proposal with something wrong with it isn't filed: it falls
        // through to dispatch, which hands the problem back to the agent.
        const gated = GATED_TOOLS.has(call.name);
        const proposalProblem = gated ? await checkProposal(call.name, call.args ?? {}, agentId, (await getSession(sessionId))?.focus) : undefined;
        const blockDecision = gated
          ? proposalProblem
            ? { block: false as const }
            : { block: true, reason: await gateToolCall({ agentId, sessionId, toolName: call.name, args: call.args ?? {}, sessionFocus: (await getSession(sessionId))?.focus }) }
          : await fireHook("tool.before", {
              agentId,
              sessionId,
              payload: call,
            });
        if (blockDecision.block) {
          stopReason = "tool-blocked";
          finalContent = `Tool call blocked: ${blockDecision.reason ?? "no reason given"}`;
          await appendEvent(sessionStream(sessionId), "session.message", {
            role: "assistant",
            content: finalContent,
          });
          break turnLoop;
        }

        // Text the model wrote alongside the tool call ("Let me check your
        // todos…") is part of its answer — keep it, or it streams in live
        // and then vanishes when the client re-reads the history.
        if (ci === 0 && response.content?.trim()) {
          await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: response.content });
        }
        await appendEvent(sessionStream(sessionId), "tool.call.start", call);
        await publishEvent("tool.call.start", { sessionId, agentId, ...call });
        // A registered ToolDefinition's timeoutMs (tool-registry.ts) is
        // enforced HERE, at the one call site every tool call passes
        // through — not inside dispatchTool()'s individual branches — so
        // it applies uniformly regardless of which tool ran. Every
        // built-in tool ships with no timeoutMs by default (see
        // BUILTIN_TOOL_DEFINITIONS), so withTimeout() is a true no-op for
        // existing behavior unless a caller explicitly registers one.
        const toolDef = getToolDefinition(call.name);
        const result = await withTimeout(
          dispatchTool(call, {
            worker,
            skills,
            agentId,
            sessionId,
            model,
            signal: turnAbort.signal,
            enableSubagents,
            enableMemoryNominations,
            enableArtifacts,
            sandboxPolicy,
          }),
          toolDef?.timeoutMs,
          () => ({
            ok: false,
            output: "",
            error: `tool "${call.name}" timed out after ${toolDef?.timeoutMs}ms`,
          }),
        );
        toolExecutions++;
        await appendEvent(sessionStream(sessionId), "tool.call.end", { ...call, result });
        await publishEvent("tool.call.end", { sessionId, agentId, ...call, result });
        await fireHook("tool.after", { agentId, sessionId, payload: { ...call, result } });

        // Record which call produced the result: the history keeps no other
        // record of the model's own tool call, and a model reading back a
        // bare result can't tell what it asked for (see getModelFacingHistory).
        await appendEvent(sessionStream(sessionId), "session.message", {
          role: "tool",
          content: result.ok ? result.output : `error: ${result.error}`,
          call: callLabel,
        });
        // Settling a work item (done / blocked / hand-back) is the last thing
        // the agent has to do — end here, with the result as the reply,
        // rather than one more model call to say so.
        if (call.name === "work" && result.ok && SETTLING_WORK_ACTIONS.has(String(call.args?.action ?? ""))) {
          const text = typeof call.args?.text === "string" ? call.args.text.trim() : "";
          finalContent = text || response.content?.trim() || result.output;
          await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: finalContent });
          break turnLoop;
        }
        // Re-checked immediately after the tool actually ran (not just at
        // the top of the next hop) so a cancellation that arrives WHILE a
        // tool call is in flight is honored before the next model call is
        // made, rather than one full extra hop later.
        if (await isSessionCancelled(sessionId)) {
          cancelled = true;
          break turnLoop;
        }
        if (!result.ok) skipReason = "an earlier call in this reply failed, so it wasn't run (look at that error first)";
      }
      // Anything beyond the cap wasn't run either: say so, so the model asks again instead of assuming.
      const requested = (response.toolCalls?.length ?? 0);
      if (requested > calls.length) {
        await appendEvent(sessionStream(sessionId), "session.message", { role: "tool", content: `skipped: only the first ${MAX_CALLS_PER_REPLY} calls of a reply are run; ask for the rest in your next reply`, call: "(extra calls)" });
      }
      // One reply is one tool step, however many calls it carried.
      hops++;
      continue;
    }

    // A small local model that just got a tool result back sometimes ends
    // its turn with a genuinely empty completion — no further tool call,
    // no text either (seen with qwen2.5:3b after a `basespace` call). Left
    // as "" this reads as the reply silently vanishing, same failure shape
    // the maxHops fallback below already guards against.
    finalContent =
      response.content ||
      (toolCalled
        ? `Got the ${toolCalled} result but didn't produce a reply — try asking again or rephrasing.`
        : "No reply came back for that message — try again or rephrase.");
    await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: finalContent });
    break;
  }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finalContent = `⚠ ${message}`;
    const usage = sawUsage ? { inputTokens: usageInputTokens, outputTokens: usageOutputTokens, ...(usageCachedTokens ? { cachedInputTokens: usageCachedTokens } : {}) } : undefined;
    if (usage) await recordAgentUsage(agentId, usage, sessionId);
    await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: finalContent, error: true });
    await appendEvent(sessionStream(sessionId), "agent.turn.end", { agentId, finalContent, toolCalled, cancelled, error: message, usage });
    await fireHook("agent.turn.end", { agentId, sessionId, payload: { finalContent, toolCalled, cancelled, error: message, usage } });
    await publishEvent("agent.turn.end", { sessionId, agentId, finalContent, toolCalled, cancelled, error: message, usage });
    throw err;
  } finally {
    endTurnAbort(sessionId, turnAbort);
  }

  // Used up every tool step without a final answer — say so instead of
  // ending the turn with nothing (which reads as the reply vanishing).
  if (!cancelled && !finalContent && hops >= maxHops) {
    stopReason = "max-hops";
    finalContent =
      `I used all ${maxHops} tool steps I get per message before finishing` +
      (toolCalled ? ` (last one: ${toolCalled})` : "") +
      `. Say "continue" and I'll pick up from here.`;
    await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: finalContent, truncated: true });
  }

  if (cancelled) {
    finalContent = finalContent || "Turn cancelled before completion.";
    await appendEvent(sessionStream(sessionId), "session.message", {
      role: "assistant",
      content: finalContent,
      cancelled: true,
    });
  }

  const usage = sawUsage ? { inputTokens: usageInputTokens, outputTokens: usageOutputTokens, ...(usageCachedTokens ? { cachedInputTokens: usageCachedTokens } : {}) } : undefined;
  // Counts toward the agent's budget (controls.ts) — including a cancelled
  // turn's tokens, since those were spent too.
  if (usage) {
    await recordAgentUsage(agentId, usage, sessionId);
    // Tokens spent in a work session count on that work item (and roll up
    // to whoever asked for it — work.ts's totalTokens).
    const working = await workForSession(sessionId, { anyStatus: true });
    if (working) await recordWorkUsage(working.id, usage.inputTokens + usage.outputTokens);
  }
  if (!cancelled && finalContent && worthRetaining(userMessage, stopReason)) {
    // A real exchange goes to Hindsight (when configured) so it can extract
    // facts/experiences from it; no-op otherwise.
    void hindsightRetain(agentId, `User: ${userMessage}\n\n${agentId}: ${finalContent}`, { context: "conversation turn", tags: ["turn"] });
  }
  await appendEvent(sessionStream(sessionId), "agent.turn.end", { agentId, finalContent, toolCalled, cancelled, usage });
  await fireHook("agent.turn.end", { agentId, sessionId, payload: { finalContent, toolCalled, cancelled, usage } });
  await publishEvent("agent.turn.end", { sessionId, agentId, finalContent, toolCalled, cancelled, usage });

  if (cancelled) stopReason = "cancelled";
  return { sessionId, finalContent, toolCalled, cancelled: cancelled || undefined, usage, stopReason };
}

/** Runs a tool call the operator approved in the Approvals tab, in the
 *  session that asked for it, and records it exactly like a call the model
 *  made inside a turn (tool.call.start/end events + a tool message). The
 *  approval IS the permission, so this skips the `tool.before` hooks —
 *  but everything else still applies: the Worker is the sandboxed one and
 *  file tools go through the same sandbox checks.
 *
 *  Why not just tell the model "approved, run it again"? Smaller models
 *  often don't re-issue the identical call, so the approval went nowhere. */
export async function executeApprovedCall(opts: {
  sessionId: string;
  agentId: string;
  toolCall: { name: string; args: Record<string, unknown> };
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
  enableSubagents?: boolean;
  enableMemoryNominations?: boolean;
  enableArtifacts?: boolean;
  sandboxPolicy?: SandboxPolicy;
}): Promise<ToolDispatchResult> {
  const { sessionId, agentId, toolCall } = opts;
  await appendEvent(sessionStream(sessionId), "tool.call.start", { ...toolCall, approved: true });
  await publishEvent("tool.call.start", { sessionId, agentId, ...toolCall });
  const toolDef = getToolDefinition(toolCall.name);
  const result = await withTimeout(
    dispatchTool(toolCall, {
      worker: opts.worker,
      skills: opts.skills,
      agentId,
      sessionId,
      model: opts.model,
      enableSubagents: opts.enableSubagents,
      enableMemoryNominations: opts.enableMemoryNominations,
      enableArtifacts: opts.enableArtifacts,
      sandboxPolicy: opts.sandboxPolicy,
      approved: true,
    }),
    toolDef?.timeoutMs,
    () => ({ ok: false, output: "", error: `tool "${toolCall.name}" timed out after ${toolDef?.timeoutMs}ms` }),
  );
  await appendEvent(sessionStream(sessionId), "tool.call.end", { ...toolCall, result, approved: true });
  await publishEvent("tool.call.end", { sessionId, agentId, ...toolCall, result });
  await fireHook("tool.after", { agentId, sessionId, payload: { ...toolCall, result } });
  await appendEvent(sessionStream(sessionId), "session.message", {
    role: "tool",
    content: result.ok ? result.output : `error: ${result.error}`,
    call: `${toolCall.name} ${JSON.stringify(toolCall.args ?? {})}`.slice(0, 300),
  });
  return result;
}

export function newSessionId(): string {
  return generateId();
}
