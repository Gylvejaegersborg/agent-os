# Harness feature-parity roadmap

Tracks agent-os/BaseOS Workbench against what Claude Code and Codex ship,
from the comparison done 2026-09-13. The goal stated at the start of this
project: splice the best of every harness studied, not just build
something that technically works. Items are tagged by where the work
lives — **[core]** agent-os's runtime, **[gateway]** its HTTP surface,
**[UI]** BaseOStest's Workbench.

Check items off as they land; add new ones as real gaps are found (the
same way every item below was found — by checking what's actually wired
into the LIVE gateway, not just what exists somewhere in the codebase).

## Done

- [x] Structured `read_file`/`edit_file`/`write_file` tools, replacing
      raw shell redirection for file changes — **[core]** `agent-loop.ts`,
      `permissions.ts`'s `checkPathSandbox()`; **[gateway]** restricted to
      `ENGINEER_AGENT_ID` same as `shell`.
- [x] Diff rendering for `edit_file`/`write_file` approvals — **[UI]**
      `ApprovalsTab.tsx`'s `ToolCallPreview`.
- [x] Real shell/filesystem access, scoped to one agent (`claude`) and
      sandboxed — **[core]** `SandboxPolicy.additionalRoots`; **[gateway]**
      `cli.ts`'s `FILESYSTEM_TOOLS` restriction + `buildEngineerPolicy()`.
- [x] Subagent delegation, memory nominations, and artifact recording
      turned on for every turn and every Flow step — **[gateway]**
      `startGateway()`'s `enable*` flags; **[core]**
      `DriveFlowOptions` gained the same fields.
- [x] The memory dreaming pass actually runs — **[core]**
      `startMemoryDreamingSweeper()`; **[gateway]** wired into `cli.ts`.
- [x] Memory visibility in the UI (curated memory, pending nominations,
      episodic log) — **[gateway]** `GET/POST /agents/:id/memory...`;
      **[UI]** `MemoryTab.tsx`.
- [x] The skills system (agentskills.io-format instructions) is actually
      live — **[core]** `SkillRegistry` constructed in `cli.ts`;
      **[gateway]** `GET/POST/DELETE /skills`; **[UI]** `SettingsModal.tsx`.
- [x] `cancelFlow()` publishes live events (was silently inert) —
      **[core]** `tasks.ts`.
- [x] Task/Flow-step output is actually visible, not truncated to one
      Events-tab line — **[UI]** `TasksTab.tsx`/`FlowTab.tsx`.
- [x] Flows can be saved as drafts instead of only started immediately —
      **[UI]** `NewFlowModal.tsx`.
- [x] Streaming for every provider. CORRECTION to the original
      comparison: real token-by-token streaming already existed
      end-to-end for Anthropic before this round — it was wrong to call
      streaming "missing" generally. What was actually true: Ollama's
      adapter had no `completeStream`, so the Codespace's actual default
      provider fell back to a single non-streamed response. Added, using
      the same `/v1/chat/completions?stream=true` OpenAI-compatible SSE
      shape the non-streaming path already spoke — **[core]**
      `models/real.ts`.
- [x] Cost/token usage tracking — as raw token counts, deliberately not
      a dollar estimate (no reliable source of truth for current
      per-model pricing). `ModelResponse.usage`, summed per turn and
      aggregated per session — **[core]** `agent-loop.ts`'s
      `getSessionUsage()`; **[gateway]** `GET /sessions/:id/usage`;
      **[UI]** a small badge in `ThreadHeader.tsx`.
- [x] Plan / read-only mode — a real harness-level block, not a prompt
      suggestion: `shell`/`edit_file`/`write_file`/`subagent` are
      refused outright when `planMode` is set, checked BEFORE Layer A's
      `PermissionPolicy` so no "allow" rule overrides it; `read_file`/
      `skill`/`nominate-memory`/`record-artifact` stay available since
      none of them mutate anything. Per-request, not a gateway-wide
      default — a client toggles it per message. **[core]**
      `agent-loop.ts`'s `PLAN_MODE_BLOCKED_TOOLS`; **[gateway]**
      `POST /sessions/:id/turns`'s `planMode` body field; **[UI]** an eye
      icon in `ConversationPane.tsx`'s composer, per-message.
- [x] User-configurable hooks — a plain JSON file (`hooks.json`) any
      operator can edit without touching code, each entry shelling out
      to a command when its event fires (exit 0 = allow, nonzero =
      block with stdout as the reason, for decision events like
      `tool.before`). Deliberately file-based and restart-required, not
      hot-reloadable — `hooks.ts`'s registry has no removal-by-source
      mechanism, so there's nothing safe to hot-swap; editing the file
      (directly, or by asking the Engineer agent, which already has
      real file-tool access) plus a gateway restart is the honest
      contract. **[core]** `configured-hooks.ts`; **[gateway]**
      `GET /hooks` (read-only visibility, no write endpoint for the
      same reason); **[UI]** a read-only list in `SettingsModal.tsx`.
- [x] Skill marketplace / install-from-elsewhere — scoped to its
      smallest useful version: fetch a raw SKILL.md from any URL (a
      GitHub raw link, a gist, a shared file server — no registry
      protocol assumed, since there isn't a standard one to assume),
      validated through the EXACT same `parseSkillFile()` a
      hand-authored skill goes through, then persisted + hot-registered
      the same way `POST /skills` already does. A human-triggered
      settings action; no new gating beyond what the rest of `/skills`
      already has none of. **[gateway]** `POST /skills/install`.
- [x] Context compaction — additive, not destructive: `getSessionHistory()`
      (the durable, full log) is completely untouched, forever; a NEW
      `getModelFacingHistory()` is what `runTurn()` actually feeds the
      model, collapsing anything before the most recent
      `COMPACTION_KEEP_RECENT` messages into one summary once history
      crosses a char threshold, written by a REAL call to the same model
      adapter the turn is already using (not hardcoded truncation). A
      second compaction folds the previous summary back in rather than
      starting over or duplicating. A failed summarization call is
      logged and swallowed — compaction is a nicety, never something
      that should be able to fail a turn that would have otherwise
      succeeded uncompacted. **[core]** `agent-loop.ts`'s
      `maybeCompactSession()`/`session.compacted` event.
- [x] Checkpoint / rewind — scoped down HONESTLY rather than attempted in
      full: this is per-file undo for `edit_file`/`write_file`
      mutations, not Claude Code's full "rewind conversation + files
      together to an arbitrary point in time." Every successful mutation
      records the file's content immediately BEFORE it changed; restoring
      a revision writes that content back (or deletes the file, for a
      revision where it didn't exist before) and is itself recorded as a
      new, undoable revision — same "append, never delete history"
      posture as the rest of this codebase. What this does NOT do:
      snapshot the conversation itself, treat a multi-file change as one
      transaction, or let you jump to an arbitrary point in a session —
      that's the real remaining gap if full checkpoint/rewind is ever
      built. **[core]** `file-revisions.ts`; **[gateway]**
      `GET /files/revisions`, `POST /files/revisions/:id/restore`
      (sandbox-checked); **[UI]** a "Files" tab in the Workbench listing
      revisions with a Restore button per entry.

## Open

Roughly in priority order — each one is a real, checkable gap, not a
vague aspiration. Re-verify the "why" before starting any of these;
codebases drift, and at least one gap in the original comparison
(real token streaming) turned out to be partially wrong once actually
checked — see the correction below.

- [ ] **MCP (Model Context Protocol) support.** The tool registry is
      closed — `shell`/`skill`/`subagent`/`nominate-memory`/
      `record-artifact`/`read_file`/`edit_file`/`write_file`, nothing
      pluggable in from an external server. **[core]**
- [ ] **Multimodal input.** The Workbench chat is text-only — no
      image/screenshot attachment support in `useAgentOsChat`/
      `ConversationPane`, and no corresponding support in `model.ts`'s
      `ModelMessage`. **[core]** **[UI]**
- [ ] **Cancellation genuinely preempts an in-flight step.** Documented,
      accepted limitation today (cancellation stops scheduling NEW work,
      never an in-flight model call) — revisit if it keeps being
      friction in practice, since this is a real architectural change
      (would need an abortable fetch at the model-adapter level), not a
      quick fix. **[core]**

## Where agent-os is already ahead (keep this true, don't regress it)

Not a todo list — a reminder of what NOT to trade away while closing the
gaps above:

- Event-sourced durability: sessions/tasks survive a crash and reconcile
  (`reconcileLostTasks()`), unlike either competitor's in-memory session
  state.
- The Layer A (gameable, pre-execution) / Layer B (real filesystem
  containment) permission split, with a durable, restart-surviving
  `ApprovalRequest` queue instead of an in-process-only prompt.
- Memory's dreaming-pass gate: the model can never write curated memory
  directly, only nominate — a human always approves before anything
  durable changes.

---

# External integrations plan

From a review of seven outside repos on 2026-09-28, each read from its
source at that date rather than its README. The goal: make every agent
more efficient through the harness (the hardware can't run a big model),
run on Claude and local models side by side, and grow toward voice, a
knowledge graph and computer use. Numbered in the order they're being
done. Tags as above, plus **[Codespace]** for BaseOStest's
`.devcontainer/` scripts.

## 1. Provider router + Claude through the official CLI — done

Why: the gateway picked ONE provider for every agent (first credential
found: Anthropic → OpenAI → Ollama). And the only way to use a Claude
subscription was to send its OAuth token straight to the API from this
harness (`ANTHROPIC_TOKEN` in `models/real.ts`), the pattern Anthropic
has been restricting for third-party tools.

What [stablyai/orca](https://github.com/stablyai/orca) and
[paperclipai/paperclip](https://github.com/paperclipai/paperclip) do
instead: start the official `claude` CLI and let it use its own login.
Paperclip's `claude-local` adapter runs
`claude --print --output-format stream-json`. Neither app itself is worth
adopting here. Orca is a desktop IDE for a human running coding agents in
worktrees, and Paperclip is a whole control plane that overlaps ~70% with
agent-os plus the Workbench. The idea is what's worth taking.

- [x] Provider router: an agent's model preference can name its provider
      (`claude-cli:sonnet`, `ollama:llama3.2:3b`, `anthropic:<id>`,
      `openai:<id>`), so agents on one gateway can use different
      providers. A preference still can't grant access the gateway process
      doesn't already have; an unusable provider falls back to the default
      with a one-time warning. `AGENT_OS_DEFAULT_MODEL` sets the gateway
      default. **[core]** `models/real.ts` (`parseModelRef`,
      `createModelFromRef`, `createDefaultModel`, `listProviders`);
      **[gateway]** `GET /providers`.
- [x] `claude-cli` provider: each model call is one `claude -p` run with
      Claude Code's built-in tools switched off. Agent-OS's tools are
      offered through a small `<tool_call>{…}</tool_call>` text protocol and
      parsed back into a normal tool call, so plan mode, policy, hooks,
      approvals and the sandbox still apply. Streams text live and hides
      the tool block from the stream. Verified live against a logged-in
      CLI (a real turn called `shell` and answered from its output).
      **[core]** `models/claude-cli.ts`; `npm run test-model-router`.
- [x] `OPENAI_BASE_URL` points the OpenAI adapter at any OpenAI-compatible
      server (LM Studio, vLLM, llama.cpp, OpenRouter): the slot for future
      providers and subscriptions. **[core]**
- [x] Agent editor offers "Claude — your subscription" and labels
      provider groups the gateway can't use. **[UI]**
      `AgentEditorModal.tsx`. The CLI is installed on Codespace creation;
      log in once with `claude` → `/login`. **[Codespace]** `setup.sh`.
- [x] Terminals inside the OS: the Workbench's Terminal panel runs the real
      Claude Code CLI (or a shell) through the gateway, so you can use
      Claude Code — and do its one-time `/login` — without leaving the OS.
      Opt-in (`AGENT_OS_TERMINAL=1`), on in the Codespace. **[gateway]**
      `terminal.ts`; **[UI]** `TerminalTab.tsx`.
- [x] The terminal's Claude Code gets the OS as context: the gateway is an
      MCP server (`/mcp`: `basespace_read`, `basespace_add`, `list_agents`,
      `ask_agent`, `list_approvals`), wired into every Claude Code terminal
      session. Approvals stay operator-only — no MCP tool decides one.
      Verified with the real CLI (it read the team and a project and added a
      todo). **[gateway]** `mcp.ts`.
- [ ] Flows still run every step on the gateway default model
      (`server.ts`'s flow routes pass `deps.model`); route per step agent
      like chat turns do. **[gateway]**
- [x] Per-agent token budgets that pause an agent at its limit — done as
      board controls (section 7). **[core]** **[UI]**
- [x] Token efficiency pass. A three-caption hand-off cost 17,206 tokens:
      each CLI call resent ~900 tokens of CLI overhead, ~870 of instructions
      and ~1,800 of tool descriptions (no prompt caching through the CLI),
      and most output was extended thinking. Now: thinking off by default
      for `claude-cli` (`+think` opts in), agents only see tools they can
      use (hidden shell/file tools for everyone but `claude`, and their
      instructions with them), a compact text tool list, `work` done /
      blocked / hand-back ends the turn without another call, compact
      BaseSpace JSON, no tools on compaction calls. **[core]** **[gateway]**
- [ ] Prompt caching: through the API adapters (`cache_control` on the
      system prompt + tools) the fixed part would cost a tenth on repeat
      calls; the CLI path can't do this. Worth it for agents on
      `anthropic:`. **[core]**
- [ ] Retire the `ANTHROPIC_TOKEN` direct-OAuth path once `claude-cli` has
      proven itself; keep `ANTHROPIC_API_KEY` (pay-per-token) as is. **[core]**

## 2. Hindsight: fix, then turn on — in progress

[vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) (MIT).
The client in `hindsight.ts` was checked against Hindsight 0.10.1's server
code and a real server: the retain, recall and reflect bodies are
accepted as sent (no `X-Ignored-Params`), `async` is a valid alias, and
per-item `tags` and `budget: "low"` are real fields.

- [x] Recall ran on every tool step of a turn (`renderMemoryContext` sat
      inside the hop loop), up to 3 identical 4s calls per message. Now
      once per turn. **[core]** `agent-loop.ts`; asserted in
      `test-basespace`.
- [x] It was never actually on: nothing started Hindsight or set
      `HINDSIGHT_URL`. Codespaces have no Docker, so the README's
      `docker run` couldn't work there. Opt-in with the Codespace secret
      `HINDSIGHT_ENABLED=1`: runs the server through `uvx`, uses the
      Codespace's Ollama for fact extraction, and sets `HINDSIGHT_URL` for
      the gateway. **[Codespace]** `hindsight.sh`, `start.sh`.
- [ ] Pick the extraction LLM deliberately. Hindsight's default for Ollama
      is `gemma3:12b` (too big here); the Codespace uses the agents' own
      3B model, which extracts poorly. `HINDSIGHT_LLM_PROVIDER=claude-code`
      (Hindsight's own Claude CLI provider) is worth trying once the CLI is
      logged in.
- [ ] Use what's unused: mental models (`/mental-models`, living documents
      Hindsight keeps current), tag-filtered recall, document ingestion
      (`/files/retain`) for Notes. **[core]**
- Note: episodic writes are mirrored into Hindsight too, but the only live
  caller is an approved memory nomination, so that's a small, deliberate
  duplicate of a human-confirmed fact, not double extraction of every turn.

## 3. Knowledge graph (not built yet)

[Tencent/WeKnora](https://github.com/Tencent/WeKnora) (MIT, Go) is document
RAG, not agent memory: its own agent, chat, sandboxes and chat-app
channels, Postgres + Redis + a parser service, and its graph needs Neo4j.
Too heavy for this hardware and it duplicates much of the stack. Revisit
only for large PDF/Office collections.

- [ ] Build the graph from Hindsight's entities (`/entities/graph`) plus
      the `[[wikilinks]]` in BaseSpace's Notes vault, and render it with the
      existing `features/constellation` 3D view. **[core]** **[UI]**

Memory layers: built-in curated memory stays the small, human-approved
"who I am / how I work" layer; Hindsight is the experience and entity
layer; Notes are the documents.

## 4. Skills + CLI-Anything for computer use

[HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) (Apache-2.0)
wraps apps' own backends as JSON-emitting CLIs, each with a `SKILL.md` in
the same format as `skills/`. That suits small models far better than
screenshot-driven computer use.

- [ ] `parseSkillFile` reads YAML block scalars (`description: >-`) as the
      literal text `">-"`, so every CLI-Anything skill imports with an empty
      description. Tested against `cli-anything-audacity`. **[core]**
      `skills.ts`.
- [ ] Try Audacity, Rekordbox, MuseScore, Kdenlive/Shotcut, OBS, n8n and
      Obsidian. They change files, so only the `claude` agent (the one with
      shell) gets them, through approvals.
- For real screen-and-mouse control, Orca's `orca computer …` commands
  exist, but they need a vision model the local hardware can't run well.

## 5. Voice for HUD mode and live chat

- [ ] [debpalash/VoiceStudio](https://github.com/debpalash/VoiceStudio):
      local speech-to-text over an OpenAI-compatible endpoint
      (`:3900/v1/audio/transcriptions`) plus a streaming WebSocket, TTS and
      MCP. First use: the Workbench mic button (`ConversationPane.tsx`)
      records a `.webm` that no agent can hear, so transcribe it before
      sending. AGPL-3.0, so keep it an unmodified separate service called
      over HTTP.
- [ ] [Tencent-Hunyuan/AuK](https://github.com/Tencent-Hunyuan/AuK) (MIT):
      1.5B speech generation/editing, ~17–25 GiB GPU memory even with CPU
      offload. Not for this hardware; maybe later for vocal edits via its
      GGUF port (audio.cpp).
- Live voice chat is limited by LLM response speed, not the voice layer.

## 6. Harness efficiency for small models, then an own model

- [ ] Adapters take one tool call per model response (`real.ts` header).
- [ ] Tool results go back as plain user text on OpenAI-style providers;
      small models follow real `tool` messages better.
- [ ] Agents get 3 tool steps per message (`maxToolHops`).
- [ ] The event log is already a dataset of approved turns and tool calls:
      the realistic first step toward an own model is a LoRA fine-tune of a
      small open model on it, not training from scratch.

## 7. Running the team like an organization (from Paperclip)

[paperclipai/paperclip](https://github.com/paperclipai/paperclip) (MIT)
treats agents as a company: goals every task traces back to, an org chart
with reporting lines, delegation through tasks, budgets that stop
spending, and a human "board" with live controls and approval gates. We're
not adopting the app (it's a whole control plane beside ours); these are
the ideas, mapped onto what agent-os and BaseSpace already have. Read from
`doc/SPEC.md`, `doc/PRODUCT.md`, `doc/TASK-WATCHDOG.md` and the companies
spec at their 2026-09-28 state.

**Already here in some form:** agent roles and capabilities (agents.ts);
teams with a lead (BaseSpace `teams.ts`); a task ledger with parent tasks
(tasks.ts); heartbeats and crons; approvals; per-session token counts.

Ordered so each step is safe before the next adds autonomy:

- [x] **Board controls.** Pause/resume any agent, and a token budget per
      day/week/month with a warning at 80% and a hard stop at the limit.
      Enforced once in `runTurn()`, so chat, flows, crons, heartbeats,
      subagents and MCP's `ask_agent` all respect it; scheduled work skips a
      blocked agent instead of failing every cycle. A budget block lifts on
      its own when the period rolls over. Operator-only: no agent tool.
      Tokens, not dollars. **[core]** `controls.ts`; **[gateway]**
      `POST /agents/:id/pause|resume`, `PUT /agents/:id/budget`, `control`
      on every agent record; **[UI]** Controls in the agent editor, a
      "Paused"/"Over budget" marker in the agent list.
- [x] **Goals and the "why" chain, woven into what's already there.**
      Goals live in BaseSpace (they're the operator's intent) and join its
      existing connective layer: a goal links projects and can sit under a
      bigger goal; notes link a goal with `[[Goal title]]` like they link
      projects; todos can serve a project or goal (a project's next moves
      do automatically). The snapshot carries all of it. A Workbench thread
      can be focused on a goal or project — every turn then gets "what this
      work serves": the chain up to the top goal, next moves, linked notes
      and open todos — and notes/todos an agent adds from that thread link
      back to it, so the work stays one continuous thread instead of
      starting from zero. Subagents inherit the focus; MCP's `ask_agent` and
      `basespace_add` take `goalId`/`projectId`. Verified live: Hemera on
      the Claude CLI, focused on a goal, answered from its chain and added a
      todo that came back linked to the goal. **[core]** `basespace.ts`
      (`focusContext`), `session.ts` (focus); **[gateway]** `PUT
      /sessions/:id/focus`, `focus` on `POST /sessions`; **[UI]** goals on
      Projects, "Serves" on projects/todos/threads.
- [ ] Flows and BaseSpace team crons take a focus too (a standup focused
      on a goal). **[core]** **[gateway]**
- [x] **Reporting lines + delegation through tasks.** `reportsTo` on each
      identity (seeded once: the artist team → Hemera; Hemera, Argus and
      Claude → the operator; loops rejected). A work ledger
      (`core/work.ts`) with Paperclip's rules: one assignee, atomic claim,
      the assignee can't cancel — it finishes (`done`), says why not
      (`blocked`), or hands it back to its manager; depth capped at 3;
      delegating straight back to the requester refused; tokens recorded
      per item and rolled up to the item that asked. Agents get `delegate`
      and `work` tools plus a "your team" block each turn; items keep the
      requesting thread's goal focus. A background runner
      (`gateway/work-runner.ts`) works them one at a time, skips paused or
      over-budget assignees, completes on a real answer, blocks on a turn
      that stopped (refused tool, pending approval, out of steps), and posts
      the outcome back into the requester's thread as a `[Work]` note (no
      reply turn — no agent ping-pong). Verified live on the Claude CLI:
      Hemera, focused on a goal, delegated captions to Nyx; Nyx wrote them to
      a BaseSpace note linked to the goal and marked the item done; the
      result appeared in Hemera's chat. **[core]** **[gateway]** `/work`
      routes, MCP `assign_work`/`list_work`; **[UI]** Work in the Tasks
      panel (assign, retry, reassign, cancel), Reports-to in the agent
      editor, reporting lines in Teams.
- [x] **Heartbeat work loop → team review.** A lead reviews its reports'
      blocked, handed-back and quiet work, and reopens with guidance,
      reassigns, escalates to the operator, or delegates. The digest is code
      (no model call); a turn only runs when something needs attention and
      changed since the last review, with a per-day cap. Escalated items
      show as "needs you" in BaseSpace. **[core]** **[gateway]** **[UI]**
      `review.ts`, `review-loop.ts`.
- [x] **Governance gates.** `propose-agent` (hire) and `propose-plan`
      (work items for a goal) always go to Approvals, enforced in the
      harness; checked before filing; never always-allowed. Agent config
      (name, role, persona, reporting line, model, budget) has a revision
      history with restore. **[core]** **[UI]** `governance.ts`.
- [x] **Task watchdog.** Opt-in per work item or plan: once everything
      under it has stopped, Argus checks each claim against the evidence
      (the tool calls that really ran, and what was added to BaseSpace),
      assembled in code. It reopens or escalates with a reason, never fixes;
      up to two rounds, then the operator. **[core]** **[UI]** `watchdog.ts`.
- [x] **Stale-work visibility.** `GET /stale` (`stale.ts`) lists in-progress
      work whose run has gone quiet (20 min, `AGENT_OS_STALE_RUN_MIN`), running
      tasks that only renew liveness, and runs that ended lost / timed out /
      failed today. Shown as "Needs a look" in the Tasks panel; nothing is
      reassigned automatically. **[core]** **[UI]**
- [ ] **Team templates.** Export/import a team (agents, personas, skills,
      budgets, reporting lines) as markdown files, like Paperclip's
      `COMPANY.md`/`TEAM.md`/`AGENTS.md` package, with secrets stripped.
      Makes the ISΛRK team reproducible and shareable. **[core]** **[UI]**

**Deliberately not copying:** multiple companies per instance and
enterprise RBAC (one operator here); "not a chatbot" as a hard rule — the
Workbench keeps chat, but work that comes out of a chat should become a
task attached to a goal; dollar-cost tracking without a real price source.
