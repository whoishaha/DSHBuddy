/**
 * DSHBuddy host half — Cordis plugin body.
 *
 * - Subscribes to host `session/event` frames and drives:
 *     PetStateMachine (9-state pet) + StatsCollector (single-DSH stats)
 *     GrowthEngine (XP/level/bond/mood/energy/intensity — growth.json)
 *     CareerEngine (six-career evolution — career.json)
 *     MemoryEngine (LLM daily summaries / milestones / timeline — memory.json)
 *     ProfileEngine (LLM user-type portrait — profile.json)
 * - Registers an HTTP route on the DSH webserver (`/api/dshbuddy/*`) that the
 *   browser half polls/fetches same-origin (snapshot, pets, sprite, stats,
 *   config, chat proxy, notes, calendar, growth).
 * - Manages pets (list / active / starter whale) and config persistence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PetStateMachine } from "./events.js";
import { RUNTIME_DIR } from "./paths.js";
import { StatsCollector } from "./stats.js";
import { ConfigStore } from "./store.js";
import {
  activePetSpriteDataUrl,
  ensureStarterPet,
  findPetDir,
  getActivePet,
  installPetToRoots,
  listPets,
  writeActive,
} from "./pets.js";
import { GrowthEngine, computeLevel, intensityLevelOf } from "./growth.js";
import { CareerEngine, CAREERS, CAREER_LABELS, CAREER_EN } from "./career.js";
import { MemoryEngine, type DailyFacts, type GrowthFacts, type LlmAsk } from "./memory.js";
import { ProfileEngine, USER_TYPES, type HabitFacts } from "./profile.js";
import { CompanionEngine, type CareSnapshot } from "./companion.js";
import { CareState } from "./care-state.js";
import { festivalOf } from "./festivals.js";
import { OrdersEngine, buildOrderPrompt, looksLikeWorkOrder, type WorkOrder } from "./orders.js";
import { SessionWatcher } from "./session-watcher.js";
import { ContextProbe, type ContextCapacity } from "./context-probe.js";
import { AchievementEngine, ACHIEVEMENTS, ACH_CATEGORIES, collectionMetrics, type AchMetrics } from "./achievements.js";
import { EconomyEngine, SHOP } from "./economy.js";
import { SelfcareEngine } from "./selfcare.js";
import { PomodoroEngine } from "./pomodoro.js";
import { SoundFx } from "./soundfx.js";
import { askLlm, buildPersonalityPrompt, chatViaDsh, llmServices, proxyChat, type BuddyCtx } from "./llm.js";

// ── work-order in-process launcher (structural minimal typing) ─────────────

type OrderAgent = {
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
  session: unknown;
};
type OrderWorkspace = {
  path: string;
  attachSession(sessionId: string): Promise<void>;
};
type OrderServices = {
  agents: {
    create(options: {
      sessionId: string;
      meta: { cwd: string };
      agentOptions: { provider: string; model: string };
    }): Promise<{ agent: OrderAgent }>;
  };
  sessions: { flush(session: unknown): Promise<boolean> };
  workspaces: {
    resolveByPath(path: string): Promise<OrderWorkspace | undefined>;
    create(path: string): Promise<OrderWorkspace>;
  };
  modelSelection: { currentSelection(): { provider: string; model: string } };
};

/** Build the in-process order launcher when every needed host service exists. */
function resolveOrderServices(ctx: HostContext): OrderServices | null {
  const agents = ctx.get<OrderServices["agents"]>("agents");
  const sessions = ctx.get<OrderServices["sessions"]>("sessions");
  const workspaces = ctx.get<OrderServices["workspaces"]>("workspaceRegistry");
  const modelSelection = ctx.get<OrderServices["modelSelection"]>("agentDefaultModel");
  return agents && sessions && workspaces && modelSelection
    ? { agents, sessions, workspaces, modelSelection }
    : null;
}

/** Minimal cordis context shape the host half uses (type-only). */
type HostContext = BuddyCtx & {
  on(name: string, cb: (...args: any[]) => void): void;
};

type WebServerService = {
  register(route: {
    path: string;
    kind?: "exact" | "prefix";
    handler: (req: IncomingMessage, res: ServerResponse) => void;
  }): () => void;
};

const API_PREFIX = "/api/dshbuddy";
const POLL_INTERVAL_MS = 100;
const WEBSERVER_RETRY_MS = 2000;
const WEBSERVER_MAX_RETRIES = 15;

export const name = "dshbuddy";

/** Hard dependency on the dsh webserver service (also declared in cordis.patch.yml). */
export const inject = ["webServer"];

/** Module-level ctx captured at apply() so routes can reach DSH llm services. */
let currentCtx: HostContext | null = null;

export function apply(ctx: HostContext) {
  currentCtx = ctx;
  const machine = new PetStateMachine(() => {
    // snapshot changed — nothing to do server-side; the client polls.
  });
  const stats = new StatsCollector();
  const config = new ConfigStore();

  // ── growth system engines (design doc G1–G5) ────────────────────────────
  const growth = new GrowthEngine();
  const career = new CareerEngine();
  const memory = new MemoryEngine();
  const profile = new ProfileEngine();

  // ── B2-1: achievement badge wall — thresholds over signals we already track.
  const achievements = new AchievementEngine();

  // v0.4 F1 — dream-bubble throttling. A dream is something the pet "sees"
  // between sessions, NOT a care action: no level escalation, no cooldowns,
  // no card opens. The 20-min floor keeps it rare enough to feel uncanny.
  let lastDreamAt = 0;
  const DREAM_MIN_INTERVAL_MS = 20 * 60 * 1000;

  // ── B2-2: coin economy (earn from real outcomes → tiny cosmetic shop).
  const economy = new EconomyEngine();
  // ── v0.4 batch C: mutual self-care (quests / breath / mood check-in).
  const selfcare = new SelfcareEngine();
  const pomodoro = new PomodoroEngine(config.get().pomodoro.workMin, config.get().pomodoro.breakMin);

  // ── B3-3: model context capacity probe (defensive — null until the llm
  // service discloses a contextWindow for the current default model route).
  const contextProbe = new ContextProbe({ services: () => llmServices(ctx) });
  let contextMemo: ContextCapacity | null = null;
  const refreshContext = () => {
    void contextProbe.current().then((cap) => {
      contextMemo = cap;
    });
  };
  // First pass once the shell services settle, then re-check occasionally so a
  // model switch updates the chip without any polling pressure.
  const contextTimer = setInterval(refreshContext, 10 * 60 * 1000);
  void contextTimer.unref?.();
  setTimeout(refreshContext, 4000).unref?.();

  ensureStarterPet();

  // One-time welcome bubble. The flag is TOP-LEVEL in the config (safe under
  // the shallow merge) and we show-then-mark, so a crash between the two steps
  // just shows the welcome once more.
  if (!config.get().welcomeShown) {
    const lang = config.get().language;
    const petName = getActivePet()?.displayName ?? "DSHBuddy";
    const welcome =
      lang === "en" ? `Hi! I'm ${petName} — click me to explore!`
      : `你好，我是${petName}，点我可以打开菜单哦～`;
    machine.setBubble(welcome, true);
    config.patch({ welcomeShown: true });
  }

  const queueTimer = setInterval(() => {
    machine.tick();
  }, POLL_INTERVAL_MS);

  // ── proactive caring (CompanionEngine: usage records + current state) ───
  const buddyMemory = readBuddyMemory();
  // One-shot / frequency-anchor bookkeeping for the relational cares (v0.4).
  const careState = new CareState();

  /** Bound LLM ask (DSH llm → legacy chat → null); engines fall back offline. */
  const llmAsk: LlmAsk = (prompt, opts) =>
    askLlm(ctx, config.get().chat, prompt, { system: opts?.system, maxLength: opts?.maxLength });

  // Track when the last REAL session event arrived (any type, any session):
  // powers the companion's "user has been silent for a while" reach-out.
  let lastRealEventAt = Date.now();

  const companion = new CompanionEngine(
    (text, _persist, meta) => machine.setCare(text, meta),
    (kind, text) => appendCare(kind, text),
    llmAsk,
    () => config.get().growth.llmEnabled,
    () => ({
      companionEnabled: config.get().companionEnabled,
      restReminderThresholdMin: config.get().restReminderThresholdMin,
      careMicroEnabled: config.get().careMicroEnabled,
      careFestivalEnabled: config.get().careFestivalEnabled,
      careIdleChatEnabled: config.get().careIdleChatEnabled,
      careIntensity: config.get().careIntensity,
      language: config.get().language,
      personality: config.get().personality,
    }),
    () => buildCareSnapshot(growth, career, stats, profile, buddyMemory, selfcare),
    () => Date.now() - lastRealEventAt,
    // Flow guard input: longest continuously-running agent right now.
    () => sessionWatcher.healthInfo().lastObservation?.longestRunningMs ?? 0,
    // Cross-restart anchors for the relational checkers (echo / pattern).
    {
      get: (key) => careState.getLastDay(key),
      set: (key, day) => careState.setLastDay(key, day),
    },
    // v0.4 D3 boundary trust: 「晚点再说」learning feeds the cooldown ladder.
    {
      getSnoozeCount: (kind) => careState.snoozeCount(kind),
      recordSnooze: (kind) => void careState.recordSnooze(kind),
    },
  );

  // Periodic companion check (rest reminder / day summary) independent of events.
  const companionTimer = setInterval(() => companion.tick(), 60 * 1000);
  void companionTimer.unref?.();

  // ── v0.4 batch B3: anniversaries ─────────────────────────────────────────
  // Days-together milestones and cumulative tool-call records fire ONCE ever
  // (care-state seenKeys), grant coins, land in the growth timeline + memory
  // milestones, and open the 鲸灵 card with a celebratory message.
  const ANNIV_DAYS: [number, number][] = [
    [7, 20],
    [30, 50],
    [100, 150],
    [365, 500],
  ];
  const TOOL_MILESTONES: [number, number][] = [
    [1_000, 30],
    [10_000, 80],
  ];
  const anniversaryTimer = setInterval(() => {
    const lang = config.get().language;
    const today = dayStrLocal(Date.now());
    const celebrate = (titleZh: string, titleEn: string, text: string, key: string, descEn: string, coins: number) => {
      economy.earn(coins);
      const title = lang === "en" ? titleEn : titleZh;
      memory.addMilestone(key, "anniversary", title, descEn);
      memory.addTimeline(today, title, `${descEn}（+${coins} 🪙）`, "milestone");
      machine.setCare(text, { kind: "anniversary", reasonKey: key, level: "card" });
      appendCare("anniversary", text);
    };
    const firstSeen = growth.getData().firstSeen || Date.now();
    const daysTogether = Math.floor((Date.now() - firstSeen) / (24 * 3600 * 1000));
    for (const [d, coins] of ANNIV_DAYS) {
      const key = `anni-${d}`;
      if (daysTogether < d || careState.has(key)) continue;
      careState.mark(key);
      celebrate(
        `同行 ${d} 天`,
        `${d}-day anniversary`,
        lang === "en"
          ? `🎉 Day ${d} together! Thank you for sticking around — +${coins} coins as a keepsake 🪙`
          : `🎉 今天是我们同行的第 ${d} 天！谢谢你一直陪着我，这 ${coins} 金币是给你的纪念礼物 🪙`,
        key,
        lang === "en" ? `Spent ${d} days together` : `与主人同行满 ${d} 天`,
        coins,
      );
      break; // at most one celebration per tick
    }
    let totalTools = 0;
    for (const d of Object.values(stats.getStats().days)) totalTools += d.toolCalls ?? 0;
    for (const [n, coins] of TOOL_MILESTONES) {
      const key = `tools-${n}`;
      if (totalTools < n || careState.has(key)) continue;
      careState.mark(key);
      celebrate(
        `累计工具调用破 ${n}`,
        `${n} tool calls`,
        lang === "en"
          ? `🔨 We just crossed ${n} tool calls together! +${coins} coins 🪙`
          : `🔨 我们的累计工具调用突破 ${n} 次啦！这 ${coins} 金币请你收下 🪙`,
        key,
        lang === "en" ? `Lifetime tool calls passed ${n}` : `累计工具调用突破 ${n} 次`,
        coins,
      );
      break;
    }
  }, 60 * 1000);
  void anniversaryTimer.unref?.();

  // ── v0.4 batch E: burnout guardrails ─────────────────────────────────────
  // E1 过劳预警信 — streak ≥6d + late nights + rising error rate → one long
  // letter-style card per week max, evening only. E2 下线仪式 — at the
  // configured hour, offer a wrap-up and draft tomorrow's todos from the
  // calendar + unfinished notes.
  const guardianTimer = setInterval(() => {
    void (() => {
      const now = new Date();
      const h = now.getHours();
      const nowMs = now.getTime();
      const today = dayStrLocal(nowMs);

      // Late-night day marking: input signal for the burnout letter. Runs in
      // its own window (23:00–02:00) so sessions crossing midnight still count.
      if ((h >= 23 || h < 2) && (stats.getStats().days[today]?.turns ?? 0) > 0) careState.markLateDay(today);

      // The two rituals below are an evening-only channel (19:00–24:00).
      if (h < 19 || h >= 24) return;

      const lang = config.get().language === "en" ? "en" : "zh";
      const days = stats.getStats().days;
      const g = growth.getData();

      // ── E2 wind-down ritual ──
      const cfgNow = config.get();
      if (cfgNow.windDownEnabled !== false && !careState.has(`winddown-${today}`)) {
        const wdHour = Math.min(23, Math.max(19, Math.round(cfgNow.windDownHour ?? 21)));
        if (h >= wdHour && (days[today]?.activeMs ?? 0) >= 30 * 60 * 1000) {
          careState.mark(`winddown-${today}`);
          // Draft tomorrow: calendar entries + up to five unfinished notes.
          const tm = new Date(nowMs + 24 * 3600 * 1000);
          const tomorrow = dayStrLocal(tm.getTime());
          const calItems = readCalendar(tm.getFullYear(), tm.getMonth() + 1)
            .filter((e) => e.date === tomorrow)
            .map((e) => `${e.startTime} ${e.note}`.trim());
          const noteItems = readNotes()
            .filter((n) => !n.done)
            .slice(0, 5)
            .map((n) => n.text);
          const drafts = [...calItems, ...noteItems].slice(0, 8);
          for (const item of drafts) {
            mutateNotes("add", { text: `📌 明日·${item}` });
          }
          const preview = drafts.slice(0, 3).map((s) => `· ${s}`).join("\n");
          const more = drafts.length > 3 ? (lang === "en" ? `\n· …and ${drafts.length - 3} more` : `\n· …等共 ${drafts.length} 件`) : "";
          const wdText =
            lang === "en"
              ? `🌙 It's wind-down time. Shall we call it a day? I drafted ${drafts.length} thing(s) for tomorrow into your notes:\n${preview}${more}`
              : `🌙 到收尾时间啦，今天要不要到这里？我把明天的事先列进待办了（草稿，可删）：\n${preview}${more}`;
          machine.setCare(wdText, { kind: "wind-down", reasonKey: "wind-down", level: "card" });
          appendCare("wind-down", wdText);
        }
      }

      // ── E1 burnout letter (≤1/week via ISO-week seen-key) ──
      const weekSeenKey = `burnout-${isoWeekKey(nowMs)}`;
      if (!careState.has(weekSeenKey) && g.streakDays >= 6) {
        // Late nights: ≥2 of the last 3 marked days.
        const lateDays = careState.lateDaysList();
        let lateRecent = 0;
        for (let i = 1; i <= 3; i++) {
          if (lateDays.includes(dayStrLocal(nowMs - i * 24 * 3600 * 1000))) lateRecent += 1;
        }
        // Error-rate rise: last 3 full days vs the 7 before them.
        let e3 = 0;
        let t3 = 0;
        let e7 = 0;
        let t7 = 0;
        for (let i = 1; i <= 3; i++) {
          const d = days[dayStrLocal(nowMs - i * 24 * 3600 * 1000)];
          e3 += d?.errors ?? 0;
          t3 += d?.turns ?? 0;
        }
        for (let i = 4; i <= 10; i++) {
          const d = days[dayStrLocal(nowMs - i * 24 * 3600 * 1000)];
          e7 += d?.errors ?? 0;
          t7 += d?.turns ?? 0;
        }
        const rate3 = t3 >= 6 ? e3 / t3 : null; // need a real sample to accuse
        const rate7 = t7 > 0 ? e7 / t7 : 0;
        if (lateRecent >= 2 && rate3 !== null && rate3 >= 0.15 && rate3 > rate7 * 1.3) {
          careState.mark(weekSeenKey);
          const prompt =
            lang === "en"
              ? `Your owner has been working 6+ days in a row, stayed up past 11pm at least ${lateRecent} of the last 3 days, and their error rate is rising (${Math.round(rate3 * 100)}% vs ${Math.round(rate7 * 100)}% before). Write a SHORT warm letter (max ~110 words): acknowledge the effort, name what you noticed gently, suggest considering a rest day tomorrow. No lecturing, no productivity advice; the LAST sentence must be pure care, not a suggestion.`
              : `主人已经连续工作超过 6 天，最近 3 天里有 ${lateRecent} 天熬到了深夜，错误率也在上升（${Math.round(rate3 * 100)}%，此前为 ${Math.round(rate7 * 100)}%）。请写一封简短的关心短信（不超过 120 字）：肯定 TA 的投入，温柔说出你观察到的信号，建议考虑明天给自己放个假。不说教、不给效率建议；最后一句必须是纯粹的关心而不是建议。`;
          const fallback =
            lang === "en"
              ? `You've been carrying this for days straight — I can see the errors piling up and the nights getting longer.\nCode will wait for you; your body won't. How about a real rest day tomorrow?\nWhatever you decide, sleep early tonight. I'm right here 🐋`
              : `你已经连续撑了好几天了——我看得到报错在变多，夜晚也越来越长。\n代码会等你，身体不会。要不要考虑明天给自己放个假？\n不管怎么决定，今晚都早点睡，我一直在的 🐋`;
          void llmAsk(prompt, {
            system:
              lang === "en"
                ? "You are DSHBuddy, a pet whale accompanying its owner through work. Write with sincere warmth, never lecture."
                : "你是 DSHBuddy，一只陪伴主人工作的宠物鲸鱼。语气真诚温暖，绝不说教。",
            maxLength: 220,
          }).then((reply) => {
            const text = reply || fallback;
            machine.setCare(text, { kind: "burnout-letter", reasonKey: "burnout", level: "card", tone: "letter" });
            appendCare("burnout-letter", text);
          });
        }
      }
    })();
  }, 60 * 1000);
  void guardianTimer.unref?.();

  // ── 鲸灵 (JingLing) work-order scheduler ─────────────────────────────────
  const orders = new OrdersEngine();
  // Heal the care log first: drop「收到工作单」entries whose order is gone
  // (deleted by the user, or left over from non-isolated test runs).
  sweepStaleOrderCareLogs(orders.list().map((o) => o.task));

  // In-process launcher: when the web host exposes its agent/workspace
  // services, a due order creates a REAL session (cwd = workspace path,
  // attached to the existing workspace → grouped in the GUI like any
  // hand-made session) and drives one plan-first task through it. Without
  // those services the engine falls back to the detached headless CLI.
  const orderServices = resolveOrderServices(ctx);
  if (orderServices) {
    orders.setLauncher(async (order) => {
      const { agents, sessions, workspaces, modelSelection } = orderServices;
      // Resolve (or register) the requested workspace so the new session is
      // grouped under it; fall back to the current process directory.
      let cwd = process.cwd();
      let workspace: OrderWorkspace | undefined;
      if (order.workspace && existsSync(order.workspace)) {
        workspace = (await workspaces.resolveByPath(order.workspace)) ?? (await workspaces.create(order.workspace));
        cwd = workspace.path;
      }
      const selection = modelSelection.currentSelection();
      const sessionId = `session-${randomUUID()}`;
      const { agent } = await agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
      });
      // Group under the workspace; membership validates header cwd === path.
      if (workspace) {
        try {
          await workspace.attachSession(sessionId);
        } catch {
          // non-fatal: the session still runs, just shows ungrouped
        }
      }
      await agent.whenIdle();
      agent.followup({
        id: `dshbuddy-order-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text: buildOrderPrompt(order) }],
        source: { kind: "user" },
      });
      await agent.whenIdle();
      await sessions.flush(agent.session);
    });
  }

  orders.onLaunch = (o) => {
    machine.setBubble(`🚀 ${o.task.slice(0, 26)}…`, true);
    appendCare("order-launch", `开始执行工作单：${o.task}`);
  };
  orders.onFinish = (o) => {
    if (o.status === "done") {
      machine.setBubble(`✅ 工作单完成：${o.task.slice(0, 24)}…`, false);
      achievements.bumpCounter("ordersDone");
      economy.earn(20); // B2-2: work-order payout
      runAchCheck();
    } else {
      machine.setBubble(`⚠️ 工作单失败（${o.error ?? "?"}）`, false);
    }
    appendCare("order-finish", `工作单「${o.task.slice(0, 40)}」状态：${o.status}${o.error ? ` (${o.error})` : ""}`);
  };
  const ordersTimer = setInterval(() => orders.tick(), 30 * 1000);
  void ordersTimer.unref?.();
  pomodoro.onWorkComplete = (minutes) => {
    stats.logPomodoro(minutes);
    economy.earn(5);
    runAchCheck();
    machine.setBubble(`🍅 专注 ${minutes} 分钟完成，休息一下吧`, false);
  };
  const pomodoroTimer = setInterval(() => pomodoro.tick(), 1000);
  void pomodoroTimer.unref?.();

  // ── B1-2: host-side tiered event sounds (OS audio, survive browser mute) ──
  const sound = new SoundFx();
  const syncSoundConfig = () => {
    sound.configure({ enabled: config.get().soundEnabled, volume: (config.get().soundVolume ?? 70) / 100 });
  };
  syncSoundConfig();

  // ── growth-system wiring ─────────────────────────────────────────────────

  // Level-up → celebrate bubble (milestone records are only created for the
  // milestone levels 5/10/20/50, via delta.milestones — not every level).
  growth.onLevelUp = (level) => {
    machine.setBubble(`🎉 升级到 Lv.${level}！`, true);
    companion.onMilestone(`升级到 Lv.${level}`);
    economy.earn(level * 10); // B2-2: level-up bonus
    runAchCheck();
  };

  // ── B2-1 achievement wiring: score the badge wall against lifetime totals.
  /** Aggregate lifetime numbers badges are scored against. */
  const collectAchMetrics = (): AchMetrics => {
    const g = growth.getData();
    const s = stats.getStats();
    let toolCalls = 0;
    let pomoMinutes = 0;
    // Weekend-warrior badge: distinct Sat/Sun dates that saw any real turn.
    const weekendDates = new Set<string>();
    for (const [date, d] of Object.entries(s.days)) {
      toolCalls += d.toolCalls ?? 0;
      pomoMinutes += d.pomoMin ?? 0;
      if ((d.turns ?? 0) > 0) {
        const wd = new Date(`${date}T12:00:00`).getDay(); // noon avoids TZ edges
        if (wd === 0 || wd === 6) weekendDates.add(date);
      }
    }
    return {
      tasksCompleted: g.tasksCompleted,
      toolCalls,
      errorsRecovered: g.errorsRecovered,
      totalApprovals: g.totalApprovals,
      totalSubagents: g.totalSubagents,
      intimacy: g.intimacy,
      level: g.level,
      streakDays: g.streakDays,
      bestStreak: g.bestStreak,
      pomoMinutes,
      activeDays: s.rhythm.activeDays ?? 0,
      prestigeCount: g.prestigeCount ?? 0,
      earnedTotal: economy.getData().earnedTotal,
      ...collectionMetrics(listPets().map((p) => p.slug)),
      weekendDays: weekendDates.size,
    };
  };
  achievements.onUnlock = (id) => {
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    const en = config.get().language === "en";
    const label = def ? (en ? def.name.en : def.name.zh) : id;
    machine.setBubble(`🏅 ${label}`, true);
    companion.onMilestone(en ? `Achievement unlocked: ${label}` : `成就解锁：${label}`);
    memory.addMilestone(`ach-${id}`, "achievement", `🏅 ${def?.name.zh ?? id}`, def?.desc.zh ?? "");
    economy.earn(10); // B2-2: badge bonus
  };
  /** One cheap evaluation pass (pure threshold compares; safe anywhere). */
  const runAchCheck = () => {
    try {
      achievements.check(collectAchMetrics());
    } catch {
      // never let badge scoring break the event chain
    }
  };

  // Day rollover → career snapshot + LLM daily summary + weekly report/profile/growth-narrative.
  growth.onDayRollover = (from, to) => {
    career.snapshotDay(from);
    const summary = buildDailyFacts(from, growth, career, stats);
    void memory.generateDailySummary(summary, llmAsk, config.get().growth.llmEnabled).then(() => {
      maybeGenerateWeeklyReport();
      maybeGenerateGrowthSummary();
    });
    maybeRegenerateProfile();
  };

  /** LLM growth narrative, regenerated weekly from the user's habits. */
  let lastNarrativeAt = memory.getData().growthSummaries[0]?.createdAt ?? 0;
  const maybeGenerateGrowthSummary = () => {
    const now = Date.now();
    if (now - lastNarrativeAt < 7 * 24 * 3600 * 1000) return;
    lastNarrativeAt = now;
    void memory.generateGrowthSummary(buildGrowthFacts(growth, career, stats, profile), llmAsk, config.get().growth.llmEnabled);
  };

  /** Weekly report on the 7th day boundary since the last report. */
  let lastWeeklyAt = memory.getData().weeklyReports[0]?.createdAt ?? 0;
  const maybeGenerateWeeklyReport = () => {
    const now = Date.now();
    if (now - lastWeeklyAt < 7 * 24 * 3600 * 1000) return;
    lastWeeklyAt = now;
    const days = lastNDays(7, growth, career, stats).filter((d) => d.tasks > 0 || d.intensity > 0);
    if (days.length === 0) return;
    void memory.generateWeeklyReport(
      {
        start: days[0]?.date ?? "",
        end: days[days.length - 1]?.date ?? "",
        days,
        totalIntensity: days.reduce((s, d) => s + d.intensity, 0),
        topTools: topToolsOf(stats),
      },
      llmAsk,
      config.get().growth.llmEnabled,
    );
  };

  /** Profile (user-type portrait) once a week or when it doesn't exist yet. */
  const maybeRegenerateProfile = () => {
    const existing = profile.getProfile();
    const now = Date.now();
    if (existing && now - existing.updatedAt < 7 * 24 * 3600 * 1000) return;
    const facts = buildHabitFacts(growth, career, stats);
    void profile.regenerate(facts, career.getData(), llmAsk, config.get().growth.llmEnabled).then((p) => {
      if (p && (!existing || p.userType !== existing.userType)) {
        memory.addTimeline(dayStrLocal(now), `画像：${p.typeLabel}`, p.summary.slice(0, 120), "profile");
      }
    });
  };

  // Startup backfill: generate missing daily summaries for the last 3 days
  // (design: 启动时补生成缺失日期; limited to avoid a burst of LLM calls).
  const backfillSummaries = () => {
    if (!config.get().growth.llmEnabled) return;
    const g = growth.getData();
    const dates = lastNDays(3, growth, career, stats).map((d) => d.date);
    for (const date of dates) {
      if (date === g.today) continue;
      if (memory.getSummary(date)) continue;
      void memory.generateDailySummary(buildDailyFacts(date, growth, career, stats), llmAsk, true);
    }
  };
  setTimeout(backfillSummaries, 5000).unref?.();

  // Startup catch-up: score the badge wall once so achievements already
  // earned by lifetime totals surface on the first run after upgrade.
  setTimeout(runAchCheck, 6000).unref?.();

  // Hourly timer: detect day rollover even without events at midnight.
  const rolloverTimer = setInterval(() => {
    growth.checkDayRollover();
  }, 60 * 60 * 1000);
  void rolloverTimer.unref?.();

  // Host session/event subscription: every session's log frames.
  // Per-session marker: the current turn used at least one tool (drives the
  // task-done chime so pure-chat turns stay silent).
  const turnHadTool = new Set<string>();
  ctx.on("session/event", (session: { id: string }, event: { type: string; data?: Record<string, unknown>; time?: number }) => {
    lastRealEventAt = Date.now();
    machine.feed(session.id, event);
    stats.feed(session.id, event);
    // ── growth chain: GrowthEngine computes decayed deltas → CareerEngine
    //    applies them; milestones/level-up bubble handled via callbacks. ──
    const before = career.getData();
    const prevPrimary = before.primary;
    const prevTitle = before.title;
    const delta = growth.feed(session.id, event);
    if (Object.keys(delta.careerDeltas).length) {
      career.applyDeltas(delta.careerDeltas, event.time ?? Date.now());
    }
    const after = career.getData();
    if (after.primary && after.primary !== prevPrimary) {
      const fromLabel = prevPrimary ? CAREER_LABELS[prevPrimary] : "综合";
      const toLabel = CAREER_LABELS[after.primary];
      const date = dayStrLocal(Date.now());
      const title = `职业方向：${toLabel}`;
      memory.addTimeline(date, title, `主导职业从 ${fromLabel} 变为 ${toLabel}（${CAREER_EN[after.primary]}）`, "career");
      // LLM narrative explaining the shift (fallback keeps the template text).
      void memory.enrichTimeline(
        title,
        `主人的主导职业最近从「${fromLabel}」转变为「${toLabel}」。请结合习惯数据用一两句中文说明这次转变意味着什么。\n${habitPrompt(growth, career, stats, profile)}`,
        llmAsk,
        config.get().growth.llmEnabled,
      );
    }
    if (after.title && after.title !== prevTitle) {
      const title = `解锁称号 ${after.title}`;
      memory.addMilestone(`title-${after.title}`, "title", title, `主副职业 ${CAREER_LABELS[after.primary ?? "builder"]}+${CAREER_LABELS[after.secondary ?? "debugger"]} 解锁称号。`);
      void memory.enrichMilestone(`title-${after.title}`, habitPrompt(growth, career, stats, profile), llmAsk, config.get().growth.llmEnabled);
      companion.onMilestone(title);
    }
    for (const id of delta.milestones) {
      memory.addMilestone(id, id.split("-")[0], milestoneTitle(id, growth), milestoneDesc(id, growth));
      // LLM-enrich the milestone description from the user's current habits.
      void memory.enrichMilestone(id, habitPrompt(growth, career, stats, profile), llmAsk, config.get().growth.llmEnabled);
      companion.onMilestone(milestoneTitle(id, growth));
    }

    const { type, data = {} } = event;
    // ── B1-2 tiered sounds: only three meaningful events ever beep. ──
    if (type === "tool/call") {
      turnHadTool.add(session.id);
    } else if (type === "tool/result" && toolResultFailed(data)) {
      sound.play("error");
    } else if (type === "approval/asked") {
      sound.play("needs-input");
    } else if (type === "turn/end") {
      const kind = String((data.reason as { kind?: string } | undefined)?.kind ?? "completed");
      // A turn that actually used tools gets the completion chime; pure chat
      // turns stay silent (research: celebrate outcomes, not activity).
      if (kind === "completed" && turnHadTool.delete(session.id)) {
        sound.play("task-done");
      } else {
        turnHadTool.delete(session.id);
      }
    }
    if (type === "user/message") {
      const source = data.source as { kind?: string } | undefined;
      if (source?.kind === "user") {
        companion.onUserActivity(event.time ?? Date.now());
        const text = extractUserText(data);
        if (text) {
          buddyMemory.push({ text, ts: Date.now() });
          if (buddyMemory.length > BUDDY_MEMORY_MAX) buddyMemory.splice(0, buddyMemory.length - BUDDY_MEMORY_MAX);
          writeBuddyMemory(buddyMemory);
        }
      }
    } else if (type === "turn/end") {
      const reason = data.reason as { kind?: string } | undefined;
      const kind = reason?.kind ?? "completed";
      if (kind === "completed") {
        companion.onTaskCompleted();
        economy.earn(2); // B2-2: small payout per completed turn
        // Night-owl / early-bird badges count tasks finished in the deep-night
        // (00–05) and early-morning (05–09) windows respectively.
        const hour = new Date().getHours();
        if (hour < 5) achievements.bumpCounter("nightTurns");
        else if (hour < 9) achievements.bumpCounter("earlyTurns");
        runAchCheck();
      }
    }
  });

  // ── B1-1: agents-service polling fallback ─────────────────────────────────
  // Some deployments never deliver `session/event` frames to dynamically
  // loaded plugins; this watcher polls the live agent registry directly and
  // feeds the machine through its priority-guarded observe() door (it can
  // fill state gaps but never downgrade waiting/failed/review).
  const sessionWatcher = new SessionWatcher({
    listAgents: () => {
      const agents = ctx.get<{ list(): unknown[] }>("agents");
      return agents ? agents.list() : null;
    },
    onObservation: (obs) => {
      if (obs.runningCount > 0) {
        machine.noteBusyObserved();
        machine.observe("running", "agents-poller");
      } else {
        machine.observe("idle", "agents-poller");
      }
    },
    intervalMs: 600,
  });
  sessionWatcher.start();

  // ── HTTP route: the browser half's same-origin data channel ──────────────
  // Register once the webserver service is available (inject declares the hard
  // dependency; the retry loop covers a service that appears slightly later).
  let registered = false;
  let retries = 0;
  const tryRegister = () => {
    if (registered) return;
    const webServer = ctx.get<WebServerService>("webServer");
    if (!webServer) {
      if (retries < WEBSERVER_MAX_RETRIES) {
        retries += 1;
        setTimeout(tryRegister, WEBSERVER_RETRY_MS).unref?.();
      }
      return;
    }
    registered = true;
    const dispose = webServer.register({
      path: API_PREFIX,
      kind: "prefix",
      handler: (req, res) => {
        handleApi(req, res, {
          machine, stats, config, growth, career, memory, profile, llmAsk, companion, orders,
          watcher: sessionWatcher, sound,
          achievements: () => achievements.list(collectAchMetrics()),
          checkAchievements: runAchCheck,
          bumpAchCounter: (name, delta) => {
            try {
              achievements.bumpCounter(name, delta);
            } catch {
              // badge bookkeeping must never fail the request
            }
          },
          economy,
          selfcare,
          pomodoro,
          careState,
          contextCapacity: () => contextMemo,
          dream: {
            getLastAt: () => lastDreamAt,
            setLastAt: (at) => { lastDreamAt = at; },
            minIntervalMs: DREAM_MIN_INTERVAL_MS,
            memory: buddyMemory,
          },
        });
      },
    });
    ctx.on("dispose", dispose);
  };
  tryRegister();

  // Cleanup the tick timers on unload.
  ctx.on("dispose", () => {
    clearInterval(queueTimer);
    clearInterval(rolloverTimer);
    clearInterval(companionTimer);
    clearInterval(anniversaryTimer);
    clearInterval(guardianTimer);
    clearInterval(ordersTimer);
    clearInterval(pomodoroTimer);
    clearInterval(contextTimer);
    sessionWatcher.stop();
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  // Defensive: replying on an already-destroyed socket (e.g. after the >1 MB
  // body guard) used to throw inside async handlers → unhandled rejection.
  try {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(payload);
  } catch {
    // socket gone — nothing to do
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.length ? JSON.parse(text) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

// ── facts builders (structured aggregates for memory/profile LLM prompts) ───

function dayStrLocal(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** ISO-8601 week key, e.g. "2026-W35" — proud-moment / burnout dedupe window. */
function isoWeekKey(nowMs: number): string {
  const d = new Date(nowMs);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (target.getDay() + 6) % 7; // Mon=0..Sun=6
  target.setDate(target.getDate() - dayNum + 3); // nearest Thursday
  const isoYear = target.getFullYear();
  const firstThu = new Date(isoYear, 0, 4);
  const firstDayNum = (firstThu.getDay() + 6) % 7;
  firstThu.setDate(firstThu.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((target.getTime() - firstThu.getTime()) / (7 * 24 * 3600 * 1000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Mirror of events.ts toolResultHasError for the sound trigger. */
function toolResultFailed(data: Record<string, unknown>): boolean {
  if (data.error) return true;
  const message = data.message as { is_error?: boolean; error?: unknown } | null | undefined;
  if (message && typeof message === "object") {
    if (message.is_error === true) return true;
    if (message.error != null) return true;
  }
  return false;
}

function topToolsOf(stats: StatsCollector): [string, number][] {
  const counts: Record<string, number> = {};
  for (const s of Object.values(stats.getStats().sessions)) {
    for (const [n, c] of Object.entries(s.tools ?? {})) counts[n] = (counts[n] ?? 0) + c;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8) as [string, number][];
}

function buildDailyFacts(
  date: string,
  growth: GrowthEngine,
  career: CareerEngine,
  stats: StatsCollector,
): DailyFacts {
  const g = growth.getData();
  const day = stats.getStats().days[date];
  const daily = career.getData().daily[date] ?? {};
  let dominant: DailyFacts["dominantCareer"] = null;
  let best = 0;
  for (const c of CAREERS) {
    const v = daily[c] ?? 0;
    if (v > best) {
      best = v;
      dominant = c;
    }
  }
  return {
    date,
    intensity: g.intensityDays[date] ?? (date === g.today ? g.dailyIntensity : 0),
    tasks: day?.turns ?? 0,
    steps: day?.steps ?? 0,
    tools: day?.toolCalls ?? 0,
    errors: day?.errors ?? 0,
    recovered: g.recoveredDays[date] ?? 0,
    approvals: day?.approvals ?? 0,
    questions: day?.questions ?? 0,
    dominantCareer: dominant,
    topTools: topToolsOf(stats),
  };
}

function lastNDays(n: number, growth?: GrowthEngine, career?: CareerEngine, stats?: StatsCollector): DailyFacts[] {
  const out: DailyFacts[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = dayStrLocal(Date.now() - i * 24 * 3600 * 1000);
    if (growth && career && stats) {
      out.push(buildDailyFacts(date, growth, career, stats));
    } else {
      out.push({
        date,
        intensity: 0,
        tasks: 0,
        steps: 0,
        tools: 0,
        errors: 0,
        recovered: 0,
        approvals: 0,
        questions: 0,
        dominantCareer: null,
        topTools: [],
      });
    }
  }
  return out;
}

function buildHabitFacts(
  growth: GrowthEngine,
  career: CareerEngine,
  stats: StatsCollector,
): HabitFacts {
  const g = growth.getData();
  const statsData = stats.getStats();
  const days = Object.values(statsData.days);
  const totalTurns = days.reduce((s, d) => s + d.turns, 0);
  const totalTools = days.reduce((s, d) => s + d.toolCalls, 0);
  const errors = days.reduce((s, d) => s + d.errors, 0);
  const intensityEntries = Object.entries(g.intensityDays).filter(([d]) => d >= dayStrLocal(Date.now() - 30 * 24 * 3600 * 1000));
  const intensitySum = intensityEntries.reduce((s, [, v]) => s + v, 0);
  const c = career.getData();
  return {
    topTools: topToolsOf(stats),
    totalTurns,
    totalTools,
    errors,
    recovered: g.errorsRecovered,
    approvals: g.totalApprovals,
    questions: g.totalQuestions,
    subagents: g.totalSubagents,
    intensitySum,
    intensityDays: intensityEntries.length || 1,
    career: c.primary,
    tasksCompleted: g.tasksCompleted,
    streakDays: g.streakDays,
    notesCount: readNotes().length,
    calendarCount: (() => {
      try {
        const p = calendarPath();
        if (!existsSync(p)) return 0;
        const raw = JSON.parse(readFileSync(p, "utf8")) as unknown[];
        return Array.isArray(raw) ? raw.length : 0;
      } catch {
        return 0;
      }
    })(),
    chatCount: readChats().reduce((s, conv) => s + conv.messages.length, 0),
  };
}

/** Aggregate facts for the LLM growth narrative (design: 根据习惯分析成长). */
function buildGrowthFacts(
  growth: GrowthEngine,
  career: CareerEngine,
  stats: StatsCollector,
  profile: ProfileEngine,
): GrowthFacts {
  const g = growth.getData();
  const c = career.getData();
  const days = Object.values(stats.getStats().days);
  const eff = stats.efficiency(days);
  const chrono = stats.chronotype();
  const cutoff7 = dayStrLocal(Date.now() - 7 * 24 * 3600 * 1000);
  const cutoff30 = dayStrLocal(Date.now() - 30 * 24 * 3600 * 1000);
  const intensity7 = Object.entries(g.intensityDays).filter(([d]) => d >= cutoff7).reduce((s, [, v]) => s + v, 0);
  const intensity30 = Object.entries(g.intensityDays).filter(([d]) => d >= cutoff30).reduce((s, [, v]) => s + v, 0);
  return {
    level: g.level,
    xp: g.xp,
    bond: g.bond,
    mood: g.mood,
    energy: g.energy,
    streakDays: g.streakDays,
    intensityToday: Math.round(g.dailyIntensity),
    intensity7: Math.round(intensity7),
    intensity30: Math.round(intensity30),
    tasksCompleted: g.tasksCompleted,
    errorsRecovered: g.errorsRecovered,
    errorRate: eff.errorRate,
    completionRate: eff.completionRate,
    avgToolChain: Math.round(eff.avgToolChain * 10) / 10,
    primaryCareer: c.primary,
    secondaryCareer: c.secondary,
    title: c.title,
    careerXp: c.xp,
    profileTypeLabel: profile.getProfile()?.typeLabel ?? null,
    topTools: topToolsOf(stats),
    chronotype: chrono.label,
    peakHour: chrono.peakHour,
  };
}

/** Compact habit facts string for milestone/career LLM enrichment prompts. */
function habitPrompt(
  growth: GrowthEngine,
  career: CareerEngine,
  stats: StatsCollector,
  profile: ProfileEngine,
): string {
  const f = buildGrowthFacts(growth, career, stats, profile);
  const tools = f.topTools.slice(0, 6).map(([n, c]) => `${n}×${c}`).join("、") || "—";
  return [
    `等级 Lv.${f.level}，连续使用 ${f.streakDays} 天，今日强度 ${f.intensityToday}`,
    `主职业 ${f.primaryCareer ? CAREER_LABELS[f.primaryCareer] : "综合"}，画像 ${f.profileTypeLabel ?? "未生成"}`,
    `错误率 ${Math.round(f.errorRate * 1000) / 10}%，完成率 ${Math.round(f.completionRate * 1000) / 10}%`,
    `常用工具 ${tools}，作息 ${f.chronotype}（峰值 ${f.peakHour} 点）`,
  ].join("\n");
}

/** Build the proactive-caring usage snapshot from the live engines. */
function buildCareSnapshot(
  growth: GrowthEngine,
  career: CareerEngine,
  stats: StatsCollector,
  profile: ProfileEngine,
  buddyMemory: { text: string; ts: number }[],
  selfcare: SelfcareEngine,
): CareSnapshot {
  const g = growth.getData();
  const c = career.getData();
  const now = new Date();
  const nowMs = now.getTime();
  const today = dayStrLocal(nowMs);
  const allStats = stats.getStats();
  const day = allStats.days[today];
  const chrono = stats.chronotype();
  // Rhythm targeting (companion-v2 A4): this hour's user-message beats vs the
  // busiest hour on record — social cares only fire well below the peak.
  const hourActivity = allStats.rhythm.hourActivity;
  let peakHourActivity = 0;
  for (const v of hourActivity) peakHourActivity = Math.max(peakHourActivity, v ?? 0);
  // Echo-recall pool (B1): quotes older than 2 days only — fresh topics feel
  // like surveillance, old ones feel like memory.
  const echoPool = buddyMemory
    .filter((m) => nowMs - m.ts >= 2 * 24 * 3600 * 1000)
    .map((m) => m.text);
  // Weekday stress anomaly (B2): today's weekday errors-per-active-day over a
  // 28-day window vs every other weekday; needs ≥3 samples to say anything.
  let weekdayStress: CareSnapshot["weekdayStress"] = null;
  try {
    const windowMs = 28 * 24 * 3600 * 1000;
    const byWd = new Map<number, { days: number; errors: number }>();
    for (const [date, d] of Object.entries(allStats.days)) {
      const ts = new Date(`${date}T12:00:00`).getTime();
      if (!Number.isFinite(ts) || nowMs - ts > windowMs) continue;
      if ((d.turns ?? 0) <= 0) continue;
      const wd = new Date(`${date}T12:00:00`).getDay();
      const rec = byWd.get(wd) ?? { days: 0, errors: 0 };
      rec.days += 1;
      rec.errors += d.errors ?? 0;
      byWd.set(wd, rec);
    }
    const cur = byWd.get(now.getDay());
    if (cur && cur.days >= 3 && cur.errors > 0) {
      let othersDays = 0;
      let othersErrors = 0;
      for (const [wd, r] of byWd) {
        if (wd === now.getDay()) continue;
        othersDays += r.days;
        othersErrors += r.errors;
      }
      const avgCur = cur.errors / cur.days;
      const avgOthers = othersDays > 0 ? othersErrors / othersDays : 0;
      if (avgCur >= 1 && avgCur > avgOthers * 1.8) {
        weekdayStress = {
          wd: now.getDay(),
          sampleDays: cur.days,
          avgErrors: Math.round(avgCur * 10) / 10,
          ratio: avgOthers > 0 ? avgCur / avgOthers : 2,
        };
      }
    }
  } catch {
    weekdayStress = null; // never let analytics break caring
  }
  // Bedtime「三件小事」candidates (B4): concrete little facts from today.
  const topTool = topToolsOf(stats)[0];
  const todayLittleThings: string[] = [];
  if ((day?.toolCalls ?? 0) > 0) {
    todayLittleThings.push(`今天跑了 ${day?.toolCalls} 次工具${topTool ? `，最顺手的是 ${topTool[0]}` : ""}`);
  }
  const recoveredToday = g.recoveredDays?.[today] ?? 0;
  if (recoveredToday > 0) todayLittleThings.push(`从 ${recoveredToday} 次报错里恢复了过来`);
  const todayMemo = [...buddyMemory].reverse().find((m) => new Date(m.ts).toDateString() === now.toDateString());
  if (todayMemo) todayLittleThings.push(`你说过的：「${todayMemo.text.slice(0, 40)}」`);
  return {
    todayTurns: day?.turns ?? 0,
    todayTools: day?.toolCalls ?? 0,
    todayErrors: day?.errors ?? 0,
    todayApprovals: day?.approvals ?? 0,
    todayQuestions: day?.questions ?? 0,
    todayActiveMs: day?.activeMs ?? 0,
    level: g.level,
    xp: Math.round(g.xp),
    mood: g.mood,
    userMoodToday: selfcare.moodToday(),
    energy: g.energy,
    intensity: Math.round(g.dailyIntensity),
    intensityLevel: intensityLevelOf(g.dailyIntensity),
    streakDays: g.streakDays,
    primaryCareer: c.primary,
    title: c.title,
    profileTypeLabel: profile.getProfile()?.typeLabel ?? null,
    chronotype: chrono.label,
    peakHour: chrono.peakHour,
    currentHourActivity: hourActivity[now.getHours()] ?? 0,
    peakHourActivity,
    echoPool,
    weekdayStress,
    todayLittleThings,
    recentUserText: buddyMemory.slice(-3).map((m) => m.text).join(" / ").slice(0, 200),
  };
}

/** Milestone display title/description helpers. */
function milestoneTitle(id: string, growth: GrowthEngine): string {
  const g = growth.getData();
  switch (id) {
    case "first-task": return "首次完成任务";
    case "first-recovery": return "首次错误恢复";
    case "first-subagent": return "首次子代理协作";
    case "intensity-100": return "高强度日";
    case "intensity-240": return "超强工作日";
    case "streak-7": return "连续使用 7 天";
    case "streak-30": return "连续使用 30 天";
    case "level-5": return "升到 Lv.5";
    case "level-10": return "升到 Lv.10";
    case "level-20": return "升到 Lv.20";
    case "level-50": return "升到 Lv.50";
    default: return id;
  }
}

function milestoneDesc(id: string, growth: GrowthEngine): string {
  const g = growth.getData();
  switch (id) {
    case "first-task": return "主人完成了第一个任务，成长开始。";
    case "first-recovery": return "第一次从工具错误中恢复，调试天赋显现。";
    case "first-subagent": return "第一次使用子代理/工作流协作。";
    case "intensity-100": return `今日工作强度突破 100（当前 ${Math.round(g.dailyIntensity)}）。`;
    case "intensity-240": return `今日工作强度突破 240（当前 ${Math.round(g.dailyIntensity)}）。`;
    case "streak-7": return "连续 7 天都在工作。";
    case "streak-30": return "连续 30 天都在工作。";
    case "level-5": return "宠物成长到 5 级。";
    case "level-10": return "宠物成长到 10 级。";
    case "level-20": return "宠物成长到 20 级。";
    case "level-50": return "宠物成长到 50 级。";
    default: return "";
  }
}

/** Build the full growth archive (Markdown) for export. */
function exportMarkdown(
  growth: GrowthEngine,
  career: CareerEngine,
  memory: MemoryEngine,
  profile: ProfileEngine,
  stats: StatsCollector,
): string {
  const g = growth.getData();
  const c = career.getData();
  const m = memory.getData();
  const p = profile.getProfile();
  const { level, intoLevel, needNext } = computeLevel(g.xp);
  const pet = getActivePet();
  const lines: string[] = [];
  lines.push(`# DSHBuddy 成长档案 — ${pet?.displayName ?? "小鲸鱼"}`);
  lines.push(`生成时间：${new Date().toLocaleString("zh-CN")}`);
  lines.push("");
  lines.push("## 总览");
  lines.push(`- 等级：Lv.${level}（XP ${Math.round(g.xp)}，距下一级 ${needNext - intoLevel}）`);
  lines.push(`- 亲密度：${Math.round(g.bond * 10) / 10}｜心情：${g.mood}｜精力：${g.energy}`);
  lines.push(`- 连续使用：${g.streakDays} 天｜今日强度：${Math.round(g.dailyIntensity)}（${intensityLevelOf(g.dailyIntensity)}）`);
  lines.push(`- 完成任务：${g.tasksCompleted}｜错误恢复：${g.errorsRecovered}｜审批：${g.totalApprovals}｜提问：${g.totalQuestions}｜子代理：${g.totalSubagents}`);
  lines.push("");
  lines.push("## 职业");
  lines.push(`- 主职业：${c.primary ? CAREER_LABELS[c.primary] + "（" + CAREER_EN[c.primary] + "）" : "—"}`);
  lines.push(`- 副职业：${c.secondary ? CAREER_LABELS[c.secondary] : "—"}｜称号：${c.title ?? "—"}`);
  for (const careerKey of CAREERS) {
    lines.push(`- ${CAREER_LABELS[careerKey]}：${Math.round((c.xp[careerKey] ?? 0) * 10) / 10}`);
  }
  lines.push("");
  lines.push("## 近 7 天强度");
  const days = Object.entries(g.intensityDays).sort((a, b) => a[0].localeCompare(b[0])).slice(-7);
  for (const [date, v] of days) lines.push(`- ${date}：${Math.round(v)}`);
  lines.push("");
  lines.push("## 里程碑");
  for (const ms of m.milestones) {
    lines.push(`- ${new Date(ms.createdAt).toLocaleDateString("zh-CN")}｜${ms.title}：${ms.description}`);
  }
  lines.push("");
  lines.push("## 每日总结");
  for (const s of m.dailySummaries.slice(0, 14)) {
    lines.push(`### ${s.date}${s.source === "llm" ? "（LLM）" : "（模板）"}`);
    lines.push(s.summaryText);
    lines.push("");
  }
  if (m.growthSummaries.length > 0) {
    lines.push("## 成长综述（LLM）");
    for (const gs of m.growthSummaries.slice(0, 3)) {
      lines.push(`### ${new Date(gs.createdAt).toLocaleDateString("zh-CN")}${gs.source === "llm" ? "（LLM）" : "（模板）"}`);
      lines.push(gs.summaryText);
      lines.push("");
    }
  }
  if (p) {
    lines.push("## 用户画像");
    lines.push(`- 类型：${p.typeLabel}（${p.userType}，${p.source === "llm" ? "LLM 生成" : "规则生成"}）`);
    lines.push(`- 总结：${p.summary}`);
    if (p.traits.length) lines.push(`- 特征：${p.traits.join("；")}`);
    if (p.strengths.length) lines.push(`- 优点：${p.strengths.join("；")}`);
    if (p.growthTips.length) lines.push(`- 成长建议：${p.growthTips.join("；")}`);
  }
  return lines.join("\n");
}

// ── statistics analytics (design §A/B/C/E/F) ───────────────────────────────

type MaxRecord = { date: string; value: number } | null;

function maxBy(arr: Record<string, unknown>[], key: string): MaxRecord {
  let best: MaxRecord = null;
  for (const d of arr) {
    const v = Number(d[key] ?? 0);
    if (!best || v > best.value) best = { date: String(d.date ?? ""), value: v };
  }
  return best;
}

function maxInMap(map: Record<string, number> | undefined): MaxRecord {
  let best: MaxRecord = null;
  for (const [date, v] of Object.entries(map ?? {})) {
    if (!best || v > best.value) best = { date, value: v };
  }
  return best;
}

/** Once-per-day morning-report cache (per host process). */
let morningCache: { date: string; payload: unknown } | null = null;

/** Compose the daily morning report from yesterday's REAL usage + today's
 *  todos + festival context. LLM-written when available, template fallback. */
async function buildMorningReport(deps: {
  stats: StatsCollector;
  growth: GrowthEngine;
  llmAsk: LlmAsk;
  llmEnabled: boolean;
}): Promise<{ ok: boolean; date: string; report: string; source: "llm" | "template"; festival: string | null }> {
  const now = Date.now();
  const date = dayStrLocal(now);
  const yesterday = dayStrLocal(now - 24 * 3600 * 1000);
  const fest = festivalOf(now);
  try {
    const y = deps.stats.getStats().days[yesterday];
    const g = deps.growth.growthSummary();
    const yTurns = y?.turns ?? 0;
    const yTools = y?.toolCalls ?? 0;
    const yErrors = y?.errors ?? 0;
    const yActiveMin = Math.round((y?.activeMs ?? 0) / 60000);
    const yIntensity = deps.growth.getData().intensityDays[yesterday] ?? 0;
    const pending = readNotes().filter((n) => !n.done);
    const firstTodos = pending.slice(0, 2).map((n) => `「${n.text}」`).join("、");
    const facts = [
      `昨天（${yesterday}）：${yTurns} 轮对话、${yTools} 次工具调用、${yErrors} 次报错、活跃约 ${yActiveMin} 分钟、强度 ${Math.round(yIntensity)}`,
      `当前等级 Lv.${g.level}，连续使用 ${g.streakDays} 天，心情 ${g.mood}`,
      pending.length ? `今日待办还有 ${pending.length} 项${firstTodos ? `（靠前：${firstTodos}）` : ""}` : "今日暂无待办",
      fest ? `今天是「${fest.name}」` : "",
    ]
      .filter(Boolean)
      .join("\n");
    let report = "";
    let source: "llm" | "template" = "template";
    if (deps.llmEnabled) {
      const reply = await deps.llmAsk(
        `现在是早上。请根据下面的真实数据，为主人写一份简短的晨报：先问候并回顾昨天（1 句），再展望今天（结合待办，1-2 句），语气温暖像伙伴。如有节日自然融入。总长不超过 3 句。\n${facts}`,
        { system: "你是 DSHBuddy，一只陪伴用户工作的宠物鲸鱼，说话简短真诚。", maxLength: 200 },
      );
      if (reply) {
        report = reply;
        source = "llm";
      }
    }
    if (!report) {
      report =
        `☀️ 早安！昨天 ${yTurns} 轮对话、${yTools} 次工具调用，活跃约 ${yActiveMin} 分钟` +
        (yIntensity > 100 ? "，强度不小，今天注意节奏。" : "。") +
        (pending.length ? `\n📋 今日待办还有 ${pending.length} 项${firstTodos ? `，可以先从 ${firstTodos} 开始` : ""}。` : "\n📋 今天还没有安排，轻松一点～") +
        (fest ? `\n${fest.emoji} 今天是「${fest.name}」，${fest.wish}！` : "") +
        `\n🔥 已连续陪伴 ${g.streakDays} 天，今天也一起加油！`;
    }
    return { ok: true, date, report, source, festival: fest?.name ?? null };
  } catch {
    return { ok: false, date, report: "", source: "template", festival: null };
  }
}

/** Full analytics payload for the stats dashboard (efficiency + rhythm + flow + records + growth fusion). */
function buildAnalytics(growth: GrowthEngine, career: CareerEngine, stats: StatsCollector) {
  const s = stats.getStats();
  const days = Object.values(s.days);
  const g = growth.growthSummary();
  const c = career.getData();
  const eff = stats.efficiency(days);
  const chrono = stats.chronotype();
  const transitions = Object.entries(s.transitions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => ({ path: k, count: v }));
  const loops = s.loops;

  const recent30 = Object.entries(g.intensityDays).filter(([d]) => d >= dayStrLocal(Date.now() - 30 * 24 * 3600 * 1000));
  const weekDays = Object.values(s.days).sort((a, b) => a.date.localeCompare(b.date)).slice(-7);

  return {
    efficiency: {
      errorRate: eff.errorRate,
      errorRatePct: Math.round(eff.errorRate * 1000) / 10,
      successRate: eff.successRate,
      successRatePct: Math.round(eff.successRate * 1000) / 10,
      completionRate: eff.completionRate,
      completionRatePct: Math.round(eff.completionRate * 1000) / 10,
      mtbrMs: eff.mtbrMs,
      avgToolChain: Math.round(eff.avgToolChain * 10) / 10,
    },
    chronotype: chrono,
    rhythm: s.rhythm,
    transitions,
    loops,
    pomodoro: (() => {
      const sorted = Object.values(s.days).sort((a, b) => a.date.localeCompare(b.date));
      const week = sorted.slice(-7).map((d) => ({ date: d.date, min: d.pomoMin ?? 0 }));
      const todayKey = dayStrLocal(Date.now());
      return {
        todayMin: s.days[todayKey]?.pomoMin ?? 0,
        totalMin: sorted.reduce((acc, d) => acc + (d.pomoMin ?? 0), 0),
        week,
      };
    }),
    records: {
      maxTurns: maxBy(days, "turns"),
      maxTools: maxBy(days, "toolCalls"),
      maxActive: maxBy(days, "activeMs"),
      maxIntensity: maxInMap(g.intensityDays),
      maxRecovered: maxInMap(g.recoveredDays),
      bestStreak: g.bestStreak ?? 0,
      totalActiveDays: days.length,
      totalToolCalls: days.reduce((acc, d) => acc + (d.toolCalls ?? 0), 0),
    },
    growth: {
      level: g.level,
      mood: g.mood,
      energy: g.energy,
      streakDays: g.streakDays,
      intensityToday: g.intensity,
      intensityLevel: g.intensityLevel,
      intensityDays: g.intensityDays,
      recoveredDays: g.recoveredDays,
      careerXp: c.xp,
      primaryCareer: c.primary,
      secondaryCareer: c.secondary,
      title: c.title,
    },
    weekDays,
    recent30Intensity: recent30.map(([d, v]) => ({ date: d, value: v })),
  };
}

/** LLM statistics insight (design §D): compare last 7d vs prior 7d + anomalies. */
async function buildStatsInsight(
  growth: GrowthEngine,
  career: CareerEngine,
  stats: StatsCollector,
  llmAsk: LlmAsk,
  llmEnabled: boolean,
): Promise<{ insight: string; source: "llm" | "rule" }> {
  const s = stats.getStats();
  const days = Object.values(s.days).sort((a, b) => a.date.localeCompare(b.date));
  const last7 = days.slice(-7);
  const prev7 = days.slice(-14, -7);
  const sum = (arr: typeof last7, key: string) => arr.reduce((acc, d) => acc + (Number((d as unknown as Record<string, number>)[key] ?? 0)), 0);
  const eff = stats.efficiency(last7);
  const prevEff = stats.efficiency(prev7);
  const chrono = stats.chronotype();
  const topTools = topToolsOf(stats).slice(0, 6).map(([n, c]) => `${n}×${c}`).join("、");
  const c = career.getData();
  const g = growth.growthSummary();

  const facts = {
    turns: sum(last7, "turns"),
    tools: sum(last7, "toolCalls"),
    errors: sum(last7, "errors"),
    activeMs: sum(last7, "activeMs"),
    prevTurns: sum(prev7, "turns"),
    prevTools: sum(prev7, "toolCalls"),
    prevErrors: sum(prev7, "errors"),
    errorRatePct: Math.round(eff.errorRate * 1000) / 10,
    prevErrorRatePct: Math.round(prevEff.errorRate * 1000) / 10,
    completionPct: Math.round(eff.completionRate * 1000) / 10,
    mtbrMs: eff.mtbrMs,
    avgChain: Math.round(eff.avgToolChain * 10) / 10,
    peakHour: chrono.peakHour,
    chronotype: chrono.label,
    topTools,
    careerLabel: c.primary ? CAREER_LABELS[c.primary] : "综合",
    intensity: g.intensity,
  };

  const prompt =
    `请基于以下 DeepSeek Harness 的真实使用统计，用中文输出 3~5 条「统计洞察」，每条一行、以「•」开头。` +
    `要点：① 本周 vs 上周的变化（上升/下降、可能原因）；② 效率或节律上的异常或亮点；③ 一条可执行建议。` +
    `语气克制专业、只讲数据能支撑的结论，不要编造。\n\n` +
    `近 7 天：轮次 ${facts.turns}、工具调用 ${facts.tools}、错误 ${facts.errors}、错误率 ${facts.errorRatePct}%、完成率 ${facts.completionPct}%、平均工具链 ${facts.avgChain}。\n` +
    `前 7 天：轮次 ${facts.prevTurns}、工具调用 ${facts.prevTools}、错误 ${facts.prevErrors}、错误率 ${facts.prevErrorRatePct}%。\n` +
    `平均错误恢复耗时 ${facts.mtbrMs === null ? "无" : Math.round(facts.mtbrMs / 1000) + " 秒"}，活跃峰值时段 ${facts.peakHour} 点，作息类型 ${facts.chronotype}，主导职业 ${facts.careerLabel}，今日强度 ${facts.intensity}。\n` +
    `常用工具：${facts.topTools || "—"}。`;

  if (llmEnabled) {
    const reply = await llmAsk(prompt, { maxLength: 900 });
    if (reply) return { insight: reply, source: "llm" };
  }

  // rule-based fallback
  const lines: string[] = [];
  const trend = facts.turns > facts.prevTurns ? "上升" : facts.turns < facts.prevTurns ? "下降" : "持平";
  lines.push(`• 活跃度：近 7 天 ${facts.turns} 轮 / ${facts.tools} 次工具，较前 7 天（${facts.prevTurns} 轮）${trend}。`);
  lines.push(`• 质量：错误率 ${facts.errorRatePct}%（前 7 天 ${facts.prevErrorRatePct}%），完成率 ${facts.completionPct}%，平均工具链 ${facts.avgChain}。`);
  if (facts.mtbrMs !== null) lines.push(`• 恢复：平均错误恢复耗时约 ${Math.round(facts.mtbrMs / 1000)} 秒。`);
  lines.push(`• 节律：活跃峰值约 ${facts.peakHour} 点，作息类型为「${facts.chronotype}」。`);
  lines.push(`• 建议：保持当前节奏，优先在峰值时段处理高复杂度任务。`);
  return { insight: lines.join("\n"), source: "rule" };
}

function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    machine: PetStateMachine;
    stats: StatsCollector;
    config: ConfigStore;
    growth: GrowthEngine;
    career: CareerEngine;
    memory: MemoryEngine;
    profile: ProfileEngine;
    llmAsk: LlmAsk;
    companion: CompanionEngine;
    orders: OrdersEngine;
    watcher: SessionWatcher;
    sound: SoundFx;
    /** Badge-wall state + a live metrics snapshot for progress hints. */
    achievements: () => ReturnType<AchievementEngine["list"]>;
    /** Re-score the badge wall (called after pat / pomodoro logging). */
    checkAchievements: () => void;
    /** Bump an internal badge counter (pats etc.) from route handlers. */
    bumpAchCounter: (name: string, delta?: number) => void;
    /** B2-2 coin wallet + shop inventory (mutated by /economy ops). */
    economy: EconomyEngine;
    /** v0.4 mutual self-care board (quests / breath / mood). */
    selfcare: SelfcareEngine;
    pomodoro: PomodoroEngine;
    /** v0.4 one-shot/frequency anchors for relational + proud cares. */
    careState: CareState;
    /** B3-3 resolved model context capacity (null when unavailable). */
    contextCapacity: () => ContextCapacity | null;
    /** Mutable dream throttle and the bounded conversational memory pool. */
    dream: {
      getLastAt: () => number;
      setLastAt: (at: number) => void;
      minIntervalMs: number;
      memory: { text: string; ts: number }[];
    };
  },
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, "");
  const {
    machine, stats, config, growth, career, memory, profile, llmAsk, companion, orders,
    watcher: sessionWatcher,
    sound,
    economy,
    pomodoro,
    selfcare,
    careState,
  } = deps;

  // GET /api/dshbuddy/debug — state-machine + poller health counters (B1-1).
  if (req.method === "GET" && path === "debug") {
    sendJson(res, 200, {
      ok: true,
      version: __DSHBUDDY_VERSION__,
      uptimeMs: Date.now() - process.uptime() * 1000,
      machine: machine.debugInfo(),
      watcher: sessionWatcher.healthInfo(),
    });
    return;
  }

  // GET /api/dshbuddy/orders — JingLing work-order list
  if (req.method === "GET" && path === "orders") {
    sendJson(res, 200, { ok: true, orders: orders.list() });
    return;
  }

  // POST /api/dshbuddy/orders — {op:'add',text} | {op:'cancel',id} | {op:'remove',id}
  if (req.method === "POST" && path === "orders") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string; text?: string; id?: string } | null;
      if (!body) {
        sendJson(res, 400, { ok: false, error: "bad json" });
        return;
      }
      if (body.op === "add" && body.text) {
        // Regex first, then one LLM extraction pass for natural phrasings
        // (「晚上八点五十」etc.). null → client shows the needTime hint.
        const order = await orders.addSmart(body.text, llmAsk);
        if (!order) {
          sendJson(res, 200, { ok: false, error: "no-time" });
          return;
        }
        machine.setBubble(`📅 收到！${formatOrderTime(order.triggerAt)} 见 ✨`, true);
        appendCare("order-add", `收到工作单：${order.task}（${new Date(order.triggerAt).toLocaleString()}）`);
        sendJson(res, 200, { ok: true, order });
        return;
      }
      if (body.op === "cancel" && body.id) {
        const target = orders.list().find((x) => x.id === body.id);
        const ok = orders.cancel(body.id);
        if (ok && target) pruneOrderCareTrail(target.task);
        sendJson(res, 200, { ok });
        return;
      }
      if (body.op === "retry" && body.id) {
        const ok = orders.retry(body.id);
        if (ok) orders.tick();
        sendJson(res, 200, { ok });
        return;
      }
      if (body.op === "remove" && body.id) {
        const target = orders.list().find((x) => x.id === body.id);
        const ok = orders.remove(body.id);
        if (ok && target) pruneOrderCareTrail(target.task);
        sendJson(res, 200, { ok });
        return;
      }
      sendJson(res, 400, { ok: false, error: "bad op" });
    })();
    return;
  }

  // GET /api/dshbuddy/snapshot — current pet state + bubble + summary
  if (req.method === "GET" && (path === "snapshot" || path === "")) {
    const summary = stats.summary();
    const pet = getActivePet();
    const g = growth.growthSummary();
    const c = career.getData();
    sendJson(res, 200, {
      ok: true,
      snapshot: machine.getSnapshot(),
      summary,
      pet: pet ? { slug: pet.slug, displayName: pet.displayName } : null,
      config: config.public(),
      growth: {
        level: g.level,
        xp: g.xp,
        levelProgress: g.levelProgress,
        bond: g.bond,
        mood: g.mood,
        energy: g.energy,
        intensity: g.intensity,
        intensityLevel: g.intensityLevel,
        streakDays: g.streakDays,
        primaryCareer: c.primary,
        title: c.title,
        userTypeLabel: profile.getProfile()?.typeLabel ?? null,
      },
      // B2-2 economy state (client shows the coin chip + worn accessory).
      economy: {
        coins: economy.getData().coins,
        snacks: economy.getData().snacks,
        toys: economy.getData().toys,
        accessories: economy.getData().accessories,
        equipped: economy.getData().equipped,
      },
      // B3-2 parallel-session awareness (orbs + subagent chip on the pet).
      sessions: (() => {
        const obs = sessionWatcher.healthInfo().lastObservation;
        return obs
          ? {
              running: obs.runningCount,
              subagents: obs.subRunningCount,
              total: obs.total,
              // B3-3 coach input: longest continuous running stretch.
              longestRunningMs: obs.longestRunningMs,
            }
          : null;
      })(),
      // B3-3 model context capacity — null unless resolveModelInfo disclosed a
      // contextWindow; the client auto-hides the capacity chip then.
      context: deps.contextCapacity(),
    });
    return;
  }

  // GET /api/dshbuddy/growth — full growth archive (overview/career/intensity/memory/profile)
  if (req.method === "GET" && path === "growth") {
    const g = growth.growthSummary();
    const c = career.getData();
    const m = memory.getData();
    const p = profile.getProfile();
    const format = url.searchParams.get("format");
    if (format === "md") {
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(exportMarkdown(growth, career, memory, profile, stats));
      return;
    }
    sendJson(res, 200, {
      ok: true,
      llmEnabled: config.get().growth.llmEnabled,
      growth: g,
      career: {
        xp: c.xp,
        historicalPrimary: c.historicalPrimary,
        recentPrimary: c.recentPrimary,
        primary: c.primary,
        secondary: c.secondary,
        title: c.title,
        snapshots: c.snapshots.slice(-30),
        labels: CAREER_LABELS,
      },
      memory: {
        milestones: m.milestones.slice(0, 60),
        dailySummaries: m.dailySummaries.slice(0, 30),
        timeline: m.timeline.slice(0, 80),
        weeklyReports: m.weeklyReports.slice(0, 8),
        growthSummaries: m.growthSummaries.slice(0, 5),
      },
      profile: p,
      userTypes: USER_TYPES,
    });
    return;
  }

  // GET /api/dshbuddy/achievements — the badge wall (ids, progress, unlock ts)
  // plus the category registry so the gallery groups/filters without
  // duplicating display text on the client.
  if (req.method === "GET" && path === "achievements") {
    sendJson(res, 200, { ok: true, achievements: deps.achievements(), categories: ACH_CATEGORIES });
    return;
  }

  // GET /api/dshbuddy/economy — wallet + shop catalog (B2-2)
  if (req.method === "GET" && path === "economy") {
    sendJson(res, 200, { ok: true, economy: economy.getData(), shop: SHOP });
    return;
  }

  // POST /api/dshbuddy/economy — { op: 'buy'|'use'|'equip', id }
  if (req.method === "POST" && path === "economy") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string; id?: string | null } | null;
      const op = body?.op ?? "";
      const id = body?.id ?? null;
      if (op === "buy") {
        if (!id) {
          sendJson(res, 400, { ok: false, error: "missing id" });
          return;
        }
        const result = economy.buy(id);
        if (result !== "ok") {
          const msg = result === "poor" ? "not enough coins" : result === "owned" ? "already owned" : "unknown item";
          sendJson(res, 400, { ok: false, error: msg });
          return;
        }
        // Consumables apply their cheer immediately on purchase.
        if (id === "snack" || id === "toy") growth.applyItem(id);
        sendJson(res, 200, { ok: true, economy: economy.getData() });
        return;
      }
      if (op === "use") {
        if (id !== "snack" && id !== "toy") {
          sendJson(res, 400, { ok: false, error: "unknown consumable" });
          return;
        }
        if (!economy.consume(id)) {
          sendJson(res, 400, { ok: false, error: "none left" });
          return;
        }
        growth.applyItem(id);
        sendJson(res, 200, { ok: true, economy: economy.getData() });
        return;
      }
      if (op === "equip") {
        const wanted = id && id !== "none" ? id : null;
        if (!economy.equip(wanted)) {
          sendJson(res, 400, { ok: false, error: "not owned" });
          return;
        }
        sendJson(res, 200, { ok: true, economy: economy.getData() });
        return;
      }
      sendJson(res, 400, { ok: false, error: "bad op" });
    })();
    return;
  }

  // GET /api/dshbuddy/selfcare — today's quest board + breath state (v0.4 C)
  if (req.method === "GET" && path === "selfcare") {
    sendJson(res, 200, {
      ok: true,
      board: selfcare.board(),
      moodToday: selfcare.moodToday(),
      moodStrip: selfcare.moodStrip(),
    });
    return;
  }

  // POST /api/dshbuddy/selfcare — { op:'complete', id } | { op:'breath' }
  if (req.method === "POST" && path === "selfcare") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string; id?: string } | null;
      if (body?.op === "complete" && typeof body.id === "string") {
        const r = selfcare.complete(body.id);
        if (!r.ok) {
          sendJson(res, 400, { ok: false, error: "quest not pending" });
          return;
        }
        if (r.earned > 0) economy.earn(r.earned);
        sendJson(res, 200, { ok: true, earned: r.earned, cleared: r.cleared });
        if (r.earned > 0 || r.cleared) {
          const lang = config.get().language;
          const text =
            lang === "en"
              ? r.cleared
                ? `🌈 All self-care quests done — today's little adventure is complete! +${r.earned} coins 🪙`
                : `Self-care +${r.earned} coins 🪙 — thanks for taking care of yourself`
              : r.cleared
                ? `🌈 今日自护任务全部完成——今天的小冒险结束啦！+${r.earned} 金币 🪙`
                : `自护任务完成，+${r.earned} 金币 🪙 谢谢你照顾好自己`;
          machine.setBubble(text, true);
          appendCare("selfcare", text);
        }
        return;
      }
      if (body?.op === "breath") {
        const quest = selfcare.completeBreathQuest();
        const earned = selfcare.breathDone() + quest.earned;
        if (earned > 0) economy.earn(earned);
        sendJson(res, 200, { ok: true, earned, cleared: quest.cleared, questCompleted: quest.ok });
        return;
      }
      sendJson(res, 400, { ok: false, error: "bad op" });
    })();
    return;
  }

  // POST /api/dshbuddy/mood — check-in {mood 1-5, note?} | proud moment {op:'proud', text}
  if (req.method === "POST" && path === "mood") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string; mood?: number; note?: string; text?: string } | null;
      if (body?.op === "proud") {
        const text = (body.text ?? "").trim().slice(0, 200);
        if (!text) {
          sendJson(res, 400, { ok: false, error: "empty text" });
          return;
        }
        // At most one proud moment per ISO week (key doubles as the seen-flag).
        const weekKey = isoWeekKey(Date.now());
        const seenKey = `proud-${weekKey}`;
        if (careState.has(seenKey)) {
          sendJson(res, 400, { ok: false, error: "already recorded this week" });
          return;
        }
        careState.mark(seenKey);
        economy.earn(10);
        const title = config.get().language === "en" ? "Proud moment of the week" : "本周胜利瞬间";
        memory.addMilestone(seenKey, "proud", title, text);
        memory.addTimeline(dayStrLocal(Date.now()), title, text, "milestone");
        machine.setCare(`🏆 ${title}:${text}`, { kind: "anniversary", reasonKey: "proud", level: "card" });
        appendCare("proud", text);
        sendJson(res, 200, { ok: true, earned: 10 });
        return;
      }
      if (typeof body?.mood !== "number") {
        sendJson(res, 400, { ok: false, error: "missing mood" });
        return;
      }
      const first = selfcare.checkMood(body.mood, body.note);
      let earned = 0;
      if (first && selfcare.moodCoinDue()) {
        earned = 2;
        economy.earn(earned);
      }
      sendJson(res, 200, { ok: true, first, earned });
    })();
    return;
  }

  // POST /api/dshbuddy/care/snooze — { kind } 「晚点再说」(v0.4 D3):
  // mutes that care kind for 2h and feeds the rolling learning table so
  // often-snoozed kinds cool down longer over the next weeks.
  if (req.method === "POST" && path === "care/snooze") {
    void (async () => {
      const body = (await readBody(req)) as { kind?: string } | null;
      const kind = (body?.kind ?? "").trim();
      if (!kind) {
        sendJson(res, 400, { ok: false, error: "missing kind" });
        return;
      }
      companion.snooze(kind);
      sendJson(res, 200, { ok: true, kind, mutedMs: 2 * 60 * 60 * 1000 });
    })();
    return;
  }

  // GET /api/dshbuddy/dream — v0.4 F1 life-of-mind: sample milestone titles +
  // recent buddyMemory entries and (when LLM is on) weave a short, dreamy,
  // 1st-person "what the whale saw" monologue. Falls back to a template line
  // if the LLM is off or returns nothing. Throttled to ≥20 min between
  // emissions — dreams are a "felt rare" channel, not a cron job. Pure
  // read-only side-effects (memory.getData + buddyMemory); no level /
  // cooldown / card opening — the dream bubbles itself up via setCare with
  // level:"bubble" so the pet just mutters a line.
  if (req.method === "GET" && path === "dream") {
    void (async () => {
      const now = Date.now();
      const lastDreamAt = deps.dream.getLastAt();
      if (now - lastDreamAt < deps.dream.minIntervalMs) {
        const wait = deps.dream.minIntervalMs - (now - lastDreamAt);
        sendJson(res, 200, { ok: true, throttled: true, waitMs: wait, text: null });
        return;
      }
      const lang = config.get().language === "en" ? "en" : "zh";
      const mem = memory.getData();
      // Sample up to 3 milestone titles + 2 most recent buddyMemory lines.
      const sampleMilestones = mem.milestones
        .slice(-3)
        .map((m) => m.title)
        .filter((s) => typeof s === "string" && s.length > 0);
      const sampleMemos = deps.dream.memory
        .slice(-3)
        .map((m) => m.text)
        .filter((s) => typeof s === "string" && s.length > 0);
      const inputs = [...sampleMilestones, ...sampleMemos];
      if (inputs.length === 0) {
        sendJson(res, 200, { ok: true, text: null });
        return;
      }
      const fallback = (() => {
        const head = inputs[0];
        if (lang === "en") {
          return `…saw ${head} drifting by in a deep place. didn't quite make it out, but it felt familiar.`;
        }
        return `……刚才在很深的地方看到了「${head}」，没看清形状，但好像在哪见过。`;
      })();
      const prompt =
        lang === "en"
          ? `Compose a very short dream (≤ 45 words, 1–2 sentences) in first person as DSHBuddy, the pet whale. Weave these scraps of memory into something half-remembered and slightly strange, like a dream should be:\n- ${inputs.slice(0, 5).map((s) => `· ${s}`).join("\n- ")}\nDo NOT be cheerful or motivational. Do NOT speak in second person. No "I remember when you…". One image, one feeling.`
          : `请用 DSHBuddy（宠物鲸鱼）的第一人称写一个很短的梦（≤ 60 字，1–2 句），把下面这些记忆碎片织成一种似曾相识、略带奇怪的梦境感觉：\n- ${inputs.slice(0, 5).map((s) => `· ${s}`).join("\n- ")}\n不要积极向上，不要用第二人称，不要"我刚才梦到你……"。一个画面，一种感觉。`;
      const reply = await llmAsk(prompt, {
        system:
          lang === "en"
            ? "You are a pet whale half-asleep, narrating a dream. Poetic, quiet, ambiguous."
            : "你是半梦半醒的宠物鲸鱼，在喃喃自己的梦。诗意、安静、模糊。",
        maxLength: 160,
      });
      const text = (reply && reply.trim().length > 0) ? reply.trim() : fallback;
      deps.dream.setLastAt(now);
      // Bubble-only — the dream should pop above the pet's head, NOT open a
      // care card. setCare with level "bubble" gates it client-side.
      machine.setCare(text, { kind: "dream", reasonKey: "dream", level: "bubble" });
      sendJson(res, 200, { ok: true, throttled: false, text, sampled: inputs.length });
    })();
    return;
  }

  // POST /api/dshbuddy/growth — { op: 'export'|'clear'|'reset'|'regenerate-summary'|'regenerate-profile' }
  if (req.method === "POST" && path === "growth") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string; date?: string } | null;
      const op = body?.op ?? "";
      if (op === "export") {
        sendJson(res, 200, { ok: true, markdown: exportMarkdown(growth, career, memory, profile, stats) });
        return;
      }
      if (op === "clear") {
        // clear memory + profile (derived data); growth/career XP stay.
        memory.clear();
        profile.clear();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (op === "prestige") {
        // B3-1 转生: Lv30+ restarts the XP curve, keeps everything earned.
        const from = growth.growthSummary().level;
        if (!growth.prestige()) {
          sendJson(res, 400, { ok: false, error: "level too low" });
          return;
        }
        machine.setBubble(`🌟 ${config.get().language === "en" ? `Reborn at Lv.${from}!` : `${from} 级转生！`}`, true);
        memory.addTimeline(
          dayStrLocal(Date.now()),
          config.get().language === "en" ? `Prestige at Lv.${from}` : `${from} 级转生`,
          config.get().language === "en"
            ? "The whale restarted its growth curve — achievements and bonds carry over."
            : "鲸鱼重新开始成长曲线——成就与羁绊全部保留。",
          "milestone",
        );
        companion.onMilestone(config.get().language === "en" ? `Prestige! (Lv.${from})` : `转生成功（${from} 级）`);
        deps.checkAchievements();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (op === "reset") {
        // full reset of the growth system (design: 支持重置).
        memory.clear();
        profile.clear();
        try {
          const p = join(RUNTIME_DIR, "growth.json");
          if (existsSync(p)) writeFileSync(p, JSON.stringify({}));
          const cp = join(RUNTIME_DIR, "career.json");
          if (existsSync(cp)) writeFileSync(cp, JSON.stringify({}));
        } catch {
          // best-effort
        }
        sendJson(res, 200, { ok: true, note: "restart required to fully reset in-memory engines" });
        return;
      }
      if (op === "regenerate-summary") {
        const date = body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : dayStrLocal(Date.now());
        const summary = await memory.generateDailySummary(
          buildDailyFacts(date, growth, career, stats),
          llmAsk,
          config.get().growth.llmEnabled,
        );
        sendJson(res, 200, { ok: true, summary });
        return;
      }
      if (op === "regenerate-profile") {
        const p = await profile.regenerate(buildHabitFacts(growth, career, stats), career.getData(), llmAsk, config.get().growth.llmEnabled);
        if (p) memory.addTimeline(dayStrLocal(Date.now()), `画像：${p.typeLabel}`, p.summary.slice(0, 120), "profile");
        sendJson(res, 200, { ok: true, profile: p });
        return;
      }
      if (op === "regenerate-narrative") {
        const summary = await memory.generateGrowthSummary(
          buildGrowthFacts(growth, career, stats, profile),
          llmAsk,
          config.get().growth.llmEnabled,
        );
        sendJson(res, 200, { ok: true, summary });
        return;
      }
      sendJson(res, 400, { ok: false, error: "bad op" });
    })();
    return;
  }

  // GET /api/dshbuddy/pets — installed pet list
  if (req.method === "GET" && path === "pets") {
    sendJson(res, 200, { ok: true, pets: listPets(), active: getActivePet()?.slug ?? null });
    return;
  }

  // GET /api/dshbuddy/sprite — active pet spritesheet (binary image)
  if (req.method === "GET" && path === "sprite") {
    const data = activePetSpriteDataUrl();
    if (!data) {
      sendJson(res, 404, { ok: false, error: "no spritesheet" });
      return;
    }
    const mime = data.dataUrl.startsWith("data:image/png")
      ? "image/png"
      : "image/webp";
    const buf = Buffer.from(data.dataUrl.split(",")[1], "base64");
    res.writeHead(200, {
      "content-type": mime,
      "cache-control": "no-store",
    });
    res.end(buf);
    return;
  }

  // GET /api/dshbuddy/stats
  if (req.method === "GET" && path === "stats") {
    sendJson(res, 200, { ok: true, stats: stats.getStats() });
    return;
  }

  // GET /api/dshbuddy/stats/export — daily rows as CSV (synchronous; BOM so
  // Excel opens UTF-8 correctly). Day keys are UTC dates (stats engine).
  if (req.method === "GET" && path === "stats/export") {
    const days = Object.values(stats.getStats().days).sort((a, b) => a.date.localeCompare(b.date));
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["date", "turns", "steps", "toolCalls", "errors", "abortedTurns", "approvals", "questions", "activeMs"];
    const lines = [header.join(",")];
    for (const d of days) {
      const row = d as unknown as Record<string, unknown>;
      lines.push(header.map((k) => esc(row[k])).join(","));
    }
    try {
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" });
      res.end(`\uFEFF${lines.join("\r\n")}`);
    } catch {
      // socket gone
    }
    return;
  }

  // GET /api/dshbuddy/stats/analytics — derived quality/rhythm/flow/records + growth fusion
  if (req.method === "GET" && path === "stats/analytics") {
    sendJson(res, 200, { ok: true, analytics: buildAnalytics(growth, career, stats), careerLabels: CAREER_LABELS });
    return;
  }

  // POST /api/dshbuddy/stats/insight — LLM statistics insight (design §D)
  if (req.method === "POST" && path === "stats/insight") {
    void (async () => {
      const insight = await buildStatsInsight(growth, career, stats, llmAsk, config.get().growth.llmEnabled);
      sendJson(res, 200, { ok: true, ...insight });
    })();
    return;
  }

  // GET /api/dshbuddy/commands
  if (req.method === "GET" && path === "commands") {
    sendJson(res, 200, { ok: true, commands: config.allCommands() });
    return;
  }

  // POST /api/dshbuddy/activate — { slug } switch pet
  if (req.method === "POST" && path === "activate") {
    void (async () => {
      const body = (await readBody(req)) as { slug?: string } | null;
      if (!body?.slug) {
        sendJson(res, 400, { ok: false, error: "missing slug" });
        return;
      }
      writeActive(body.slug);
      sendJson(res, 200, { ok: true, active: body.slug });
    })();
    return;
  }

  // POST /api/dshbuddy/config — partial config patch
  if (req.method === "POST" && path === "config") {
    void (async () => {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (!body) {
        sendJson(res, 400, { ok: false, error: "bad json" });
        return;
      }
      config.patch(body as never);
      // Live-apply sound settings (B1-2) without a plugin reload.
      const current = config.get();
      sound.configure({ enabled: current.soundEnabled, volume: (current.soundVolume ?? 70) / 100 });
      if (body.pomodoro && typeof body.pomodoro === "object") {
        pomodoro.updateDurations(current.pomodoro.workMin, current.pomodoro.breakMin);
      }
      sendJson(res, 200, { ok: true, config: config.public() });
    })();
    return;
  }

  // POST /api/dshbuddy/commands — upsert / delete custom command {op:'upsert'|'remove', command}
  if (req.method === "POST" && path === "commands") {
    void (async () => {
      const body = (await readBody(req)) as {
        op?: string;
        command?: { id: string; label: string; command: string };
      } | null;
      if (!body) {
        sendJson(res, 400, { ok: false, error: "bad json" });
        return;
      }
      if (body.op === "upsert" && body.command) {
        config.upsertCommand(body.command);
      } else if (body.op === "remove" && body.command) {
        config.removeCommand(body.command.id);
      } else {
        sendJson(res, 400, { ok: false, error: "bad op" });
        return;
      }
      sendJson(res, 200, { ok: true, commands: config.allCommands() });
    })();
    return;
  }

  // POST /api/dshbuddy/signal — { kind: 'approval'|'question'|'idle'|'custom', detail?, text? }
  // `custom` pushes a plain bubble (pomodoro phase changes etc.). The kind is
  // whitelisted: unknown kinds used to silently strand the pet in "waiting"
  // with a stale bubble.
  if (req.method === "POST" && path === "signal") {
    void (async () => {
      const body = (await readBody(req)) as { kind?: string; text?: string; detail?: string } | null;
      const kinds = new Set(["approval", "question", "idle", "custom"]);
      if (!body?.kind || !kinds.has(body.kind)) {
        sendJson(res, 400, { ok: false, error: "bad kind" });
        return;
      }
      if (body.kind === "custom") {
        const text = String(body.text ?? "").trim().slice(0, 120);
        if (!text) {
          sendJson(res, 400, { ok: false, error: "missing text" });
          return;
        }
        machine.setBubble(text, false);
      } else {
        machine.signal(body.kind as "approval" | "question" | "idle", body.detail);
      }
      sendJson(res, 200, { ok: true });
    })();
    return;
  }

  // POST /api/dshbuddy/chat — chat proxy to Ollama/OpenAI/Gemini (+ local
  // conversation persistence when conversationId is supplied).
  if (req.method === "POST" && path === "chat") {
    void (async () => {
      const body = (await readBody(req)) as {
        messages?: { role: string; content: string }[];
        provider?: string;
        model?: string;
        conversationId?: string;
      } | null;
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        sendJson(res, 400, { ok: false, error: "missing messages" });
        return;
      }
      // Work-order intent: when a chat message reads like a timed task
      // (「任务：…」hint or time + action verb), schedule it instead of
      // chatting. Falls through to normal chat when parsing finds no time.
      const intentText = ([...(body.messages as { role: string; content: string }[])]
        .reverse()
        .find((m) => m.role === "user")?.content ?? "").trim();
      if (intentText && looksLikeWorkOrder(intentText)) {
        const order = await orders.addSmart(intentText, llmAsk);
        if (order) {
          const when = formatOrderTime(order.triggerAt);
          machine.setBubble(`📅 收到！${when} 见 ✨`, true);
          appendCare("order-add", `收到工作单：${order.task}（${new Date(order.triggerAt).toLocaleString()}）`);
          sendJson(res, 200, {
            ok: true,
            reply: `📅 好的，已安排！将在 ${when} 开始执行：\n${order.task}${order.workspace ? `\n工作区：${order.workspace}` : ""}`,
            conversationId: body.conversationId ?? null,
          });
          return;
        }
      }

      // Personality is applied as a system prompt so the reply matches the
      // chosen preset/custom prompt + constraints.
      const personality = config.get().personality;
      const system = buildPersonalityPrompt(personality);
      const msgs = system
        ? [{ role: "system", content: system }, ...(body.messages as { role: string; content: string }[])]
        : (body.messages as { role: string; content: string }[]);

      // Prefer the user's DeepSeek Harness LLM configuration; fall back to the
      // legacy chat config when the DSH services are unavailable.
      const chat = config.get().chat;
      let reply: string | null = null;
      let dshError: string | null = null;
      if (currentCtx) {
        const { llm, agentDefaultModel } = llmServices(currentCtx);
        if (llm && agentDefaultModel) {
          const result = await chatViaDsh(llm, agentDefaultModel, msgs, { disableThinking: chat.disableThinking });
          if (result.ok) reply = result.text;
          else dshError = result.error;
        }
      }
      if (reply === null) {
        const provider = (body.provider as typeof chat.provider) ?? chat.provider;
        if (provider === "off" || !chat.baseUrl) {
          // A failed DSH attempt is a backend error (502), not a config gap —
          // surface the real reason instead of the misleading 400.
          if (dshError) {
            sendJson(res, 502, { ok: false, error: `LLM failed: ${dshError}` });
          } else {
            sendJson(res, 400, { ok: false, error: "chat not configured" });
          }
          return;
        }
        reply = await proxyChat(provider, chat, msgs, body.model);
      }
      if (!reply) {
        sendJson(res, 502, { ok: false, error: "upstream failed" });
        return;
      }
      // Persist user + assistant into the local conversation.
      const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const conv = body.conversationId ? appendChat(body.conversationId, lastUser, reply) : null;
      sendJson(res, 200, { ok: true, reply, conversationId: conv?.id ?? body.conversationId ?? null });
    })();
    return;
  }

  // GET /api/dshbuddy/notes — quick notes list
  if (req.method === "GET" && path === "notes") {
    sendJson(res, 200, { ok: true, notes: readNotes() });
    return;
  }

  // GET /api/dshbuddy/morning — daily morning report (built once per day)
  if (req.method === "GET" && path === "morning") {
    const today = dayStrLocal(Date.now());
    if (morningCache?.date === today) {
      sendJson(res, 200, morningCache.payload);
      return;
    }
    void (async () => {
      const payload = await buildMorningReport({
        stats,
        growth,
        llmAsk,
        llmEnabled: config.get().growth.llmEnabled,
      });
      if ((payload as { date?: string }).date === dayStrLocal(Date.now())) {
        morningCache = { date: today, payload };
      }
      sendJson(res, 200, payload);
    })();
    return;
  }

  // POST /api/dshbuddy/pet — { op: "head" } → intimacy / petting
  if (req.method === "POST" && path === "pet") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string } | null;
      if (body?.op !== "head") {
        sendJson(res, 400, { ok: false, error: "bad op" });
        return;
      }
      const r = growth.petHead();
      if (r.milestone) {
        const title = `亲密度达到 ${r.milestone}`;
        memory.addMilestone(`intimacy-${r.milestone}`, "bond", title, `和宠物的亲密度累计达到 ${r.milestone}，感情很好呢。`);
        companion.onMilestone(title);
      }
      deps.bumpAchCounter("pats"); // 摸头百次 badge
      deps.checkAchievements();
      sendJson(res, 200, { ok: true, ...r });
    })();
    return;
  }

  // Host-owned countdown state survives panel closure and host restarts.
  if (req.method === "GET" && path === "pomodoro/state") {
    sendJson(res, 200, { ok: true, state: pomodoro.snapshot() });
    return;
  }
  if (req.method === "POST" && path === "pomodoro/state") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string; workMin?: number; breakMin?: number } | null;
      const state = body?.op === "start"
        ? pomodoro.start(body.workMin, body.breakMin)
        : body?.op === "pause"
          ? pomodoro.pause()
          : body?.op === "reset"
            ? pomodoro.reset(body.workMin, body.breakMin)
            : null;
      if (!state) {
        sendJson(res, 400, { ok: false, error: "bad op" });
        return;
      }
      sendJson(res, 200, { ok: true, state });
    })();
    return;
  }

  // POST /api/dshbuddy/pomodoro — legacy completed-round logger
  if (req.method === "POST" && path === "pomodoro") {
    void (async () => {
      const body = (await readBody(req)) as { minutes?: number } | null;
      const minutes = Number(body?.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) {
        sendJson(res, 400, { ok: false, error: "bad minutes" });
        return;
      }
      stats.logPomodoro(minutes);
      economy.earn(5); // B2-2: focus-minute payout
      deps.checkAchievements();
      sendJson(res, 200, { ok: true });
    })();
    return;
  }

  // POST /api/dshbuddy/notes — { op: 'add'|'toggle'|'remove', note: {id, text, done?} }
  if (req.method === "POST" && path === "notes") {
    void (async () => {
      const body = (await readBody(req)) as {
        op?: string;
        note?: { id?: string; text?: string; done?: boolean };
      } | null;
      if (!body?.op) {
        sendJson(res, 400, { ok: false, error: "missing op" });
        return;
      }
      const notes = mutateNotes(body.op, body.note);
      sendJson(res, 200, { ok: true, notes });
    })();
    return;
  }

  // GET /api/dshbuddy/calendar?year=&month=
  if (req.method === "GET" && path === "calendar") {
    const year = Number(url.searchParams.get("year")) || new Date().getFullYear();
    const month = Number(url.searchParams.get("month")) || new Date().getMonth() + 1;
    sendJson(res, 200, { ok: true, entries: readCalendar(year, month) });
    return;
  }

  // POST /api/dshbuddy/calendar — { date, startTime?, endTime?, note? } or { op:"remove", date }
  if (req.method === "POST" && path === "calendar") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string; id?: string; date?: string; startTime?: string; endTime?: string; note?: string } | null;
      if (!body?.date) {
        sendJson(res, 400, { ok: false, error: "missing date" });
        return;
      }
      const entries = body.op === "remove"
        ? removeCalendar(body.date, body.id)
        : writeCalendar(body.date, body.startTime ?? "", body.endTime ?? "", body.note ?? "", body.id);
      sendJson(res, 200, { ok: true, entries });
    })();
    return;
  }

  // GET /api/dshbuddy/chats — local conversation list (id/title/updatedAt/count)
  if (req.method === "GET" && path === "chats") {
    const conversations = readChats()
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    sendJson(res, 200, { ok: true, conversations });
    return;
  }

  // POST /api/dshbuddy/chats — { op: "new" | "delete", id? }
  if (req.method === "POST" && path === "chats") {
    void (async () => {
      const body = (await readBody(req)) as { op?: string; id?: string; title?: string } | null;
      if (!body?.op) {
        sendJson(res, 400, { ok: false, error: "missing op" });
        return;
      }
      if (body.op === "new") {
        const conv = newChat(body.title);
        const chats = readChats();
        chats.unshift(conv);
        writeChats(chats);
        sendJson(res, 200, { ok: true, conversation: { id: conv.id, title: conv.title, updatedAt: conv.updatedAt, count: 0 } });
        return;
      }
      if (body.op === "delete" && body.id) {
        const chats = readChats().filter((c) => c.id !== body.id);
        writeChats(chats);
        sendJson(res, 200, {
          ok: true,
          conversations: chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length })),
        });
        return;
      }
      sendJson(res, 400, { ok: false, error: "bad op" });
    })();
    return;
  }

  // GET /api/dshbuddy/chat?conversationId= — messages of one conversation
  if (req.method === "GET" && path === "chat") {
    const cid = url.searchParams.get("conversationId");
    const conv = readChats().find((c) => c.id === cid);
    sendJson(res, 200, { ok: true, messages: conv ? conv.messages : [] });
    return;
  }

  // GET /api/dshbuddy/market/sprite?url=<encoded trusted sprite URL> — proxy the
  // pet sprite so the browser can preview it: assets.petdex.dev hotlink-blocks
  // requests that carry the DSH app's Referer, but a server-side fetch (no
  // Referer) succeeds, and serving it same-origin avoids any CORS/hotlink issue.
  if (req.method === "GET" && path === "market/sprite") {
    const target = url.searchParams.get("url");
    if (!target || !isTrustedAssetUrl(target)) {
      sendJson(res, 400, { ok: false, error: "bad url" });
      return;
    }
    void (async () => {
      try {
        const r = await fetch(target, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) {
          sendJson(res, 502, { ok: false, error: "upstream" });
          return;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get("content-type") || "image/webp";
        res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
        res.end(buf);
      } catch {
        sendJson(res, 502, { ok: false, error: "upstream" });
      }
    })();
    return;
  }

  // GET /api/dshbuddy/market — online pet catalog (proxied from petdex)
  if (req.method === "GET" && path === "market") {
    void (async () => {
      const pets = await fetchMarket();
      if (!pets) {
        sendJson(res, 502, { ok: false, error: "market_unavailable" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        pets: pets.map((p) => ({
          slug: p.slug,
          displayName: p.displayName,
          description: p.description ?? "",
          spritesheetUrl: p.spritesheetUrl,
          petJsonUrl: p.petJsonUrl,
        })),
      });
    })();
    return;
  }

  // POST /api/dshbuddy/market/install — { slug } download & install a pet
  if (req.method === "POST" && path === "market/install") {
    void (async () => {
      const body = (await readBody(req)) as { slug?: string } | null;
      if (!body?.slug) {
        sendJson(res, 400, { ok: false, error: "missing slug" });
        return;
      }
      const ok = await installMarketPet(body.slug);
      sendJson(res, ok ? 200 : 400, { ok, error: ok ? undefined : "install_failed" });
    })();
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}

// ── pet market (proxied from petdex.dev) ───────────────────────────────────

const MARKET_URL = "https://petdex.dev/api/manifest";
// Anti-SSRF asset allowlist: the manifest API is trusted, but the asset URLs
// it returns are still data, so only hosts we explicitly allow are downloaded.
// Current petdex assets are served from assets.petdex.dev (spritesheetUrl +
// petJsonUrl both live there).
const TRUSTED_ASSET_HOSTS = new Set([
  "assets.petdex.dev",
  // Legacy asset hosts (older petdex API) retained for backward compatibility.
  "pub-94495283df974cfea5e98d6a9e3fa462.r2.dev",
  "yu2vz9gndp.ufs.sh",
]);

type MarketPet = {
  slug: string;
  displayName: string;
  spritesheetUrl: string;
  petJsonUrl: string;
  description?: string;
};

function isTrustedAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return TRUSTED_ASSET_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

async function fetchMarket(): Promise<MarketPet[] | null> {
  try {
    // The manifest is large (~1.6 MB for ~4.5k pets); give it a generous budget.
    const res = await fetch(MARKET_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { pets?: MarketPet[] };
    return Array.isArray(data.pets) ? data.pets : null;
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function installMarketPet(slug: string): Promise<boolean> {
  const pets = await fetchMarket();
  if (!pets) return false;
  const pet = pets.find((p) => p.slug === slug);
  if (!pet) return false;
  if (!isTrustedAssetUrl(pet.spritesheetUrl) || !isTrustedAssetUrl(pet.petJsonUrl)) return false;
  if (findPetDir(pet.slug)) return false; // never overwrite an existing pet dir
  const [petJson, sheet] = await Promise.all([fetchBytes(pet.petJsonUrl), fetchBytes(pet.spritesheetUrl)]);
  if (!petJson || !sheet) return false;
  const ext = pet.spritesheetUrl.endsWith(".png") ? "png" : "webp";
  // Install into the plugin-local pets root (official CLI roots stay read-only).
  return installPetToRoots(pet.slug, petJson, sheet, ext);
}

// ── proactive caring ───────────────────────────────────────────────────────

const BUDDY_MEMORY_MAX = 24;

type MemoryItem = { text: string; ts: number };

function memoryPath(): string {
  return join(RUNTIME_DIR, "buddy-memory.json");
}

function readBuddyMemory(): MemoryItem[] {
  try {
    const p = memoryPath();
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as MemoryItem[];
    return Array.isArray(raw) ? raw.slice(-BUDDY_MEMORY_MAX) : [];
  } catch {
    return [];
  }
}

function writeBuddyMemory(memory: MemoryItem[]): void {
  try {
    const p = memoryPath();
    mkdirSync(p.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(p, JSON.stringify(memory, null, 2));
  } catch {
    // best-effort
  }
}

/** Pull the user's message text out of a user/message frame (best-effort). */
function extractUserText(data: Record<string, unknown>): string {
  for (const c of [data.content, data.text, data.message]) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 400);
    if (c && typeof c === "object") {
      const t = (c as { text?: string }).text;
      if (typeof t === "string" && t.trim()) return t.trim().slice(0, 400);
    }
  }
  return "";
}

/** Log a caring exchange into the pet's chat ("care" conversation). */
function appendCare(kind: string, care: string): void {
  const chats = readChats();
  let conv = chats.find((c) => c.id === "care");
  if (!conv) {
    conv = { id: "care", title: "鲸灵关怀记录", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    chats.unshift(conv);
  }
  const now = Date.now();
  conv.messages.push(
    { role: "user", content: `（触发：${kind || "主动关心"}）`, ts: now },
    { role: "assistant", content: care, ts: now },
  );
  conv.updatedAt = now;
  writeChats(chats);
}

/**
 * Remove one order's「收到工作单」log pair from the care conversation —
 * deleting/canceling an order should not leave ghost entries behind.
 */
function pruneOrderCareTrail(task: string): void {
  const needle = task.trim().slice(0, 40);
  if (!needle) return;
  const chats = readChats();
  const conv = chats.find((c) => c.id === "care");
  if (!conv || !Array.isArray(conv.messages)) return;
  const kept: ChatMsg[] = [];
  for (let i = 0; i < conv.messages.length; i++) {
    const m = conv.messages[i];
    const next = conv.messages[i + 1];
    if (
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.includes("order-add") &&
      next &&
      next.role === "assistant" &&
      typeof next.content === "string" &&
      next.content.includes(needle)
    ) {
      i++; // drop the trigger+text pair
      continue;
    }
    kept.push(m);
  }
  if (kept.length !== conv.messages.length) {
    conv.messages = kept;
    conv.updatedAt = Date.now();
    writeChats(chats);
  }
}

/**
 * Startup sweep: drop every「收到工作单」pair whose task matches no live
 * order — heals logs left by deleted orders or pre-isolation test runs.
 */
function sweepStaleOrderCareLogs(liveTasks: string[]): void {
  const live = new Set(liveTasks.map((t) => t.trim()));
  const chats = readChats();
  const conv = chats.find((c) => c.id === "care");
  if (!conv || !Array.isArray(conv.messages)) return;
  const kept: ChatMsg[] = [];
  for (let i = 0; i < conv.messages.length; i++) {
    const m = conv.messages[i];
    const next = conv.messages[i + 1];
    const isOrderAdd =
      m.role === "user" && typeof m.content === "string" && m.content.includes("order-add");
    if (isOrderAdd && next && next.role === "assistant" && typeof next.content === "string") {
      const task = next.content
        .replace(/^收到工作单：/, "")
        .replace(/（[^）]*）\s*$/, "")
        .trim();
      if (!live.has(task)) {
        i++; // stale trail → drop the pair
        continue;
      }
    }
    kept.push(m);
  }
  if (kept.length !== conv.messages.length) {
    conv.messages = kept;
    conv.updatedAt = Date.now();
    writeChats(chats);
  }
}

/** Compact HH:mm label for order bubbles. */
function formatOrderTime(triggerAt: number): string {
  const d = new Date(triggerAt);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── notes / calendar persistence ───────────────────────────────────────────

type Note = { id: string; text: string; done: boolean; createdAt: number };

function notesPath(): string {
  return join(RUNTIME_DIR, "notes.json");
}

function readNotes(): Note[] {
  try {
    const p = notesPath();
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as Note[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function mutateNotes(op: string, note?: { id?: string; text?: string; done?: boolean }): Note[] {
  const notes = readNotes();
  if (op === "add" && note?.text) {
    notes.unshift({ id: note.id ?? String(Date.now()), text: note.text, done: false, createdAt: Date.now() });
  } else if (op === "toggle" && note?.id) {
    const target = notes.find((n) => n.id === note.id);
    if (target) target.done = !target.done;
  } else if (op === "remove" && note?.id) {
    const idx = notes.findIndex((n) => n.id === note.id);
    if (idx >= 0) notes.splice(idx, 1);
  } else if (op === "clear-done") {
    const kept = notes.filter((n) => !n.done);
    notes.length = 0;
    notes.push(...kept);
  }
  try {
    const p = notesPath();
    mkdirSync(p.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(p, JSON.stringify(notes, null, 2));
  } catch {
    // best-effort
  }
  return notes;
}

type CalendarEntry = { id: string; date: string; startTime: string; endTime: string; note: string; hours?: number };

function calendarPath(): string {
  return join(RUNTIME_DIR, "calendar.json");
}

function readCalendar(year: number, month: number): CalendarEntry[] {
  try {
    const p = calendarPath();
    if (!existsSync(p)) return [];
    const raw = normalizeCalendar(JSON.parse(readFileSync(p, "utf8")));
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    return Array.isArray(raw) ? raw.filter((e) => e.date.startsWith(prefix)) : [];
  } catch {
    return [];
  }
}

function normalizeCalendar(raw: unknown): CalendarEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const e = value as Partial<CalendarEntry>;
    if (typeof e.date !== "string") return [];
    return [{
      id: typeof e.id === "string" && e.id ? e.id : `legacy-${e.date}-${index}`,
      date: e.date,
      startTime: typeof e.startTime === "string" ? e.startTime : "",
      endTime: typeof e.endTime === "string" ? e.endTime : "",
      note: typeof e.note === "string" ? e.note : "",
      ...(typeof e.hours === "number" ? { hours: e.hours } : {}),
    }];
  });
}

function writeCalendar(date: string, startTime: string, endTime: string, note: string, id?: string): CalendarEntry[] {
  try {
    const p = calendarPath();
    let entries: CalendarEntry[] = [];
    if (existsSync(p)) {
      entries = normalizeCalendar(JSON.parse(readFileSync(p, "utf8")));
    }
    const hours = startTime && endTime ? Math.max(0, (toMin(endTime) - toMin(startTime)) / 60) : undefined;
    const entry: CalendarEntry = { id: id || randomUUID(), date, startTime, endTime, note, ...(hours === undefined ? {} : { hours }) };
    const idx = id ? entries.findIndex((e) => e.id === id) : -1;
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    mkdirSync(p.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(p, JSON.stringify(entries, null, 2));
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    return entries.filter((e) => e.date.startsWith(`${year}-${String(month).padStart(2, "0")}`));
  } catch {
    return [];
  }
}

function toMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Remove one date's calendar entry (and its time-range record). */
function removeCalendar(date: string, id?: string): CalendarEntry[] {
  try {
    const p = calendarPath();
    let entries: CalendarEntry[] = [];
    if (existsSync(p)) {
      entries = normalizeCalendar(JSON.parse(readFileSync(p, "utf8")));
    }
    entries = entries.filter((e) => id ? e.id !== id : e.date !== date);
    writeFileSync(p, JSON.stringify(entries, null, 2));
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    return entries.filter((e) => e.date.startsWith(`${year}-${String(month).padStart(2, "0")}`));
  } catch {
    return [];
  }
}

// ── chat conversations (local persistence) ──────────────────────────────────

type ChatMsg = { role: "user" | "assistant"; content: string; ts: number };
type ChatConversation = { id: string; title: string; createdAt: number; updatedAt: number; messages: ChatMsg[] };

function chatsPath(): string {
  return join(RUNTIME_DIR, "chats.json");
}

function readChats(): ChatConversation[] {
  try {
    const p = chatsPath();
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as ChatConversation[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeChats(chats: ChatConversation[]): void {
  try {
    const p = chatsPath();
    mkdirSync(p.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(p, JSON.stringify(chats, null, 2));
  } catch {
    // best-effort
  }
}

function newChat(title?: string): ChatConversation {
  const now = Date.now();
  return { id: `ch${now}`, title: (title ?? "").trim() || "新对话", createdAt: now, updatedAt: now, messages: [] };
}

function appendChat(id: string, userContent: string, assistantContent: string): ChatConversation | null {
  const chats = readChats();
  let conv = chats.find((c) => c.id === id);
  if (!conv) {
    conv = newChat(userContent.slice(0, 24));
    chats.unshift(conv);
  }
  if (conv.title === "新对话" && conv.messages.length === 0 && userContent) conv.title = userContent.slice(0, 24);
  const now = Date.now();
  conv.messages.push({ role: "user", content: userContent, ts: now }, { role: "assistant", content: assistantContent, ts: now });
  conv.updatedAt = now;
  writeChats(chats);
  return conv;
}
