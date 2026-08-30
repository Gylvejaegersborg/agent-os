// Model abstraction: swappable adapters behind one interface, mirroring
// the pattern every harness in the study converged on (Hermes' provider
// registry, DeepSeek Harness's ctx.llm, Pi's pi-ai package). The scaffold
// ships one adapter — a deterministic stub — so the whole system is
// runnable with zero API keys; real adapters (Anthropic, OpenAI, etc.)
// implement the exact same three-method interface.

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ModelResponse {
  content: string;
  toolCall?: { name: string; args: Record<string, unknown> };
}

/** One chunk of a streamed response. 'delta' carries incremental text (the
 *  UI appends each one as it arrives); 'tool-call' carries a complete tool
 *  call once the model has finished emitting it (tool calls are not
 *  streamed token-by-token by any provider studied — they arrive whole);
 *  'done' always terminates the stream exactly once, carrying the same
 *  {content, toolCall} shape complete() would have returned, so a caller
 *  that only cares about the final result can ignore every delta and just
 *  await the 'done' event. */
export type ModelStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "tool-call"; toolCall: { name: string; args: Record<string, unknown> } }
  | { type: "done"; content: string; toolCall?: { name: string; args: Record<string, unknown> } };

export interface ModelAdapter {
  id: string;
  complete(messages: ModelMessage[]): Promise<ModelResponse>;
  /** Optional real streaming. When absent, callers should use
   *  streamFromComplete() (below) to get the same event SEQUENCE from any
   *  adapter — the wire protocol and UI never need to know which case
   *  they're in. */
  stream?(messages: ModelMessage[]): AsyncIterable<ModelStreamEvent>;
}

/** Turns ANY ModelAdapter into a stream by calling complete() once and
 *  chunking the result — real network latency and a real full response,
 *  but not real token-by-token arrival. This is what makes streaming work
 *  uniformly for the stub model and for any adapter that hasn't
 *  implemented a real stream() yet: the EVENT SEQUENCE (delta*, then
 *  done) is identical to a genuinely-streamed adapter, so gateway.ts and
 *  every downstream consumer of ModelStreamEvent never need a special
 *  case for "this adapter doesn't really stream." Chunked on whitespace
 *  boundaries (not arbitrary byte counts) so partial words never render
 *  mid-token in the UI. */
export async function* streamFromComplete(adapter: ModelAdapter, messages: ModelMessage[]): AsyncIterable<ModelStreamEvent> {
  const response = await adapter.complete(messages);
  const words = response.content.split(/(?<=\s)/); // keep trailing whitespace attached to each chunk
  for (const word of words) {
    if (word.length === 0) continue;
    yield { type: "delta", delta: word };
  }
  if (response.toolCall) {
    yield { type: "tool-call", toolCall: response.toolCall };
  }
  yield { type: "done", content: response.content, toolCall: response.toolCall };
}

/** The canonical entry point every caller (gateway.ts included) should
 *  use instead of choosing between adapter.stream() and
 *  streamFromComplete() itself — picks real streaming when the adapter
 *  provides it, falls back otherwise. */
export function streamModel(adapter: ModelAdapter, messages: ModelMessage[]): AsyncIterable<ModelStreamEvent> {
  return adapter.stream ? adapter.stream(messages) : streamFromComplete(adapter, messages);
}

/** Deterministic stub adapter: no network calls, no API key, fully
 *  reproducible — good enough to prove the agent loop, task lifecycle,
 *  and memory pipeline actually run end to end. Swap for a real adapter
 *  (see docs/architecture.md §1 Agent vs Worker) once you're ready. */
export function createStubModel(id = "stub-model"): ModelAdapter {
  return {
    id,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      // If the most recent message is a tool result, we've already run the
      // tool this turn — summarize instead of calling it again. Without
      // this check the loop would keep re-matching the original "run
      // shell:" user message and hammer maxToolHops every time.
      const last = messages[messages.length - 1];
      if (last?.role === "tool") {
        return { content: `Tool finished. Result: ${last.content.trim()}` };
      }

      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const text = lastUser?.content ?? "";

      // Order matters here: check the MOST SPECIFIC/prefixed patterns
      // first, since these are unanchored substring tests (text.test()),
      // not "starts with" checks. "delegate to subagent: run shell: ..."
      // contains BOTH "run shell:" and "delegate to subagent:" as
      // substrings — checking "run shell:" first would wrongly match a
      // delegation message and call the shell tool directly instead of
      // delegating. This exact bug was caught by the "1c. Subagent" demo
      // section showing an unexpected shell tool call instead of a
      // subagent call — fixed by moving the more specific pattern first.
      if (/delegate\s+to\s+subagent:/i.test(text)) {
        const goal = text.replace(/.*delegate\s+to\s+subagent:/i, "").trim();
        return { content: `Delegating to a subagent: ${goal}`, toolCall: { name: "subagent", args: { goal } } };
      }
      if (/nominate\s+memory:/i.test(text)) {
        const content = text.replace(/.*nominate\s+memory:/i, "").trim();
        return { content: `Nominating for memory: ${content}`, toolCall: { name: "nominate-memory", args: { content, kind: "fact" } } };
      }
      if (/run\s+shell:/i.test(text)) {
        const command = text.replace(/.*run\s+shell:/i, "").trim();
        return { content: `Running: ${command}`, toolCall: { name: "shell", args: { command } } };
      }
      if (/load\s+skill:/i.test(text)) {
        const name = text.replace(/.*load\s+skill:/i, "").trim();
        return { content: `Loading skill: ${name}`, toolCall: { name: "skill", args: { name } } };
      }
      if (/use\s+forbidden-tool/i.test(text)) {
        return { content: "Attempting forbidden-tool", toolCall: { name: "forbidden-tool", args: {} } };
      }
      return { content: `[stub-model] acknowledged: ${text.slice(0, 120)}` };
    },
  };
}

/** Wraps any ModelAdapter to record the exact messages array passed to
 *  every complete() call — used to PROVE what actually reached the
 *  model (e.g. that curated memory was really injected as a system
 *  message), not just trust that the code intends to inject it.
 *  lastMessages() returns the most recent call's messages, or undefined
 *  if complete() was never called. */
export function createRecordingModel(inner: ModelAdapter): ModelAdapter & { lastMessages: () => ModelMessage[] | undefined } {
  let last: ModelMessage[] | undefined;
  return {
    id: inner.id,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      last = messages;
      return inner.complete(messages);
    },
    lastMessages: () => last,
  };
}
