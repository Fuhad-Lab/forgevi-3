/**
 * Forgevi 3.0 — configuration.
 *
 * Everything is env-driven, nothing is hardcoded. The engine is a single
 * Bun process: no Redis, no Temporal, no orchestrator — one agent loop,
 * one journal, one HTTP surface.
 */

export interface EngineConfig {
  port: number;
  extraOrigins: string[];
  grantSecret: string | undefined;

  provider: "openrouter" | "zai" | "mock";
  model: string | undefined;
  openrouterKey: string | undefined;

  /** NVIDIA NIM fallback — the OpenRouter free tier is 50 requests/day
   *  (account-wide). When the whole openrouter chain 429s with the
   *  free-models-per-day signature, runs fail over to this lane. */
  nvidia: { key: string; baseUrl: string; model: string | undefined } | undefined;

  mcpServers: McpServerConfig[];

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

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .filter((s) => typeof s["name"] === "string" && typeof s["url"] === "string" && /^https?:\/\//.test(String(s["url"])))
      .map((s) => ({
        name: String(s["name"]),
        url: String(s["url"]),
        headers:
          s["headers"] && typeof s["headers"] === "object"
            ? Object.fromEntries(
                Object.entries(s["headers"] as Record<string, unknown>)
                  .filter(([, v]) => typeof v === "string")
                  .map(([k, v]) => [k, String(v)]),
              )
            : undefined,
      }));
  } catch {
    return [];
  }
}

export function loadConfig(): EngineConfig {
  const env = process.env;
  const provider = env.ENGINE_PROVIDER === "zai" || env.ENGINE_PROVIDER === "mock" ? env.ENGINE_PROVIDER : "openrouter";
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

    provider,
    model: env.ENGINE_MODEL || undefined,
    openrouterKey: env.OPENROUTER_API_KEY || undefined,

    nvidia:
      env.NVIDIA_API_KEY || env.NVIDIA_NIM_API_KEY
        ? {
            key: (env.NVIDIA_API_KEY || env.NVIDIA_NIM_API_KEY)!,
            baseUrl: env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
            model: env.NVIDIA_MODEL || undefined,
          }
        : undefined,

    mcpServers: parseMcpServers(env.MCP_SERVERS),

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
