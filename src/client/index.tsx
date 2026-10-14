/**
 * DSHBuddy client half — plugin body.
 *   - shell.overlay: the pet floater (corner docked or bottom walker) + panels.
 *   - settings.section: ONE "DSHBuddy" entry; SettingsPanel switches feature tabs.
 *
 * v0.3: pet switching moved into the floater/walker menu (the old fixed
 * top-right switcher ignored where the pet actually was); connection status
 * and the active pet slug flow down to the overlay components.
 */

import { useEffect, useState } from "react";
import { PetFloater } from "./PetFloater.js";
import { PetWalker } from "./PetWalker.js";
import { GrowthPanel } from "./GrowthPanel.js";
import { CursorThief } from "./CursorThief.js";
import { CareCard, careCardActive } from "./CareCard.js";
import { BreathOverlay } from "./BreathOverlay.js";
import { buddyGet, buddyPost, useBuddySnapshot, type BuddyConfig, type SnapshotGrowth } from "./useBuddyState.js";
import {
  CalendarPanel,
  ChatPanel,
  NotesPanel,
  PomodoroPanel,
  QuickCommandsPanel,
  type PanelKind,
  MorningReportPanel,
} from "./panels.js";
import { SettingsPanel } from "./settings/SettingsPanel.js";
import { setModelEffortServices } from "./useModelEffort.js";
import { takePending } from "./panelBus.js";
import { THEMES } from "./theme.js";
import { setLang } from "./i18n.js";

/** Minimal client plugin context shape (type-only). */
export type ClientContext = {
  effect(fn: () => unknown, label?: string): void;
  get<T = unknown>(name: string): T | undefined;
  slots: {
    inject(name: string, cb: () => unknown): void;
    register(options: unknown, component: unknown): unknown;
  };
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): unknown;
  };
};

const NS = "dshbuddy";

const inject = ["slots", "locale"];

function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh: {}, en: {} }), "dshbuddy: dictionaries");

  const slots = ctx.get<{
    inject(name: string, cb: () => unknown): void;
    register(options: unknown, component: unknown): unknown;
  }>("slots");
  if (!slots) return;

  // Capture shell services for the model-effort slider (optional; the slider
  // hides itself when either service is unavailable).
  setModelEffortServices(ctx.get("sessions"), ctx.get("connection"));

  // ── pet floater (global overlay) ────────────────────────────────────────
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      { name: "shell.overlay", id: "dshbuddy-pet", order: 100, locale: NS },
      PetLayer,
    ),
  );

  // ── ONE settings entry: DSHBuddy (tabs inside) ──────────────────────────
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      { name: "settings.section", id: "dshbuddy", order: 70, label: () => "DSHBuddy", locale: NS },
      SettingsPanel,
    ),
  );
}

// ── pet floater overlay ────────────────────────────────────────────────────

function PetLayer(_props: { useSessions?: unknown }) {
  const { data, connected } = useBuddySnapshot(250);
  const [activePanel, setActivePanel] = useState<PanelKind>(null);
  // While the cursor thief is running the regular pet hides (it IS the thief).
  const [thiefActive, setThiefActive] = useState(false);
  // Last dismissed care-card timestamp (a new care ts reopens the card).
  // Must be STATE, not a ref: the snapshot poll skips re-renders while the
  // payload is unchanged, so a ref write alone would never hide the card.
  const [careDismissedTs, setCareDismissedTs] = useState<number>(0);
  // Daily morning report (auto-opens once per day, morning hours only).
  const [morningReport, setMorningReport] = useState<{ report: string; source: string; festival: string | null } | null>(null);

  const config: BuddyConfig | null = data?.config ?? null;
  const visible = config?.visible ?? true;

  useEffect(() => {
    if (!visible || !data) return; // wait until the overlay is actually live
    const now = new Date();
    const hour = now.getHours();
    if (hour < 5 || hour >= 12) return;
    const key = `dshbuddy:morning-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    let shown = false;
    try {
      shown = localStorage.getItem(key) === "1";
    } catch {
      // storage unavailable → show anyway (host caches per day too)
    }
    if (shown) return;
    void buddyGet<{ ok: boolean; date: string; report: string; source: string; festival: string | null }>("morning").then((j) => {
      if (!j?.ok || !j.report) return;
      setMorningReport({ report: j.report, source: j.source, festival: j.festival });
      setActivePanel((p) => p ?? "morning"); // never steal an already-open panel
      try {
        localStorage.setItem(key, "1");
      } catch {
        // ignore
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, Boolean(data)]);

  // Keep i18n language in sync with the persisted config.
  useEffect(() => {
    if (config?.language) setLang(config.language);
  }, [config?.language]);

  // Settings tabs can ask the floater to open a panel (chat/calendar/pomodoro).
  // A request may arrive while the overlay is unmounted (the DSH settings view
  // can unmount shell.overlay), so we consume the pending mailbox on mount too.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const kind = (e as CustomEvent).detail as PanelKind;
      if (kind) {
        takePending(); // clear the mailbox — we're handling it now
        setActivePanel(kind);
      }
    };
    window.addEventListener("dshbuddy:open-panel", onOpen);
    const queued = takePending();
    if (queued) setActivePanel(queued);
    return () => window.removeEventListener("dshbuddy:open-panel", onOpen);
  }, []);

  if (!visible || !data) return null;

  // 鲸灵 care card: show only for CARD-level cares (v0.4 escalation ladder —
  // gentle nudges ride the pet bubble instead of stealing attention), while
  // fresh, and not dismissed.
  const careTs = data.snapshot?.care?.ts ?? 0;
  const careText = data.snapshot?.care?.text ?? "";
  const careLevel = data.snapshot?.care?.level ?? "bubble";
  // Letter tone (burnout/wind-down) keeps the card up until explicitly dismissed.
  const careLetter = (data.snapshot?.care?.tone ?? "normal") === "letter";
  const showCareCard =
    !thiefActive && careLevel === "card" && careCardActive(careTs, careLetter) && careDismissedTs !== careTs;

  const switchMode = async () => {
    const next = config?.floaterMode === "corner" ? "walker" : "corner";
    await buddyPost("config", { floaterMode: next });
  };

  // Cache-bust the sprite by pet slug so switching pets reloads the image.
  const spriteUrl = data.pet?.slug
    ? `/api/dshbuddy/sprite?v=${encodeURIComponent(data.pet.slug)}`
    : "/api/dshbuddy/sprite";

  const common = {
    snapshot: data.snapshot,
    scale: config?.petScale ?? 1,
    spriteUrl,
    growth: data.growth ?? null,
    economy: data.economy ?? null,
    sessions: data.sessions ?? null,
    context: data.context ?? null,
    connected,
    activePetSlug: data.pet?.slug ?? null,
    // While the 鲸灵 CareCard shows this care message, pet bubbles back off.
    suppressCare: showCareCard,
    onScale: (v: number) => {
      void buddyPost("config", { petScale: v });
    },
    onSwitchMode: () => void switchMode(),
    onHide: () => {
      void buddyPost("config", { visible: false });
    },
    onOpenSettings: () => {
      window.dispatchEvent(new CustomEvent("dshbuddy:open-settings"));
    },
    onPanel: (kind: PanelKind) => setActivePanel(kind),
  };

  const mode = config?.floaterMode ?? "corner";
  const themeVars = THEMES[config?.skin === "light" ? "light" : "dark"];

  return (
    <div data-dshbuddy="1" style={{ ...themeVars, position: "fixed", inset: 0, pointerEvents: "none" }}>
      {!thiefActive &&
        (mode === "corner" ? (
          <PetFloater {...common} summary={data.summary} displayName={data.pet?.displayName ?? null} />
        ) : (
          <PetWalker {...common} />
        ))}
      {/* Mouse thief: steals the idle cursor and runs around with it. */}
      <CursorThief
        enabled={config?.mouseStealEnabled ?? true}
        idleMinutes={config?.mouseStealIdleMin ?? 3}
        suppressed={activePanel !== null}
        spriteUrl={spriteUrl}
        scale={config?.petScale ?? 1}
        onActive={setThiefActive}
      />
      {/* 鲸灵 proactive-care popup (independent of panels, hides while thief runs) */}
      {showCareCard && careText && (
        <CareCard
          careText={careText}
          careTs={careTs}
          reasonKey={data.snapshot?.care?.reasonKey}
          snoozeKind={data.snapshot?.care?.kind}
          letter={careLetter}
          onDismiss={() => {
            setCareDismissedTs(careTs);
          }}
          onOpenChat={() => {
            setCareDismissedTs(careTs);
            setActivePanel("chat");
          }}
        />
      )}
      {activePanel === "breath" && <BreathOverlay onClose={() => setActivePanel(null)} />}
      {activePanel === "commands" && <QuickCommandsPanel onClose={() => setActivePanel(null)} />}
      {activePanel === "pomodoro" && <PomodoroPanel onClose={() => setActivePanel(null)} />}
      {activePanel === "chat" && <ChatPanel onClose={() => setActivePanel(null)} />}
      {activePanel === "notes" && <NotesPanel onClose={() => setActivePanel(null)} />}
      {activePanel === "calendar" && <CalendarPanel onClose={() => setActivePanel(null)} />}
      {activePanel === "growth" && <GrowthPanel onClose={() => setActivePanel(null)} />}
      {activePanel === "morning" && morningReport && (
        <MorningReportPanel
          onClose={() => setActivePanel(null)}
          report={morningReport.report}
          source={morningReport.source}
          festival={morningReport.festival}
        />
      )}
    </div>
  );
}

export { apply, inject };
