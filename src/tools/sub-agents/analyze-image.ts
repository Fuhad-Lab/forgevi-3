/**
 * Forgevi 3.0 — the analyze_image sub-agent tool.
 *
 * THE SUB-AGENT LAW (user directive): sub-agents are OPTIONAL TOOLS the
 * agent chooses to call — never a mandatory pipeline stage, never
 * auto-dispatched. This one gives the agent eyes: it reads an image from
 * the workspace (a screenshot from browser_preview, a design the user
 * uploaded) and answers a question about it through the provider's
 * vision model. If the active provider cannot see, the tool says so
 * honestly and the agent works without it.
 */

import type { AgentTool, ToolOutcome } from "../registry.ts";
import { counters, withSpan } from "../monitoring/telemetry.ts";
import { safeRelPath } from "../../e2b-backblaze/sandbox.ts";

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export const analyzeImageTool: AgentTool = {
  name: "analyze_image",
  description:
    "Look at an image in the workspace (screenshot, uploaded design, mockup) and answer questions about it. " +
    "Use it to check what a page actually looks like (after browser_preview saves a screenshot) or to follow " +
    "an uploaded design. Requires the active model to have vision — you'll get an honest error if it can't.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the image." },
      question: { type: "string", description: "What to look at / answer about the image." },
    },
    required: ["path", "question"],
  },
  async execute(args, ctx): Promise<ToolOutcome> {
    const path = typeof args["path"] === "string" ? args["path"] : "";
    const question = typeof args["question"] === "string" ? args["question"] : "Describe this image precisely.";
    const clean = safeRelPath(path);
    if (!clean) return { content: `error: invalid path "${path}"` };
    return withSpan("forgevi.subagent.analyze_image", { "forgevi.run_id": ctx.runId, "forgevi.path": clean }, async () => {
      counters.toolCalls.add(1, { tool: "analyze_image" });
      const ext = clean.split(".").pop()?.toLowerCase() ?? "";
      const mediaType = MEDIA_TYPES[ext];
      if (!mediaType) return { content: `error: "${clean}" does not look like a supported image (png/jpg/webp/gif/bmp)` };
      if (!ctx.provider.vision) {
        return {
          content:
            `error: the active model provider (${ctx.provider.name}) has no vision — ` +
            `I cannot see "${clean}". Rely on the browser probe's status/title/error markers instead.`,
        };
      }
      let bytes: Buffer;
      try {
        bytes = await ctx.sandbox.readBytesFile(clean);
      } catch (err) {
        return { content: `error: could not read "${clean}" — ${err instanceof Error ? err.message : String(err)}` };
      }
      if (bytes.length > 8 * 1024 * 1024) return { content: `error: "${clean}" is larger than 8 MB` };
      const answer = await ctx.provider.vision([{ b64: bytes.toString("base64"), mediaType }], question, {
        signal: ctx.signal,
      });
      return { content: answer?.trim() || "(the vision model returned no text)" };
    });
  },
};
