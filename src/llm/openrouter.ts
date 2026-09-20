/**
 * Forgevi 3.0 — OpenRouter provider.
 *
 * Ranks the best FREE tool-calling models on OpenRouter (verified live
 * against the catalog before this list was fixed) and fails over down
 * the chain on 429 / 5xx / model-not-served. ENGINE_MODEL overrides the
 * primary; the chain still backs it up.
 */

import { config } from "../config.ts";
import { normalizeToolCalls, type ChatMessage, type ChatResult, type LLMProvider, type ToolDef, type VisionImage } from "./provider.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Free, tool-calling-capable, live-verified. Order = preference. */
export const FREE_TOOL_MODEL_CHAIN = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "deepseek/deepseek-v4-flash-0731:free",
  "qwen/qwen3.8-27b:free",
  "cohere/north-mini-code:free",
  "poolside/laguna-s-2.1:free",
] as const;

/** Free vision-capable model for the optional analyze_image sub-agent. */
const FREE_VISION_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";

function modelChain(): string[] {
  const primary = config.model?.trim();
  const chain: string[] = [...FREE_TOOL_MODEL_CHAIN];
  if (primary && primary !== chain[0]) {
    const existing = chain.indexOf(primary);
    if (existing > 0) chain.splice(existing, 1);
    chain.unshift(primary);
  }
  return chain;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
  name?: string;
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
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
      return { role: "tool" as const, content: m.content, tool_call_id: m.toolCallId, name: m.name };
    }
    return { role: m.role, content: m.content };
  });
}

async function callOpenRouter(
  model: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openrouterKey}`,
      "HTTP-Referer": "https://forgeyn.com.ng",
      "X-Title": "Forgevi 3.0",
    },
    body: JSON.stringify({ ...body, model }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`openrouter ${model} ${res.status}: ${text.slice(0, 300)}`), {
      status: res.status,
    });
  }
  const json = (await res.json()) as {
    model?: string;
    choices?: Array<{
      message?: { content?: unknown; reasoning?: unknown; tool_calls?: unknown };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning === "string" ? message.reasoning : undefined;
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

export function createOpenRouterProvider(): LLMProvider {
  if (!config.openrouterKey) {
    throw new Error("OPENROUTER_API_KEY is required for the openrouter provider");
  }
  const chain = modelChain();
  return {
    name: "openrouter",
    model: chain[0]!,
    async chat(messages: ChatMessage[], tools: ToolDef[], opts): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        messages: toOpenAIMessages(messages),
        tools: tools.length
          ? tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
          : undefined,
      };
      let lastError: unknown = null;
      for (const model of chain) {
        try {
          return await callOpenRouter(model, body, opts?.signal);
        } catch (err) {
          if (opts?.signal?.aborted) throw err;
          const status = (err as { status?: number }).status;
          // 400/404/502 model-not-served → try next model; 429/5xx → also next;
          // abort → rethrow.
          lastError = err;
          if (status && [400, 401, 403, 404, 429, 500, 502, 503, 504].includes(status)) continue;
          throw err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("openrouter: all models failed");
    },
    async vision(images: VisionImage[], prompt: string, opts): Promise<string> {
      const content: Array<Record<string, unknown>> = [
        { type: "text", text: prompt },
        ...images.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.b64}` },
        })),
      ];
      const result = await callOpenRouter(FREE_VISION_MODEL, { messages: [{ role: "user", content }] }, opts?.signal);
      return result.content;
    },
  };
}
