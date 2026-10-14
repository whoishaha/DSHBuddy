/**
 * GrowthEngine — DSH session event stream → XP / level / bond / mood /
 * energy / daily intensity.
 *
 * Event → XP rules, session decay, quality multipliers and the level curve
 * are implemented here. Persists to ~/.petdex/runtime/growth.json with
 * low-frequency batch writes.
 *
 * The engine also owns the milestone-ID registry (which milestones were
 * unlocked) so MemoryEngine can append human-readable milestone records
 * without duplicating them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";
import type { Career } from "./career.js";

export type Mood = "relaxed" | "focused" | "happy" | "waiting" | "frustrated" | "tired";
export type IntensityLevel = "quiet" | "normal" | "busy" | "intense" | "night_shift";

export const MOOD_LABELS: Record<Mood, string> = {
  relaxed: "relaxed",
  focused: "focused",
  happy: "happy",
  waiting: "waiting",
  frustrated: "frustrated",
  tired: "tired",
};

export const INTENSITY_LEVELS: { max: number; level: IntensityLevel }[] = [
  { max: 10, level: "quiet" },
  { max: 40, level: "normal" },
  { max: 100, level: "busy" },
  { max: 200, level: "intense" },
  { max: Infinity, level: "night_shift" },
];

export function intensityLevelOf(v: number): IntensityLevel {
  for (const bucket of INTENSITY_LEVELS) if (v <= bucket.max) return bucket.level;
  return "night_shift";
}

export type GrowthData = {
  level: number;
  xp: number;
  bond: number;
  mood: Mood;
  energy: number;
  today: string;
  dailyIntensity: number;
  streakDays: number;
  /** Best consecutive active-day streak ever reached (personal record). */
  bestStreak: number;
  lastActiveDay: string;
  tasksCompleted: number;
  errorsRecovered: number;
  totalApprovals: number;
  totalQuestions: number;
  totalSubagents: number;
  /** Cumulative head-pat intimacy (user-initiated affection). */
  intimacy: number;
  /** Local day string of the last petting (for the daily cap). */
  intimacyDay: string;
  /** Petting count today (cap: 20/day). */
  intimacyToday: number;
  firstSeen: number;
  /** date → daily intensity, for 7/30-day heatmaps. */
  intensityDays: Record<string, number>;
  /** date → errors recovered that day (for daily memory summaries). */
  recoveredDays: Record<string, number>;
  /** milestone ids already unlocked (dedupe registry). */
  unlockedMilestones: string[];
  /** B2-2 economy cheers: snack/toy effects last until these timestamps. */
  snackUntil: number;
  playUntil: number;
  /** B3-1 prestige (转生) count — lifetime, survives the XP reset. */
  prestigeCount: number;
  updatedAt: number;
};

/** Result of feeding one event into the growth engine. */
export type GrowthDelta = {
  /** Decayed + quality-scaled career XP deltas for CareerEngine to apply. */
  careerDeltas: Partial<Record<Career, number>>;
  /** Set when the pet leveled up during this event. */
  levelUp: number | null;
  /** Set when the day rolled over (from → to). */
  dayRollover: { from: string; to: string } | null;
  /** Newly unlocked milestone ids (GrowthEngine registry + MemoryEngine records). */
  milestones: string[];
};

const GROWTH_PATH = join(RUNTIME_DIR, "growth.json");

function dayStr(ts: number): string {
  // Local day (not UTC) — matches how the user experiences "today".
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultData(now: number): GrowthData {
  const today = dayStr(now);
  return {
    level: 1,
    xp: 0,
    bond: 0,
    mood: "relaxed",
    energy: 100,
    today,
    dailyIntensity: 0,
    streakDays: 0,
    bestStreak: 0,
    lastActiveDay: "",
    tasksCompleted: 0,
    errorsRecovered: 0,
    totalApprovals: 0,
    totalQuestions: 0,
    totalSubagents: 0,
    intimacy: 0,
    intimacyDay: "",
    intimacyToday: 0,
    firstSeen: now,
    intensityDays: {},
    recoveredDays: {},
    unlockedMilestones: [],
    snackUntil: 0,
    playUntil: 0,
    prestigeCount: 0,
    updatedAt: now,
  };
}

/** Level curve from the design doc: required_xp_for_next_level(level) = 30 × level^1.33. */
function needFor(level: number): number {
  return Math.round(30 * Math.pow(level, 1.33));
}

export function computeLevel(xp: number): { level: number; intoLevel: number; needNext: number } {
  let level = 1;
  let rem = Math.max(0, xp);
  for (;;) {
    const need = needFor(level);
    if (rem < need) break;
    rem -= need;
    level += 1;
  }
  return { level, intoLevel: rem, needNext: needFor(level) };
}

// ── tool / event classification (shared with CareerEngine mapping) ─────────

export const PLAN_TOOLS = new Set(["todo_write", "plan", "exit_plan_mode"]);
export const SUBAGENT_TOOLS = new Set([
  "subagent",
  "subagent_fork",
  "workflow",
  "send_message",
  "list_agents",
]);

export function isPlanEvent(type: string): boolean {
  return type.startsWith("plan") || type === "goal/created";
}

export function isPlanTool(name: string): boolean {
  return PLAN_TOOLS.has(name.toLowerCase());
}

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name.toLowerCase());
}

export function toolResultHasError(data: Record<string, unknown>): boolean {
  if (data.error) return true;
  const message = data.message as { is_error?: boolean; error?: unknown } | null | undefined;
  if (message && typeof message === "object") {
    if (message.is_error === true) return true;
    if (message.error != null) return true;
  }
  return false;
}

export function toolNameOf(data: Record<string, unknown>): string {
  return String(data.name ?? "tool");
}

export function reasonKindOf(data: Record<string, unknown>): string {
  return String((data.reason as { kind?: string } | undefined)?.kind ?? "completed");
}

// ── mood window helpers ─────────────────────────────────────────────────────

type MoodSample = { t: number; kind: "error" | "waiting" | "done" | "activity" };

const MOOD_WINDOW_MS = 10 * 60 * 1000;
const MOOD_MAX_SAMPLES = 60;

export class GrowthEngine {
  private data: GrowthData;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** sessionId → category → count, for session decay. */
  private sessionCounts = new Map<string, Map<string, number>>();
  /** sessionId → a tool/result error is waiting for recovery. */
  private pendingRecovery = new Map<string, boolean>();
  private lastEventAt = 0;
  private lastErrorAt = 0;
  private moodWindow: MoodSample[] = [];
  /** Fired when the pet levels up (client bubble + milestone). */
  onLevelUp: ((level: number) => void) | null = null;
  /** Fired when the local day rolls over (daily summary / career snapshot). */
  onDayRollover: ((from: string, to: string) => void) | null = null;

  constructor() {
    this.data = this.load();
  }

  private load(): GrowthData {
    try {
      if (existsSync(GROWTH_PATH)) {
        const raw = JSON.parse(readFileSync(GROWTH_PATH, "utf8")) as Partial<GrowthData>;
        return { ...defaultData(Date.now()), ...raw };
      }
    } catch {
      // corrupt file: start fresh
    }
    return defaultData(Date.now());
  }

  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    const timer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      try {
        mkdirSync(RUNTIME_DIR, { recursive: true });
        this.data.updatedAt = Date.now();
        writeFileSync(GROWTH_PATH, JSON.stringify(this.data));
      } catch {
        // best-effort persistence
      }
    }, 1000);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.saveTimer = timer;
  }

  getData(): GrowthData {
    return this.data;
  }

  /** Force an immediate write (called on shutdown signals / export). */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
      this.data.updatedAt = Date.now();
      writeFileSync(GROWTH_PATH, JSON.stringify(this.data));
    } catch {
      // best-effort
    }
  }

  /** Check for a day rollover without an event (called by the hourly timer). */
  checkDayRollover() {
    const now = Date.now();
    const today = dayStr(now);
    if (today !== this.data.today) this.rollDay(now);
  }

  private rollDay(now: number) {
    const from = this.data.today;
    const to = dayStr(now);
    if (from && this.data.intensityDays[from] === undefined) {
      this.data.intensityDays[from] = Math.round(this.data.dailyIntensity);
    }
    this.data.dailyIntensity = 0;
    this.data.today = to;
    this.data.energy = 100; // fresh day, energy restored (design: no punishment)
    this.scheduleSave();
    const onRoll = this.onDayRollover;
    if (onRoll) onRoll(from, to);
  }

  /** bump a per-session category counter; returns the count AFTER bump. */
  private bump(sessionId: string, cat: string): number {
    let map = this.sessionCounts.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessionCounts.set(sessionId, map);
    }
    const next = (map.get(cat) ?? 0) + 1;
    map.set(cat, next);
    return next;
  }

  /**
   * Grant XP with session decay + quality multiplier (design §3.3/§3.4).
   * Returns the decayed career deltas so CareerEngine applies identical values.
   */
  private grant(
    sessionId: string,
    cat: string,
    platform: number,
    careers: Partial<Record<Career, number>>,
    intensity: number,
    quality = 1,
  ): Partial<Record<Career, number>> {
    const count = this.bump(sessionId, cat); // 1st, 2nd, 3rd… event of this category
    // session_decay = 1/sqrt(count): 1st 100%, 2nd ≈70%, 6th ≈40%, 20th ≈22%.
    const decay = 1 / Math.sqrt(count);
    // Intensity decays softly (keeps the workload realistic): 1st 100%, 2nd ≈89%.
    const intDecay = 1 / Math.sqrt(1 + (count - 1) * 0.25);
    this.data.xp += platform * decay * quality;
    const deltas: Partial<Record<Career, number>> = {};
    for (const [career, v] of Object.entries(careers)) {
      const amount = (v as number) * decay * quality;
      deltas[career as Career] = (deltas[career as Career] ?? 0) + amount;
    }
    this.data.dailyIntensity += intensity * intDecay;
    this.scheduleSave();
    return deltas;
  }

  private unlockMilestone(id: string, out: string[]) {
    if (this.data.unlockedMilestones.includes(id)) return;
    this.data.unlockedMilestones.push(id);
    if (this.data.unlockedMilestones.length > 200) this.data.unlockedMilestones.splice(0, this.data.unlockedMilestones.length - 200);
    out.push(id);
  }

  private trackStreak(now: number) {
    const today = dayStr(now);
    if (today === this.data.lastActiveDay) return;
    const yesterday = dayStr(now - 24 * 3600 * 1000);
    this.data.streakDays = this.data.lastActiveDay === yesterday ? this.data.streakDays + 1 : 1;
    this.data.lastActiveDay = today;
    if (this.data.streakDays > this.data.bestStreak) this.data.bestStreak = this.data.streakDays;
  }

  /** Unlock milestones driven by aggregate thresholds (called after each feed). */
  private checkThresholdMilestones(out: string[]) {
    if (this.data.dailyIntensity > 100) this.unlockMilestone("intensity-100", out);
    if (this.data.dailyIntensity > 240) this.unlockMilestone("intensity-240", out);
    if (this.data.streakDays >= 7) this.unlockMilestone("streak-7", out);
    if (this.data.streakDays >= 30) this.unlockMilestone("streak-30", out);
  }

  /** Intimacy thresholds that unlock a celebratory milestone. */
  static INTIMACY_MILESTONES = [10, 50, 100, 200, 500];

  /**
   * Pet the pet's head: +1 intimacy, at most 20 pats per local day.
   * Returns updated totals and — when a threshold is exactly reached — the
   * milestone value for the caller to announce.
   */
  petHead(): { intimacy: number; today: number; milestone: number | null } {
    const today = dayStr(Date.now());
    if (this.data.intimacyDay !== today) {
      this.data.intimacyDay = today;
      this.data.intimacyToday = 0;
    }
    let milestone: number | null = null;
    if (this.data.intimacyToday < 20) {
      this.data.intimacyToday += 1;
      this.data.intimacy += 1;
      if ((GrowthEngine.INTIMACY_MILESTONES as number[]).includes(this.data.intimacy)) {
        milestone = this.data.intimacy;
      }
      this.scheduleSave();
    }
    return { intimacy: this.data.intimacy, today: this.data.intimacyToday, milestone };
  }

  /** Feed one host-side session/event frame; returns decayed deltas + events. */
  feed(sessionId: string, event: { type: string; data?: Record<string, unknown>; time?: number }): GrowthDelta {
    const now = event.time ?? Date.now();
    this.lastEventAt = now;
    this.trackStreak(now);
    if (dayStr(now) !== this.data.today) this.rollDay(now);

    const { type, data = {} } = event;
    const out: GrowthDelta = { careerDeltas: {}, levelUp: null, dayRollover: null, milestones: [] };
    const deltas: Partial<Record<Career, number>> = {};

    const add = (
      cat: string,
      platform: number,
      careers: Partial<Record<Career, number>>,
      intensity: number,
      quality = 1,
    ) => {
      const d = this.grant(sessionId, cat, platform, careers, intensity, quality);
      for (const [k, v] of Object.entries(d)) deltas[k as Career] = (deltas[k as Career] ?? 0) + (v as number);
    };

    switch (type) {
      case "user/message": {
        const source = data.source as { kind?: string } | undefined;
        if (source?.kind !== "user") break;
        this.moodWindow.push({ t: now, kind: "activity" });
        break;
      }
      case "turn/start":
        // XP is granted at turn/end with the quality multiplier (aborted ×0);
        // the work intensity still counts immediately.
        this.grant(sessionId, "turn-intent", 0, {}, 1);
        break;
      case "step/start":
        add("step", 0.1, {}, 1);
        break;
      case "tool/call": {
        const name = toolNameOf(data);
        const careers = careerForTool(name);
        add("tool", 0.1, careers, 1);
        if (isPlanTool(name) || isPlanEvent(type)) {
          add("plan", 1.0, { architect: 1.2 }, 2);
          this.moodWindow.push({ t: now, kind: "activity" });
        } else if (isSubagentTool(name)) {
          add("subagent", 1.3, { operator: 1.2 }, 3);
          this.data.totalSubagents += 1;
          this.unlockMilestone("first-subagent", out.milestones);
          this.moodWindow.push({ t: now, kind: "activity" });
        } else {
          this.moodWindow.push({ t: now, kind: "activity" });
        }
        break;
      }
      case "tool/result": {
        const failed = toolResultHasError(data);
        if (failed) {
          this.pendingRecovery.set(sessionId, true);
          this.lastErrorAt = now;
          add("tool-error", 0.2, { debugger: 0.6 }, 0, 0.3); // failed-not-recovered ×0.3
          this.moodWindow.push({ t: now, kind: "error" });
        } else {
          if (this.pendingRecovery.get(sessionId)) {
            this.pendingRecovery.set(sessionId, false);
            this.data.errorsRecovered += 1;
            this.data.recoveredDays[dayStr(now)] = (this.data.recoveredDays[dayStr(now)] ?? 0) + 1;
            add("recovery", 1.0, { debugger: 1.2 }, 2, 1.1); // error → recovered ×1.1
            this.unlockMilestone("first-recovery", out.milestones);
            this.moodWindow.push({ t: now, kind: "done" });
          } else {
            add("tool-success", 0.5, {}, 0);
          }
        }
        break;
      }
      case "assistant/message":
        add("assistant", 0.3, {}, 0);
        break;
      case "approval/asked":
        add("approval", 0.6, { reviewer: 0.8 }, 1);
        this.data.totalApprovals += 1;
        this.moodWindow.push({ t: now, kind: "waiting" });
        break;
      case "approval/decided": {
        const outcome = String(data.outcome ?? "");
        const approved = outcome === "allowed-once" || outcome === "allow-always" || outcome === "approved";
        if (approved) {
          // user confirmed → ×1.2 confirmation bonus
          add("approval-decided", 0.12, { reviewer: 0.16 }, 0, 1.2);
          this.data.bond += 0.2;
        } else {
          this.data.bond += 0.05;
        }
        break;
      }
      case "question/requested":
        add("question", 0.4, { reviewer: 0.5 }, 1);
        this.data.totalQuestions += 1;
        this.moodWindow.push({ t: now, kind: "waiting" });
        break;
      case "question/resolved":
        this.data.bond += 0.2;
        break;
      case "turn/end": {
        const kind = reasonKindOf(data);
        if (kind === "completed") {
          add("turn", 0.1, {}, 0, 1.0); // completed ×1.0
          this.data.tasksCompleted += 1;
          this.data.bond += 0.1;
          this.unlockMilestone("first-task", out.milestones);
          this.moodWindow.push({ t: now, kind: "done" });
        } else if (kind === "error" || kind === "max-tokens") {
          add("turn", 0.1, {}, 0, 0.3); // failed-not-recovered ×0.3
        }
        // aborted/blocked/interrupted → ×0 (XP dropped)
        break;
      }
      default:
        if (isPlanEvent(type)) {
          add("plan", 1.0, { architect: 1.2 }, 2);
          this.moodWindow.push({ t: now, kind: "activity" });
        }
        break;
    }

    // Level-up detection (design §3.5: derived from cumulative XP).
    const { level } = computeLevel(this.data.xp);
    if (level > this.data.level) {
      this.data.level = level;
      out.levelUp = level;
      for (const target of [5, 10, 20, 50]) {
        if (level >= target) this.unlockMilestone(`level-${target}`, out.milestones);
      }
      const onUp = this.onLevelUp;
      if (onUp) onUp(level);
    }

    // Mood from the recent 10-minute window (design §3.6).
    this.recomputeMood(now);

    // Energy: max(20, 100 − daily_intensity × 0.25), +15 while a snack/toy
    // cheer is active; never below 20, never above 100.
    this.data.energy = this.computeEnergy(now);
    this.data.updatedAt = now;

    out.careerDeltas = deltas;
    this.checkThresholdMilestones(out.milestones);
    this.scheduleSave();
    return out;
  }

  private recomputeMood(now: number) {
    const cutoff = now - MOOD_WINDOW_MS;
    while (this.moodWindow.length && this.moodWindow[0].t < cutoff) this.moodWindow.shift();
    if (this.moodWindow.length > MOOD_MAX_SAMPLES) this.moodWindow.splice(0, this.moodWindow.length - MOOD_MAX_SAMPLES);

    const errs = this.moodWindow.filter((s) => s.kind === "error").length;
    const wait = this.moodWindow.some((s) => s.kind === "waiting");
    const done = this.moodWindow.filter((s) => s.kind === "done").length;
    const active = now - this.lastEventAt < 60 * 1000;
    // B2-2 economy cheer: a fresh snack/toy lifts the mood floor — bad days
    // soften to "happy" while it lasts. It never masks a waiting state.
    const cheered = now < this.data.snackUntil || now < this.data.playUntil;

    let mood: Mood = "relaxed";
    if (errs >= 2) mood = cheered ? "happy" : "frustrated";
    else if (wait && !cheered) mood = "waiting";
    else if (this.data.dailyIntensity > 100 && !cheered) mood = "tired";
    else if (done >= 2 || cheered) mood = "happy";
    else if (active) mood = "focused";
    this.data.mood = mood;
  }

  /** Energy with the economy-cheer bonus applied (base formula unchanged). */
  private computeEnergy(now: number): number {
    const base = Math.max(20, Math.round(100 - this.data.dailyIntensity * 0.25));
    const cheered = now < this.data.snackUntil || now < this.data.playUntil ? 15 : 0;
    return Math.min(100, base + cheered);
  }

  /**
   * B2-2: consume a shop item's effect. Snacks cheer for 30 min (+15 energy),
   * toys for 20 min. The cheer window persists in growth.json so a restart
   * doesn't waste a purchase.
   */
  applyItem(kind: "snack" | "toy"): { cheeredMs: number } {
    const now = Date.now();
    const add = kind === "snack" ? 30 * 60 * 1000 : 20 * 60 * 1000;
    const field = kind === "snack" ? ("snackUntil" as const) : ("playUntil" as const);
    this.data[field] = Math.max(now, this.data[field]) + add;
    this.recomputeMood(now);
    this.data.energy = this.computeEnergy(now);
    this.scheduleSave();
    return { cheeredMs: add };
  }

  /** Minimum level before prestige (转生) is allowed. */
  static PRESTIGE_MIN_LEVEL = 30;

  /**
   * B3-1 prestige: reset the XP curve while keeping everything the user
   * EARNED — achievements (separate engine), intimacy, streak, lifetime
   * counters, coins. Only the level/xp numbers start over; prestigeCount
   * marks the whale as a reborn one.
   */
  prestige(): boolean {
    if (this.data.level < GrowthEngine.PRESTIGE_MIN_LEVEL) return false;
    this.data.prestigeCount += 1;
    this.data.xp = 0;
    this.data.level = 1;
    this.recomputeMood(Date.now());
    this.scheduleSave();
    return true;
  }

  /** Snapshot summary for the floater / growth tab (cheap to compute). */
  growthSummary() {
    const { level, intoLevel, needNext } = computeLevel(this.data.xp);
    return {
      level,
      prestigeCount: this.data.prestigeCount,
      xp: Math.round(this.data.xp),
      levelProgress: needNext > 0 ? Math.min(1, intoLevel / needNext) : 1,
      needNext,
      bond: Math.round(this.data.bond * 10) / 10,
      mood: this.data.mood,
      energy: this.data.energy,
      intensity: Math.round(this.data.dailyIntensity),
      intensityLevel: intensityLevelOf(this.data.dailyIntensity),
      streakDays: this.data.streakDays,
      bestStreak: this.data.bestStreak,
      tasksCompleted: this.data.tasksCompleted,
      errorsRecovered: this.data.errorsRecovered,
      totalApprovals: this.data.totalApprovals,
      totalQuestions: this.data.totalQuestions,
      totalSubagents: this.data.totalSubagents,
      intimacy: this.data.intimacy,
      firstSeen: this.data.firstSeen,
      intensityDays: this.data.intensityDays,
      recoveredDays: this.data.recoveredDays,
    };
  }
}

/** Career mapping for ordinary tool calls (design §4.1). */
export function careerForTool(name: string): Partial<Record<Career, number>> {
  const n = name.toLowerCase();
  if (PLAN_TOOLS.has(n)) return { architect: 1.2 };
  if (SUBAGENT_TOOLS.has(n)) return { operator: 1.2 };
  if (RESEARCH_TOOLS.has(n)) return { researcher: 1.2 };
  if (DEBUG_TOOLS.has(n)) return { debugger: 1.2 };
  if (BUILD_TOOLS.has(n)) return { builder: 1.2 };
  if (REVIEW_TOOLS.has(n)) return { reviewer: 1.2 };
  return { builder: 0.6 }; // generic tools lean builder (they get the job done)
}

const BUILD_TOOLS = new Set([
  "edit",
  "write",
  "bash",
  "pwsh",
  "apply_patch",
  "patch",
  "rename",
  "mv",
  "cp",
  "mkdir",
  "create",
]);
const DEBUG_TOOLS = new Set([
  "test",
  "tests",
  "jest",
  "pytest",
  "vitest",
  "run-tests",
  "typecheck",
  "tsc",
  "lint",
  "eslint",
  "debug",
  "fix",
  "doctor",
]);
const RESEARCH_TOOLS = new Set([
  "read",
  "grep",
  "rg",
  "glob",
  "web_search",
  "websearch",
  "webfetch",
  "web_fetch",
  "fetch",
  "list",
  "ls",
  "search",
  "pdf",
  "extract",
  "job_output",
  "browse",
]);
const REVIEW_TOOLS = new Set([
  "review",
  "code-review",
  "approve",
  "approval",
  "audit",
]);
