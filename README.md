# Forgevi 3.1

One agent. One sandbox. One process per run. **The real OpenHands.**

**What it is:** the Forgvi 3.1 engine — the actual
[`openhands-sdk`](https://github.com/All-Hands-AI/openhands) (pinned
`1.44.1`) running its default agent (terminal + file editor + task
tracker, its own system prompt, its own loop, its own finish decision)
behind the Forgvi wire contract (POST /runs + SSE), inside an E2B cloud
sandbox or local-disk workspace, persisted to Backblaze B2.

**What it deliberately is NOT** (the laws of this codebase):

- **No custom agent loop.** No "iteration 1, 2…" theatre. OpenHands owns
  the loop; the engine relays what the agent actually does.
- **No custom LLM providers.** One env-driven OpenAI-compatible gateway
  (OpenRouter by default) through the SDK's `LLM` (litellm).
- **No custom tool registry.** The SDK's own default toolset.
- **No LangGraph, no swarm, no chief/subagent dispatch, no judges.**
- **No Redis bus.** The journal is in-process; SSE readers fan out directly.
- **No Temporal.** A run is one async function. Durability = snapshot at
  run end + the frontend's honest 404-poll fallback.
- **No silent fallbacks.** Bad grant → 400. Provider down → honest error.
  The one lane switch (OpenRouter free-tier exhaustion → NVIDIA NIM) is
  announced in the stream.

## Architecture

```
src/
├── server.ts                # HTTP surface — the wire contract (Bun.serve)
├── openhands.ts             # the bridge: spawns the worker, relays events
├── task.ts                  # ONE user message: history → task → context
├── config.ts                # env-driven config, nothing hardcoded
├── grant.ts                 # fg1. workspace grants (HMAC, copied from 2.0)
├── openhands/worker.py      # THE agent — the real openhands-sdk conversation
├── e2b-backblaze/           # execution + persistence
│   ├── sandbox.ts           #   SandboxAdapter: E2B (prod) | local disk (dev)
│   ├── template.ts          #   silent boot: restore + uploads + scaffold
│   └── storage.ts           #   StorageAdapter: Backblaze B2 | local disk
├── uploads/                 # uploads/ → sandbox + USER-prompt enhancement
├── runs/
│   ├── manager.ts           #   run lifecycle, abort, lane switch, settle
│   └── journal.ts           #   seq-numbered journal + SSE fanout + ?since replay
└── tools/monitoring/        # OpenTelemetry (traces + metrics, OTLP)
```

One worker process per run: `python3 openhands/worker.py --job <spec>`.
The worker captures the REAL stdout before redirecting `sys.stdout` to
stderr, so the SDK's consoles can never pollute the event stream; the
engine shell reads JSON-lines events from the worker's stdout and
republishes them as journal frames. Abort = SIGTERM to the worker
process — a hung LLM call can never wedge the run.

## The wire contract

| Route | Purpose |
|---|---|
| `GET /health` | `{ok:true, engine:"forgvi", kernel:"openhands-sdk", agent:{sdk,tools}, model, …}` |
| `POST /runs` | `{objective, acceptance, workspaceGrant?, files?, appName?, platform?, chatHistory?}` → `201 {runId, goalId, status, workspace}` |
| `GET /runs/:id` | run state (status, report, eventCount) |
| `GET /runs/:id/events?since=N` | SSE — replay, live frames, 15s pings, `forge-close` |
| `POST /runs/:id/abort` | `{reason?}` → SIGTERMs the worker, settles incomplete |
| `GET /runs/:id/files` | additive — workspace tree (the test console) |
| `/workspace/:projectId/*` | the studio surface (relay-key guarded): files, file read/write, exec, upload, status, heartbeat, manifest, preview |

Events the frontend renders: `run_started`, `workspace_bound`,
`tool_used` (the agent's REAL tool calls — terminal, file_editor,
task_tracker, finish), `file_written`, `assistant_text` (REPLACES the
bubble), `assistant_thinking` (APPENDS), `run_error`, `run_finished`
(+ `forge-close`). There is no `iteration_started` — iteration numbers
are bookkeeping on the frames, not stream theatre.

## Environment

| Var | Meaning |
|---|---|
| `ENGINE_PORT` / `PORT` | listen port (default 3010) |
| `WORKSPACE_GRANT_SECRET` | same value the Arcforge backend mints fg1. grants with |
| `OPENROUTER_API_KEY` | the primary LLM lane (required) |
| `ENGINE_MODEL` | model override (default `nvidia/nemotron-3-super-120b-a12b:free`) |
| `OPENROUTER_BASE_URL` | gateway override (default `https://openrouter.ai/api/v1`) |
| `NVIDIA_API_KEY` / `NVIDIA_MODEL` / `NVIDIA_BASE_URL` | the failover lane for OpenRouter free-tier exhaustion |
| `OH_PYTHON` / `OH_MAX_ITERATIONS` | worker python binary / iteration cap (default 500) |
| `E2B_API_KEY` / `E2B_TEMPLATE_ID` | real E2B sandboxes (unset → local-disk sandboxes) |
| `B2_KEY_ID` / `B2_APP_KEY` / `B2_BUCKET` / `B2_REGION` | Backblaze B2 persistence (unset → local disk) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry OTLP traces/metrics (unset → no-op) |
| `FORGVI3_MAX_STEPS` / `FORGVI3_MAX_WALLCLOCK_MS` / `FORGVI3_MAX_TOKENS` | optional safety ceilings — **0 = OFF (default)** |
| `ENGINE_MAX_CONCURRENT` | concurrent runs before 429 (default 3) |
| `ENGINE_RELAY_KEY` | guards the /workspace/* studio surface |

## The pinned SDK

`openhands-sdk==1.44.1` + `openhands-tools==1.44.1` + `fastmcp==3.4.7`
(`requirements.txt`). 1.49.1 regressed against NIM-class gateways
(litellm `_cache_buckets` AttributeError); fastmcp 4.x removed the
`Client` import. A gateway compat patch strips `prompt_cache_key` for
non-OpenAI base URLs (NIM 400s on it) — the same verified patch the
platform has shipped since the longhorizon engine.

## The prompt-caching posture

The project's prior chat history and the new task ride in ONE user
message per run; the SDK's own system prompt stays byte-stable above it.
Dynamic facts (app name, platform, dev port, acceptance, uploads) live
only in that message.

## Running locally

```bash
pip install -r requirements.txt   # the real OpenHands SDK
bun install
python3 dev-daemon.py             # engine on :3010 (LLM lane: the local mock gateway)
```

## Deploying

Docker (Render): `python:3.12-slim` + bun + tmux + ripgrep + node, `pip
install -r requirements.txt`, `bun src/server.ts`, listen on `$PORT`.
Set `WORKSPACE_GRANT_SECRET` (same as the backend), `OPENROUTER_API_KEY`,
`ENGINE_RELAY_KEY`, `E2B_API_KEY`, `B2_*`. Wire the frontend's
`engine-ops` relay to this service's URL via the
`ARCFORGE_FORGVI3_ENGINE_URL` edge secret.

---

# 3.2.0 — the pool laws (E2B + B2 + OpenRouter + Redis)

**The compute substrate, per the platform's own e2b_backblaze laws:**

- **THE E2B KEY POOL** (`src/e2b-backblaze/pool/broker.ts`): 20 seats/key,
  ≥1000ms spawn throttle per key, least-loaded cascade, bounded spawn
  queue, 429 telemetry + cooldown, rollback on failed acquisition,
  provider-truth reconcile (`POST /e2b/pool/reconcile`), honest
  `PoolExhaustedError` ("0/0 slots across 0 keys" — never fake execution).
  Keys: `E2B_API_KEYS` (csv) or `E2B_API_KEY_1..N` or legacy `E2B_API_KEY`.
- **THE B2 SELF-HEALING BOOTSTRAP** (`src/e2b-backblaze/b2.ts`): give it
  the master `B2_KEY_ID`/`B2_APPLICATION_KEY` — it auto-discovers the S3
  endpoint/region via `b2_authorize`, mints a dedicated S3-credential key
  cached at `~/.agent-platform/b2-s3-key.json`, and auto-creates the
  private bucket when none exists. Production bucket: `Forgeyn`
  (`s3.eu-central-003`). Direct S3 creds (`B2_S3_KEY_ID`/
  `B2_S3_APPLICATION_KEY`) skip the bootstrap.
- **THE SANDBOX LIFECYCLE** (`src/runs/workspace-service.ts`): 5-minute
  idle reaper → persist to B2 → destroy VM → seat freed (DATA-SAFETY LAW:
  a failed B2 upload keeps the VM alive — never destroy unsaved work);
  55-minute seamless migration (fresh VM, in-place handle swap);
  1-hour hard cap (persist + evict + rehydrate on demand).
- **THE OPENROUTER KEY POOL** (`src/llm/openrouter-pool.ts`): round-robin
  across keys with 429/quota latching (60s / 6h cooldowns), per-key
  telemetry, plus THE MODEL CHAIN (`ENGINE_MODELS`, csv) — when a lane
  dies with the quota signature the run rotates to the next pooled key +
  next model, announced in the stream. NVIDIA NIM remains the final lane.
  Keys: `OPENROUTER_API_KEYS` (csv) or `OPENROUTER_API_KEY_1..N` or
  legacy `OPENROUTER_API_KEY`.
- **THE MESSAGE-CACHING LAW** (`src/redis.ts`): no localStorage anywhere
  in the AI system — chat history per project + journal frames per run
  live in Upstash Redis (`UPSTASH_REDIS_REST_URL` +
  `UPSTASH_REDIS_REST_TOKEN`, REST API, best-effort by design). THE
  CONTINUITY MERGE: a run arriving with missing chatHistory still
  continues the SAME conversation from the Redis cache — the fix for
  "every message treated as a new project" after engine restarts.

**The deploy path (no Render dashboard needed):** `POST /admin/config`
(relay-key guarded, edge master-email gated) writes
`.engine-runtime-config.json` — env vars always WIN, the runtime file
fills gaps. The edge function pushes pool keys + service credentials
through it at deploy time.

**Env knobs (all optional, honest defaults):** `E2B_SEATS_PER_KEY=20`,
`E2B_SPAWN_THROTTLE_MS=1000`, `E2B_SPAWN_QUEUE_MAX=8`, `E2B_IDLE_TTL_MS=300000`,
`E2B_MIGRATE_AT_MS=3300000`, `E2B_HARD_CAP_MS=3600000`,
`E2B_POOL__API_TOKEN`, `E2B_TEMPLATE_ID`, `B2_BUCKET=Forgeyn`, `B2_REGION`
(auto-discovered when unset), `ENGINE_MODELS` (default free chain:
`nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3-super-120b-a12b:free`).
