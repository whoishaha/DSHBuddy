/**
 * Bubble — companion/state bubble ABOVE the pet (vertical placement, horizontal
 * text). Must live inside a wide containing block (the fixed floater root),
 * because an absolutely-positioned element's shrink-to-fit width is capped by
 * its containing block — a narrow 72px wrapper would wrap CJK text character
 * by character.
 *
 * v0.3: pop-in animation (re-triggered per message), tone variants
 * (default / care / celebrate) with matching border accents, and theme-token
 * shadows so it reads well in both skins.
 *
 * v0.3.4: graceful fade-out on hide (previously it vanished in one frame), and
 * a `flat` mode that drops backdrop-filter for surfaces that move every frame
 * (walking pet / drag) — re-filtering the backdrop per frame was the single
 * biggest source of whale-walk jank.
 */

import { useEffect, useRef, useState } from "react";
import type { BuddySnapshot } from "./useBuddyState.js";
import { ensureFx } from "./fx.js";

/** How long a bubble stays visible after the conversation has stopped (ms). */
const STOPPED_DURATION_MS = 5000;
/** How long a proactive-caring bubble stays shown above the pet (ms). */
export const CARE_VISIBLE_MS = 8000;
/** Exit fade duration — keep in sync with the dshb-pop-out keyframe (ms). */
const EXIT_FADE_MS = 200;

type Phase = "hidden" | "shown" | "leaving";

/**
 * Care-bubble visibility driven by a local timer instead of polling renders:
 * with adaptive polling the overlay may not re-render for seconds, so the
 * "hide after 8 s" decision must not depend on a re-render happening.
 *
 * v0.4 escalation ladder: only BUBBLE-level cares ride the pet-head bubble —
 * card-level ones belong to the 鲸灵 CareCard (which suppresses this bubble
 * via the `suppressCare` prop anyway; the level check here is defense in depth
 * for the moment before index.tsx flips that prop).
 */
export function useCareText(snapshot: BuddySnapshot): string | null {
  const [care, setCare] = useState<string | null>(null);
  const ts = snapshot.care?.ts ?? 0;
  const text = snapshot.care?.text ?? "";
  const level = snapshot.care?.level ?? "bubble";
  useEffect(() => {
    if (!ts || !text || level === "card") {
      setCare(null);
      return;
    }
    setCare(text);
    const remain = Math.max(800, CARE_VISIBLE_MS - (Date.now() - ts));
    const timer = setTimeout(() => setCare(null), remain);
    return () => clearTimeout(timer);
  }, [ts, text, level]);
  return care;
}

/** Bubble tone heuristic: caring messages get the accent frame, 🎉 gets green. */
export function toneFor(care: string | null, status: string): BubbleTone {
  if (care) return "care";
  if (status.startsWith("🎉")) return "celebrate";
  return "default";
}

/**
 * States where the conversation is actively working: the status bubble stays
 * visible continuously while the pet is in one of these.
 */
export const BUBBLE_PERSIST_STATES = new Set([
  "running",
  "running-left",
  "running-right",
  "working",
  "jumping",
  "review",
  "waiting",
]);

export type BubbleTone = "default" | "care" | "celebrate";

const TONE_BORDER: Record<BubbleTone, string> = {
  default: "var(--buddy-panel-border)",
  care: "var(--buddy-accent)",
  celebrate: "var(--buddy-success)",
};

/** Ask the bubble to leave: hidden stays hidden, anything else fades first. */
const toLeaving = (p: Phase): Phase => (p === "hidden" ? p : "leaving");

export function Bubble({
  text,
  visible,
  persist = false,
  tone = "default",
  flat = false,
}: {
  text: string;
  visible: boolean;
  persist?: boolean;
  tone?: BubbleTone;
  /** True while the carrying surface moves every frame: skip backdrop-filter. */
  flat?: boolean;
}) {
  // hidden → not mounted · shown → popped in · leaving → fading out one beat.
  const [phase, setPhase] = useState<Phase>("hidden");

  // The pop-in/out classes live in the shared stylesheet.
  useEffect(() => {
    ensureFx();
  }, []);

  useEffect(() => {
    if (!visible || !text) {
      setPhase(toLeaving);
      return;
    }
    setPhase("shown");
    // While the conversation is running the bubble stays; once it stops, the
    // bubble lingers for a few seconds and then fades away.
    if (persist) return;
    const timer = setTimeout(() => setPhase(toLeaving), STOPPED_DURATION_MS);
    return () => clearTimeout(timer);
  }, [text, visible, persist]);

  // One fade later, actually unmount.
  useEffect(() => {
    if (phase !== "leaving") return;
    const t = setTimeout(() => setPhase("hidden"), EXIT_FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "hidden" || !text) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "100%",
        left: "50%",
        transform: "translateX(-50%)",
        marginBottom: 7,
        zIndex: 10,
        pointerEvents: "none",
      }}
    >
      {/* key={text} restarts the pop-in animation for every new message */}
      <div
        key={text}
        className={phase === "leaving" ? "dshb-pop-out" : "dshb-pop"}
        style={{ position: "relative" }}
      >
        <div
          style={{
            width: "max-content",
            maxWidth: 280,
            padding: "8px 13px",
            borderRadius: 14,
            background: "var(--buddy-bubble-bg)",
            border: `1px solid ${TONE_BORDER[tone]}`,
            boxShadow: tone === "default" ? "var(--buddy-shadow)" : `var(--buddy-shadow), inset 0 0 0 1px ${TONE_BORDER[tone]}22`,
            color: "var(--buddy-bubble-fg)",
            fontSize: 12.5,
            lineHeight: 1.5,
            whiteSpace: "normal",
            wordBreak: "break-word",
            // Flat mode: this surface translates every frame while the pet
            // walks/drags — a live blur here forces full backdrop re-filters.
            backdropFilter: flat ? undefined : "blur(10px)",
          }}
        >
          {text}
        </div>
        {/* tail pointing down toward the pet */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: -4.5,
            width: 9,
            height: 9,
            transform: "translateX(-50%) rotate(45deg)",
            background: "var(--buddy-bubble-bg)",
            borderRight: `1px solid ${TONE_BORDER[tone]}`,
            borderBottom: `1px solid ${TONE_BORDER[tone]}`,
          }}
        />
      </div>
    </div>
  );
}
