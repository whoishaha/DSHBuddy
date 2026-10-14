/**
 * chronoLabels — host sends chronotype labels as Chinese strings; map the
 * known ones to i18n keys so the stats page follows the configured language.
 * Unknown labels pass through unchanged (forward-compatible with new hosts).
 */

import { t } from "../i18n.js";

const KEYS: Record<string, string> = {
  夜猫子: "chrono.nightOwl",
  早鸟: "chrono.earlyBird",
  正常作息: "chrono.normal",
};

export function chronoLabel(label: string): string {
  const key = KEYS[label];
  return key ? t(key as never) : label;
}
