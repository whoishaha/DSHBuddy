/**
 * Running-variant alternator — ported from Petdex sidecar (`running-variant.ts`).
 *
 * Hooks/events send the bare "running" state; the plugin substitutes alternating
 * "running-left" / "running-right" so consecutive tool calls don't all show the
 * same sprite frame.
 */

let toggle: "running-left" | "running-right" = "running-left";

export function nextRunningVariant(): "running-left" | "running-right" {
  const next = toggle;
  toggle = next === "running-left" ? "running-right" : "running-left";
  return next;
}

/** Test-only: reset the toggle. */
export function resetRunningVariantForTests(): void {
  toggle = "running-left";
}
