/**
 * CursorThief — "the pet steals your mouse" idle play.
 *
 * When the user hasn't moved the mouse for `idleMinutes`, the pet "grabs" the
 * cursor arrow and runs around the screen with it. Browsers can't move the OS
 * pointer, so we do the equivalent: hide the page cursor (CSS class), render a
 * look-alike arrow carried at the pet's mouth, and wander full-screen. ANY
 * user activity (mouse / wheel / key / touch) makes the pet drop the arrow:
 * it tweens back to the REAL pointer position, the real cursor reappears
 * exactly under it, then the arrow fades — so the user instantly sees where
 * their mouse is.
 *
 * Safety rails: disabled while a buddy panel is open (suppressed), while the
 * tab is hidden, and entirely for prefers-reduced-motion users.
 */

import { useEffect, useRef, useState } from "react";
import { PetSprite } from "./PetSprite.js";
import { ensureFx } from "./fx.js";
import { buddyPost } from "./useBuddyState.js";
import { t } from "./i18n.js";

type Phase = "idle" | "carrying" | "dropping";

const SPEED = 120; // px/s wander speed (× scale) — brisk for the small thief
const EDGE = 48; // horizontal safe margin
const TOP_EDGE = 96; // keep below the DSH header area
const BOTTOM_EDGE = 56;
const WAYPOINT_MS = 2600; // pick a new wander target every …
/** Match the docked pet's visual size (PetFloater shows it 72px wide at
 *  scale=1) — the thief must NOT be bigger than the pet the user set up. */
const PET_W = 72;
const PET_H = Math.round((PET_W / 192) * 208);
const SPRITE_BASE = PET_W / 192; // sprite scale inside the box at scale=1
/** Mouth offset of the carried arrow, relative to the sprite box (fraction). */
const MOUTH = { x: 0.62, y: 0.55 };
const DROP_MS = 220; // arrow return tween duration
const HOLD_MS = 650; // keep the arrow at the real pointer before fading

function ArrowGlyph() {
  return (
    <svg width="26" height="30" viewBox="0 0 13 15" aria-hidden>
      <path
        d="M1 1 L1 12.2 L3.9 9.6 L5.8 14 L7.9 13.1 L6 8.9 L10 8.6 Z"
        fill="#ffffff"
        stroke="#1f2328"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CursorThief({
  enabled,
  idleMinutes,
  suppressed,
  spriteUrl,
  scale,
  onActive,
}: {
  enabled: boolean;
  idleMinutes: number;
  suppressed: boolean;
  spriteUrl: string;
  scale: number;
  onActive?: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const petWrapRef = useRef<HTMLDivElement>(null);
  const petFlipRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);

  const posRef = useRef({ x: 0, y: 0 }); // thief pet box top-left
  const dirRef = useRef<1 | -1>(1);
  const targetRef = useRef({ x: 0, y: 0 });
  const nextPickRef = useRef(0);
  const lastTsRef = useRef(0);
  const realRef = useRef({ x: 0, y: 0 }); // real pointer position
  const scaleRef = useRef(scale);
  const idleMinRef = useRef(idleMinutes);
  const lastActivityRef = useRef(Date.now());
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafRef = useRef(0);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  useEffect(() => {
    idleMinRef.current = idleMinutes;
  }, [idleMinutes]);

  // Track user activity globally (also while another element handles it).
  useEffect(() => {
    if (!enabled || suppressed) return;
    const bump = () => {
      lastActivityRef.current = Date.now();
    };
    window.addEventListener("mousemove", bump, { passive: true });
    window.addEventListener("mousedown", bump, { passive: true });
    window.addEventListener("wheel", bump, { passive: true });
    window.addEventListener("touchstart", bump, { passive: true });
    window.addEventListener("keydown", bump);
    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("mousedown", bump);
      window.removeEventListener("wheel", bump);
      window.removeEventListener("touchstart", bump);
      window.removeEventListener("keydown", bump);
    };
  }, [enabled, suppressed]);

  // Theft lifecycle.
  useEffect(() => {
    if (!enabled || suppressed) return;
    if (typeof window === "undefined") return;

    ensureFx();
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    let raf = 0;

    const placeArrow = (x: number, y: number) => {
      const el = arrowRef.current;
      if (el) el.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
    };

    /** Position the pet box; the arrow rides the (flip-aware) mouth point.
     *  The inner box mirrors around its own center so the footprint never
     *  shifts when facing changes. */
    const placePet = () => {
      const el = petWrapRef.current;
      if (el) el.style.transform = `translate(${posRef.current.x}px, ${posRef.current.y}px)`;
      const flip = petFlipRef.current;
      if (flip) flip.style.transform = `scaleX(${dirRef.current})`;
      const s = scaleRef.current;
      const bw = PET_W * s;
      const bh = PET_H * s;
      const mx = posRef.current.x + (dirRef.current === 1 ? MOUTH.x : 1 - MOUTH.x) * bw;
      const my = posRef.current.y + MOUTH.y * bh;
      placeArrow(mx, my);
    };

    const pickTarget = () => {
      const s = scaleRef.current;
      targetRef.current = {
        x: EDGE + Math.random() * Math.max(1, window.innerWidth - PET_W * s - EDGE * 2),
        y: TOP_EDGE + Math.random() * Math.max(1, window.innerHeight - PET_H * s - TOP_EDGE - BOTTOM_EDGE),
      };
      nextPickRef.current = performance.now() + WAYPOINT_MS + Math.random() * 1200;
    };

    const carryLoop = (now: number) => {
      if (phaseRef.current !== "carrying") return;
      const dt = Math.min(0.05, (now - lastTsRef.current) / 1000 || 0.016);
      lastTsRef.current = now;
      if (now > nextPickRef.current) pickTarget();
      const dx = targetRef.current.x - posRef.current.x;
      const dy = targetRef.current.y - posRef.current.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 2) {
        const v = SPEED * scaleRef.current;
        posRef.current.x += (dx / dist) * v * dt;
        posRef.current.y += (dy / dist) * v * dt;
        if (Math.abs(dx) > 6) dirRef.current = dx > 0 ? 1 : -1;
      }
      placePet();
      raf = requestAnimationFrame(carryLoop);
    };

    const beginCarry = () => {
      phaseRef.current = "carrying";
      setPhase("carrying");
      onActive?.(true);
      document.documentElement.classList.add("dshb-cursor-stolen");
      // The theft happens right where the cursor is.
      const s = scaleRef.current;
      posRef.current = {
        x: Math.min(
          Math.max(realRef.current.x - PET_W * s * MOUTH.x, EDGE),
          Math.max(EDGE, window.innerWidth - PET_W * s - EDGE),
        ),
        y: Math.min(
          Math.max(realRef.current.y - PET_H * s * MOUTH.y, TOP_EDGE),
          Math.max(TOP_EDGE, window.innerHeight - PET_H * s - BOTTOM_EDGE),
        ),
      };
      dirRef.current = 1;
      pickTarget();
      lastTsRef.current = performance.now();
      placePet();
      void buddyPost("signal", { kind: "custom", text: t("thief.steal") });
      raf = requestAnimationFrame(carryLoop);
    };

    const dropArrow = () => {
      if (phaseRef.current !== "carrying") return;
      phaseRef.current = "dropping";
      // Pet scurries off + fades while the arrow flies home.
      const pet = petWrapRef.current;
      if (pet) {
        pet.style.transition = "opacity 280ms ease";
        pet.style.opacity = "0";
      }
      const el = arrowRef.current;
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el?.style.transform ?? "");
      const start = m ? { x: Number(m[1]), y: Number(m[2]) } : { ...realRef.current };
      const t0 = performance.now();
      const step = (now: number) => {
        if (phaseRef.current !== "dropping") return;
        const k = Math.min(1, (now - t0) / DROP_MS);
        const e = 1 - Math.pow(1 - k, 3); // cubic-out
        placeArrow(start.x + (realRef.current.x - start.x) * e, start.y + (realRef.current.y - start.y) * e);
        if (k < 1) {
          raf = requestAnimationFrame(step);
          return;
        }
        // Arrow now sits exactly over the real pointer → give the cursor back,
        // linger briefly so the user registers the spot, then fade out.
        document.documentElement.classList.remove("dshb-cursor-stolen");
        if (el) el.style.transition = "opacity 320ms ease";
        timersRef.current.push(
          setTimeout(() => {
            if (el) el.style.opacity = "0";
            timersRef.current.push(
              setTimeout(() => {
                phaseRef.current = "idle";
                setPhase("idle");
                onActive?.(false);
                void buddyPost("signal", { kind: "custom", text: t("thief.return") });
              }, 340),
            );
          }, HOLD_MS),
        );
      };
      raf = requestAnimationFrame(step);
    };

    /** Any input: remember where the REAL pointer is, and release if stolen.
     *  Typed loosely on purpose: one handler serves mouse/wheel/key/touch. */
    const markActivity = (e?: Event) => {
      lastActivityRef.current = Date.now();
      const me = e as MouseEvent | undefined;
      if (me && typeof me.clientX === "number" && !document.hidden) {
        realRef.current = { x: me.clientX, y: me.clientY };
      }
      if (phaseRef.current === "carrying") dropArrow();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      markActivity();
      void e;
    };

    const onVisibility = () => {
      if (document.hidden && phaseRef.current === "carrying") dropArrow();
    };

    const iv = setInterval(() => {
      if (document.hidden || phaseRef.current !== "idle") return;
      if (Date.now() - lastActivityRef.current >= Math.max(1, idleMinRef.current) * 60_000) {
        beginCarry();
      }
    }, 1000);

    window.addEventListener("mousemove", markActivity, { passive: true });
    window.addEventListener("mousedown", markActivity, { passive: true });
    window.addEventListener("wheel", markActivity, { passive: true });
    window.addEventListener("touchstart", markActivity, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(iv);
      cancelAnimationFrame(raf);
      for (const t of timersRef.current.splice(0)) clearTimeout(t);
      window.removeEventListener("mousemove", markActivity);
      window.removeEventListener("mousedown", markActivity);
      window.removeEventListener("wheel", markActivity);
      window.removeEventListener("touchstart", markActivity);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);
      document.documentElement.classList.remove("dshb-cursor-stolen");
      if (phaseRef.current !== "idle") {
        phaseRef.current = "idle";
        onActive?.(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, suppressed]);

  // Always render the layers while active so refs exist when the loop starts.
  const show = phase !== "idle";
  return (
    <>
      <div
        ref={petWrapRef}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          zIndex: 2147483000,
          width: PET_W * scale,
          height: PET_H * scale,
          pointerEvents: "none",
          willChange: "transform",
          transformOrigin: "top left",
          display: show ? "block" : "none",
        }}
      >
        <div
          ref={petFlipRef}
          style={{ width: "100%", height: "100%", transformOrigin: "center" }}
        >
          <PetSprite state="running-right" scale={SPRITE_BASE * scale} spriteUrl={spriteUrl} />
        </div>
      </div>
      <div
        ref={arrowRef}
        className="dshb-thief-arrow"
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          zIndex: 2147483001,
          width: 26,
          height: 30,
          willChange: "transform",
          display: show ? "block" : "none",
        }}
      >
        <ArrowGlyph />
      </div>
    </>
  );
}
