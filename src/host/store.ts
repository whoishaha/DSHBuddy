/**
 * DSHBuddy persistent config + runtime store (~/.petdex/runtime/dshbuddy.json).
 * The data root resolves in ./paths.ts (local home directory by default).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";

export type FloaterMode = "corner" | "walker";

/** v0.4 companion-v2 D1: how chatty the proactive cares may be.
 *  quiet=only essentials · gentle=restrained · normal=default · attentive=chatty. */
export type CareIntensity = "quiet" | "gentle" | "normal" | "attentive";
export const CARE_INTENSITIES: CareIntensity[] = ["quiet", "gentle", "normal", "attentive"];

export type ChatConfig = {
  provider: "ollama" | "openai" | "gemini" | "off";
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Skip reasoning/thinking for buddy chats — fast casual replies.
   *  Only takes effect when the selected model exposes selectable efforts
   *  (an off/minimal/low level); otherwise the provider default applies. */
  disableThinking: boolean;
};

export type QuickCommand = {
  id: string;
  label: string;
  command: string;
  platform?: string;
};

export type BuddyConfig = {
  floaterMode: FloaterMode;
  visible: boolean;
  companionEnabled: boolean;
  restReminderThresholdMin: number;
  /** Pet display scale (0.5–1.5); 1 = original size. Persisted, both modes. */
  petScale: number;
  skin: "dark" | "light";
  /** UI language — zh/en since v0.2.9 (legacy ja/ko configs fall back to zh). */
  language: "zh" | "en";
  /** One-time welcome bubble shown on the first run after install. */
  welcomeShown: boolean;
  /** Mouse-thief play: pet steals the idle cursor arrow and runs around. */
  mouseStealEnabled: boolean;
  /** Idle minutes before the theft triggers (1–30, clamped client-side). */
  mouseStealIdleMin: number;
  /** 喝水/护眼/起身 rotating micro nudges during long active stretches. */
  careMicroEnabled: boolean;
  /** Festival-flavored greetings. */
  careFestivalEnabled: boolean;
  /** Friendly conversation starters after long silence. */
  careIdleChatEnabled: boolean;
  /** v0.4 D1 global care chattiness (budget + cooldown multiplier). */
  careIntensity: CareIntensity;
  /** v0.4 E2 wind-down ritual: offer a wrap-up at this hour (19–23). */
  windDownEnabled: boolean;
  windDownHour: number;
  /** B1-2 host-side event sounds (played by the OS, survive browser mute). */
  soundEnabled: boolean;
  /** Master volume 0–100 (baked into the synthesized WAV gain). */
  soundVolume: number;
  bindings: Record<string, string>;
  chat: ChatConfig;
  customCommands: QuickCommand[];
  personality: {
    preset: string;
    customPrompt: string;
    constraints: string[];
    /** B2-4 five tone dials (0–100) mixed into the persona prompt. */
    traits: PersonalityTraits;
  };
  pomodoro: {
    workMin: number;
    breakMin: number;
  };
  growth: {
    /** LLM-powered memory summaries & user portrait (fallback = template/rule). */
    llmEnabled: boolean;
  };
};

/** B2-4 five-dimension tone dials — each 0–100, all optional-safe. */
export type PersonalityTraits = {
  /** 毒舌 — teasing / snark level. */
  sarcasm: number;
  /** 热情 — enthusiasm. */
  enthusiasm: number;
  /** 唠叨 — chattiness / message length. */
  chattiness: number;
  /** 幽默 — humor frequency. */
  humor: number;
  /** 温柔 — gentleness / comfort tone. */
  gentleness: number;
};

export const DEFAULT_TRAITS: PersonalityTraits = {
  sarcasm: 20,
  enthusiasm: 60,
  chattiness: 40,
  humor: 35,
  gentleness: 55,
};

export const PERSONALITY_PRESETS: { id: string; name: string; prompt: string }[] = [
  { id: "default", name: "默认", prompt: "你是陪伴程序员工作的宠物鲸鱼，友好、简洁、鼓励。" },
  { id: "cheerleader", name: "元气加油", prompt: "你是元气满满的啦啦队鲸鱼，总是积极鼓励用户，语气活泼。" },
  { id: "calm", name: "沉稳安静", prompt: "你是沉稳安静的鲸鱼，话语少而精，专注陪伴，不打扰。" },
  { id: "mentor", name: "技术导师", prompt: "你是技术导师鲸鱼，适时给出编程建议和提醒，理性务实。" },
  { id: "comedian", name: "幽默搞怪", prompt: "你是幽默搞怪的鲸鱼，偶尔讲冷幽默，让编程更有趣。" },
  { id: "senpai", name: "温柔陪伴", prompt: "你是温柔治愈的鲸鱼，像前辈一样体贴，安慰情绪。" },
];

export const DEFAULT_CONFIG: BuddyConfig = {
  floaterMode: "corner",
  visible: true,
  companionEnabled: true,
  restReminderThresholdMin: 120,
  petScale: 1,
  skin: "dark",
  language: "zh",
  welcomeShown: false,
  mouseStealEnabled: true,
  mouseStealIdleMin: 3,
  careMicroEnabled: true,
  careFestivalEnabled: true,
  careIdleChatEnabled: true,
  careIntensity: "normal",
  windDownEnabled: true,
  windDownHour: 21,
  soundEnabled: true,
  soundVolume: 70,
  personality: { preset: "default", customPrompt: "", constraints: [], traits: { ...DEFAULT_TRAITS } },
  pomodoro: { workMin: 25, breakMin: 5 },
  growth: { llmEnabled: true },
  bindings: {},
  chat: {
    provider: "off",
    baseUrl: "",
    apiKey: "",
    model: "",
    disableThinking: true,
  },
  customCommands: [],
};

export const BUILTIN_COMMANDS: QuickCommand[] = [
  { id: "compact", label: "Compress context", command: "/compact" },
  { id: "goal", label: "Set a goal", command: "/goal " },
  { id: "plan", label: "Plan mode", command: "/plan" },
  { id: "skill", label: "Use a skill", command: "/skill " },
  { id: "clear", label: "New session", command: "/new" },
];

const CONFIG_PATH = join(RUNTIME_DIR, "dshbuddy.json");

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Normalize untrusted disk/API data while retaining unknown future defaults. */
function normalizeConfig(
  patch: unknown,
  base: BuddyConfig,
  preserveBlankApiKey: boolean,
): BuddyConfig {
  const raw = recordOf(patch) ?? {};
  const next: BuddyConfig = {
    ...base,
    chat: { ...base.chat },
    personality: {
      ...base.personality,
      constraints: [...base.personality.constraints],
      traits: { ...base.personality.traits },
    },
    pomodoro: { ...base.pomodoro },
    growth: { ...base.growth },
    bindings: { ...base.bindings },
    customCommands: [...base.customCommands],
  };

  const boolKeys = [
    "visible", "companionEnabled", "welcomeShown", "mouseStealEnabled",
    "careMicroEnabled", "careFestivalEnabled", "careIdleChatEnabled",
    "windDownEnabled", "soundEnabled",
  ] as const;
  for (const key of boolKeys) if (typeof raw[key] === "boolean") next[key] = raw[key];
  if (raw.floaterMode === "corner" || raw.floaterMode === "walker") next.floaterMode = raw.floaterMode;
  if (raw.skin === "dark" || raw.skin === "light") next.skin = raw.skin;
  if (raw.language === "zh" || raw.language === "en") next.language = raw.language;
  if (CARE_INTENSITIES.includes(raw.careIntensity as CareIntensity)) next.careIntensity = raw.careIntensity as CareIntensity;
  if ("petScale" in raw) next.petScale = clampNumber(raw.petScale, next.petScale, 0.5, 1.5);
  if ("restReminderThresholdMin" in raw) next.restReminderThresholdMin = Math.round(clampNumber(raw.restReminderThresholdMin, next.restReminderThresholdMin, 15, 360));
  if ("mouseStealIdleMin" in raw) next.mouseStealIdleMin = Math.round(clampNumber(raw.mouseStealIdleMin, next.mouseStealIdleMin, 1, 30));
  if ("windDownHour" in raw) next.windDownHour = Math.round(clampNumber(raw.windDownHour, next.windDownHour, 19, 23));
  if ("soundVolume" in raw) next.soundVolume = Math.round(clampNumber(raw.soundVolume, next.soundVolume, 0, 100));

  const chat = recordOf(raw.chat);
  if (chat) {
    if (["off", "ollama", "openai", "gemini"].includes(String(chat.provider))) {
      next.chat.provider = chat.provider as ChatConfig["provider"];
    }
    if (typeof chat.baseUrl === "string") next.chat.baseUrl = chat.baseUrl.trim().slice(0, 2048);
    if (typeof chat.model === "string") next.chat.model = chat.model.trim().slice(0, 200);
    if (typeof chat.disableThinking === "boolean") next.chat.disableThinking = chat.disableThinking;
    if (typeof chat.apiKey === "string" && (!preserveBlankApiKey || chat.apiKey.length > 0)) {
      next.chat.apiKey = chat.apiKey.slice(0, 8192);
    }
  }

  const personality = recordOf(raw.personality);
  if (personality) {
    if (typeof personality.preset === "string") next.personality.preset = personality.preset.slice(0, 80);
    if (typeof personality.customPrompt === "string") next.personality.customPrompt = personality.customPrompt.slice(0, 4000);
    if (Array.isArray(personality.constraints)) {
      next.personality.constraints = personality.constraints
        .filter((v): v is string => typeof v === "string")
        .slice(0, 20)
        .map((v) => v.slice(0, 500));
    }
    const traits = recordOf(personality.traits);
    if (traits) {
      for (const key of Object.keys(DEFAULT_TRAITS) as (keyof PersonalityTraits)[]) {
        if (key in traits) next.personality.traits[key] = Math.round(clampNumber(traits[key], next.personality.traits[key], 0, 100));
      }
    }
  }

  const pomodoro = recordOf(raw.pomodoro);
  if (pomodoro) {
    if ("workMin" in pomodoro) next.pomodoro.workMin = Math.round(clampNumber(pomodoro.workMin, next.pomodoro.workMin, 1, 180));
    if ("breakMin" in pomodoro) next.pomodoro.breakMin = Math.round(clampNumber(pomodoro.breakMin, next.pomodoro.breakMin, 1, 60));
  }
  const growth = recordOf(raw.growth);
  if (growth && typeof growth.llmEnabled === "boolean") next.growth.llmEnabled = growth.llmEnabled;

  const bindings = recordOf(raw.bindings);
  if (bindings) {
    next.bindings = Object.fromEntries(
      Object.entries(bindings)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(0, 100)
        .map(([key, value]) => [key.slice(0, 100), value.slice(0, 500)]),
    );
  }
  if (Array.isArray(raw.customCommands)) {
    next.customCommands = raw.customCommands
      .map(recordOf)
      .filter((cmd): cmd is Record<string, unknown> => Boolean(cmd))
      .filter((cmd) => typeof cmd.id === "string" && typeof cmd.label === "string" && typeof cmd.command === "string")
      .slice(0, 100)
      .map((cmd) => ({
        id: String(cmd.id).slice(0, 100),
        label: String(cmd.label).slice(0, 100),
        command: String(cmd.command).slice(0, 2000),
        ...(typeof cmd.platform === "string" ? { platform: cmd.platform.slice(0, 50) } : {}),
      }));
  }
  return next;
}

export class ConfigStore {
  private config: BuddyConfig;

  constructor() {
    this.config = this.load();
  }

  private load(): BuddyConfig {
    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<BuddyConfig>;
        return normalizeConfig(raw, DEFAULT_CONFIG, false);
      }
    } catch {
      // fall through to defaults
    }
    return { ...DEFAULT_CONFIG };
  }

  save() {
    const tempPath = `${CONFIG_PATH}.${process.pid}.tmp`;
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
      writeFileSync(tempPath, JSON.stringify(this.config, null, 2), "utf8");
      renameSync(tempPath, CONFIG_PATH);
    } catch {
      try { rmSync(tempPath, { force: true }); } catch { /* best-effort cleanup */ }
      // best-effort
    }
  }

  get(): BuddyConfig {
    return this.config;
  }

  /** Browser-safe view: preserve whether a secret exists without exposing it. */
  public(): BuddyConfig & { chat: ChatConfig & { hasApiKey: boolean } } {
    return {
      ...this.config,
      chat: {
        ...this.config.chat,
        apiKey: "",
        hasApiKey: this.config.chat.apiKey.length > 0,
      },
    };
  }

  patch(patch: Partial<BuddyConfig>): BuddyConfig {
    // Empty apiKey means "keep the stored secret" so the browser never needs
    // the existing key in order to update another model field.
    this.config = normalizeConfig(patch, this.config, true);
    this.save();
    return this.config;
  }

  allCommands(): QuickCommand[] {
    return [...this.config.customCommands, ...BUILTIN_COMMANDS];
  }

  upsertCommand(cmd: QuickCommand) {
    const idx = this.config.customCommands.findIndex((c) => c.id === cmd.id);
    if (idx >= 0) this.config.customCommands[idx] = cmd;
    else this.config.customCommands.push(cmd);
    this.save();
  }

  removeCommand(id: string) {
    this.config.customCommands = this.config.customCommands.filter((c) => c.id !== id);
    this.save();
  }
}
