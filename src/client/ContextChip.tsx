/**
 * ContextChip — B3-3 model capacity awareness + gentle compaction coaching.
 *
 * DSH discloses NO token metering, so there is no honest "quota fill" to draw:
 * the only reliable facts are the current model's context window (via
 * llm.resolveModelInfo, host-probed) and how long a session has been running
 * continuously. The chip shows the capacity; once a stretch exceeds the coach
 * threshold it warms up and the tooltip suggests /compact or a fresh session.
 * Renders NOTHING when the host probe failed — the whole feature auto-hides.
 */

import type { SnapshotContext } from "./useBuddyState.js";
import { t } from "./i18n.js";

/** Suggest a compaction once one agent has run continuously this long. */
const COACH_AFTER_MS = 45 * 60 * 1000;

/** Human token counts: 131072 → "131K", 1000000 → "1M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function ContextChip({
  context,
  longestRunningMs = 0,
}: {
  context: SnapshotContext | null | undefined;
  longestRunningMs?: number;
}) {
  if (!context || !(context.contextWindow > 0)) return null;
  const coach = longestRunningMs >= COACH_AFTER_MS;
  const title =
    t("pet.context.title", [context.model, `${fmtTokens(context.contextWindow)} tokens`]) +
    (coach ? `\n${t("pet.context.coach", [Math.floor(longestRunningMs / 60000)])}` : "");
  return (
    <span
      title={title}
      style={{ opacity: 0.85, color: coach ? "var(--buddy-warning)" : undefined }}
    >
      · 🧠{fmtTokens(context.contextWindow)}
    </span>
  );
}
