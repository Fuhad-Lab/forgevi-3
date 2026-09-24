/**
 * Forgevi — the task message.
 *
 * THE SYSTEM-PROMPT LAW (user mandate 2026-09-24): the platform's
 * standing instructions — above all THE FINISH LAW (the agent spins up
 * the dev server when it finishes making edits) — ride the AGENT'S
 * SYSTEM PROMPT (Cline's .clinerules rules file / the OpenHands
 * worker's system-prompt addendum; see src/platform-law.ts). The engine
 * assembles exactly ONE user message per run: the project's prior
 * conversation (so the agent knows the context), then the new task with
 * its dynamic facts (app name, platform, dev port, acceptance,
 * uploads). The platform block below is the task-message REMINDER of
 * the same laws the system prompt already carries — defense in depth,
 * never a hardcoded engine-side dev-server start.
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
  /** THE SOUL LAW: a project-bound run — soul.md (the account-global
   * memory) was injected at the workspace root before this prompt. */
  soul?: boolean;
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

/** THE PLATFORM-LAW REMINDER — the task-message echo of the laws the
 *  agent's SYSTEM PROMPT already carries (src/platform-law.ts). Kept as
 *  defense in depth: the reminder rides the fresh turn even in long
 *  conversations where the system prompt is far upstream. */
function platformBlock(devPort: number | null): string {
  const lines: string[] = [
    "This platform builds NEXT.JS apps — App Router + TypeScript + Tailwind CSS.",
    "If the workspace does not yet contain a Next.js app, create one first (package.json, next.config, tsconfig, src/app/). NEVER deliver the app as a standalone .html document — plain HTML files are only acceptable as assets inside public/ or as templates the Next.js app renders.",
    "Keep the dev server RUNNING while you work and when you finish: start it DETACHED so it outlives the run — `setsid nohup npm run dev -- -p PORT -H 0.0.0.0 > /tmp/dev-server.log 2>&1 &` (setsid is what makes it survive: a plain nohup child dies with the command's process group and the preview dies with it), then verify it answers with `curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:PORT`. The platform previews the app through that port — a run that ends without a reachable dev server is an unfinished run.",
  ];
  if (devPort) {
    lines.push(`The dev-server port for this run is ${devPort} — bind the server to exactly that port.`);
  }
  return `[Platform laws — non-negotiable]\n${lines.join("\n")}`;
}

/** THE SOUL LAW — the cross-project memory contract. soul.md at the
 *  workspace root is the USER's global agent memory (shared across all
 *  their projects on this platform). Read it first; update it when the
 *  run teaches something durable. It is synced by the platform — treat
 *  it as a concise memory file, never as project documentation. */
function soulBlock(): string {
  return (
    `[Global memory — soul.md]\n` +
    `A file named soul.md sits at the workspace root: it is your persistent GLOBAL memory for this user, shared across ALL their projects on this platform. Read it BEFORE planning. It may hold their preferences, framework choices, past architecture decisions, and lessons — honour them in this run (e.g. if it says they prefer a styling approach, use it without re-asking).\n` +
    `Before finishing, update soul.md itself (edit the file directly) with anything DURABLE this run taught you: new user preferences you observed, stack/architecture decisions that were made, and lessons from debugging. Keep it concise (it is memory, not documentation — do not log task-specific detail that another project would not care about). If nothing durable was learned, leave it unchanged.`
  );
}

/** ONE user message: history → the new task → context → platform → acceptance → uploads. */
export function buildTaskPrompt(ctx: TaskContext, chatHistory: ChatHistoryRow[]): string {
  const blocks: string[] = [];

  const history = historyBlock(chatHistory);
  if (history) blocks.push(history);

  if (ctx.soul) blocks.push(soulBlock());

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
