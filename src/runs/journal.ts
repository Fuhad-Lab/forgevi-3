/**
 * Forgevi 3.0 — the run journal.
 *
 * Every engine action lands here as a seq-numbered frame; SSE readers
 * replay from ?since= and then stream live. In-memory by design — the
 * same trade the 2.0 engine makes (the frontend's poll fallback handles
 * engine restarts honestly; a 404 renders "everything built so far is
 * saved in your workspace"). No Redis, no external bus — a single
 * process owns the journal and fans it out to open streams directly.
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
