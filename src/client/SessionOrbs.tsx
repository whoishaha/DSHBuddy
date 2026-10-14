/**
 * SessionOrbs — B3-2: tiny light dots above the pet, one per parallel running
 * session (main + subagent). Pure atmosphere: hidden entirely when nothing is
 * running so idle users never see chrome they didn't ask for.
 */

import type { SnapshotSessions } from "./useBuddyState.js";
import { t } from "./i18n.js";

/** Show at most this many orbs; extra sessions collapse into a "+n". */
const MAX_ORBS = 4;

export function SessionOrbs({ sessions }: { sessions: SnapshotSessions | null | undefined }) {
  if (!sessions || sessions.running <= 0) return null;
  const main = Math.max(0, sessions.running - sessions.subagents);
  const sub = sessions.subagents;
  const shown = Math.min(MAX_ORBS, sessions.running);
  const extra = sessions.running - shown;

  return (
    <div
      title={t("pet.sessions.title", [sessions.running])}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        pointerEvents: "none",
      }}
    >
      {Array.from({ length: main }, (_, i) => (
        <span
          key={`m${i}`}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#38bdf8",
            boxShadow: "0 0 6px rgba(56,189,248,0.8)",
            animation: "dshb-pulse 1.8s ease-in-out infinite",
            animationDelay: `${i * 0.22}s`,
          }}
        />
      ))}
      {Array.from({ length: Math.min(sub, MAX_ORBS) }, (_, i) => (
        <span
          key={`s${i}`}
          title={t("pet.sessions.subagent")}
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "#a78bfa",
            boxShadow: "0 0 5px rgba(167,139,250,0.85)",
            animation: "dshb-pulse 1.4s ease-in-out infinite",
            animationDelay: `${i * 0.18}s`,
          }}
        />
      ))}
      {extra > 0 && (
        <span style={{ fontSize: 9, fontWeight: 700, color: "var(--buddy-panel-muted)" }}>+{extra}</span>
      )}
    </div>
  );
}

/** Subagent-aware chip copy: 🎧 for one, juggling text for several. */
export function subagentChipText(subagents: number): string | null {
  if (subagents <= 0) return null;
  return subagents === 1 ? "🎧" : `🎧 ×${subagents}`;
}
