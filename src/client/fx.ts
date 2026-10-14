/**
 * fx — one-shot global stylesheet for DSHBuddy overlay UI.
 *
 * Inline styles can't express keyframes / pseudo-classes / media queries, so
 * every animated or hover-styled piece of the floater (bubble pop-in, menu
 * fade, icon-button hover, thin scrollbars, typing dots) uses a class defined
 * here. The sheet is injected once per page and never removed (harmless,
 * class-scoped, and re-used across plugin reloads).
 */

let injected = false;

const CSS = `
/* ── DSHBuddy animations ─────────────────────────────────────────────── */
@keyframes dshb-pop-in {
  from { opacity: 0; transform: translateY(6px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dshb-pop-below {
  from { opacity: 0; transform: translateY(-6px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dshb-pop-out {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to   { opacity: 0; transform: translateY(4px) scale(0.97); }
}
@keyframes dshb-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes dshb-typing {
  0% { opacity: 0.25; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
  100% { opacity: 0.25; transform: translateY(0); }
}
@keyframes dshb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.dshb-pop { animation: dshb-pop-in 160ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both; }
.dshb-pop-below { animation: dshb-pop-below 160ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both; }
.dshb-pop-out { animation: dshb-pop-out 200ms ease both; }
.dshb-fade { animation: dshb-fade-in 200ms ease both; }

/* ── shared surface and form language ───────────────────────────────── */
.dshb-settings,
.dshb-panel-shell,
.dshb-menu {
  color: var(--buddy-panel-fg);
  font-family: inherit;
  -webkit-font-smoothing: antialiased;
}
.dshb-settings *,
.dshb-panel-shell *,
.dshb-menu * { box-sizing: border-box; }

.dshb-settings input,
.dshb-settings textarea,
.dshb-settings select,
.dshb-panel-shell input,
.dshb-panel-shell textarea,
.dshb-panel-shell select {
  transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
}
.dshb-settings input:hover,
.dshb-settings textarea:hover,
.dshb-settings select:hover,
.dshb-panel-shell input:hover,
.dshb-panel-shell textarea:hover,
.dshb-panel-shell select:hover { border-color: color-mix(in srgb, var(--buddy-accent) 44%, var(--buddy-panel-border)) !important; }
.dshb-settings input:focus,
.dshb-settings textarea:focus,
.dshb-settings select:focus,
.dshb-panel-shell input:focus,
.dshb-panel-shell textarea:focus,
.dshb-panel-shell select:focus {
  border-color: var(--buddy-accent) !important;
  box-shadow: 0 0 0 3px var(--buddy-accent-soft);
}
button:disabled { cursor: not-allowed !important; opacity: 0.55; }

/* ── settings: two-level top navigation + full-width content ────────── */
.dshb-settings {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 520px;
  min-width: 0;
  padding: 2px 0 20px;
  --buddy-surface-bg: transparent;
  --buddy-surface-raised: transparent;
  --buddy-shadow-soft: none;
}
.dshb-settings-nav {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 8px;
  padding: 0 0 10px;
  border-bottom: 1px solid var(--buddy-panel-border);
}
.dshb-settings-groups {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.dshb-settings-groups::-webkit-scrollbar { display: none; }
.dshb-settings-group-btn {
  flex: none;
  padding: 7px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--buddy-panel-muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.dshb-settings-group-btn:hover { color: var(--buddy-panel-fg); background: var(--buddy-row-bg); }
.dshb-settings-group-btn.dshb-on {
  color: var(--buddy-panel-fg);
  border-bottom-color: var(--buddy-accent);
}
.dshb-settings-group-btn:focus-visible { outline: 2px solid var(--buddy-accent); outline-offset: -2px; }
.dshb-settings-subnav {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 1px 0 2px;
  overscroll-behavior-inline: contain;
}
.dshb-settings-tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  flex: none;
  width: auto;
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--buddy-panel-muted);
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: color 140ms ease, background 140ms ease, border-color 140ms ease, transform 140ms ease;
}
.dshb-settings-tab:hover:not(.dshb-on) {
  color: var(--buddy-panel-fg);
  background: var(--buddy-row-hover);
}
.dshb-settings-tab.dshb-on {
  color: var(--buddy-panel-fg);
  background: var(--buddy-row-hover);
  border-color: transparent;
  font-weight: 650;
}
.dshb-settings-tab:active { transform: scale(0.985); }
.dshb-settings-tab:focus-visible { outline: 2px solid var(--buddy-accent); outline-offset: 2px; }
.dshb-settings-content {
  min-width: 0;
  min-height: 520px;
  padding: 0 4px 24px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.dshb-settings-content > * { animation: dshb-fade-in 160ms ease both; }
.dshb-settings-content h3 {
  color: var(--buddy-panel-fg);
  letter-spacing: -0.012em;
}
.dshb-settings-content h4 {
  color: var(--buddy-panel-fg);
  letter-spacing: 0.005em;
}
.dshb-tabbtn { transition: background 130ms ease, color 130ms ease, transform 130ms ease, border-color 130ms ease; }
.dshb-tabbtn:not(.dshb-on):hover {
  background: var(--buddy-row-hover) !important;
  color: var(--buddy-panel-fg) !important;
}
.dshb-tabbtn:active { transform: translateY(1px); }
.dshb-tabbtn:focus-visible { outline: 2px solid var(--buddy-accent); outline-offset: 2px; }

/* Companion home: a calm summary, with every feature still one click away. */
.dshb-home {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}
.dshb-home > section { min-width: 0; }
.dshb-home-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 20px;
  border: 1px solid var(--buddy-panel-border);
  border-radius: 14px;
  background: var(--buddy-row-bg);
}
.dshb-home-eyebrow {
  color: var(--buddy-panel-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.dshb-home-level {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}
.dshb-home-level strong {
  color: var(--buddy-accent);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}
.dshb-home-level span {
  color: var(--buddy-panel-muted);
  font-size: 10px;
  white-space: nowrap;
}
.dshb-home-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.dshb-home-section-head h4 { margin: 0; font-size: 13px; }
.dshb-home-link {
  padding: 3px 0;
  border: 0;
  background: transparent;
  color: var(--buddy-accent);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.dshb-home-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.dshb-home-link:focus-visible { outline: 2px solid var(--buddy-accent); outline-offset: 2px; }
.dshb-home-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.dshb-home-metric {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid var(--buddy-panel-border);
  border-radius: 11px;
  background: transparent;
}
.dshb-home-metric strong {
  overflow: hidden;
  color: var(--buddy-panel-fg);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
}
.dshb-home-metric span {
  overflow: hidden;
  color: var(--buddy-panel-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshb-home-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.dshb-home-actions button {
  min-height: 34px;
  padding: 7px 12px;
  border: 1px solid var(--buddy-panel-border);
  border-radius: 10px;
  background: transparent;
  color: var(--buddy-panel-fg);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
}
.dshb-home-actions button:hover {
  border-color: color-mix(in srgb, var(--buddy-accent) 40%, var(--buddy-panel-border));
  background: var(--buddy-row-hover);
}
.dshb-home-actions button:active { transform: translateY(1px); }
.dshb-home-actions button:focus-visible { outline: 2px solid var(--buddy-accent); outline-offset: 2px; }
.dshb-home-memory-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dshb-home-memory {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border-left: 2px solid var(--buddy-accent);
  border-radius: 0 9px 9px 0;
  background: var(--buddy-row-bg);
}
.dshb-home-memory strong { font-size: 12px; }
.dshb-home-memory span,
.dshb-home-empty {
  color: var(--buddy-panel-muted);
  font-size: 11px;
  line-height: 1.5;
}
@media (max-width: 600px) {
  .dshb-home-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dshb-home-hero { padding: 14px; }
}

/* ── floating panels ────────────────────────────────────────────────── */
.dshb-panel-shell {
  isolation: isolate;
  background: var(--buddy-surface-raised) !important;
  box-shadow: var(--buddy-shadow), inset 0 1px 0 color-mix(in srgb, white 7%, transparent) !important;
}
.dshb-panel-header {
  background: linear-gradient(180deg, var(--buddy-surface-raised), var(--buddy-surface-bg));
  cursor: grab !important;
}
.dshb-panel-header:active { cursor: grabbing !important; }
.dshb-panel-body { background: color-mix(in srgb, var(--buddy-panel-bg) 96%, transparent); }
.dshb-panel-resize { opacity: 0.5; transition: opacity 140ms ease; }
.dshb-panel-resize:hover { opacity: 1; }

@media (pointer: coarse) {
  .dshb-panel-resize { display: none; }
  .dshb-iconbtn { min-width: 32px; min-height: 32px; }
}

/* ── hover helpers (inline styles can't do :hover) ───────────────────── */
.dshb-iconbtn {
  background: none;
  border: none;
  color: var(--buddy-panel-muted);
  cursor: pointer;
  border-radius: 7px;
  display: inline-grid;
  place-items: center;
  transition: background 120ms, color 120ms, transform 120ms;
}
.dshb-iconbtn:hover { background: var(--buddy-row-hover); color: var(--buddy-panel-fg); }
.dshb-iconbtn:active { transform: translateY(1px); }

.dshb-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--buddy-panel-fg);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  transition: background 100ms;
}
.dshb-menu-item:hover:not(:disabled) { background: var(--buddy-row-hover); }
.dshb-menu-item:disabled { color: var(--buddy-panel-muted); cursor: default; }
.dshb-menu-item .dshb-menu-icon { width: 16px; text-align: center; flex: none; }

/* ── thin themed scrollbars for buddy panels ─────────────────────────── */
.dshb-scroll { scrollbar-width: thin; scrollbar-color: var(--buddy-panel-border) transparent; }
.dshb-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.dshb-scroll::-webkit-scrollbar-track { background: transparent; }
.dshb-scroll::-webkit-scrollbar-thumb {
  background: var(--buddy-panel-border);
  border-radius: 8px;
}
.dshb-scroll::-webkit-scrollbar-thumb:hover { filter: brightness(1.2); }

/* ── typing indicator dots ───────────────────────────────────────────── */
.dshb-typing { display: inline-flex; gap: 3px; align-items: center; }
.dshb-typing i {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--buddy-panel-muted);
  animation: dshb-typing 1s infinite;
}
.dshb-typing i:nth-child(2) { animation-delay: 0.15s; }
.dshb-typing i:nth-child(3) { animation-delay: 0.3s; }

/* ── cursor thief (pet steals the idle mouse arrow) ──────────────────── */
.dshb-cursor-stolen,
.dshb-cursor-stolen * { cursor: none !important; }
@keyframes dshb-arrow-swing {
  0%, 100% { transform: rotate(-16deg); }
  50% { transform: rotate(-2deg); }
}
.dshb-thief-arrow {
  filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));
  pointer-events: none;
}
.dshb-thief-arrow svg { animation: dshb-arrow-swing 900ms ease-in-out infinite; transform-origin: 20% 10%; }

/* ── petting: happy wiggle + floating hearts ─────────────────────────── */
@keyframes dshb-wiggle {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-3deg) translateY(-2px); }
  75% { transform: rotate(3deg) translateY(-2px); }
}
.dshb-wiggle { animation: dshb-wiggle 320ms ease-in-out infinite; }
@keyframes dshb-heart-float {
  0% { transform: translate(0, 0) scale(0.5); opacity: 0; }
  12% { opacity: 1; }
  100% { transform: translate(var(--dshb-hx, 0px), -84px) scale(1.2); opacity: 0; }
}
.dshb-heart {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 2147483002;
  pointer-events: none;
  font-size: 15px;
  line-height: 1;
  will-change: transform, opacity;
  animation: dshb-heart-float 1150ms ease-out forwards;
}

/* ── pet presence: idle breathing, ground shadow, status aura ────────── */
@keyframes dshb-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2.5px); }
}
.dshb-pet-body { animation: dshb-bob 3.4s ease-in-out infinite; }
.dshb-ground-shadow {
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 64%;
  height: 9px;
  margin-left: -32%;
  border-radius: 50%;
  /* pure soft gradient — no filter:blur, so it never adds per-frame filter cost */
  background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.28), rgba(0, 0, 0, 0.12) 45%, transparent 70%);
  pointer-events: none;
}
@keyframes dshb-shadow-breathe {
  0%, 100% { transform: scaleX(1); opacity: 0.9; }
  50% { transform: scaleX(0.86); opacity: 0.55; }
}
.dshb-ground-shadow { animation: dshb-shadow-breathe 3.4s ease-in-out infinite; }
/* v0.3.4: the aura pulses via opacity+scale only — animating box-shadow used
 * to repaint every frame; these two properties composite on the GPU thread,
 * which matters when the aura rides a walking pet. */
@keyframes dshb-aura-pulse {
  0% { transform: translateX(-50%) scale(0.65); opacity: 0.85; }
  100% { transform: translateX(-50%) scale(1.6); opacity: 0; }
}
.dshb-aura {
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 46%;
  height: 10px;
  border-radius: 50%;
  pointer-events: none;
  transform: translateX(-50%);
  will-change: transform, opacity;
}
.dshb-aura.working { background: radial-gradient(ellipse at center, rgba(56, 189, 248, 0.6), transparent 72%); animation: dshb-aura-pulse 1.8s ease-out infinite; }
.dshb-aura.waiting { background: radial-gradient(ellipse at center, rgba(251, 191, 36, 0.7), transparent 72%); animation: dshb-aura-pulse 1.1s ease-out infinite; }

/* ── swimming polish (walker mode) ─────────────────────────────────────
 * dshb-turn: quick squash-and-settle the instant the whale flips direction;
 * re-triggered from the walk loop by classList remove/add + reflow. */
@keyframes dshb-turn {
  0% { transform: scale(1, 1); }
  35% { transform: scale(1.08, 0.9) translateY(1px); }
  100% { transform: scale(1, 1); }
}
.dshb-turn { animation: dshb-turn 240ms cubic-bezier(0.34, 1.56, 0.64, 1); }

/* dshb-trail: tiny bubbles shed behind a swimming whale, rising & fading. */
@keyframes dshb-trail-rise {
  0% { transform: translate(0, 0) scale(0.6); opacity: 0; }
  15% { opacity: 0.75; }
  100% { transform: translate(var(--dshb-tx, 0px), -46px) scale(1.15); opacity: 0; }
}
.dshb-trail {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 2147482999;
  pointer-events: none;
  line-height: 1;
  font-size: 10px;
  will-change: transform, opacity;
  animation: dshb-trail-rise 1400ms ease-out forwards;
}

/* ── sleep ambience (B1-3): doze off when the page is idle ─────────────
 * The pet dims and breathes slowly (speed handled in PetSprite); a tiny
 * 💤 drifts up beside it. Waking plays one quick startle pop. */
.dshb-sleep-dim {
  filter: brightness(0.72) saturate(0.85);
  transition: filter 1200ms ease;
}
@keyframes dshb-zzz {
  0% { transform: translate(0, 0) scale(0.7); opacity: 0; }
  18% { opacity: 0.9; }
  100% { transform: translate(-10px, -34px) scale(1.15); opacity: 0; }
}
.dshb-zzz {
  position: absolute;
  top: -4px;
  right: 2px;
  font-size: 15px;
  pointer-events: none;
  animation: dshb-zzz 2.6s ease-out infinite;
}
@keyframes dshb-startle {
  0% { transform: scale(1, 1); }
  30% { transform: scale(1.14, 0.86); }
  60% { transform: scale(0.94, 1.08); }
  100% { transform: scale(1, 1); }
}
.dshb-startle { animation: dshb-startle 420ms cubic-bezier(0.34, 1.56, 0.64, 1); }

/* ── B2-3 adoption reveal: rarity pop-in + shine sweep + shiny variant ── */
@keyframes dshb-reveal-pop {
  0% { transform: scale(0.6) rotate(-4deg); opacity: 0; filter: blur(6px); }
  60% { transform: scale(1.06) rotate(1deg); opacity: 1; filter: blur(0); }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
.dshb-reveal { position: relative; overflow: hidden; animation: dshb-reveal-pop 520ms cubic-bezier(0.2, 0.9, 0.3, 1.15) both; }
@keyframes dshb-shine {
  0% { transform: translateX(-140%) skewX(-18deg); }
  100% { transform: translateX(240%) skewX(-18deg); }
}
/* one light sweep across the reveal card */
.dshb-reveal::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 40%;
  height: 100%;
  background: linear-gradient(105deg, transparent, rgba(255, 255, 255, 0.16), transparent);
  animation: dshb-shine 1400ms ease-out 320ms both;
  pointer-events: none;
}
.dshb-shiny { filter: hue-rotate(45deg) saturate(1.35) brightness(1.08); }
/* ── focus visibility for keyboard users ─────────────────────────────── */
.dshb-menu-item:focus-visible,
.dshb-iconbtn:focus-visible {
  outline: 2px solid var(--buddy-accent);
  outline-offset: 1px;
}

/* ── reduced motion: drop decorative animation, keep function ────────── */
@media (prefers-reduced-motion: reduce) {
  .dshb-pop, .dshb-pop-below, .dshb-pop-out, .dshb-fade { animation: none; }
  .dshb-typing i { animation-duration: 1.6s; }
  .dshb-pet-body, .dshb-ground-shadow, .dshb-aura, .dshb-thief-arrow svg,
  .dshb-turn, .dshb-trail { animation: none; }
  /* Sleep stays functional (dim + slowed frames), minus the motion bits. */
  .dshb-zzz, .dshb-startle { animation: none; }
  /* Reveal card still shows (static), minus pop + sweep. */
  .dshb-reveal, .dshb-reveal::after { animation: none; }
}
`;

/** Inject the stylesheet once (idempotent; safe to call from any component). */
export function ensureFx(): void {
  if (injected || typeof document === "undefined") return;
  if (document.getElementById("dshbuddy-fx")) {
    injected = true;
    return;
  }
  const el = document.createElement("style");
  el.id = "dshbuddy-fx";
  el.textContent = CSS;
  document.head.appendChild(el);
  injected = true;
}
