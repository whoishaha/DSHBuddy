/**
 * Single DeepSeek Harness session statistics.
 *
 * Aggregates the host-side session/event stream (turns, steps, tool calls,
 * errors, approvals, questions, active duration) into per-session and per-day
 * buckets, persisted to ~/.petdex/runtime/stats.json with low-frequency batch
 * writes (1s merge).
 *
 * Beyond raw counts it also captures the "quality" and "rhythm" signals that
 * power the analytics dashboard:
 *   - turn outcomes (completed / aborted / failed) → completion rate
 *   - tools per turn → tool-chain length
 *   - error → recovery timings → MTTR (mean time to recovery)
 *   - 24h × 7-day USER-message heatmap → chronotype (your work intensity)
 *   - tool→tool transitions → workflow fingerprint
 *   - tool loop classification (research / coding / writing / debug / plan / orchestrate)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";

export type SessionStats = {
  sessionId: string;
  firstSeen: number;
  lastSeen: number;
  turns: number;
  steps: number;
  toolCalls: number;
  errors: number;
  errorRecovered: number;
  approvals: number;
  approved: number;
  rejected: number;
  questions: number;
  activeMs: number;
  tools: Record<string, number>;
};

export type DailyStats = {
  date: string;
  turns: number;
  steps: number;
  toolCalls: number;
  errors: number;
  approvals: number;
  questions: number;
  activeMs: number;
  /** Turn outcomes (from turn/end reason): completed / aborted / failed. */
  completedTurns: number;
  abortedTurns: number;
  failedTurns: number;
  /** Turns that used at least one tool (for average tool-chain length). */
  turnsWithTools: number;
  /** Error → recovery timing: sum of recovery durations + count (MTTR). */
  recoveryMs: number;
  recoveryCount: number;
  /** Completed pomodoro focus minutes (logged by the client timer). */
  pomoMin: number;
};

export type Rhythm = {
  /** [weekday 0=Sun..6=Sat][hour 0..23] → user-message count (lifetime cumulative). */
  weekdayHour: number[][];
  /** [hour 0..23] → user-message count (lifetime cumulative). */
  hourActivity: number[];
  /** Number of distinct active days (for averages). */
  activeDays: number;
  /**
   * Semantics marker: since v0.3.3 the rhythm counts USER messages only
   * (your work intensity), not agent tool calls. Older accumulations were
   * agent-weighted, so they are reset once on first load after upgrade.
   */
  userOnly?: boolean;
};

export type Stats = {
  sessions: Record<string, SessionStats>;
  days: Record<string, DailyStats>;
  rhythm: Rhythm;
  /** "fromTool>toTool" → count (workflow fingerprint). */
  transitions: Record<string, number>;
  /** loop label → count (research/coding/writing/debug/plan/orchestrate/other). */
  loops: Record<string, number>;
  updatedAt: number;
};

const STATS_PATH = join(RUNTIME_DIR, "stats.json");

function emptySession(sessionId: string): SessionStats {
  return {
    sessionId,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    turns: 0,
    steps: 0,
    toolCalls: 0,
    errors: 0,
    errorRecovered: 0,
    approvals: 0,
    approved: 0,
    rejected: 0,
    questions: 0,
    activeMs: 0,
    tools: {},
  };
}

function emptyRhythm(): Rhythm {
  return {
    weekdayHour: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    hourActivity: new Array(24).fill(0),
    activeDays: 0,
    userOnly: true,
  };
}

function today(): string {
  // Local date (matches how the user experiences "today") — the UTC variant
  // mis-bucketed evenings/nights into tomorrow for UTC+8 users.
  return localParts(Date.now()).date;
}

/** Local hour/date parts (not UTC — matches how the user experiences "today"). */
function localParts(ms: number): { date: string; weekday: number; hour: number } {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    weekday: d.getDay(),
    hour: d.getHours(),
  };
}

export class StatsCollector {
  private stats: Stats = {
    sessions: {},
    days: {},
    rhythm: emptyRhythm(),
    transitions: {},
    loops: {},
    updatedAt: Date.now(),
  };
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSince: number | null = null;
  /** per-session: last tool name (for transitions) */
  private lastTool = new Map<string, string>();
  /** per-session: current turn already used a tool */
  private turnHasTools = new Map<string, boolean>();
  /** per-session: timestamp of the last unrecovered error (for MTTR) */
  private pendingErrorAt = new Map<string, number>();

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (existsSync(STATS_PATH)) {
        const raw = JSON.parse(readFileSync(STATS_PATH, "utf8")) as Partial<Stats>;
        if (raw && typeof raw === "object") {
          this.stats.sessions = raw.sessions ?? {};
          this.stats.days = raw.days ?? {};
          this.stats.rhythm = { ...emptyRhythm(), ...(raw.rhythm ?? {}) };
          // Normalize a partially-shaped rhythm from older versions.
          if (!Array.isArray(this.stats.rhythm.weekdayHour)) this.stats.rhythm.weekdayHour = emptyRhythm().weekdayHour;
          if (!Array.isArray(this.stats.rhythm.hourActivity)) this.stats.rhythm.hourActivity = emptyRhythm().hourActivity;
          // One-time semantics migration: pre-v0.3.3 rhythms counted agent
          // tool calls; reset them so the heatmap starts clean as user-only.
          if (this.stats.rhythm.userOnly !== true) {
            this.stats.rhythm.weekdayHour = emptyRhythm().weekdayHour;
            this.stats.rhythm.hourActivity = emptyRhythm().hourActivity;
            this.stats.rhythm.userOnly = true;
          }
          this.stats.transitions = raw.transitions ?? {};
          this.stats.loops = raw.loops ?? {};
          this.stats.updatedAt = raw.updatedAt ?? Date.now();
        }
      }
    } catch {
      // corrupt file: start fresh
    }
  }

  /** Merge-save at most once per second. */
  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    const timer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      try {
        mkdirSync(RUNTIME_DIR, { recursive: true });
        this.stats.updatedAt = Date.now();
        writeFileSync(STATS_PATH, JSON.stringify(this.stats));
      } catch {
        // best-effort persistence
      }
    }, 1000);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.saveTimer = timer;
  }

  private bumpDay(date: string, key: keyof DailyStats, delta = 1) {
    const day = (this.stats.days[date] ??= emptyDay(date));
    (day as unknown as Record<string, number>)[key] =
      (((day as unknown as Record<string, number>)[key]) ?? 0) + delta;
  }

  /** Log a completed pomodoro focus round (minutes), clamped to sane bounds. */
  logPomodoro(minutes: number) {
    const min = Math.max(1, Math.min(180, Math.round(Number(minutes) || 0)));
    if (!Number.isFinite(min) || min < 1) return;
    this.bumpDay(today(), "pomoMin", min);
    this.scheduleSave();
  }

  /** Record a USER-message beat into the 24×7 rhythm heatmap (work intensity). */
  private bumpRhythm(ms: number) {
    const { date, weekday, hour } = localParts(ms);
    if (!this.stats.days[date]) this.stats.rhythm.activeDays += 1;
    const row = this.stats.rhythm.weekdayHour[weekday] ?? (this.stats.rhythm.weekdayHour[weekday] = new Array(24).fill(0));
    row[hour] = (row[hour] ?? 0) + 1;
    this.stats.rhythm.hourActivity[hour] = (this.stats.rhythm.hourActivity[hour] ?? 0) + 1;
  }

  feed(sessionId: string, event: { type: string; data?: Record<string, unknown>; time?: number }) {
    const now = event.time ?? Date.now();
    const sess = (this.stats.sessions[sessionId] ??= emptySession(sessionId));
    sess.lastSeen = now;

    switch (event.type) {
      case "user/message":
        if (this.activeSince === null) this.activeSince = now;
        // The rhythm heatmap measures YOUR output intensity — user messages
        // only. Agent turns/tool calls are counted in their own metrics.
        this.bumpRhythm(now);
        break;
      case "turn/start":
        sess.turns += 1;
        this.bumpDay(today(), "turns");
        this.turnHasTools.set(sessionId, false);
        break;
      case "step/start":
        sess.steps += 1;
        this.bumpDay(today(), "steps");
        break;
      case "tool/call": {
        sess.toolCalls += 1;
        this.bumpDay(today(), "toolCalls");
        const name = String(event.data?.name ?? "unknown");
        sess.tools[name] = (sess.tools[name] ?? 0) + 1;
        // tool-chain: mark this turn as using tools
        if (!this.turnHasTools.get(sessionId)) {
          this.turnHasTools.set(sessionId, true);
          this.bumpDay(today(), "turnsWithTools");
        }
        // workflow fingerprint: from-tool → to-tool transition
        const from = this.lastTool.get(sessionId);
        if (from) {
          const key = `${from}>${name}`;
          this.stats.transitions[key] = (this.stats.transitions[key] ?? 0) + 1;
        }
        this.lastTool.set(sessionId, name);
        // loop classification
        const loop = loopOfTool(name, event.data);
        this.stats.loops[loop] = (this.stats.loops[loop] ?? 0) + 1;
        break;
      }
      case "tool/result": {
        const failed = Boolean(
          event.data?.error ||
          (event.data?.message as { is_error?: boolean } | undefined)?.is_error,
        );
        if (failed) {
          sess.errors += 1;
          this.bumpDay(today(), "errors");
          this.pendingErrorAt.set(sessionId, now);
        } else {
          // success → possibly a recovery: measure MTTR
          const errAt = this.pendingErrorAt.get(sessionId);
          if (errAt !== undefined) {
            sess.errorRecovered += 1;
            this.pendingErrorAt.delete(sessionId);
            this.bumpDay(today(), "recoveryCount");
            this.bumpDay(today(), "recoveryMs", Math.max(0, now - errAt));
          }
        }
        break;
      }
      case "turn/end": {
        const kind = String((event.data?.reason as { kind?: string } | undefined)?.kind ?? "completed");
        if (kind === "completed") this.bumpDay(today(), "completedTurns");
        else if (kind === "aborted" || kind === "blocked" || kind === "interrupted") this.bumpDay(today(), "abortedTurns");
        else this.bumpDay(today(), "failedTurns"); // error / max-tokens
        if (this.activeSince !== null) {
          const dur = now - this.activeSince;
          sess.activeMs += dur;
          this.bumpDay(today(), "activeMs", dur);
          this.activeSince = null;
        }
        break;
      }
      default:
        break;
    }
    this.scheduleSave();
  }

  /** Approval / question counters (called from external signals). */
  recordDecision(kind: "approval" | "question", decision?: "approved" | "rejected") {
    const todayStr = today();
    const day = (this.stats.days[todayStr] ??= emptyDay(todayStr));
    if (kind === "approval") day.approvals += 1;
    else day.questions += 1;
    this.scheduleSave();
  }

  getStats(): Stats {
    return this.stats;
  }

  /** Summary line for the pet bubble / stats page. */
  summary(): { todayTurns: number; todayTools: number; totalSessions: number; todayActiveMs: number } {
    const day = this.stats.days[today()];
    return {
      todayTurns: day?.turns ?? 0,
      todayTools: day?.toolCalls ?? 0,
      totalSessions: Object.keys(this.stats.sessions).length,
      todayActiveMs: day?.activeMs ?? 0,
    };
  }

  /**
   * Derived quality metrics (design §A): error rate, success rate, completion
   * rate, MTTR and average tool-chain length.
   */
  efficiency(days: DailyStats[]): {
    errorRate: number;
    successRate: number;
    completionRate: number;
    mtbrMs: number | null;
    avgToolChain: number;
  } {
    const turns = days.reduce((s, d) => s + (d.turns ?? 0), 0);
    const completed = days.reduce((s, d) => s + (d.completedTurns ?? 0), 0);
    const toolCalls = days.reduce((s, d) => s + (d.toolCalls ?? 0), 0);
    const errors = days.reduce((s, d) => s + (d.errors ?? 0), 0);
    const turnsWithTools = days.reduce((s, d) => s + (d.turnsWithTools ?? 0), 0);
    const recoveryMs = days.reduce((s, d) => s + (d.recoveryMs ?? 0), 0);
    const recoveryCount = days.reduce((s, d) => s + (d.recoveryCount ?? 0), 0);
    return {
      errorRate: toolCalls > 0 ? errors / toolCalls : 0,
      successRate: toolCalls > 0 ? (toolCalls - errors) / toolCalls : 1,
      completionRate: turns > 0 ? completed / turns : 0,
      mtbrMs: recoveryCount > 0 ? recoveryMs / recoveryCount : null,
      avgToolChain: turnsWithTools > 0 ? toolCalls / turnsWithTools : 0,
    };
  }

  /** Chronotype from the 24-hour activity distribution (design §B). */
  chronotype(): {
    peakHour: number;
    earliestHour: number | null;
    latestHour: number | null;
    label: string;
    morningWeight: number;
    nightWeight: number;
  } {
    const h = this.stats.rhythm.hourActivity;
    let peakHour = 0;
    let peak = -1;
    let earliest: number | null = null;
    let latest: number | null = null;
    let morningWeight = 0;
    let nightWeight = 0;
    for (let i = 0; i < 24; i++) {
      const v = h[i] ?? 0;
      if (v > peak) {
        peak = v;
        peakHour = i;
      }
      if (v > 0) {
        if (earliest === null) earliest = i;
        latest = i;
      }
      if (i >= 5 && i <= 11) morningWeight += v;
      if (i >= 22 || i <= 4) nightWeight += v;
    }
    let label = "均衡型";
    if (nightWeight > morningWeight * 1.2 || (latest !== null && latest >= 23)) label = "夜猫子";
    else if (morningWeight > nightWeight * 1.2 || (earliest !== null && earliest <= 8)) label = "早鸟";
    return { peakHour, earliestHour: earliest, latestHour: latest, label, morningWeight, nightWeight };
  }
}

function emptyDay(date: string): DailyStats {
  return {
    date,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    errors: 0,
    approvals: 0,
    questions: 0,
    activeMs: 0,
    completedTurns: 0,
    abortedTurns: 0,
    failedTurns: 0,
    turnsWithTools: 0,
    recoveryMs: 0,
    recoveryCount: 0,
    pomoMin: 0,
  };
}

/** Pull a target file path out of a tool/call payload without serializing it. */
function pathHint(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "filename", "notebook_path"]) {
    const v = d[key];
    if (typeof v === "string" && v) return v;
  }
  const nested = d.input ?? d.args ?? d.params;
  if (nested && typeof nested === "object") return pathHint(nested);
  return "";
}

const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|cts|mts|py|pyw|rs|go|java|kt|kts|c|h|cpp|hpp|cc|cxx|cs|rb|php|swift|scala|vue|svelte|astro|sql|sh|bash|zsh|ps1|psm1|bat|cmd|lua|dart|r|jl|m|mm|groovy|gradle|proto|graphql|gql|tf|hcl|json|ya?ml|toml|ini|xml)$/i;
const DOC_EXT = /\.(md|mdx|txt|rst|adoc|tex|docx?|odt|pages|pdf|epub|csv)$/i;

/**
 * Classify a tool into one of the workflow loops (design §C).
 * `edit`/`write` are NOT necessarily prose — most of the time they change
 * CODE, so when a target file is visible in the payload we split by extension:
 * documents → "writing", everything else (code/config/unknown) → "coding".
 */
export function loopOfTool(name: string, detail?: unknown): string {
  const n = name.toLowerCase();
  if (RESEARCH.has(n)) return "research";
  if (DEBUGGING.has(n)) return "debug";
  if (PLANNING.has(n)) return "plan";
  if (ORCHESTRATING.has(n)) return "orchestrate";
  if (WRITING.has(n)) {
    const p = pathHint(detail);
    if (p && DOC_EXT.test(p)) return "writing";
    return "coding";
  }
  return "other";
}

const RESEARCH = new Set([
  "read", "grep", "rg", "glob", "web_search", "websearch", "webfetch", "web_fetch",
  "fetch", "list", "ls", "search", "browse", "job_output",
]);
const WRITING = new Set([
  "edit", "write", "apply_patch", "patch", "rename", "mv", "cp", "mkdir", "create",
]);
const DEBUGGING = new Set([
  "bash", "pwsh", "test", "tests", "jest", "pytest", "vitest", "run-tests",
  "typecheck", "tsc", "lint", "eslint", "debug", "fix", "doctor",
]);
const PLANNING = new Set(["todo_write", "plan", "exit_plan_mode", "skill"]);
const ORCHESTRATING = new Set([
  "subagent", "subagent_fork", "workflow", "send_message", "list_agents",
  "interrupt_agent", "job_kill", "job_list",
]);
