---
name: commit-message-style
description: House style for writing git commit messages. Use when the agent is about to write or suggest a commit message for this repo.
metadata:
  author: agent-os
  version: "1.0"
---

# Commit message style

This repo's commit messages follow a specific convention — apply it any
time you write one:

1. **Subject line**: imperative mood, no trailing period, under 72 chars.
   Good: "Add Ollama model adapter". Bad: "Added the Ollama adapter.".
2. **Body**: explain *what changed and why*, not a line-by-line diff
   narration. Reference which primitive from `docs/architecture.md` this
   commit scales, if applicable.
3. **Verification note**: state what was actually run to confirm the
   change works (typecheck, demo, a live test) — never claim something
   works without having executed it.
4. Never claim a fabricated test result. If something wasn't verified,
   say so explicitly instead of implying it was.

## Example

```
Add Ollama model adapter

Implements ModelAdapter against Ollama's OpenAI-compatible endpoint —
zero API key, zero cost, local-first. Model name overridable via
OLLAMA_MODEL since the locally-pulled model varies machine to machine.

Verified: npm run test-live-model against a running local Ollama server
(llama3.1:8b) — real model response through the full agent-loop stack.
```
