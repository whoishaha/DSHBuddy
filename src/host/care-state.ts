/**
 * CareState — tiny runtime JSON store (~/.petdex/runtime/care-state.json) for
 * companion-v2 bookkeeping that is neither user preference (→ config) nor
 * user-facing narrative (→ memory.json): one-shot care keys already delivered
 * (anniversaries), and cross-restart frequency anchors for the relational
 * checkers (echo recall / weekday pattern).
 *
 * Same durability contract as the other runtime stores: best-effort atomic
 * enough writes, missing/corrupt file falls back to defaults.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";

export type CareStateData = {
  /** One-shot care keys already delivered (e.g. "anni-30", "tools-1000"). */
  seenKeys: string[];
  /** Day string of the last echo-recall fire (cross-restart ≥3d spacing). */
  lastEchoDay: string | null;
  /** Day string of the last weekday-pattern observation (≥6d spacing). */
  lastPatternDay: string | null;
  /** v0.4 D3 snooze learning: kind → recent snooze timestamps (rolling 14d). */
  snooze: Record<string, number[]>;
  /** v0.4 E1 dates whose activity ran past 23:00 (rolling window, burnout input). */
  lateDays: string[];
};

function emptyData(): CareStateData {
  return { seenKeys: [], lastEchoDay: null, lastPatternDay: null, snooze: {}, lateDays: [] };
}

const CARE_STATE_PATH = join(RUNTIME_DIR, "care-state.json");

export class CareState {
  private data: CareStateData;

  constructor() {
    this.data = this.load();
  }

  private load(): CareStateData {
    try {
      if (existsSync(CARE_STATE_PATH)) {
        const raw = JSON.parse(readFileSync(CARE_STATE_PATH, "utf8")) as Partial<CareStateData>;
        return {
          seenKeys: Array.isArray(raw.seenKeys) ? raw.seenKeys.filter((k) => typeof k === "string") : [],
          lastEchoDay: typeof raw.lastEchoDay === "string" ? raw.lastEchoDay : null,
          lastPatternDay: typeof raw.lastPatternDay === "string" ? raw.lastPatternDay : null,
          snooze: this.pruneSnooze(raw.snooze ?? {}),
          lateDays: this.pruneLateDays(raw.lateDays ?? []),
        };
      }
    } catch {
      // fall through to defaults
    }
    return emptyData();
  }

  private save() {
    try {
      this.data.snooze = this.pruneSnooze(this.data.snooze);
      this.data.lateDays = this.pruneLateDays(this.data.lateDays);
      writeFileSync(CARE_STATE_PATH, JSON.stringify(this.data));
    } catch {
      // best-effort — a lost anchor at worst re-fires one low-frequency care
    }
  }

  /** Late-day markers older than 21 days stop mattering — drop them. */
  private pruneLateDays(list: string[]): string[] {
    const cutoffMs = Date.now() - 21 * 24 * 3600 * 1000;
    return (Array.isArray(list) ? list : []).filter((day) => {
      if (typeof day !== "string") return false;
      const ts = new Date(`${day}T12:00:00`).getTime();
      return Number.isFinite(ts) && ts >= cutoffMs;
    });
  }

  /** Rolling 14-day window — old snoozes are forgotten, the pet forgives. */
  private pruneSnooze(snooze: Record<string, number[]>): Record<string, number[]> {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    const out: Record<string, number[]> = {};
    for (const [kind, list] of Object.entries(snooze)) {
      const kept = Array.isArray(list) ? list.filter((ts) => typeof ts === "number" && ts >= cutoff) : [];
      if (kept.length > 0) out[kind] = kept;
    }
    return out;
  }

  has(key: string): boolean {
    return this.data.seenKeys.includes(key);
  }

  mark(key: string) {
    if (this.data.seenKeys.includes(key)) return;
    this.data.seenKeys.push(key);
    this.save();
  }

  getLastDay(key: "echo" | "pattern"): string | null {
    return key === "echo" ? this.data.lastEchoDay : this.data.lastPatternDay;
  }

  setLastDay(key: "echo" | "pattern", day: string) {
    if (key === "echo") this.data.lastEchoDay = day;
    else this.data.lastPatternDay = day;
    this.save();
  }

  /** v0.4 D3 — record one 「晚点再说」and return the rolling count. */
  recordSnooze(kind: string): number {
    const list = this.data.snooze[kind] ?? [];
    list.push(Date.now());
    this.data.snooze[kind] = list;
    this.save();
    return list.length;
  }

  snoozeCount(kind: string): number {
    return this.pruneSnooze(this.data.snooze)[kind]?.length ?? 0;
  }

  /** v0.4 E1 — record that activity on `day` ran past 23:00. */
  markLateDay(day: string) {
    if (this.data.lateDays.includes(day)) return;
    this.data.lateDays.push(day);
    this.save();
  }

  lateDayCount(): number {
    return this.data.lateDays.length;
  }

  lateDaysList(): string[] {
    return [...this.data.lateDays];
  }
}
