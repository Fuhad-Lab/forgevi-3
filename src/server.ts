/**
 * Forgevi 3.0 — the HTTP surface (the Forgvi wire contract).
 *
 * GET  /health              {ok:true, ...}
 * POST /runs                {objective, acceptance, workspaceGrant?, files?, appName?, platform?, chatHistory?}
 * GET  /runs/:id            run state
 * GET  /runs/:id/events?since=N   SSE — replay, live frames, 15s pings, forge-close
 * POST /runs/:id/abort      {reason?}
 * GET  /stats               engine stats (runs, active, model, pools)
 *
 * THE E2B POOL SURFACE (the pool laws):
 * GET  /e2b/pool            dashboard — seats, throttle, 429s, sessions
 *                           (guarded by E2B_POOL__API_TOKEN)
 * POST /e2b/pool/reconcile  provider-truth reconciliation — probes E2B with
 *                           the sandbox list per key and re-adopts live seats
 *                           (guarded by E2B_POOL__API_TOKEN)
 *
 * THE CONFIG-PUSH SURFACE (the deploy path — no Render dashboard needed):
 * POST /admin/config        {values: {KEY: value}} — relay-key guarded; the
 *                           edge function (master-email gated) pushes pool
 *                           keys and service credentials; env vars always
 *                           win, the runtime file fills gaps
 * GET  /admin/config        relay-key guarded — the runtime-config inspector:
 *                           the persisted runtime file's keys + the live
 *                           effective state (counts, template, chain). The
 *                           ops migration path: config-push writes the file,
 *                           this reads it back so the values can be lifted
 *                           into REAL env vars (Render dashboard / API).
 *
 * CORS allowlist per the contract; OPTIONS handled. No framework — one
 * Bun.serve, one process, no message bus behind it.
 */

import { config, writeRuntimeConfigFile, readRuntimeConfigFile, runtimeConfigPath, reloadEngineConfig } from "./config.ts";
import { abortRun, activeRunCount, getLlmConfig, getRunJournal, getRunView, listRunFiles, startRun, totalRunCount, findLiveRunForProject, type StartRunInput } from "./runs/manager.ts";
import { probeOpenHands, probeOpenHandsSync, openrouterPool, reloadOpenRouterPool } from "./openhands.ts";
import {
  projectFiles,
  projectReadFile,
  projectWriteFile,
  projectExec,
  projectUpload,
  projectUploadsManifest,
  projectStatus,
  projectHeartbeat,
  projectSessions,
  projectDevPort,
  projectPreviewUrl,
  ensureProjectDevServer,
  stopProjectDevServer,
  validProjectId,
  studioSafePath,
} from "./runs/workspace-service.ts";
import { e2bBroker, reloadE2BBroker } from "./e2b-backblaze/sandbox.ts";
import { b2BootstrapStatus, resetB2Bootstrap } from "./e2b-backblaze/b2.ts";
import { startTemplateSync, templateSyncStatus } from "./runs/template-sync.ts";
import { redisConfigured } from "./redis.ts";
import { loadRunEvents } from "./redis.ts";
import type { JournalEnvelope } from "./runs/journal.ts";

const VERSION = "3.2.3";
const KERNEL = "cline+openhands";

const ALLOWED_ORIGINS = new Set([
  // forgeyn.com — THE CANONICAL ORIGIN since the 2026-09-25 domain change
  // (the site now serves at the apex; www redirects to it). The retired
  // forgeyn.com.ng and studio.forgeyn.com origins stay allowed during the
  // transition window so cached clients keep working.
  "https://forgeyn.com",
  "https://www.forgeyn.com",
  "https://studio.forgeyn.com",
  "https://forgeyn.com.ng",
  "https://www.forgeyn.com.ng",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  ...config.extraOrigins,
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://forgeyn.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function notFound(origin: string | null): Response {
  return json({ error: "not found" }, 404, origin);
}

const PING_INTERVAL_MS = 15_000;

/** SSE stream: replay (seq > since) → live → forge-close → end. */
function sseResponse(runId: string, since: number, origin: string | null): Response {
  const journal = getRunJournal(runId);
  if (!journal) return notFound(origin);
  const encoder = new TextEncoder();
  const replay = journal.framesSince(since);
  const lastSeq = replay.length > 0 ? replay[replay.length - 1]!.seq : since;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* reader gone */
        }
      };
      send("retry: 3000\n\n");
      for (const frame of replay) send(`data: ${JSON.stringify(frame)}\n\n`);

      if (journal.isClosed) {
        send("event: forge-close\ndata: closed\n\n");
        controller.close();
        return;
      }

      const unsubscribe = journal.subscribe((frame: JournalEnvelope) => {
        send(`data: ${JSON.stringify(frame)}\n\n`);
      });
      const pingTimer = setInterval(() => send(": ping\n\n"), PING_INTERVAL_MS);
      const finish = () => {
        clearInterval(pingTimer);
        unsubscribe();
        send("event: forge-close\ndata: closed\n\n");
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      journal.closedPromise.then(finish).catch(finish);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(origin),
    },
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Warm the OpenHands capability probe once at boot so /health is fast.
void probeOpenHands().catch(() => undefined);
// Warm the B2 self-healing bootstrap once at boot (minted-key latency).
void b2BootstrapStatus().catch(() => undefined);

function providerLabel(): string {
  const llm = getLlmConfig();
  if (!llm.ok || !llm.llm) return "unconfigured";
  return llm.llm.model.replace(/^openai\//, "");
}

/** THE E2B POOL DASHBOARD SHAPE (seats, throttle, 429s, sessions). */
async function poolDashboard(): Promise<Record<string, unknown>> {
  return {
    broker: e2bBroker.stats(),
    b2: await b2BootstrapStatus(),
    redis: {
      configured: redisConfigured(),
      ...(config.redis ? { endpoint: config.redis.restUrl.replace(/^https:\/\//, "") } : {}),
    },
    lifecycle: {
      idleTtlMs: config.e2bIdleTtlMs,
      migrateAtMs: config.e2bMigrateAtMs,
      hardCapMs: config.e2bHardCapMs,
      seatsPerKey: config.e2bSeatsPerKey,
      spawnThrottleMs: config.e2bSpawnThrottleMs,
    },
    sessions: projectSessions(),
  };
}

/** PROVIDER-TRUTH RECONCILIATION — probe E2B with the sandbox list per
 *  key, re-adopt live seats (free-tier sleep / redeploy / crash drift). */
async function reconcilePool(): Promise<Record<string, unknown>> {
  if (config.e2bKeys.length === 0) {
    return { ok: false, error: "E2B pool has 0 keys — nothing to reconcile" };
  }
  const { Sandbox } = (await import("e2b")) as {
    Sandbox: { list: (opts?: Record<string, unknown>) => { nextItems: () => Promise<Array<{ sandboxId?: string }>>; hasNext: boolean } };
  };
  const liveCounts: Array<{ keyLabel: string; live: number; sandboxIds: string[]; error?: string }> = [];
  const stats = e2bBroker.stats();
  for (const keyStat of stats.keyStats) {
    const key = config.e2bKeys[stats.keyStats.indexOf(keyStat)];
    if (!key) continue;
    try {
      const paginator = Sandbox.list({ apiKey: key });
      const ids: string[] = [];
      while (paginator.hasNext) {
        const items = await paginator.nextItems();
        for (const item of items) {
          if (typeof item.sandboxId === "string") ids.push(item.sandboxId);
        }
      }
      liveCounts.push({ keyLabel: keyStat.label, live: ids.length, sandboxIds: ids });
    } catch (err) {
      liveCounts.push({
        keyLabel: keyStat.label,
        live: -1,
        sandboxIds: [],
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }
  e2bBroker.seedSlots(liveCounts.map((c) => ({ keyLabel: c.keyLabel, live: Math.max(0, c.live) })));
  return {
    ok: true,
    reconciled: liveCounts.map((c) => ({ key: c.keyLabel, live: c.live })),
    broker: e2bBroker.stats(),
  };
}

const server = Bun.serve({
  port: config.port,
  // SSE streams idle between events — Bun's default 10s idle timeout kills
  // them mid-run (live-observed). 255s is the ceiling; the 15s pings keep
  // every healthy stream far below it.
  idleTimeout: 255,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── health ──
    if (path === "/health" && request.method === "GET") {
      const llm = getLlmConfig();
      const probe = probeOpenHandsSync();
      const ok = llm.ok && (probe?.ok ?? false);
      return json(
        {
          ok,
          status: ok ? "ok" : "degraded",
          engine: "forgvi",
          version: VERSION,
          kernel: KERNEL,
          model: llm.ok && llm.llm ? llm.llm.model.replace(/^openai\//, "") : llm.error,
          agentLane: config.agentLane,
          agent: probe
            ? { ok: probe.ok, sdk: probe.sdk, tools: probe.tools, error: probe.error }
            : { ok: false, error: "probing" },
          sandbox: config.e2bKeys.length > 0 ? "e2b-pool" : "local",
          e2bTemplate: config.e2bTemplate ?? "default",
          storage: config.b2 ? "backblaze-b2" : "local-disk",
          redis: redisConfigured() ? "upstash" : "none",
          e2bPool: e2bBroker.stats(),
          openrouterPool: openrouterPool.stats(),
          activeRuns: activeRunCount(),
          totalRuns: totalRunCount(),
        },
        200,
        origin,
      );
    }

    // ── stats ──
    if (path === "/stats" && request.method === "GET") {
      const probe = probeOpenHandsSync();
      return json(
        {
          ok: true,
          version: VERSION,
          kernel: KERNEL,
          model: providerLabel(),
          agent: probe ? { ok: probe.ok, sdk: probe.sdk, tools: probe.tools } : { ok: false, error: "probing" },
          sandbox: config.e2bKeys.length > 0 ? "e2b-pool" : "local",
          e2bTemplate: config.e2bTemplate ?? "default",
          storage: config.b2 ? "backblaze-b2" : "local-disk",
          redis: redisConfigured() ? "upstash" : "none",
          e2bPool: e2bBroker.stats(),
          openrouterPool: openrouterPool.stats(),
          activeRuns: activeRunCount(),
          totalRuns: totalRunCount(),
          ceilings: { steps: config.maxSteps, wallclockMs: config.maxWallclockMs, tokens: config.maxTokens },
        },
        200,
        origin,
      );
    }

    // ── THE E2B POOL DASHBOARD (E2B_POOL__API_TOKEN guarded) ──────────
    if ((path === "/e2b/pool" && request.method === "GET") || (path === "/e2b/pool/reconcile" && request.method === "POST")) {
      // live-read: the config-push surface may have updated it in-process
      const poolToken = process.env.E2B_POOL__API_TOKEN || config.e2bPoolToken;
      if (!poolToken) {
        return json({ error: "pool surface not configured (E2B_POOL__API_TOKEN unset)" }, 503, origin);
      }
      const token = request.headers.get("X-Pool-Token") ?? request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (token !== poolToken) {
        return json({ error: "forbidden — pool token required" }, 403, origin);
      }
      if (path === "/e2b/pool") {
        return json(await poolDashboard(), 200, origin);
      }
      return json(await reconcilePool(), 200, origin);
    }

    // ── THE TEMPLATE-SYNC SURFACE (relay-key guarded) — build the forgevi
    // template into EVERY pooled key's account (same alias), then spawn by
    // alias so all keys' seats become usable. POST kicks off background
    // builds; GET polls readiness and flips onto the alias when ready.
    if (path === "/admin/template-sync" && (request.method === "POST" || request.method === "GET")) {
      if (!config.relayKey) {
        return json({ error: "template-sync surface not configured (ENGINE_RELAY_KEY unset)" }, 503, origin);
      }
      const key = request.headers.get("X-Engine-Relay-Key") ?? "";
      if (key !== config.relayKey) {
        return json({ error: "forbidden — relay key required" }, 403, origin);
      }
      if (request.method === "POST") {
        return json(await startTemplateSync(), 200, origin);
      }
      return json(await templateSyncStatus(), 200, origin);
    }

    // ── THE CONFIG-PUSH SURFACE (relay-key guarded deploy path) ──────
    if (path === "/admin/config" && request.method === "POST") {
      if (!config.relayKey) {
        return json({ error: "config surface not configured (ENGINE_RELAY_KEY unset)" }, 503, origin);
      }
      const key = request.headers.get("X-Engine-Relay-Key") ?? "";
      if (key !== config.relayKey) {
        return json({ error: "forbidden — relay key required" }, 403, origin);
      }
      const body = await readJsonBody(request);
      const values = body?.["values"];
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        return json({ error: "values (object of KEY: string) is required" }, 400, origin);
      }
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        if (typeof k !== "string" || typeof v !== "string" || k.length > 64 || v.length > 32_768) continue;
        clean[k] = v;
      }
      if (Object.keys(clean).length === 0) {
        return json({ error: "no valid values supplied" }, 400, origin);
      }
      const { written, denied } = writeRuntimeConfigFile(clean);
      // HOT RELOAD (the deploy law): the pushed values take effect NOW —
      // the config object mutates in place and every pool singleton
      // rebuilds off it. No engine restart, no Render dashboard.
      reloadEngineConfig();
      reloadOpenRouterPool();
      reloadE2BBroker();
      resetB2Bootstrap();
      // warm the B2 bootstrap so the next dashboard read reports it
      void b2BootstrapStatus().catch(() => undefined);
      return json(
        {
          ok: true,
          applied: written,
          denied,
          note: "values are applied in-memory now (pools rebuilt) and persisted to the runtime config file — env vars (when set) still take precedence at boot",
          runtimeConfigPath: runtimeConfigPath(),
          state: {
            openrouterKeys: config.openrouterKeys.length,
            e2bKeys: config.e2bKeys.length,
            b2Configured: Boolean(config.b2),
            redisConfigured: Boolean(config.redis),
            modelChain: config.modelChain,
          },
        },
        200,
        origin,
      );
    }

    // ── THE CONFIG-INSPECTOR SURFACE (relay-key guarded) ─────────────
    // The ops migration path: POST /admin/config (the edge config-push)
    // writes .engine-runtime-config.json; THIS reads it back so the values
    // can be lifted into REAL env vars (Render API / dashboard) — after
    // which env vars win at boot and the runtime file becomes a no-op
    // backup. Same guard as the write surface: the relay key.
    if (path === "/admin/config" && request.method === "GET") {
      if (!config.relayKey) {
        return json({ error: "config surface not configured (ENGINE_RELAY_KEY unset)" }, 503, origin);
      }
      const key = request.headers.get("X-Engine-Relay-Key") ?? "";
      if (key !== config.relayKey) {
        return json({ error: "forbidden — relay key required" }, 403, origin);
      }
      const fileValues = readRuntimeConfigFile();
      const envSources: Record<string, boolean> = {};
      for (const k of Object.keys(fileValues)) {
        // env vars ALWAYS win — a key here that is also a live env var is
        // currently overridden at boot (the migration target state)
        envSources[k] = process.env[k] !== undefined;
      }
      return json(
        {
          ok: true,
          runtimeConfigPath: runtimeConfigPath(),
          runtimeValues: fileValues,
          overriddenByEnv: envSources,
          state: {
            openrouterKeys: config.openrouterKeys.length,
            e2bKeys: config.e2bKeys.length,
            e2bTemplate: config.e2bTemplate ?? null,
            b2Configured: Boolean(config.b2),
            redisConfigured: Boolean(config.redis),
            modelChain: config.modelChain,
            agentLane: config.agentLane,
            engineProvider: process.env.ENGINE_PROVIDER || "openrouter",
          },
        },
        200,
        origin,
      );
    }

    // ── runs ──
    if (path === "/runs" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body) return json({ error: "invalid JSON body" }, 400, origin);
      const input: StartRunInput = {
        objective: typeof body["objective"] === "string" ? body["objective"] : "",
        acceptance: Array.isArray(body["acceptance"]) ? (body["acceptance"] as unknown[]) : [],
        ...(typeof body["workspaceGrant"] === "string" ? { workspaceGrant: body["workspaceGrant"] } : {}),
        ...(Array.isArray(body["files"]) ? { files: body["files"] as StartRunInput["files"] } : {}),
        ...(typeof body["appName"] === "string" ? { appName: body["appName"] } : {}),
        ...(typeof body["platform"] === "string" ? { platform: body["platform"] } : {}),
        ...(Array.isArray(body["chatHistory"]) ? { chatHistory: body["chatHistory"] as StartRunInput["chatHistory"] } : {}),
        ...(Array.isArray(body["uploadedFiles"]) ? { uploadedFiles: body["uploadedFiles"].filter((f): f is string => typeof f === "string") } : {}),
        ...(typeof body["projectId"] === "string" ? { projectId: body["projectId"] } : {}),
      };
      const result = startRun(input);
      return json(result.body, result.status, origin);
    }

    const runMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (runMatch && request.method === "GET") {
      const view = getRunView(runMatch[1]!);
      if (!view) {
        // THE REDIS REPLAY FALLBACK: the engine lost the run (restart) but
        // the journal cache may still hold its frames — surface them so the
        // frontend can settle the stream honestly instead of a bare 404.
        const cached = await loadRunEvents(runMatch[1]!);
        if (cached && cached.length > 0) {
          return json(
            {
              runId: runMatch[1],
              status: "incomplete",
              objective: "",
              acceptance: [],
              iteration: 0,
              budgets: {},
              workspace: { bound: false },
              startedAt: 0,
              eventCount: cached.length,
              cachedEvents: true,
              note: "the engine restarted and lost this run — the Redis journal cache holds its frames",
            },
            200,
            origin,
          );
        }
        return notFound(origin);
      }
      return json(view, 200, origin);
    }

    const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (eventsMatch && request.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0");
      return sseResponse(eventsMatch[1]!, Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0, origin);
    }

    const abortMatch = /^\/runs\/([^/]+)\/abort$/.exec(path);
    if (abortMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      const view = abortRun(abortMatch[1]!, typeof body?.["reason"] === "string" ? body["reason"] : undefined);
      if (!view) return notFound(origin);
      return json({ ok: true, runId: view.runId, status: view.status, aborted: true }, 200, origin);
    }

    // additive: workspace file tree for the run console (contract-neutral)
    const filesMatch = /^\/runs\/([^/]+)\/files$/.exec(path);
    if (filesMatch && request.method === "GET") {
      if (!getRunView(filesMatch[1]!)) return notFound(origin);
      const files = await listRunFiles(filesMatch[1]!);
      if (!files) return json({ files: [], note: "workspace not available (sandbox destroyed)" }, 200, origin);
      return json({ files }, 200, origin);
    }

    // ── THE STUDIO SURFACE (project workspace — relay-key guarded) ──────
    // The edge relay verifies the caller owns the project (PostgREST) and
    // presents X-Engine-Relay-Key; the engine trusts exactly that relay.
    if (path.startsWith("/workspace/")) {
      if (!config.relayKey) {
        return json({ error: "studio surface not configured (ENGINE_RELAY_KEY unset)" }, 503, origin);
      }
      const key = request.headers.get("X-Engine-Relay-Key") ?? "";
      if (key !== config.relayKey) {
        return json({ error: "forbidden — relay key required" }, 403, origin);
      }
      const segments = path.split("/").filter(Boolean); // ["workspace", pid, ...]
      const projectId = validProjectId(segments[1]);
      if (!projectId) return json({ error: "invalid project id" }, 400, origin);
      const op = segments.slice(2).join("/"); // "files" | "file" | "exec" | "preview"

      // GET /workspace/:pid/files — the tree (Files tab)
      if (op === "files" && request.method === "GET") {
        try {
          const files = await projectFiles(projectId);
          return json({ files }, 200, origin);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500, origin);
        }
      }

      // GET /workspace/:pid/file?path= — read (text | base64 for binaries)
      if (op === "file" && request.method === "GET") {
        const rawPath = url.searchParams.get("path") ?? "";
        const rel = studioSafePath(rawPath);
        if (!rel) return json({ error: "invalid path" }, 400, origin);
        try {
          const file = await projectReadFile(projectId, rel);
          if (!file) return json({ error: "file not found" }, 404, origin);
          return json(file, 200, origin);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500, origin);
        }
      }

      // POST /workspace/:pid/file {path, content} — a user edit from Files
      if (op === "file" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!body) return json({ error: "invalid JSON body" }, 400, origin);
        const rel = studioSafePath(body["path"]);
        const content = typeof body["content"] === "string" ? body["content"] : null;
        if (!rel || content === null) return json({ error: "path and content are required" }, 400, origin);
        if (content.length > 2_000_000) return json({ error: "content too large (max 2MB)" }, 400, origin);
        try {
          const { bytes } = await projectWriteFile(projectId, rel, content);
          // a live run's stream log shows the user's write like an agent write
          const journal = findLiveRunForProject(projectId);
          if (journal) {
            try {
              journal.append({ type: "file_written", path: rel, bytes, by: "user" });
            } catch {
              /* closed journal — fine */
            }
          }
          return json({ ok: true, path: rel, bytes }, 200, origin);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500, origin);
        }
      }

      // POST /workspace/:pid/exec {command, cwd?} — the studio Terminal
      if (op === "exec" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!body) return json({ error: "invalid JSON body" }, 400, origin);
        const command = typeof body["command"] === "string" ? body["command"] : "";
        if (!command.trim()) return json({ error: "command is required" }, 400, origin);
        const cwd = typeof body["cwd"] === "string" && studioSafePath(body["cwd"]) ? body["cwd"] : undefined;
        try {
          const result = await projectExec(projectId, command, cwd);
          return json(
            {
              exit_code: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timed_out: result.timedOut,
              duration_ms: result.durationMs,
            },
            200,
            origin,
          );
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500, origin);
        }
      }

      // POST /workspace/:pid/upload {filename, content_b64} — THE
      // UPLOAD-FOLDER LAW: binary-safe user uploads → uploads/.
      if (op === "upload" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!body) return json({ error: "invalid JSON body" }, 400, origin);
        const filename = typeof body["filename"] === "string" ? body["filename"] : "";
        const contentB64 = typeof body["content_b64"] === "string" ? body["content_b64"] : "";
        if (!filename || !contentB64) return json({ error: "filename and content_b64 are required" }, 400, origin);
        try {
          const { bytes } = await projectUpload(projectId, filename, contentB64);
          return json({ ok: true, filename, bytes, folder: "uploads/" }, 200, origin);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400, origin);
        }
      }

      // GET /workspace/:pid/status — the seat status (studio banner/preview)
      if (op === "status" && request.method === "GET") {
        const devPort = projectDevPort(projectId);
        const status = await projectStatus(projectId, devPort);
        return json({ driver: status.driver, configured: status.configured, session: status.session, previewPort: status.previewPort }, 200, origin);
      }

      // POST /workspace/:pid/terminal — the E2B-mandate exec alias
      if (op === "terminal" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!body) return json({ error: "invalid JSON body" }, 400, origin);
        const command = typeof body["command"] === "string" ? body["command"] : "";
        if (!command.trim()) return json({ error: "command is required" }, 400, origin);
        const cwd = typeof body["cwd"] === "string" && studioSafePath(body["cwd"]) ? body["cwd"] : undefined;
        try {
          const result = await projectExec(projectId, command, cwd);
          return json(
            { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timed_out: result.timedOut, duration_ms: result.durationMs },
            200,
            origin,
          );
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500, origin);
        }
      }

      // POST /workspace/:pid/heartbeat — keep the seat warm
      if (op === "heartbeat" && request.method === "POST") {
        await projectHeartbeat(projectId);
        return json({ ok: true }, 200, origin);
      }

      // GET /workspace/:pid/manifest — the manifest-shaped file list
      // (the legacy action name — same tree, manifest vocabulary).
      if (op === "manifest" && request.method === "GET") {
        try {
          const files = await projectFiles(projectId);
          const manifest = files.map((f) => ({ path: f.path, size: f.size ?? 0, updated_at: 0 }));
          return json({ projectId, revision: manifest.length, files: manifest }, 200, origin);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500, origin);
        }
      }

      // GET /workspace/:pid/preview — THE PREVIEW-SURVIVAL LAW (user fix
      // 2026-09-21): the dev port lives on the PROJECT entry, not the run —
      // the preview serves for as long as the port actually answers inside
      // the sandbox (run finished, reaper not yet fired — all the same).
      // Honest null when no port was ever assigned or the sandbox is gone;
      // the POST dev-server action (below) rehydrates + restarts.
      if (op === "preview" && request.method === "GET") {
        const { appUrl, devPort, serving } = await projectPreviewUrl(projectId);
        return json(
          {
            appUrl,
            devPort,
            serving,
            public: Boolean(appUrl && appUrl.startsWith("https://")),
          },
          200,
          origin,
        );
      }

      // POST /workspace/:pid/dev-server {action: "start"|"restart"|"stop"}
      // — THE MANUAL-RESTART LAW: the studio's Restart button. "start"
      // no-ops when the server already answers; "restart" always boots a
      // fresh one; both REHYDRATE the sandbox from the B2 snapshot when
      // the reaper evicted it (the preview comes back from the dead).
      if (op === "dev-server" && request.method === "POST") {
        const body = await readJsonBody(request);
        const action = typeof body?.["action"] === "string" ? body["action"] : "start";
        if (action === "stop") {
          const res = await stopProjectDevServer(projectId);
          return json({ ...res, appUrl: null, devPort: projectDevPort(projectId) }, 200, origin);
        }
        if (action !== "start" && action !== "restart") {
          return json({ error: 'action must be "start", "restart" or "stop"' }, 400, origin);
        }
        const res = await ensureProjectDevServer(projectId, {
          restart: action === "restart",
          waitMs: 90_000,
        });
        return json(
          {
            appUrl: res.appUrl,
            devPort: res.devPort,
            public: Boolean(res.appUrl && res.appUrl.startsWith("https://")),
            ...(res.error ? { error: res.error } : {}),
          },
          res.error ? 503 : 200,
          origin,
        );
      }

      return notFound(origin);
    }

    return notFound(origin);
  },
});

console.error(
  `[forgevi-3] listening on :${server.port} — kernel=${KERNEL} sandbox=${config.e2bKeys.length > 0 ? `e2b-pool(${config.e2bKeys.length} keys)` : "local"} storage=${config.b2 ? "backblaze-b2" : "local-disk"} redis=${redisConfigured() ? "upstash" : "none"} openrouter-keys=${config.openrouterKeys.length} version=${VERSION}`,
);
