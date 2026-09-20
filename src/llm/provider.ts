/**
 * Forgevi 3.0 — the LLM provider contract.
 *
 * One shape, three implementations:
 *   - openrouter : production (best FREE tool-calling models, live-ranked)
 *   - zai        : local development (this workspace's z-ai-web-dev-sdk)
 *   - mock       : the self-test probe (scripted deterministic turns)
 *
 * Non-streaming by design: the wire contract's `assistant_text` event
 * REPLACES the bubble content each turn, so whole-turn responses map
 * exactly onto the frontend's rendering semantics.
 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage?: ChatUsage;
  model: string;
}

export interface VisionImage {
  b64: string;
  mediaType: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolDef[], opts?: { signal?: AbortSignal }): Promise<ChatResult>;
  /** Optional vision — powers the optional analyze_image sub-agent tool. */
  vision?(images: VisionImage[], prompt: string, opts?: { signal?: AbortSignal }): Promise<string>;
}

/** OpenAI tool-call normalization shared by every provider. */
export interface RawToolCall {
  id?: string | number;
  type?: string;
  function?: { name?: string; arguments?: string };
  index?: number;
}

export function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const fn = (item as { function?: { name?: unknown; arguments?: unknown } }).function;
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    if (!name) continue;
    const args = typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {});
    const id = (item as { id?: unknown }).id;
    calls.push({
      id: typeof id === "string" && id ? id : `call_${crypto.randomUUID().slice(0, 12)}`,
      name,
      arguments: args,
    });
  }
  return calls;
}
