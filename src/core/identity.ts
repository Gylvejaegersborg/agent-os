// Minimal Agent identity store — backs /agent/identity/<agentId>.json in
// agentfs.ts. Kept intentionally small: this scaffold's Agent type (see
// docs/architecture.md §1) is {id, identity, memory, policy, defaultModel,
// skillCatalog} — most of those fields are already separately-addressable
// primitives elsewhere in this codebase (memory.ts, permissions.ts,
// models/real.ts, skills.ts), so the identity store here only owns what's
// genuinely unique to "who is this agent": name + persona text.

import { project, appendEvent } from "./eventlog.js";

export interface AgentIdentity {
  id: string;
  name: string;
  persona: string;
  createdAt: string;
  updatedAt: string;
}

const IDENTITY_STREAM = "agent-identities";

export async function registerAgentIdentity(input: {
  id: string;
  name: string;
  persona: string;
}): Promise<AgentIdentity> {
  await appendEvent(IDENTITY_STREAM, "agent.identity.registered", input);
  const identity = await getAgentIdentity(input.id);
  if (!identity) throw new Error("agent.identity.registered event did not project");
  return identity;
}

async function projectIdentities(): Promise<Map<string, AgentIdentity>> {
  return project<Map<string, AgentIdentity>>(IDENTITY_STREAM, new Map(), (state, event) => {
    if (event.type === "agent.identity.registered") {
      const p = event.payload as any;
      state.set(p.id, {
        id: p.id,
        name: p.name,
        persona: p.persona,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    } else if (event.type === "agent.identity.updated") {
      const p = event.payload as any;
      const existing = state.get(p.id);
      if (existing) {
        state.set(p.id, { ...existing, ...p, updatedAt: event.timestamp });
      }
    }
    return state;
  });
}

export async function getAgentIdentity(id: string): Promise<AgentIdentity | undefined> {
  return (await projectIdentities()).get(id);
}

export async function listAgentIdentities(): Promise<AgentIdentity[]> {
  return [...(await projectIdentities()).values()];
}
