// Real model adapters — implement the exact same ModelAdapter interface as
// the stub in model.ts, proving the abstraction is genuinely swappable and
// not just a paper interface. Uses Node's native fetch (Node 18+), zero
// extra dependencies, matching this scaffold's "auditable in five minutes"
// constraint.
//
// Both adapters intentionally support only a single in-flight tool call per
// turn, matching the ModelResponse shape the agent loop already expects
// (model.ts). Real deployments will likely want to extend ModelResponse to
// carry multiple tool calls — that's a deliberate scaffold limitation, not
// an oversight.

import type { ModelAdapter, ModelMessage, ModelResponse } from "../model.js";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  tools?: ToolSpec[];
  baseUrl?: string;
  /** Anthropic issues two different secret shapes behind similarly-named
   *  env vars in the wild: raw API keys (sk-ant-api...) authenticate via
   *  the `x-api-key` header, while OAuth access tokens (sk-ant-oat... or
   *  opaque OAuth tokens issued by `claude setup-token`/console PKCE flows)
   *  authenticate via `Authorization: Bearer`. Auto-detected from the key
   *  shape by default; override if detection guesses wrong. */
  authStyle?: "api-key" | "oauth-bearer";
}

function detectAnthropicAuthStyle(apiKey: string): "api-key" | "oauth-bearer" {
  // Classic API keys are "sk-ant-api...". Everything else issued as an
  // ANTHROPIC_TOKEN-style credential (OAuth access tokens from the
  // dashboard PKCE flow, `claude setup-token`, etc.) is a bearer token.
  return apiKey.startsWith("sk-ant-api") ? "api-key" : "oauth-bearer";
}

function toAnthropicMessages(messages: ModelMessage[]): { system?: string; messages: unknown[] } {
  const system = messages.find((m) => m.role === "system")?.content;
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "user" : "user",
      content: m.role === "tool" ? [{ type: "tool_result", content: m.content }] : m.content,
    }));
  return { system, messages: rest };
}

export function createAnthropicModel(opts: AnthropicOptions): ModelAdapter {
  const model = opts.model ?? "claude-sonnet-4-5-20250929";
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com/v1/messages";
  const authStyle = opts.authStyle ?? detectAnthropicAuthStyle(opts.apiKey);

  return {
    id: `anthropic:${model}`,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (authStyle === "api-key") {
        headers["x-api-key"] = opts.apiKey;
      } else {
        headers["authorization"] = `Bearer ${opts.apiKey}`;
        // OAuth-issued credentials (console/CLI login flows) require this
        // beta header to be accepted on the Messages API.
        headers["anthropic-beta"] = "oauth-2025-04-20";
      }

      const body: Record<string, unknown> = {
        model,
        max_tokens: opts.maxTokens ?? 1024,
        messages: anthropicMessages,
        ...(system ? { system } : {}),
      };
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }

      const res = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(body) });
      const json: any = await res.json();
      if (!res.ok) {
        throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }

      const textBlock = json.content?.find((b: any) => b.type === "text");
      const toolBlock = json.content?.find((b: any) => b.type === "tool_use");

      return {
        content: textBlock?.text ?? "",
        ...(toolBlock ? { toolCall: { name: toolBlock.name, args: toolBlock.input } } : {}),
      };
    },
  };
}

interface OpenAiOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  tools?: ToolSpec[];
}

export function createOpenAiModel(opts: OpenAiOptions): ModelAdapter {
  const model = opts.model ?? "gpt-4o-mini";
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1/chat/completions";

  return {
    id: `openai:${model}`,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const openAiMessages = messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role, // scaffold-level simplification
        content: m.content,
      }));

      const body: Record<string, unknown> = { model, messages: openAiMessages };
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
      });
      const json: any = await res.json();
      if (!res.ok) {
        throw new Error(`OpenAI API error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }

      const choice = json.choices?.[0]?.message;
      const toolCall = choice?.tool_calls?.[0];

      return {
        content: choice?.content ?? "",
        ...(toolCall
          ? { toolCall: { name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments || "{}") } }
          : {}),
      };
    },
  };
}

/** Reads well-known env vars and returns whichever real adapter is
 *  available, or undefined if none are configured — lets the CLI degrade
 *  gracefully to the stub model instead of crashing when no key is set. */
export function createModelFromEnv(): ModelAdapter | undefined {
  const anthropicKey = process.env.ANTHROPIC_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) return createAnthropicModel({ apiKey: anthropicKey });

  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) return createOpenAiModel({ apiKey: openAiKey });

  return undefined;
}

interface OllamaOptions {
  model?: string;
  /** Default matches Ollama's standard local install. Override for a
   *  remote Ollama server. */
  baseUrl?: string;
  tools?: ToolSpec[];
}

/** Ollama's OpenAI-compatible endpoint (/v1/chat/completions) — same
 *  request/response shape as createOpenAiModel above, no API key needed
 *  since it's a local (or self-hosted) server. This is the adapter you
 *  want for zero-cost, zero-network testing beyond the deterministic
 *  stub: real model behavior, still no cloud bill. */
export function createOllamaModel(opts: OllamaOptions = {}): ModelAdapter {
  // Default model is overridable via OLLAMA_MODEL since "llama3.2" is a
  // guess — whatever's actually pulled locally varies machine to machine.
  const model = opts.model ?? process.env.OLLAMA_MODEL ?? "llama3.2";
  const baseUrl = opts.baseUrl ?? "http://localhost:11434/v1/chat/completions";

  return {
    id: `ollama:${model}`,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const ollamaMessages = messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      }));

      const body: Record<string, unknown> = { model, messages: ollamaMessages, stream: false };
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      let res: Response;
      try {
        res = await fetch(baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new Error(
          `Could not reach Ollama at ${baseUrl} — is it running? ('ollama serve', or 'ollama pull ${model}' if the model isn't installed yet). Original error: ${err}`,
        );
      }
      const json: any = await res.json();
      if (!res.ok) {
        throw new Error(`Ollama API error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }

      const choice = json.choices?.[0]?.message;
      const toolCall = choice?.tool_calls?.[0];

      return {
        content: choice?.content ?? "",
        ...(toolCall
          ? { toolCall: { name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments || "{}") } }
          : {}),
      };
    },
  };
}

/** Checks env vars first (Anthropic/OpenAI), then falls back to a local
 *  Ollama instance if one is reachable, before giving up entirely. Use
 *  this instead of createModelFromEnv() when you want "try everything
 *  free/local before admitting no real model is available." */
export async function createModelFromEnvOrOllama(
  ollamaOpts: OllamaOptions = {},
): Promise<ModelAdapter | undefined> {
  const fromEnv = createModelFromEnv();
  if (fromEnv) return fromEnv;

  const baseUrl = ollamaOpts.baseUrl ?? "http://localhost:11434/v1/chat/completions";
  const probeUrl = baseUrl.replace(/\/v1\/chat\/completions$/, "/api/tags");
  try {
    const probe = await fetch(probeUrl, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) return createOllamaModel(ollamaOpts);
  } catch {
    // Ollama not running — fall through to undefined.
  }
  return undefined;
}
