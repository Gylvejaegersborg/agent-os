// Event bus — the missing piece scheduler.ts's file-level comment named
// explicitly: "there's no event bus in this scaffold yet." This is a
// deliberately minimal IN-PROCESS pub/sub (no message broker, no
// cross-process delivery) — matching this scaffold's zero-dependency,
// prove-the-primitive-first philosophy. Two things make it more than a
// bare EventEmitter:
//   1. Every publish is itself event-sourced (a `bus.event.published`
//      entry in its own stream), so the same "everything is a
//      projection" principle applies here too — you can audit exactly
//      what was published and when, independent of whether any
//      subscriber actually existed to receive it.
//   2. wireAutomationsToEventBus() closes the loop scheduler.ts left
//      open: event-triggered Automations used to require a caller to
//      manually invoke fireEventAutomations() "from wherever the real
//      event happens." Now publishEvent() does that automatically for
//      any process that called wireAutomationsToEventBus() once at
//      startup — the manual function still exists and still works
//      standalone, this just makes the bus the normal way to trigger it.
//
// Explicit non-goals (stated, not hidden): no persistence of
// subscriptions across a process restart (subscribers are in-memory,
// re-registered at startup, same as hooks.ts's registry), no delivery
// guarantees/retries/ordering across processes, no cross-process bus —
// this is intentionally the simplest thing that actually demonstrates
// the primitive, not a message-queue replacement.

import { appendEvent } from "./eventlog.js";

const BUS_STREAM = "event-bus";

export type EventBusHandler = (eventType: string, payload: Record<string, unknown>) => Promise<void> | void;

// Keyed by eventType for typed subscribers, plus a wildcard list for
// subscribers that want every event regardless of type (this is how
// wireAutomationsToEventBus listens without knowing every eventType an
// Automation might ever be registered against).
const typedSubscribers = new Map<string, EventBusHandler[]>();
const wildcardSubscribers: EventBusHandler[] = [];

export type Unsubscribe = () => void;

/** Subscribes to exactly one event type. Returns an unsubscribe function
 *  — always keep it if the subscription is scoped to something shorter
 *  than the process lifetime (a test, a request handler), otherwise the
 *  handler leaks for the life of the process. */
export function subscribeToEvent(eventType: string, handler: EventBusHandler): Unsubscribe {
  const existing = typedSubscribers.get(eventType) ?? [];
  existing.push(handler);
  typedSubscribers.set(eventType, existing);
  return () => {
    const list = typedSubscribers.get(eventType);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  };
}

/** Subscribes to every event published on the bus, regardless of type.
 *  Used by wireAutomationsToEventBus() since Automations can register
 *  against any eventType at any time — the bus can't know the full set
 *  in advance. */
export function subscribeToAllEvents(handler: EventBusHandler): Unsubscribe {
  wildcardSubscribers.push(handler);
  return () => {
    const idx = wildcardSubscribers.indexOf(handler);
    if (idx !== -1) wildcardSubscribers.splice(idx, 1);
  };
}

/** Publishes an event: records it to the audit stream FIRST (so the
 *  publish is durable even if every subscriber throws), then notifies
 *  typed subscribers and wildcard subscribers. Each handler is invoked
 *  independently via Promise.allSettled — one failing subscriber does
 *  not prevent others from receiving the event, matching the "one
 *  broken thing shouldn't take the whole system down" pattern already
 *  used in discoverSkills() (skills.ts) and runSchedulerTick()
 *  (scheduler.ts, via its own try/catch per tick). Failures are logged,
 *  not silently swallowed. */
export async function publishEvent(eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
  await appendEvent(BUS_STREAM, "bus.event.published", { eventType, payload });

  const handlers = [...(typedSubscribers.get(eventType) ?? []), ...wildcardSubscribers];
  // Wrap each call in an async IIFE so a handler that throws SYNCHRONOUSLY
  // (not just one that returns a rejected promise) still becomes a
  // rejected promise for Promise.allSettled to catch, rather than
  // throwing straight out of the .map() call and skipping every
  // subsequent handler before allSettled ever runs.
  const results = await Promise.allSettled(handlers.map(async (h) => h(eventType, payload)));
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`[event-bus] a subscriber to "${eventType}" threw:`, r.reason instanceof Error ? r.reason.message : r.reason);
    }
  }
}

/** Removes every subscriber — typed and wildcard. Intended for test
 *  isolation (mirrors hooks.ts's clearHooks()), not for production use;
 *  calling this mid-flight in a running process silently drops every
 *  future automation trigger until re-wired. */
export function clearEventBusSubscribers(): void {
  typedSubscribers.clear();
  wildcardSubscribers.length = 0;
}
