/**
 * Forgevi 3.0 — the mock provider (self-test probe only).
 *
 * Deterministic scripted turns so the probe can prove the WHOLE engine
 * (wire contract, journal, sandbox execution, tool dispatch, finish
 * semantics) without any network. The script is chosen by markers in the
 * objective — the probe drives several scenarios through one engine.
 *
 *   default objective  → build/verify/finish scenario
 *   "loop forever"     → endless sleep commands (abort test)
 *   "fail loudly"      → engine-level failure (run_error test)
 */

import type { ChatMessage, ChatResult, LLMProvider, ToolDef } from "./provider.ts";

interface ScriptedTurn {
  content?: string;
  toolCalls?: Array<{ name: string; args: string }>;
}

function toolResultSummary(messages: ChatMessage[]): string {
  const tools = messages.filter((m) => m.role === "tool").map((m) => m.content);
  return tools.length ? tools[tools.length - 1]! : "(no observations yet)";
}

function scriptFor(objective: string): ScriptedTurn[] {
  if (/loop forever/i.test(objective)) {
    // Never finishes — every turn re-issues a slow command.
    return Array.from({ length: 1000 }, () => ({
      content: "Still working — sleeping another round.",
      toolCalls: [{ name: "execute_command", args: JSON.stringify({ command: "sleep 30", timeout_s: 35 }) }],
    }));
  }
  // Default: build → verify → finish.
  return [
    {
      content: "I'll create the file and verify it on disk.",
      toolCalls: [
        { name: "execute_command", args: JSON.stringify({ command: "echo 'forgevi-3 was here' > hello.txt && ls -la" }) },
      ],
    },
    {
      content: "The file landed. Now writing package.json.",
      toolCalls: [
        {
          name: "write_file",
          args: JSON.stringify({ path: "package.json", content: '{\n  "name": "forgevi-3-probe",\n  "version": "1.0.0"\n}\n' }),
        },
      ],
    },
    {
      content: "Both artifacts are in the workspace. Verifying, then finishing.",
      toolCalls: [{ name: "execute_command", args: JSON.stringify({ command: "cat hello.txt package.json" }) }],
    },
    {
      content: "Everything verified.",
      toolCalls: [
        {
          name: "finish",
          args: JSON.stringify({ status: "complete", summary: "Created hello.txt and package.json and verified both on disk." }),
        },
      ],
    },
  ];
}

export function createMockProvider(): LLMProvider {
  let turn = -1;
  let script: ScriptedTurn[] | null = null;
  let lastObjective = "";
  return {
    name: "mock",
    model: "mock",
    async chat(messages: ChatMessage[], _tools: ToolDef[], opts): Promise<ChatResult> {
      if (opts?.signal?.aborted) throw new Error("aborted");
      const user = [...messages].reverse().find((m) => m.role === "user");
      const objective = user?.content ?? "";
      // A fresh conversation (no assistant/tool turns yet) re-arms the
      // script — same objective twice (two probe runs) still starts clean.
      const isFreshConversation = !messages.some((m) => m.role === "tool" || m.role === "assistant");
      if (isFreshConversation || objective !== lastObjective || !script) {
        lastObjective = objective;
        script = scriptFor(objective);
        turn = -1;
      }
      if (/fail loudly/i.test(objective)) {
        throw new Error("mock provider: simulated LLM failure");
      }
      const scripted = script[++turn] ?? script[script.length - 1]!;
      return {
        content: scripted.content ?? "",
        toolCalls: (scripted.toolCalls ?? []).map((c, i) => ({
          id: `mock_${turn}_${i}`,
          name: c.name,
          arguments: c.args,
        })),
        model: "mock",
      };
    },
  };
}

/** Exported for the probe: inspect what the loop actually observed. */
export { toolResultSummary as __toolResultSummary };
