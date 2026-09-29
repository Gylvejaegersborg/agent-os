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
| Model abstraction (swappable adapter interface) | ✅ working — stub + real Anthropic/OpenAI/Ollama/Claude-CLI adapters, per-agent provider routing | `src/core/model.ts`, `src/core/models/real.ts`, `src/core/models/claude-cli.ts` |
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
| Observability (metrics derived from the event log, no new store) | ✅ working — task success/failure rates, automation fires by trigger kind, dreaming pass stats, subagent delegation count, turn latency | `src/core/observability.ts` |

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

## Model providers — one gateway, several providers

Each agent's model preference (`defaultModel`, set in BaseSpace's agent
editor or via `POST/PUT /agents`) can name its provider, so agents on the
same gateway can run on different ones:

| Preference | Provider | Needs on the gateway machine |
|---|---|---|
| `claude-cli:sonnet` (or `:opus`, `:haiku`, a full id) | Your Claude subscription through the official Claude Code CLI | `claude` installed and logged in once (`claude` → `/login`) |
| `anthropic:<model id>` | Anthropic API, pay per token | `ANTHROPIC_API_KEY` |
| `openai:<model id>` | OpenAI, or any OpenAI-compatible server | `OPENAI_API_KEY`, and/or `OPENAI_BASE_URL` (e.g. LM Studio `http://localhost:1234/v1`) |
| `ollama:<model>` (e.g. `ollama:llama3.2:3b`) | Local Ollama | `ollama serve` reachable |
| a bare name (`llama3.2:3b`, `claude-sonnet-5`, …) | As before: Anthropic → OpenAI → Ollama; a bare `claude-…` name uses the CLI when there's no Anthropic key | — |

A preference can only pick a provider the gateway already has access to;
anything else falls back to the default with a one-time warning.
`AGENT_OS_DEFAULT_MODEL` (same syntax) sets the default for agents without
a preference, e.g. `AGENT_OS_DEFAULT_MODEL=claude-cli:sonnet`.
`GET /providers` lists what this gateway can use.

**How `claude-cli` works** (`src/core/models/claude-cli.ts`): each model call
is one `claude -p --output-format stream-json` run, fed the conversation on
stdin, with Claude Code's own tools switched off (`--tools ""`). The model asks
for a tool with a `<tool_call>` block; because Claude sometimes falls back to
the shapes it was trained on (`<function_calls>` JSON or `<invoke>` XML,
`<call>`, OpenAI-style `function`/`arguments`), all of those are accepted,
only the first call is taken, and anything written after it is dropped —
that's where a model invents results. Agent-OS's
tools are described in the system prompt and the model asks for one with a
`<tool_call>{"name": …, "args": …}</tool_call>` block, which the adapter
turns back into a normal tool call — so plan mode, permissions, hooks,
approvals and the sandbox all still apply. This is the same way Orca and
Paperclip use a Claude subscription: through Anthropic's own CLI rather
than by sending the subscription's token to the API from a third-party app
(which is what the older `ANTHROPIC_TOKEN` path does). `CLAUDE_CLI_PATH`
overrides where the CLI is; `AGENT_OS_CLAUDE_CLI_TIMEOUT_MS` (default
180000) caps one call. `npm run test-model-router` covers it with a fake
CLI; it was also run live against a logged-in CLI.

**What a call costs, and what keeps it down.** Every model call resends the
whole system prompt, and through the CLI there's no prompt caching — so the
fixed part is paid again on every tool step. Measured on one caption hand-off
(Nyx on `claude-cli:haiku`, three calls): about 900 tokens of CLI overhead,
~870 of instructions and ~1,800 describing tools per call, and most of the
output was extended thinking. So:

- **Thinking is off by default** for `claude-cli` (`MAX_THINKING_TOKENS=0`).
  Turn it on for an agent that needs it with a `+think` suffix:
  `claude-cli:sonnet+think`.
- **Agents are only shown the tools they can use** (`offeredTools` in
  `agent-loop.ts`): tools the turn hasn't switched on are left out, and the
  gateway hides the shell and file tools from everyone but the builder agent
  (`setToolVisibility` in `tool-registry.ts`), along with the instructions
  that go with them. The `tool.before` hook is still what refuses them.
- **The tool list is compact text** (a line per argument), not a JSON
  Schema per tool. API providers still get their native tool format.
- **Settling a work item ends the turn**: after `work` done / blocked /
  hand-back there's no extra call to say "done".
- BaseSpace reads come back as compact JSON; context compaction sends no
  tools at all.

Same work item rerun after these changes (same snapshot, same model): 6,713
tokens in two calls (6,082 in / 631 out), down from 17,206 in three calls
(13,104 in / 4,102 out). One run each, so treat it as indicative.

## Terminals inside the OS — Claude Code in BaseSpace

With `AGENT_OS_TERMINAL=1`, the gateway runs interactive terminal sessions
that BaseSpace shows in the Workbench's **Terminal** panel: **Claude Code**
(the real, full `claude` CLI, logged in with your own subscription) or a
**shell**. Both start in BaseOStest's checkout (`BASEOS_REPO_DIR`), so Claude
Code works on the OS itself. The first time, pick a theme and run `/login`;
that same login is what the `claude-cli:` model provider uses.

- The gateway owns the processes (`src/gateway/terminal.ts`): closing the
  panel or reloading the page leaves them running, and reopening re-attaches
  with recent scrollback. They end when the gateway restarts.
- Plain HTTP, no WebSocket: output streams over SSE
  (`GET /terminals/:id/stream`), keystrokes are `POST /terminals/:id/input`,
  plus `POST /terminals` (`{profile: "claude" | "shell", cols, rows}`),
  `POST /terminals/:id/resize`, `DELETE /terminals/:id` and `GET /terminals`.
- PTY: `node-pty`, an **optional** dependency (it compiles a native module;
  if that fails, `npm install` still succeeds). Without it, util-linux's
  `script` provides the PTY and everything works except live resizing.
  `AGENT_OS_TERMINAL_BACKEND=script` forces the fallback.
- **Off by default, and it's a full shell as the gateway's user.** The
  gateway has no auth, so only enable it where the gateway is reachable by
  you alone. BaseOStest's Codespace turns it on because forwarded ports are
  private to your GitHub login by default; never make them public while it's
  on. (Anyone who can reach the gateway could already approve the `claude`
  agent's shell commands, so this widens less than it sounds, but it skips
  approvals entirely.)

`npm run test-terminal` covers both PTY backends through the real routes.

## The OS over MCP — for Claude Code and other MCP clients

`POST /mcp` makes the gateway an MCP server (Model Context Protocol,
Streamable HTTP in its simplest form: one JSON-RPC request per POST, a JSON
reply; no dependency). Tools (`src/gateway/mcp.ts`):

| Tool | Does |
|---|---|
| `basespace_read` | Reads the BaseSpace snapshot (summary, notes, projects, todos, events, crons, teams) |
| `basespace_add` | Adds a note, todo or project update to BaseSpace (internal to the operator's own dashboard) |
| `list_agents` | The agent team: role, model, status, capabilities |
| `ask_agent` | Runs a turn with an agent, exactly like chatting in the Workbench; `sessionId` continues it |
| `list_approvals` | The approval queue, read-only |

There is deliberately no tool that approves or rejects: that stays with the
operator. Every Claude Code session started from the Terminal panel gets
this server automatically (`--mcp-config`) plus a line of context saying it
runs inside the OS. Any other MCP client can use it too:

```bash
claude mcp add --transport http agent-os http://127.0.0.1:8787/mcp
```

Same trust as the rest of the gateway: no auth, so keep it private.
`npm run test-mcp` covers it; it was also verified with the real Claude
Code CLI.

## Goals and focus — the "why" behind the work

BaseSpace goals (what the work is for) link projects, sub-goals, notes and
todos; the snapshot carries those links, and agents read them with the
`basespace` tool (`section: goals`; a goal or project read by id comes with
its chain, linked notes and open todos).

A session can be **focused** on a goal or project — `POST /sessions` with
`{focus: {kind: "goal" | "project", id}}`, or `PUT /sessions/:id/focus`
(`{focus: null}` clears it). Each turn in a focused session then gets a
"What this work serves" block (`focusContext()` in `src/core/basespace.ts`):
the project's status and next moves, the goal chain up to the top goal with
each goal's *why* and target, linked notes (with ids to read them), and the
open todos serving it. Once per turn, from the snapshot — no model call.

Continuity back into BaseSpace: a note an agent adds from a focused session
gets a `Serves: [[Name]]` link (so it shows under that goal/project), a todo
gets its `projectId`/`goalId`, and a `project-update` defaults to the
focused project. Subagents inherit the focus (session and Task). Over MCP,
`ask_agent` and `basespace_add` take `goalId`/`projectId`.

`npm run test-goals` covers it.

## Work — handing tasks between agents

Agents hand each other work as tracked **work items** (`src/core/work.ts`),
not chat messages — Paperclip's model:

- **Reporting lines**: each identity can have `reportsTo` (set in BaseSpace's
  agent editor, or `PUT /agents/:id {reportsTo}`; `null` = the operator).
  Seeded once: Nyx, Aether, Hermes, Theia, Mnemosyne → Hemera; Hemera, Argus
  and Claude → the operator. Loops are rejected. Each turn gets a "Your team"
  block: who you report to, who reports to you, what's assigned to you.
- **Tools**: `delegate {to, title, detail?}` creates an item for a teammate
  (it keeps the thread's goal/project focus); `work {action: list | done |
  blocked | hand-back | note | cancel, id?, text?}`.
- **Rules**: one assignee, claimed atomically; the assignee can't cancel —
  it finishes, marks it blocked with a reason, or hands it back to its
  manager (no manager → blocked for the operator); only the requester or
  the operator cancels; at most 3 hand-offs deep; handing work straight
  back to whoever asked is refused. Tokens spent working an item are
  recorded on it, and `totalTokens` includes everything it was split into.
- **Runner** (`src/gateway/work-runner.ts`, `AGENT_OS_WORK_RUNNER=off` to
  disable): works open items one at a time (`AGENT_OS_WORK_CONCURRENCY`), in
  a fresh session for the assignee with the item's focus; skips paused or
  over-budget assignees until that lifts. A turn that ends with a real
  answer completes the item with it (if the agent didn't call `work`
  itself); one that stopped — a refused tool, a pending approval, out of
  tool steps (`AgentTurnResult.stopReason`) — leaves it blocked with why. The
  outcome is posted into the requester's thread as a `[Work]` note; no turn
  runs on the requester's side, so agents can't ping-pong.
- **HTTP**: `GET /work?assignee=&requestedBy=&involving=&team=&status=`
  (`team`: a lead's own work plus its reports'), `GET /work/:id`, `POST /work
  {assignee, title, detail?, focus?}` (as the operator), `POST
  /work/:id/cancel|reopen|reassign|note`. **MCP**: `assign_work`, `list_work`.

`npm run test-work` covers it; it was also run live on the Claude CLI.

### Team review — leads manage their team's work

A lead (any agent with reports; Hemera by default) reviews its team's work
(`core/review.ts`, run by `gateway/review-loop.ts`), after Paperclip's
heartbeat.

- **The digest is plain code, with no model call**: its reports' blocked
  work, work handed back to it, and work with no movement for
  `AGENT_OS_STALE_HOURS` (default 24). Each item carries who asked and what for,
  so the lead decides from the digest instead of searching for context.
- **A model turn only when needed**: something needs attention *and* it
  differs from what the lead saw at its last review. An unchanged team costs
  nothing.
- **The lead acts through `work`**: `reopen {id, text}` with guidance,
  `reassign {id, to, text}`, `escalate {id, text}` to the operator (the item
  shows as "needs you" until it moves), or `delegate`. Only the requester,
  the assignee's manager or the operator may do these; an assignee still
  can't cancel. A review turn offers only `work`, `delegate` and `basespace`,
  with two tool steps per item.
- **When**: every `AGENT_OS_REVIEW_INTERVAL_MIN` (240), and
  `AGENT_OS_REVIEW_DEBOUNCE_MIN` (10) after work is blocked or handed back.
  At most `AGENT_OS_REVIEW_MAX_PER_DAY` (6) automatic reviews per lead;
  paused or over-budget leads are skipped. Each lead reviews in one
  long-lived "Team review" thread. Off with `AGENT_OS_REVIEW=off`.
- **HTTP**: `GET /reviews?agentId=` (leads, past reviews with tokens and
  summary), `GET /reviews/:id/digest` (free), `POST /reviews/:id` (review
  now, even if nothing changed).

Live on `claude-cli:haiku`: Nyx blocked on a cover-photo pick (no access to
the shoot files). Hemera's first review browsed BaseSpace for all 8 steps
and never acted (64k tokens). With the digest carrying the ask, the focused
tool set and step limit, the next review escalated it to the operator in one
call (12k tokens), naming exactly what was missing. `npm run test-review`
covers the rules.

## Governance gates — hires and plans need you

After Paperclip's board: the team can grow and plan, but you sign off first
(`core/governance.ts`).

- **`propose-agent`**: a lead proposes hiring a teammate (id, name, role,
  persona, who it reports to, optional model, and why).
- **`propose-plan`**: a lead proposes a plan for a goal, with up to 8 steps
  for teammates. On approval each step becomes a work item serving the goal,
  reported back to the proposing thread.
- **Enforced in the harness, not a hook.** `runTurn()` never runs either
  one; it files an approval and stops the turn, and dispatch refuses them
  unless the operator approved (the gateway's `executeApprovedCall` path).
  Proposing the same thing again reuses the pending request. Neither can be
  always-allowed (`allowlist.ts` refuses), and only leads are offered them.
- **Checked before filing.** A proposal with a problem (an id that exists, a
  thin persona, a step assigned to the lead itself, an unknown agent or goal)
  isn't filed; the problem goes straight back to the agent to fix. Plans are
  all-or-nothing.
- On approval, a hire is registered under its proposer with the roster's
  BaseSpace defaults and no budget (you set that). BaseSpace shows both
  proposals as readable cards in Approvals.

**Agent config history.** An agent's name, role, persona, reporting line,
model and budget are all events already; `listAgentRevisions()` folds them
into a numbered history. `restoreAgentRevision()` writes a restore as new
events, marked `restoredFrom`, so a restore can itself be undone. Routes:
`GET /agents/:id/revisions`, `POST /agents/:id/revisions/:rev/restore`
(operator-only). BaseSpace: agent editor → History.

Live on `claude-cli:haiku`: Hemera proposed hiring Lyra (sync licensing).
Her first plan for the Switch goal assigned step 1 to herself; that's what
led to the pre-filing check. The re-proposed plan was approved in BaseSpace
and became three work items for Nyx, Aether and Hermes, which the runner
picked up. `npm run test-governance` covers the rules.

## Watchdog — a verifier checks finished work

After Paperclip's verifier: "trust, but verify" for handed-off work
(`core/watchdog.ts`).

- **Opt in**: on a work item, or on an approved plan, for the item and
  everything it's split into.
  - Agents: `delegate {verify: true}`, `propose-plan {verify: true}`.
  - HTTP: `POST /work {verify: true}`, `POST /work/:id/verify`.
  - MCP: `assign_work {verify: true}`.
  - BaseSpace: the Assign form's checkbox, or "Verify when done" on an item.
- **When everything under a watch has stopped** (done, blocked or
  cancelled), the verifier gets one verification work item: Argus, or
  `AGENT_OS_VERIFIER`. Its evidence is assembled in code, not left to the
  verifier to dig for: each item's brief and claimed result, next to the tool
  calls that really ran in its session (the `work` bookkeeping call excluded)
  and the text of what it added to BaseSpace.
- **The verifier reports, it doesn't fix.** It runs with only `work` and
  `basespace`, and may reopen or escalate the items it's verifying, nothing
  else. A reopened item (a done one can be reopened now) re-runs with the
  reason at the top of its brief, and is verified again. After two rounds
  the watch is left for the operator ("verification needs you"). If a
  verifier sends items back but runs out of steps before writing a verdict,
  its reasons become the verdict.
- The verdict goes back to the thread the watch came from as a `[Work]`
  note. `GET /watches` lists watches and verdicts. Off with
  `AGENT_OS_WATCHDOG=off`.

Live on `claude-cli:haiku`, two watched items. The first run exposed four
problems, all now fixed:
- The `basespace` tool couldn't see what agents had just added, so the
  verifier sent back finished work. Reads now include the overlay.
- Hermes added one note five times. The same title from the same agent now
  updates the note.
- A re-run wasn't told why it had been sent back, and Nyx spent 112k tokens
  redoing her research. Re-runs now get the reason.
- Verdicts were lost when the verifier ran out of steps.

The second run:
- Nyx's captions were accepted in one round (59k tokens).
- Argus caught Hermes listing a distributor as a curator and sent it back;
  Hermes fixed it.
- In round two, Argus flagged Hermes' unbacked claim that the contacts were
  "verified". He passed his own verification's id and was refused, so the
  item wasn't sent back. Such a call now maps to the checked item.

`npm run test-watchdog` covers it with the real runner and a scripted team.

## Board controls — pause, resume, budgets

The operator's live levers over each agent (`src/core/controls.ts`, from
Paperclip's "board powers"):

- **Pause/resume:** `POST /agents/:id/pause` (`{reason?}`) and
  `POST /agents/:id/resume`. A paused agent takes no new turns.
- **Budgets:** `PUT /agents/:id/budget` with `{period: "day" | "week" |
  "month", limitTokens, warnAt?}` (`limitTokens: null` removes it). An
  `agent.budget.warning` event fires once at `warnAt` (default 80%) and
  `agent.budget.exceeded` once at the limit; from then on new turns are
  refused until the period rolls over (UTC) or the limit is raised — the
  block is derived from usage, never stuck.
- Enforced in `runTurn()`, so it covers chat, flows, crons, heartbeats,
  subagents and MCP. A refused turn is written to the session with the
  reason and answered with HTTP 409 `{blocked}`. Crons, heartbeats and
  automations skip a blocked agent instead of recording failures. A turn
  already running finishes.
- Tokens, not dollars: what each provider reports (the Claude CLI includes
  cached input). Every agent record carries `control` (pause, budget, this
  period's usage, `blocked`). No agent tool can change any of this.

`npm run test-controls` covers it.

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
(including for `test-cross-harness-worker`, `test-memory-embeddings`,
and `test-observability`, all added after this fix — `test-observability`
was initially merged without the import, found and fixed during the
7-way parallel-subagent merge, and re-verified back to back).

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

## Observability — metrics derived from the event log

Per this scaffold's core design principle, there is **no separate
metrics store**. `computeMetricsSnapshot(agentId?)` in
`src/core/observability.ts` is a pure read-side projection — exactly
like `getTask`, `getCuratedMemory`, or every other `project()` call in
this codebase — that replays the SAME event streams every other
primitive already reads and writes (`tasks`, `automations`,
`memory:<agentId>:dreaming`, `session:<sessionId>`) and derives numbers
fresh on every call. Nothing is incremented on write; delete the whole
snapshot and recompute it from `data/streams/*.jsonl` and you get the
exact same answer.

Numbers exposed, and exactly how each is computed:

| Field | Computed from |
|---|---|
| `tasks.byStatus` (queued/running/succeeded/failed/timed_out/cancelled/lost) | `listTasks()` (tasks.ts) over the `tasks` stream, tallied by current `TaskStatus` |
| `tasks.successRate` / `tasks.failureRate` | `succeeded` / `failed` divided by the count of tasks that reached ANY terminal status (`null` until at least one task finishes, never a misleading `0`) |
| `tasks.subagentDelegationCount` | count of `Task.type === "subagent"` — the same Tasks `subagent.ts`'s `spawnSubagentTask()` creates |
| `automations.firesByTriggerKind` (cron/event/webhook) | every `automation.fired` event in the `automations` stream, joined against each automation's registered `trigger.kind` via `listAutomations()` |
| `dreaming.totalPasses` / `totalEpisodicEntriesReviewed` / `totalPromoted` / `totalHeld` / `totalDiscarded` | every `memory.dreaming.completed` event across each agent's `memory:<agentId>:dreaming` stream, summing `DreamingPass.promotions[].decision` |
| `turnLatency.avgMs` / `minMs` / `maxMs` / `sampleCount` | pairing each `agent.turn.start` with its following `agent.turn.end` in every `session:<sessionId>` stream and diffing their ISO timestamps (agent-loop.ts's `runTurn()` appends exactly one of each per call) |

`agentId` is optional everywhere: omit it for a whole-system snapshot,
or pass one to scope tasks/automations/dreaming/turn-latency to a
single agent (automation fire counts naturally include only that
agent's registered automations).

The same snapshot is also reachable through the agent filesystem
namespace above, read-only, at **`/agent/metrics/summary.json`**
(`fsList("/agent")` now lists a `metrics/` entry alongside
`tasks/`/`flows/`/etc.) — following `agentfs.ts`'s existing
`fsList`/`fsRead` dispatch pattern exactly, no new code path.

Verified end-to-end (not mocked) by `npm run test-observability`: it
creates real Tasks across every terminal status plus two real
`spawnSubagentTask()` delegations, registers and fires one real
automation per trigger kind (`runSchedulerTick`, `fireEventAutomations`,
`fireWebhookAutomations`), writes real episodic entries and runs two
real `runDreamingPass()` calls (one promoted, one held, then a second
pass proving the "reviewed every time, re-appended only once" audit
behavior still shows up correctly in the aggregate), runs real
`runTurn()` calls, and asserts `computeMetricsSnapshot()` — both called
directly and read back through `fsRead("/agent/metrics/summary.json")`
— reports the exact counts that actually landed in the event log (34
assertions total). `npm run demo`'s "9. Observability" section then
prints a live snapshot aggregated over everything the earlier demo
sections generated.

## BaseSpace bridge — agents see and add to the operator's dashboard

BaseSpace (the BaseOStest repo) is the operator's dashboard: notes, projects,
todos, calendar, cron jobs and teams. `src/core/basespace.ts` connects it to the
agents with two JSON files under the data dir:

| File | Written by | Read by |
| --- | --- | --- |
| `basespace/snapshot.json` | BaseSpace, `POST /basespace/snapshot`, a few seconds after anything changes | agents, via the `basespace` tool |
| `basespace/overlay.json` | agents, via the `basespace-add` tool | BaseSpace, `GET /basespace/overlay` (polled every 30 s) |

- `basespace` — `section` = summary · notes · projects · todos · events · crons · teams,
  plus optional `query` (text filter) or `id` (one item in full; notes are listed without
  their text until asked for by id). Read-only: agents never rewrite the operator's items.
- `basespace-add` — `kind` = `note` {title, body, folder?} · `todo` {title, due?, time?,
  priority?, notes?} · `project-update` {projectId, text}. Internal to the operator's own
  dashboard, so not approval-gated; anything outward-facing still goes through approvals.
- `DELETE /basespace/overlay/:kind/:id` removes an agent-added item.

The gateway tells agents about these in their system message (`enableBaseSpace`).

**Team meetings.** Cron jobs that BaseSpace tags with a team (Workbench → Teams →
Schedule standup) are run here by `src/gateway/basespace-crons.ts`: at each slot the
team lead chairs a turn that reads BaseSpace and writes the minutes back as a note in
`Team/Meetings`, plus todos for the operator. Runs are ordinary `cron` Tasks. Missed
slots older than 15 minutes aren't replayed. BaseSpace's other cron jobs are
descriptive and are not executed. Turn it off with `AGENT_OS_BASESPACE_CRONS=off`.

**Tools reach real models now.** Before this, the gateway created its model adapters
without a tool list, so Anthropic/OpenAI/Ollama models were never told any tool existed
(only the stub model ever "called" one). Adapters now fall back to every tool in the
registry (`registryToolSpecs()` in `models/real.ts`).

## Hindsight — optional long-term memory

[Hindsight](https://github.com/vectorize-io/hindsight) (MIT) is an agent memory service:
it extracts facts, entities and experiences from what you give it (retain), finds what's
relevant later (recall) and reasons over it (reflect). `src/core/hindsight.ts` adds it
next to the built-in episodic → dreaming → curated pipeline. It's off unless
`HINDSIGHT_URL` is set, and every call has a short timeout and fails quietly, so a
down Hindsight never breaks a turn.

When it's on:

- every completed exchange and every episodic memory write is retained into the
  agent's own bank (`<HINDSIGHT_BANK_PREFIX or "agent-os">-<agentId>`);
- each turn's system message gets a "Recalled from long-term memory" block for the
  user's message (recalled once per turn, not on every tool step);
- agents get a `recall-memory` tool ({query, deep?}; `deep` uses reflect).

Run it (one container with its own embedded Postgres; it needs an LLM key for fact
extraction):

```bash
docker run -d --name hindsight --restart unless-stopped -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest

HINDSIGHT_URL=http://127.0.0.1:8888 npm run gateway
```

Without Docker (a Codespace has none), run the same server through `uv`, here with
a local Ollama doing the fact extraction:

```bash
HINDSIGHT_API_LLM_PROVIDER=ollama HINDSIGHT_API_LLM_MODEL=llama3.2:3b \
HINDSIGHT_API_LLM_BASE_URL=http://localhost:11434/v1 \
  uvx --from hindsight-api==0.10.1 hindsight-api --port 8888 --idle-timeout 0
```

It refuses to run as root (its embedded Postgres won't). In a BaseOStest Codespace, set
the secret `HINDSIGHT_ENABLED=1` and `.devcontainer/hindsight.sh` does this for you.

Optional: `HINDSIGHT_API_KEY` (Bearer token), `HINDSIGHT_BANK_PREFIX`,
`HINDSIGHT_RECALL_TOKENS` (default 600). The Hindsight UI is on port 9999.

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
    observability.ts          # read-only metrics projection over the event log (no new store)
    scheduler.ts              # cron parser + tick loop + event/webhook dispatch for Automations
    eventbus.ts                # minimal in-process pub/sub, wires event-triggered Automations
    webhook.ts                   # real local HTTP listener for webhook-triggered Automations
    heartbeat.ts                   # the OTHER scheduling mode: imprecise timing, full session context
    subagent.ts                      # in-process delegation to a fresh, isolated agent-loop run
    worker.ts                          # execution-environment interface (local-shell, stub, sandboxed wrapper)
    cli-agent-worker.ts                  # OPTIONAL cross-harness Worker: shells out to claude/codex/opencode CLI
    model.ts             # swappable LLM adapter interface (stub adapter shipped)
    models/real.ts        # real Anthropic / OpenAI / Ollama adapters, provider router + per-agent defaultModel wiring
    models/claude-cli.ts  # Claude through the official Claude Code CLI (your subscription), Agent-OS keeps the tools
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
  test-observability.ts                      # standalone end-to-end metrics-projection tests
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
