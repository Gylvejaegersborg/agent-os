import type { ToolSpec } from "./model.js";

// Tool registry — declarative metadata ABOUT the tools dispatchTool()
// (agent-loop.ts) already executes through, kept deliberately separate
// from execution itself. Before this file, "shell"/"skill"/"subagent"/
// "nominate-memory" existed only as string literals matched inside
// dispatchTool()'s if-chain: nothing in the codebase could answer "what
// tools exist," "what arguments does this one take," or "how long should
// this be allowed to run" without reading that function's source. This is
// that missing catalog — the same "one central harness path, formalized
// with metadata" idea the architecture doc's tool-system section
// describes — plus a small, genuinely enforced piece of behavior: a
// registered timeoutMs is applied uniformly at the dispatchTool() call
// site in runTurn(), regardless of which tool ran or how it's implemented
// internally.
//
// Deliberately NOT a plugin system: dispatchTool() is still the one place
// that actually executes a tool call. Registering a ToolDefinition here
// does not make dispatchTool() automatically support a new tool name —
// it only makes an EXISTING tool introspectable and gives it enforceable
// metadata (timeout today; permission/schema hints a gateway can surface
// tomorrow). Wiring an actually-new tool still means adding a branch to
// dispatchTool() itself, same as before this file existed.

export interface ToolInputSchemaProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  /** For type "array": the JSON Schema of one element. */
  items?: Record<string, unknown>;
}

/** Tools that always need the operator's approval and can never be
 *  always-allowed (governance.ts): growing the team and planning a goal. */
export const GATED_TOOL_NAMES = ["propose-agent", "propose-plan", "propose-flow"];

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, ToolInputSchemaProperty>;
  /** Maximum time (ms) this tool call is allowed to run before
   *  dispatchTool()'s call site (runTurn(), agent-loop.ts) preempts it
   *  with a timeout error result. Omit for "no timeout enforced" — the
   *  historical/default behavior for every built-in tool below, so
   *  registering a tool (or leaving the built-ins as-is) never changes
   *  existing behavior unless a caller explicitly opts a tool into a
   *  timeout via registerTool(). */
  timeoutMs?: number;
  /** Metadata hint only — NOT itself an enforcement mechanism. The real
   *  permission decision for a tool call is Layer A's PermissionPolicy
   *  (permissions.ts), evaluated independently of whatever this field
   *  says. This exists so a future gateway's tool catalog can flag
   *  "this one is typically dangerous" without duplicating policy logic
   *  here. */
  requiresApproval?: boolean;
}

const registry = new Map<string, ToolDefinition>();

/** A definition as the JSON-Schema spec the provider APIs take. */
export function toToolSpec(d: ToolDefinition): ToolSpec {
  return {
    name: d.name,
    description: d.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(d.inputSchema).map(([k, v]) => [
          k,
          { type: v.type, ...(v.description ? { description: v.description } : {}), ...(v.items ? { items: v.items } : {}) },
        ]),
      ),
      required: Object.entries(d.inputSchema)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  };
}

/** Which tools an agent is shown at all (the gateway sets this — e.g. file
 *  and shell tools only for the builder agent). Showing an agent a tool it
 *  will only be refused costs tokens on every call and invites the call;
 *  hiding it is not the enforcement — the tool.before hooks and the
 *  permission policy still are, for any call that arrives anyway. */
export type ToolVisibility = (agentId: string, toolName: string) => boolean;
let visibility: ToolVisibility | undefined;

export function setToolVisibility(fn: ToolVisibility | undefined): void {
  visibility = fn;
}

export function toolVisibleTo(agentId: string, toolName: string): boolean {
  return !visibility || visibility(agentId, toolName);
}

export function registerTool(definition: ToolDefinition): void {
  registry.set(definition.name, definition);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listToolDefinitions(): ToolDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test/ops hook, mirroring clearHooks()/clearEventBusSubscribers() —
 *  resets to the built-in defaults registered below, not to empty, so a
 *  test that clears the registry doesn't also have to re-seed the
 *  built-ins it didn't mean to remove. */
export function resetToolRegistry(): void {
  registry.clear();
  for (const def of BUILTIN_TOOL_DEFINITIONS) registerTool(def);
  if (process.env.HINDSIGHT_URL) registerTool(RECALL_MEMORY_TOOL);
}

export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "shell",
    description: "Runs a shell command through the session's configured Worker.",
    inputSchema: { command: { type: "string", required: true, description: "The shell command to execute." } },
  },
  {
    name: "skill",
    description: "Loads the full body of a named skill (agentskills.io-format, layer-2 progressive disclosure).",
    inputSchema: { name: { type: "string", required: true, description: "The skill's name, as listed in the catalog." } },
  },
  {
    name: "subagent",
    description: "Delegates a focused sub-task to a fresh, isolated agent-loop session.",
    inputSchema: { goal: { type: "string", required: true, description: "The goal for the subagent to accomplish." } },
  },
  {
    name: "nominate-memory",
    description: "Proposes something worth remembering long-term; requires explicit human approval before it affects curated memory.",
    inputSchema: {
      content: { type: "string", required: true, description: "The content being nominated for memory." },
      kind: { type: "string", description: "One of the EpisodicKind values (fact, preference, correction, outcome, skill-candidate)." },
    },
  },
  {
    name: "record-artifact",
    description: "Attaches a produced output (a file, report, plan, ...) to the current Task/Session — does not create the content itself.",
    inputSchema: {
      type: { type: "string", required: true, description: "One of the ArtifactType values (code, file, report, image, dataset, plan, draft, other)." },
      location: { type: "string", required: true, description: "Where the content lives (a path, a URL)." },
      description: { type: "string", description: "Optional human-readable description of the artifact." },
    },
  },
  {
    name: "delegate",
    description:
      "Hand a piece of work to a teammate as a tracked work item (not a chat message): they run it in the background and the result is posted back " +
      "in this conversation. It keeps this conversation's goal/project. Hand-offs are capped at a few levels deep.",
    inputSchema: {
      to: { type: "string", required: true, description: "The teammate's agent id (see 'Your team' in your instructions)." },
      title: { type: "string", required: true, description: "What to do, as a short imperative (e.g. 'Draft three caption options for the Switch teaser')." },
      detail: { type: "string", description: "Context they need: constraints, what done looks like, where to look." },
      verify: { type: "boolean", description: "When it's finished, have the verifier check the result against what actually happened." },
    },
  },
  {
    name: "work",
    description:
      "Your work items. action: list | done {text: the result} | blocked {text: why} | hand-back {text: why; goes to your manager} | note {id, text}. " +
      "id defaults to the item this conversation is working. You can't cancel work handed to you. " +
      "For work you asked for or your reports are doing: reopen {id, text: guidance} | reassign {id, to, text} | escalate {id, text: what the operator must decide} | cancel {id, text}.",
    inputSchema: {
      action: { type: "string", required: true, description: "list, done, blocked, hand-back, note, reopen, reassign, escalate or cancel." },
      id: { type: "string", description: "Work item id." },
      to: { type: "string", description: "reassign: the teammate's agent id." },
      text: { type: "string", description: "The result, reason, guidance or note." },
    },
  },
  {
    name: "propose-agent",
    description:
      "Propose hiring a new agent onto the team — for recurring work no teammate fits. Always goes to the operator's Approvals; nothing is " +
      "created unless they approve. Say plainly why the team needs it.",
    inputSchema: {
      id: { type: "string", required: true, description: "Short lowercase id, e.g. 'lyra' or 'sync-scout'." },
      name: { type: "string", required: true, description: "Display name." },
      role: { type: "string", required: true, description: "e.g. 'Sync licensing · Outreach'." },
      persona: { type: "string", required: true, description: "A few sentences: who it is, what it does, what it must never do." },
      reportsTo: { type: "string", description: "Its manager's agent id (defaults to you)." },
      model: { type: "string", description: "Optional model, e.g. 'claude-cli:haiku'. Defaults to the gateway's." },
      why: { type: "string", required: true, description: "What work it takes on and why no current teammate fits." },
    },
  },
  {
    name: "propose-flow",
    description:
      "Design a flow: a small graph of steps, each for one agent, with dependencies, to get a bigger piece of work done faster than handing items out one by one. " +
      "Independent steps run in parallel, dependent ones wait and are shown what the steps they depend on produced. Argus checks it first (unknown agents, circular " +
      "dependencies, vague steps, paused agents) and tells you what to fix; then it always goes to the operator's Approvals. Once approved it runs in the background " +
      "and the outcome is posted back here. Use `propose-plan` for independent items with no dependencies, `delegate` for a single hand-off.",
    inputSchema: {
      summary: { type: "string", required: true, description: "The flow in one or two sentences: the approach and why it is shaped this way." },
      goalId: { type: "string", description: "The goal it serves (defaults to this conversation's goal)." },
      steps: {
        type: "array",
        required: true,
        description: "Up to 10 steps: {id, agent, goal, dependsOn?, retries?}. id is a short lowercase name; goal says what the step should produce; dependsOn lists step ids that must finish first.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            agent: { type: "string" },
            goal: { type: "string" },
            dependsOn: { type: "array", items: { type: "string" } },
            retries: { type: "number" },
          },
        },
      },
    },
  },
  {
    name: "propose-plan",
    description:
      "Propose a plan for a goal: several work items for teammates. Always goes to the operator's Approvals first; once approved the items " +
      "are created and run, and results come back here. For a single hand-off use `delegate`.",
    inputSchema: {
      goalId: { type: "string", description: "The goal it serves (defaults to this conversation's goal)." },
      summary: { type: "string", required: true, description: "The plan in one or two sentences: the approach and why." },
      verify: { type: "boolean", description: "When every step has finished, have the verifier check the results against what actually happened." },
      steps: {
        type: "array",
        required: true,
        description: "Up to 8 steps for teammates (not yourself), each {to: agent id, title: what to do, detail?: context}.",
        items: {
          type: "object",
          properties: { to: { type: "string" }, title: { type: "string" }, detail: { type: "string" } },
          required: ["to", "title"],
        },
      },
    },
  },
  {
    name: "basespace",
    description:
      "Reads the operator's BaseSpace dashboard (a snapshot it syncs here): section = summary | goals | notes | projects | todos | events | crons | teams | songs " +
      "(songs: the operator's music library: title, beat or song, BPM, key, tags, a note. Nothing else is known about a song; don't guess). " +
      "Goals are what the work is for; projects serve goals; todos and notes link to them. Use query to filter by text; use id to get one item in full " +
      "(a goal or project by id comes with its goal chain, linked notes and open todos; notes are listed without their text until you ask for one by id).",
    inputSchema: {
      section: { type: "string", required: true, description: "summary, goals, notes, projects, todos, events, crons, teams or songs." },
      query: { type: "string", description: "Only items containing this text." },
      id: { type: "string", description: "Return this one item in full (for a note: its whole text)." },
    },
  },
  {
    name: "basespace-add",
    description:
      "Adds something to the operator's BaseSpace: kind = note {title, body, folder?} | todo {title, due? YYYY-MM-DD, time? HH:MM, priority? high|med|low, notes?} | " +
      "project-update {projectId, text}. Todos can name the projectId or goalId they serve. When this conversation is focused on a goal or project, " +
      "what you add links to it automatically. Internal to their own dashboard — use approvals for anything that goes outside it.",
    inputSchema: {
      kind: { type: "string", required: true, description: "note, todo or project-update." },
      title: { type: "string", description: "Note or todo title." },
      body: { type: "string", description: "Note text (markdown)." },
      folder: { type: "string", description: "Note folder, e.g. Team/Meetings. Defaults to Agents/<your name>." },
      due: { type: "string", description: "Todo due date, YYYY-MM-DD." },
      time: { type: "string", description: "Todo time, HH:MM (the operator gets a notification then)." },
      priority: { type: "string", description: "Todo priority: high, med or low." },
      notes: { type: "string", description: "Todo details." },
      projectId: { type: "string", description: "Project id (from the basespace tool): required for a project-update; for a todo, the project it serves." },
      goalId: { type: "string", description: "For a todo: the goal it serves (from the basespace tool, section goals)." },
      text: { type: "string", description: "The project update." },
    },
  },
  {
    name: "library",
    description:
      "The operator's music library (songs uploaded through BaseSpace's Beat DB): action = list | read | add | update. " +
      "list: every uploaded song with its id. read: one song in full, including its lyrics if any have been written down. " +
      "add: put an audio file from disk into the library as a song {path, title, kind? beat|song, bpm?, key?, tags?, note?, lyrics?} (needs file access). " +
      "update: change a song's title, kind, bpm, key, tags, note or lyrics {id, ...}. There is no delete: only the operator removes songs. " +
      "Only write down what you were told. Never invent BPM, key or lyrics; leave a field out when unknown. You can't hear audio.",
    inputSchema: {
      action: { type: "string", required: true, description: "list, read, add or update." },
      id: { type: "string", description: "Song id (from list). Required for read and update." },
      path: { type: "string", description: "add: path to the audio file (mp3, wav, flac, m4a, aac, ogg, aiff)." },
      title: { type: "string", description: "Song title." },
      kind: { type: "string", description: "beat (an instrumental) or song." },
      bpm: { type: "number", description: "Tempo, only if known." },
      key: { type: "string", description: "Musical key, only if known." },
      tags: { type: "array", description: "Tags (descriptive words, not people).", items: { type: "string" } },
      collaborators: { type: "array", description: "Who else made it, each as \"Name\" or \"Name: what they did\" (e.g. \"Gswish: melody\"). Credits only; never invent splits.", items: { type: "string" } },
      note: { type: "string", description: "A short note." },
      lyrics: { type: "string", description: "The lyrics, exactly as given to you. Empty string clears them." },
    },
  },
  {
    name: "desktop",
    description:
      "What the operator has been doing on their computer: time per app, time per BaseSpace project or goal (matched from window titles), app switches and focus blocks " +
      "for a day, plus the window in front right now. Window titles only: keystrokes, typed text, the clipboard, audio and screenshots are never recorded. " +
      "Private windows show as (private). It says where time went, not why: don't guess intent, and say so when nothing was recorded.",
    inputSchema: { day: { type: "string", description: "YYYY-MM-DD, local time. Default: today." } },
  },
  {
    name: "soundlab",
    description:
      "The operator's Sound Lab: synthesized drums and melodic one-shots they listen to and judge. action = kept | packs | license. " +
      "kept {kind?}: the sounds they kept (name and kind) and how many are waiting or in maybe. packs: the sound packs built from kept sounds and what is in them. license: the full text of the DRAFT license that ships with a pack, and the [brackets] still open in it (read it to explain it; you can't change it). " +
      "You can't hear anything, and you can't accept, skip or build: only the operator judges and builds packs. Describe sounds only by their names and the counts; never say how one sounds.",
    inputSchema: {
      action: { type: "string", required: true, description: "kept, packs or license." },
      kind: { type: "string", description: "kept: only this kind (808, kick, snare, clap, perc, hat-closed, hat-open, bell, pluck, keys, pad, strings, lead)." },
    },
  },
  {
    name: "audio",
    description:
      "Audio editing with ffmpeg, like the practical parts of Audacity. action = info | edit. info {path}: length, format, peak and average level, loudness in LUFS. " +
      "edit {path, output, ...}: writes a NEW file (never overwrites; output ends in .wav .mp3 .flac .ogg or .m4a) applying, in one pass: " +
      "trim_start, trim_end (seconds), reverse, speed (0.25-4), pitch_semitones (-12..12, keeps length), high_pass_hz, low_pass_hz, gain_db, " +
      "normalize_peak_db (e.g. -1), limit_db, fade_in_sec, fade_out_sec, bit_depth (16|24, wav). Give only the edits you need. " +
      "It measures levels; it can't judge how something sounds.",
    inputSchema: {
      action: { type: "string", required: true, description: "info or edit." },
      path: { type: "string", required: true, description: "The input audio file." },
      output: { type: "string", description: "edit: the new file to write." },
      trim_start: { type: "number", description: "Seconds to cut from the start." },
      trim_end: { type: "number", description: "Seconds at which to stop." },
      reverse: { type: "boolean", description: "Play backwards." },
      speed: { type: "number", description: "Speed factor (changes length, keeps pitch)." },
      pitch_semitones: { type: "number", description: "Shift pitch, keeps length." },
      high_pass_hz: { type: "number", description: "Cut frequencies below this." },
      low_pass_hz: { type: "number", description: "Cut frequencies above this." },
      gain_db: { type: "number", description: "Louder (+) or quieter (-)." },
      normalize_peak_db: { type: "number", description: "Set the loudest peak to this level, e.g. -1." },
      limit_db: { type: "number", description: "Hard ceiling, e.g. -1." },
      fade_in_sec: { type: "number", description: "Fade in length." },
      fade_out_sec: { type: "number", description: "Fade out length." },
      bit_depth: { type: "number", description: "16 or 24 (wav output)." },
    },
  },
  {
    name: "read_file",
    description: "Reads a file's full text content from disk, subject to the session's SandboxPolicy (if one is configured).",
    inputSchema: { path: { type: "string", required: true, description: "Path to the file, absolute or relative to the sandbox's workspaceRoot." } },
  },
  {
    name: "edit_file",
    description:
      "Replaces an exact, unique occurrence of old_string with new_string in an existing file — the structured alternative to editing via shell redirection/sed. " +
      "old_string must match exactly once in the file unless replace_all is set, otherwise the call fails with no write made (so a bad match never silently edits the wrong spot).",
    inputSchema: {
      path: { type: "string", required: true, description: "Path to the existing file to edit." },
      old_string: { type: "string", required: true, description: "The exact text to replace. Must occur exactly once unless replace_all is true." },
      new_string: { type: "string", required: true, description: "The replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence of old_string instead of requiring exactly one. Default false." },
    },
  },
  {
    name: "write_file",
    description: "Creates a new file (or fully overwrites an existing one) with the given content. Creates parent directories as needed.",
    inputSchema: {
      path: { type: "string", required: true, description: "Path to the file to create or overwrite." },
      content: { type: "string", required: true, description: "The full file content to write." },
    },
  },
];

/** Registered only when HINDSIGHT_URL is set (see hindsight.ts), so models
 *  aren't offered a tool that can only fail. */
export const RECALL_MEMORY_TOOL: ToolDefinition = {
  name: "recall-memory",
  description:
    "Searches your long-term memory (Hindsight) for what you know about something. Set deep=true for a reasoned answer across everything you remember (slower).",
  inputSchema: {
    query: { type: "string", required: true, description: "What you want to remember, as a question or topic." },
    deep: { type: "boolean", description: "Reflect across all memories instead of a quick lookup. Default false." },
  },
  timeoutMs: 70_000,
};

for (const def of BUILTIN_TOOL_DEFINITIONS) registerTool(def);
if (process.env.HINDSIGHT_URL) registerTool(RECALL_MEMORY_TOOL);

/** Races `promise` against a timer of `timeoutMs`, returning `onTimeout()`'s
 *  result if the timer wins. `timeoutMs` undefined (the default for every
 *  built-in tool above) means no timeout is enforced — `promise` is
 *  returned directly with no race set up at all, so this is a true no-op
 *  for every existing caller that never opted a tool into a timeout. Note:
 *  like any Promise.race-based timeout, the LOSING side (a slow tool call
 *  that got preempted) keeps running in the background — this stops the
 *  CALLER from waiting on it, it does not cancel the underlying work
 *  itself. A Worker/tool that needs genuine cancellation should use
 *  Session's cancellation primitive (session.ts) instead, which this
 *  complements rather than replaces. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => T,
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  const result = await Promise.race([promise, timeoutPromise]);
  clearTimeout(timer!);
  return result;
}
