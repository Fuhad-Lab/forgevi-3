/**
 * Forgevi 3.0 — the HTTP surface (the Forgvi wire contract).
 *
 * GET  /health              {ok:true, ...}
 * POST /runs                {objective, acceptance, workspaceGrant?, files?, appName?, platform?, chatHistory?}
 * GET  /runs/:id            run state
 * GET  /runs/:id/events?since=N   SSE — replay, live frames, 15s pings, forge-close
 * POST /runs/:id/abort      {reason?}
 * GET  /stats               engine stats (runs, active, model)
 *
 * CORS allowlist per the contract; OPTIONS handled. No framework — one
 * Bun.serve, one process, no message bus behind it.
 */

import { config } from "./config.ts";
import { abortRun, activeRunCount, getProvider, getRunJournal, getRunView, listRunFiles, startRun, totalRunCount, type StartRunInput } from "./runs/manager.ts";
import type { JournalEnvelope } from "./runs/journal.ts";

const VERSION = "3.0.0";
const KERNEL = "openhands-codeact";

const ALLOWED_ORIGINS = new Set([
  "https://forgeyn.com.ng",
  "https://www.forgeyn.com.ng",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  ...config.extraOrigins,
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://forgeyn.com.ng";
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

function providerLabel(): string {
  if (config.provider === "zai") return "zai-glm (dev)";
  if (config.provider === "mock") return "mock";
  return config.model ?? "nvidia/nemotron-3-super-120b-a12b:free";
}

const server = Bun.serve({
  port: config.port,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── health ──
    if (path === "/health" && request.method === "GET") {
      let ok = true;
      let model = providerLabel();
      try {
        const provider = await getProvider();
        model = provider.model;
      } catch (err) {
        ok = false;
        model = `${providerLabel()} (unconfigured: ${err instanceof Error ? err.message : String(err)})`;
      }
      return json(
        {
          ok,
          status: ok ? "ok" : "degraded",
          engine: "forgvi",
          version: VERSION,
          kernel: KERNEL,
          model,
          sandbox: config.e2bKey ? "e2b" : "local",
          storage: config.b2 ? "backblaze-b2" : "local-disk",
          activeRuns: activeRunCount(),
          totalRuns: totalRunCount(),
        },
        200,
        origin,
      );
    }

    // ── stats ──
    if (path === "/stats" && request.method === "GET") {
      return json(
        {
          ok: true,
          version: VERSION,
          kernel: KERNEL,
          provider: config.provider,
          model: providerLabel(),
          sandbox: config.e2bKey ? "e2b" : "local",
          storage: config.b2 ? "backblaze-b2" : "local-disk",
          mcpServers: config.mcpServers.length,
          activeRuns: activeRunCount(),
          totalRuns: totalRunCount(),
          ceilings: { steps: config.maxSteps, wallclockMs: config.maxWallclockMs, tokens: config.maxTokens },
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
        ...(typeof body["projectId"] === "string" ? { projectId: body["projectId"] } : {}),
      };
      const result = startRun(input);
      return json(result.body, result.status, origin);
    }

    const runMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (runMatch && request.method === "GET") {
      const view = getRunView(runMatch[1]!);
      if (!view) return notFound(origin);
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

    return notFound(origin);
  },
});

console.error(`[forgevi-3] listening on :${server.port} — kernel=${KERNEL} provider=${config.provider} sandbox=${config.e2bKey ? "e2b" : "local"} storage=${config.b2 ? "backblaze-b2" : "local-disk"}`);
