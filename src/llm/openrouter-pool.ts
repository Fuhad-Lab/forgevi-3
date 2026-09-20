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

export class OpenRouterKeyPool {
  private readonly nodes: KeyNode[] = [];
  private cursor = 0;

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

  /** Pick the next healthy key (least-recently-used rotation). */
  pick(): KeyPick {
    if (this.nodes.length === 0) {
      throw new Error("OpenRouter pool has 0 keys — set OPENROUTER_API_KEYS (or OPENROUTER_API_KEY)");
    }
    const t = Date.now();
    let node: KeyNode | undefined;
    for (let i = 0; i < this.nodes.length; i++) {
      const candidate = this.nodes[(this.cursor + i) % this.nodes.length]!;
      if (candidate.cooldownUntil <= t) {
        node = candidate;
        this.cursor = (this.cursor + i + 1) % this.nodes.length;
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
    return {
      apiKey: picked.keyString,
      label: picked.label,
      reportSuccess: () => {
        picked.lastError = null;
      },
      report429: () => {
        picked.total429s += 1;
        picked.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        picked.lastError = "429 rate limited";
      },
      reportQuotaExhaustion: (signature: string) => {
        picked.quotaExhaustions += 1;
        picked.cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
        picked.lastError = signature.slice(0, 200);
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
