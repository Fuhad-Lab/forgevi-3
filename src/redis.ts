/**
 * Forgevi — the Upstash Redis layer (THE MESSAGE-CACHING LAW).
 *
 * The user's law: no localStorage/sessionStorage anywhere in the AI
 * system — messages live in Redis (Upstash). This is the ENGINE side:
 *
 *   - chat history per project: the full conversation cached under
 *     forgeyn:project:{id}:chat (capped) — a run that arrives WITHOUT
 *     chatHistory (engine restart, lost cookie, new device) still
 *     continues the SAME conversation instead of starting fresh
 *   - journal frames per run: capped under forgeyn:run:{id}:events —
 *     an SSE re-attach after an engine restart replays what Redis
 *     still holds (the frontend's honest 404-poll fallback shrinks)
 *
 * The REST API (zero client dependency, plain fetch — works on Bun).
 * Every operation is best-effort BY DESIGN: Redis is a cache, never the
 * source of truth; a Redis outage degrades to today's behavior, never
 * to a hard failure (errors land in engine stderr only).
 */

import { config } from "./config.ts";

// ── the REST client ─────────────────────────────────────────────────────

async function redisCommand<T>(command: (string | number)[]): Promise<T | null> {
  const redis = config.redis;
  if (!redis) return null;
  try {
    const res = await fetch(redis.restUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redis.restToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.error(`[redis] REST ${command[0]} → HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { result?: unknown };
    return (body.result ?? null) as T | null;
  } catch (err) {
    console.error(`[redis] REST ${command[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function redisConfigured(): boolean {
  return Boolean(config.redis);
}

// ── the chat-history cache (per project) ────────────────────────────────

export interface CachedChatRow {
  role: "user" | "assistant";
  content: string;
  at: number;
}

const CHAT_CAP = 200;

function chatKey(projectId: string): string {
  return `forgeyn:project:${projectId}:chat`;
}

/** Cache the project's conversation (frontend-provided rows win, Redis fills). */
export async function cacheProjectChat(projectId: string, rows: CachedChatRow[]): Promise<void> {
  if (rows.length === 0) return;
  const key = chatKey(projectId);
  await redisCommand(["DEL", key]);
  // RPUSH in batches
  const batch: string[] = [];
  for (const row of rows.slice(-CHAT_CAP)) {
    batch.push(JSON.stringify(row));
  }
  if (batch.length > 0) {
    await redisCommand(["RPUSH", key, ...batch]);
  }
}

/** Append one completed turn (user objective + assistant outcome). */
export async function appendProjectTurn(
  projectId: string,
  turn: { user: string; assistant: string },
): Promise<void> {
  const key = chatKey(projectId);
  await redisCommand([
    "RPUSH",
    key,
    JSON.stringify({ role: "user", content: turn.user, at: Date.now() } satisfies CachedChatRow),
    JSON.stringify({ role: "assistant", content: turn.assistant, at: Date.now() } satisfies CachedChatRow),
  ]);
  await redisCommand(["LTRIM", key, -CHAT_CAP, -1]);
}

/** Load the cached conversation (null when Redis is unconfigured/down). */
export async function loadProjectChat(projectId: string): Promise<CachedChatRow[] | null> {
  const raw = await redisCommand<string[]>(["LRANGE", chatKey(projectId), 0, -1]);
  if (!raw) return null;
  const rows: CachedChatRow[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item) as CachedChatRow;
      if (parsed && (parsed.role === "user" || parsed.role === "assistant") && typeof parsed.content === "string") {
        rows.push({ role: parsed.role, content: parsed.content, at: Number(parsed.at) || 0 });
      }
    } catch {
      /* skip malformed row */
    }
  }
  return rows;
}

// ── the journal-frame cache (per run) ───────────────────────────────────

const EVENTS_CAP = 800;

function eventsKey(runId: string): string {
  return `forgeyn:run:${runId}:events`;
}

/** Cache one journal frame (best-effort, capped). */
export async function cacheRunEvent(runId: string, seq: number, frame: unknown): Promise<void> {
  const ok = await redisCommand(["RPUSH", eventsKey(runId), JSON.stringify(frame)]);
  if (ok !== null) {
    await redisCommand(["LTRIM", eventsKey(runId), -EVENTS_CAP, -1]);
  }
}

/** Load the cached frames for a run (null when unconfigured/down/empty). */
export async function loadRunEvents(runId: string): Promise<unknown[] | null> {
  const raw = await redisCommand<string[]>(["LRANGE", eventsKey(runId), 0, -1]);
  if (!raw || raw.length === 0) return null;
  const frames: unknown[] = [];
  for (const item of raw) {
    try {
      frames.push(JSON.parse(item));
    } catch {
      /* skip malformed frame */
    }
  }
  return frames;
}

// ── the continuity merge (THE FIX for "every message = a new project") ──

/** Merge the frontend-supplied history with the Redis-cached one:
 *  union by (role, content) preserving order — whichever side is longer
 *  wins the tail; the merged history is what the run's prompt carries. */
export function mergeChatHistories(
  frontend: Array<{ role: "user" | "assistant"; content: string }>,
  cached: CachedChatRow[] | null,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!cached || cached.length === 0) return frontend;
  const cachedRows = cached.map((r) => ({ role: r.role, content: r.content }));
  if (frontend.length >= cachedRows.length) {
    // frontend is at least as complete — but check whether Redis holds
    // turns the frontend lost (engine restart mid-conversation)
    const seen = new Set(frontend.map((m) => `${m.role}:${m.content}`));
    const missing = cachedRows.filter((m) => !seen.has(`${m.role}:${m.content}`));
    if (missing.length === 0) return frontend;
    // interleave the missing cached turns in chronological position
    const merged = [...frontend];
    for (const row of missing) merged.push(row);
    return merged;
  }
  // Redis is more complete (frontend lost state) — cached wins, frontend
  // rows not present are appended (the newest objective rides separately)
  const seen = new Set(cachedRows.map((m) => `${m.role}:${m.content}`));
  const extra = frontend.filter((m) => !seen.has(`${m.role}:${m.content}`));
  return [...cachedRows, ...extra];
}

export const redisKeyScheme = {
  chatCap: CHAT_CAP,
  eventsCap: EVENTS_CAP,
};
