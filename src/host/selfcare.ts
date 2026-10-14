/**
 * SelfcareEngine — companion-v2 batch C「双向自护」(mutual self-care).
 *
 * You take care of yourself, the pet celebrates it: three tiny daily quests,
 * a one-a-day box-breathing reward, and a mood check-in with a 14-day strip.
 * Persistence lives in ~/.petdex/runtime/selfcare.json (+ moodcheck.json).
 *
 * Red line honored throughout: NOTHING punishes. Unfinished quests simply
 * vanish at midnight; coins are granted, never revoked.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";

export type QuestDef = {
  id: string;
  icon: string;
  /** Bilingual display text, resolved by the client's current language. */
  label: { zh: string; en: string };
};

/** The quest pool — three are drawn deterministically per day. */
export const QUEST_POOL: QuestDef[] = [
  { id: "water", icon: "💧", label: { zh: "喝一杯水", en: "Drink a glass of water" } },
  { id: "eyes", icon: "👀", label: { zh: "远眺 20 秒", en: "Gaze far away for 20 seconds" } },
  { id: "stretch", icon: "🧘", label: { zh: "起身伸展一下", en: "Stand up and stretch" } },
  { id: "breath", icon: "🫁", label: { zh: "做三次深呼吸", en: "Take three deep breaths" } },
  { id: "walk", icon: "🚶", label: { zh: "走动五分钟", en: "Walk around for five minutes" } },
  { id: "pause", icon: "☕", label: { zh: "离开屏幕歇一会", en: "Step away from the screen" } },
  { id: "desk", icon: "🌿", label: { zh: "整理一下桌面", en: "Tidy up your desk" } },
  { id: "squat", icon: "💪", label: { zh: "十个深蹲", en: "Do ten squats" } },
];

/** Coins per completed quest, capped per day (full-clear bonus is separate). */
const QUEST_COINS = 5;
const QUEST_DAILY_CAP = 15;
const FULL_CLEAR_BONUS = 15;
const BREATH_COINS = 3;
const MOOD_COINS = 2;
const HISTORY_DAYS = 60;

function dayStr(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** FNV-1a — same flavor of deterministic seeding the rarity system uses. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic 3-of-8 draw seeded by the date — refresh-proof, fair-ish. */
function pickQuests(day: string): string[] {
  let seed = hashStr(`selfcare:${day}`);
  const idx: number[] = [];
  while (idx.length < 3) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const cand = seed % QUEST_POOL.length;
    if (!idx.includes(cand)) idx.push(cand);
  }
  return idx.map((i) => QUEST_POOL[i].id);
}

type SelfcareData = {
  day: string;
  questIds: string[];
  doneIds: string[];
  clearedAt: number;
  /** Coins already earned from quests today (cap bookkeeping). */
  questCoinsToday: number;
  /** Day → quests completed that day (bounded window). */
  history: Record<string, number>;
  breathDay: string | null;
  moodCoinDay: string | null;
};

function emptySelfcare(): SelfcareData {
  const day = dayStr();
  return { day, questIds: pickQuests(day), doneIds: [], clearedAt: 0, questCoinsToday: 0, history: {}, breathDay: null, moodCoinDay: null };
}

const SELFCARE_PATH = join(RUNTIME_DIR, "selfcare.json");
const MOOD_PATH = join(RUNTIME_DIR, "moodcheck.json");

export type MoodEntry = { ts: number; mood: number; note?: string };

export class SelfcareEngine {
  private data: SelfcareData;
  private moods: MoodEntry[];

  constructor() {
    this.data = this.loadSelfcare();
    this.moods = this.loadMoods();
  }

  private loadSelfcare(): SelfcareData {
    try {
      if (existsSync(SELFCARE_PATH)) {
        const raw = JSON.parse(readFileSync(SELFCARE_PATH, "utf8")) as Partial<SelfcareData>;
        const fresh = emptySelfcare();
        if (raw.day === dayStr() && Array.isArray(raw.questIds)) {
          return {
            ...fresh,
            ...raw,
            doneIds: Array.isArray(raw.doneIds) ? raw.doneIds : [],
            history: raw.history && typeof raw.history === "object" ? raw.history : {},
          };
        }
        // Day rollover on load: keep yesterday into history via save path below.
        return fresh;
      }
    } catch {
      // fall through
    }
    return emptySelfcare();
  }

  private loadMoods(): MoodEntry[] {
    try {
      if (existsSync(MOOD_PATH)) {
        const raw = JSON.parse(readFileSync(MOOD_PATH, "utf8")) as { entries?: MoodEntry[] };
        if (Array.isArray(raw.entries)) {
          const cutoff = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
          return raw.entries.filter((e) => e && typeof e.ts === "number" && e.ts >= cutoff && e.mood >= 1 && e.mood <= 5);
        }
      }
    } catch {
      // fall through
    }
    return [];
  }

  private save() {
    try {
      // Roll history forward before writing; drop entries older than the window.
      const hist = { ...this.data.history };
      hist[this.data.day] = this.data.doneIds.length;
      const cutoff = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
      for (const k of Object.keys(hist)) {
        if (new Date(`${k}T12:00:00`).getTime() < cutoff) delete hist[k];
      }
      this.data.history = hist;
      writeFileSync(SELFCARE_PATH, JSON.stringify(this.data));
      writeFileSync(MOOD_PATH, JSON.stringify({ entries: this.moods }));
    } catch {
      // best-effort
    }
  }

  /** Ensure the quest set matches TODAY (midnight rollover, lazy). */
  private rollover() {
    const today = dayStr();
    if (this.data.day === today) return;
    this.data = emptySelfcare();
  }

  /** Today's board: quest defs joined with done flags. */
  board(): {
    day: string;
    quests: { id: string; icon: string; label: { zh: string; en: string }; done: boolean; breathable: boolean }[];
    cleared: boolean;
    breathDoneToday: boolean;
    history: Record<string, number>;
  } {
    this.rollover();
    return {
      day: this.data.day,
      quests: this.data.questIds.map((id) => {
        const def = QUEST_POOL.find((q) => q.id === id) ?? QUEST_POOL[0];
        return { id, icon: def.icon, label: def.label, done: this.data.doneIds.includes(id), breathable: id === "breath" };
      }),
      cleared: this.data.clearedAt > 0,
      breathDoneToday: this.data.breathDay === this.data.day,
      history: { ...this.data.history },
    };
  }

  /** Mark a quest done. Returns coins earned (already capped) + full-clear flag. */
  complete(id: string): { ok: boolean; earned: number; cleared: boolean } {
    this.rollover();
    if (!this.data.questIds.includes(id) || this.data.doneIds.includes(id)) {
      return { ok: false, earned: 0, cleared: false };
    }
    this.data.doneIds.push(id);
    let earned = 0;
    if (this.data.questCoinsToday < QUEST_DAILY_CAP) {
      earned = Math.min(QUEST_COINS, QUEST_DAILY_CAP - this.data.questCoinsToday);
      this.data.questCoinsToday += earned;
    }
    let cleared = false;
    if (this.data.doneIds.length >= this.data.questIds.length && this.data.clearedAt === 0) {
      cleared = true;
      this.data.clearedAt = Date.now();
      earned += FULL_CLEAR_BONUS;
    }
    this.save();
    return { ok: true, earned, cleared };
  }

  /** A finished breathing session — rewarded once per day. */
  breathDone(): number {
    this.rollover();
    if (this.data.breathDay === this.data.day) return 0;
    this.data.breathDay = this.data.day;
    this.save();
    return BREATH_COINS;
  }

  /** Complete today's breathing quest when the breathing overlay finishes. */
  completeBreathQuest(): { ok: boolean; earned: number; cleared: boolean } {
    const quest = this.board().quests.find((q) => q.breathable && !q.done);
    return quest ? this.complete(quest.id) : { ok: false, earned: 0, cleared: false };
  }

  /** Mood check-in. Returns whether this was the first entry today. */
  checkMood(mood: number, note?: string): boolean {
    const clamped = Math.max(1, Math.min(5, Math.round(mood)));
    const today = dayStr();
    const first = !this.moods.some((m) => dayStr(m.ts) === today);
    // Multiple check-ins per day are allowed; the latest wins in the strip.
    this.moods.push({ ts: Date.now(), mood: clamped, ...(note?.trim() ? { note: note.trim().slice(0, 140) } : {}) });
    const cutoff = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
    this.moods = this.moods.filter((m) => m.ts >= cutoff);
    this.save();
    return first;
  }

  moodCoinDue(): boolean {
    const today = dayStr();
    if (this.data.moodCoinDay === today) return false;
    this.data.moodCoinDay = today;
    this.save();
    return true;
  }

  /** Latest mood today (for the check-in row highlight), or null. */
  moodToday(): number | null {
    const today = dayStr();
    for (let i = this.moods.length - 1; i >= 0; i--) {
      if (dayStr(this.moods[i].ts) === today) return this.moods[i].mood;
    }
    return null;
  }

  /** One cell per day for the 14-day strip (latest entry of each day wins). */
  moodStrip(): { date: string; mood: number | null; note?: string }[] {
    const out: { date: string; mood: number | null; note?: string }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = dayStr(Date.now() - i * 24 * 3600 * 1000);
      let mood: number | null = null;
      let note: string | undefined;
      for (const e of this.moods) {
        if (dayStr(e.ts) === d) {
          mood = e.mood;
          note = e.note;
        }
      }
      out.push({ date: d, mood, ...(note ? { note } : {}) });
    }
    return out;
  }
}
