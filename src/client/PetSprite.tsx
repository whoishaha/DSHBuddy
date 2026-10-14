/**
 * PetSprite — the animated pet. Frame stepping writes background-position
 * DIRECTLY to the DOM (no per-frame React state), so the animation stays
 * smooth and cheap.
 *
 * v0.3.4 smoothness/efficiency rework:
 *  - the stepper no longer polls at display refresh (60+ rAF wakeups/s for a
 *    ~6-8fps sheet). It draws the current frame, then schedules the next draw
 *    exactly at the NEXT FRAME BOUNDARY (wall-clock modulo, drift-free) —
 *    ~8 timer wakeups/s instead of ~60, so the page's main thread stays free
 *    for the walk loop and everything else;
 *  - style write happens only when the frame index actually changes;
 *  - the loop idles while the tab is hidden (visibilitychange) to save battery.
 */

import { useEffect, useRef } from "react";
import { GRID, animForState, type AnimKey } from "./sprite.js";

/** Frame index for a keyed animation at time `now` (ms). */
function frameAt(anim: AnimKey, now: number): number {
  const a = GRID.anims[anim];
  return Math.floor((now % a.dur) / (a.dur / a.frames)) % a.frames;
}

export function PetSprite({
  state,
  scale = 1,
  spriteUrl,
  className = "",
  /** Animation speed multiplier — <1 slows the loop (sleep breathes slowly). */
  speed = 1,
}: {
  state: string;
  scale?: number;
  spriteUrl: string;
  className?: string;
  speed?: number;
}) {
  const anim: AnimKey = animForState(state);
  const speedRef = useRef(speed);
  speedRef.current = Math.max(0.1, speed);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const a = GRID.anims[anim];
    const box = boxRef.current;
    if (!box) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastFrame = -1;

    const draw = () => {
      const now = Date.now();
      // Sleep-slowed clock: advance a virtual timeline at `speed` so frames
      // change less often without freezing mid-cycle.
      const frame = frameAt(anim, now * speedRef.current);
      if (frame !== lastFrame) {
        lastFrame = frame;
        box.style.backgroundPosition = `${-frame * GRID.frameW}px ${-a.row * GRID.frameH}px`;
      }
      // Schedule the next draw precisely at the next frame boundary of the
      // (possibly slowed) virtual clock. Recomputing from the wall clock
      // every tick keeps long-run drift at zero.
      const frameDur = a.dur / a.frames / speedRef.current;
      const delay = Math.max(30, frameDur - ((now * speedRef.current) % (frameDur)));
      timer = setTimeout(draw, delay);
    };

    const stop = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const start = () => {
      stop();
      lastFrame = -1; // force one redraw on (re)start
      draw();
    };

    const onVis = () => {
      if (document.hidden) stop();
      else start();
    };

    if (typeof document === "undefined" || !document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [anim]);

  return (
    <div
      style={{
        // Layout box == visual box: the unscaled 192×208 sheet is scaled from
        // its TOP-LEFT inside an outer box already sized to the scaled dims.
        // (The old bottom-center origin made layout ≠ visuals, so anything
        // anchoring to the box — bubbles, mouths, hit areas — missed the pet.)
        width: GRID.frameW * scale,
        height: GRID.frameH * scale,
        position: "relative",
        pointerEvents: "none",
      }}
    >
      <div
        ref={boxRef}
        className={className}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: GRID.frameW,
          height: GRID.frameH,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          backgroundImage: `url(${spriteUrl})`,
          backgroundRepeat: "no-repeat",
          imageRendering: "pixelated",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
