/**
 * Forgevi — the task message.
 *
 * OpenHands owns the system prompt; the engine assembles exactly ONE
 * user message per run: the project's prior conversation (so the agent
 * knows the context), then the new task with its dynamic facts (app
 * name, platform, dev port, acceptance, uploads). Nothing else — no
 * custom system prompt, no iteration instructions, no finish coaching.
 *
 * THE PLATFORM LAW (user mandate 2026-09-21): the task message carries
 * the non-negotiable platform rules — Next.js (never a standalone HTML
 * deliverable), a running dev server on the assigned port, and
 * continuation of the existing workspace instead of a re-scaffold.
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
  return (
    `[Conversation on this project so far]\n` +
    `This project has history — the transcript below is the SAME project's prior conversation, and the workspace already contains the work described in it. LIST the existing files first, then CONTINUE from where the conversation left off. Do NOT re-scaffold, re-initialize, or start over unless the user explicitly asks for a fresh start.\n\n` +
    rows.join("\n\n") +
    `\n\n`
  );
}

/** THE PLATFORM LAW — the non-negotiable rules every run carries. */
function platformBlock(devPort: number | null): string {
  const lines: string[] = [
    "This platform builds NEXT.JS apps — App Router + TypeScript + Tailwind CSS.",
    "If the workspace does not yet contain a Next.js app, create one first (package.json, next.config, tsconfig, src/app/). NEVER deliver the app as a standalone .html document — plain HTML files are only acceptable as assets inside public/ or as templates the Next.js app renders.",
    "Keep the dev server RUNNING while you work and when you finish: start it in the background bound to 0.0.0.0 (for Next.js: `nohup npm run dev -- -p PORT -H 0.0.0.0 > /tmp/dev-server.log 2>&1 &`), then verify it answers with `curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:PORT`. The platform previews the app through that port — a run that ends without a reachable dev server is an unfinished run.",
  ];
  if (devPort) {
    lines.push(`The dev-server port for this run is ${devPort} — bind the server to exactly that port.`);
  }
  return `[Platform laws — non-negotiable]\n${lines.join("\n")}`;
}

/** ONE user message: history → the new task → context → platform → acceptance → uploads. */
export function buildTaskPrompt(ctx: TaskContext, chatHistory: ChatHistoryRow[]): string {
  const blocks: string[] = [];

  const history = historyBlock(chatHistory);
  if (history) blocks.push(history);

  blocks.push(`[New task]\n${ctx.objective.trim()}`);

  const meta: string[] = [];
  if (ctx.appName?.trim()) meta.push(`App name: ${ctx.appName.trim()}`);
  if (ctx.platform && ctx.platform !== "web") meta.push(`Target platform: ${ctx.platform}`);
  if (meta.length > 0) blocks.push(`[Task context]\n${meta.join("\n")}`);

  blocks.push(platformBlock(ctx.devPort));

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
