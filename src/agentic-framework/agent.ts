/**
 * Forgevi 3.0 — THE agent loop (OpenHands CodeAct style).
 *
 * ONE agent. It acts (tool calls), observes (tool results), and decides.
 * It finishes by calling `finish` — or by answering without any tool call,
 * which the loop treats as a final answer (the model decided it is done).
 *
 * What is deliberately ABSENT (the user's law):
 *   - no hardcoded iteration counts      — the loop runs until done
 *   - no judge / verifier roles          — the agent verifies its own work
 *   - no completion-decision theatre     — finish IS the decision
 *   - no verification_result theatre     — the finish summary reports state
 *   - no mandatory sub-agent dispatch    — sub-agents are optional tools
 *   - no budgets                         — env-configurable safety ceilings
 *                                         default to OFF; the run ends when
 *                                         the agent finishes or the user
 *                                         aborts
 *
 * Wire-contract mapping:
 *   - each step emits `iteration_started` (step N — live progress, not a cap)
 *   - each assistant turn emits `assistant_text` (full text, REPLACES the bubble)
 *     and `assistant_thinking` when the model exposes reasoning (APPENDS)
 *   - each tool call emits `tool_used` ({tool, status, detail})
 *   - terminal: `run_finished` {status, summary, iterations, durationMs, ...}
 */

import type { ChatMessage, ChatResult, LLMProvider, ToolDef } from "../llm/provider.ts";
import type { AgentTool, ToolCtx } from "../tools/registry.ts";
import { counters, withSpan } from "../tools/monitoring/telemetry.ts";
import { FINISH_TOOL_DESCRIPTION, finishToolParameters } from "./prompts.ts";

export interface AgentLoopEmit {
  (event: { type: string } & Record<string, unknown>, meta?: { iteration?: number }): void;
}

export interface AgentLoopResult {
  status: "complete" | "incomplete";
  summary: string;
  remainingIssues: string[];
  steps: number;
  stopReason: "finish" | "final-answer" | "aborted" | "step-ceiling" | "wall-clock" | "token-ceiling" | "error";
  usage: { promptTokens: number; completionTokens: number };
}

export interface AgentLoopOpts {
  runId: string;
  provider: LLMProvider;
  tools: AgentTool[];
  messages: ChatMessage[];
  ctx: ToolCtx;
  emit: AgentLoopEmit;
  signal: AbortSignal;
  ceilings: { maxSteps: number; maxWallclockMs: number; maxTokens: number };
  startedAt: number;
}

export function finishToolDef(): ToolDef {
  return { name: "finish", description: FINISH_TOOL_DESCRIPTION, parameters: finishToolParameters };
}

function toolDefs(tools: AgentTool[]): ToolDef[] {
  return [...tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })), finishToolDef()];
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function observationForError(err: unknown): string {
  if (err instanceof Error) {
    return `error: tool execution failed — ${err.message}`;
  }
  return `error: tool execution failed — ${String(err)}`;
}

/** One final-text answer without any tool call — the model decided.
 *  Reasoning models (nemotron & co.) often put the whole answer in the
 *  `reasoning` field with an empty `content` — the reasoning IS the answer
 *  then. */
function finalAnswerFromContent(content: string, reasoning?: string): { summary: string; issues: string[] } {
  const text = content.trim() || reasoning?.trim() || "";
  if (!text) return { summary: "", issues: [] };
  return { summary: text.slice(0, 20_000), issues: [] };
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  const { provider, tools, messages, ctx, emit, signal, ceilings, startedAt, runId } = opts;
  const usage = { promptTokens: 0, completionTokens: 0 };
  let steps = 0;
  let emptyTurnNudged = false;

  const final = (status: "complete" | "incomplete", summary: string, issues: string[], stopReason: AgentLoopResult["stopReason"]): AgentLoopResult => ({
    status,
    summary,
    remainingIssues: issues,
    steps,
    stopReason,
    usage,
  });

  while (true) {
    if (signal.aborted) {
      return final("incomplete", "Aborted by the user. Work done so far is saved in the workspace.", [], "aborted");
    }

    // Optional safety ceilings (0 = OFF — the default; the user's law)
    if (ceilings.maxSteps > 0 && steps >= ceilings.maxSteps) {
      return final(
        "incomplete",
        `Stopped at the configured step ceiling (${ceilings.maxSteps}). Work done so far is saved in the workspace.`,
        ["step ceiling reached"],
        "step-ceiling",
      );
    }
    if (ceilings.maxWallclockMs > 0 && Date.now() - startedAt > ceilings.maxWallclockMs) {
      return final(
        "incomplete",
        `Stopped at the configured wall-clock limit (${Math.round(ceilings.maxWallclockMs / 60_000)} min). Work done so far is saved in the workspace.`,
        ["wall-clock ceiling reached"],
        "wall-clock",
      );
    }
    if (ceilings.maxTokens > 0 && usage.promptTokens + usage.completionTokens > ceilings.maxTokens) {
      return final(
        "incomplete",
        `Stopped at the configured token ceiling (${ceilings.maxTokens}). Work done so far is saved in the workspace.`,
        ["token ceiling reached"],
        "token-ceiling",
      );
    }

    steps += 1;
    counters.steps.add(1);
    emit({ type: "iteration_started", iteration: steps }, { iteration: steps });

    let res: ChatResult;
    try {
      res = await withSpan(
        "forgevi.llm.chat",
        { "forgevi.run_id": runId, "forgevi.step": steps },
        async (span) => {
          const result = await provider.chat(messages, toolDefs(tools), { signal });
          span.setAttribute("forgevi.tool_calls", result.toolCalls.length);
          span.setAttribute("forgevi.model", result.model);
          return result;
        },
      );
    } catch (err) {
      if (signal.aborted) {
        return final("incomplete", "Aborted by the user. Work done so far is saved in the workspace.", [], "aborted");
      }
      const message = err instanceof Error ? err.message : String(err);
      return final("incomplete", `The model provider failed: ${message}`, [message], "error");
    }

    if (res.usage) {
      usage.promptTokens += res.usage.promptTokens;
      usage.completionTokens += res.usage.completionTokens;
      counters.tokens.add(res.usage.promptTokens + res.usage.completionTokens);
    }
    if (res.reasoning?.trim()) {
      emit({ type: "assistant_thinking", text: res.reasoning }, { iteration: steps });
    }
    if (res.content?.trim()) {
      // full text — the frontend REPLACES the bubble content with this
      emit({ type: "assistant_text", text: res.content }, { iteration: steps });
    }

    // ── no tool call: the model's answer IS the final answer ──
    // (A FULLY empty turn — no content, no reasoning, no tool calls — is a
    // transient free-model glitch: nudge ONCE with an explicit continue
    // observation before accepting it. An empty answer twice settles
    // honestly as an empty final answer.)
    if (res.toolCalls.length === 0) {
      const hasText = Boolean(res.content?.trim() || res.reasoning?.trim());
      if (!hasText && !emptyTurnNudged) {
        emptyTurnNudged = true;
        messages.push({ role: "assistant", content: "" });
        messages.push({
          role: "user",
          content:
            "(system nudge: your last response was empty — no text and no tool calls. " +
            "Continue the task: either use a tool or give your final answer.)",
        });
        continue;
      }
      const { summary, issues } = finalAnswerFromContent(res.content ?? "", res.reasoning);
      if (!summary) {
        return final(
          "incomplete",
          "The model returned an empty final answer — the run ended without a summary. Work done so far is saved in the workspace.",
          ["empty final answer"],
          "final-answer",
        );
      }
      return final("complete", summary, issues, "final-answer");
    }
    emptyTurnNudged = false;

    // ── tool calls: act, observe, continue ──
    messages.push({ role: "assistant", content: res.content ?? "", toolCalls: res.toolCalls });

    for (const call of res.toolCalls) {
      // finish: the model's own decision to stop
      if (call.name === "finish") {
        const args = parseArgs(call.arguments);
        const status = args["status"] === "incomplete" ? "incomplete" : "complete";
        const summary = typeof args["summary"] === "string" && args["summary"].trim() ? args["summary"].trim() : "(no summary provided)";
        const issues = Array.isArray(args["remaining_issues"])
          ? args["remaining_issues"].filter((i): i is string => typeof i === "string" && i.trim() !== "").slice(0, 20)
          : [];
        return final(status, summary.slice(0, 20_000), issues, "finish");
      }

      const tool = tools.find((t) => t.name === call.name);
      const args = parseArgs(call.arguments);
      let content: string;
      if (!tool) {
        content = `error: unknown tool "${call.name}" — available tools: ${[...tools.map((t) => t.name), "finish"].join(", ")}`;
        emit({ type: "tool_used", tool: call.name, status: "error", detail: "unknown tool" }, { iteration: steps });
      } else {
        const started = Date.now();
        let status = "ok";
        let detail = call.name;
        try {
          const outcome = await tool.execute(args, ctx);
          content = outcome.content;
          detail = describeCall(call.name, args, Date.now() - started);
        } catch (err) {
          status = "error";
          content = observationForError(err);
          detail = `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        emit({ type: "tool_used", tool: call.name, status, detail }, { iteration: steps });
      }
      messages.push({ role: "tool", content, toolCallId: call.id, name: call.name });
    }
  }
}

function describeCall(name: string, args: Record<string, unknown>, durationMs: number): string {
  const primary =
    typeof args["command"] === "string"
      ? args["command"]
      : typeof args["path"] === "string"
        ? args["path"]
        : typeof args["url"] === "string"
          ? args["url"]
          : typeof args["question"] === "string"
            ? args["question"]
            : "";
  return `${name}(${primary.slice(0, 120)}) — ${Math.round(durationMs / 100) / 10}s`;
}
