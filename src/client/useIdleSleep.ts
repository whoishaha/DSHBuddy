/**
 * useIdleSleep — B1-3 pet sleep + startle ambience.
 *
 * After `idleMs` with NO page activity (mouse/keys/scroll/touch) AND the agent
 * not busy, the pet dozes off (slowed animation + dim + 💤). The first activity
 * startles it awake (`justWoke` pulses for a beat so the shell can play the
 * pop animation). Purely client-side ambience — no host round-trips.
 *
 * Deliberate non-features:
 *  - never sleeps while the agent is busy/waiting (you might be away but the
 *    pet stays on watch — that's the "ambient companion" contract);
 *  - never transitions while the tab is hidden (nothing to see; on return the
 *    fresh activity timestamp decides);
 *  - respects prefers-reduced-motion via CSS (the hook only reports state).
 */

import { useEffect, useRef, useState } from "react";

const ACTIVITY_EVENTS: [keyof WindowEventMap, EventTarget][] = [
  ["mousemove", window],
  ["mousedown", window],
  ["keydown", window],
  ["wheel", window],
  ["touchstart", window],
  ["scroll", window],
];

export function useIdleSleep(opts: {
  /** Agent busy / waiting → the pet must stay alert. */
  busy: boolean;
  /** Menu open / care card showing / thief running → hold off. */
  suppress?: boolean;
  /** Idle threshold before dozing off. */
  idleMs?: number;
}): { asleep: boolean; justWoke: boolean } {
  const { busy, suppress = false, idleMs = 60_000 } = opts;
  const [asleep, setAsleep] = useState(false);
  const [justWoke, setJustWoke] = useState(false);

  const lastActivityRef = useRef(Date.now());
  const asleepRef = useRef(false);
  const wakePulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const markActivity = () => {
      lastActivityRef.current = Date.now();
      if (asleepRef.current) {
        // Startle awake: report not-asleep immediately, pulse justWoke once.
        asleepRef.current = false;
        setAsleep(false);
        setJustWoke(true);
        if (wakePulseTimer.current) clearTimeout(wakePulseTimer.current);
        wakePulseTimer.current = setTimeout(() => setJustWoke(false), 1100);
      }
    };
    for (const [name, target] of ACTIVITY_EVENTS) {
      target.addEventListener(name, markActivity, { passive: true });
    }

    const iv = setInterval(() => {
      if (asleepRef.current) {
        // Conditions to STAY asleep: still idle-ish and not suppressed/busy.
        if (opts.busy || opts.suppress) {
          asleepRef.current = false;
          setAsleep(false);
        }
        return;
      }
      if (opts.busy || opts.suppress) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (Date.now() - lastActivityRef.current >= idleMs) {
        asleepRef.current = true;
        setAsleep(true);
      }
    }, 1000);

    return () => {
      for (const [name, target] of ACTIVITY_EVENTS) {
        target.removeEventListener(name, markActivity);
      }
      clearInterval(iv);
      if (wakePulseTimer.current) clearTimeout(wakePulseTimer.current);
    };
  }, [busy, suppress, idleMs]);

  return { asleep, justWoke };
}

/** Snapshot states during which the pet is on duty and must not sleep. */
export const ALERT_STATES = new Set([
  "waiting",
  "running",
  "running-left",
  "running-right",
  "review",
  "jumping",
  "failed",
]);
