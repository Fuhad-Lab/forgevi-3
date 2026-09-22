/**
 * Forgevi — the E2B KeyPoolBroker (THE KEY POOL LAW).
 *
 * Ported from the platform's own e2b_backblaze/pool/broker.py laws:
 *
 *   - 20 sandbox seats per key (free-tier concurrent limit), enforced
 *   - >= 1000ms throttle between spawns on the SAME key (E2B 429s faster)
 *   - least-loaded cascade across keys (the key with the most open seats
 *     AND an expired throttle wins)
 *   - bounded spawn queue (requests arriving faster than the pool can
 *     spawn wait, bounded — they never crash with a raw 429)
 *   - 429 telemetry per key (lifetime counters, observability)
 *   - rollback on failed acquisition (a seat taken is a seat returned)
 *   - provider-truth reconciliation: seedSlots/adoptByIds re-adopt live
 *     sandboxes after free-tier sleep / redeploy / crash instead of
 *     over-allocating
 *   - honest failure: PoolExhaustedError "0/0 slots across 0 keys" —
 *     never fake execution
 */

export interface KeyStats {
  label: string;
  activeSlots: number;
  maxSlots: number;
  throttleRemainingMs: number;
  totalSpawns: number;
  total429s: number;
  exhausted: boolean;
  exhaustedUntil: number;
  /** THE TEMPLATE-ACCESS LAW (2026-09-22): a key whose account cannot
   * spawn the configured (private) template — "404 template not found" /
   * "403 no access" — is blocked from further spawn attempts instead of
   * poisoning every cascade round. null = usable. */
  blockedReason: string | null;
}

export interface PoolStats {
  keys: number;
  /** Keys not blocked by template-access/auth failures. */
  usableKeys: number;
  totalSlots: number;
  usedSlots: number;
  queueDepth: number;
  total429s: number;
  keyStats: KeyStats[];
}

export class PoolExhaustedError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "PoolExhaustedError";
  }
}

interface KeyNode {
  keyString: string;
  label: string;
  activeSlots: number;
  lastSpawnAt: number;
  totalSpawns: number;
  total429s: number;
  /** Cooldown after a live 429 (transient upstream pressure). */
  exhaustedUntil: number;
  /** Permanent-for-this-config spawn failure (template access / dead
   * auth) — the key stops competing for spawns until the broker rebuilds
   * (config push / restart re-discovers with fresh credentials). */
  blockedReason: string | null;
}

export interface Lease {
  key: string;
  keyLabel: string;
  release: () => void;
  /** Mark this acquisition as having hit a live 429 — cooldown + telemetry. */
  report429: () => void;
  /** Mark this key as unable to spawn the configured template (404/403
   * template-access or dead auth) — it stops competing until the broker
   * rebuilds. THE TEMPLATE-ACCESS LAW. */
  reportBlocked: (reason: string) => void;
}

export interface BrokerOptions {
  keys: string[];
  maxSlotsPerKey?: number;
  spawnThrottleMs?: number;
  queueMax?: number;
  queueTimeoutMs?: number;
  now?: () => number;
}

/** The single serialization point the 1-spawn/second law demands. */
export class KeyPoolBroker {
  private readonly nodes: KeyNode[] = [];
  private readonly maxSlots: number;
  private readonly throttleMs: number;
  private readonly queueMax: number;
  private readonly queueTimeoutMs: number;
  private readonly now: () => number;
  private waiters: Array<{
    leaseResolve: (lease: Lease) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(opts: BrokerOptions) {
    this.maxSlots = Math.max(1, opts.maxSlotsPerKey ?? 20);
    this.throttleMs = Math.max(0, opts.spawnThrottleMs ?? 1000);
    this.queueMax = Math.max(0, opts.queueMax ?? 8);
    this.queueTimeoutMs = Math.max(1_000, opts.queueTimeoutMs ?? 120_000);
    this.now = opts.now ?? (() => Date.now());
    for (const key of opts.keys) {
      this.nodes.push({
        keyString: key,
        label: maskKey(key),
        activeSlots: 0,
        lastSpawnAt: 0,
        totalSpawns: 0,
        total429s: 0,
        exhaustedUntil: 0,
        blockedReason: null,
      });
    }
  }

  get keyCount(): number {
    return this.nodes.length;
  }

  /** Least-loaded cascade: most open slots, expired throttle, not cooling
   * down, and not blocked (THE TEMPLATE-ACCESS LAW — a key that cannot
   * spawn the configured template never wins a pick). */
  private pick(): KeyNode | null {
    let best: KeyNode | null = null;
    let bestScore = -1;
    const t = this.now();
    for (const node of this.nodes) {
      if (node.blockedReason !== null) continue;
      if (node.exhaustedUntil > t) continue;
      const open = this.maxSlots - node.activeSlots;
      if (open <= 0) continue;
      const throttleLeft = node.lastSpawnAt > 0 ? Math.max(0, node.lastSpawnAt + this.throttleMs - t) : 0;
      // primary: open seats; tie-break: the longest-idle key (round-robin drift)
      const score = open * 1_000_000 - throttleLeft;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  private throttleWaitMs(node: KeyNode): number {
    if (node.lastSpawnAt === 0) return 0;
    return Math.max(0, node.lastSpawnAt + this.throttleMs - this.now());
  }

  /** Hand a released seat to the next waiter (FIFO). */
  private pump(): void {
    while (this.waiters.length > 0) {
      const node = this.pick();
      if (!node) return;
      const wait = this.throttleWaitMs(node);
      if (wait > 0) {
        setTimeout(() => this.pump(), wait).unref?.();
        return;
      }
      const waiter = this.waiters.shift()!;
      this.checkout(node, waiter.leaseResolve);
      clearTimeout(waiter.timer);
    }
  }

  /** Seat checkout shared by acquire() and pump(). */
  private checkout(node: KeyNode, resolve: (lease: Lease) => void): void {
    node.activeSlots += 1;
    node.lastSpawnAt = this.now();
    node.totalSpawns += 1;
    let released = false;
    resolve({
      key: node.keyString,
      keyLabel: node.label,
      release: () => {
        if (released) return;
        released = true;
        node.activeSlots = Math.max(0, node.activeSlots - 1);
        this.pump();
      },
      report429: () => {
        node.total429s += 1;
        // short cooldown (30s) — the throttle law already spaces spawns
        node.exhaustedUntil = this.now() + 30_000;
      },
      reportBlocked: (reason: string) => {
        node.blockedReason = reason.slice(0, 160);
        this.pump();
      },
    });
  }

  /** Acquire a spawn slot — the bounded cascade wait lives here. */
  async acquire(): Promise<Lease> {
    if (this.nodes.length === 0) {
      // THE HONEST FAILURE LAW: 0/0 slots across 0 keys, never fake execution
      throw new PoolExhaustedError(
        "E2B pool has 0/0 slots across 0 keys — set E2B_API_KEYS (or E2B_API_KEY_1..N) to activate the pool",
      );
    }
    // THE ALL-BLOCKED LAW: every key is template/auth-blocked — waiting in
    // the queue cannot help (no key will ever win a pick). Fail honestly
    // NOW instead of burning the 120s queue timeout.
    if (this.nodes.every((n) => n.blockedReason !== null)) {
      const blocked = this.nodes
        .map((n) => `${n.label}: ${n.blockedReason}`)
        .join(" | ");
      throw new PoolExhaustedError(
        `E2B pool: all ${this.nodes.length} keys are blocked — ${blocked}`,
      );
    }
    // fast path: a key can take it right now (respecting the throttle) —
    // but never queue-jump past waiters already in line
    if (this.waiters.length === 0) {
      const node = this.pick();
      if (node) {
        const wait = this.throttleWaitMs(node);
        if (wait > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, wait));
          return await this.acquire(); // re-pick — a better key may have opened
        }
        return await new Promise<Lease>((resolve) => this.checkout(node, resolve));
      }
    }
    // slow path: every key is full/cooling — the bounded queue. The lease
    // is handed to this caller by pump() the moment a seat frees.
    if (this.queueMax === 0 || this.waiters.length >= this.queueMax) {
      const used = this.nodes.reduce((sum, n) => sum + n.activeSlots, 0);
      throw new PoolExhaustedError(
        `E2B pool exhausted: ${used}/${this.nodes.length * this.maxSlots} slots across ${this.nodes.length} keys (queue full) — retry shortly`,
      );
    }
    return await new Promise<Lease>((resolve, reject) => {
      const entry: { leaseResolve: (lease: Lease) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } = {
        leaseResolve: resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new PoolExhaustedError(`E2B pool queue timeout (${this.queueTimeoutMs}ms)`));
        }, this.queueTimeoutMs),
      };
      entry.timer.unref?.();
      this.waiters.push(entry);
    });
  }

  // ── provider-truth reconciliation ─────────────────────────────────────

  /** Seed slot counts from provider truth (live sandbox counts per key). */
  seedSlots(liveCounts: Array<{ keyLabel: string; live: number }>): void {
    for (const { keyLabel, live } of liveCounts) {
      const node = this.nodes.find((n) => n.label === keyLabel);
      if (!node) continue;
      node.activeSlots = Math.max(0, Math.min(this.maxSlots, live));
    }
  }

  /** Adopt live sandboxes by id → the owning key (post-restart reconciliation). */
  adoptByIds(sandboxIds: string[], keyForSandbox: (sandboxId: string) => string | null): void {
    for (const id of sandboxIds) {
      const keyLabel = keyForSandbox(id);
      if (!keyLabel) continue;
      const node = this.nodes.find((n) => n.label === keyLabel);
      if (!node) continue;
      if (node.activeSlots < this.maxSlots) node.activeSlots += 1;
    }
  }

  /** The dashboard shape: seats, throttle, 429s per key. */
  stats(): PoolStats {
    const t = this.now();
    const keyStats: KeyStats[] = this.nodes.map((n) => ({
      label: n.label,
      activeSlots: n.activeSlots,
      maxSlots: this.maxSlots,
      throttleRemainingMs: n.lastSpawnAt > 0 ? Math.max(0, n.lastSpawnAt + this.throttleMs - t) : 0,
      totalSpawns: n.totalSpawns,
      total429s: n.total429s,
      exhausted: n.exhaustedUntil > t,
      exhaustedUntil: n.exhaustedUntil,
      blockedReason: n.blockedReason,
    }));
    return {
      keys: this.nodes.length,
      usableKeys: this.nodes.filter((n) => n.blockedReason === null).length,
      totalSlots: this.nodes.length * this.maxSlots,
      usedSlots: this.nodes.reduce((sum, n) => sum + n.activeSlots, 0),
      queueDepth: this.waiters.length,
      total429s: this.nodes.reduce((sum, n) => sum + n.total429s, 0),
      keyStats,
    };
  }
}

function maskKey(key: string): string {
  if (key.length <= 14) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 8)}…${key.slice(-6)}`;
}
