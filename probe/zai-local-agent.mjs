/**
 * Forgevi 3.0 — z.ai local agent test (the real-LLM run).
 *
 * A real GLM tool-calling agent builds a real Node web server inside the
 * local sandbox: files on disk, background server on the assigned port,
 * self-verified with curl, then finish. This is the "z.ai local agent"
 * gate before the live browser test.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

const BASE = process.env.ENGINE_URL ?? "http://127.0.0.1:3010";
const projectId = process.env.ZAI_PROJECT ?? `zai-${Date.now()}`;

const OBJECTIVE = [
  "Create a minimal Node.js web app in the workspace root:",
  "1. package.json (name \"forgevi-live\", private, no dependencies)",
  "2. server.js using ONLY the built-in http module that responds to every request with the exact text: Forgevi 3.0 live",
  "Start the server in the background on the port from the task context (nohup node server.js > server.log 2>&1 &),",
  "wait a moment, verify it with curl, then finish.",
].join(" ");

async function readSse(runId, timeoutMs = 600_000) {
  const frames = [];
  let sawClose = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/runs/${runId}/events?since=0`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let eventName = "";
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (eventName === "forge-close" && data === "closed") {
          sawClose = true;
          controller.abort();
          break;
        }
        if (data) {
          try {
            const frame = JSON.parse(data);
            frames.push(frame);
            if (frame.event?.type === "tool_used") {
              console.log(`    [tool] ${frame.event.tool} ${frame.event.status} — ${String(frame.event.detail).slice(0, 90)}`);
            } else if (frame.event?.type === "iteration_started") {
              console.log(`  — step ${frame.event.iteration}`);
            } else if (frame.event?.type === "assistant_text") {
              console.log(`    [agent] ${String(frame.event.text).slice(0, 140).replace(/\n/g, " ")}`);
            }
          } catch {
            /* skip */
          }
        }
      }
      if (sawClose) break;
    }
  } catch {
    /* aborted */
  } finally {
    clearTimeout(timer);
  }
  return { frames, sawClose };
}

console.log(`[zai-run] project=${projectId}`);
const start = await fetch(`${BASE}/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    objective: OBJECTIVE,
    acceptance: ["server.js serves 'Forgevi 3.0 live'", "the agent verified it with curl"],
    projectId,
  }),
});
const started = await start.json();
if (!started.runId) {
  console.error("run failed to start:", started);
  process.exit(1);
}
console.log(`[zai-run] runId=${started.runId} — streaming (real GLM agent):`);

const { frames, sawClose } = await readSse(started.runId);
const finished = frames.filter((f) => f.event?.type === "run_finished")[0];
const toolUsed = frames.filter((f) => f.event?.type === "tool_used");
const steps = frames.filter((f) => f.event?.type === "iteration_started").length;

console.log("\n[zai-run] ═══ RESULT ═══");
console.log(`forge-close: ${sawClose}`);
console.log(`steps: ${steps}, tool calls: ${toolUsed.length}`);
console.log(`status: ${finished?.event?.status}`);
console.log(`summary: ${String(finished?.event?.summary).slice(0, 500)}`);

let pass = true;
if (!sawClose || !finished) pass = false;
if (finished?.event?.status !== "complete") pass = false;

// artifacts on disk
const serverJs = await readFile(path.resolve("workspaces", projectId, "server.js"), "utf8").catch(() => null);
console.log(`server.js on disk: ${serverJs !== null}`);
if (!serverJs) pass = false;
const pkg = await readFile(path.resolve("workspaces", projectId, "package.json"), "utf8").catch(() => null);
console.log(`package.json on disk: ${pkg !== null} (forgevi-live: ${pkg?.includes("forgevi-live")})`);
if (!pkg?.includes("forgevi-live")) pass = false;

// the server the agent left running — find its port and curl it
try {
  const listeners = execSync("ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null", { encoding: "utf8" });
  const ports = [...listeners.matchAll(/:(41[0-9]{2}|4180)\s/mg)].map((m) => m[1]);
  let served = null;
  for (const port of new Set(ports)) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3000) });
      const text = await res.text();
      if (text.includes("Forgevi 3.0 live")) served = port;
    } catch {
      /* not this one */
    }
  }
  console.log(`live server check: ${served ? `ANSWERING on :${served} with the exact text ✓` : "not found"}`);
  if (!served) pass = false;
} catch (err) {
  console.log(`live server check skipped (${err instanceof Error ? err.message : err})`);
}

console.log(`\n[zai-run] ${pass ? "PASS ✅" : "FAIL ❌"}`);
process.exit(pass ? 0 : 1);
