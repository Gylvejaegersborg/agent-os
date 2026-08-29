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
| Task / Flow (OpenClaw's ledger + orchestration split, with optimistic-concurrency revisioning) — **timeout + 'lost' enforcement, real notifyPolicy wiring, and Flow.kind:'mirrored' now implemented** | ✅ working | `src/core/tasks.ts` |
| Subagent delegation (in-process, isolated context, same harness) | ✅ working — PRIMARY/default multiagent mechanism | `src/core/subagent.ts` |
| Cross-harness delegation (shell out to Claude Code/Codex/OpenCode CLI as a child process) | ✅ implemented — OPTIONAL, opt-in, NOT the default; live-verification status varies by machine (see below) | `src/core/cli-agent-worker.ts` |
| Automation registry + scheduler (cron tick loop + event bus + webhooks) | ✅ working — all three trigger kinds fire for real | `src/core/scheduler.ts`, `src/core/eventbus.ts`, `src/core/webhook.ts` |
| Heartbeat (imprecise timing, full main-session context, no Task created) | ✅ working | `src/core/heartbeat.ts` |
| **Memory: fast-path episodic + gated "dreaming" promotion, MEMORY.md/USER.md split, dedup, and real injection into the agent loop** | ✅ working | `src/core/memory.ts`, `src/core/agent-loop.ts` |
| Hooks (deterministic, harness-run, decision vs. observe-only) | ✅ working | `src/core/hooks.ts` |
| Standing Order (deliberately NOT a data object) | 📝 documented only | `docs/architecture.md §2` |
| Skills (agentskills.io-compatible format) | ✅ working — parser, discovery, progressive disclosure, write support | `src/core/skills.ts`, `skills/*/SKILL.md` |
| Sandboxing / permission policy (two-layer) | ✅ working — Layer A (policy hook) + Layer B (sandboxed worker) | `src/core/permissions.ts` |
| Agent filesystem namespace | ✅ working — read/write over paths (write supported for skills only; see below) | `src/core/agentfs.ts` |
| **Agent identity (persona, defaultModel) actually affecting behavior** | ✅ working — persona injected into every turn's system message; defaultModel consulted during model selection | `src/core/identity.ts`, `src/core/agent-loop.ts`, `src/core/models/real.ts` |

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
understanding — it's still token overlap, not real embeddings. This
remains the **always-available default** with zero setup and zero
network calls; see the optional embedding upgrade below for when real
semantic similarity matters more than zero-dependency simplicity.

### Optional upgrade: embedding-based similarity via local Ollama, with automatic fallback

Jaccard token overlap misses paraphrases that share almost no
vocabulary ("The database needs a backup before the migration" vs
"Back up the DB prior to running the schema update" — genuinely the
same fact, near-zero token overlap). `text-similarity.ts` now also
exports `createSimilarityProvider(opts?)`, which returns an async
`SimilarityProvider` backed by a local Ollama server's
`/api/embeddings` endpoint (cosine similarity, rescaled to the same
`[0, 1]` range `textSimilarity()` uses so both backends threshold
identically against `SIMILARITY_REPETITION_THRESHOLD`).

- **Model**: defaults to `nomic-embed-text`, overridable via the
  `OLLAMA_EMBEDDING_MODEL` env var (or the `model` option). Server URL
  defaults to `http://localhost:11434`, overridable via `OLLAMA_BASE_URL`
  (or the `baseUrl` option).
- **Automatic, transparent fallback**: every attempt is wrapped so
  *any* failure — server not running, model not pulled, network error,
  or a short timeout (default 2s) — logs a one-line warning and falls
  back to the exact same synchronous `textSimilarity()` Jaccard scoring
  for the rest of that provider's lifetime. It **never throws** and
  never crashes a caller; `provider.usingEmbeddings` reports which
  backend actually served the last successful call, for diagnostics
  only (callers should never branch on it).
- **Zero-impact opt-in**: `writeEpisodic()`, `retrieveMemoryContext()`,
  and the new `retrieveRelevantLinesAsync()` all accept an *optional*
  `similarityProvider` parameter. Omit it (as every existing call site
  and the entire test/demo suite still does) and behavior is byte-for-
  byte identical to before — no network call is ever made unless a
  caller explicitly constructs and passes a provider. The always-
  synchronous `retrieveRelevantLines()` is untouched for callers that
  want to stay fully synchronous.
- **Caching**: a provider instance caches embeddings per exact input
  string (call sites like `countSimilar()` compare one new string
  against many stored entries) and caches the reachability verdict
  after the first attempt, so a confirmed-down server doesn't re-pay a
  network round trip on every comparison in a loop.

```ts
import { createSimilarityProvider, writeEpisodic, retrieveMemoryContext } from "./core/index.js";

const provider = createSimilarityProvider(); // OLLAMA_EMBEDDING_MODEL / OLLAMA_BASE_URL env-overridable
await writeEpisodic({ agentId, content, kind: "fact", sourceSessionId, similarityProvider: provider });
const retrieved = await retrieveMemoryContext(agentId, queryText, provider);
```

**Live-verification status, stated honestly**: this was built and
tested in an environment where a local Ollama server with
`nomic-embed-text` pulled was actually reachable, and
`npm run test-memory-embeddings` genuinely exercised the live path —
real embeddings were fetched over HTTP, cosine-compared, and asserted
to score a low-token-overlap paraphrase pair (~0.82) higher than an
unrelated sentence pair (~0.70) and higher than Jaccard scored the same
pair (0.0), including end-to-end through `writeEpisodic()`'s
`repetitionCount` and `retrieveMemoryContext()`. The fallback path
(pointing a provider at a dead port) was also live-tested and confirmed
to degrade to Jaccard without throwing. On a machine with no Ollama
server or no embedding model pulled, the live-embeddings assertions
self-skip with a logged reason rather than failing — the fallback
assertions still run unconditionally, since they need no server at all.

### Retrieval instead of full-dump (`retrieveMemoryContext` in `memory.ts`)

Curated memory is no longer injected in its entirety every turn.
`retrieveMemoryContext(agentId, queryText, similarityProvider?)` returns
everything as before ONLY while a document stays small
(`RETRIEVAL_LINE_THRESHOLD = 8` lines) — a fresh agent's behavior is
unchanged. Once a document grows past that, only the
`RETRIEVAL_TOP_N = 6` lines most similar to the CURRENT user message
(Jaccard by default, or the embedding provider above if one is passed)
are injected, restored to original document order so the excerpt still
reads as coherent prose rather than a shuffled bag of lines.
`runTurn()`'s system-message injection uses this automatically (Jaccard,
no provider passed) — no separate opt-in needed, and the injected text
notes when retrieval trimmed the document ("showing 6 of 20 most
relevant lines") so it's never silently incomplete.

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

**Remaining known gap, stated not hidden**: the Jaccard token-overlap
heuristic remains the always-available default for both retrieval and
repetition detection — genuinely useful, evidence-based improvements
over the previous exact-substring/full-dump behavior on their own. The
optional embedding-based upgrade above (`createSimilarityProvider()`,
live-tested against a local Ollama server) closes most of the gap to
production memory systems (mem0, Zep, MemGPT/Letta) that use vector
similarity — but it's opt-in and depends on a local embedding model
being available, so Jaccard is what actually runs unless a caller wires
a provider through. Nothing in this scaffold requires cloud embeddings
or an API key for either path.

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
separate, genuinely optional primitive — see the "Cross-harness
delegation (optional, NOT the default)" section below, which IS now
built (`src/core/cli-agent-worker.ts`), sitting right alongside this
Subagent primitive without replacing it as the default.

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

## Task lifecycle — timeout, 'lost' detection, real notifyPolicy, mirrored Flow

`types.ts`'s `TaskStatus` always included `'timed_out'` and `'lost'`, and
`Flow.kind` was always typed `'managed' | 'mirrored'` — but until now
nothing ever produced those statuses or that Flow kind, and
`notifyPolicy` was stored on every `Task` and read by nothing. This
section closes all four gaps, entirely inside `src/core/tasks.ts`, using
the same event-sourced pattern as everything else here: new behavior is
new event types appended to the existing `tasks`/`flows` streams, reduced
by `projectTasks()`/`projectFlows()` — no new mutable store, no database.

**1. Timeout enforcement.** A `Task` can carry an optional
`timeoutMs` (set at `createTask()` time). `checkTaskTimeouts()` is a
**sweep** — not a per-task `setTimeout` — that walks every currently
`'running'` Task, compares `now - startedAt` against `timeoutMs` (or an
optional sweep-wide `defaultTimeoutMs` for Tasks with none configured),
and transitions any that are over budget to `'timed_out'` via the
existing `transitionTask()`. Deliberately a sweep, not a timer armed at
`createTask()` time: a `setTimeout` armed in one process is silently lost
if that process crashes before it fires; a sweep re-derived from
`startedAt` in the event log gives the correct answer regardless of which
process runs it or how long it was down. Every sweep appends a
`task.timeout.checked` audit event (which Tasks were even eligible, which
were found over budget) before driving any actual status change, so "why
did this time out" is always answerable from the log alone.
`startTaskTimeoutSweeper()` wraps this in a real `setInterval` loop
(unref'd, `stop()` handle), matching `scheduler.ts`'s `startScheduler()`
and `heartbeat.ts`'s `startHeartbeat()` in shape; call it once at process
startup if you want continuous enforcement instead of only calling
`checkTaskTimeouts()` manually/on demand.

**2. 'lost' detection — the honest version.** This scaffold has no
process supervisor, container runtime, or distributed lease store, so
"lost" detection here is a documented, correctly-scoped approximation,
not a claim of true multi-process crash detection:
`transitionTask()` maintains an in-memory `liveTaskIds` Set — every Task
id the CURRENT process has itself moved into `'running'` and not yet
moved out of. `reconcileLostTasks()` is meant to run once, early, at
process startup: any Task the event log still says is `'running'` at that
moment cannot possibly be live in a just-started process (nothing has run
yet), so if it isn't in `liveTaskIds` either, the process that was
actually executing it is gone and never got to append a terminal status
change — it's marked `'lost'`. `simulateProcessRestart()` clears
`liveTaskIds` without touching the event log, modeling exactly what a
real crash+restart does to that registry, which is what lets the test
suite exercise this deterministically. **What this deliberately does
NOT do**: distinguish "genuinely crashed" from "alive in some other
still-running process that hasn't registered here" in a true
multi-process deployment — that needs a shared lease/heartbeat registry
(e.g. a periodic `task.liveness.renewed` event with a TTL, checked
instead of local Set membership). The Set-based approach here is the
honestly-scoped, zero-dependency version of that idea for a scaffold
where only one process talks to the log at a time. Like timeout
enforcement, every sweep appends a `task.reconciliation.swept` audit
event (which Tasks were running, which were found orphaned) before
marking anything `'lost'`.

**3. `notifyPolicy` wired to something real.** Every `transitionTask()`
call — no matter which primitive triggered it (`subagent.ts`,
`scheduler.ts`'s `fireAutomation`, the timeout sweep, the reconciliation
sweep) — now routes through `notifyTaskStatus()`, so all three policies
apply uniformly everywhere a Task's status changes, not just in one
call site:
- **`'immediate'`** appends a `task.notification.sent` audit event
  (`batched: false`) AND publishes a real `task.notification` event on
  the in-process event bus (`eventbus.ts`) synchronously, once per status
  change. Any `subscribeToEvent("task.notification", ...)` handler hears
  it inside that same `publishEvent()` call.
- **`'digest'`** queues into an in-memory `digestQueue` and publishes
  nothing yet. `flushDigest()` (called manually, or on an interval via
  `startNotificationDigestFlusher()`, same shape as the other
  `start*()` handles in this codebase) drains the WHOLE queue into one
  `task.notification.sent` audit event (`batched: true`, carrying every
  queued item) and one `task.notification.digest` bus publish — genuinely
  batched, not fired per task. Flushing an empty queue is a safe no-op
  (`flushDigest()` returns `null`, appends/publishes nothing).
- **`'silent'`** appends a `task.notification.suppressed` audit event
  (so the silence itself is provable from the log — nothing was "lost",
  it was deliberately never sent) and publishes NOTHING on the event bus.
  No subscriber ever sees it.

**4. `Flow.kind: 'mirrored'`.** The existing `'managed'` path is
unchanged: the caller explicitly drives every `FlowStep` via
`updateFlowStep()`, and `projectFlows()` aggregates step statuses into
the Flow's own status. `createMirroredFlow()` is the new contrast case: it
creates a Flow with **exactly one** `FlowStep`, wrapping a single new
`Task` (bound via that Task's own `flowId`) — a genuine 1:1 wrapper, not
a `'managed'` Flow with one step that happens to be alone. The defining
difference is *who* drives the step transitions: for `'managed'`, the
caller calls `updateFlowStep()` directly; for `'mirrored'`, nobody calls
it directly at all — `propagateToMirroredFlow()`, invoked from inside
`transitionTask()` after every status change, automatically mirrors the
wrapped Task's status onto that one step via the SAME `updateFlowStep()`
a `'managed'` Flow's caller would use. The Flow's own overall status
(`running`/`succeeded`/`failed`/`cancelled`) falls out of the exact same
step-aggregation logic `projectFlows()` already used for `'managed'`
Flows — no separate status machine for `'mirrored'` — with `'timed_out'`
and `'lost'` step statuses both counted as `'failed'` at the Flow level,
since `Flow.status` has no `timed_out`/`lost` value of its own.

**Known scaffold limitation** (documented, not hidden): timeout and
reconciliation sweeps must be triggered (manually, or via
`startTaskTimeoutSweeper()`/on process startup) — nothing in this
scaffold currently wires them into `cli.ts`'s demo/chat startup path
automatically the way `wireAutomationsToEventBus()` is wired for event
automations. A real deployment calls `startTaskTimeoutSweeper()`,
`reconcileLostTasks()` (once, at startup, before resuming any Tasks),
and `startNotificationDigestFlusher()` explicitly alongside
`startScheduler()`/`startHeartbeat()`.

Verified with `npm run test-task-lifecycle` (34 assertions covering all
four pieces end to end against real event-log writes — not just
typechecking): a Task with a short `timeoutMs` genuinely elapses and
times out while one with a long `timeoutMs` and one with none are left
alone; a sweep-wide `defaultTimeoutMs` catches untimed Tasks
retroactively; `simulateProcessRestart()` + `reconcileLostTasks()`
correctly marks an orphaned Task `'lost'` while leaving a re-registered
one `'running'`; all three `notifyPolicy` values are checked against a
real `subscribeToEvent()` listener on the actual event bus (immediate
fires 1:1, digest batches N status changes into exactly 1 publish,
silent publishes 0 but still audits the suppression); and a
`createMirroredFlow()` Flow's single step and overall status are shown
tracking its wrapped Task automatically — including through a
`timed_out` transition — while a sibling `'managed'` Flow stays untouched
by any of it. `npm run demo`'s existing "4. Task / Flow / Automation"
section is unchanged and still green (no regression) — the lifecycle
enforcement pieces are additive and only activate when a Task is given a
`timeoutMs`, goes through a reconciliation sweep, or is created via
`createMirroredFlow()`.

## Cross-harness delegation (optional, NOT the default)

**Read this before using `cli-agent-worker.ts`.** The in-process
Subagent above (`spawnSubagentTask()`, `src/core/subagent.ts`) is the
PRIMARY multiagent mechanism in this scaffold and remains the default:
zero extra install, zero subprocess overhead, same harness, same
tools/model/skills/permissions. **Nothing below replaces it.**

Cross-harness delegation is a genuinely SEPARATE, explicitly opt-in
capability for one specific case: you want a *different agent product*
to do the work — e.g. "use the real Claude Code CLI for this because
its coding tool loop is what I actually want" — not "I need another
subagent." It's modeled on DeepSeek Harness's proof that "spawn a
different harness entirely as the child" is trivial once delegation is
a protocol boundary (a `Worker`) rather than an internal function call,
and on the `"acp:claude-code"` / `"acp:codex"` `WorkerKind` sketched in
`docs/architecture.md §1`.

`src/core/cli-agent-worker.ts` implements:

- `createCliAgentWorker(cliCommand, buildArgs, opts)` — the generic
  factory: spawns `cliCommand` as a child process via
  `node:child_process`'s `spawn`, captures stdout/stderr, and maps the
  exit code into the exact same `WorkerResult` shape (`{ ok, output,
  error }`) every other Worker in this scaffold produces. `kind` is
  reported as `"acp:<name>"`, matching the architecture doc's naming.
- `createClaudeCodeWorker(opts)` — pre-filled for the Claude Code CLI's
  documented non-interactive invocation: `claude -p "<task>"
  --output-format text` (`-p`/`--print`: "Print response and exit,
  useful for non-interactive mode", straight from `claude --help`).
- `createCodexWorker(opts)` — pre-filled for OpenAI Codex CLI's
  documented exec mode: `codex exec "<task>"` (plus `--sandbox
  workspace-write` by default so a delegated coding task can actually
  edit files, matching Codex's own documented automation flags).
- `createOpenCodeWorker(opts)` — pre-filled for OpenCode CLI's
  documented run mode: `opencode run "<task>"`.
- `detectCliAgent()` — probes `claude` / `codex` / `opencode` on PATH
  via `--version` (short timeout, no crash if none respond), the same
  "try everything available, admit clearly if nothing is" pattern
  `createModelFromEnvOrOllama` already uses in `models/real.ts`.

**Graceful degradation, matching the Ollama adapter's pattern exactly**:
if the target CLI isn't installed, `spawn` fails with `ENOENT`, which is
caught and turned into a clear `WorkerResult.error` ("... is not
installed or not resolvable on PATH ... the in-process Subagent
primitive remains fully usable without any external CLI") — never an
uncaught crash. A configurable timeout (`timeoutMs`, default 120s —
higher than `createLocalShellWorker`'s 30s since a full coding agent run
can legitimately take minutes) kills a hung child and returns a timeout
`WorkerResult` rather than hanging forever. `npm run demo`'s "1d.
Cross-harness delegation" section calls `detectCliAgent()` first and
prints a one-line skip message (not a failure) if nothing responds,
exactly like the demo already degrades gracefully around Ollama.

### Live-verification status on the machine this was built on

**Found**: Claude Code CLI (`claude.exe`, v2.1.247) is genuinely
installed on this machine, but under a version-numbered AppData folder
that is **not on PATH** (`where claude` fails; Windows desktop installs
don't add themselves to PATH the way the standalone CLI installer does).
`src/test-cross-harness-worker.ts` includes a documented, Windows-
specific fallback (`findClaudeExeOffPath()`) that locates it directly so
the live test isn't skipped just because PATH resolution fails.

**Live-tested**: the Worker's spawn/argument-construction/stdout-stderr-
capture/exit-code-mapping plumbing is fully verified — `claude.exe -p
"<task>" --output-format text` was actually spawned as a real child
process and its real output was correctly adapted into `WorkerResult`.

**NOT live-verified as a successful task delegation**: the installed
Claude Code CLI is not logged in in this non-interactive environment
(`claude.exe` returns `"Not logged in · Please run /login"`, exit code
1), which the Worker correctly reports as `WorkerResult.ok = false`
with that exact message in `error`/`output` — an honest finding, not a
fabricated pass. Interactive `/login` can't be scripted here. On a
machine with an authenticated Claude Code CLI (or `ANTHROPIC_API_KEY`
wired through `--settings`/env), the exact same code path would
complete the task and return `ok: true`.

Run `npm run test-cross-harness-worker` yourself to see the current
finding on your machine — it reports live-tested, not-installed, or
installed-but-not-authenticated distinctly rather than collapsing them
into one pass/fail bit. Unit-level tests (not dependent on any CLI being
installed) cover: a nonexistent binary resolves as a graceful
`WorkerResult.ok = false` rather than throwing, a hung child process is
killed by the timeout and returns promptly, and exit code 0 vs. nonzero
correctly map to `ok: true` vs. `ok: false` with stdout/stderr captured
into `output`/`error`.



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
`test-heartbeat`, `test-subagent`, `test-memory`, `test-memory-v2`,
`test-identity-wiring`, `test-memory-embeddings`) now
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
`rm -rf data` before a standalone run is no longer necessary
(including for `test-cross-harness-worker` and `test-memory-embeddings`,
both added after this fix).

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

## Agent identity — persona and defaultModel actually affecting behavior

Per `src/core/identity.ts`: `AgentIdentity` (`{id, name, persona,
createdAt, updatedAt}`) is registered via `registerAgentIdentity()` and
event-sourced over the `agent-identities` stream, same pattern as
everything else in this scaffold. **Previously this was read-only** — an
identity could be registered and read back (directly, or via
`/agent/identity/<agentId>.json` in the agent filesystem projection) but
nothing in the agent loop or model-selection logic ever consulted it. It
existed only as documentation of intent.

That's now wired through in two places:

**1. Persona → system message.** `runTurn()` (`agent-loop.ts`) looks up
`getAgentIdentity(agentId)` once per turn and, when a persona is
registered, renders it (`# Agent Identity\nYou are <name>. <persona>`)
as one more entry in the exact same `systemParts.filter(Boolean).join(...)`
array the skill catalog, curated memory, and tool-capability descriptions
already use — no separate mechanism, no special-casing. This is
deliberately **optional and additive**: an `agentId` with no registered
identity produces `getAgentIdentity() -> undefined`, which renders to an
empty string, which `filter(Boolean)` drops — so an unregistered agent's
system message (or lack of one) is byte-for-byte unchanged from before
this wiring existed. Proven in `src/test-identity-wiring.ts` by
inspecting the actual `messages` array a `createRecordingModel()`-wrapped
model receives (the same technique `test-memory.ts` uses for memory
injection).

**2. defaultModel → model selection.** The conceptual `Agent` type's
`defaultModel: string` field (`types.ts`) is, per `identity.ts`'s own
header comment, deliberately owned by `models/real.ts` rather than by
`identity.ts` itself — each facet of "Agent" lives with the subsystem
that already owns that concern (memory.ts owns memory, permissions.ts
owns policy, skills.ts owns skillCatalog). `models/real.ts` now has a
sibling event-sourced primitive: `setAgentDefaultModel(agentId, model)`
/ `getAgentDefaultModel(agentId)`, backed by its own
`agent-model-preferences` stream. `createModelForAgent(agentId,
ollamaOpts?)` is the actual wiring point — it looks up the agent's
preference and threads it through to `createModelFromEnvOrOllama()`.
`cli.ts`'s `runChat()` now calls `createModelForAgent(AGENT_ID)` instead
of calling `createModelFromEnvOrOllama()` directly.

**Precedence — read this before assuming a preference "picks the
model"**:
1. **Which provider** (Anthropic vs. OpenAI vs. Ollama vs. none) is
   decided *purely* by which env vars are set / which local services are
   reachable — exactly as before this wiring. A registered preference
   can never make a provider "available" that isn't already credentialed;
   an agent's stored data must not be able to conjure API access on its
   own.
2. **Which model name** is requested from that already-available
   provider *does* defer to the agent's registered preference when one
   exists (overriding the provider adapter's own hardcoded default model
   name, e.g. `claude-sonnet-4-5-...`). This is the part that's
   genuinely new — previously `defaultModel` was never read by anything.
3. With **no registered preference** for the given `agentId`,
   `createModelForAgent()` is behavior-identical to calling
   `createModelFromEnvOrOllama()` directly (regression-safe).

Scope note: this wiring makes an agent's *own* preference influence
model selection when the CLI/agent-loop resolves a model *for that
agent*. It does not add per-agent credential storage, does not change
what `createStubModel()`-based demo/test paths do (they never call
`createModelForAgent()`), and does not attempt any live validation that
a preferred model name is actually valid for the resolved provider — an
invalid model name still surfaces as a normal API error at request time,
same as manually mistyping `ANTHROPIC_MODEL` would.

`npm run test-identity-wiring` proves: persona text genuinely appears in
the system message sent to the model for an agent with a registered
identity; an agent with no registered identity is unaffected
(regression); `setAgentDefaultModel`/`getAgentDefaultModel` round-trip
and overwrite (not append) correctly; and `createModelForAgent()`
resolves to `undefined` when no provider is credentialed regardless of a
registered preference, matching rule 1 above.

## Repo layout

```
src/
  core/
    types.ts        # shared interfaces (Event, Task, Flow, Automation, ...)
    id.ts            # sortable id generator (no deps)
    eventlog.ts      # THE foundation — append/read/project over JSONL streams
    tasks.ts         # Task/Flow/Automation projections over the event log
    memory.ts         # episodic fast-path, dreaming promotion, retrieval, agent nominations
    text-similarity.ts # zero-dependency Jaccard similarity + optional Ollama-embedding upgrade w/ fallback
    hooks.ts          # deterministic lifecycle hooks, harness-run not model-run
    skills.ts          # agentskills.io SKILL.md parser + progressive-disclosure registry
    permissions.ts      # two-layer permission policy (hook) + sandbox (worker enforcement)
    identity.ts           # Agent identity store (name + persona) — persona now injected into runTurn()'s system message
    agentfs.ts              # /agent/... filesystem projection (read all paths, write skills only)
    scheduler.ts              # cron parser + tick loop + event/webhook dispatch for Automations
    eventbus.ts                # minimal in-process pub/sub, wires event-triggered Automations
    webhook.ts                   # real local HTTP listener for webhook-triggered Automations
    heartbeat.ts                   # the OTHER scheduling mode: imprecise timing, full session context
    subagent.ts                      # in-process delegation to a fresh, isolated agent-loop run
    worker.ts                          # execution-environment interface (local-shell, stub, sandboxed wrapper)
    cli-agent-worker.ts                  # OPTIONAL cross-harness Worker: shells out to claude/codex/opencode CLI
    model.ts             # swappable LLM adapter interface (stub adapter shipped)
    models/real.ts        # real Anthropic / OpenAI / Ollama adapters + per-agent defaultModel preference wiring
    agent-loop.ts          # the turn loop binding all of the above together (persona + memory + skills + tools)
  cli.ts                    # runnable end-to-end demo of every primitive above
  test-live-model.ts         # calls a real model adapter (not the stub) — see below
  test-cron.ts                # standalone cron parser/matcher regression tests
  test-eventbus.ts             # standalone event bus pub/sub + Automation-wiring tests
  test-webhook.ts                # standalone webhook listener tests (real HTTP server)
  test-skills-write.ts             # standalone skills write/round-trip tests
  test-heartbeat.ts                  # standalone Heartbeat scheduling-mode tests
  test-subagent.ts                     # standalone Subagent context-isolation tests
  test-cross-harness-worker.ts           # standalone cross-harness (external CLI) Worker tests — OPTIONAL primitive
  test-memory.ts                         # standalone memory dedup/split/injection tests
  test-memory-v2.ts                        # standalone similarity/retrieval/nomination tests
  test-identity-wiring.ts                   # standalone persona-injection + defaultModel-wiring tests
  test-memory-embeddings.ts                 # standalone embedding-similarity + fallback tests
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
