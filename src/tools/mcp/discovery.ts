/**
 * Forgevi 3.0 — MCP auto-discovery.
 *
 * Sources (union, both optional):
 *   1. MCP_SERVERS env — JSON [{name, url, headers?}]
 *   2. mcp_servers.json at the repo root (gitignored; local testing,
 *      future user connectors land here through the platform backend)
 *
 * Discovery connects to every configured server at run start, lists its
 * tools, and hands them to the agent as first-class tools. Failures skip
 * the server — logged to engine stderr only (silent in the event stream,
 * honest in the logs). This is the whole discovery story: a new connector
 * is a new entry, never new code.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, type McpServerConfig } from "../../config.ts";
import { connectMcpServer, type McpSession, type McpToolInfo } from "./client.ts";

interface Discovered {
  sessions: McpSession[];
  skipped: Array<{ server: string; reason: string }>;
}

async function serversFromFile(): Promise<McpServerConfig[]> {
  try {
    const raw = await readFile(path.resolve(process.cwd(), "mcp_servers.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .filter((s) => typeof s["name"] === "string" && typeof s["url"] === "string" && /^https?:\/\//.test(String(s["url"])))
      .map((s) => ({
        name: String(s["name"]),
        url: String(s["url"]),
        ...(s["headers"] && typeof s["headers"] === "object"
          ? {
              headers: Object.fromEntries(
                Object.entries(s["headers"] as Record<string, unknown>)
                  .filter(([, v]) => typeof v === "string")
                  .map(([k, v]) => [k, String(v)] as [string, string]),
              ),
            }
          : {}),
      }));
  } catch {
    return [];
  }
}

export async function discoverMcpSessions(): Promise<Discovered> {
  const fileServers = await serversFromFile();
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const server of [...config.mcpServers, ...fileServers]) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    servers.push(server);
  }
  const sessions: McpSession[] = [];
  const skipped: Array<{ server: string; reason: string }> = [];
  for (const server of servers) {
    try {
      const session = await connectMcpServer(server);
      sessions.push(session);
      console.error(`[mcp] ${server.name}: ${session.tools.length} tools discovered`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ server: server.name, reason });
      console.error(`[mcp] ${server.name}: SKIPPED — ${reason}`);
    }
  }
  return { sessions, skipped };
}

export function allToolInfos(sessions: McpSession[]): McpToolInfo[] {
  return sessions.flatMap((s) => s.tools);
}

export async function closeSessions(sessions: McpSession[]): Promise<void> {
  await Promise.allSettled(sessions.map((s) => s.close()));
}
