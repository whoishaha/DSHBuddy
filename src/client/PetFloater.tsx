/**
 * PetFloater — mode ①: pet docked anywhere on the page, draggable, with a
 * popup menu (switch pet / panels / zoom / walker mode / settings / hide).
 *
 * v0.3 UX fixes & polish:
 *  - drag threshold: releasing after a real drag no longer pops the menu;
 *  - position persists across page reloads (localStorage, clamped on restore);
 *  - unified PopMenu with icons, inline pet-picker and viewport clamping;
 *  - theme-token chips (level / intensity / today turns), offline dot;
 *  - care bubble via timer hook (works with adaptive polling).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BuddySnapshot, BuddySummary, SnapshotGrowth, SnapshotEconomy, SnapshotSessions, SnapshotContext } from "./useBuddyState.js";
import { SessionOrbs, subagentChipText } from "./SessionOrbs.js";
import { ContextChip } from "./ContextChip.js";
import { buddyGet, buddyPost } from "./useBuddyState.js";
import type { PanelKind } from "./panels.js";
import { t } from "./i18n.js";
import { moodLabel } from "./growthLabels.js";
import { PetSprite } from "./PetSprite.js";
import { Bubble, BUBBLE_PERSIST_STATES, useCareText, toneFor } from "./Bubble.js";
import { EffortSlider } from "./EffortSlider.js";
import { PopMenu, PopItem, PopLabel, PopSep, PopSlider, PetPickerSection } from "./menu.js";
import { useIdleSleep, ALERT_STATES } from "./useIdleSleep.js";
import { accessoryEmoji } from "./cosmetics.js";
import { isShiny } from "./rarity.js";
import { ensureFx } from "./fx.js";

const SIZE = 72; // displayed pet width (px)
const HEIGHT = Math.round((SIZE / 192) * 208);
/** Movement (px) beyond which a press counts as a drag, not a click. */
const DRAG_THRESHOLD = 4;

const POS_KEY = "dshbuddy:floater-pos";
/** Hold the pointer this long (without dragging) to start petting. */
const PET_PRESS_MS = 430;

/** Spawn a few floating glyphs at a viewport point (transient DOM). */
function spawnFloat(x: number, y: number, n = 4, glyphs: string[] = ["❤️", "💛"]) {
  ensureFx();
  for (let i = 0; i < n; i++) {
    const el = document.createElement("span");
    el.className = "dshb-heart";
    el.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
    el.style.left = `${x + (Math.random() * 2 - 1) * 20}px`;
    el.style.top = `${y - 6 + (Math.random() * 2 - 1) * 6}px`;
    el.style.setProperty("--dshb-hx", `${Math.round((Math.random() * 2 - 1) * 44)}px`);
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 1250);
  }
}

function loadSavedPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x: number; y: number };
    if (typeof p?.x === "number" && typeof p?.y === "number") return p;
  } catch {
    // ignore corrupt storage
  }
  return null;
}

const INTENSITY_DOT: Record<string, string> = {
  quiet: "#64748b",
  normal: "#3b82f6",
  busy: "#f59e0b",
  intense: "#ef4444",
  night_shift: "#8b5cf6",
};

export function PetFloater({
  snapshot,
  summary,
  displayName,
  scale,
  spriteUrl,
  growth,
  economy = null,
  sessions = null,
  context = null,
  connected = true,
  activePetSlug = null,
  onScale,
  onOpenSettings,
  onSwitchMode,
  onHide,
  onPanel,
  suppressCare = false,
}: {
  snapshot: BuddySnapshot;
  summary: BuddySummary | null;
  displayName: string | null;
  scale: number;
  spriteUrl: string;
  growth: SnapshotGrowth | null;
  economy?: SnapshotEconomy | null;
  sessions?: SnapshotSessions | null;
  /** B3-3 resolved model context capacity (null → chip auto-hides). */
  context?: SnapshotContext | null;
  connected?: boolean;
  activePetSlug?: string | null;
  onScale: (v: number) => void;
  onOpenSettings: () => void;
  onSwitchMode: () => void;
  onHide: () => void;
  onPanel: (kind: PanelKind) => void;
  /** True while the 鲸灵 CareCard displays the same care message. */
  suppressCare?: boolean;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(loadSavedPos);
  const [menu, setMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  // Local zoom mirrors the persisted petScale; the slider writes both so the
  // pet resizes instantly and the config round-trip keeps them in sync.
  const [zoom, setZoom] = useState(scale);
  // Inline pet-picker state (lazy-loaded when expanded).
  const [showPets, setShowPets] = useState(false);
  const [pets, setPets] = useState<{ slug: string; displayName: string }[]>([]);
  const [petsLoading, setPetsLoading] = useState(false);

  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  // Shift the popup menu so it never overflows the viewport.
  const [, forceTick] = useState(0);
  // ── petting (摸头): long-press or menu → wiggle + hearts + intimacy ──
  const [petting, setPetting] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pettingIV = useRef<ReturnType<typeof setInterval> | null>(null);
  const justPetted = useRef(false);

  useEffect(() => {
    ensureFx();
  }, []);

  // ── level-up celebration: ✨ burst when the reported level increases ──
  const prevLevelRef = useRef<number | null>(null);
  const level = growth?.level ?? null;
  useEffect(() => {
    if (level != null && prevLevelRef.current != null && level > prevLevelRef.current) {
      const g = geoRef.current;
      spawnFloat(g.left + g.w / 2, g.top + g.h * 0.3, 9, ["✨", "⭐", "🎉"]);
    }
    prevLevelRef.current = level;
  }, [level]);

  /** Status aura under the pet: amber fast pulse while waiting for approval,
   *  blue slow pulse while the agent is working; nothing when idle. */
  const st = (snapshot.state || "").toLowerCase();
  const aura = st.includes("wait") ? "waiting" : st.includes("run") || st.includes("review") ? "working" : null;

  // ── sleep ambience (B1-3): doze off on long page idleness while off-duty.
  // Suppressed while the care card shows or a menu/petting interaction is live
  // (hover implies activity anyway, but menu state can outlive it).
  const alert = ALERT_STATES.has(snapshot.state);
  const { asleep, justWoke } = useIdleSleep({ busy: alert, suppress: suppressCare || menu || petting });

  useEffect(() => {
    setZoom(scale);
  }, [scale]);

  /** Bottom-left default; clamp keeps the pet fully inside the viewport. */
  const clampPos = useCallback(
    (p: { x: number; y: number } | null): { x: number; y: number } => {
      const w = SIZE * zoom;
      const h = HEIGHT * zoom;
      const vw = typeof window !== "undefined" ? window.innerWidth : 0;
      const vh = typeof window !== "undefined" ? window.innerHeight : 0;
      const base = p ?? { x: 16, y: Math.max(0, vh - h - 24) };
      return {
        x: Math.min(Math.max(base.x, 0), Math.max(0, vw - w)),
        y: Math.min(Math.max(base.y, 0), Math.max(0, vh - h)),
      };
    },
    [zoom],
  );

  // Place at the saved/default corner on mount, and keep on-screen across
  // resizes and zoom changes (the pet grows/shrinks in place).
  useEffect(() => {
    setPos((p) => clampPos(p));
    const onResize = () => {
      setPos((p) => clampPos(p));
      forceTick((n) => n + 1); // let an open menu re-clamp
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampPos]);

  // Lazy-load the installed pet list whenever the picker section shows.
  useEffect(() => {
    if (!menu || !showPets) return;
    let alive = true;
    setPetsLoading(true);
    void buddyGet<{ ok: boolean; pets: { slug: string; displayName: string }[] }>("pets").then((json) => {
      if (alive) {
        setPetsLoading(false);
        if (json?.ok) setPets(json.pets ?? []);
      }
    });
    return () => {
      alive = false;
    };
  }, [menu, showPets]);

  const persistPos = (p: { x: number; y: number }) => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(p));
    } catch {
      // storage unavailable — session-only positioning
    }
  };

  const w = SIZE * zoom;
  const h = HEIGHT * zoom;
  const left = pos?.x ?? (typeof window !== "undefined" ? 16 : 0);
  const top = pos?.y ?? (typeof window !== "undefined" ? Math.max(0, window.innerHeight - h - 24) : 0);
  // Latest geometry for event handlers (avoids stale closures).
  const geoRef = useRef({ left, top, w, h });
  geoRef.current = { left, top, w, h };

  // ── petting implementation ─────────────────────────────────────────────
  const doPat = () => {
    void buddyPost<{ ok: boolean }>("pet", { op: "head" });
  };
  const heartBurst = () => {
    const g = geoRef.current;
    spawnFloat(g.left + g.w / 2, g.top + g.h * 0.35, 4);
  };
  const beginPetting = useCallback(() => {
    if (pettingIV.current) return;
    justPetted.current = true;
    setPetting(true);
    doPat();
    heartBurst();
    pettingIV.current = setInterval(() => {
      doPat();
      heartBurst();
    }, 700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const endPetting = useCallback(() => {
    if (pettingIV.current) {
      clearInterval(pettingIV.current);
      pettingIV.current = null;
    }
    setPetting(false);
    window.setTimeout(() => {
      justPetted.current = false;
    }, 350);
  }, []);
  /** One-shot pat from the menu (brief wiggle + hearts). */
  const patOnce = useCallback(() => {
    setMenu(false);
    doPat();
    heartBurst();
    justPetted.current = true;
    setPetting(true);
    window.setTimeout(() => setPetting(false), 900);
    window.setTimeout(() => {
      justPetted.current = false;
    }, 1200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Clear petting timers when the floater unmounts.
  useEffect(
    () => () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
      if (pettingIV.current) clearInterval(pettingIV.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const start = pos ?? { x: 16, y: Math.max(0, window.innerHeight - HEIGHT * zoom - 24) };
      drag.current = { sx: e.clientX, sy: e.clientY, ox: start.x, oy: start.y, moved: false };
      setDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      // Long-press (no drag) → pet the pet.
      if (pressTimer.current) clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => {
        if (!drag.current?.moved) beginPetting();
      }, PET_PRESS_MS);
    },
    [pos, zoom, beginPetting],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!d.moved && pressTimer.current) clearTimeout(pressTimer.current); // it's a drag
      d.moved = true;
      if (pettingIV.current) endPetting();
      const w = SIZE * zoom;
      const h = HEIGHT * zoom;
      const nx = Math.min(Math.max(d.ox + dx, 0), Math.max(0, window.innerWidth - w));
      const ny = Math.min(Math.max(d.oy + dy, 0), Math.max(0, window.innerHeight - h));
      setPos({ x: nx, y: ny });
    },
    [zoom, endPetting],
  );

  const onPointerUp = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (pettingIV.current || justPetted.current) endPetting();
    if (drag.current?.moved && pos) persistPos(pos);
    drag.current = null;
    setDragging(false);
  }, [pos, endPetting]);

  // Care bubble first, then status bubble (tone picks matching frame color).
  // While the 鲸灵 CareCard is showing the same message, the bubble backs off —
  // otherwise the user reads the identical care text twice.
  const rawCareText = useCareText(snapshot);
  const careText = suppressCare ? null : rawCareText;
  const bubbleText = careText ?? snapshot.bubble;
  const bubbleVisible = careText ? true : Boolean(snapshot.bubble);
  const bubblePersist = careText ? true : snapshot.bubblePersist ?? BUBBLE_PERSIST_STATES.has(snapshot.state);
  const tone = toneFor(careText, snapshot.bubble ?? "");

  const resetPosition = () => {
    const p = { x: 16, y: Math.max(0, window.innerHeight - h - 24) };
    setPos(p);
    try {
      localStorage.removeItem(POS_KEY);
    } catch {
      // ignore
    }
    setMenu(false);
  };

  return (
    <div
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 2147483000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        pointerEvents: "auto",
        userSelect: "none",
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onDoubleClick={onOpenSettings}
      onClick={() => {
        if (justPetted.current || drag.current?.moved) return;
        setMenu((m) => !m);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Bubble text={bubbleText} visible={bubbleVisible} persist={bubblePersist} tone={tone} flat={dragging} />
      <div
        style={{
          position: "relative",
          width: SIZE * zoom,
          height: HEIGHT * zoom,
          transform: hover && !dragging ? "translateY(-3px)" : "none",
          transition: "transform 160ms ease",
        }}
      >
        {/* grounding shadow + status aura (both breathe with the idle bob) */}
        <div className="dshb-ground-shadow" style={asleep ? { opacity: 0.5 } : undefined} />
        {aura && !dragging && !asleep && <div className={`dshb-aura ${aura}`} />}
        {asleep && (
          <div
            title={t("pet.sleeping")}
            style={{ position: "absolute", top: -2, right: 4, zIndex: 11, pointerEvents: "none" }}
          >
            <span className="dshb-zzz">💤</span>
          </div>
        )}
        {/* idle breathing wrapper — the wiggle (petting) rides on top of it.
            Sleep dims the sprite and slows its clock; waking plays one pop. */}
        <div
          className="dshb-pet-body"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, textAlign: "center" }}
        >
          <div
            key={justWoke ? "startle" : "calm"}
            className={`${petting ? "dshb-wiggle" : ""} ${justWoke ? "dshb-startle" : ""}`.trim() || undefined}
            style={{ position: "relative", display: "inline-block" }}
          >
            <div className={asleep ? "dshb-sleep-dim" : isShiny(activePetSlug ?? "") ? "dshb-shiny" : undefined}>
              <PetSprite state={snapshot.state} scale={(SIZE / 192) * zoom} spriteUrl={spriteUrl} speed={asleep ? 0.3 : 1} />
            </div>
          </div>
        </div>
        {/* hover mini-toolbar (idea credit: dsh-ventus-whale): one-tap access
            to the most common actions without opening the full menu */}
        {hover && !dragging && !menu && (
          <div
            style={{
              position: "absolute",
              left: `calc(100% - 4px)`,
              top: "34%",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              zIndex: 12,
            }}
          >
            {(
              [
                ["💬", t("nav.chat"), () => onPanel("chat")],
                ["🍅", t("nav.pomodoro"), () => onPanel("pomodoro")],
                ["🫶", t("pet.head"), patOnce],
                ["⚙️", t("pet.settings"), () => onOpenSettings()],
              ] as [string, string, () => void][]
            ).map(([icon, title, onClick]) => (
              <button
                key={title}
                title={title}
                onClick={(e) => {
                  e.stopPropagation();
                  onClick();
                }}
                className="dshb-iconbtn"
                style={{
                  width: 27,
                  height: 27,
                  borderRadius: 9,
                  border: "1px solid var(--buddy-chip-border)",
                  background: "var(--buddy-chip-bg)",
                  backdropFilter: "blur(8px)",
                  fontSize: 13,
                  lineHeight: 1,
                  padding: 0,
                  boxShadow: "var(--buddy-shadow)",
                }}
              >
                {icon}
              </button>
            ))}
          </div>
        )}
        {summary && summary.todayTurns > 0 && (
          <div
            title={t("pet.chip.turnsTitle", [summary.todayTurns, summary.todayTools])}
            style={{
              position: "absolute",
              bottom: 4,
              right: 0,
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
              color: "var(--buddy-panel-muted)",
              background: "var(--buddy-chip-bg)",
              border: "1px solid var(--buddy-chip-border)",
              borderRadius: 8,
              padding: "2px 6px",
              whiteSpace: "nowrap",
              backdropFilter: "blur(6px)",
            }}
          >
            {t("pet.chip.turns", [summary.todayTurns])}
          </div>
        )}
        {growth && (
          <div
            title={t("pet.chip.levelTitle", [growth.level, growth.intensity, moodLabel(growth.mood)])}
            style={{
              position: "absolute",
              bottom: 4,
              left: 0,
              fontSize: 10,
              color: "var(--buddy-panel-fg)",
              background: "var(--buddy-chip-bg)",
              border: "1px solid var(--buddy-chip-border)",
              borderRadius: 8,
              padding: "2px 6px",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 4,
              backdropFilter: "blur(6px)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: INTENSITY_DOT[growth.intensityLevel] ?? "#64748b",
                boxShadow: `0 0 0 2px color-mix(in srgb, ${INTENSITY_DOT[growth.intensityLevel] ?? "#64748b"} 28%, transparent)`,
                flex: "none",
              }}
            />
            Lv.{growth.level}
            {economy && (
              <span title={t("pet.coins")} style={{ opacity: 0.85 }}>
                · 🪙{economy.coins}
              </span>
            )}
            {/* subagent-aware chip (B3-2): 🎧 for one, ×n when juggling */}
            {sessions && sessions.subagents > 0 && (
              <span title={t("pet.sessions.subagent")} style={{ opacity: 0.9 }}>
                · {subagentChipText(sessions.subagents)}
              </span>
            )}
            {/* context-capacity chip (B3-3) — hidden until the probe succeeds */}
            <ContextChip context={context} longestRunningMs={sessions?.longestRunningMs ?? 0} />
          </div>
        )}
        {/* worn shop accessory (B2-2) — tiny emoji riding above the head */}
        {accessoryEmoji(economy?.equipped) && !menu && (
          <div
            style={{
              position: "absolute",
              top: -12,
              left: "50%",
              transform: `translateX(-50%) scale(${Math.max(0.7, scale)})`,
              fontSize: 14,
              lineHeight: 1,
              pointerEvents: "none",
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))",
            }}
          >
            {accessoryEmoji(economy?.equipped)}
          </div>
        )}
        {/* parallel-session orbs (B3-2) — hover above the accessory row */}
        {sessions && sessions.running > 0 && !menu && (
          <div
            style={{
              position: "absolute",
              top: -28,
              left: "50%",
              transform: `translateX(-50%) scale(${Math.max(0.7, scale)})`,
            }}
          >
            <SessionOrbs sessions={sessions} />
          </div>
        )}
        {!connected && (
          <div
            title={t("pet.disconnected")}
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--buddy-danger)",
              animation: "dshb-pulse 1.2s ease-in-out infinite",
            }}
          />
        )}
      </div>
      <PopMenu open={menu} onClose={() => setMenu(false)}>
        <PopLabel>{displayName ?? t("pet.title")}{growth ? ` · Lv.${growth.level}` : ""}</PopLabel>
        <PopItem icon="🫶" label={t("pet.head")} onClick={patOnce} />
        <PopItem icon="🐾" label={t("pet.switch")} onClick={() => setShowPets((v) => !v)} />
        {showPets && (
          <div style={{ paddingLeft: 6 }}>
            <PetPickerSection
              pets={pets}
              activeSlug={activePetSlug}
              loading={petsLoading}
              onPick={(slug) => {
                void buddyPost("activate", { slug }).then(() => {
                  setMenu(false);
                  setShowPets(false);
                });
              }}
            />
          </div>
        )}
        <PopSep />
        <PopItem icon="🌟" label={t("growth.archive")} onClick={() => { onPanel("growth"); setMenu(false); }} />
        <PopItem icon="⚡" label={t("nav.commands")} onClick={() => { onPanel("commands"); setMenu(false); }} />
        <PopItem icon="🍅" label={t("nav.pomodoro")} onClick={() => { onPanel("pomodoro"); setMenu(false); }} />
        <PopItem icon="💬" label={t("nav.chat")} onClick={() => { onPanel("chat"); setMenu(false); }} />
        <PopItem icon="✅" label={t("nav.notes")} onClick={() => { onPanel("notes"); setMenu(false); }} />
        <PopItem icon="📅" label={t("nav.calendar")} onClick={() => { onPanel("calendar"); setMenu(false); }} />
        <PopSep />
        <PopSlider
          label={t("pet.zoom")}
          value={zoom}
          display={`${Math.round(zoom * 100)}%`}
          min={0.5}
          max={1.5}
          step={0.05}
          onChange={(v) => {
            setZoom(v);
            onScale(v);
          }}
        />
        <EffortSlider />
        <PopSep />
        <PopItem icon="↺" label={t("pet.relocate")} onClick={resetPosition} />
        <PopItem icon="🚶" label={t("pet.mode.walker")} onClick={() => { setMenu(false); onSwitchMode(); }} />
        <PopItem icon="⚙️" label={t("pet.settings")} onClick={() => { setMenu(false); onOpenSettings(); }} />
        <PopItem icon="🙈" label={t("pet.hide")} danger onClick={() => { setMenu(false); onHide(); }} />
      </PopMenu>
    </div>
  );
}
