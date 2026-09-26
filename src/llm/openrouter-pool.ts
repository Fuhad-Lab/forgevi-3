/**
 * Forgevi — the OpenRouter key pool (THE OPENROUTER POOL LAW).
 *
 * The user's law, mirrored from the E2B/B2 pool approach: free-tier
 * capacity multiplies across N keys — but ONLY if the pool enforces it:
 *
 *   - round-robin across healthy keys (least-recently-used wins)
 *   - 429 / quota-exhaustion latching: a key that came back
 *     rate-limited or out-of-credit cools down (60s for 429s, rest-of-day
 *     for hard quota exhaustion) and is skipped — never retried blind
 *   - telemetry per key (uses, 429s, quota hits, last error)
 *   - honest failure: when EVERY key is cooling down the pool reports
 *     exhausted instead of hammering a dead key
 *
 * THE STICKY-KEY LAW (user mandate 2026-09-26): the LAST key that served
 * a successful lane is remembered — the next run's first pick PREFERS it
 * (a healthy sticky wins over the rotation cursor), so a follow-up
 * message continues on the key the AI settled on instead of marching from
 * key #1 through every exhausted key again ("routine/pipeline" rotations).
 * Stickiness + cooldowns persist in Redis (the engine restarts on every
 * Render deploy; in-memory state alone resets and resurrects exhausted
 * keys), restored at run start through snapshot()/restore().
 */

export interface OpenRouterKeyStats {
  label: string;
  uses: number;
  total429s: number;
  quotaExhaustions: number;
  cooldownRemainingMs: number;
  lastError: string | null;
}

export interface OpenRouterPoolStats {
  keys: number;
  healthyKeys: number;
  exhausted: boolean;
  /** The masked label of the sticky (last-good) key, when set. */
  stickyLabel: string | null;
  keyStats: OpenRouterKeyStats[];
}

export interface KeyPick {
  apiKey: string;
  label: string;
  reportSuccess: () => void;
  report429: () => void;
  reportQuotaExhaustion: (signature: string) => void;
  reportError: (err: string) => void;
}

/** The persistence shape — full key strings (server-side Redis only). */
export interface OpenRouterPoolSnapshot {
  stickyKey: string | null;
  cooldowns: { key: string; until: number }[];
}

interface KeyNode {
  keyString: string;
  label: string;
  uses: number;
  total429s: number;
  quotaExhaustions: number;
  cooldownUntil: number;
  lastUsedAt: number;
  lastError: string | null;
}

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const QUOTA_COOLDOWN_MS = 6 * 60 * 60_000; // rest-of-day for hard exhaustion

/** The 429/quota signature detection — OpenRouter's free-tier exhaustion
 *  phrasing plus generic rate-limit markers. */
export function isOpenRouterQuotaSignature(text: string): boolean {
  return /free-models-per-day|free_tier_daily|add 10 credits|rate limit exceeded|You've exceeded|insufficient_credits|quota/i.test(
    text,
  );
}

/** HARD quota only (a key's credit is truly gone — the rest-of-day
 *  cooldown). Rate-limit markers are deliberately excluded: a transient
 *  429 on one model must not bench a perfectly good key for six hours. */
export function isOpenRouterHardQuotaSignature(text: string): boolean {
  return /free-models-per-day|free_tier_daily|add 10 credits|insufficient_credits|You've exceeded|quota/i.test(
    text,
  );
}

/** A lane-level model failure (live-observed 2026-09-22: OpenRouter
 *  retired the `qwen/qwen3-coder:free` slug mid-run — "This model is
 *  unavailable for free. The paid version is available now"). A dead or
 *  unavailable model slug is a LANE problem: rotate to the next model in
 *  the chain instead of settling the whole run incomplete.
 *  THE MODEL-CONTEXT LAW (live-observed 2026-09-25): the bare /not found/
 *  alternative over-matched — "cline binary not found" (an engine-side
 *  infra failure) rotated the cascade through the whole chain as if every
 *  model were dead. Every alternative now demands MODEL context. */
export function isOpenRouterModelUnavailableSignature(text: string): boolean {
  return /model (?:is unavailable|not found|does not exist|unavailable)|no such model|invalid model id|unavailable for free|paid version is available|does not exist/i.test(
    text,
  );
}

/** THE UPSTREAM-TIMEOUT LAW (user report 2026-09-25, live-observed):
 * OpenRouter itself times out waiting on a free model's upstream provider
 * ("Upstream timeout exceeded" — NVIDIA's free endpoints under load miss
 * OpenRouter's proxy deadline), and the agent-side SDK surfaces the same
 * class as "The operation timed out" (user report 2026-09-26 — the
 * request-level fetch timeout inside the cline binary; NOT a limit the
 * engine sets — our only limits are the 50-min run wall clock and the
 * worker's 600s per-call budget, neither of which produces this string).
 * Both are LANE problems on that model: rotating to the next chain model
 * (a different upstream) recovers the run instead of settling it
 * incomplete with "Remaining (honest): error". */
export function isOpenRouterUpstreamTimeoutSignature(text: string): boolean {
  return /upstream timeout|timeout exceeded|timed out|upstream.*(error|unavailable|overloaded)|provider returned error|temporarily unavailable|service unavailable|overloaded/i.test(
    text,
  );
}

/** THE CRASH-RECOVERY LAW (user report 2026-09-26): the agent binary can
 *  DIE outright (Cline exit code -1, no settled run_result) — often the
 *  request-timeout class killing the process. A crashed lane is
 *  rotatable: the next pooled key + model gets the same prompt against
 *  the SAME workspace (prior work persists on disk), which recovers the
 *  run instead of settling it dead. */
export function isAgentCrashSignature(text: string): boolean {
  return /exited \(code|exited unexpectedly|without finishing/i.test(text);
}

export class OpenRouterKeyPool {
  private readonly nodes: KeyNode[] = [];
  private cursor = 0;
  /** THE STICKY-KEY LAW: index of the last key that served a successful
   *  lane — pick() prefers it whenever it is healthy. */
  private stickyIndex: number | null = null;
  /** Best-effort persistence hook (wired by openhands.ts to Redis). */
  private persistSink: (() => void) | null = null;

  constructor(keys: string[]) {
    for (const key of keys) {
      this.nodes.push({
        keyString: key,
        label: maskKey(key),
        uses: 0,
        total429s: 0,
        quotaExhaustions: 0,
        cooldownUntil: 0,
        lastUsedAt: 0,
        lastError: null,
      });
    }
  }

  get keyCount(): number {
    return this.nodes.length;
  }

  private healthy(): KeyNode[] {
    const t = Date.now();
    return this.nodes.filter((n) => n.cooldownUntil <= t);
  }

  get exhausted(): boolean {
    return this.nodes.length > 0 && this.healthy().length === 0;
  }

  /** Wire the best-effort persistence hook (called after every sticky /
   *  cooldown state change). */
  setPersistSink(sink: (() => void) | null): void {
    this.persistSink = sink;
  }

  private persist(): void {
    try {
      this.persistSink?.();
    } catch {
      /* persistence is best-effort by law */
    }
  }

  /** THE STICKY-KEY LAW, hint side: prefer a specific key (full string) on
   *  the next pick — the Redis-restored last-good key for this project.
   *  Unknown/cooling keys are ignored gracefully. */
  preferKey(keyString: string | null | undefined): void {
    if (!keyString) return;
    const idx = this.nodes.findIndex((n) => n.keyString === keyString);
    if (idx >= 0) this.stickyIndex = idx;
  }

  /** Restore persisted state (sticky + future cooldowns) — keys that are
   *  no longer in the pool are ignored; stale cooldowns drop out. */
  restore(snapshot: OpenRouterPoolSnapshot): void {
    const t = Date.now();
    for (const c of snapshot.cooldowns ?? []) {
      const node = this.nodes.find((n) => n.keyString === c.key);
      if (node && c.until > t && c.until > node.cooldownUntil) {
        node.cooldownUntil = c.until;
        if (!node.lastError) node.lastError = "quota exhausted (restored)";
      }
    }
    if (snapshot.stickyKey) {
      const idx = this.nodes.findIndex((n) => n.keyString === snapshot.stickyKey);
      // a sticky key that restored into a cooldown is no longer sticky
      if (idx >= 0 && this.nodes[idx]!.cooldownUntil <= t) this.stickyIndex = idx;
    }
  }

  /** The persistable state — full key strings, never masked (Redis is the
   *  engine's own server-side cache). */
  snapshot(): OpenRouterPoolSnapshot {
    const t = Date.now();
    return {
      stickyKey: this.stickyIndex !== null ? (this.nodes[this.stickyIndex]?.keyString ?? null) : null,
      cooldowns: this.nodes
        .filter((n) => n.cooldownUntil > t)
        .map((n) => ({ key: n.keyString, until: n.cooldownUntil })),
    };
  }

  /** Pick the next healthy key — THE STICKY-KEY LAW: a healthy sticky key
   *  wins first; otherwise least-recently-used rotation from the cursor. */
  pick(): KeyPick {
    if (this.nodes.length === 0) {
      throw new Error("OpenRouter pool has 0 keys — set OPENROUTER_API_KEYS (or OPENROUTER_API_KEY)");
    }
    const t = Date.now();
    let start = this.cursor;
    if (this.stickyIndex !== null) {
      const sticky = this.nodes[this.stickyIndex];
      if (sticky && sticky.cooldownUntil <= t) start = this.stickyIndex;
    }
    let node: KeyNode | undefined;
    for (let i = 0; i < this.nodes.length; i++) {
      const candidate = this.nodes[(start + i) % this.nodes.length]!;
      if (candidate.cooldownUntil <= t) {
        node = candidate;
        this.cursor = (start + i + 1) % this.nodes.length;
        break;
      }
    }
    if (!node) {
      const soonest = Math.min(...this.nodes.map((n) => n.cooldownUntil));
      throw new Error(
        `OpenRouter pool exhausted — every key is cooling down (next key free in ${Math.max(0, soonest - t)}ms)`,
      );
    }
    node.uses += 1;
    node.lastUsedAt = t;
    const picked = node;
    const pickedIndex = this.nodes.indexOf(picked);
    return {
      apiKey: picked.keyString,
      label: picked.label,
      reportSuccess: () => {
        picked.lastError = null;
        // THE STICKY-KEY LAW: this key just served a good lane — the next
        // run continues on it instead of restarting the rotation.
        this.stickyIndex = pickedIndex;
        this.persist();
      },
      report429: () => {
        picked.total429s += 1;
        picked.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        picked.lastError = "429 rate limited";
        this.persist();
      },
      reportQuotaExhaustion: (signature: string) => {
        picked.quotaExhaustions += 1;
        picked.cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
        picked.lastError = signature.slice(0, 200);
        // an exhausted key can never stay sticky
        if (this.stickyIndex === pickedIndex) this.stickyIndex = null;
        this.persist();
      },
      reportError: (err: string) => {
        picked.lastError = err.slice(0, 200);
      },
    };
  }

  stats(): OpenRouterPoolStats {
    const t = Date.now();
    return {
      keys: this.nodes.length,
      healthyKeys: this.healthy().length,
      exhausted: this.exhausted,
      stickyLabel: this.stickyIndex !== null ? (this.nodes[this.stickyIndex]?.label ?? null) : null,
      keyStats: this.nodes.map((n) => ({
        label: n.label,
        uses: n.uses,
        total429s: n.total429s,
        quotaExhaustions: n.quotaExhaustions,
        cooldownRemainingMs: Math.max(0, n.cooldownUntil - t),
        lastError: n.lastError,
      })),
    };
  }
}

function maskKey(key: string): string {
  if (key.length <= 14) return `${key.slice(0, 6)}…`;
  return `${key.slice(0, 10)}…${key.slice(-6)}`;
}
