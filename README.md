# Forgevi 3.0

One agent. One sandbox. One process. Built from scratch.

**What it is:** the Forgvi 3.0 engine — a single OpenHands-style (CodeAct)
agent that builds software inside an E2B cloud sandbox, persists the
workspace to Backblaze B2, and streams everything it does to the frontend
over the Forgvi wire contract (POST /runs + SSE).

**What it deliberately is NOT** (the laws of this codebase):

- **No Redis bus.** The journal is in-process; SSE readers fan out directly.
- **No Temporal.** A run is one async function. Durability = snapshot at
  run end + the frontend's honest 404-poll fallback.
- **No LangGraph, no swarm, no chief/subagent dispatch.** One agent loop.
- **No judges, no hardcoded iteration counts.** The model decides when the
  work is done (the `finish` tool); the only caps are optional
  env-configurable safety ceilings, OFF by default.
- **No silent fallbacks.** Bad grant → 400. Provider down → run_error.
  Engine restart → the frontend says so honestly.

## Architecture

```
src/
├── server.ts                # HTTP surface — the wire contract (Bun.serve)
├── config.ts                # env-driven config, nothing hardcoded
├── grant.ts                 # fg1. workspace grants (HMAC, copied from 2.0)
├── agentic-framework/       # THE agent
│   ├── agent.ts             #   the single CodeAct loop (act → observe → decide)
│   ├── prompts.ts           #   the PINNED system prompt (prompt-caching law)
│   ├── context.ts           #   [system] + [chat history] + [objective last]
│   └── event-stream …       #   (the journal IS the event stream)
├── tools/                   # the agent's hands
│   ├── registry.ts          #   execute_command / read_file / write_file / list_dir
│   ├── browser.ts           #   browser_preview — OTel-connected preview tool
│   ├── mcp/                 #   unified MCP SDK + auto-discovery (client, discovery, bridge)
│   ├── sub-agents/          #   analyze_image — OPTIONAL, the agent decides
│   └── monitoring/          #   OpenTelemetry (traces + metrics, OTLP)
├── e2b-backblaze/           # execution + persistence
│   ├── sandbox.ts           #   SandboxAdapter: E2B (prod) | local disk (dev)
│   ├── template.ts          #   silent boot: restore + uploads + scaffold
│   └── storage.ts           #   StorageAdapter: Backblaze B2 | local disk
├── uploads/                 # uploads/ → sandbox + USER-prompt enhancement
├── runs/
│   ├── manager.ts           #   run lifecycle, abort, concurrency
│   └── journal.ts           #   seq-numbered journal + SSE fanout + ?since replay
└── llm/
    ├── openrouter.ts        #   best FREE tool-calling models, fallback chain
    ├── zai.ts               #   local dev provider (z-ai-web-dev-sdk)
    └── mock.ts              #   deterministic provider for the self-test probe
```

## The wire contract

| Route | Purpose |
|---|---|
| `GET /health` | `{ok:true, engine:"forgvi", kernel:"openhands-codeact", model, …}` |
| `POST /runs` | `{objective, acceptance, workspaceGrant?, files?, appName?, platform?, chatHistory?}` → `201 {runId, goalId, status, workspace}` |
| `GET /runs/:id` | run state (status, report, eventCount) |
| `GET /runs/:id/events?since=N` | SSE — replay, live frames, 15s pings, `forge-close` |
| `POST /runs/:id/abort` | `{reason?}` → settles the run incomplete |
| `GET /runs/:id/files` | additive — workspace tree (the test console) |

Events the frontend already renders: `run_started`, `workspace_bound`,
`iteration_started` (step N — live progress, **not** a cap),
`assistant_text` (REPLACES the bubble), `assistant_thinking` (APPENDS),
`tool_used`, `file_written`, `run_error`, `run_finished` (+ `forge-close`).

## Environment

| Var | Meaning |
|---|---|
| `ENGINE_PORT` / `PORT` | listen port (default 3010) |
| `WORKSPACE_GRANT_SECRET` | same value the Arcforge backend mints fg1. grants with |
| `ENGINE_PROVIDER` | `openrouter` (default) \| `zai` (dev) \| `mock` (probe) |
| `ENGINE_MODEL` | override the primary model (chain still backs it up) |
| `OPENROUTER_API_KEY` | required for the openrouter provider |
| `MCP_SERVERS` | JSON `[{name, url, headers?}]` — auto-discovered at run start |
| `E2B_API_KEY` / `E2B_TEMPLATE_ID` | real E2B sandboxes (unset → local-disk dev sandboxes) |
| `B2_KEY_ID` / `B2_APP_KEY` / `B2_BUCKET` / `B2_REGION` | Backblaze B2 persistence (unset → local disk) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry OTLP traces/metrics (unset → no-op) |
| `FORGVI3_MAX_STEPS` / `FORGVI3_MAX_WALLCLOCK_MS` / `FORGVI3_MAX_TOKENS` | optional safety ceilings — **0 = OFF (default, the user's law: runs end when the agent finishes or the user aborts)** |
| `ENGINE_MAX_CONCURRENT` | concurrent runs before 429 (default 3) |

## Free model chain (OpenRouter, tool-calling, live-verified)

1. `nvidia/nemotron-3-super-120b-a12b:free` (primary)
2. `deepseek/deepseek-v4-flash-0731:free`
3. `qwen/qwen3.8-27b:free`
4. `cohere/north-mini-code:free`
5. `poolside/laguna-s-2.1:free`

Failover on 429/5xx/not-served; vision (for `analyze_image`) uses
`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`.

## The prompt-caching law

The system prompt is **pinned** (byte-stable). The project's prior chat
history rides in the middle; the objective + task context (app name,
platform, acceptance, uploads manifest) is the **final user message**.
Nothing dynamic ever touches the system prompt, so provider prompt caches
reuse everything above the newest turn.

## The uploads law

Attached files land in the sandbox's `uploads/` at boot — **silent** (never
in the event stream). The USER prompt is enhanced with the manifest; the
system prompt never mentions them.

## The baked E2B template

`e2b-template/template.ts` defines the custom sandbox image (Node toolchain
+ Playwright/Chromium so `browser_preview` can screenshot). Build once:

```bash
cd e2b-template && e2b template build   # then set E2B_TEMPLATE_ID
```

Without it the engine uses the stock E2B base template and the browser
tool honestly reports "screenshot unavailable" (probe-only mode).

## Running locally

```bash
bun install
ENGINE_PROVIDER=zai bun run dev          # dev agent (z-ai provider, local sandboxes)
ENGINE_PROVIDER=mock bun run probe       # self-test: 51 wire-contract assertions
```

The engine resolves `z-ai-web-dev-sdk` from the parent workspace when
`ENGINE_PROVIDER=zai` — a development-only affordance.

## Deploying

Docker (Render): `oven/bun:1.2-slim`, `bun src/server.ts`, listen on `$PORT`.
Set `WORKSPACE_GRANT_SECRET` (same as the backend), `OPENROUTER_API_KEY`,
`E2B_API_KEY`, `B2_*`. Wire the frontend's `engine-ops` relay to this
service's URL via the `ARCFORGE_FORGVI3_ENGINE_URL` edge secret.
