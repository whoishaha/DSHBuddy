import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";

export type PomodoroPhase = "work" | "break";
export type PomodoroStatus = "idle" | "running" | "paused";

export type PomodoroState = {
  phase: PomodoroPhase;
  status: PomodoroStatus;
  workMin: number;
  breakMin: number;
  remainingMs: number;
  endsAt: number | null;
  completedRounds: number;
  updatedAt: number;
};

const STATE_PATH = join(RUNTIME_DIR, "pomodoro.json");

function minutes(value: unknown, fallback: number, max: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(1, Math.min(max, n)) : fallback;
}

function initial(workMin = 25, breakMin = 5): PomodoroState {
  return {
    phase: "work",
    status: "idle",
    workMin,
    breakMin,
    remainingMs: workMin * 60_000,
    endsAt: null,
    completedRounds: 0,
    updatedAt: Date.now(),
  };
}

export class PomodoroEngine {
  private state: PomodoroState;
  onWorkComplete?: (minutes: number) => void;

  constructor(workMin = 25, breakMin = 5) {
    this.state = this.load(workMin, breakMin);
  }

  snapshot(): PomodoroState {
    this.tick();
    return { ...this.state };
  }

  start(workMin?: number, breakMin?: number): PomodoroState {
    this.configure(workMin, breakMin);
    if (this.state.status !== "running") {
      if (this.state.status === "idle") this.state.remainingMs = this.phaseDuration();
      this.state.status = "running";
      this.state.endsAt = Date.now() + Math.max(1, this.state.remainingMs);
      this.save();
    }
    return this.snapshot();
  }

  pause(): PomodoroState {
    this.tick();
    if (this.state.status === "running") {
      this.state.remainingMs = Math.max(0, (this.state.endsAt ?? Date.now()) - Date.now());
      this.state.status = "paused";
      this.state.endsAt = null;
      this.save();
    }
    return { ...this.state };
  }

  reset(workMin?: number, breakMin?: number): PomodoroState {
    this.configure(workMin, breakMin);
    this.state = { ...initial(this.state.workMin, this.state.breakMin), completedRounds: this.state.completedRounds };
    this.save();
    return { ...this.state };
  }

  updateDurations(workMin?: number, breakMin?: number): PomodoroState {
    this.configure(workMin, breakMin);
    if (this.state.status === "idle") this.state.remainingMs = this.phaseDuration();
    this.save();
    return { ...this.state };
  }

  tick(): void {
    if (this.state.status !== "running" || !this.state.endsAt) return;
    const now = Date.now();
    if (now < this.state.endsAt) {
      this.state.remainingMs = this.state.endsAt - now;
      return;
    }
    const completed = this.state.phase;
    if (completed === "work") {
      this.state.completedRounds += 1;
      this.onWorkComplete?.(this.state.workMin);
    }
    this.state.phase = completed === "work" ? "break" : "work";
    this.state.remainingMs = this.phaseDuration();
    this.state.endsAt = now + this.state.remainingMs;
    this.save();
  }

  private configure(workMin?: number, breakMin?: number): void {
    this.state.workMin = minutes(workMin, this.state.workMin, 180);
    this.state.breakMin = minutes(breakMin, this.state.breakMin, 60);
  }

  private phaseDuration(): number {
    return (this.state.phase === "work" ? this.state.workMin : this.state.breakMin) * 60_000;
  }

  private load(workMin: number, breakMin: number): PomodoroState {
    try {
      if (!existsSync(STATE_PATH)) return initial(workMin, breakMin);
      const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<PomodoroState>;
      const base = initial(minutes(raw.workMin, workMin, 180), minutes(raw.breakMin, breakMin, 60));
      return {
        ...base,
        phase: raw.phase === "break" ? "break" : "work",
        status: raw.status === "running" || raw.status === "paused" ? raw.status : "idle",
        remainingMs: Math.max(0, Number(raw.remainingMs) || base.remainingMs),
        endsAt: typeof raw.endsAt === "number" ? raw.endsAt : null,
        completedRounds: Math.max(0, Math.floor(Number(raw.completedRounds) || 0)),
        updatedAt: Number(raw.updatedAt) || Date.now(),
      };
    } catch {
      return initial(workMin, breakMin);
    }
  }

  private save(): void {
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
      this.state.updatedAt = Date.now();
      const tmp = `${STATE_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(tmp, STATE_PATH);
    } catch {
      // best effort persistence
    }
  }
}
