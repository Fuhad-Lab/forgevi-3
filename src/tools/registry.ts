/**
 * Forgevi 3.0 — the tool registry.
 *
 * The agent's hands: execute_command, read_file, write_file, list_dir.
 * Every call is spanned (OpenTelemetry), observed honestly, and reported
 * to the journal as a `tool_used` event by the agent loop (this layer
 * returns observations; the loop frames them).
 *
 * Nothing here is smart on purpose — no judges, no phases, no retry
 * theatre. The MODEL decides what to run; the sandbox reports the truth.
 */

import type { SandboxAdapter } from "../e2b-backblaze/sandbox.ts";
import { safeRelPath } from "../e2b-backblaze/sandbox.ts";
import type { LLMProvider } from "../llm/provider.ts";
import type { JournalEvent } from "../runs/journal.ts";
import { counters, withSpan } from "./monitoring/telemetry.ts";

export interface ToolCtx {
  runId: string;
  sandbox: SandboxAdapter;
  signal: AbortSignal;
  provider: LLMProvider;
  /** The port the agent was told to serve web apps on (browser tool). */
  devPort: number | null;
  /** Journal emitter — tools surface honest events (file_written, preview_frame). */
  emit: (event: JournalEvent, meta?: { iteration?: number }) => void;
}

export interface ToolOutcome {
  /** The observation text the model receives. */
  content: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema (object) for the tool's parameters. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome>;
}

// ── output shaping ─────────────────────────────────────────────────────

const MAX_OBSERVATION = 60_000;

function clip(text: string, max = MAX_OBSERVATION): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.3));
  return `${head}\n… [${text.length - max} chars truncated] …\n${tail}`;
}

function argString(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v : fallback;
}

function argNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ── execute_command ────────────────────────────────────────────────────

export const executeCommandTool: AgentTool = {
  name: "execute_command",
  description:
    "Run a shell command in the project workspace (bash, cwd = project root). " +
    "Use it for everything: scaffolding, installing deps, building, running tests and dev servers, " +
    "inspecting files. Long-running dev servers: start them in the background (e.g. `nohup <cmd> > server.log 2>&1 &`) " +
    "and poll the log. Output is capped; don't print huge files to stdout.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute." },
      timeout_s: {
        type: "number",
        description: "Optional timeout in seconds (default 120, max 600). Commands are killed at the timeout.",
      },
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    const command = argString(args, "command");
    if (!command.trim()) return { content: "error: empty command" };
    const timeoutS = Math.min(Math.max(argNumber(args, "timeout_s", 120), 1), 600);
    return withSpan(
      "forgevi.tool.execute_command",
      { "forgevi.run_id": ctx.runId, "forgevi.command": command.slice(0, 200) },
      async () => {
        counters.toolCalls.add(1, { tool: "execute_command" });
        const res = await ctx.sandbox.exec(command, {
          timeoutMs: timeoutS * 1000,
          signal: ctx.signal,
        });
        const parts = [
          `exit_code: ${res.exitCode}${res.timedOut ? " (timed out — killed)" : ""}`,
          `duration_ms: ${res.durationMs}`,
          "--- stdout ---",
          res.stdout || "(empty)",
          "--- stderr ---",
          res.stderr || "(empty)",
        ];
        return { content: clip(parts.join("\n")) };
      },
    );
  },
};

// ── read_file ──────────────────────────────────────────────────────────

export const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read a text file from the workspace. Paths are relative to the project root.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path." },
      max_chars: { type: "number", description: "Optional cap on returned characters (default 50000)." },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = argString(args, "path");
    const clean = safeRelPath(path);
    if (!clean) return { content: `error: invalid path "${path}"` };
    return withSpan("forgevi.tool.read_file", { "forgevi.run_id": ctx.runId, "forgevi.path": clean }, async () => {
      counters.toolCalls.add(1, { tool: "read_file" });
      try {
        const content = await ctx.sandbox.readTextFile(clean);
        const max = argNumber(args, "max_chars", 50_000);
        return { content: content.length > max ? clip(content, max) : content || "(empty file)" };
      } catch (err) {
        return { content: `error: could not read "${clean}" — ${err instanceof Error ? err.message : String(err)}` };
      }
    });
  },
};

// ── write_file ─────────────────────────────────────────────────────────

export const writeFileTool: AgentTool = {
  name: "write_file",
  description:
    "Write a file (create or overwrite) in the workspace. Paths are relative to the project root. " +
    "Directories are created automatically. Always write COMPLETE file contents.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path." },
      content: { type: "string", description: "The full file content to write." },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const path = argString(args, "path");
    const content = argString(args, "content");
    const clean = safeRelPath(path);
    if (!clean) return { content: `error: invalid path "${path}"` };
    return withSpan("forgevi.tool.write_file", { "forgevi.run_id": ctx.runId, "forgevi.path": clean }, async () => {
      counters.toolCalls.add(1, { tool: "write_file" });
      try {
        await ctx.sandbox.writeFile(clean, content);
        ctx.emit({ type: "file_written", path: clean, bytes: content.length });
        return { content: `wrote ${content.length} bytes to ${clean}` };
      } catch (err) {
        return { content: `error: could not write "${clean}" — ${err instanceof Error ? err.message : String(err)}` };
      }
    });
  },
};

// ── list_dir ───────────────────────────────────────────────────────────

export const listDirTool: AgentTool = {
  name: "list_dir",
  description:
    "List workspace files. Use recursive=true for the full tree (capped). " +
    "Run it before editing so you know the current state of the project.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Optional subdirectory (default: project root)." },
      recursive: { type: "boolean", description: "List recursively (default true)." },
      max_entries: { type: "number", description: "Optional entry cap (default 500)." },
    },
  },
  async execute(args, ctx) {
    const rawPath = argString(args, "path", "");
    const recursive = args["recursive"] !== false;
    const clean = rawPath ? safeRelPath(rawPath) : "";
    if (rawPath && !clean) return { content: `error: invalid path "${rawPath}"` };
    return withSpan("forgevi.tool.list_dir", { "forgevi.run_id": ctx.runId, "forgevi.path": clean ?? "" }, async () => {
      counters.toolCalls.add(1, { tool: "list_dir" });
      const entries = await ctx.sandbox.listDir(clean ?? "", {
        recursive,
        maxEntries: argNumber(args, "max_entries", 500),
      });
      if (entries.length === 0) return { content: "(empty — no files)" };
      const lines = entries
        .map((e) => (e.type === "dir" ? `${e.path}/` : `${e.path}${e.size !== undefined ? ` (${e.size} B)` : ""}`))
        .join("\n");
      return { content: clip(lines, 20_000) };
    });
  },
};

export const CORE_TOOLS: AgentTool[] = [executeCommandTool, readFileTool, writeFileTool, listDirTool];
