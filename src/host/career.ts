/**
 * CareerEngine — six-career evolution (design doc §4).
 *
 * CareerEngine only ACCUMULATES the decayed/quality-scaled career XP that
 * GrowthEngine already computed (so the session-decay formula lives in exactly
 * one place). It derives:
 *   - historical primary/secondary  (lifetime career XP)
 *   - recent primary/secondary      (last 7 days career XP deltas)
 *   - primary/secondary/title       (Recent when data is sufficient, else Historical)
 *   - daily snapshots (career evolution timeline)
 *
 * Persists to ~/.petdex/runtime/career.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";

export type Career = "builder" | "debugger" | "researcher" | "reviewer" | "architect" | "operator";

export const CAREERS: Career[] = [
  "builder",
  "debugger",
  "researcher",
  "reviewer",
  "architect",
  "operator",
];

export const CAREER_LABELS: Record<Career, string> = {
  builder: "构建者",
  debugger: "调试者",
  researcher: "研究者",
  reviewer: "审查者",
  architect: "架构师",
  operator: "调度者",
};

export const CAREER_EN: Record<Career, string> = {
  builder: "Builder",
  debugger: "Debugger",
  researcher: "Researcher",
  reviewer: "Reviewer",
  architect: "Architect",
  operator: "Operator",
};

/** 双职业称号表（设计 §4.3，主+副 → 称号）。 */
export const TITLE_MAP: Record<string, string> = {
  "builder+debugger": "Patch Smith",
  "builder+architect": "System Crafter",
  "researcher+reviewer": "Fact Checker",
  "researcher+architect": "Knowledge Architect",
  "reviewer+operator": "Gatekeeper",
  "debugger+operator": "Incident Commander",
  "architect+operator": "Orchestrator",
};

type CareerSnapshot = {
  date: string;
  xp: Record<Career, number>;
  primary: Career | null;
  secondary: Career | null;
  title: string | null;
};

export type CareerData = {
  xp: Record<Career, number>;
  /** date → career XP gained that day (for "recent 7 days"). */
  daily: Record<string, Partial<Record<Career, number>>>;
  historicalPrimary: Career | null;
  recentPrimary: Career | null;
  primary: Career | null;
  secondary: Career | null;
  title: string | null;
  snapshots: CareerSnapshot[];
  updatedAt: number;
};

const CAREER_PATH = join(RUNTIME_DIR, "career.json");

function emptyXp(): Record<Career, number> {
  return { builder: 0, debugger: 0, researcher: 0, reviewer: 0, architect: 0, operator: 0 };
}

function emptyData(): CareerData {
  return {
    xp: emptyXp(),
    daily: {},
    historicalPrimary: null,
    recentPrimary: null,
    primary: null,
    secondary: null,
    title: null,
    snapshots: [],
    updatedAt: Date.now(),
  };
}

export function careerTitleFor(primary: Career | null, secondary: Career | null): string | null {
  if (!primary || !secondary || primary === secondary) return null;
  return TITLE_MAP[`${primary}+${secondary}`] ?? null;
}

export class CareerEngine {
  private data: CareerData;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.data = this.load();
    this.recompute();
  }

  private load(): CareerData {
    try {
      if (existsSync(CAREER_PATH)) {
        const raw = JSON.parse(readFileSync(CAREER_PATH, "utf8")) as Partial<CareerData>;
        const base = emptyData();
        base.xp = { ...base.xp, ...(raw.xp ?? {}) };
        base.daily = raw.daily ?? {};
        base.snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
        base.updatedAt = raw.updatedAt ?? Date.now();
        return base;
      }
    } catch {
      // corrupt file: start fresh
    }
    return emptyData();
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
        writeFileSync(CAREER_PATH, JSON.stringify(this.data));
      } catch {
        // best-effort
      }
    }, 1000);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.saveTimer = timer;
  }

  getData(): CareerData {
    return this.data;
  }

  /** Apply the decayed career XP deltas computed by GrowthEngine. */
  applyDeltas(deltas: Partial<Record<Career, number>>, now = Date.now()) {
    const today = dayStr(now);
    for (const [career, v] of Object.entries(deltas)) {
      const amount = (v as number) ?? 0;
      if (amount <= 0) continue;
      const c = career as Career;
      this.data.xp[c] = (this.data.xp[c] ?? 0) + amount;
      const day = (this.data.daily[today] ??= {});
      day[c] = (day[c] ?? 0) + amount;
    }
    this.recompute();
    this.scheduleSave();
  }

  /** Snapshot today's career state (called at day rollover). */
  snapshotDay(date: string) {
    const primary = this.data.primary;
    const secondary = this.data.secondary;
    this.data.snapshots.push({
      date,
      xp: { ...this.data.xp },
      primary,
      secondary,
      title: this.data.title,
    });
    if (this.data.snapshots.length > 400) this.data.snapshots.splice(0, this.data.snapshots.length - 400);
    this.scheduleSave();
  }

  private recompute() {
    const hist = top2(this.data.xp);
    this.data.historicalPrimary = hist[0] ?? null;
    const recent = recent7(this.data.daily);
    this.data.recentPrimary = recent[0] ?? null;
    // Primary = Recent when recent data is sufficient, else Historical.
    const recentXp = totalOf(recent, this.data.daily);
    const primarySource = recentXp >= 5 && recent[0] ? recent : hist;
    this.data.primary = primarySource[0] ?? null;
    this.data.secondary = primarySource[1] ?? null;
    this.data.title = careerTitleFor(this.data.primary, this.data.secondary);
  }
}

function dayStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function top2(xp: Record<Career, number>): [Career | null, Career | null] {
  const entries = (Object.entries(xp) as [Career, number][]).filter(([, v]) => v > 0);
  entries.sort((a, b) => b[1] - a[1]);
  return [entries[0]?.[0] ?? null, entries[1]?.[0] ?? null];
}

function recent7(daily: Record<string, Partial<Record<Career, number>>>): [Career | null, Career | null] {
  const cutoff = dayStr(Date.now() - 7 * 24 * 3600 * 1000);
  const sums = emptyXp();
  for (const [date, deltas] of Object.entries(daily)) {
    if (date < cutoff) continue;
    for (const [c, v] of Object.entries(deltas)) sums[c as Career] += (v as number) ?? 0;
  }
  return top2(sums);
}

function totalOf(list: [Career | null, Career | null], daily: Record<string, Partial<Record<Career, number>>>): number {
  const cutoff = dayStr(Date.now() - 7 * 24 * 3600 * 1000);
  let sum = 0;
  for (const [date, deltas] of Object.entries(daily)) {
    if (date < cutoff) continue;
    for (const c of list) if (c) sum += (deltas[c] ?? 0);
  }
  return sum;
}
