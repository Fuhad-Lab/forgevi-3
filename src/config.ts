/**
 * Forgevi — configuration.
 *
 * Everything is env-driven, nothing is hardcoded. The engine is one Bun
 * process (the HTTP/SSE surface) plus one OpenHands worker process per
 * run — no Redis, no Temporal, no orchestrator.
 */

export interface EngineConfig {
  port: number;
  extraOrigins: string[];
  grantSecret: string | undefined;

  e2bKey: string | undefined;
  e2bTemplate: string | undefined;

  b2: { keyId: string; appKey: string; bucket: string; region: string } | undefined;

  otlpEndpoint: string | undefined;

  /** Shared secret guarding the /workspace/* studio surface (the edge relay
   *  sends X-Engine-Relay-Key after verifying project ownership). */
  relayKey: string | undefined;

  /** 0 = unlimited (default — the user's law: runs end when the agent finishes or the user aborts) */
  maxSteps: number;
  maxWallclockMs: number;
  maxTokens: number;
  maxConcurrent: number;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(): EngineConfig {
  const env = process.env;
  const b2 =
    env.B2_KEY_ID && env.B2_APP_KEY && env.B2_BUCKET
      ? {
          keyId: env.B2_KEY_ID,
          appKey: env.B2_APP_KEY,
          bucket: env.B2_BUCKET,
          region: env.B2_REGION || "us-west-004",
        }
      : undefined;
  return {
    // ENGINE_PORT wins; Render injects PORT; local default 3010
    port: num(env.ENGINE_PORT, num(env.PORT, 3010)),
    extraOrigins: (env.ENGINE_EXTRA_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    grantSecret: env.WORKSPACE_GRANT_SECRET || undefined,

    e2bKey: env.E2B_API_KEY || undefined,
    e2bTemplate: env.E2B_TEMPLATE_ID || undefined,

    b2,

    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,

    relayKey: env.ENGINE_RELAY_KEY || undefined,

    maxSteps: num(env.FORGVI3_MAX_STEPS, 0),
    maxWallclockMs: num(env.FORGVI3_MAX_WALLCLOCK_MS, 0),
    maxTokens: num(env.FORGVI3_MAX_TOKENS, 0),
    maxConcurrent: Math.max(1, num(env.ENGINE_MAX_CONCURRENT, 3)),
  };
}

export const config = loadConfig();
