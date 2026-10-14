/**
 * Pet sprite animation — ported from Petdex desktop `ui/pet.js`.
 *
 * Renders the active pet's spritesheet (served same-origin by the host half at
 * /api/dshbuddy/sprite) using CSS background-position frame stepping with
 * time-modulo timing, so no per-frame timers are needed.
 */

export const GRID = {
  frameW: 192,
  frameH: 208,
  anims: {
    idle: { row: 0, frames: 6, dur: 1100 },
    runRight: { row: 1, frames: 8, dur: 1060 },
    runLeft: { row: 2, frames: 8, dur: 1060 },
    wave: { row: 3, frames: 4, dur: 700 },
    jump: { row: 4, frames: 5, dur: 840 },
    fail: { row: 5, frames: 8, dur: 1220 },
    wait: { row: 6, frames: 6, dur: 1010 },
    run: { row: 7, frames: 6, dur: 820 },
    review: { row: 8, frames: 6, dur: 1030 },
  },
} as const;

export type AnimKey = keyof typeof GRID.anims;

export const STATE_MAP: Record<string, AnimKey> = {
  idle: "idle",
  running: "run",
  working: "run",
  "running-left": "runLeft",
  "running-right": "runRight",
  waving: "wave",
  jumping: "jump",
  failed: "fail",
  waiting: "wait",
  review: "review",
};

export function animForState(state: string): AnimKey {
  return STATE_MAP[state] ?? "idle";
}

/** Frame index for a keyed animation at time `now` (ms). */
export function frameAt(anim: AnimKey, now: number): number {
  const a = GRID.anims[anim];
  return Math.floor((now % a.dur) / (a.dur / a.frames)) % a.frames;
}

export const SPRITE_URL = "/api/dshbuddy/sprite";
