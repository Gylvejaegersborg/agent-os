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

## Open

Roughly in priority order — each one is a real, checkable gap, not a
vague aspiration. Re-verify the "why" before starting any of these;
codebases drift, and at least one gap in the original comparison
(real token streaming) turned out to be partially wrong once actually
checked — see the correction below.

- [ ] **Context compaction.** `getSessionHistory()` (`agent-loop.ts`) is
      an unbounded projection — every session.message event, forever. A
      long-running session will eventually blow the model's context
      window with no graceful degradation. Claude Code auto-summarizes
      near the limit. **[core]**
- [ ] **Plan / read-only mode.** No hard mode switch separating
      "explore and propose" from "actually execute" — Layer A's
      `PermissionPolicy` gates by command *pattern*, not by a mode the
      model itself knows it's in. **[core]**
- [ ] **Checkpoint / rewind.** No file snapshotting at all — once
      `edit_file`/`write_file` lands (even approved), there's no undo
      beyond `git`. Claude Code can roll back conversation + files
      together to an earlier point. **[core]**
- [ ] **MCP (Model Context Protocol) support.** The tool registry is
      closed — `shell`/`skill`/`subagent`/`nominate-memory`/
      `record-artifact`/`read_file`/`edit_file`/`write_file`, nothing
      pluggable in from an external server. **[core]**
- [ ] **Cost/token usage tracking.** Nowhere in the runtime or the UI —
      no token counts recorded per turn, no running cost shown anywhere.
      Claude Code's `/cost` and session total are the bar. **[core]**
      **[UI]**
- [ ] **User-configurable hooks.** `hooks.ts`'s hook points
      (`tool.before`, `session.start`, ...) are real but only addressable
      from code you write and redeploy — Claude Code's hooks are a
      settings file any operator can edit without a rebuild. **[core]**
      **[UI]** (a settings-file editor, alongside the new Skills section)
- [ ] **Skill marketplace / install-from-elsewhere.** `SkillRegistry` +
      the new Settings UI cover hand-authoring a skill; there's still no
      way to pull one in from outside (a URL, a shared registry). **[core]**
      **[UI]**
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
