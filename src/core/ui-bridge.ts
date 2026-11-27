import { generateId } from "./id.js";
import { publishEvent } from "./eventbus.js";

export type UiOperation = "snapshot" | "query" | "act";
export type UiSource = "user" | "agent";

export interface UiEnvelope {
  requestId: string;
  sessionId: string;
  turnId: string;
  operation: UiOperation;
  timeoutMs: number;
  source: UiSource;
  input: Record<string, unknown>;
}

export type UiOutcome =
  | { ok: true; result: unknown }
  | { ok: false; outcome: "rejected" | "cancelled" | "timeout" | "error"; error?: string };

interface PendingUiRequest {
  resolve: (outcome: UiOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingUiRequest>();

export async function requestUi(envelope: Omit<UiEnvelope, "requestId">): Promise<UiOutcome> {
  const requestId = generateId();
  const full: UiEnvelope = { ...envelope, requestId };
  await publishEvent("ui.request", full as unknown as Record<string, unknown>);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, outcome: "timeout", error: `UI request timed out after ${full.timeoutMs}ms` });
    }, Math.max(1000, Math.min(full.timeoutMs, 300000)));
    pending.set(requestId, { resolve, timer });
  });
}

export function respondUi(requestId: string, outcome: UiOutcome): boolean {
  const waiting = pending.get(requestId);
  if (!waiting) return false;
  clearTimeout(waiting.timer);
  pending.delete(requestId);
  waiting.resolve(outcome);
  return true;
}

