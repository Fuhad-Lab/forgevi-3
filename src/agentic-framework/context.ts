/**
 * Forgevi 3.0 — run context assembly.
 *
 * THE PROMPT-CACHING LAW (verbatim from the platform): the engine pins
 * the system prompt at the top, places the project's prior chat history
 * in the middle, and appends the user's new prompt (objective + task
 * context) as the very last message. The prefix above the newest turn is
 * byte-stable across turns, so provider prompt caches reuse everything
 * already processed and the model only reads the new part.
 *
 * Dynamic facts (app name, platform, acceptance, uploads) live ONLY in
 * the final user message — the system prompt stays pinned.
 */

import type { ChatMessage } from "../llm/provider.ts";
import { SYSTEM_PROMPT } from "./prompts.ts";
import { uploadsPromptBlock, type UploadManifestEntry } from "../uploads/uploads.ts";

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

function taskContextMessage(ctx: TaskContext): string {
  const blocks: string[] = [ctx.objective.trim()];
  const meta: string[] = [];
  if (ctx.appName?.trim()) meta.push(`App name: ${ctx.appName.trim()}`);
  if (ctx.platform && ctx.platform !== "web") meta.push(`Target platform: ${ctx.platform}`);
  if (ctx.devPort) meta.push(`Serve web apps on sandbox port ${ctx.devPort} (the browser_preview tool reaches it)`);
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

/**
 * Assemble the run's opening messages:
 *   [pinned system] → [prior chat history] → [objective + dynamic context]
 */
export function assembleContext(ctx: TaskContext, chatHistory: ChatHistoryRow[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const row of chatHistory.slice(-200)) {
    if (!row.content?.trim()) continue;
    messages.push({ role: row.role, content: row.content.slice(0, 20_000) });
  }
  messages.push({ role: "user", content: taskContextMessage(ctx) });
  return messages;
}
