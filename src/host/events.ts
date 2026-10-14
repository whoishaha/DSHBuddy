/**
 * DSH session/event → PetState state machine.
 *
 * Feeds on host-side `session/event` frames ({type, seq, time, data}) and
 * produces pet states + bubbles through a StateQueue (dwell/coalesce), so the
 * mascot doesn't pinball under rapid turn/step/tool traffic.
 */

import { StateQueue } from "./state-queue.js";
import { nextRunningVariant } from "./running-variant.js";
import { formatBubble, companionBubble, type BubbleEvent } from "./bubbles.js";

export type PetState =
  | "idle"
  | "running"
  | "running-left"
  | "running-right"
  | "waving"
  | "jumping"
  | "failed"
  | "review"
  | "waiting";

/** Proactive-care channel payload — v0.4 adds the escalation ladder metadata:
 *  gentle nudges ride the bubble channel, repeated / card-worthy cares open
 *  the 鲸灵 CareCard, and kind/reasonKey power explainability + snooze. */
export type CarePayload = {
  text: string;
  ts: number;
  /** Trigger identity (e.g. "rest-reminder"). */
  kind?: string;
  /** i18n suffix under client key `care.reason.*` explaining WHY this fired. */
  reasonKey?: string;
  /** bubble = pet-head bubble only; card = JingLing care card popup. */
  level?: "bubble" | "card";
  /** letter = burnout/wind-down long-form: sticky until dismissed, no TTL bar. */
  tone?: "normal" | "letter";
};

export type Snapshot = {
  state: PetState;
  bubble: string;
  /** Bubble should stay visible while true (busy states or proactive care). */
  bubblePersist: boolean;
  agentSource: string;
  updatedAt: number;
  /** Monotonic counter so the client can tell "new" from "re-polled". */
  counter: number;
  /** Latest proactive-caring message (shown above the pet, separate from status). */
  care: CarePayload | null;
};

/** States during which the status bubble stays visible continuously. */
export const BUBBLE_PERSIST_STATES = new Set([
  "running",
  "running-left",
  "running-right",
  "working",
  "jumping",
  "review",
  "waiting",
]);

/**
 * Formal state priority ladder (B1-1). When two sources disagree about what
 * the pet should show (event stream vs. agents-service poller), the higher
 * number wins: an approval ask must never be visually downgraded to "running"
 * by a stale observation, and a failure flash must survive a concurrent
 * tool-start event. Lower-priority sources simply no-op.
 */
export const STATE_PRIORITY: Record<PetState, number> = {
  waiting: 5,
  failed: 4,
  review: 3,
  running: 2,
  "running-left": 2,
  "running-right": 2,
  jumping: 2,
  waving: 1,
  idle: 0,
};

function priorityOf(state: string | undefined): number {
  if (!state) return 0;
  return (STATE_PRIORITY as Record<string, number>)[state] ?? 0;
}

export type StateSink = (snapshot: Snapshot) => void;

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "rg",
  "glob",
  "web_search",
  "websearch",
  "webfetch",
  "web_fetch",
  "list",
  "ls",
  "search",
]);

function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name.toLowerCase());
}

/** Parse a tool/result's model-facing text to detect an error signal. */
function toolResultHasError(data: {
  error?: { name?: string; code?: string };
  message?: unknown;
}): boolean {
  if (data.error) return true;
  const message = data.message as { is_error?: boolean; error?: unknown } | null | undefined;
  if (message && typeof message === "object") {
    if (message.is_error === true) return true;
    if (message.error != null) return true;
  }
  return false;
}

export class PetStateMachine {
  private queue = new StateQueue();
  private bubble = "";
  private care: CarePayload | null = null;
  private agentSource = "deepseek-harness";
  private counter = 0;
  private lastSnapshot: Snapshot | null = null;
  /** Track per-session error streak for the companion "comfort" bubble. */
  private errorStreak = 0;
  /** Track tool activity in the current turn for the "task done" celebration. */
  private turnToolCount = 0;
  private currentTurn = -1;
  /** Companion bubble cooldowns (ms timestamps). */
  private companionCooldowns = new Map<string, number>();
  private readonly companionCooldownMs = 5 * 60 * 1000;
  /** Debug/health counters (exposed via GET /debug). */
  private debug = {
    fedTotal: 0,
    fedByType: {} as Record<string, number>,
    lastFeedAt: 0,
    lastFeedType: "",
    emitted: 0,
    observedAccepted: 0,
    observedRejected: 0,
    startedAt: Date.now(),
  };

  constructor(private readonly sink: StateSink) {}

  private emit(state: PetState, bubble?: string, duration?: number) {
    const now = Date.now();
    this.debug.emitted += 1;
    const enqueueState = state === "running" ? nextRunningVariant() : state;
    this.queue.enqueue({
      state: enqueueState,
      duration,
      receivedAt: now,
    });
    if (bubble !== undefined) this.bubble = bubble;
    const displayed = this.queue.currentDisplayed();
    const snapshot: Snapshot = {
      state: displayed ? (displayed.state as PetState) : "idle",
      bubble: this.bubble,
      bubblePersist: BUBBLE_PERSIST_STATES.has(enqueueState),
      agentSource: this.agentSource,
      updatedAt: now,
      counter: ++this.counter,
      care: this.care,
    };
    this.lastSnapshot = snapshot;
    this.sink(snapshot);
  }

  /**
   * Show a bubble WITHOUT changing the pet state (used for proactive caring).
   * `persist` keeps it visible until the next regular event.
   */
  setBubble(text: string, persist = false) {
    this.bubble = text;
    const now = Date.now();
    const displayed = this.queue.currentDisplayed();
    const snapshot: Snapshot = {
      state: displayed ? (displayed.state as PetState) : "idle",
      bubble: this.bubble,
      bubblePersist: persist,
      agentSource: this.agentSource,
      updatedAt: now,
      counter: ++this.counter,
      care: this.care,
    };
    this.lastSnapshot = snapshot;
    this.sink(snapshot);
  }

  /**
   * Pop a proactive-caring message in a SEPARATE channel, so it shows above the
   * pet regardless of (and without clobbering) the status bubble. The client
   * displays it for a few seconds and then falls back to the status bubble.
   */
  setCare(text: string, meta?: Omit<CarePayload, "text" | "ts">) {
    this.care = { text, ts: Date.now(), ...meta };
    const now = Date.now();
    const displayed = this.queue.currentDisplayed();
    const snapshot: Snapshot = {
      state: displayed ? (displayed.state as PetState) : "idle",
      bubble: this.bubble,
      bubblePersist: BUBBLE_PERSIST_STATES.has(displayed?.state as string),
      agentSource: this.agentSource,
      updatedAt: now,
      counter: ++this.counter,
      care: this.care,
    };
    this.lastSnapshot = snapshot;
    this.sink(snapshot);
  }

  /** Drain the queue once (call on a 100ms tick). Returns the next state or null. */
  tick(): Snapshot | null {
    const next = this.queue.tick(Date.now());
    if (!next) return null;
    const snapshot: Snapshot = {
      state: next.state as PetState,
      bubble: this.bubble,
      bubblePersist: BUBBLE_PERSIST_STATES.has(next.state),
      agentSource: this.agentSource,
      updatedAt: Date.now(),
      counter: ++this.counter,
      care: this.care,
    };
    this.lastSnapshot = snapshot;
    this.sink(snapshot);
    return snapshot;
  }

  getSnapshot(): Snapshot {
    if (!this.lastSnapshot) {
      const now = Date.now();
      this.lastSnapshot = {
        state: "idle",
        bubble: this.bubble,
        bubblePersist: false,
        agentSource: this.agentSource,
        updatedAt: now,
        counter: 0,
        care: this.care,
      };
    }
    return { ...this.lastSnapshot };
  }

  /** Feed one host-side `session/event` frame. */
  feed(sessionId: string, event: { type: string; data?: Record<string, unknown> }) {
    const { type, data = {} } = event;
    // Debug bookkeeping (cheap; powers GET /debug health output).
    this.debug.fedTotal += 1;
    this.debug.fedByType[type] = (this.debug.fedByType[type] ?? 0) + 1;
    this.debug.lastFeedAt = Date.now();
    this.debug.lastFeedType = type;
    switch (type) {
      case "user/message": {
        const source = data.source as { kind?: string } | undefined;
        if (source?.kind === "user") {
          this.emit("jumping", "Thinking…", 800);
        }
        break;
      }
      case "turn/start": {
        this.currentTurn = (data.turn as number) ?? -1;
        this.turnToolCount = 0;
        this.emit("running");
        break;
      }
      case "step/start": {
        this.emit("running");
        break;
      }
      case "assistant/chunk": {
        this.emit("running");
        break;
      }
      case "tool/call": {
        const name = (data.name as string) ?? "tool";
        this.turnToolCount += 1;
        let toolInput: unknown;
        try {
          toolInput = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
        } catch {
          toolInput = undefined;
        }
        const bubble = formatBubble({
          kind: "tool",
          phase: "running",
          toolName: name,
          toolInput,
        });
        const state: PetState = isReadOnlyTool(name) ? "review" : "running";
        this.emit(state, bubble);
        break;
      }
      case "tool/result": {
        const failed = toolResultHasError(data as never);
        if (failed) {
          this.errorStreak += 1;
          if (this.errorStreak >= 2 && this.canCompanion("error")) {
            this.emit("failed", companionBubble("error-comfort"), 2500);
          } else {
            this.emit("failed", undefined, 2500);
          }
        } else {
          this.errorStreak = 0;
          const name = (data.name as string) ?? "tool";
          let toolInput: unknown;
          try {
            toolInput = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
          } catch {
            toolInput = undefined;
          }
          this.emit("idle", formatBubble({ kind: "tool", phase: "done", toolName: name, toolInput }));
        }
        break;
      }
      case "assistant/message": {
        if (data.interrupted === true) {
          this.emit("failed", undefined, 1500);
        } else {
          this.emit("waving", "Done.", 1500);
        }
        break;
      }
      case "step/end": {
        this.emit("idle");
        break;
      }
      case "turn/end": {
        const reason = data.reason as { kind?: string } | undefined;
        const kind = reason?.kind ?? "completed";
        if (kind === "error" || kind === "max-tokens") {
          this.emit("failed", undefined, 2000);
        } else if (kind === "aborted" || kind === "blocked" || kind === "interrupted") {
          this.emit("idle", undefined, 500);
        } else {
          // completed
          if (this.turnToolCount > 0 && this.canCompanion("done")) {
            this.emit("waving", companionBubble("task-done"), 1800);
          } else {
            this.emit("waving", "Done.", 1500);
          }
        }
        break;
      }
      case "session/end-seed":
      case "session/disposed": {
        this.emit("waving", "Done.", 1200);
        break;
      }
      case "approval/asked": {
        const toolName = (data.toolName as string) ?? "";
        this.emit("waiting", companionBubble("approval", toolName || undefined));
        break;
      }
      case "approval/decided": {
        const outcome = (data.outcome as string) ?? "allowed-once";
        if (outcome === "allowed-once") {
          this.emit("running");
        } else {
          this.emit("idle", undefined, 500);
        }
        break;
      }
      default:
        break;
    }
  }

  /** External signals (approval/question from mux frames or client hints). */
  signal(kind: "approval" | "question" | "idle", detail?: string) {
    if (kind === "idle") {
      this.emit("idle");
      return;
    }
    this.emit("waiting", companionBubble(kind, detail));
  }

  /**
   * Priority-guarded observation from the agents-service poller (B1-1).
   *
   * The poller sees ground truth about live agents (`agents.list()` statuses)
   * even when `session/event` frames never reach this plugin's bus — but it
   * knows LESS than the event stream (no review/waiting nuance, no bubbles),
   * so its voice is deliberately second-class:
   *   - a "running" observation only lands when the displayed state is idle-ish
   *     or the queue is empty (never downgrades waiting/failed/review);
   *   - an "idle" observation only calms a poller- or event-instigated busy
   *     state after real work signals have gone quiet for `busyQuietMs`.
   * Returns true when the observation changed the displayed state.
   */
  observe(observed: "running" | "idle", source: string, busyQuietMs = 4000): boolean {
    const displayed = this.queue.currentDisplayed();
    const cur = (displayed?.state as PetState | undefined) ?? "idle";

    if (observed === "running") {
      if (priorityOf(cur) > STATE_PRIORITY.running) {
        // waiting / failed / review outrank a bare "something is running".
        this.debug.observedRejected += 1;
        return false;
      }
      if (cur === "running" || cur === "running-left" || cur === "running-right") {
        this.debug.observedRejected += 1;
        return false; // already busy — no flap
      }
      // A queued transient (waving/jumping tail) shouldn't be trampled either.
      if (this.queue.pendingLength() > 0 && priorityOf(cur) >= STATE_PRIORITY.running) {
        this.debug.observedRejected += 1;
        return false;
      }
      const quietFor = Date.now() - Math.max(this.debug.lastFeedAt, 0);
      if (quietFor < busyQuietMs && priorityOf(cur) > STATE_PRIORITY.idle) {
        // Real events arrived recently and already describe the state better.
        this.debug.observedRejected += 1;
        return false;
      }
      this.agentSource = source;
      this.emit("running");
      this.debug.observedAccepted += 1;
      return true;
    }

    // observed === "idle": calm down only from busy states, never from
    // waiting/failed/review (those resolve through their own events).
    if (cur === "waiting" || cur === "failed" || cur === "review") {
      this.debug.observedRejected += 1;
      return false;
    }
    const busy = cur === "running" || cur === "running-left" || cur === "running-right";
    if (!busy) {
      this.debug.observedRejected += 1;
      return false;
    }
    if (Date.now() - this.lastObservedBusyAt < busyQuietMs) {
      this.debug.observedRejected += 1;
      return false; // grace period before calling work "gone"
    }
    this.emit("idle", undefined, 400);
    this.debug.observedAccepted += 1;
    return true;
  }

  /** Timestamp of the last poller observation that showed ≥1 running agent. */
  private lastObservedBusyAt = 0;
  /** Called by the watcher so the idle-grace clock is grounded in reality. */
  noteBusyObserved(): void {
    this.lastObservedBusyAt = Date.now();
  }

  /** Health/counters for GET /debug (state-machine half). */
  debugInfo() {
    return {
      ...this.debug,
      pendingStates: this.queue.pendingLength(),
      displayed: this.queue.currentDisplayed(),
      snapshot: this.getSnapshot(),
    };
  }

  private canCompanion(kind: string): boolean {
    const last = this.companionCooldowns.get(kind) ?? 0;
    if (Date.now() - last < this.companionCooldownMs) return false;
    this.companionCooldowns.set(kind, Date.now());
    return true;
  }
}
