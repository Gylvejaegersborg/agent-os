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

## Open

Roughly in priority order — each one is a real, checkable gap, not a
vague aspiration. Re-verify the "why" before starting any of these;
codebases drift, and at least one gap in the original comparison
(real token streaming) turned out to be partially wrong once actually
checked — see the correction below.

- [ ] **Checkpoint / rewind.** No file snapshotting at all — once
      `edit_file`/`write_file` lands (even approved), there's no undo
      beyond `git`. Claude Code can roll back conversation + files
      together to an earlier point. **[core]**
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
