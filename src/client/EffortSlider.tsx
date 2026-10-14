/**
 * EffortSlider — a range slider for the model's reasoning effort
 * (off / low / high / max), rendered inside the pet menu. Reads the current
 * selection via useModelEffort and writes it back through session.selectModel.
 */

import { useState } from "react";
import { t, type TKey } from "./i18n.js";
import { useModelEffort } from "./useModelEffort.js";

const EFFORT_LABEL: Record<string, TKey> = {
  off: "effort.off",
  low: "effort.low",
  high: "effort.high",
  max: "effort.max",
};

export function EffortSlider() {
  const { supported, current, ready, select } = useModelEffort();
  const [busy, setBusy] = useState(false);

  // Hide when the shell/session is unavailable or the model has no effort levels.
  if (!ready) return null;
  if (supported.length === 0) return null;

  const idx = current ? Math.max(0, supported.indexOf(current)) : 0;

  const onChange = async (v: number) => {
    const id = supported[Math.min(Math.max(Math.round(v), 0), supported.length - 1)];
    if (!id || id === current) return;
    setBusy(true);
    try {
      await select(id);
    } finally {
      setBusy(false);
    }
  };

  const labelOf = (id: string): string => (EFFORT_LABEL[id] ? t(EFFORT_LABEL[id]) : id);
  const labelText = current ? labelOf(current) : "—";
  const value = Math.min(Math.max(idx, 0), Math.max(supported.length - 1, 0));

  return (
    <div
      style={{
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        cursor: "default",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 12,
          color: "var(--buddy-panel-fg)",
        }}
      >
        <span>{t("pet.effort")}</span>
        <span>{labelText}</span>
      </div>
      <input
        type="range"
        min={0}
        max={supported.length - 1}
        step={1}
        value={value}
        disabled={busy || supported.length < 2}
        onChange={(e) => void onChange(Number(e.target.value))}
        style={{
          width: "100%",
          accentColor: "var(--buddy-accent)",
          cursor: busy ? "wait" : "pointer",
          background: "transparent",
        }}
      />
      {/* Tick markers: one per effort level, aligned with the slider track
          (the 8px side padding offsets the thumb's overhang so the ticks line
          up under the thumb positions). */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "0 8px",
          marginTop: -2,
        }}
      >
        {supported.map((id) => {
          const active = id === (current ?? supported[value]);
          return (
            <div
              key={id}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                fontSize: 10,
                lineHeight: "12px",
                color: active ? "var(--buddy-accent)" : "var(--buddy-panel-muted)",
                userSelect: "none",
              }}
            >
              <div
                style={{
                  width: active ? 3 : 2,
                  height: active ? 7 : 5,
                  borderRadius: 1,
                  background: active ? "var(--buddy-accent)" : "var(--buddy-panel-border)",
                }}
              />
              <span>{labelOf(id)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
