---
name: event-log-debugging
description: How to debug issues in this OS by reading its event log streams directly. Use when something seems wrong with task/flow/memory state and you need to find the root cause.
compatibility: Requires read access to the data/streams/ directory.
metadata:
  author: agent-os
---

# Debugging via the event log

Every piece of state in this system — session history, task status, flow
progress, curated memory — is a projection over an append-only JSONL
stream under `data/streams/`. When something looks wrong, don't guess:
read the actual events.

## Steps

1. Identify the relevant stream. Naming convention:
   - `tasks` — every Task, across all agents
   - `flows` — every Flow
   - `session:<id>` — one session's message/tool history
   - `memory:<agentId>:episodic` — fast-path memory writes
   - `memory:<agentId>:curated` — promoted memory (should only change via dreaming)
   - `memory:<agentId>:dreaming` — every dreaming pass and its scoring decisions

2. Read it directly — it's plain JSONL, one event per line:
   ```bash
   cat data/streams/tasks.jsonl | python -m json.tool
   ```

3. For memory questions specifically ("why does the agent believe X?"),
   check `memory:<agentId>:dreaming` — every promotion decision carries its
   `eligibilityScore` and which episodic entry caused it. See
   `references/scoring-fields.md` for what each field means.

4. Never assume state — the whole point of the event-log-first design is
   that you can always reconstruct exactly what happened and why.
