/**
 * useBuddyState — polls the host half's same-origin snapshot endpoint and
 * exposes the pet state + config to React.
 *
 * v0.3 adaptive polling:
 *  - 250 ms while something is changing (default cadence);
 *  - relaxes to 1 s after ~2 s of identical payloads (idle conversation);
 *  - drops to 3 s while the tab is hidden, snaps back on visibility;
 *  - skips React state updates entirely when the meaningful payload is
 *    unchanged (volatile fields stripped), eliminating 4 re-renders/s of the
 *    whole overlay during long-running tool calls.
 * Also exposes `connected` (false after repeated failures) so the floater can
 * show an offline hint.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";

/** Proactive-care channel payload (v0.4 escalation ladder): bubble-level cares
 *  float above the pet only; card-level ones open the 鲸灵 CareCard. */
export type BuddyCare = {
  text: string;
  ts: number;
  /** Trigger identity (e.g. "rest-reminder") — explainability & snooze input. */
  kind?: string;
  /** i18n suffix under `care.reason.*` explaining why this fired. */
  reasonKey?: string;
  /** Missing level = legacy host = treat as bubble. */
  level?: "bubble" | "card";
  /** letter = long-form (burnout/wind-down): card stays until dismissed. */
  tone?: "normal" | "letter";
};

export type BuddySnapshot = {
  state: string;
  bubble: string;
  bubblePersist?: boolean;
  updatedAt: number;
  counter: number;
  care?: BuddyCare | null;
};

export type BuddySummary = {
  todayTurns: number;
  todayTools: number;
  totalSessions: number;
  /** Continuous active time today (drives rest reminders). */
  todayActiveMs?: number;
};

export type BuddyPet = {
  slug: string;
  displayName: string;
};

export type BuddyConfig = {
  floaterMode: "corner" | "walker";
  visible: boolean;
  companionEnabled: boolean;
  restReminderThresholdMin: number;
  petScale: number;
  skin: "dark" | "light";
  language: "zh" | "en";
  /** Mouse-thief play: steal the idle cursor arrow and run around with it. */
  mouseStealEnabled: boolean;
  /** Idle minutes before the theft triggers. */
  mouseStealIdleMin: number;
  /** 喝水/护眼/起身 micro nudges. */
  careMicroEnabled: boolean;
  /** Festival-flavored greetings. */
  careFestivalEnabled: boolean;
  /** Friendly conversation starters after long silence. */
  careIdleChatEnabled: boolean;
  /** v0.4 D1 global care chattiness (quiet/gentle/normal/attentive). */
  careIntensity?: string;
  windDownEnabled?: boolean;
  windDownHour?: number;
  /** Host-side event sounds (B1-2). */
  soundEnabled?: boolean;
  soundVolume?: number;
  bindings: Record<string, string>;
  chat: {
    provider: "ollama" | "openai" | "gemini" | "off";
    baseUrl: string;
    apiKey: string;
    /** The host keeps the actual secret server-side and exposes only this flag. */
    hasApiKey?: boolean;
    model: string;
    /** Fast-reply mode: skip reasoning when the model offers efforts. */
    disableThinking?: boolean;
  };
  personality: {
    preset: string;
    customPrompt: string;
    constraints: string[];
    /** B2-4 tone dials 0–100 (may be absent on hosts older than the feature). */
    traits?: { sarcasm: number; enthusiasm: number; chattiness: number; humor: number; gentleness: number };
  };
  pomodoro: {
    workMin: number;
    breakMin: number;
  };
  growth: {
    llmEnabled: boolean;
  };
};

/** Compact growth summary embedded in the pet snapshot (floater atmosphere). */
export type SnapshotGrowth = {
  level: number;
  xp: number;
  levelProgress: number;
  bond: number;
  /** Cumulative head-pat intimacy (user-initiated affection). */
  intimacy?: number;
  mood: string;
  energy: number;
  intensity: number;
  intensityLevel: string;
  streakDays: number;
  primaryCareer: string | null;
  title: string | null;
  userTypeLabel: string | null;
};

/** B2-2 economy slice of the snapshot (wallet + worn cosmetic). */
export type SnapshotEconomy = {
  coins: number;
  snacks: number;
  toys: number;
  accessories: string[];
  equipped: string | null;
};

/** B3-2 parallel-session slice (from the agents-poller observation). */
export type SnapshotSessions = {
  running: number;
  subagents: number;
  total: number;
  /** Longest continuous running stretch (B3-3 coach input; may be absent). */
  longestRunningMs?: number;
};

/** B3-3 model context capacity — present only when the host probe succeeded. */
export type SnapshotContext = {
  provider: string;
  model: string;
  contextWindow: number;
};

export type SnapshotResponse = {
  ok: boolean;
  snapshot: BuddySnapshot;
  summary: BuddySummary;
  pet: BuddyPet | null;
  config: BuddyConfig;
  growth?: SnapshotGrowth;
  economy?: SnapshotEconomy;
  sessions?: SnapshotSessions | null;
  context?: SnapshotContext | null;
};

const BASE_MS = 250;
const IDLE_MS = 1000;
const HIDDEN_MS = 3000;
/** Consecutive unchanged polls before relaxing to IDLE_MS (~2 s at 250 ms). */
const IDLE_AFTER_UNCHANGED = 8;
/** Consecutive failures before the UI is flagged offline. */
const OFFLINE_AFTER = 3;

/** Stable fingerprint of the meaningful payload (volatile fields stripped). */
function fingerprint(json: SnapshotResponse): string {
  const s = json.snapshot;
  return [
    s.state,
    s.bubble,
    s.bubblePersist ? 1 : 0,
    s.care ? `${s.care.ts}|${s.care.text}|${s.care.level ?? "bubble"}` : "-",
    json.pet?.slug ?? "-",
    // These objects contain no volatile timestamps. Hashing their complete
    // public shape prevents settings such as language/model/care intensity and
    // less-visible growth fields from staying stale in another React root.
    JSON.stringify(json.summary ?? null),
    JSON.stringify(json.config ?? null),
    JSON.stringify(json.growth ?? null),
    // B2-2: coin chip + worn accessory must re-render when they change.
    JSON.stringify(json.economy ?? null),
    // B3-2: session orbs react to parallel/subagent activity. The coach timer
    // is bucketed to whole minutes so a growing duration doesn't dirty every
    // poll (the chip only needs minute resolution).
    json.sessions
      ? `${json.sessions.running}|${json.sessions.subagents}|${Math.floor((json.sessions.longestRunningMs ?? 0) / 60000)}`
      : "-",
    // B3-3: capacity chip re-renders when the resolved route changes.
    json.context ? `${json.context.model}|${json.context.contextWindow}` : "-",
  ].join("~");
}

type SnapshotStoreState = {
  data: SnapshotResponse | null;
  error: string | null;
  connected: boolean;
};

// All React roots share one transport. Previously every settings tab started
// its own polling loop, multiplying identical snapshot requests while open.
let storeState: SnapshotStoreState = { data: null, error: null, connected: true };
let storeFingerprint = "";
let storeUnchanged = 0;
let storeFailures = 0;
let storePolling = false;
let storeTimer: ReturnType<typeof setTimeout> | null = null;
const storeSubscribers = new Map<symbol, { intervalMs: number; listener: () => void }>();

function emitStore(): void {
  for (const { listener } of storeSubscribers.values()) listener();
}

function requestedInterval(): number {
  let interval = IDLE_MS;
  for (const sub of storeSubscribers.values()) interval = Math.min(interval, sub.intervalMs);
  return Math.max(100, interval);
}

function nextStoreDelay(): number {
  if (typeof document !== "undefined" && document.hidden) return HIDDEN_MS;
  return storeUnchanged >= IDLE_AFTER_UNCHANGED ? IDLE_MS : requestedInterval();
}

function scheduleStorePoll(delay: number): void {
  if (storeTimer) clearTimeout(storeTimer);
  if (storeSubscribers.size === 0) {
    storeTimer = null;
    return;
  }
  storeTimer = setTimeout(() => void pollStore(), delay);
}

async function pollStore(): Promise<void> {
  if (storePolling || storeSubscribers.size === 0) return;
  storePolling = true;
  try {
    const res = await fetch("/api/dshbuddy/snapshot", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    const json = (await res.json()) as SnapshotResponse;
    storeFailures = 0;
    const fp = fingerprint(json);
    const changed = fp !== storeFingerprint;
    if (changed) {
      storeFingerprint = fp;
      storeUnchanged = 0;
    } else {
      storeUnchanged += 1;
    }
    if (changed || storeState.error !== null || !storeState.connected) {
      storeState = { data: changed ? json : storeState.data, error: null, connected: true };
      emitStore();
    }
  } catch (err) {
    storeFailures += 1;
    const next = {
      ...storeState,
      error: String((err as Error).message ?? err),
      connected: storeFailures < OFFLINE_AFTER,
    };
    if (next.error !== storeState.error || next.connected !== storeState.connected) {
      storeState = next;
      emitStore();
    }
  } finally {
    storePolling = false;
    scheduleStorePoll(nextStoreDelay());
  }
}

function onStoreVisibility(): void {
  if (typeof document !== "undefined" && !document.hidden) scheduleStorePoll(60);
}

function subscribeStore(token: symbol, intervalMs: number, listener: () => void): () => void {
  const first = storeSubscribers.size === 0;
  storeSubscribers.set(token, { intervalMs, listener });
  if (first) {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onStoreVisibility);
    scheduleStorePoll(0);
  }
  return () => {
    storeSubscribers.delete(token);
    if (storeSubscribers.size === 0) {
      if (storeTimer) clearTimeout(storeTimer);
      storeTimer = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onStoreVisibility);
    }
  };
}

function getStoreSnapshot(): SnapshotStoreState {
  return storeState;
}

export function useBuddySnapshot(intervalMs = BASE_MS): SnapshotStoreState {
  const token = useRef(Symbol("buddy-snapshot"));
  const subscribe = useCallback(
    (listener: () => void) => subscribeStore(token.current, intervalMs, listener),
    [intervalMs],
  );
  return useSyncExternalStore(subscribe, getStoreSnapshot, getStoreSnapshot);
}

/** POST a JSON body to a buddy endpoint; returns parsed JSON or null. */
export async function buddyPost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`/api/dshbuddy/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function buddyGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`/api/dshbuddy/${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
