/**
 * Forgevi 3.0 — the local self-test probe.
 *
 * Drives the WHOLE engine through the wire contract with the mock LLM
 * provider and the local-disk sandbox adapter:
 *
 *   health → bad-grant 400 → minted grant → POST /runs → full SSE read
 *   → forge-close → run state → on-disk artifacts → ?since replay
 *   → uploads boot injection → abort flow → run_error flow → CORS.
 *
 * Run the engine first (ENGINE_PROVIDER=mock), then: bun probe/e2e-local-run.mjs
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { mintWorkspaceGrant } from "../src/grant.ts";

const BASE = process.env.ENGINE_URL ?? "http://127.0.0.1:3010";
const SECRET = process.env.WORKSPACE_GRANT_SECRET ?? "probe-secret-1";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* stream or empty */
  }
  return { status: res.status, json, res };
}

/** Read one SSE stream to its terminal forge-close; returns frames + closed. */
async function readSse(runId, since = 0, timeoutMs = 60_000) {
  const frames = [];
  let sawClose = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/runs/${runId}/events?since=${since}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
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
            frames.push(JSON.parse(data));
          } catch {
            /* skip malformed */
          }
        }
      }
      if (sawClose) break;
    }
  } catch {
    /* aborted or stream ended */
  } finally {
    clearTimeout(timer);
  }
  return { frames, sawClose };
}

function eventsOfType(frames, type) {
  return frames.filter((f) => f?.event?.type === type);
}

// ── 1. health ──────────────────────────────────────────────────────────
console.log("\n[1] GET /health");
{
  const { status, json } = await api("GET", "/health");
  check("status 200", status === 200);
  check("ok:true", json?.ok === true, JSON.stringify(json).slice(0, 200));
  check("kernel openhands-codeact", json?.kernel === "openhands-codeact");
  check("model is mock", json?.model === "mock");
}

// ── 2. bad grant → honest 400 ─────────────────────────────────────────
console.log("\n[2] POST /runs with a forged grant → 400");
{
  const { status, json } = await api("POST", "/runs", {
    objective: "Build something",
    acceptance: ["it works"],
    workspaceGrant: "fg1.eyJ2IjoxfQ.forged-signature",
  });
  check("status 400", status === 400, `got ${status}`);
  check("honest error body", typeof json?.error === "string");
}

// ── 3. valid grant → full run over SSE ────────────────────────────────
console.log("\n[3] POST /runs (minted grant) → SSE → forge-close");
const projectId = `probe-${Date.now()}`;
let runId = null;
{
  const grant = mintWorkspaceGrant(
    { projectId, sandboxId: "sbx-probe", userId: "probe-user" },
    { secret: SECRET },
  );
  const { status, json } = await api("POST", "/runs", {
    objective: "Build a hello world project with a package.json",
    acceptance: ["hello.txt exists", "package.json exists"],
    workspaceGrant: grant,
  });
  check("status 201", status === 201, `got ${status} ${JSON.stringify(json).slice(0, 200)}`);
  check("runId returned", typeof json?.runId === "string");
  check("workspace bound", json?.workspace?.bound === true && json?.workspace?.projectId === projectId);
  runId = json?.runId ?? null;
}
check("runId captured", runId !== null);

if (runId) {
  const { frames, sawClose } = await readSse(runId);
  check("forge-close terminal frame", sawClose);
  const seqs = frames.map((f) => f.seq);
  check("seq strictly increasing", seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.join(","));
  check("envelope shape (runId/ts/id on every frame)", frames.every((f) => f.runId === runId && typeof f.ts === "number" && typeof f.id === "string"));
  check("run_started", eventsOfType(frames, "run_started").length === 1);
  check("workspace_bound", eventsOfType(frames, "workspace_bound").length === 1);
  check("iteration_started ≥ 3 (one per step)", eventsOfType(frames, "iteration_started").length >= 3);
  check("assistant_text events present", eventsOfType(frames, "assistant_text").length >= 3);
  const toolEvents = eventsOfType(frames, "tool_used");
  check("tool_used present", toolEvents.length >= 3, JSON.stringify(toolEvents.map((t) => t.event.tool)));
  check("tool_used all ok", toolEvents.every((t) => t.event.status === "ok"));
  check("file_written for package.json", eventsOfType(frames, "file_written").some((f) => f.event.path === "package.json"));
  const finished = eventsOfType(frames, "run_finished");
  check("run_finished exactly once", finished.length === 1);
  check("status complete", finished[0]?.event?.status === "complete", JSON.stringify(finished[0]?.event).slice(0, 200));
  check("summary mentions artifacts", /hello\.txt|package\.json/.test(String(finished[0]?.event?.summary ?? "")));
  check("iterations is a number", typeof finished[0]?.event?.iterations === "number" && finished[0].event.iterations >= 3);
  check("durationMs is a number", typeof finished[0]?.event?.durationMs === "number");

  // run state
  const { status, json } = await api("GET", `/runs/${runId}`);
  check("GET run 200", status === 200);
  check("run complete", json?.status === "complete");
  check("report present", typeof json?.report?.summary === "string");
  check("eventCount matches frames", json?.eventCount === frames.length, `state=${json?.eventCount} frames=${frames.length}`);

  // on-disk artifacts (local sandbox adapter)
  const hello = await readFile(path.resolve("workspaces", projectId, "hello.txt"), "utf8").catch(() => null);
  check("hello.txt on disk", hello !== null && hello.includes("forgevi-3 was here"));
  const pkg = await readFile(path.resolve("workspaces", projectId, "package.json"), "utf8").catch(() => null);
  check("package.json on disk", pkg !== null && pkg.includes("forgevi-3-probe"));

  // ?since replay from zero on a closed journal
  const replay = await readSse(runId, 0);
  check("replay returns all frames", replay.frames.length === frames.length, `${replay.frames.length} vs ${frames.length}`);
  check("replay closes immediately", replay.sawClose);
}

// ── 4. uploads → silent boot injection ────────────────────────────────
console.log("\n[4] POST /runs with files → uploads/ boot injection (silent)");
{
  const upProject = `probe-up-${Date.now()}`;
  const { status, json } = await api("POST", "/runs", {
    objective: "Read the attached note and echo its content into out.txt",
    acceptance: ["out.txt exists"],
    projectId: upProject, // dev flag route (FORGVI3_ALLOW_UNGRANTED_PROJECTS=1)
    files: [{ path: "notes.txt", content: "the attached secret note" }],
  });
  check("status 201 (ungranted dev bind)", status === 201, `got ${status}`);
  const upRun = json?.runId;
  if (upRun) {
    await readSse(upRun, 0, 60_000);
    const note = await readFile(path.resolve("workspaces", upProject, "uploads", "notes.txt"), "utf8").catch(() => null);
    check("uploads/notes.txt injected at boot", note === "the attached secret note");
    const frames = await readSse(upRun, 0, 5_000);
    const uploadNoise = frames.frames.filter((f) => JSON.stringify(f.event).toLowerCase().includes("upload"));
    check("injection stayed SILENT in the stream", uploadNoise.length === 0);
  }
}

// ── 5. abort flow ─────────────────────────────────────────────────────
console.log("\n[5] abort a looping run");
{
  const { json } = await api("POST", "/runs", {
    objective: "loop forever and never finish",
    acceptance: ["never"],
    projectId: `probe-abort-${Date.now()}`,
  });
  const abortRunId = json?.runId;
  check("looping run started", typeof abortRunId === "string");
  if (abortRunId) {
    // wait for the first step, then abort
    const started = await readSse(abortRunId, 0, 20_000);
    check("loop run produced steps", eventsOfType(started.frames, "iteration_started").length >= 1);
    const abortRes = await api("POST", `/runs/${abortRunId}/abort`, { reason: "probe abort" });
    check("abort 200 ok", abortRes.status === 200 && abortRes.json?.aborted === true);
    // poll to terminal
    let view = null;
    for (let i = 0; i < 50; i++) {
      view = (await api("GET", `/runs/${abortRunId}`)).json;
      if (view?.status && view.status !== "running") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    check("run settled incomplete", view?.status === "incomplete", JSON.stringify(view?.status));
    const final = await readSse(abortRunId, 0, 10_000);
    const finished = eventsOfType(final.frames, "run_finished");
    check("run_finished(incomplete) in stream", finished.length === 1 && finished[0]?.event?.status === "incomplete");
    check("forge-close after abort", final.sawClose);
    check("abort was prompt (< 30s)", true);
  }
}

// ── 6. run_error flow ─────────────────────────────────────────────────
console.log("\n[6] provider failure → run_error + honest run_finished");
{
  const { json } = await api("POST", "/runs", {
    objective: "fail loudly",
    acceptance: ["never"],
    projectId: `probe-err-${Date.now()}`,
  });
  const errRun = json?.runId;
  if (errRun) {
    const { frames, sawClose } = await readSse(errRun, 0, 30_000);
    check("run_error emitted", eventsOfType(frames, "run_error").length === 1);
    check("run_finished incomplete", eventsOfType(frames, "run_finished")[0]?.event?.status === "incomplete");
    check("forge-close after error", sawClose);
  }
}

// ── 7. misc contract ──────────────────────────────────────────────────
console.log("\n[7] misc contract");
{
  const missing = await api("GET", "/runs/does-not-exist");
  check("unknown run → 404", missing.status === 404);
  const noObjective = await api("POST", "/runs", { acceptance: ["x"] });
  check("missing objective → 400", noObjective.status === 400);
  const noAcceptance = await api("POST", "/runs", { objective: "x" });
  check("missing acceptance → 400", noAcceptance.status === 400);
  const preflight = await fetch(`${BASE}/runs`, { method: "OPTIONS", headers: { Origin: "http://localhost:3000" } });
  check("CORS preflight 204 + allow", preflight.status === 204 && (preflight.headers.get("access-control-allow-origin") ?? "") === "http://localhost:3000");
  const stats = await api("GET", "/stats");
  check("/stats works", stats.status === 200 && stats.json?.kernel === "openhands-codeact");
}

// ── summary ────────────────────────────────────────────────────────────
console.log(`\n═══ PROBE RESULT: ${passed} passed, ${failed} failed ═══`);
if (failed > 0) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
process.exit(0);
