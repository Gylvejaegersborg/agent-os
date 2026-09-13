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
  /** Token counts for this one call, when the provider reports them —
   *  ROADMAP.md's "cost/token usage tracking" item. Best-effort and
   *  provider-shaped (Anthropic/OpenAI/Ollama all report this slightly
   *  differently, see each adapter in models/real.ts), never fabricated:
   *  omitted entirely rather than guessed when a provider's response
   *  doesn't carry it. Deliberately raw counts, not a dollar estimate —
   *  per-model pricing changes and varies by provider/tier in ways this
   *  scaffold has no reliable source of truth for; inventing a cost
   *  figure would be worse than not showing one. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelAdapter {
  id: string;
  complete(messages: ModelMessage[]): Promise<ModelResponse>;
  /** OPTIONAL: true incremental streaming. Returns the exact same final
   *  ModelResponse complete() would, but ALSO invokes `onDelta` with each
   *  chunk of assistant text as it arrives from the provider, before the
   *  full response resolves — this is what lets a caller (agent-loop.ts's
   *  runTurn()) publish live token-by-token progress instead of only
   *  ever having the complete text once the whole call finishes. Not
   *  every adapter implements this (the OpenAI adapter here doesn't yet
   *  — documented future work, see models/real.ts; Anthropic and Ollama
   *  both do); callers MUST check for its presence and fall back to
   *  complete() otherwise, which
   *  is exactly what runTurn() does — a model without this behaves
   *  byte-for-byte as before this field existed. `onDelta` is
   *  deliberately synchronous (no return value) — an adapter's read loop
   *  should never have to await a caller's side effect (like publishing
   *  an event) between chunks. */
  completeStream?(messages: ModelMessage[], onDelta: (deltaText: string) => void): Promise<ModelResponse>;
}

/** Deterministic stub adapter: no network calls, no API key, fully
 *  reproducible — good enough to prove the agent loop, task lifecycle,
 *  and memory pipeline actually run end to end. Swap for a real adapter
 *  (see docs/architecture.md §1 Agent vs Worker) once you're ready. */
function computeStubResponse(messages: ModelMessage[]): ModelResponse {
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
}

export function createStubModel(id = "stub-model"): ModelAdapter {
  return {
    id,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      return computeStubResponse(messages);
    },
    // Deterministic "streaming": computes the exact same response
    // complete() would, then delivers its `content` to onDelta word by
    // word, yielding the event loop between each word (a real setTimeout,
    // not just a microtask) so a caller genuinely observes multiple
    // separate chunks over time rather than one synchronous burst — good
    // enough to prove the streaming mechanism end to end with zero
    // network calls, same "runnable with zero API keys" spirit as
    // complete() itself.
    async completeStream(messages: ModelMessage[], onDelta: (deltaText: string) => void): Promise<ModelResponse> {
      const response = computeStubResponse(messages);
      const words = response.content.split(/(?<=\s)/); // keep trailing whitespace attached to each word
      for (const word of words) {
        if (!word) continue;
        onDelta(word);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return response;
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
    // Only defined when the wrapped adapter itself supports streaming —
    // an `undefined` completeStream on this wrapper (when inner lacks
    // one) is what lets runTurn()'s `model.completeStream ? ... : ...`
    // check correctly fall back to complete() even through this wrapper.
    ...(inner.completeStream
      ? {
          completeStream: async (messages: ModelMessage[], onDelta: (deltaText: string) => void): Promise<ModelResponse> => {
            last = messages;
            return inner.completeStream!(messages, onDelta);
          },
        }
      : {}),
    lastMessages: () => last,
  };
}
