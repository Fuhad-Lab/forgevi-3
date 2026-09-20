/**
 * Forgevi 3.0 — the run journal.
 *
 * Every engine action lands here as a seq-numbered frame; SSE readers
 * replay from ?since= and then stream live. In-memory by design — with
 * an optional best-effort frame sink (the Upstash Redis journal cache)
 * so an SSE re-attach after an engine restart replays what Redis still
 * holds instead of an immediate 404. The journal itself stays single-
 * process: one owner, direct fan-out, no external bus in the hot path.
 */

export interface JournalEvent {
  type: string;
  [key: string]: unknown;
}

export interface JournalEnvelope {
  seq: number;
  ts: number;
  id: string;
  runId: string;
  sessionId: string;
  goalId?: string;
  iteration?: number;
  role?: string;
  event: JournalEvent;
}

/** Async frame sink (best-effort) — the Redis journal cache rides this. */
export type FrameSink = (frame: JournalEnvelope) => void;

export type FrameListener = (frame: JournalEnvelope) => void;

export class RunJournal {
  private readonly frames: JournalEnvelope[] = [];
  private seq = 0;
  private closed = false;
  private readonly listeners = new Set<FrameListener>();
  private readonly closeWaiters: (() => void)[] = [];

  constructor(
    private readonly runId: string,
    private readonly sessionId: string,
    private readonly goalId: string,
    private readonly onFrame?: FrameSink,
  ) {}

  /** Append an event; assigns seq/id/ts and fans out to live listeners. */
  append(event: JournalEvent, meta: { iteration?: number; role?: string } = {}): JournalEnvelope {
    if (this.closed) throw new Error(`journal ${this.runId} is closed`);
    const frame: JournalEnvelope = {
      seq: ++this.seq,
      ts: Date.now(),
      id: crypto.randomUUID(),
      runId: this.runId,
      sessionId: this.sessionId,
      goalId: this.goalId,
      ...(meta.iteration !== undefined ? { iteration: meta.iteration } : {}),
      ...(meta.role ? { role: meta.role } : {}),
      event,
    };
    this.frames.push(frame);
    if (this.onFrame) {
      try {
        this.onFrame(frame);
      } catch {
        /* the cache sink never breaks the journal */
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch {
        /* a dead SSE reader never breaks the journal */
      }
    }
    return frame;
  }

  /** All frames with seq > since — the ?since= replay set. */
  framesSince(since: number): JournalEnvelope[] {
    return this.frames.filter((f) => f.seq > since);
  }

  get lastSeq(): number {
    return this.seq;
  }

  get eventCount(): number {
    return this.frames.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Subscribe to live frames. Returns an unsubscribe function. */
  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Terminal: after this, no more frames — SSE readers send forge-close and end. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.closeWaiters) {
      try {
        waiter();
      } catch {
        /* ignore */
      }
    }
    this.closeWaiters.length = 0;
  }

  /** Resolves when the journal closes (bounded SSE lifetimes). */
  get closedPromise(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.closeWaiters.push(resolve);
    });
  }
}
