# agent-os

A minimal, runnable scaffold for a personal **agent-native operating
system** — the layer a "harness" (Hermes, Claude Code, Codex, etc.) would
eventually sit inside, not a harness itself.

> **Harness = process model for intelligence. OS = process model for
> everything else.**

This repo exists to test one idea at a time. It grew out of a comparative
study of six real agent harnesses (Hermes, Claude Code, OpenClaw, Codex,
DeepSeek Harness, Pi) — see [`docs/architecture.md`](docs/architecture.md)
for the full design rationale and source citations behind every choice
below. It is a sibling project to
[BaseOStest](https://github.com/Gylvejaegersborg/BaseOStest) (the ISΛRK
personal OS dashboard) — related in spirit, not sharing code. BaseOStest is
the UI this OS layer would eventually sit underneath; nothing here is
copied from it.

## Design principle

**Everything is a projection over an append-only event log.** Not separate
tables for Session/Task/Memory — one append-only stream per id, and
everything else (current session state, task status, curated memory,
skill catalog) is *derived* by replaying events, not separately maintained.
This is the one pattern Hermes (SQLite), OpenClaw (SQLite+revision), Pi
(JSONL trees), and DeepSeek Harness (JSONL/SQLite) all converged on
independently — see `docs/architecture.md §0`.

## What's implemented in this scaffold

| Primitive | Status | File |
|---|---|---|
| Event log (append-only, JSONL, projections) | ✅ working | `src/core/eventlog.ts` |
| Agent loop (turn = LLM call + tool calls, event-sourced) | ✅ working | `src/core/agent-loop.ts` |
| Model abstraction (swappable adapter interface) | ✅ working — stub + real Anthropic/OpenAI/Ollama adapters | `src/core/model.ts`, `src/core/models/real.ts` |
| Worker abstraction (execution environment, separate from Agent identity) | ✅ working (local-shell + stub) | `src/core/worker.ts` |
| Task / Flow (OpenClaw's ledger + orchestration split, with optimistic-concurrency revisioning) | ✅ working | `src/core/tasks.ts` |
| Subagent delegation (in-process, isolated context, same harness) | ✅ working — cross-harness delegation (Claude Code/Codex as a child process) is planned, not built | `src/core/subagent.ts` |
| Automation registry + scheduler (cron tick loop + event bus + webhooks) | ✅ working — all three trigger kinds fire for real | `src/core/scheduler.ts`, `src/core/eventbus.ts`, `src/core/webhook.ts` |
| Heartbeat (imprecise timing, full main-session context, no Task created) | ✅ working | `src/core/heartbeat.ts` |
| **Memory: fast-path episodic + gated "dreaming" promotion, MEMORY.md/USER.md split, dedup, and real injection into the agent loop** | ✅ working | `src/core/memory.ts`, `src/core/agent-loop.ts` |
| Hooks (deterministic, harness-run, decision vs. observe-only) | ✅ working | `src/core/hooks.ts` |
| Standing Order (deliberately NOT a data object) | 📝 documented only | `docs/architecture.md §2` |
| Skills (agentskills.io-compatible format) | ✅ working — parser, discovery, progressive disclosure, write support | `src/core/skills.ts`, `skills/*/SKILL.md` |
| Sandboxing / permission policy (two-layer) | ✅ working — Layer A (policy hook) + Layer B (sandboxed worker) | `src/core/permissions.ts` |
| Agent filesystem namespace | ✅ working — read/write over paths (write supported for skills only; see below) | `src/core/agentfs.ts` |

The memory design directly answers "I want the agent to keep getting
better with me, safely": episodic writes are immediate and ungated (same
immediacy as Hermes' memory tool today); the **only** path into permanent
curated memory is a deterministic scoring function (`scoreEligibility` in
`memory.ts`) that a background "dreaming" pass runs — the model is only
ever used to *phrase* what code already qualified, never to *decide* what's
worth remembering. Full provenance is kept for every promotion.

Curated memory is split into two documents mirroring Hermes' own
MEMORY.md/USER.md shape — `EpisodicKind: "preference"` entries promote
into USER.md (user profile/preferences), everything else promotes into
MEMORY.md (durable facts/procedures). Both documents are re-read fresh
and injected as a system message into **every real agent-loop turn**
(`runTurn()`, opt-out via `injectMemory: false`) — not just computed and
left sitting unread, which is what this scaffold did before this pass.
Re-promoting an already-promoted episodic entry in a later dreaming pass
no longer duplicates it in the document (dedup is tracked via each
promotion's own provenance, keyed by episodic entry id).

Verified with `npm run test-memory` (14 assertions: preference vs.
non-preference entries land in the correct document, a second dreaming
pass with no new writes produces byte-identical documents — proving
dedup — a newly-eligible entry is added alongside prior promotions
without duplicating them, and a `createRecordingModel()` wrapper proves
curated memory ACTUALLY reaches a real model's system message in a
brand-new session, plus that `injectMemory: false` genuinely opts out)
and `npm run demo`'s "3. Dreaming" section, which runs the same
dreaming pass twice back to back and prints `MEMORY.md content
unchanged: true`.

### Similarity-based repetition detection (`src/core/text-similarity.ts`)

`countSimilar()` no longer does exact-substring matching — it uses a
zero-dependency Jaccard token-overlap similarity
(`textSimilarity`/`tokenize`, `SIMILARITY_REPETITION_THRESHOLD = 0.15`)
so two paraphrases of the same fact ("User prefers concise, terse
responses" vs "User likes brief, to-the-point replies") now DO count as
repetitions of each other. This is a genuine, evidence-based
improvement over the previous behavior, not a claim of solving semantic
understanding — it's still token overlap, not real embeddings (see
mem0/Zep/MemGPT below for what that actually looks like in production).
Swapping in real embeddings later only touches this one file.

### Retrieval instead of full-dump (`retrieveMemoryContext` in `memory.ts`)

Curated memory is no longer injected in its entirety every turn.
`retrieveMemoryContext(agentId, queryText)` returns everything as
before ONLY while a document stays small (`RETRIEVAL_LINE_THRESHOLD = 8`
lines) — a fresh agent's behavior is unchanged. Once a document grows
past that, only the `RETRIEVAL_TOP_N = 6` lines most similar to the
CURRENT user message (the same Jaccard similarity as above) are
injected, restored to original document order so the excerpt still
reads as coherent prose rather than a shuffled bag of lines.
`runTurn()`'s system-message injection uses this automatically — no
separate opt-in needed, and the injected text notes when retrieval
trimmed the document ("showing 6 of 20 most relevant lines") so it's
never silently incomplete.

### Agent-nominated memory — a bounded voice, not a bypass

The user specifically wanted the agent to be able to influence what
gets learned, while still requiring human sign-off. The agent can call
a `nominate-memory` tool (opt-in per `runTurn()` call via
`enableMemoryNominations`, same pattern as `enableSubagents`) to
propose something worth remembering — but a nomination has **zero
effect** on curated memory, and doesn't even create an episodic entry,
until a human explicitly reviews it. This is deliberately **async, not
a blocking prompt**: the scaffold has no live UI to synchronously ask a
human mid-conversation, so nominations sit in `pending` state
(`listAgentMemoryNominations(agentId, { status: 'pending' })`) until
`approveAgentMemory(agentId, nominationId, reviewNote?)` or
`rejectAgentMemory(...)` is called — by you directly, or by a future
UI/CLI command layered on top.

**Approval is what actually "adds the points"**: it creates a real
episodic entry via the exact same `writeEpisodic()` path everything
else uses, weighted as an explicit correction
(`wasExplicitCorrection: true`) — which crosses the promotion threshold
on its own, the same as a user's own explicit correction would. There
is no separate promotion path for agent-nominated content and no way
for the agent to talk its way past the gate unilaterally: the
`agentFlaggedImportant` flag on an episodic entry is kept purely as a
provenance marker ("the agent proposed this, and the human later
agreed"), and on its own (outside the approval flow) is worth only +10
points — well under the 40-point threshold, so it can nudge a
borderline entry but never independently promote one.

Verified with `npm run test-memory-v2` (30 assertions covering all
three pieces above — including a pending nomination surviving an
entire dreaming pass with zero effect, a double-approval attempt
throwing rather than silently no-opping, a rejected nomination never
creating an episodic entry at all, and the whole nominate ->
pending -> approve -> promoted flow running through the real
`runTurn()`/agent-loop tool-call path, not just direct function calls)
plus `npm run demo`'s "3b. Agent-nominated memory" section, which walks
the entire flow live: nominate, prove a dreaming pass ignores the
pending nomination, approve, prove the SAME dreaming pass now promotes
it into MEMORY.md, then also demonstrates human rejection and the
opt-in gate.

**Remaining known gap, stated not hidden**: retrieval and repetition
detection here are both token-overlap heuristics, not real semantic
embeddings — genuinely useful, evidence-based improvements over the
previous exact-substring/full-dump behavior, but still a real gap
compared to production memory systems (mem0, Zep, MemGPT/Letta) that
use vector similarity. Swapping in embeddings is a natural next step
that would only touch `text-similarity.ts` and the retrieval/dedup call
sites in `memory.ts`.

## Running it

Zero API keys, zero external services required — the demo uses a
deterministic stub model and a stub-or-local-shell worker.

```bash
npm install
npm run demo
```

This runs an end-to-end tour: an agent loop turn that calls a shell tool,
episodic memory writes with varying eligibility, a dreaming pass that
promotes only what scores above threshold, a Task lifecycle, a Flow with
two dependent steps (plus a deliberate stale-write conflict to prove
optimistic concurrency), and an Automation registration — then prints
every event stream on disk to prove none of it needed a database.

Inspect the result directly — it's all human-readable:

```bash
cat data/streams/tasks.jsonl
cat data/streams/memory_demo-agent_dreaming.jsonl | python -m json.tool
```

Other commands:

```bash
npm run typecheck   # tsc --noEmit
npm run build        # tsc -b -> dist/
npm run chat          # interactive REPL — talk to a real agent-loop session
```

## Interactive chat (`npm run chat`)

The demo above is scripted and non-interactive. `npm run chat` starts a
real interactive session against a real agent loop — same code path,
same skills, same sandboxed worker, just driven by you instead of a
script. It picks a model with the same priority order as
`test-live-model` (Anthropic/OpenAI env var, then local Ollama, then the
deterministic stub as a last resort) and runs every message through the
sandboxed local-shell worker with the hard blocklist active. Set
`OLLAMA_MODEL` to override the default if you have something other than
`llama3.2` pulled locally. Every turn is written to that session's event
stream under `data/streams/`, same as the demo.

## Testing a real model adapter (not the stub)

The demo above never touches a network. To prove the model abstraction is
genuinely swappable, `npm run test-live-model` runs one real agent-loop
turn through whichever real adapter it finds, in this priority order:

1. `ANTHROPIC_TOKEN` or `ANTHROPIC_API_KEY` env var -> Anthropic Messages API
2. `OPENAI_API_KEY` env var -> OpenAI Chat Completions API
3. A local Ollama server (`ollama serve`, probed at `localhost:11434`) ->
   Ollama's OpenAI-compatible endpoint, zero API key, zero cost. Set
   `OLLAMA_MODEL=<name>` to pick which locally-pulled model to use (default
   `llama3.2` — override if you have something else pulled, e.g.
   `OLLAMA_MODEL=llama3.1:8b`).

```bash
# with a cloud key
export ANTHROPIC_TOKEN=sk-ant-...
npm run test-live-model

# or fully local/free
ollama serve &
ollama pull llama3.2   # or use OLLAMA_MODEL to point at one you already have
npm run test-live-model
```

If none of the above are available, the command exits with a clear error
instead of silently falling back to the stub.

## Skills — the open agentskills.io format

Skills live under `./skills/<skill-name>/SKILL.md`, following the open
[agentskills.io](https://agentskills.io/specification) spec rather than a
bespoke format — this is the one primitive that's most converged across
every harness studied (Hermes, Claude Code, DeepSeek Harness, and Pi all
implement near-identical progressive disclosure). Skills written for those
harnesses should be directly usable here, and vice versa.

Progressive disclosure, exactly as the spec describes it:

1. **Metadata** (name + description) is loaded for every skill at agent
   startup — always resident in context, ~100 tokens each.
2. **Instructions** (the full `SKILL.md` body) load only when the agent
   calls the `skill` tool with a name — see `demoSkills()` in `cli.ts` for
   a worked example, including the `skill.loaded` event this records.
3. **Resources** (`scripts/`, `references/`, `assets/`) load only as
   needed — `event-log-debugging/references/scoring-fields.md` is an
   example resource file, referenced from its skill's body.

Two example skills ship in `./skills/` and are loaded automatically by
`npm run demo`. Malformed skills (bad `name` format, missing
`description`, etc.) are skipped with a warning rather than failing
discovery for the whole catalog.

## Permissions & Sandboxing — two deliberately separate layers

Per `docs/architecture.md §6` (Claude Code's own articulation of this is
the clearest across every harness studied): **permission rules can be
circumvented by a misleading command string, but a sandbox boundary holds
regardless of what the model chose to run.** This scaffold keeps the two
genuinely separate rather than conflating them into one "safety" concept:

- **Layer A — `PermissionPolicy`** (`installPermissionPolicy` in
  `permissions.ts`): pre-execution, model-input-based. Evaluated as a
  `tool.before` hook — decides allow/ask/deny from the tool *name* the
  model requested. Gameable by design: a model that names a tool
  correctly but sends malicious args can still slip past this layer alone.
- **Layer B — `SandboxPolicy`** (`createSandboxedWorker` in `worker.ts`):
  enforced by the Worker itself, at the point of actual execution,
  independent of any upstream policy decision. Ships with a small
  hardline blocklist (`DEFAULT_HARD_BLOCKLIST`) mirroring Hermes' own
  non-overridable blocklist floor — patterns like a root filesystem wipe
  are rejected no matter what tool or policy was involved.

`npm run demo`'s "5. Permissions / Sandbox" section proves both layers
independently: a named tool denied at the hook layer (never reaches the
Worker at all), and a dangerous command rejected at the Worker layer even
when called directly with no permission policy in the way — while a
harmless command through that same sandboxed Worker still succeeds.

### The filesystem-scope check: what it does now

`checkSandbox`'s filesystem-scope check (`workspace-only` /
`workspace-and-temp`) used to be a bare `../` substring match — it caught
`cat ../../../etc/passwd` but completely missed an absolute-path escape
with no `..` in it at all (`type C:\Windows\System32\config\SAM`, `cat
/etc/passwd`), which sailed straight through unblocked. That was a real
gap, not a theoretical one.

It's now a real path-containment check built on Node's `path` module
only (zero new dependencies):

1. Tokenize the command (whitespace/quote-aware, not a full shell parser)
   and pull out path-looking tokens.
2. Resolve each one to an absolute path with `path.resolve()` — relative
   tokens resolve against `workspaceRoot`, absolute tokens (Windows drive
   paths, UNC paths, POSIX-rooted paths, and MSYS/git-bash-style
   `/c/Windows/...` paths, normalized since this scaffold runs on Windows
   via git-bash) resolve to themselves regardless of `workspaceRoot` —
   this is exactly the case the old check missed.
3. Resolve symlinks with `fs.realpathSync` (walking up to the nearest
   existing ancestor for not-yet-created paths) so a symlink planted
   *inside* the workspace that points *outside* it doesn't fool the
   check.
4. Test genuine containment with `path.relative()` plus a `..`/absolute
   check — not a string-prefix test, which would wrongly treat a sibling
   directory like `D:\workspace-evil` as "inside" `D:\workspace` just
   because the string happens to start the same way. On Windows the
   comparison case-folds (NTFS is case-insensitive/case-preserving).

See `src/test-sandbox-hardening.ts` (`npm run test-sandbox-hardening`)
for the test cases proving: traversal (`../`) is still blocked, an
absolute-path escape with no `../` is now blocked (the actual bug fixed),
a symlink pointing out of the workspace is caught, and paths genuinely
inside `workspaceRoot` are still allowed — including on Windows-style
paths.

### What this still does NOT provide — read this before trusting it

This is still, and will always be as implemented, an **in-process
string/path check that runs in the same Node process as the command it's
checking** — not OS-level enforcement. It is not Landlock, not Seatbelt,
not a container/namespace boundary, not a chroot, not a restricted
access token. Concretely:

- Nothing stops code with a different execution path from touching the
  filesystem directly without ever going through `checkSandbox()` —
  a spawned child process reading its own argv, a script interpreter
  invoked with `-c`, a compiled binary, or raw syscalls all bypass this
  entirely. **A determined attacker with arbitrary code execution inside
  the sandboxed Worker can very plausibly find a gap this does not
  cover.**
- The tokenizer is not a real shell parser: it does not resolve `$VAR` /
  `%VAR%` expansion, `~` expansion, command substitution (`$(...)`,
  `` `...` ``), or paths reassembled from concatenated fragments. Any of
  those can smuggle a path past this check's static view of the command
  string.
- `realpathSync`-based symlink resolution only covers what exists on
  disk at check time — there is no atomicity between "we checked" and
  "the command ran" (a TOCTOU symlink swap is not defended against).
- It has no visibility into what an *allowed* command does once it
  runs — e.g. an allowed `node script.js` invocation can itself open
  arbitrary paths at runtime that were never mentioned in the original
  command string.

That's an intentional "prove the layer separation first, then make the
in-process check meaningfully more correct" scope — real OS-level
enforcement (Landlock on Linux, Seatbelt on macOS, a container/namespace
boundary, or a restricted-token/AppContainer approach on Windows)
belongs *underneath* this check, not instead of it. See
`docs/architecture.md §6` for what a production sandbox needs on top of
this.

## Subagent — delegating within the same harness

A NEW isolated agent-loop run inside the SAME process, using this
harness's own tools/model/skills/permissions — not a call to a
different product. This is the Claude Code model of delegation, not
the DeepSeek Harness model: `spawnSubagentTask()` (`src/core/subagent.ts`)
just calls this scaffold's own `runTurn()` again with a fresh
`newSessionId()`. No second application, no external process, no extra
install — the parent and the subagent are the exact same running
program.

**The defining property (matching Claude Code's own "context
isolation" design)**: the parent never sees the subagent's own tool-call
noise, intermediate reasoning, or session history — only the final
result crosses back. This is why `spawnSubagentTask()` gives the
subagent its own `sessionId` rather than reusing the parent's; dumping
the child's full transcript into the parent's context would defeat the
entire point.

Every subagent run creates a real `Task` (`type: "subagent"`,
`parentTaskId` set) in the exact same ledger every other Task-creating
primitive in this scaffold uses — `listTasks({ parentTaskId })` answers
"what did my subagents do" the same way it would for any other Task
relationship, no bespoke tracking structure needed.

Delegation is exposed to the model itself as a real tool: pass
`enableSubagents: true` to `runTurn()` and the model can call the
`subagent` tool with `{ goal }` mid-conversation. It's opt-in per call
(not a global default) specifically to avoid uncontrolled fan-out —
a subagent run itself does not automatically get `enableSubagents`
passed through, so subagents don't recursively spawn further subagents
unless you deliberately wire that up.

**What this is NOT (yet)**: a way to shell out to a *different* agent
product (Claude Code, Codex, etc.) as a child process. That's a
separate, genuinely optional primitive — cross-harness delegation,
modeled on DeepSeek Harness's proof that "spawn a different harness
entirely as the child" is trivial once delegation is a protocol
boundary rather than an internal function call. It would mean a new
`WorkerKind` (e.g. `"acp:claude-code"`) that shells out to an installed
CLI and adapts its output back into this scaffold's `WorkerResult`
shape — useful for "use Codex specifically for this coding task because
it's better at it," but it requires the other CLI to be installed and
runnable, adds subprocess overhead, and is NOT a prerequisite for
subagents to work at all. Planned, not built — see
`docs/architecture.md`'s Worker section for the design intent.

Verified with `npm run test-subagent` (9 assertions: the spawned Task
has `type: "subagent"` and the right `parentTaskId`, `listTasks({
parentTaskId })` finds it, the parent session sees the subagent's
result but has no direct handle into the child's own session, and
`enableSubagents` is genuinely opt-in — omitting it rejects the
`subagent` tool call rather than silently working) plus `npm run
demo`'s "1c. Subagent" section, which runs the delegation through the
real agent loop end to end (not just calling `spawnSubagentTask()`
directly) and prints the resulting Task id, parent session message
count, and the gated-rejection case side by side.

Found and fixed a real bug while building this: the deterministic stub
model's pattern matching checked `run shell:` before `delegate to
subagent:`, and since both are unanchored substring tests, a message
like `"delegate to subagent: run shell: echo hi"` matched `run shell:`
first and called the shell tool directly instead of delegating —
caught immediately by the demo section showing an unexpected shell call
instead of a subagent call; fixed by checking the more specific pattern
first.

## Scheduler — Automations that actually fire

Per `docs/architecture.md §2`'s "two scheduling modes" note. Both modes
are now implemented, each as its own module, matching the doc's explicit
warning not to collapse them into one scheduler abstraction:

- **Automations** (`src/core/scheduler.ts`) — precise timing, isolated
  context. A zero-dependency 5-field cron parser (`parseCron`/
  `cronMatches`) plus a real tick loop (`startScheduler`, default 30s
  interval) that checks every enabled cron-triggered Automation and
  fires the ones that are due. Firing spawns a real Task (`type:
  "cron"`) and runs a full agent-loop turn in a brand-new, isolated
  session — never the automation's own history, matching "isolated
  context" from the architecture doc. Every firing is itself
  event-sourced (`automation.fired` events in the same `automations`
  stream `tasks.ts` already writes to), which is also how dedup works:
  an automation can fire at most once per matching minute, so a
  scheduler restart never double-fires or loses its place.
- **Heartbeat** (`src/core/heartbeat.ts`) — imprecise timing (an
  interval plus symmetric random jitter, default ±20%, so "roughly every
  30 minutes" is genuinely approximate, not a disguised cron), full
  main-session context (every tick is a turn appended to ONE long-lived
  session via `runTurn`, so it sees everything that happened before —
  the defining difference from Automations, where every firing gets a
  brand-new isolated session), and — critically — **no Task is ever
  created**, mirroring `types.ts`'s own comment that plain chat turns do
  not create a Task. This is why `runHeartbeatTick`/`startHeartbeat` are
  thin wrappers around `runTurn()` targeting an *existing* `sessionId`,
  not task-spawning functions like `fireAutomation`. Ticks are still
  independently auditable via `heartbeat.ticked` events in their own
  stream, separate from session content.

`event`-triggered automations now fire automatically once
`wireAutomationsToEventBus()` (`src/core/scheduler.ts`) is called at
startup — it subscribes to the event bus (`src/core/eventbus.ts`, a
minimal in-process pub/sub, no external broker) and calls
`fireEventAutomations()` for every published event. The manual
`fireEventAutomations()` call still works standalone if you'd rather
trigger it yourself without the bus. `webhook`-triggered automations
fire via a real local HTTP server (`src/core/webhook.ts`, Node's
built-in `http` module, no framework) — `startWebhookServer()` matches
any request whose path equals a registered, enabled webhook
automation's `path` (any HTTP method — path-only matching), returning
200 with which automations fired, or 404 if nothing matches (never a
silent no-op). Deliberately out of scope: no auth/signature
verification on the webhook endpoint and no HTTPS — add both before
exposing this beyond localhost.

Verified with `npm run test-cron` (9 assertions: step values, ranges,
weekday matching, malformed-input error handling), `npm run
test-heartbeat` (5 assertions: no Task created, context accumulates
across ticks in the same session, and consecutive tick gaps under a real
`startHeartbeat` loop are NOT identical — jitter genuinely present, not
just claimed), `npm run test-eventbus` (9 assertions: typed + wildcard
subscription, unsubscribe, a throwing subscriber does not block other
subscribers, and `wireAutomationsToEventBus` end-to-end — publishing a
non-matching event does nothing, a matching one creates a real Task,
unwiring stops it), `npm run test-webhook` (8 assertions against a REAL
HTTP server on an ephemeral port: registered path fires and returns 200,
unregistered path returns 404, a disabled automation's path also
returns 404 rather than silently succeeding, any HTTP method matches,
and a non-JSON body doesn't crash the handler), plus `npm run demo`'s
"5. Scheduler", "5b. Heartbeat", and "5c. Event Bus + Webhooks"
sections, which exercise all of it against real data side by side.

**Note on test isolation**: fixed. Every standalone test script
(`test-cron`, `test-eventbus`, `test-webhook`, `test-skills-write`,
`test-heartbeat`, `test-subagent`, `test-memory`, `test-memory-v2`) now
imports `src/test-helpers/isolate.ts` as its first line, before any
`./core/*` import. That module sets `AGENT_OS_DATA_DIR` to a
deterministic `./data-test/<test-name>/` directory (wiped at the start
of every run) before `eventlog.ts` — which reads that env var once at
module-load time — ever gets evaluated. Effect: each test file gets its
own scratch event-log directory, isolated from `npm run demo` (which
still defaults to `./data/`, untouched) and from every other test file.
Verified by running `rm -rf data && npm run demo` to populate real demo
data (registered/fired Automations, Tasks, sessions) and then every
`test-*` script back to back with **no** `rm -rf data` in between —
including `test-webhook`'s "exactly one fired automation" assertion,
the exact case that previously produced a false failure — and all pass.
`rm -rf data` before a standalone run is no longer necessary.

## Agent filesystem namespace — the same primitives, addressed as paths

Per `docs/architecture.md §7`: a projection that exposes everything
above as a virtual `/agent/...` filesystem, e.g.
`/agent/identity/<agentId>.json`, `/agent/skills/<name>/SKILL.md`,
`/agent/memory/<agentId>/curated/MEMORY.md`,
`/agent/sessions/<sessionId>.jsonl`, `/agent/tasks/<taskId>/state.json`.
This is deliberately **not a new storage layer** — every path is a VIEW
over the exact same event-log streams and skill files the rest of this
scaffold already writes, using the same "everything is a projection"
principle from the top of this README, just applied to a filesystem-
shaped API (`fsList`/`fsRead`/`fsWrite` in `agentfs.ts`) instead of an
event-log-shaped one.

**Write support is implemented for exactly one path kind: skills.**
`/agent/skills/<name>/SKILL.md` can be written because a skill is
genuinely just a file — no event-log invariant is bypassed by writing
one directly (`fsWrite` validates via `parseSkillFile` before anything
touches disk, and rejects a frontmatter `name` that doesn't match the
path segment). Every other path kind (`identity`, `memory`, `sessions`,
`tasks`, `flows`, `automations`) still throws
`FsWriteNotSupportedError` rather than silently no-op'ing: writing e.g.
`/agent/memory/.../MEMORY.md` would mean deciding how a raw file write
maps back onto event-log semantics, and for memory specifically it
would bypass the dreaming-gate invariant §3 exists to enforce — a real
open design question, not a missing feature to paper over.

`npm run demo`'s "6. Agent filesystem" section walks every path kind
(skills, curated + episodic memory, sessions, tasks) against the exact
data the earlier demo sections just wrote, confirms a nonexistent path
throws, and confirms `fsWrite` writes and reads back a real skill
end-to-end. `npm run test-skills-write` covers the write path in
isolation: frontmatter round-tripping (parse -> serialize -> parse),
`writeSkill()` validating before touching disk, `fsWrite()`/`fsRead()`
round-tripping through the real `skills/` directory (cleaned up
immediately so it never pollutes the actual catalog), the
path/frontmatter name-mismatch rejection, and the
`FsWriteNotSupportedError` thrown for unsupported path kinds.

## Repo layout

```
src/
  core/
    types.ts        # shared interfaces (Event, Task, Flow, Automation, ...)
    id.ts            # sortable id generator (no deps)
    eventlog.ts      # THE foundation — append/read/project over JSONL streams
    tasks.ts         # Task/Flow/Automation projections over the event log
    memory.ts         # episodic fast-path, dreaming promotion, retrieval, agent nominations
    text-similarity.ts # zero-dependency Jaccard similarity for repetition/retrieval
    hooks.ts          # deterministic lifecycle hooks, harness-run not model-run
    skills.ts          # agentskills.io SKILL.md parser + progressive-disclosure registry
    permissions.ts      # two-layer permission policy (hook) + sandbox (worker enforcement)
    identity.ts           # minimal Agent identity store (name + persona), backs /agent/identity
    agentfs.ts              # /agent/... filesystem projection (read all paths, write skills only)
    scheduler.ts              # cron parser + tick loop + event/webhook dispatch for Automations
    eventbus.ts                # minimal in-process pub/sub, wires event-triggered Automations
    webhook.ts                   # real local HTTP listener for webhook-triggered Automations
    heartbeat.ts                   # the OTHER scheduling mode: imprecise timing, full session context
    subagent.ts                      # in-process delegation to a fresh, isolated agent-loop run
    worker.ts                          # execution-environment interface (local-shell, stub, sandboxed wrapper)
    model.ts             # swappable LLM adapter interface (stub adapter shipped)
    models/real.ts        # real Anthropic / OpenAI / Ollama adapters
    agent-loop.ts          # the turn loop binding all of the above together
  cli.ts                    # runnable end-to-end demo of every primitive above
  test-live-model.ts         # calls a real model adapter (not the stub) — see below
  test-cron.ts                # standalone cron parser/matcher regression tests
  test-eventbus.ts             # standalone event bus pub/sub + Automation-wiring tests
  test-webhook.ts                # standalone webhook listener tests (real HTTP server)
  test-skills-write.ts             # standalone skills write/round-trip tests
  test-heartbeat.ts                  # standalone Heartbeat scheduling-mode tests
  test-subagent.ts                     # standalone Subagent context-isolation tests
  test-memory.ts                         # standalone memory dedup/split/injection tests
  test-memory-v2.ts                        # standalone similarity/retrieval/nomination tests
skills/
  commit-message-style/       # example skill: house style for git commits
    SKILL.md
  event-log-debugging/          # example skill with a references/ subfile
    SKILL.md
    references/scoring-fields.md
docs/
  architecture.md                # the full design sketch this scaffold implements
```

## Status

Early scaffold, actively evolving. The plan is to scale one primitive at a
time from here — see the table above for what's next (Skills, sandboxing,
the agent filesystem namespace, a real scheduler for Automations, a real
model adapter).
