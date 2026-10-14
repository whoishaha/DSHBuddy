/**
 * BreathOverlay — companion-v2 batch C2「盒式呼吸」floating overlay.
 *
 * 30 seconds of box breathing (inhale 4s → hold 4s → exhale 4s → rest 4s ×
 * ~2 rounds): a circle grows/shrinks with the phase, a phase label and the
 * remaining seconds sit underneath. prefers-reduced-motion degrades the
 * animation to a static ring + text countdown. Finishing a session (not Esc —
 * quitting early must feel fine, just unrewarded) grants the once-a-day
 +3 coin bonus via POST /selfcare {op:"breath"}.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "./i18n.js";
import { buddyPost } from "./useBuddyState.js";

const PHASES: { key: "breath.inhale" | "breath.hold" | "breath.exhale" | "breath.rest"; secs: number; scale: number }[] = [
  { key: "breath.inhale", secs: 4, scale: 1 },
  { key: "breath.hold", secs: 4, scale: 1 },
  { key: "breath.exhale", secs: 4, scale: 0.55 },
  { key: "breath.rest", secs: 4, scale: 0.55 },
];
const TOTAL_MS = PHASES.reduce((s, p) => s + p.secs * 1000, 0);

export function BreathOverlay({ onClose }: { onClose: () => void }) {
  // One tick per second drives phase/label/countdown; the circle itself is CSS-
  // transitioned so animation frames never touch React.
  const [elapsed, setElapsed] = useState(0);
  const [finished, setFinished] = useState(false);
  const [reward, setReward] = useState<number | null>(null);
  const doneRef = useRef(false);

  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const started = Date.now();
    const iv = setInterval(() => {
      const ms = Date.now() - started;
      if (ms >= TOTAL_MS) {
        setElapsed(TOTAL_MS);
        clearInterval(iv);
        if (!doneRef.current) {
          doneRef.current = true;
          setFinished(true);
          void buddyPost<{ ok: boolean; earned: number }>("selfcare", { op: "breath" }).then((j) => {
            setReward(j?.earned ?? 0);
          });
        }
        return;
      }
      setElapsed(ms);
    }, 250);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Current phase + seconds left in it.
  let acc = 0;
  let phase = PHASES[0];
  let phaseLeft = 0;
  for (const p of PHASES) {
    if (elapsed < acc + p.secs * 1000 || finished) {
      phase = p;
      phaseLeft = Math.max(1, Math.ceil((acc + p.secs * 1000 - elapsed) / 1000));
      break;
    }
    acc += p.secs * 1000;
  }
  const totalLeft = Math.max(0, Math.ceil((TOTAL_MS - elapsed) / 1000));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--buddy-panel-bg, #10141c) 55%, transparent)",
        pointerEvents: "auto",
      }}
      onClick={onClose}
    >
      <div
        className="dshb-pop"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          width: 260,
          padding: "22px 18px 16px",
          borderRadius: 16,
          background: "var(--buddy-bubble-bg)",
          border: "1px solid var(--buddy-accent)",
          boxShadow: "var(--buddy-shadow)",
          color: "var(--buddy-bubble-fg)",
          backdropFilter: "blur(12px)",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>🫁 {t("selfcare.breath")}</span>

        {/* breathing circle */}
        <div style={{ position: "relative", width: 128, height: 128, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              width: 116,
              height: 116,
              borderRadius: "50%",
              background: "radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--buddy-accent) 70%, white 10%), var(--buddy-accent))",
              opacity: 0.85,
              transform: `scale(${finished ? 0.8 : reducedMotion ? 0.7 : phase.scale})`,
              transition: reducedMotion ? "none" : `transform ${phase.key === "breath.inhale" || phase.key === "breath.exhale" ? 3800 : 400}ms ease-in-out`,
            }}
          />
          <span
            style={{
              position: "absolute",
              fontSize: 22,
              fontWeight: 700,
              color: "var(--buddy-on-accent)",
              textShadow: "0 1px 4px rgba(0,0,0,.35)",
            }}
          >
            {finished ? "🌊" : totalLeft}
          </span>
        </div>

        <span style={{ fontSize: 12.5, minHeight: 18 }}>
          {finished ? t("breather.done") : t(phase.key)}
        </span>

        {finished && reward !== null && reward > 0 && (
          <span style={{ fontSize: 11.5, color: "var(--buddy-success)" }}>+{reward} 🪙</span>
        )}

        <button onClick={onClose} className="dshb-iconbtn" style={{ fontSize: 11, padding: "4px 10px" }}>
          {t("breather.close")}
        </button>
      </div>
    </div>
  );
}
