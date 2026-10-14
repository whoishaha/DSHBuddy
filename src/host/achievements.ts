/**
 * Achievements — badge wall.
 *
 * A registry of lifetime badges derived from signals the plugin ALREADY
 * tracks (growth totals, stats rhythms, order outcomes, pet collection).
 * No new event plumbing: an AchievementsEngine.check() pass compares cheap
 * thresholds and persists unlocks to ~/.petdex/runtime/achievements.json.
 *
 * v0.3.6: the wall grew to 8 categories × 21 tracks × 37 levels. Categories carry their
 * own bilingual display meta so the settings gallery can group/filter without
 * extra i18n plumbing; a handful of badges read internal counters (night
 * turns, early turns, pats, orders) that aren't derivable elsewhere.
 *
 * Design red line: badges only ever celebrate — nothing expires, nothing can
 * be lost, no guilt mechanics.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";

/** Aggregate metrics the checker understands (all plain numbers). */
export type AchMetrics = {
  tasksCompleted: number;
  toolCalls: number;
  errorsRecovered: number;
  totalApprovals: number;
  totalSubagents: number;
  intimacy: number;
  level: number;
  streakDays: number;
  bestStreak: number;
  pomoMinutes: number;
  activeDays: number;
  /** Lifetime coins earned (never spent — the wallet only grows in spirit). */
  earnedTotal?: number;
  /** Installed pets (market + local). */
  petsOwned?: number;
  /** Head-pats given (counter — every tap counts, intimacy has its own scale). */
  pats?: number;
  /** Turns completed between 00:00–05:00 local (tracked internally too). */
  nightTurns?: number;
  /** Turns completed between 05:00–09:00 local (early-bird counter). */
  earlyTurns?: number;
  /** Weekend days (Sat/Sun) with real activity, derived from stats.days. */
  weekendDays?: number;
  /** Work orders finished successfully. */
  ordersDone?: number;
  /** Prestige count (转生次数). */
  prestigeCount?: number;
  /** True when any installed pet rolled the 1% shiny variant. */
  shinyOwned?: number;
  /** True when any installed pet rolled epic rarity. */
  epicOwned?: number;
};

/** Badge categories — bilingual display meta travels with the registry. */
export type AchCategoryId =
  | "tasks"
  | "tools"
  | "team"
  | "growth"
  | "bond"
  | "rhythm"
  | "focus"
  | "whale";

export const ACH_CATEGORIES: {
  id: AchCategoryId;
  icon: string;
  color: string;
  name: { zh: string; en: string };
}[] = [
  { id: "tasks", icon: "🤝", color: "#38bdf8", name: { zh: "协作任务", en: "Tasks" } },
  { id: "tools", icon: "🛠️", color: "#f59e0b", name: { zh: "工具排障", en: "Tools" } },
  { id: "team", icon: "🧠", color: "#a78bfa", name: { zh: "团队指挥", en: "Crew" } },
  { id: "growth", icon: "🌱", color: "#4ade80", name: { zh: "成长进化", en: "Growth" } },
  { id: "bond", icon: "❤️", color: "#f472b6", name: { zh: "陪伴羁绊", en: "Bond" } },
  { id: "rhythm", icon: "📅", color: "#818cf8", name: { zh: "坚持节律", en: "Rhythm" } },
  { id: "focus", icon: "🍅", color: "#ef4444", name: { zh: "专注深度", en: "Focus" } },
  { id: "whale", icon: "🐋", color: "#22d3ee", name: { zh: "鲸灵收藏", en: "Whale" } },
];

export type AchievementDef = {
  id: string;
  category: AchCategoryId;
  icon: string;
  metric: keyof AchMetrics;
  target: number;
  /** Display text travels with the registry (host bubbles need it too). */
  name: { zh: string; en: string };
  desc: { zh: string; en: string };
};

/**
 * The wall (8 categories × 21 tracks × 37 levels), tiered so each metric has a ladder:
 * names/descriptions ship in both languages so the settings gallery and the
 * unlock bubble render without extra i18n plumbing.
 */
export const ACHIEVEMENTS: AchievementDef[] = [
  // ── 协作任务 🤝 ────────────────────────────────────────────────────────────
  { id: "first-task", category: "tasks", icon: "🤝", metric: "tasksCompleted", target: 1,
    name: { zh: "初次合作", en: "First Handshake" },
    desc: { zh: "完成第一个协作任务", en: "Complete your first task together" } },
  { id: "tasks-10", category: "tasks", icon: "🌟", metric: "tasksCompleted", target: 10,
    name: { zh: "小有名气", en: "Getting Known" },
    desc: { zh: "累计完成 10 个任务", en: "Complete 10 tasks in total" } },
  { id: "tasks-100", category: "tasks", icon: "💯", metric: "tasksCompleted", target: 100,
    name: { zh: "百战老兵", en: "Centurion" },
    desc: { zh: "累计完成 100 个任务", en: "Complete 100 tasks in total" } },
  { id: "tasks-500", category: "tasks", icon: "🏆", metric: "tasksCompleted", target: 500,
    name: { zh: "身经百战", en: "Battle-Hardened" },
    desc: { zh: "累计完成 500 个任务", en: "Complete 500 tasks in total" } },

  // ── 工具排障 🛠️ ────────────────────────────────────────────────────────────
  { id: "tools-50", category: "tools", icon: "🔍", metric: "toolCalls", target: 50,
    name: { zh: "初窥门径", en: "First Steps" },
    desc: { zh: "累计调用 50 次工具", en: "Run 50 tool calls in total" } },
  { id: "tools-500", category: "tools", icon: "🛠️", metric: "toolCalls", target: 500,
    name: { zh: "工具大师", en: "Toolmaster" },
    desc: { zh: "累计调用 500 次工具", en: "Run 500 tool calls in total" } },
  { id: "tools-2000", category: "tools", icon: "⚙️", metric: "toolCalls", target: 2000,
    name: { zh: "万物皆调", en: "Everything Is a Tool" },
    desc: { zh: "累计调用 2000 次工具", en: "Run 2000 tool calls in total" } },
  { id: "recovery-10", category: "tools", icon: "🪀", metric: "errorsRecovered", target: 10,
    name: { zh: "打不倒", en: "Comeback Kid" },
    desc: { zh: "从 10 次报错中恢复", en: "Recover from 10 errors" } },
  { id: "recovery-100", category: "tools", icon: "🔧", metric: "errorsRecovered", target: 100,
    name: { zh: "排障专家", en: "Troubleshooter" },
    desc: { zh: "从 100 次报错中恢复", en: "Recover from 100 errors" } },

  // ── 团队指挥 🧠 ────────────────────────────────────────────────────────────
  { id: "approvals-10", category: "team", icon: "📝", metric: "totalApprovals", target: 10,
    name: { zh: "守门新人", en: "Rookie Gatekeeper" },
    desc: { zh: "处理 10 次审批请求", en: "Handle 10 approval requests" } },
  { id: "approvals-50", category: "team", icon: "✅", metric: "totalApprovals", target: 50,
    name: { zh: "审批老手", en: "Gatekeeper" },
    desc: { zh: "处理 50 次审批请求", en: "Handle 50 approval requests" } },
  { id: "subagents-1", category: "team", icon: "🥚", metric: "totalSubagents", target: 1,
    name: { zh: "第一次放权", en: "First Delegation" },
    desc: { zh: "派出第一个子代理", en: "Dispatch your first subagent" } },
  { id: "subagents-10", category: "team", icon: "🧠", metric: "totalSubagents", target: 10,
    name: { zh: "团队大脑", en: "Hive Mind" },
    desc: { zh: "派出 10 个子代理", en: "Dispatch 10 subagents" } },
  { id: "subagents-50", category: "team", icon: "👑", metric: "totalSubagents", target: 50,
    name: { zh: "舰队司令", en: "Fleet Commander" },
    desc: { zh: "派出 50 个子代理", en: "Dispatch 50 subagents" } },

  // ── 成长进化 🌱 ────────────────────────────────────────────────────────────
  { id: "level-10", category: "growth", icon: "🌱", metric: "level", target: 10,
    name: { zh: "崭露头角", en: "Sprouting" },
    desc: { zh: "宠物等级达到 Lv.10", en: "Reach pet level 10" } },
  { id: "level-30", category: "growth", icon: "🐋", metric: "level", target: 30,
    name: { zh: "深海巨鲸", en: "Deep Giant" },
    desc: { zh: "宠物等级达到 Lv.30", en: "Reach pet level 30" } },
  { id: "prestige-1", category: "growth", icon: "🌟", metric: "prestigeCount", target: 1,
    name: { zh: "破茧重生", en: "Rebirth" },
    desc: { zh: "完成第一次转生", en: "Prestige for the first time" } },
  { id: "prestige-5", category: "growth", icon: "✨", metric: "prestigeCount", target: 5,
    name: { zh: "轮回行者", en: "Cycle Walker" },
    desc: { zh: "累计转生 5 次", en: "Prestige 5 times in total" } },

  // ── 陪伴羁绊 ❤️ ────────────────────────────────────────────────────────────
  { id: "intimacy-100", category: "bond", icon: "❤️", metric: "intimacy", target: 100,
    name: { zh: "心有灵犀", en: "Two Hearts" },
    desc: { zh: "摸头亲密度达到 100", en: "Reach 100 head-pat intimacy" } },
  { id: "intimacy-500", category: "bond", icon: "💞", metric: "intimacy", target: 500,
    name: { zh: "灵魂伴侣", en: "Soulmate" },
    desc: { zh: "摸头亲密度达到 500", en: "Reach 500 head-pat intimacy" } },
  { id: "pats-100", category: "bond", icon: "🫶", metric: "pats", target: 100,
    name: { zh: "摸头百次", en: "Century of Pats" },
    desc: { zh: "累计摸头 100 次", en: "Give 100 head pats in total" } },
  { id: "pets-3", category: "bond", icon: "🏡", metric: "petsOwned", target: 3,
    name: { zh: "三鲸同堂", en: "Full House" },
    desc: { zh: "拥有 3 只不同的宠物", en: "Own 3 different pets" } },
  { id: "pets-8", category: "bond", icon: "🌊", metric: "petsOwned", target: 8,
    name: { zh: "鲸群成海", en: "A Sea of Whales" },
    desc: { zh: "拥有 8 只不同的宠物", en: "Own 8 different pets" } },

  // ── 坚持节律 📅 ────────────────────────────────────────────────────────────
  { id: "streak-7", category: "rhythm", icon: "📅", metric: "streakDays", target: 7,
    name: { zh: "七日之约", en: "Week Streak" },
    desc: { zh: "连续活跃 7 天", en: "Stay active 7 days in a row" } },
  { id: "best-streak-30", category: "rhythm", icon: "🌙", metric: "bestStreak", target: 30,
    name: { zh: "月满坚持", en: "Moon Streak" },
    desc: { zh: "最长连续活跃 30 天", en: "Reach a 30-day activity streak" } },
  { id: "active-days-30", category: "rhythm", icon: "🗓️", metric: "activeDays", target: 30,
    name: { zh: "老朋友", en: "Old Friend" },
    desc: { zh: "累计活跃 30 个不同的日子", en: "Be active on 30 different days" } },
  { id: "active-days-100", category: "rhythm", icon: "🗿", metric: "activeDays", target: 100,
    name: { zh: "百日同行", en: "Hundred Days Together" },
    desc: { zh: "累计活跃 100 个不同的日子", en: "Be active on 100 different days" } },
  { id: "weekend-8", category: "rhythm", icon: "🏖️", metric: "weekendDays", target: 8,
    name: { zh: "周末战士", en: "Weekend Warrior" },
    desc: { zh: "在 8 个周末（周六/周日）保持活跃", en: "Stay active on 8 weekend days" } },
  { id: "night-turns-5", category: "rhythm", icon: "🌃", metric: "nightTurns", target: 5,
    name: { zh: "夜航员", en: "Night Navigator" },
    desc: { zh: "在深夜（0–5 点）完成 5 个任务", en: "Finish 5 tasks between midnight and 5am" } },
  { id: "early-turns-5", category: "rhythm", icon: "🌅", metric: "earlyTurns", target: 5,
    name: { zh: "早起的鸟", en: "Early Bird" },
    desc: { zh: "在清晨（5–9 点）完成 5 个任务", en: "Finish 5 tasks between 5am and 9am" } },

  // ── 专注深度 🍅 ────────────────────────────────────────────────────────────
  { id: "pomo-60", category: "focus", icon: "🍀", metric: "pomoMinutes", target: 60,
    name: { zh: "第一小时", en: "First Hour" },
    desc: { zh: "累计专注 60 分钟（番茄钟）", en: "Log 60 focus minutes with pomodoros" } },
  { id: "pomo-600", category: "focus", icon: "🍅", metric: "pomoMinutes", target: 600,
    name: { zh: "专注十小时", en: "Deep Focus" },
    desc: { zh: "累计专注 600 分钟（番茄钟）", en: "Log 600 focus minutes with pomodoros" } },
  { id: "pomo-3000", category: "focus", icon: "🌳", metric: "pomoMinutes", target: 3000,
    name: { zh: "五十小时森林", en: "Fifty-Hour Forest" },
    desc: { zh: "累计专注 3000 分钟（番茄钟）", en: "Log 3000 focus minutes with pomodoros" } },

  // ── 鲸灵收藏 🐋 ────────────────────────────────────────────────────────────
  { id: "orders-1", category: "whale", icon: "🚀", metric: "ordersDone", target: 1,
    name: { zh: "鲸灵首单", en: "First Dispatch" },
    desc: { zh: "成功完成一张鲸灵工作单", en: "Successfully finish a JingLing work order" } },
  { id: "orders-20", category: "whale", icon: "🛳️", metric: "ordersDone", target: 20,
    name: { zh: "运筹帷幄", en: "Master Dispatcher" },
    desc: { zh: "成功完成 20 张鲸灵工作单", en: "Successfully finish 20 JingLing work orders" } },
  { id: "earned-1000", category: "whale", icon: "🪙", metric: "earnedTotal", target: 1000,
    name: { zh: "千金不散", en: "Coin Magnet" },
    desc: { zh: "累计赚取 1000 金币", en: "Earn 1000 coins in total" } },
  { id: "epic-1", category: "whale", icon: "🔮", metric: "epicOwned", target: 1,
    name: { zh: "史诗相遇", en: "Epic Encounter" },
    desc: { zh: "拥有一只史诗稀有度的宠物", en: "Own a pet of epic rarity" } },
  { id: "shiny-1", category: "whale", icon: "💎", metric: "shinyOwned", target: 1,
    name: { zh: "闪光之缘", en: "Shiny Charm" },
    desc: { zh: "拥有一只闪光变体宠物（1% 命中）", en: "Own a shiny pet (a 1% roll)" } },
];

type AchData = {
  /** id → unlock timestamp. */
  unlocked: Record<string, number>;
  /** Internal counters not derivable elsewhere (nightTurns, earlyTurns, pats…). */
  counters: Record<string, number>;
  updatedAt: number;
};

const ACH_PATH = join(RUNTIME_DIR, "achievements.json");

function emptyData(): AchData {
  return { unlocked: {}, counters: {}, updatedAt: 0 };
}

/** FNV-1a 32-bit — mirrors src/client/rarity.ts exactly (same slugs must
 *  resolve to the same rarity/shiny verdict on both sides of the plugin). */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Collection metrics derived from the installed pet list (host-side mirror
 *  of the client's deterministic rarity rolls). */
export function collectionMetrics(slugs: readonly string[]): {
  petsOwned: number;
  shinyOwned: number;
  epicOwned: number;
} {
  let shiny = 0;
  let epic = 0;
  for (const slug of slugs) {
    if (hashStr(`shiny:${slug}`) % 100 === 0) shiny = 1;
    if (hashStr(`rarity:${slug}`) % 100 >= 95) epic = 1;
  }
  return { petsOwned: slugs.length, shinyOwned: shiny, epicOwned: epic };
}

export class AchievementEngine {
  private data: AchData;
  /** Fired once per newly unlocked id (celebration bubble / care log / coins). */
  onUnlock: ((id: string) => void) | null = null;

  constructor() {
    this.data = this.load();
  }

  private load(): AchData {
    try {
      if (existsSync(ACH_PATH)) {
        const raw = JSON.parse(readFileSync(ACH_PATH, "utf8")) as Partial<AchData>;
        return {
          unlocked: raw.unlocked ?? {},
          counters: raw.counters ?? {},
          updatedAt: raw.updatedAt ?? 0,
        };
      }
    } catch {
      // corrupt file → fresh start (badges re-unlock naturally)
    }
    return emptyData();
  }

  private save() {
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
      this.data.updatedAt = Date.now();
      writeFileSync(ACH_PATH, JSON.stringify(this.data));
    } catch {
      // best-effort
    }
  }

  getData(): AchData {
    return this.data;
  }

  /** Bump an internal counter (night turns, pats, finished orders…). */
  bumpCounter(name: string, delta = 1): number {
    this.data.counters[name] = (this.data.counters[name] ?? 0) + delta;
    this.save();
    return this.data.counters[name];
  }

  /** Merge the engine's internal counters into a metrics snapshot. */
  private withCounters(m: AchMetrics): AchMetrics {
    return {
      ...m,
      nightTurns: m.nightTurns ?? this.data.counters.nightTurns ?? 0,
      earlyTurns: m.earlyTurns ?? this.data.counters.earlyTurns ?? 0,
      pats: m.pats ?? this.data.counters.pats ?? 0,
      ordersDone: m.ordersDone ?? this.data.counters.ordersDone ?? 0,
    };
  }

  /**
   * One evaluation pass over all definitions. Returns ids unlocked BY THIS
   * CALL (already-unlocked ones never fire again). Cheap: pure comparisons,
   * safe to call after every turn end.
   */
  check(m: AchMetrics): string[] {
    const metrics = this.withCounters(m);
    const fresh: string[] = [];
    let dirty = false;
    for (const def of ACHIEVEMENTS) {
      if (this.data.unlocked[def.id]) continue;
      const value = metrics[def.metric] ?? 0;
      if (value >= def.target) {
        this.data.unlocked[def.id] = Date.now();
        fresh.push(def.id);
        dirty = true;
      }
    }
    if (dirty) this.save();
    for (const id of fresh) {
      const cb = this.onUnlock;
      if (cb) cb(id);
    }
    return fresh;
  }

  /**
   * Tiered wall state for the API/GUI.
   *
   * Definitions that measure the same thing become one achievement track.
   * Each historical threshold is one level, so existing unlock timestamps,
   * celebration bubbles and coin rewards remain fully compatible.
   */
  list(m: AchMetrics): {
    id: string;
    category: AchCategoryId;
    icon: string;
    unlockedAt: number | null;
    level: number;
    maxLevel: number;
    value: number;
    progress: { cur: number; target: number };
    name: { zh: string; en: string };
    desc: { zh: string; en: string };
  }[] {
    const metrics = this.withCounters(m);
    const tracks = new Map<string, AchievementDef[]>();
    for (const def of ACHIEVEMENTS) {
      const key = `${def.category}:${def.metric}`;
      const defs = tracks.get(key) ?? [];
      defs.push(def);
      tracks.set(key, defs);
    }

    return [...tracks.entries()].map(([trackId, unsorted]) => {
      const defs = [...unsorted].sort((a, b) => a.target - b.target);
      const unlockedDefs = defs.filter((def) => this.data.unlocked[def.id] != null);
      const level = unlockedDefs.length;
      const maxLevel = defs.length;
      const currentTier = level > 0 ? defs[level - 1] : defs[0];
      const nextTier = defs[level] ?? null;
      const displayTier = nextTier ?? currentTier;
      const value = Number(metrics[defs[0].metric] ?? 0);
      return {
        id: trackId,
        category: defs[0].category,
        icon: currentTier.icon,
        unlockedAt: level > 0 ? (this.data.unlocked[currentTier.id] ?? null) : null,
        level,
        maxLevel,
        value,
        progress: nextTier
          ? { cur: Math.min(value, nextTier.target), target: nextTier.target }
          : { cur: currentTier.target, target: currentTier.target },
        name: currentTier.name,
        desc: displayTier.desc,
      };
    });
  }
}
