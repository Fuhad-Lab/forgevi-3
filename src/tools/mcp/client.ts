/**
 * Forgevi 3.0 — the unified MCP client.
 *
 * ONE client implementation (the official @modelcontextprotocol/sdk,
 * Streamable HTTP with SSE-fallback per connection) for every server —
 * platform connectors today, user connectors tomorrow. No per-connector
 * code: a server that speaks MCP is a server we can use.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../../config.ts";

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpSession {
  server: string;
  tools: McpToolInfo[];
  callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

export function mcpToolName(info: McpToolInfo): string {
  return `mcp__${sanitize(info.server)}__${sanitize(info.name)}`;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null).slice(0, 20_000);
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string; mimeType?: string; data?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "image") parts.push(`[image ${b.mimeType ?? "?"} — ${b.data?.length ?? 0} chars]`);
      else if (b.type === "resource") parts.push(`[resource ${JSON.stringify(b).slice(0, 500)}]`);
      else parts.push(JSON.stringify(block).slice(0, 2_000));
    } else if (typeof block === "string") {
      parts.push(block);
    }
  }
  const joined = parts.join("\n");
  return joined.length > 60_000 ? `${joined.slice(0, 42_000)}\n… [truncated] …\n${joined.slice(-6_000)}` : joined;
}

/**
 * Connect to one MCP server and return a live session. Throws on failure —
 * the caller (auto-discovery) skips the server honestly and logs to engine
 * stderr, never into the run's event stream.
 */
export async function connectMcpServer(server: McpServerConfig, timeoutMs = 20_000): Promise<McpSession> {
  const client = new Client({ name: "forgevi-3", version: "3.0.0" }, { capabilities: {} });
  const url = new URL(server.url);
  const headers: Record<string, string> = { ...server.headers };

  const connect = async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers, signal: controller.signal },
      });
      await client.connect(transport);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    await connect();
  } catch (primaryError) {
    // Streamable HTTP can legitimately be refused by older servers — one
    // retry with the legacy SSE transport before we call the server dead.
    try {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const transport = new SSEClientTransport(url, {
          requestInit: { headers, signal: controller.signal },
        });
        await client.connect(transport);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      throw new Error(
        `${server.name}: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`,
      );
    }
  }

  const listed = await client.listTools().catch((err) => {
    throw new Error(`${server.name}: tools/list failed — ${err instanceof Error ? err.message : String(err)}`);
  });

  const tools: McpToolInfo[] = (listed.tools ?? []).map((t) => ({
    server: server.name,
    name: t.name,
    description: t.description ?? `(no description)`,
    inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  }));

  return {
    server: server.name,
    tools,
    async callTool(toolName, args, signal) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = (await client.callTool({ name: toolName, arguments: args })) as {
          content?: unknown;
          isError?: boolean;
        };
        const text = textFromContent(result.content);
        return result.isError ? `MCP tool error: ${text}` : text;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
