/**
 * State queue for the mascot — ported from Petdex sidecar (`sidecar/state-queue.ts`).
 *
 * Each session/event state transition becomes a StateEvent that a worker drains
 * in order. The queue:
 *   1. Enforces a minimum dwell time per event so the mascot doesn't pinball
 *      when the agent fires turn/start → tool/call → tool/result back-to-back.
 *   2. Coalesces same-state runs at enqueue time (already displayed or queued).
 *   3. Bounds the queue (overflow drops oldest; newest always wins).
 *
 * Pure logic — no I/O. The host plugin's tick loop drains it.
 */

export type StateEvent = {
  state: string;
  duration?: number;
  receivedAt: number;
};

export type QueueOptions = {
  minDwellMs?: number;
  maxQueueSize?: number;
  /**
   * Transient states whose duration is intrinsic to the animation (waving,
   * failed, jumping). The worker must not advance until min(duration, dwell)
   * elapses, otherwise the user never sees the action finish.
   */
  durationStates?: ReadonlySet<string>;
};

const DEFAULTS: Required<QueueOptions> = {
  minDwellMs: 250,
  maxQueueSize: 50,
  durationStates: new Set(["waving", "failed", "review", "jumping"]),
};

export type DisplayedState = {
  state: string;
  duration: number;
  shownAt: number;
};

export class StateQueue {
  private readonly opts: Required<QueueOptions>;
  private readonly pending: StateEvent[] = [];
  private displayed: DisplayedState | null = null;

  constructor(options: QueueOptions = {}) {
    this.opts = { ...DEFAULTS, ...options } as Required<QueueOptions>;
  }

  /** Push an event. Returns true if accepted, false if coalesced. */
  enqueue(event: StateEvent): boolean {
    if (this.coalesces(event)) return false;
    this.pending.push(event);
    while (this.pending.length > this.opts.maxQueueSize) {
      this.pending.shift();
    }
    return true;
  }

  private coalesces(event: StateEvent): boolean {
    if (this.displayed && this.displayed.state === event.state) {
      const elapsed = event.receivedAt - this.displayed.shownAt;
      if (elapsed < this.displayed.duration) return true;
    }
    if (this.pending.length === 0) return false;
    const tail = this.pending[this.pending.length - 1];
    if (tail.state === event.state) return true;
    return false;
  }

  /**
   * Advance the queue. Called by the worker at a regular interval (e.g. 100ms).
   * Returns the next event to render, or null.
   */
  tick(now: number): StateEvent | null {
    if (this.displayed) {
      const elapsed = now - this.displayed.shownAt;
      if (elapsed < this.displayed.duration) return null;
      this.displayed = null;
    }
    const next = this.pending.shift();
    if (!next) return null;
    this.displayed = {
      state: next.state,
      duration: this.dwellFor(next),
      shownAt: now,
    };
    return next;
  }

  private dwellFor(event: StateEvent): number {
    if (this.opts.durationStates.has(event.state) && event.duration) {
      return Math.max(event.duration, this.opts.minDwellMs);
    }
    if (event.duration && event.duration > this.opts.minDwellMs) {
      return event.duration;
    }
    return this.opts.minDwellMs;
  }

  pendingLength(): number {
    return this.pending.length;
  }

  currentDisplayed(): DisplayedState | null {
    return this.displayed ? { ...this.displayed } : null;
  }
}
