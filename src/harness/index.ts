// Harness — the WebSocket boundary between BaseOS (UI) and agent-os
// (runtime). See AGENT-HARNESS-IMPLEMENTATION-PLAN.md for the full design
// and build order. Phase 1 (this file + protocol.ts) is the contract
// only — no transport/runtime logic yet.

export * from "./protocol.js";
