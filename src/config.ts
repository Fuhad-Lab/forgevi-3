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
  const modelChain: string[] = csv(env.ENGINE_MODELS).map((m) => m.replace(/^openai\//, ""));
  const singleModel = (env.ENGINE_MODEL || "").replace(/^openai\//, "");
  if (modelChain.length === 0 && singleModel) modelChain.push(singleModel);
  if (modelChain.length === 0) {
    // THE FREE-CHAIN DEFAULT (live-tested 2026-09-20): ultra works, lightning
    // works, super was 503-overloaded — order by observed reliability.
    modelChain.push(
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-3.5-lightning:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
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
  };
}

export const config = loadConfig();
