/**
 * Forgevi — configuration.
 *
 * Everything is env-driven, nothing is hardcoded. The engine is one Bun
 * process (the HTTP/SSE surface) plus one OpenHands worker process per
 * run — no Redis bus, no Temporal, no orchestrator.
 *
 * CONFIG SOURCES (priority, the deployment law):
 *   1. process.env — the Render dashboard / shell environment ALWAYS wins
 *   2. `.engine-runtime-config.json` — the runtime config file written by
 *      the authenticated config-push surface (POST /admin/config, relay-key
 *      guarded, master-email gated at the edge). Fills ONLY unset keys —
 *      env vars remain the source of truth; the file is a deployment
 *      convenience for keys that cannot ride a git push.
 *   3. defaults — the honest fallbacks below.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The runtime config file — persisted by the config-push surface. */
const RUNTIME_CONFIG_FILE = path.resolve(process.cwd(), ".engine-runtime-config.json");

/** Keys the config-push surface may never set (surface hardening). */
const RUNTIME_CONFIG_DENYLIST = new Set([
  "ENGINE_PORT",
  "PORT",
  "NODE_ENV",
  "ENGINE_RUNTIME_CONFIG_DISABLE",
]);

// ── runtime config file → env gaps (boot time, exactly once) ───────────
function applyRuntimeConfigFile(): void {
  if (process.env.ENGINE_RUNTIME_CONFIG_DISABLE === "1") return;
  try {
    if (!existsSync(RUNTIME_CONFIG_FILE)) return;
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_FILE, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (RUNTIME_CONFIG_DENYLIST.has(key)) continue;
      if (key.startsWith("ENGINE_") && key !== "ENGINE_RELAY_KEY") {
        // engine-scoped knobs stay env-only except the documented allowlist
        if (!["ENGINE_MODEL", "ENGINE_MODELS", "ENGINE_MAX_CONCURRENT"].includes(key)) continue;
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // unreadable/corrupt runtime config — env-only operation (honest)
  }
}

applyRuntimeConfigFile();

export function runtimeConfigPath(): string {
  return RUNTIME_CONFIG_FILE;
}

/** Read the runtime config file's persisted values (the inspector surface).
 *  Returns {} when absent/unreadable — an honest empty, not an error. */
export function readRuntimeConfigFile(): Record<string, string> {
  try {
    if (!existsSync(RUNTIME_CONFIG_FILE)) return {};
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_FILE, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof key === "string" && typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function runtimeConfigDenylist(): string[] {
  return [...RUNTIME_CONFIG_DENYLIST];
}

/** Write the runtime config file (the config-push surface). */
export function writeRuntimeConfigFile(values: Record<string, string>): { written: string[]; denied: string[] } {
  const written: string[] = [];
  const denied: string[] = [];
  const merged: Record<string, string> = {};
  if (existsSync(RUNTIME_CONFIG_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_FILE, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) if (typeof v === "string") merged[k] = v;
    } catch {
      /* corrupt file — overwrite whole */
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (RUNTIME_CONFIG_DENYLIST.has(key) || (key.startsWith("ENGINE_") && key !== "ENGINE_RELAY_KEY" && !["ENGINE_MODEL", "ENGINE_MODELS", "ENGINE_MAX_CONCURRENT"].includes(key))) {
      denied.push(key);
      continue;
    }
    merged[key] = value;
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
    written.push(key);
  }
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
  return { written, denied };
}

// ── typed config ───────────────────────────────────────────────────────

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function csv(v: string | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** E2B pool keys: E2B_API_KEYS (csv) + E2B_API_KEY_1..N + legacy E2B_API_KEY. */
function e2bPoolKeys(): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (k: string | undefined) => {
    if (k && k.trim() && !seen.has(k.trim())) {
      seen.add(k.trim());
      keys.push(k.trim());
    }
  };
  for (const k of csv(process.env.E2B_API_KEYS)) add(k);
  for (let i = 1; i <= 12; i++) add(process.env[`E2B_API_KEY_${i}`]);
  add(process.env.E2B_API_KEY); // legacy single-key form → pool of one
  return keys;
}

export interface B2Config {
  /** Master credentials (self-healing bootstrap mints the S3 key). */
  masterKeyId: string;
  masterAppKey: string;
  /** Direct S3 credentials (skip the bootstrap when provided). */
  s3KeyId?: string;
  s3AppKey?: string;
  bucket: string;
  region?: string;
}

export interface EngineConfig {
  port: number;
  extraOrigins: string[];

  e2bKeys: string[];
  e2bTemplate: string | undefined;
  e2bSeatsPerKey: number;
  e2bSpawnThrottleMs: number;
  e2bSpawnQueueMax: number;
  e2bIdleTtlMs: number;
  e2bMigrateAtMs: number;
  e2bHardCapMs: number;
  e2bPoolToken: string | undefined;

  b2: B2Config | undefined;

  openrouterKeys: string[];
  modelChain: string[];
  openrouterBaseUrl: string;

  redis: { restUrl: string; restToken: string } | undefined;

  otlpEndpoint: string | undefined;

  /** The workspace-grant HMAC secret (the backend mints, the engine verifies). */
  grantSecret: string | undefined;

  /** Shared secret guarding the /workspace/* studio surface (the edge relay
   *  sends X-Engine-Relay-Key after verifying project ownership). */
  relayKey: string | undefined;

  /** 0 = unlimited (default — the user's law: runs end when the agent finishes or the user aborts) */
  maxSteps: number;
  maxWallclockMs: number;
  maxTokens: number;
  maxConcurrent: number;

  /** THE AGENT-LANE LAW (2026-09-23): the in-VM agent runtime.
   *   "cline" (default) — the Cline CLI headless (`--json` NDJSON +
   *   `--auto-approve`), the npm `cline` platform binary baked into the
   *   golden image (lazy `npm i -g cline` fallback for old sandboxes),
   *   driven per lane with a `cline auth -p openrouter` exec (the pooled
   *   key + the lane's model).
   *   "openhands" — the previous generation (openhands/worker.py inside
   *   the venv), retained as the explicit fallback and the automatic
   *   fallback when cline is unavailable in a sandbox.
   * Set via ENGINE_AGENT=cline|openhands. */
  agentLane: "cline" | "openhands";
}

export function loadConfig(): EngineConfig {
  const env = process.env;
  const e2bKeys = e2bPoolKeys();
  const b2 =
    (env.B2_KEY_ID && env.B2_APPLICATION_KEY) || (env.B2_S3_KEY_ID && env.B2_S3_APPLICATION_KEY)
      ? {
          masterKeyId: env.B2_KEY_ID || "",
          masterAppKey: env.B2_APPLICATION_KEY || "",
          ...(env.B2_S3_KEY_ID && env.B2_S3_APPLICATION_KEY
            ? { s3KeyId: env.B2_S3_KEY_ID, s3AppKey: env.B2_S3_APPLICATION_KEY }
            : {}),
          bucket: env.B2_BUCKET || "Forgeyn",
          ...(env.B2_REGION ? { region: env.B2_REGION } : {}),
        }
      : undefined;
  const openrouterKeys: string[] = [];
  {
    const seen = new Set<string>();
    const add = (k: string | undefined) => {
      if (k && k.trim() && !seen.has(k.trim())) {
        seen.add(k.trim());
        openrouterKeys.push(k.trim());
      }
    };
    for (const k of csv(env.OPENROUTER_API_KEYS)) add(k);
    for (let i = 1; i <= 16; i++) add(env[`OPENROUTER_API_KEY_${i}`]);
    add(env.OPENROUTER_API_KEY); // legacy single-key form
  }
  // THE RETIRED-PRIMARY GUARD (live-observed 2026-09-25): the engine's
  // Render service carries ENGINE_MODELS as a REAL env var (the user lifted
  // the earlier session's list into the dashboard) — and env vars win at
  // boot, so the stale chain (nemotron-lightning first) survived every
  // config-push and code-default change. When the env chain's PRIMARY is a
  // slug this platform has explicitly RETIRED, the chain's ordering is
  // obsolete — discard it for the maintained default (a non-retired env
  // chain still wins verbatim, minus any retired tail steps).
  const RETIRED_MODEL_SLUGS = new Set([
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
  ]);
  const envChain = csv(env.ENGINE_MODELS).map((m) => m.replace(/^openai\//, ""));
  const primaryRetired = envChain.length > 0 && RETIRED_MODEL_SLUGS.has(envChain[0]!);
  const modelChain: string[] = primaryRetired ? [] : envChain.filter((m) => !RETIRED_MODEL_SLUGS.has(m));
  const singleModel = (env.ENGINE_MODEL || "").replace(/^openai\//, "");
  if (modelChain.length === 0 && singleModel && !RETIRED_MODEL_SLUGS.has(singleModel)) modelChain.push(singleModel);
  if (modelChain.length === 0) {
    // THE CAPABLE-MODEL LAW (user mandate 2026-09-25): the free chain leads
    // with DEDICATED CODING AGENT models, not general chat models — the
    // user's law: "code quality, tools calling and others it should be able
    // to do." Live-probed order against the OpenRouter catalog (all $0,
    // tools-capable):
    //   1. poolside/laguna-s-2.1:free — Poolside's coding agent model
    //      (118B/8B active, 70.2% Terminal-Bench 2.1) — built for exactly
    //      this workload: multi-file agentic coding in a terminal loop.
    //      Live-verified through Cline for 15 iterations (the upstream
    //      throttles transiently — the lane cascade rides it out).
    //   2. qwen/qwen3.8-27b:free — dense 27B for coding, agentic and
    //      long-running agent tasks (262K ctx, VLM).
    //   3. cohere/north-mini-code:free — Cohere's dedicated agentic coding
    //      model (30B/3B active) — LIVE-VERIFIED tool calling when the
    //      bigger upstreams are throttled.
    //   4. nvidia/nemotron-3-ultra-550b-a55b:free — the proven former
    //      top-of-chain fallback (1M ctx).
    //    REMOVED after live verification (2026-09-25): thinkingmachines/
    //    inkling:free (403 "only available on agentic harnesses" — app-
    //    whitelist gated, fails even through the real Cline CLI) and
    //    nex-agi/nex-n2.5-(pro|mini):free (404 "No endpoints found" — dead
    //    slugs). The lightning/super steps are RETIRED: NVIDIA's free
    //    upstreams are the source of the live-observed "Upstream timeout
    //    exceeded" lane deaths.
    // The lane cascade rotates on dead slugs and upstream timeouts, so a
    // future retirement degrades gracefully.
    modelChain.push(
      "poolside/laguna-s-2.1:free",
      "qwen/qwen3.8-27b:free",
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    );
  }
  const redis =
    env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? { restUrl: env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, ""), restToken: env.UPSTASH_REDIS_REST_TOKEN }
      : undefined;
  return {
    // ENGINE_PORT wins; Render injects PORT; local default 3010
    port: num(env.ENGINE_PORT, num(env.PORT, 3010)),
    extraOrigins: csv(env.ENGINE_EXTRA_ORIGINS),

    e2bKeys,
    e2bTemplate: env.E2B_TEMPLATE_ID || undefined,
    e2bSeatsPerKey: Math.max(1, num(env.E2B_SEATS_PER_KEY, 20)),
    e2bSpawnThrottleMs: Math.max(0, num(env.E2B_SPAWN_THROTTLE_MS, 1000)),
    e2bSpawnQueueMax: Math.max(0, num(env.E2B_SPAWN_QUEUE_MAX, 8)),
    e2bIdleTtlMs: Math.max(30_000, num(env.E2B_IDLE_TTL_MS, 5 * 60_000)),
    e2bMigrateAtMs: Math.max(60_000, num(env.E2B_MIGRATE_AT_MS, 55 * 60_000)),
    e2bHardCapMs: Math.max(60_000, num(env.E2B_HARD_CAP_MS, 60 * 60_000)),
    e2bPoolToken: env.E2B_POOL__API_TOKEN || undefined,

    b2,

    openrouterKeys,
    modelChain,
    openrouterBaseUrl: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",

    redis,

    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,

    grantSecret: env.WORKSPACE_GRANT_SECRET || undefined,

    relayKey: env.ENGINE_RELAY_KEY || undefined,

    maxSteps: num(env.FORGVI3_MAX_STEPS, 0),
    maxWallclockMs: num(env.FORGVI3_MAX_WALLCLOCK_MS, 0),
    maxTokens: num(env.FORGVI3_MAX_TOKENS, 0),
    maxConcurrent: Math.max(1, num(env.ENGINE_MAX_CONCURRENT, 3)),

    agentLane: env.ENGINE_AGENT === "openhands" ? "openhands" : "cline",
  };
}

export const config = loadConfig();

/** Hot-apply pushed config: mutate the live config object in place (env
 *  vars still win — loadConfig re-reads process.env, which the push only
 *  fills for unset keys). The pool singletons rebuild off this. */
export function reloadEngineConfig(): void {
  Object.assign(config, loadConfig());
}
