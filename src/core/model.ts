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

export interface ModelAdapter {
  id: string;
  complete(messages: ModelMessage[]): Promise<ModelResponse>;
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

      if (/run\s+shell:/i.test(text)) {
        const command = text.replace(/.*run\s+shell:/i, "").trim();
        return { content: `Running: ${command}`, toolCall: { name: "shell", args: { command } } };
      }
      if (/load\s+skill:/i.test(text)) {
        const name = text.replace(/.*load\s+skill:/i, "").trim();
        return { content: `Loading skill: ${name}`, toolCall: { name: "skill", args: { name } } };
      }
      return { content: `[stub-model] acknowledged: ${text.slice(0, 120)}` };
    },
  };
}
