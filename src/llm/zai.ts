/**
 * Forgevi 3.0 — local-development provider (z-ai-web-dev-sdk).
 *
 * NEVER a production dependency: loaded by dynamic import only when
 * ENGINE_PROVIDER=zai, resolved from this workspace's node_modules.
 * Verified live: the SDK emits proper OpenAI-style tool_calls
 * (finish_reason "tool_calls"), so the agent loop runs unmodified.
 */

import { normalizeToolCalls, type ChatMessage, type ChatResult, type LLMProvider, type ToolDef, type VisionImage } from "./provider.ts";

interface ZaiSdk {
  chat: {
    completions: {
      create: (args: Record<string, unknown>) => Promise<{
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: unknown; tool_calls?: unknown };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

async function loadZai(): Promise<ZaiSdk> {
  try {
    // z-ai-web-dev-sdk is installed in the PARENT workspace (dev-only).
    // Module shape: default export is the ZAI class; instance via ZAI.create().
    const mod = (await import("z-ai-web-dev-sdk")) as unknown as {
      default?: { create: () => Promise<ZaiSdk> };
      create?: () => Promise<ZaiSdk>;
    };
    const ZAI = mod.default ?? mod;
    if (typeof ZAI?.create !== "function") throw new Error("z-ai-web-dev-sdk: no create export");
    return await ZAI.create();
  } catch (err) {
    throw new Error(
      `zai provider unavailable (development-only; needs z-ai-web-dev-sdk in the workspace node_modules): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function createZaiProvider(): Promise<LLMProvider> {
  const zai = await loadZai();
  const model = "zai-glm";
  return {
    name: "zai",
    model,
    async chat(messages: ChatMessage[], tools: ToolDef[], opts): Promise<ChatResult> {
      const payload: Array<Record<string, unknown>> = messages.map((m) => {
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content ?? "",
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          };
        }
        if (m.role === "tool") {
          return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
        }
        return { role: m.role, content: m.content };
      });
      const args: Record<string, unknown> = { messages: payload, temperature: 0.2 };
      if (tools.length) {
        args.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      const res = await zai.chat.completions.create(opts?.signal ? { ...args, signal: opts.signal } : args);
      const message = res.choices?.[0]?.message ?? {};
      const content = typeof message.content === "string" ? message.content : "";
      const usage = res.usage
        ? { promptTokens: res.usage.prompt_tokens ?? 0, completionTokens: res.usage.completion_tokens ?? 0 }
        : undefined;
      return {
        content,
        toolCalls: normalizeToolCalls(message.tool_calls),
        ...(usage ? { usage } : {}),
        model,
      };
    },
    async vision(images: VisionImage[], prompt: string): Promise<string> {
      const content = [
        { type: "text", text: prompt },
        ...images.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.b64}` },
        })),
      ];
      const res = await zai.chat.completions.create({ messages: [{ role: "user", content }] });
      const text = res.choices?.[0]?.message?.content;
      return typeof text === "string" ? text : "";
    },
  };
}
