/**
 * Forgevi 3.0 — the MCP → agent tool bridge.
 *
 * Every discovered MCP tool becomes a first-class agent tool
 * (`mcp__<server>__<tool>`) with its real schema. The agent decides
 * whether to use them — same as every other tool. No dispatch rules,
 * no per-connector code paths.
 */

import type { McpSession } from "./client.ts";
import { mcpToolName } from "./client.ts";
import type { AgentTool, ToolCtx, ToolOutcome } from "../registry.ts";
import { counters, withSpan } from "../monitoring/telemetry.ts";

export function mcpToolsForSession(session: McpSession): AgentTool[] {
  return session.tools.map((info): AgentTool => ({
    name: mcpToolName(info),
    description: `[${info.server}] ${info.description}`.slice(0, 1000),
    parameters: info.inputSchema?.["type"] === "object" ? info.inputSchema : { type: "object", properties: {} },
    async execute(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
      const toolName = mcpToolName(info);
      return withSpan(
        "forgevi.tool.mcp",
        { "forgevi.run_id": ctx.runId, "forgevi.mcp_server": info.server, "forgevi.mcp_tool": info.name },
        async () => {
          counters.toolCalls.add(1, { tool: "mcp", server: info.server });
          try {
            const text = await session.callTool(info.name, args, ctx.signal);
            return { content: text || "(empty MCP result)" };
          } catch (err) {
            return {
              content: `error: MCP call ${info.server}/${info.name} failed — ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      );
    },
  }));
}
