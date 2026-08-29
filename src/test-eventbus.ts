// Standalone tests for the event bus (eventbus.ts) and its wiring into
// Automations via wireAutomationsToEventBus (scheduler.ts) — proves
// publish/subscribe works AND that event-triggered Automations actually
// fire automatically once wired, closing the gap scheduler.ts's original
// comment named explicitly ("there's no event bus in this scaffold yet").
// Run with: node dist/test-eventbus.js

import "./test-helpers/isolate.js";
import {
  publishEvent,
  subscribeToEvent,
  subscribeToAllEvents,
  clearEventBusSubscribers,
  registerAutomation,
  wireAutomationsToEventBus,
  createStubModel,
  createStubWorker,
  listTasks,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main(): Promise<void> {
  clearEventBusSubscribers();

  // 1. Basic pub/sub: a typed subscriber receives exactly the events it
  // subscribed to, with the right payload.
  const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const unsub = subscribeToEvent("test.thing.happened", (eventType, payload) => {
    received.push({ type: eventType, payload });
  });
  await publishEvent("test.thing.happened", { value: 42 });
  await publishEvent("test.other.thing", { value: 99 }); // should NOT be received
  assert(received.length === 1, "typed subscriber receives exactly matching-type events (got " + received.length + ")");
  assert(received[0]?.payload.value === 42, "received payload matches what was published");
  unsub();
  await publishEvent("test.thing.happened", { value: 1000 });
  assert(received.length === 1, "unsubscribe actually stops delivery");

  // 2. Wildcard subscriber receives every event type.
  clearEventBusSubscribers();
  const wildcardReceived: string[] = [];
  subscribeToAllEvents((eventType) => {
    wildcardReceived.push(eventType);
  });
  await publishEvent("a.thing", {});
  await publishEvent("b.thing", {});
  assert(
    wildcardReceived.length === 2 && wildcardReceived.includes("a.thing") && wildcardReceived.includes("b.thing"),
    "wildcard subscriber receives every published event type",
  );

  // 3. A throwing subscriber does not prevent other subscribers from
  // receiving the same event (Promise.allSettled semantics).
  clearEventBusSubscribers();
  let goodSubscriberRan = false;
  subscribeToEvent("test.resilience", () => {
    throw new Error("intentional test failure");
  });
  subscribeToEvent("test.resilience", () => {
    goodSubscriberRan = true;
  });
  await publishEvent("test.resilience", {}); // should not throw out of publishEvent itself
  assert(goodSubscriberRan, "a throwing subscriber does not block other subscribers from running");

  // 4. wireAutomationsToEventBus: publishing an event automatically fires
  // a matching event-triggered Automation — no manual fireEventAutomations
  // call needed once wired.
  clearEventBusSubscribers();
  const agentId = "eventbus-test-agent";
  await registerAutomation({
    trigger: { kind: "event", eventType: "inbox.message.received", filter: { important: true } },
    agentId,
    promptTemplate: "Handle the important inbox message.",
    enabled: true,
  });
  const deps = { model: createStubModel(), worker: createStubWorker() };
  const unwire = wireAutomationsToEventBus(deps);

  const tasksBefore = await listTasks({ agentId });
  await publishEvent("inbox.message.received", { important: false }); // filter mismatch — should NOT fire
  const tasksAfterMismatch = await listTasks({ agentId });
  assert(tasksAfterMismatch.length === tasksBefore.length, "a published event with a non-matching filter does NOT fire the automation");

  await publishEvent("inbox.message.received", { important: true }); // filter matches — should fire
  // publishEvent awaits all subscriber handlers (including the async
  // fireEventAutomations call) before resolving, so no extra wait needed.
  const tasksAfterMatch = await listTasks({ agentId });
  assert(
    tasksAfterMatch.length === tasksBefore.length + 1,
    `a published event with a matching filter DOES fire the automation and creates a Task (before=${tasksBefore.length}, after=${tasksAfterMatch.length})`,
  );

  unwire();
  await publishEvent("inbox.message.received", { important: true });
  const tasksAfterUnwire = await listTasks({ agentId });
  assert(tasksAfterUnwire.length === tasksAfterMatch.length, "unwiring stops automatic firing");

  if (process.exitCode === 1) {
    console.error("\nSome event bus tests FAILED.");
  } else {
    console.log("\nAll event bus tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
