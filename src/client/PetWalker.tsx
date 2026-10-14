/**
 * PetWalker — mode ②: the pet roams freely along the bottom of the page,
 * pacing back and forth. The face direction is driven by the live movement
 * direction (right → right-facing, left → left-facing) whenever it is
 * actually moving, so a transient state tick never flips it.
 *
 * v0.3 polish:
 *  - hovering the pet pauses the stroll (so the menu is easy to hit);
 *  - unified PopMenu with icons / inline pet picker / zoom slider;
 *  - care bubble via timer hook (works with adaptive polling).
 *
 * v0.3.4 swim-smoothness rework:
 *  - the rAF loop STOPS entirely when the pet isn't moving (previously it
 *    spun empty 60Hz wakeups forever while paused/not-walking);
 *  - position rides translate3d (own compositor layer) plus a gentle sine
 *    "water glide" so the whale swims instead of sliding;
 *  - direction flips trigger a squash-and-settle turn dip (CSS, not JS);
 *  - the whale sheds tiny 🫧 bubbles behind it while swimming (throttled,
 *    capped, disabled for prefers-reduced-motion);
 *  - backdrop-filter glass on the bubble/chips is only ON while standing —
 *    a live blur riding a moving surface repainted the backdrop every frame
 *    and was the main source of walk jank;
 *  - ground shadow + status aura now match corner mode.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BuddySnapshot, SnapshotGrowth, SnapshotEconomy, SnapshotSessions, SnapshotContext } from "./useBuddyState.js";
import { SessionOrbs, subagentChipText } from "./SessionOrbs.js";
import { ContextChip } from "./ContextChip.js";
import { buddyGet, buddyPost } from "./useBuddyState.js";
import type { PanelKind } from "./panels.js";
import { PetSprite } from "./PetSprite.js";
import { Bubble, BUBBLE_PERSIST_STATES, useCareText, toneFor } from "./Bubble.js";
import { EffortSlider } from "./EffortSlider.js";
import { t } from "./i18n.js";
import { PopMenu, PopItem, PopLabel, PopSep, PopSlider, PetPickerSection } from "./menu.js";
import { useIdleSleep, ALERT_STATES } from "./useIdleSleep.js";
import { accessoryEmoji } from "./cosmetics.js";
import { isShiny } from "./rarity.js";
import { ensureFx } from "./fx.js";

const SIZE = 64;
const SPEED_IDLE = 30; // px/s — slow stroll while the agent is idle
const SPEED_BUSY = 90; // px/s — faster trot while the agent works
const EDGE_PAD = 24; // px — keep clear of both screen edges

/** States during which the pet keeps walking (idle stroll / running trot). */
const WALKING_STATES = new Set(["idle", "running", "running-left", "running-right"]);

/** Trail bubble cadence / caps — deliberately frugal. */
const TRAIL_EVERY_MS = 620;
const TRAIL_MAX_LIVE = 12;

let liveTrails = 0; // module-level cap across remounts

/** Spawn one tiny bubble glyph at a viewport point (transient DOM). */
function spawnTrail(x: number, y: number): void {
  if (liveTrails >= TRAIL_MAX_LIVE) return;
  liveTrails++;
  const el = document.createElement("span");
  el.className = "dshb-trail";
  el.textContent = Math.random() < 0.75 ? "◦" : "🫧";
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  el.style.fontSize = `${8 + Math.random() * 6}px`;
  el.style.setProperty("--dshb-tx", `${Math.round((Math.random() * 2 - 1) * 16)}px`);
  document.body.appendChild(el);
  window.setTimeout(() => {
    el.remove();
    liveTrails--;
  }, 1500);
}

const INTENSITY_DOT: Record<string, string> = {
  quiet: "#64748b",
  normal: "#3b82f6",
  busy: "#f59e0b",
  intense: "#ef4444",
  night_shift: "#8b5cf6",
};

export function PetWalker({
  snapshot,
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
  const [dir, setDir] = useState<1 | -1>(1);
  const [menu, setMenu] = useState(false);
  const [paused, setPaused] = useState(false); // hover pause
  // Inline pet-picker state (lazy-loaded when expanded).
  const [showPets, setShowPets] = useState(false);
  const [pets, setPets] = useState<{ slug: string; displayName: string }[]>([]);
  const [petsLoading, setPetsLoading] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef<HTMLDivElement>(null);
  const xRef = useRef(EDGE_PAD);
  const dirRef = useRef<1 | -1>(1);
  // Live values read by the rAF loop so walk bounds track size/pause state.
  const scaleRef = useRef(scale);
  const lastTsRef = useRef(0);
  const nextTrailRef = useRef(0);

  useEffect(() => {
    ensureFx();
  }, []);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // Seed the initial position once. The walk loop then owns `transform`
  // exclusively — React must never patch it, or a snapshot-poll re-render
  // mid-swim would snap the whale back to a stale x for a frame.
  useLayoutEffect(() => {
    if (wrapRef.current) {
      wrapRef.current.style.transform = `translate3d(${xRef.current}px, 0, 0)`;
    }
  }, []);

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

  const walking = WALKING_STATES.has(snapshot.state);
  const busy = !walking ? false : snapshot.state !== "idle";
  // ── sleep ambience (B1-3): doze off on long page idleness while off-duty;
  // a sleeping whale also stops swimming (it's asleep, after all).
  const alert = ALERT_STATES.has(snapshot.state);
  const { asleep, justWoke } = useIdleSleep({ busy: alert, suppress: suppressCare || menu });
  /** True only while the stroll is actually advancing. */
  const moving = walking && !paused && !menu && !asleep;
  /** Standing still (glass blur allowed again — nothing repaints underneath). */
  const standing = !moving;

  useEffect(() => {
    if (!moving) return; // no loop at all while paused / not walking
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let flippedThisFrame = false;
    lastTsRef.current = 0; // fresh dt on (re)start — no resume jump

    const loop = () => {
      const now = performance.now();
      const last = lastTsRef.current || now;
      lastTsRef.current = now;
      const dt = Math.min(0.1, (now - last) / 1000);
      const speed = busy ? SPEED_BUSY : SPEED_IDLE;
      const s = scaleRef.current;
      const size = SIZE * s;
      const maxX = Math.max(size + EDGE_PAD, window.innerWidth - size - EDGE_PAD);
      let nx = xRef.current + dirRef.current * speed * dt;
      flippedThisFrame = false;
      if (nx > maxX) {
        nx = maxX;
        dirRef.current = -1;
        flippedThisFrame = true;
        setDir(-1);
      } else if (nx < EDGE_PAD) {
        nx = EDGE_PAD;
        dirRef.current = 1;
        flippedThisFrame = true;
        setDir(1);
      }
      xRef.current = nx;
      // Gentle sine "water glide": the whale undulates instead of sliding.
      // Biased fully above the baseline (sin-1) so it never dips below the
      // bottom screen edge.
      const amp = (busy ? 2.4 : 1.9) * s;
      const gy = amp * (Math.sin(now / (busy ? 260 : 430)) - 1);
      // One composited write per frame — translate3d keeps it on the GPU.
      if (wrapRef.current) {
        wrapRef.current.style.transform = `translate3d(${nx.toFixed(2)}px, ${gy.toFixed(2)}px, 0)`;
      }
      // Turn dip: quick squash-and-settle the instant direction flips.
      if (flippedThisFrame && !reduced && turnRef.current) {
        const el = turnRef.current;
        el.classList.remove("dshb-turn");
        void el.offsetWidth; // restart the CSS animation
        el.classList.add("dshb-turn");
      }
      // Shed a trail bubble behind the whale (throttled).
      if (!reduced && now >= nextTrailRef.current) {
        nextTrailRef.current = now + (busy ? 460 : TRAIL_EVERY_MS);
        const tailX = dirRef.current === 1 ? nx + 2 : nx + size - 10;
        const tailY = window.innerHeight - Math.round((SIZE / 192) * 208) * s * (0.42 + Math.random() * 0.2);
        spawnTrail(tailX, tailY);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lastTsRef.current = 0;
    };
  }, [moving, busy]);

  // Facing tracks the live movement direction while swimming; a paused or
  // transiently-non-walking stroll settles into the idle animation.
  const animState = moving
    ? dir === 1
      ? "running-right"
      : "running-left"
    : WALKING_STATES.has(snapshot.state)
      ? "idle"
      : snapshot.state;

  // Care bubble first, then status bubble. suppressCare backs off while the
  // 鲸灵 CareCard is showing the same message (no double read).
  const rawCareText = useCareText(snapshot);
  const careText = suppressCare ? null : rawCareText;
  const bubbleText = careText ?? snapshot.bubble;
  const bubbleVisible = careText ? true : Boolean(snapshot.bubble);
  const bubblePersist = careText ? true : snapshot.bubblePersist ?? BUBBLE_PERSIST_STATES.has(snapshot.state);
  const tone = toneFor(careText, snapshot.bubble ?? "");

  /** Status aura under the pet — same semantics as corner mode. */
  const st = (snapshot.state || "").toLowerCase();
  const aura = st.includes("wait") ? "waiting" : st.includes("run") || st.includes("review") ? "working" : null;

  const dotColor = INTENSITY_DOT[growth?.intensityLevel ?? ""] ?? "#64748b";

  // B2-2 economy: worn cosmetic + coin chip (both modes share the language).
  const acc = accessoryEmoji(economy?.equipped);
  const coins = economy?.coins ?? 0;

  return (
    <div
      ref={wrapRef}
      style={{
        position: "fixed",
        left: 0,
        bottom: 0,
        zIndex: 2147483000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        pointerEvents: "auto",
        userSelect: "none",
        cursor: "pointer",
        willChange: "transform",
        touchAction: "none",
      }}
      onClick={() => setMenu((m) => !m)}
      onDoubleClick={onOpenSettings}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Bubble text={bubbleText} visible={bubbleVisible} persist={bubblePersist} tone={tone} flat={!standing} />
      <div style={{ position: "relative", width: SIZE * scale, height: Math.round((SIZE / 192) * 208) * scale }}>
        {/* grounding shadow + status aura — same presence language as corner */}
        {!menu && <div className="dshb-ground-shadow" style={asleep ? { opacity: 0.5 } : undefined} />}
        {aura && !menu && !asleep && <div className={`dshb-aura ${aura}`} />}
        {asleep && (
          <div
            title={t("pet.sleeping")}
            style={{ position: "absolute", top: -2, right: 4, zIndex: 11, pointerEvents: "none" }}
          >
            <span className="dshb-zzz">💤</span>
          </div>
        )}
        {/* worn shop accessory (B2-2) — a tiny emoji riding above the head */}
        {acc && !menu && (
          <div
            style={{
              position: "absolute",
              top: -12 * scale,
              left: "50%",
              transform: `translateX(-50%) scale(${Math.max(0.7, scale)})`,
              fontSize: 14,
              lineHeight: 1,
              zIndex: 10,
              pointerEvents: "none",
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))",
            }}
          >
            {acc}
          </div>
        )}
        {/* parallel-session orbs (B3-2) — hover above the accessory row */}
        {sessions && sessions.running > 0 && !menu && (
          <div
            style={{
              position: "absolute",
              top: -28 * scale,
              left: "50%",
              transform: `translateX(-50%) scale(${Math.max(0.7, scale)})`,
              zIndex: 9,
            }}
          >
            <SessionOrbs sessions={sessions} />
          </div>
        )}
        {/* idle breathing only while resting; swimming has its own glide.
            Sleep dims + slows the sprite; waking plays one startle pop. */}
        <div
          className={moving ? undefined : "dshb-pet-body"}
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, textAlign: "center" }}
        >
          {/* hover lift: rise a little when the user reaches for the whale */}
          <div
            key={justWoke ? "startle" : "calm"}
            className={justWoke ? "dshb-startle" : undefined}
            style={{
              display: "inline-block",
              position: "relative",
              transform: paused && !menu ? "translateY(-3px) scale(1.03)" : "none",
              transition: "transform 180ms ease",
            }}
          >
            <div ref={turnRef} style={{ display: "inline-block" }}>
              <div className={asleep ? "dshb-sleep-dim" : isShiny(activePetSlug ?? "") ? "dshb-shiny" : undefined}>
                <PetSprite state={animState} scale={(SIZE / 192) * scale} spriteUrl={spriteUrl} speed={asleep ? 0.3 : 1} />
              </div>
            </div>
          </div>
        </div>
        {growth && (
          <div
            title={t("pet.chip.levelTitle", [growth.level, growth.intensity, growth.mood])}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: 0.2,
              fontVariantNumeric: "tabular-nums",
              color: "var(--buddy-panel-fg)",
              background: "var(--buddy-chip-bg)",
              border: "1px solid var(--buddy-chip-border)",
              borderRadius: 999,
              padding: "1px 6px",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 4,
              // Glass only while standing: a live blur riding the swim loop
              // forces a full backdrop re-filter every frame.
              backdropFilter: standing ? "blur(6px)" : undefined,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: dotColor,
                boxShadow: `0 0 0 2px color-mix(in srgb, ${dotColor} 28%, transparent)`,
                flex: "none",
              }}
            />
            Lv.{growth.level}
            {economy && (
              <span title={t("pet.coins")} style={{ opacity: 0.85 }}>
                · 🪙{coins}
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
        {!connected && (
          <div
            title={t("pet.disconnected")}
            style={{
              position: "absolute",
              top: 2,
              left: 2,
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
        <PopLabel>{t("pet.title")}{growth ? ` · Lv.${growth.level}` : ""}</PopLabel>
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
          value={scale}
          display={`${Math.round(scale * 100)}%`}
          min={0.5}
          max={1.5}
          step={0.05}
          onChange={onScale}
        />
        <EffortSlider />
        <PopSep />
        <PopItem icon="🧍" label={t("pet.mode.corner")} onClick={() => { setMenu(false); onSwitchMode(); }} />
        <PopItem icon="⚙️" label={t("pet.settings")} onClick={() => { setMenu(false); onOpenSettings(); }} />
        <PopItem icon="🙈" label={t("pet.hide")} danger onClick={() => { setMenu(false); onHide(); }} />
      </PopMenu>
    </div>
  );
}
