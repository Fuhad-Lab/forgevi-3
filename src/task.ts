/**
 * Forgevi — the task message.
 *
 * OpenHands owns the system prompt; the engine assembles exactly ONE
 * user message per run: the project's prior conversation (so the agent
 * knows the context), then the new task with its dynamic facts (app
 * name, platform, dev port, acceptance, uploads). Nothing else — no
 * custom system prompt, no iteration instructions, no finish coaching.
 */

import { uploadsPromptBlock, type UploadManifestEntry } from "./uploads/uploads.ts";

export interface ChatHistoryRow {
  role: "user" | "assistant";
  content: string;
}

export interface TaskContext {
  objective: string;
  acceptance: string[];
  appName?: string;
  platform?: string;
  devPort: number | null;
  uploads: UploadManifestEntry[];
}

function historyBlock(chatHistory: ChatHistoryRow[]): string {
  const rows = chatHistory
    .slice(-200)
    .filter((row) => row.content?.trim())
    .map((row) => `${row.role === "user" ? "user" : "assistant"}: ${row.content.trim().slice(0, 20_000)}`);
  if (rows.length === 0) return "";
  return `[Conversation on this project so far]\n${rows.join("\n\n")}\n\n`;
}

/** ONE user message: history → the new task → context → acceptance → uploads. */
export function buildTaskPrompt(ctx: TaskContext, chatHistory: ChatHistoryRow[]): string {
  const blocks: string[] = [];

  const history = historyBlock(chatHistory);
  if (history) blocks.push(history);

  blocks.push(`[New task]\n${ctx.objective.trim()}`);

  const meta: string[] = [];
  if (ctx.appName?.trim()) meta.push(`App name: ${ctx.appName.trim()}`);
  if (ctx.platform && ctx.platform !== "web") meta.push(`Target platform: ${ctx.platform}`);
  if (ctx.devPort) meta.push(`Serve the app on port ${ctx.devPort} (bind 0.0.0.0) so the platform can preview it`);
  if (meta.length > 0) blocks.push(`[Task context]\n${meta.join("\n")}`);

  if (ctx.acceptance.length > 0) {
    blocks.push(
      `[Definition of done — verify every point yourself before finishing]\n` +
        ctx.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n"),
    );
  }

  const uploadsBlock = uploadsPromptBlock(ctx.uploads);
  if (uploadsBlock) blocks.push(uploadsBlock.trim());

  return blocks.join("\n\n");
}
