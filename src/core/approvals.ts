// Durable approvals — the persisted half of Layer A's "ask" decision
// (permissions.ts's PermissionPolicy). Before this file, a rule evaluating
// to "ask" with no synchronous onAsk callback wired up simply denied the
// tool call and forgot it ever happened: no record, nothing a human could
// later discover, approve, or reject. That's fine for a single-process
// demo but wrong for a gateway-fronted runtime, where "approval required"
// needs to survive the process that asked for it — a human may approve it
// from an entirely different process, hours or days later.
//
// Same shape as every other primitive here: an append-only `approvals`
// stream, reduced by project(). A resolved (approved/rejected) request is
// terminal — it cannot be re-resolved, mirroring session.ts's terminal-
// status enforcement.

import { project, appendEvent } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { generateId } from "./id.js";
import type { ApprovalRequest, ApprovalStatus } from "./types.js";

const APPROVALS_STREAM = "approvals";

export interface RequestApprovalInput {
  agentId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}

export async function requestApproval(input: RequestApprovalInput): Promise<ApprovalRequest> {
  const id = generateId();
  await appendEvent(APPROVALS_STREAM, "approval.requested", { approvalId: id, ...input });
  const request = await getApproval(id);
  if (!request) throw new Error("approval.requested event did not project to an approval request");
  // Published live so a gateway can surface "approval needed" the moment
  // it happens — see agent-loop.ts's runTurn() for the same pattern.
  await publishEvent("approval.requested", { approvalId: id, ...input });
  return request;
}

interface ApprovalProjectionState {
  approvals: Map<string, ApprovalRequest>;
}

async function projectApprovals(): Promise<ApprovalProjectionState> {
  return project<ApprovalProjectionState>(APPROVALS_STREAM, { approvals: new Map() }, (state, event) => {
    if (event.type === "approval.requested") {
      const p = event.payload as any;
      state.approvals.set(p.approvalId, {
        id: p.approvalId,
        agentId: p.agentId,
        sessionId: p.sessionId,
        toolName: p.toolName,
        args: p.args ?? {},
        reason: p.reason ?? "",
        status: "pending",
        requestedAt: event.timestamp,
      });
    } else if (event.type === "approval.resolved") {
      const p = event.payload as any;
      const existing = state.approvals.get(p.approvalId);
      if (!existing) return state;
      state.approvals.set(p.approvalId, {
        ...existing,
        status: p.status,
        resolvedAt: event.timestamp,
        resolvedBy: p.resolvedBy,
        resolutionNote: p.note,
      });
    }
    return state;
  });
}

export async function getApproval(id: string): Promise<ApprovalRequest | undefined> {
  return (await projectApprovals()).approvals.get(id);
}

export async function listApprovals(filter?: {
  status?: ApprovalStatus;
  agentId?: string;
  sessionId?: string;
}): Promise<ApprovalRequest[]> {
  const { approvals } = await projectApprovals();
  let list = [...approvals.values()];
  if (filter?.status) list = list.filter((a) => a.status === filter.status);
  if (filter?.agentId) list = list.filter((a) => a.agentId === filter.agentId);
  if (filter?.sessionId) list = list.filter((a) => a.sessionId === filter.sessionId);
  return list.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

async function resolveApproval(
  id: string,
  status: "approved" | "rejected",
  extra: { resolvedBy?: string; note?: string } = {},
): Promise<ApprovalRequest> {
  const existing = await getApproval(id);
  if (!existing) throw new Error(`no such approval request: ${id}`);
  if (existing.status !== "pending") {
    throw new Error(`approval request ${id} is already resolved ("${existing.status}") and cannot be resolved again`);
  }
  await appendEvent(APPROVALS_STREAM, "approval.resolved", { approvalId: id, status, ...extra });
  const updated = await getApproval(id);
  if (!updated) throw new Error("approval.resolved event did not project to an approval request");
  await publishEvent("approval.resolved", { approvalId: id, status, ...extra });
  return updated;
}

export async function approveRequest(id: string, extra: { resolvedBy?: string; note?: string } = {}): Promise<ApprovalRequest> {
  return resolveApproval(id, "approved", extra);
}

export async function rejectRequest(id: string, extra: { resolvedBy?: string; note?: string } = {}): Promise<ApprovalRequest> {
  return resolveApproval(id, "rejected", extra);
}
