/**
 * growthLabels — the ONE shared copy of growth-domain label/color maps.
 *
 * Labels are i18n keys resolved through t() so the whole plugin follows the
 * configured language. Colors stay static here.
 */

import { t } from "./i18n.js";

const MOOD_KEYS: Record<string, string> = {
  relaxed: "mood.relaxed",
  focused: "mood.focused",
  happy: "mood.happy",
  waiting: "mood.waiting",
  frustrated: "mood.frustrated",
  tired: "mood.tired",
};

const INTENSITY_KEYS: Record<string, string> = {
  quiet: "level.quiet",
  normal: "level.normal",
  busy: "level.busy",
  intense: "level.intense",
  night_shift: "level.nightShift",
};

/** Workflow-loop label keys MUST mirror the host classifier in
 *  src/host/stats.ts (research/coding/writing/debug/plan/orchestrate/other). */
const LOOP_KEYS: Record<string, string> = {
  research: "loop.research",
  coding: "loop.coding",
  writing: "loop.writing",
  debug: "loop.debug",
  plan: "loop.plan",
  orchestrate: "loop.orchestrate",
  other: "loop.other",
};

export const INTENSITY_COLORS: Record<string, string> = {
  quiet: "#64748b",
  normal: "#3b82f6",
  busy: "#f59e0b",
  intense: "#ef4444",
  night_shift: "#8b5cf6",
};

export const LOOP_COLORS: Record<string, string> = {
  research: "#38bdf8",
  coding: "#fb923c",
  writing: "#22c55e",
  debug: "#ef4444",
  plan: "#8b5cf6",
  orchestrate: "#f59e0b",
  other: "#64748b",
};

/** Intensity → level name (single source of truth; mirrors the host engine's
 *  buckets in src/host/growth.ts: ≤10 / ≤40 / ≤100 / ≤200 / >200). */
export function intensityLevelOf(intensity: number): string {
  if (intensity <= 10) return "quiet";
  if (intensity <= 40) return "normal";
  if (intensity <= 100) return "busy";
  if (intensity <= 200) return "intense";
  return "night_shift";
}

function labelOf(keys: Record<string, string>, k: string, prefix: string): string {
  const key = keys[k];
  return key ? t(key as never) : k || prefix;
}

export function moodLabel(mood: string): string {
  return labelOf(MOOD_KEYS, mood, "mood");
}

export function intensityLabel(level: string): string {
  return labelOf(INTENSITY_KEYS, level, "level");
}

export function loopLabel(loop: string): string {
  return labelOf(LOOP_KEYS, loop, "loop");
}

export function intensityColor(level: string): string {
  return INTENSITY_COLORS[level] ?? "#64748b";
}

// ── B3-1 evolution stages (label/color only — the sprite never changes) ────

export type EvolutionStage = {
  minLevel: number;
  zh: string;
  en: string;
  color: string;
};

/** Level-mapped stages: 幼鲸 → 少年鲸 → 成年鲸 → 深渊鲸 → 星鲸. */
export const EVOLUTION_STAGES: EvolutionStage[] = [
  { minLevel: 1, zh: "幼鲸", en: "Calf", color: "#7dd3fc" },
  { minLevel: 5, zh: "少年鲸", en: "Juvenile", color: "#38bdf8" },
  { minLevel: 10, zh: "成年鲸", en: "Adult", color: "#0ea5e9" },
  { minLevel: 20, zh: "深渊鲸", en: "Abyssal", color: "#818cf8" },
  { minLevel: 30, zh: "星鲸", en: "Star Whale", color: "#c084fc" },
];

export function stageFor(level: number): EvolutionStage {
  let stage = EVOLUTION_STAGES[0];
  for (const s of EVOLUTION_STAGES) if (level >= s.minLevel) stage = s;
  return stage;
}

export const PRESTIGE_MIN_LEVEL = 30;
