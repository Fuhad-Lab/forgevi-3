/**
 * Forgevi — the run manager.
 *
 * A run is one async function in one process: verify grant → boot sandbox
 * (silent restore + uploads + scaffold) → run ONE OpenHands agent in the
 * workspace → persist snapshot (silent) → close the journal. No Redis
 * bus, no Temporal workflow, no orchestrator — and NO custom agent loop:
 * the openhands-sdk owns the loop, the tools, and the finish decision.
 */

import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { verifyWorkspaceGrant } from "../grant.ts";
import { createSandbox, type SandboxAdapter } from "../e2b-backblaze/sandbox.ts";
import { createStorage } from "../e2b-backblaze/storage.ts";
import { bootWorkspace, persistWorkspace } from "../e2b-backblaze/template.ts";
import {
  ensureProjectDevServer,
  holdProjectSandbox,
  releaseProjectSandbox,
  getProjectSandbox,
  rememberProjectDevPort,
} from "./workspace-service.ts";
import {
  resolveLlmConfig,
  resolveLaneLlm,
  runOpenHands,
  isOpenRouterQuotaSignature,
  type LlmConfig,
  type OpenHandsEvent,
} from "../openhands.ts";
import { buildTaskPrompt, type ChatHistoryRow } from "../task.ts";
import { normalizeUploads, type RawUpload } from "../uploads/uploads.ts";
import { RunJournal, type JournalEvent } from "./journal.ts";
import { counters, initTelemetry } from "../tools/monitoring/telemetry.ts";
import {
  appendProjectTurn,
  cacheProjectChat,
  cacheRunEvent,
  loadProjectChat,
  mergeChatHistories,
  redisConfigured,
} from "../redis.ts";

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

// ── LLM resolution ─────────────────────────────────────────────────────

/** Resolves the run's LLM or fails with the honest config error. */
export function getLlmConfig() {
  return resolveLlmConfig();
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
  // THE REDIS JOURNAL CACHE (best-effort frame sink — restart resilience)
  const journal = new RunJournal(runId, sessionId, goalId, (frame) => {
    if (redisConfigured()) void cacheRunEvent(runId, frame.seq, frame);
  });

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

interface OpenHandsOutcome {
  status: "complete" | "incomplete";
  summary: string;
  remainingIssues: string[];
  stopReason: string;
  actions: number;
}

/** Map an OpenHands worker event onto the Forgvi journal vocabulary. */
function journalEventFor(ev: OpenHandsEvent): JournalEvent | null {
  switch (ev.type) {
    case "thinking":
      return { type: "assistant_thinking", text: ev.text };
    case "message":
      return { type: "assistant_text", text: ev.text };
    case "action":
      return { type: "tool_used", tool: ev.tool, status: "ok", detail: ev.detail ?? ev.tool };
    case "file":
      // THE CODE-STREAM LAW (user fix 2026-09-21): the worker caps and
      // forwards the file BODY — the studio's fragments code panel
      // streams real code, not just paths.
      return {
        type: "file_written",
        path: ev.path,
        by: "agent",
        ...(typeof (ev as { content?: string }).content === "string"
          ? { content: (ev as { content: string }).content }
          : {}),
      };
    case "error":
      return { type: "tool_used", tool: "openhands", status: "error", detail: ev.error };
    case "finished":
      return null; // terminal — handled by the executor
    default:
      return null;
  }
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
  let outcome: OpenHandsOutcome | null = null;
  let hardError: string | null = null;
  /** THE ONE-SANDBOX LAW: a project-bound run works in the project's
   *  REGISTERED sandbox — the very machine the studio surface serves
   *  (uploads, Files tab, terminal). The agent and the user share ONE
   *  workspace; the B2 snapshot only carries state across sandbox death
   *  (reaper / deploys), never between the agent and the studio. */
  let sharedSandbox = false;

  try {
    if (run.projectId) {
      sandbox = await getProjectSandbox(run.projectId);
      sharedSandbox = true;
      holdProjectSandbox(run.projectId);
    } else {
      sandbox = await createSandbox(`run-${view.runId.slice(0, 12)}`);
    }
    run.devPort = pickDevPort();
    run.sandbox = sandbox;
    // THE DEV-SERVER LAW: the port lands on the PROJECT entry — the
    // preview surface serves it for the sandbox's whole life, not just
    // the run's.
    if (run.projectId && run.devPort) rememberProjectDevPort(run.projectId, run.devPort);

    // THE PREVIEW-WATCHER LAW (user fix 2026-09-21): the moment the
    // agent's dev server answers on the assigned port, the journal says
    // so — the studio's preview flips live MID-RUN instead of waiting
    // for the run to end. One announcement per run (then the watcher
    // exits); a stopped/restarted server is the preview route's business.
    void (async () => {
      if (!sandbox || !run.devPort) return;
      const port = run.devPort;
      const url = sandbox.appUrl(port);
      for (let i = 0; i < 200 && !abort.signal.aborted; i++) {
        await new Promise((r) => setTimeout(r, 12_000));
        if (abort.signal.aborted || view.status !== "running") return;
        try {
          const probe = await sandbox.exec(
            `curl -s -o /dev/null -m 4 -w "%{http_code}" http://127.0.0.1:${port} || true`,
            { timeoutMs: 8_000 },
          );
          if (/^\d{3}$/.test(probe.stdout.trim()) && probe.stdout.trim() !== "000") {
            emit({ type: "dev_server_ready", appUrl: url, devPort: port });
            return;
          }
        } catch {
          /* probe failures just mean not-yet */
        }
      }
    })();
    // SILENT boot: restore + uploads + scaffold — never in the stream.
    // A shared sandbox skips the restore (getProjectSandbox already
    // restored a fresh one, and a LIVE one must never be snapshotted over).
    await bootWorkspace({ sandbox, storage: createStorage(), workspaceKey, uploads: uploadFiles, skipRestore: sharedSandbox });

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

    const llmResult = getLlmConfig();
    if (!llmResult.ok || !llmResult.llm) {
      throw new Error(llmResult.error || "the engine has no LLM configured");
    }

    // THE CONTINUITY LAW (the fix for "every message = a new project"):
    // the frontend-supplied chat history rides every run — and the Redis
    // cache fills any gap (engine restart, lost cookie, new device), so
    // the conversation CONTINUES instead of starting fresh. The merged
    // history is cached back (best-effort) for the next run.
    let chatHistory: ChatHistoryRow[] = Array.isArray(input.chatHistory) ? input.chatHistory : [];
    if (workspaceKey) {
      const cached = await loadProjectChat(workspaceKey);
      chatHistory = mergeChatHistories(chatHistory, cached);
      if (chatHistory.length > 0) {
        void cacheProjectChat(workspaceKey, chatHistory.map((m) => ({ role: m.role, content: m.content, at: Date.now() })));
      }
    }

    const prompt = buildTaskPrompt(
      {
        objective: view.objective,
        acceptance: view.acceptance,
        ...(input.appName ? { appName: input.appName } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        devPort: run.devPort,
        uploads: uploadManifest,
      },
      chatHistory,
    );

    // THE mandate: ONE real OpenHands agent, one conversation, one workspace.
    const runLane = async (llm: LlmConfig): Promise<OpenHandsOutcome | null> => {
      let actions = 0;
      let laneOutcome: OpenHandsOutcome | null = null;
      for await (const ev of runOpenHands({
        workspace: sandbox!.cwd,
        // THE IN-VM AGENT LAW: the worker executes INSIDE the run's
        // sandbox — the same machine the studio surface serves. E2B:
        // streamed stdout over the commands API; local: host spawn.
        sandbox: sandbox!,
        prompt,
        llm,
        signal: abort.signal,
      })) {
        if (ev.type === "finished") {
          laneOutcome = {
            status: ev.status === "complete" ? "complete" : "incomplete",
            summary: ev.summary || "(no summary provided)",
            remainingIssues: Array.isArray(ev.issues) ? ev.issues.filter((i) => typeof i === "string" && i.trim()).slice(0, 20) : [],
            stopReason: ev.status === "complete" ? "finish" : abort.signal.aborted ? "aborted" : "openhands",
            actions,
          };
          break;
        }
        if (ev.type === "action") {
          actions += 1;
          counters.steps.add(1);
          emit(journalEventFor(ev) ?? { type: "tool_used", tool: ev.tool, status: "ok" }, { iteration: actions });
        } else {
          const event = journalEventFor(ev);
          if (event) emit(event);
        }
      }
      return laneOutcome;
    };

    outcome = await runLane(llmResult.llm);
    llmResult.pick?.reportSuccess();

    // THE KEY-POOL CASCADE: when the lane died with the quota/429 signature
    // (a key's free tier is exhausted), rotate to the NEXT pooled key +
    // next model in the chain — announced in the stream, never silent.
    // The NVIDIA NIM lane remains the final failover when configured.
    if (outcome && !abort.signal.aborted) {
      const signature = `${outcome.summary} ${outcome.remainingIssues.join(" ")}`;
      let quotaHit = outcome.status === "incomplete" && isOpenRouterQuotaSignature(signature);
      let laneIdx = 1;
      while (
        quotaHit &&
        !abort.signal.aborted &&
        laneIdx < Math.max(1, llmResult.modelChain.length)
      ) {
        const lane = resolveLaneLlm(laneIdx);
        if (!lane) break; // the pool is exhausted — fall through to NIM
        emit({
          type: "tool_used",
          tool: "engine",
          status: "ok",
          detail: `OpenRouter lane exhausted (${llmResult.modelChain[laneIdx - 1] ?? "primary"}) — rotating to the next pooled key + model: ${llmResult.modelChain[laneIdx]}`,
        });
        outcome = await runLane(lane.llm);
        lane.pick.reportSuccess();
        laneIdx += 1;
        quotaHit =
          outcome !== null &&
          outcome.status === "incomplete" &&
          isOpenRouterQuotaSignature(`${outcome.summary} ${outcome.remainingIssues.join(" ")}`);
      }
      // the final failover lane (NVIDIA NIM) when the whole pool is dry
      const nvidiaExhausted =
        outcome &&
        !abort.signal.aborted &&
        llmResult.nvidia &&
        outcome.status === "incomplete" &&
        isOpenRouterQuotaSignature(`${outcome.summary} ${outcome.remainingIssues.join(" ")}`);
      if (nvidiaExhausted && outcome && llmResult.nvidia) {
        emit({
          type: "tool_used",
          tool: "engine",
          status: "ok",
          detail: "OpenRouter pool exhausted — switching this run to the NVIDIA lane",
        });
        outcome = await runLane(llmResult.nvidia);
      }
    }
  } catch (err) {
    hardError = err instanceof Error ? err.message : String(err);
    console.error(`[run ${view.runId}] execution error: ${hardError}`);
  } finally {
    // SILENT persist — the workspace survives, the stream never mentions it
    if (sandbox) {
      await persistWorkspace({ sandbox, storage: createStorage(), workspaceKey }).catch((err) => {
        console.error(`[run ${view.runId}] snapshot failed (workspace work is still on disk/in the sandbox): ${err instanceof Error ? err.message : String(err)}`);
      });
      if (sharedSandbox && run.projectId) {
        // THE ONE-SANDBOX LAW: the project's sandbox OUTLIVES the run —
        // the idle reaper owns its lifecycle (release re-arms the TTL).
        // Never destroy the machine the studio surface is still serving.
        releaseProjectSandbox(run.projectId);
        // THE POST-RUN PREVIEW LAW (user fix 2026-09-21): the preview must
        // NOT die with the run. If the agent left a dev server running, the
        // announcement below simply confirms it; if it did not, the engine
        // starts one on the remembered port (best-effort, never blocks the
        // run's terminal settle — the journal is already closed by then, so
        // the studio learns through the preview route / restart button).
        if (!abort.signal.aborted) {
          void ensureProjectDevServer(run.projectId).catch((err) => {
            console.error(
              `[run ${view.runId}] post-run dev-server ensure failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
            );
          });
        }
      } else {
        await sandbox.destroy();
      }
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
      usage: { promptTokens: 0, completionTokens: 0 },
    };
    if (outcome.stopReason === "error") {
      emit({ type: "run_error", error: outcome.summary });
    }
    // THE PREVIEW-CONFIRMATION LAW: before the terminal frame, announce the
    // live preview URL when the dev server is answering — the studio flips
    // its preview surface the instant the run settles.
    if (sharedSandbox && run.projectId && run.devPort && sandbox && !abort.signal.aborted) {
      try {
        const probe = await sandbox.exec(
          `curl -s -o /dev/null -m 4 -w "%{http_code}" http://127.0.0.1:${run.devPort} || true`,
          { timeoutMs: 8_000 },
        );
        if (/^\d{3}$/.test(probe.stdout.trim()) && probe.stdout.trim() !== "000") {
          emit({ type: "dev_server_ready", appUrl: sandbox.appUrl(run.devPort), devPort: run.devPort });
        }
      } catch {
        /* not serving — the post-run ensure owns it */
      }
    }
    emit({
      type: "run_finished",
      status: outcome.status,
      summary: outcome.summary,
      verificationScore: 0, // honest: the agent self-verified via OpenHands
      iterations: outcome.actions || view.iteration,
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
  // THE MESSAGE-CACHING LAW: the completed turn lands in the Redis cache
  // (best-effort) — the next run's continuity merge reads it back.
  if (workspaceKey && !abort.signal.aborted) {
    const assistantSummary =
      view.report?.summary ??
      (hardError ? `The run failed: ${hardError}` : "(no summary provided)");
    void appendProjectTurn(workspaceKey, { user: view.objective, assistant: assistantSummary.slice(0, 20_000) });
  }

  journal.close();
}
