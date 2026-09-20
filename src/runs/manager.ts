/**
 * Forgevi 3.0 — the run manager.
 *
 * A run is one async function in one process: verify grant → boot sandbox
 * (silent restore + uploads + scaffold) → discover MCP → run the ONE
 * agent loop → persist snapshot (silent) → close the journal. No Redis
 * bus, no Temporal workflow, no orchestrator — durability comes from the
 * snapshot at run end and the frontend's honest 404-poll fallback.
 */

import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { verifyWorkspaceGrant } from "../grant.ts";
import { createSandbox, type SandboxAdapter } from "../e2b-backblaze/sandbox.ts";
import { createStorage } from "../e2b-backblaze/storage.ts";
import { bootWorkspace, persistWorkspace } from "../e2b-backblaze/template.ts";
import { createZaiProvider } from "../llm/zai.ts";
import { createMockProvider } from "../llm/mock.ts";
import { createOpenRouterProvider } from "../llm/openrouter.ts";
import { createNvidiaProvider } from "../llm/nvidia.ts";
import type { ChatMessage, ChatResult, LLMProvider, ToolDef } from "../llm/provider.ts";
import { assembleContext, type ChatHistoryRow } from "../agentic-framework/context.ts";
import { runAgentLoop, type AgentLoopResult } from "../agentic-framework/agent.ts";
import { CORE_TOOLS, type AgentTool, type ToolCtx } from "../tools/registry.ts";
import { browserPreviewTool } from "../tools/browser.ts";
import { analyzeImageTool } from "../tools/sub-agents/analyze-image.ts";
import { discoverMcpSessions, closeSessions } from "../tools/mcp/discovery.ts";
import { mcpToolsForSession } from "../tools/mcp/tools.ts";
import type { McpSession } from "../tools/mcp/client.ts";
import { normalizeUploads, type RawUpload } from "../uploads/uploads.ts";
import { RunJournal, type JournalEvent } from "./journal.ts";
import { counters, initTelemetry, withSpan } from "../tools/monitoring/telemetry.ts";

export interface StartRunInput {
  objective: string;
  acceptance: unknown[];
  workspaceGrant?: string;
  files?: RawUpload[];
  appName?: string;
  platform?: string;
  chatHistory?: ChatHistoryRow[];
  /** THE UPLOAD-FOLDER LAW: filenames the user uploaded through the
   *  workspace-upload action before starting the run — the engine
   *  enhances the USER prompt with the uploads/ manifest. */
  uploadedFiles?: string[];
  /** DEV-ONLY (FORGVI3_ALLOW_UNGRANTED_PROJECTS=1): bind without a grant. */
  projectId?: string;
}

export interface RunView {
  runId: string;
  goalId: string;
  status: "running" | "complete" | "incomplete";
  objective: string;
  acceptance: string[];
  iteration: number;
  budgets: Record<string, number>;
  workspace: { sandboxId: string; projectId: string; bound: true } | { bound: false };
  startedAt: number;
  finishedAt?: number;
  report?: {
    summary: string;
    remainingIssues: string[];
    stopReason: string;
    usage: { promptTokens: number; completionTokens: number };
  };
  eventCount: number;
}

interface RunState {
  view: RunView;
  journal: RunJournal;
  abort: AbortController;
  sessionId: string;
  workspaceKey: string | null;
  projectId: string | null;
  devPort: number | null;
  sandbox?: SandboxAdapter;
}

// ── provider singleton ─────────────────────────────────────────────────

let providerPromise: Promise<LLMProvider> | null = null;

/** OpenRouter's free tier is account-wide: once the daily request budget
 *  is gone EVERY model on the chain 429s with the same signature. */
function isFreeTierExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /free-models-per-day|free_tier_daily|Rate limit exceeded/i.test(msg);
}

/** Wrap the openrouter provider with the NVIDIA NIM failover lane. Once a
 *  free-tier exhaustion is seen, the wrapper latches to NVIDIA for the
 *  rest of the process's lifetime (the OpenRouter budget will not come
 *  back until 00:00 UTC — retrying it mid-run just burns steps). */
function withNvidiaFailover(primary: LLMProvider): LLMProvider {
  if (!config.nvidia) return primary;
  let latched: LLMProvider | null = null;
  return {
    name: "openrouter+nvidia",
    model: primary.model,
    async chat(messages: ChatMessage[], tools: ToolDef[], opts): Promise<ChatResult> {
      if (latched) return latched.chat(messages, tools, opts);
      try {
        return await primary.chat(messages, tools, opts);
      } catch (err) {
        if (opts?.signal?.aborted || !isFreeTierExhausted(err)) throw err;
        console.warn(`[provider] OpenRouter free tier exhausted — failing over to NVIDIA NIM for the rest of this process`);
        latched = createNvidiaProvider();
        return latched.chat(messages, tools, opts);
      }
    },
  };
}

export function getProvider(): Promise<LLMProvider> {
  if (!providerPromise) {
    providerPromise = (async () => {
      if (config.provider === "mock") return createMockProvider();
      if (config.provider === "zai") return await createZaiProvider();
      return withNvidiaFailover(createOpenRouterProvider());
    })().catch((err) => {
      providerPromise = null; // honest retry on next request
      throw err;
    });
  }
  return providerPromise;
}

// ── manager state ──────────────────────────────────────────────────────

const runs = new Map<string, RunState>();
let totalRuns = 0;

export function activeRunCount(): number {
  let active = 0;
  for (const state of runs.values()) if (state.view.status === "running") active++;
  return active;
}

export function totalRunCount(): number {
  return totalRuns;
}

export function getRunView(runId: string): RunView | null {
  return runs.get(runId)?.view ?? null;
}

export function getRunJournal(runId: string): RunJournal | null {
  return runs.get(runId)?.journal ?? null;
}

/** The live (running) run journal for a project — studio writes journal into
 *  it so the stream log shows user edits like agent writes. Null when idle. */
export function findLiveRunForProject(projectId: string): RunJournal | null {
  for (const state of runs.values()) {
    if (state.projectId === projectId && state.view.status === "running") return state.journal;
  }
  return null;
}

/** The dev port a live run for this project was assigned (preview surface). */
export function liveRunDevPort(projectId: string): number | null {
  for (const state of runs.values()) {
    if (state.projectId === projectId && state.view.status === "running") return state.devPort;
  }
  return null;
}

export function abortRun(runId: string, reason?: string): RunView | null {
  const state = runs.get(runId);
  if (!state) return null;
  if (state.view.status === "running") {
    state.abort.abort();
    state.journal.append({ type: "run_abort_requested", ...(reason ? { reason } : {}) });
  }
  return state.view;
}

// ── run start ──────────────────────────────────────────────────────────

export function startRun(input: StartRunInput): { status: number; body: Record<string, unknown> } {
  initTelemetry();

  const objective = input.objective?.trim();
  if (!objective) {
    return { status: 400, body: { error: "objective is required" } };
  }
  const acceptance = Array.isArray(input.acceptance)
    ? input.acceptance.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim())
    : [];
  if (acceptance.length === 0) {
    return { status: 400, body: { error: "acceptance is required (the definition of done)" } };
  }

  if (activeRunCount() >= config.maxConcurrent) {
    return { status: 429, body: { error: "engine at max concurrency — retry shortly" } };
  }

  // workspace binding — the grant IS the auth (fg1. HMAC from the backend)
  let projectId: string | null = null;
  let sandboxIdClaim: string | null = null;
  if (input.workspaceGrant) {
    const claims = verifyWorkspaceGrant(input.workspaceGrant, { secret: config.grantSecret });
    if (!claims) {
      return { status: 400, body: { error: "invalid or expired workspace grant" } };
    }
    projectId = claims.projectId;
    sandboxIdClaim = claims.sandboxId;
  } else if (input.projectId && process.env.FORGVI3_ALLOW_UNGRANTED_PROJECTS === "1") {
    // development affordance ONLY — set the env explicitly to opt in
    projectId = input.projectId;
  }

  // uploads (honest validation — never start a run on a lie)
  let files: ReturnType<typeof normalizeUploads>;
  try {
    files = normalizeUploads(input.files);
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
  const uploadManifest = files.manifest;

  const runId = randomUUID();
  const goalId = randomUUID();
  const sessionId = `s-${randomUUID().slice(0, 8)}`;
  const journal = new RunJournal(runId, sessionId, goalId);

  const run: RunState = {
    view: {
      runId,
      goalId,
      status: "running",
      objective,
      acceptance,
      iteration: 0,
      budgets: {
        maxIterations: 0,
        wallClockMs: config.maxWallclockMs,
        tokenBudget: config.maxTokens,
      },
      workspace: projectId ? { sandboxId: sandboxIdClaim ?? `f3-${runId.slice(0, 8)}`, projectId, bound: true } : { bound: false },
      startedAt: Date.now(),
      eventCount: 0,
    },
    journal,
    abort: new AbortController(),
    sessionId,
    workspaceKey: projectId ?? null,
    projectId,
    devPort: null,
  };
  runs.set(runId, run);
  totalRuns += 1;
  counters.runs.add(1);

  // fire and forget — the SSE stream and GET /runs/:id observe it
  void executeRun(run, input, files.files, uploadManifest).catch((err) => {
    console.error(`[run ${runId}] executor crashed: ${err instanceof Error ? err.stack : String(err)}`);
  });

  return {
    status: 201,
    body: {
      runId,
      goalId,
      status: "running",
      workspace: run.view.workspace,
    },
  };
}

/** List the run's workspace files (local sandbox persists post-run; E2B is destroyed — honest 404). */
export async function listRunFiles(runId: string): Promise<{ path: string; type: string; size?: number }[] | null> {
  const state = runs.get(runId);
  if (!state?.sandbox) return null;
  try {
    return await state.sandbox.listDir("", { recursive: true, maxEntries: 400 });
  } catch {
    return null;
  }
}

// ── run execution ──────────────────────────────────────────────────────

const DEV_PORT_RANGE_START = 4100;
const DEV_PORT_RANGE_SIZE = 80;

function pickDevPort(): number {
  return DEV_PORT_RANGE_START + Math.floor(Math.random() * DEV_PORT_RANGE_SIZE);
}

async function executeRun(
  run: RunState,
  input: StartRunInput,
  uploadFiles: { path: string; content: string | Buffer }[],
  uploadManifest: { path: string; contentType: string; bytes: number }[],
): Promise<void> {
  const { view, journal, abort, workspaceKey } = run;
  const emit = (event: JournalEvent, meta?: { iteration?: number }) => {
    journal.append(event, meta);
    view.eventCount = journal.eventCount;
    if (meta?.iteration) view.iteration = meta.iteration;
  };

  emit({
    type: "run_started",
    objective: view.objective,
    acceptance: view.acceptance,
    budgets: view.budgets,
  });

  let sandbox: SandboxAdapter | null = null;
  let sessions: McpSession[] = [];
  let outcome: AgentLoopResult | null = null;
  let hardError: string | null = null;

  try {
    sandbox = await withSpan("forgevi.sandbox.create", { "forgevi.run_id": view.runId }, async () => {
      const adapter = await createSandbox(workspaceKey ?? `run-${view.runId.slice(0, 12)}`);
      run.devPort = pickDevPort();
      run.sandbox = adapter;
      return adapter;
    });

    // SILENT boot: restore + uploads + scaffold — never in the stream
    await bootWorkspace({ sandbox, storage: createStorage(), workspaceKey, uploads: uploadFiles });

    // THE UPLOAD-FOLDER LAW (pre-uploaded files): uploads that landed
    // through the workspace-upload action BEFORE this run started — the
    // manifest enhances the USER prompt (never the system prompt).
    if (uploadManifest.length === 0) {
      const onDisk = await sandbox.listDir("uploads", { maxEntries: 50 }).catch(() => []);
      for (const entry of onDisk) {
        if (entry.type !== "file") continue;
        uploadManifest.push({
          path: entry.path.replace(/^uploads\//, ""),
          contentType: "binary",
          bytes: entry.size ?? 0,
        });
      }
    }

    if (view.workspace.bound) {
      emit({
        type: "workspace_bound",
        sandboxId: sandbox.kind === "e2b" ? sandbox.id : view.workspace.sandboxId,
        projectId: view.workspace.projectId,
      });
    }

    const provider = await getProvider();

    // MCP auto-discovery (failures skip honestly — stderr only)
    sessions = await discoverMcpSessions().then((d) => d.sessions);

    const tools: AgentTool[] = [...CORE_TOOLS, browserPreviewTool];
    if (provider.vision) tools.push(analyzeImageTool); // optional — the agent decides
    for (const session of sessions) tools.push(...mcpToolsForSession(session));

    const ctx: ToolCtx = {
      runId: view.runId,
      sandbox,
      signal: abort.signal,
      provider,
      devPort: run.devPort,
      emit,
    };

    const messages = assembleContext(
      {
        objective: view.objective,
        acceptance: view.acceptance,
        ...(input.appName ? { appName: input.appName } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        devPort: run.devPort,
        uploads: uploadManifest,
      },
      Array.isArray(input.chatHistory) ? input.chatHistory : [],
    );

    outcome = await runAgentLoop({
      runId: view.runId,
      provider,
      tools,
      messages,
      ctx,
      emit,
      signal: abort.signal,
      ceilings: { maxSteps: config.maxSteps, maxWallclockMs: config.maxWallclockMs, maxTokens: config.maxTokens },
      startedAt: view.startedAt,
    });
  } catch (err) {
    hardError = err instanceof Error ? err.message : String(err);
    console.error(`[run ${view.runId}] execution error: ${hardError}`);
  } finally {
    await closeSessions(sessions);
    // SILENT persist — the workspace survives, the stream never mentions it
    if (sandbox) {
      await persistWorkspace({ sandbox, storage: createStorage(), workspaceKey }).catch((err) => {
        console.error(`[run ${view.runId}] snapshot failed (workspace work is still on disk/in the sandbox): ${err instanceof Error ? err.message : String(err)}`);
      });
      await sandbox.destroy();
    }
  }

  // settle the journal — exactly one terminal path
  const finishedAt = Date.now();
  view.finishedAt = finishedAt;
  if (hardError) {
    view.status = "incomplete";
    emit({ type: "run_error", error: hardError });
    emit({
      type: "run_finished",
      status: "incomplete",
      summary: `The run failed before completing: ${hardError}. Work completed before the failure is saved in the workspace.`,
      verificationScore: 0,
      iterations: view.iteration,
      durationMs: finishedAt - view.startedAt,
      remainingIssues: [hardError],
    });
  } else if (outcome) {
    view.status = outcome.status;
    view.report = {
      summary: outcome.summary,
      remainingIssues: outcome.remainingIssues,
      stopReason: outcome.stopReason,
      usage: outcome.usage,
    };
    if (outcome.stopReason === "error") {
      emit({ type: "run_error", error: outcome.summary });
    }
    emit({
      type: "run_finished",
      status: outcome.status,
      summary: outcome.summary,
      verificationScore: 0, // honest: no verifier role in 3.0 — the agent self-verified
      iterations: outcome.steps,
      durationMs: finishedAt - view.startedAt,
      remainingIssues: outcome.remainingIssues,
    });
  } else {
    view.status = "incomplete";
    emit({
      type: "run_finished",
      status: "incomplete",
      summary: "The run ended without a result — this is an engine bug, reported honestly.",
      verificationScore: 0,
      iterations: view.iteration,
      durationMs: finishedAt - view.startedAt,
      remainingIssues: ["engine error: no outcome"],
    });
  }
  journal.close();
}
