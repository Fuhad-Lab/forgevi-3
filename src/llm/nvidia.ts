/**
 * Forgevi 3.0 — NVIDIA NIM provider (the fallback lane).
 *
 * The user's OpenRouter account is free-tier: 50 model requests/day. A
 * single agent run spends ~10, so a handful of live tests exhausts the
 * day — and EVERY free model on the chain 429s with the same
 * free-models-per-day signature (the limit is account-wide, not per-model).
 *
 * This provider speaks the OpenAI-compatible NIM surface
 * (https://integrate.api.nvidia.com/v1) with the platform's NVIDIA key —
 * the same key the previous generation of Forgeyn ran its whole
 * architect/developer loop on (live-verified then as
 * nvidia/nemotron-3.5-lightning-30b-a3b). NIM does not gate tool calling
 * behind a paid tier, which is all the CodeAct kernel needs.
 *
 * NOTE: NVIDIA (like Groq) blocks some non-US egress at the edge — the
 * Render deployment (US egress) reaches it fine; local dev should stick
 * to ENGINE_PROVIDER=zai.
 */

import { config } from "../config.ts";
import { normalizeToolCalls, type ChatMessage, type ChatResult, type LLMProvider, type ToolDef } from "./provider.ts";

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** Preference order — all tool-calling-capable on NIM. */
const NVIDIA_MODEL_CHAIN = [
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3-super-120b-a12b",
] as const;

interface NimMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
}

function toNimMessages(messages: ChatMessage[]): NimMessage[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: m.content ?? "",
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool" as const, content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content };
  });
}

async function callNim(
  model: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const base = (config.nvidia?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.nvidia?.key}`,
      Accept: "application/json",
    },
    body: JSON.stringify({ ...body, model }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`nvidia ${model} ${res.status}: ${text.slice(0, 300)}`), {
      status: res.status,
    });
  }
  const json = (await res.json()) as {
    model?: string;
    choices?: Array<{
      message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;
  const usage = json.usage
    ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 }
    : undefined;
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls: normalizeToolCalls(message.tool_calls),
    ...(usage ? { usage } : {}),
    model: json.model ?? model,
  };
}

export function createNvidiaProvider(): LLMProvider {
  if (!config.nvidia?.key) {
    throw new Error("NVIDIA_API_KEY is required for the nvidia provider");
  }
  const chain = config.nvidia.model
    ? [config.nvidia.model, ...NVIDIA_MODEL_CHAIN.filter((m) => m !== config.nvidia!.model)]
    : [...NVIDIA_MODEL_CHAIN];
  return {
    name: "nvidia",
    model: chain[0]!,
    async chat(messages: ChatMessage[], tools: ToolDef[], opts): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        messages: toNimMessages(messages),
        tools: tools.length
          ? tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
          : undefined,
        temperature: 0.2,
        max_tokens: 8192,
      };
      let lastError: unknown = null;
      for (const model of chain) {
        try {
          return await callNim(model, body, opts?.signal);
        } catch (err) {
          if (opts?.signal?.aborted) throw err;
          lastError = err;
          const status = (err as { status?: number }).status;
          if (status && [400, 401, 403, 404, 429, 500, 502, 503, 504].includes(status)) continue;
          throw err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("nvidia: all models failed");
    },
  };
}
