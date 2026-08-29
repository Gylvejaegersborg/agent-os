// Task / Flow projections — pure reducers over the event log. Nothing here
// is "state" in the traditional sense; call project() any time you need
// current status and it's derived fresh from history. This is deliberate:
// it means a Task's status can never drift out of sync with its own event
// trail, because there IS no separate copy to drift.

import { project, appendEvent } from "./eventlog.js";
import { generateId } from "./id.js";
import type { Task, TaskStatus, Flow, Automation } from "./types.js";

const TASKS_STREAM = "tasks"; // one shared stream; task id lives in payload

export async function createTask(input: {
  type: Task["type"];
  agentId: string;
  workerId?: string;
  parentTaskId?: string;
  flowId?: string;
  input: Record<string, unknown>;
  notifyPolicy?: Task["notifyPolicy"];
}): Promise<Task> {
  const id = generateId();
  await appendEvent(TASKS_STREAM, "task.created", {
    taskId: id,
    ...input,
    notifyPolicy: input.notifyPolicy ?? "immediate",
  });
  const task = await getTask(id);
  if (!task) throw new Error("task.created event did not project to a task");
  return task;
}

export async function transitionTask(
  taskId: string,
  status: TaskStatus,
  extra: { output?: Record<string, unknown> } = {},
): Promise<void> {
  await appendEvent(TASKS_STREAM, "task.status.changed", { taskId, status, ...extra });
}

interface TaskProjectionState {
  tasks: Map<string, Task>;
}

async function projectTasks(): Promise<TaskProjectionState> {
  return project<TaskProjectionState>(TASKS_STREAM, { tasks: new Map() }, (state, event) => {
    if (event.type === "task.created") {
      const p = event.payload as any;
      state.tasks.set(p.taskId, {
        id: p.taskId,
        type: p.type,
        agentId: p.agentId,
        workerId: p.workerId,
        parentTaskId: p.parentTaskId,
        flowId: p.flowId,
        status: "queued",
        createdAt: event.timestamp,
        input: p.input ?? {},
        notifyPolicy: p.notifyPolicy ?? "immediate",
      });
    } else if (event.type === "task.status.changed") {
      const p = event.payload as any;
      const existing = state.tasks.get(p.taskId);
      if (!existing) return state;
      const updated: Task = { ...existing, status: p.status };
      if (p.status === "running" && !updated.startedAt) updated.startedAt = event.timestamp;
      if (["succeeded", "failed", "timed_out", "cancelled", "lost"].includes(p.status)) {
        updated.completedAt = event.timestamp;
      }
      if (p.output) updated.output = p.output;
      state.tasks.set(p.taskId, updated);
    }
    return state;
  });
}

export async function getTask(taskId: string): Promise<Task | undefined> {
  const { tasks } = await projectTasks();
  return tasks.get(taskId);
}

export async function listTasks(filter?: { agentId?: string; status?: TaskStatus; parentTaskId?: string }): Promise<Task[]> {
  const { tasks } = await projectTasks();
  let list = [...tasks.values()];
  if (filter?.agentId) list = list.filter((t) => t.agentId === filter.agentId);
  if (filter?.status) list = list.filter((t) => t.status === filter.status);
  if (filter?.parentTaskId) list = list.filter((t) => t.parentTaskId === filter.parentTaskId);
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---- Flow ----

const FLOWS_STREAM = "flows";

export async function createFlow(kind: Flow["kind"], stepIds: { id: string; dependsOn: string[] }[]): Promise<Flow> {
  const id = generateId();
  await appendEvent(FLOWS_STREAM, "flow.created", { flowId: id, kind, steps: stepIds });
  const flow = await getFlow(id);
  if (!flow) throw new Error("flow.created event did not project to a flow");
  return flow;
}

export async function updateFlowStep(
  flowId: string,
  stepId: string,
  status: TaskStatus,
  expectedRevision: number,
  taskId?: string,
): Promise<{ ok: true } | { ok: false; conflict: true; currentRevision: number }> {
  // Optimistic concurrency, mirroring OpenClaw's flow_runs revision counter:
  // a stale write is rejected rather than silently clobbering state.
  const current = await getFlow(flowId);
  if (!current) throw new Error(`no such flow: ${flowId}`);
  if (current.revision !== expectedRevision) {
    return { ok: false, conflict: true, currentRevision: current.revision };
  }
  await appendEvent(FLOWS_STREAM, "flow.step.updated", { flowId, stepId, status, taskId });
  return { ok: true };
}

interface FlowProjectionState {
  flows: Map<string, Flow>;
}

async function projectFlows(): Promise<FlowProjectionState> {
  return project<FlowProjectionState>(FLOWS_STREAM, { flows: new Map() }, (state, event) => {
    if (event.type === "flow.created") {
      const p = event.payload as any;
      state.flows.set(p.flowId, {
        id: p.flowId,
        kind: p.kind,
        status: "running",
        steps: p.steps.map((s: any) => ({ id: s.id, dependsOn: s.dependsOn, status: "queued" as TaskStatus })),
        revision: 0,
      });
    } else if (event.type === "flow.step.updated") {
      const p = event.payload as any;
      const flow = state.flows.get(p.flowId);
      if (!flow) return state;
      const steps = flow.steps.map((s) =>
        s.id === p.stepId ? { ...s, status: p.status as TaskStatus, taskId: p.taskId ?? s.taskId } : s,
      );
      const allDone = steps.every((s) => ["succeeded", "failed", "cancelled"].includes(s.status));
      const anyFailed = steps.some((s) => s.status === "failed");
      const flowStatus: Flow["status"] = allDone ? (anyFailed ? "failed" : "succeeded") : "running";
      state.flows.set(p.flowId, { ...flow, steps, revision: flow.revision + 1, status: flowStatus });
    }
    return state;
  });
}

export async function getFlow(flowId: string): Promise<Flow | undefined> {
  const { flows } = await projectFlows();
  return flows.get(flowId);
}

export async function listFlows(): Promise<Flow[]> {
  const { flows } = await projectFlows();
  return [...flows.values()];
}

// ---- Automation (registry only in this scaffold — no real scheduler yet;
// see /docs/architecture.md for the two-mode Automations/Heartbeat design
// this will grow into). ----

const AUTOMATIONS_STREAM = "automations";

export async function registerAutomation(input: Omit<Automation, "id">): Promise<Automation> {
  const id = generateId();
  await appendEvent(AUTOMATIONS_STREAM, "automation.registered", { automationId: id, ...input });
  const automation = await getAutomation(id);
  if (!automation) throw new Error("automation.registered event did not project");
  return automation;
}

async function projectAutomations(): Promise<Map<string, Automation>> {
  return project<Map<string, Automation>>(AUTOMATIONS_STREAM, new Map(), (state, event) => {
    if (event.type === "automation.registered") {
      const p = event.payload as any;
      state.set(p.automationId, {
        id: p.automationId,
        trigger: p.trigger,
        agentId: p.agentId,
        promptTemplate: p.promptTemplate,
        enabled: p.enabled ?? true,
      });
    } else if (event.type === "automation.toggled") {
      const p = event.payload as any;
      const existing = state.get(p.automationId);
      if (existing) state.set(p.automationId, { ...existing, enabled: p.enabled });
    }
    return state;
  });
}

export async function getAutomation(id: string): Promise<Automation | undefined> {
  return (await projectAutomations()).get(id);
}

export async function listAutomations(): Promise<Automation[]> {
  return [...(await projectAutomations()).values()];
}
