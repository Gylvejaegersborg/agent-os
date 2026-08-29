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
| Automation registry + scheduler (cron tick loop + manual event dispatch) | ✅ working — Heartbeat mode NOT implemented (see below) | `src/core/scheduler.ts` |
| **Memory: fast-path episodic + gated "dreaming" promotion** | ✅ working | `src/core/memory.ts` |
| Hooks (deterministic, harness-run, decision vs. observe-only) | ✅ working | `src/core/hooks.ts` |
| Standing Order (deliberately NOT a data object) | 📝 documented only | `docs/architecture.md §2` |
| Skills (agentskills.io-compatible format) | ✅ working — parser, discovery, progressive disclosure | `src/core/skills.ts`, `skills/*/SKILL.md` |
| Sandboxing / permission policy (two-layer) | ✅ working — Layer A (policy hook) + Layer B (sandboxed worker) | `src/core/permissions.ts` |
| Agent filesystem namespace | ✅ working — read-only projection over paths (skills/memory/sessions/tasks/flows/automations) | `src/core/agentfs.ts` |

The memory design directly answers "I want the agent to keep getting
better with me, safely": episodic writes are immediate and ungated (same
immediacy as Hermes' memory tool today); the **only** path into permanent
curated memory is a deterministic scoring function (`scoreEligibility` in
`memory.ts`) that a background "dreaming" pass runs — the model is only
ever used to *phrase* what code already qualified, never to *decide* what's
worth remembering. Full provenance is kept for every promotion.

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

**Known scaffold limitation** (documented, not hidden): the current
`checkSandbox` filesystem-scope check is a simple pattern match (`../`
detection), not an OS-level enforcement boundary (Landlock, Seatbelt, a
real container). That's an intentional "prove the layer separation first"
choice — see `docs/architecture.md §6` for what a production sandbox
needs on top of this.

## Scheduler — Automations that actually fire

Per `docs/architecture.md §2`'s "two scheduling modes" note. This
scaffold implements ONE of the two explicitly:

- **Automations** (implemented, `src/core/scheduler.ts`) — precise
  timing, isolated context. A zero-dependency 5-field cron parser
  (`parseCron`/`cronMatches`) plus a real tick loop (`startScheduler`,
  default 30s interval) that checks every enabled cron-triggered
  Automation and fires the ones that are due. Firing spawns a real Task
  (`type: "cron"`) and runs a full agent-loop turn in a brand-new,
  isolated session — never the automation's own history, matching
  "isolated context" from the architecture doc. Every firing is itself
  event-sourced (`automation.fired` events in the same `automations`
  stream `tasks.ts` already writes to), which is also how dedup works:
  an automation can fire at most once per matching minute, so a
  scheduler restart never double-fires or loses its place.
- **Heartbeat** (imprecise timing, full main-session context, for "check
  the inbox"-style work) is a genuinely different mechanism — a
  recurring turn in an existing long-lived session, not a spawned
  isolated Task — and is **NOT implemented** here. Stated explicitly
  rather than half-built alongside Automations.

`event`-triggered automations are implemented as a manual dispatch
function (`fireEventAutomations`) rather than a tick, since this
scaffold has no event bus yet — call it from wherever the real event
happens. `webhook`-triggered automations are not implemented (would need
an actual HTTP listener).

Verified with `npm run test-cron` (9 assertions covering step values,
ranges, weekday matching, and malformed-input error handling) plus
`npm run demo`'s "5. Scheduler" section, which registers a cron
automation matching the current minute, runs a real tick, and proves:
the automation fires and creates a real Task; a second tick in the same
minute does NOT re-fire (dedup); and a tick one minute later does not
fire either (the cron expression no longer matches).

## Agent filesystem namespace — the same primitives, addressed as paths

Per `docs/architecture.md §7`: a read-only projection that exposes
everything above as a virtual `/agent/...` filesystem, e.g.
`/agent/identity/<agentId>.json`, `/agent/skills/<name>/SKILL.md`,
`/agent/memory/<agentId>/curated/MEMORY.md`,
`/agent/sessions/<sessionId>.jsonl`, `/agent/tasks/<taskId>/state.json`.
This is deliberately **not a new storage layer** — every path is a VIEW
over the exact same event-log streams and skill files the rest of this
scaffold already writes, using the same "everything is a projection"
principle from the top of this README, just applied to a filesystem-
shaped API (`fsList`/`fsRead` in `agentfs.ts`) instead of an event-log-
shaped one.

Write operations through this namespace are intentionally NOT
implemented — mapping a raw file write back onto event-log semantics
(an appended event? a new event type?) is a real design question, not
something to paper over with a fake write that doesn't actually persist
correctly.

`npm run demo`'s "6. Agent filesystem" section walks every path kind
(skills, curated + episodic memory, sessions, tasks) against the exact
data the earlier demo sections just wrote, and confirms a nonexistent
path throws rather than returning something misleading.

## Repo layout

```
src/
  core/
    types.ts        # shared interfaces (Event, Task, Flow, Automation, ...)
    id.ts            # sortable id generator (no deps)
    eventlog.ts      # THE foundation — append/read/project over JSONL streams
    tasks.ts         # Task/Flow/Automation projections over the event log
    memory.ts         # episodic fast-path + dreaming promotion pipeline
    hooks.ts          # deterministic lifecycle hooks, harness-run not model-run
    skills.ts          # agentskills.io SKILL.md parser + progressive-disclosure registry
    permissions.ts      # two-layer permission policy (hook) + sandbox (worker enforcement)
    identity.ts           # minimal Agent identity store (name + persona), backs /agent/identity
    agentfs.ts              # read-only /agent/... filesystem projection over everything above
    scheduler.ts              # cron parser + tick loop that makes Automations actually fire
    worker.ts                   # execution-environment interface (local-shell, stub, sandboxed wrapper)
    model.ts             # swappable LLM adapter interface (stub adapter shipped)
    models/real.ts        # real Anthropic / OpenAI / Ollama adapters
    agent-loop.ts          # the turn loop binding all of the above together
  cli.ts                    # runnable end-to-end demo of every primitive above
  test-live-model.ts         # calls a real model adapter (not the stub) — see below
  test-cron.ts                # standalone cron parser/matcher regression tests
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
