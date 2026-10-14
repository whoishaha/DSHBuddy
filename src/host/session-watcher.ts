/**
 * SessionWatcher — B1-1 state-awareness reliability net.
 *
 * The event-driven PetStateMachine is authoritative when `session/event`
 * frames reach this plugin's bus, but on some deployments dynamically-loaded
 * plugins never receive them (observed in the wild by kun-like-pet). This
 * watcher polls the host `agents` service directly — an in-memory registry
 * read (`agents.list()` → per-agent `status: 'idle' | 'running'`) — and feeds
 * the result to the machine through its PRIORITY-GUARDED `observe()` door, so
 * a poller observation can fill gaps but never downgrade a real waiting /
 * failed / review state.
 *
 * Everything is defensive: the service may be absent, shaped differently, or
 * disposed mid-poll. Any surprise counts as one skipped poll.
 */

export type WatchedAgent = {
  id: string;
  status: "running" | "idle";
  /** Working directory from the session header (best effort). */
  cwd: string | null;
  /** True for subagent children (`header.origin === 'subagent'`). */
  isSubagent: boolean;
};

export type WatchObservation = {
  at: number;
  total: number;
  runningCount: number;
  subRunningCount: number;
  /** Longest an agent has been continuously seen running (0 when none). */
  longestRunningMs: number;
  agents: WatchedAgent[];
};

/** Minimal structural shape we need from a live agent (all optional-safe). */
type AgentLike = {
  id?: unknown;
  status?: unknown;
  session?: { header?: { cwd?: unknown; origin?: unknown } | null } | null;
};

export type WatcherHealth = {
  /** False while the agents service is absent or unreadable. */
  available: boolean;
  startedAt: number;
  lastPollAt: number;
  polls: number;
  errors: number;
  lastError: string;
  intervalMs: number;
  lastObservation: WatchObservation | null;
};

const DEFAULT_INTERVAL_MS = 600;

function asString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export class SessionWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** agent id → first poll it was seen running (drives longestRunningMs). */
  private runningSince = new Map<string, number>();
  private health: WatcherHealth = {
    available: false,
    startedAt: 0,
    lastPollAt: 0,
    polls: 0,
    errors: 0,
    lastError: "",
    intervalMs: DEFAULT_INTERVAL_MS,
    lastObservation: null,
  };

  constructor(
    private readonly opts: {
      /** Resolve live agents; null/undefined = service unavailable right now. */
      listAgents: () => readonly unknown[] | null | undefined;
      /** Priority-guarded sink (PetStateMachine.observe / noteBusyObserved). */
      onObservation: (obs: WatchObservation) => void;
      intervalMs?: number;
    },
  ) {
    if (opts.intervalMs && opts.intervalMs >= 200) this.health.intervalMs = opts.intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.health.startedAt = Date.now();
    this.poll(); // first pass immediately
    this.timer = setInterval(() => this.poll(), this.health.intervalMs);
    void this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  healthInfo(): WatcherHealth {
    return { ...this.health };
  }

  private poll(): void {
    this.health.lastPollAt = Date.now();
    let raw: readonly unknown[] | null | undefined;
    try {
      raw = this.opts.listAgents();
    } catch (err) {
      this.health.errors += 1;
      this.health.available = false;
      this.health.lastError = String((err as Error)?.message ?? err);
      return;
    }
    if (!Array.isArray(raw)) {
      // Service not present (yet) — stay quiet, stay marked unavailable.
      this.health.available = false;
      return;
    }
    this.health.polls += 1;
    this.health.available = true;
    this.health.lastError = "";

    const agents: WatchedAgent[] = [];
    for (const a of raw as readonly AgentLike[]) {
      const status = a?.status === "running" ? "running" : "idle";
      agents.push({
        id: asString(a?.id) ?? `agent-${agents.length}`,
        status,
        cwd: asString(a?.session?.header?.cwd),
        isSubagent: a?.session?.header?.origin === "subagent",
      });
    }
    // Track continuous running stretches: stamp first sight, drop agents that
    // went idle (a re-run starts a fresh stretch).
    const now = Date.now();
    for (const a of agents) {
      if (a.status === "running") {
        if (!this.runningSince.has(a.id)) this.runningSince.set(a.id, now);
      } else {
        this.runningSince.delete(a.id);
      }
    }
    let longestRunningMs = 0;
    for (const since of this.runningSince.values()) {
      longestRunningMs = Math.max(longestRunningMs, now - since);
    }
    const obs: WatchObservation = {
      at: now,
      total: agents.length,
      runningCount: agents.filter((a) => a.status === "running").length,
      subRunningCount: agents.filter((a) => a.status === "running" && a.isSubagent).length,
      longestRunningMs,
      agents,
    };
    this.health.lastObservation = obs;
    try {
      this.opts.onObservation(obs);
    } catch {
      // machine sink failure must never kill the poll loop
    }
  }
}
