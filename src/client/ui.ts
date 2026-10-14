/**
 * DSHBuddy UI design system — shared style tokens and component presets so the
 * settings tabs, floating panels and menus look consistent and polished.
 */

import type { CSSProperties } from "react";
import { createElement } from "react";

export const radius = 12;

export const card: CSSProperties = {
  borderRadius: radius,
  background: "var(--buddy-surface-raised, var(--buddy-row-bg))",
  border: "1px solid var(--buddy-panel-border)",
  boxShadow: "0 1px 0 color-mix(in srgb, white 5%, transparent) inset",
};

export const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 700,
  color: "var(--buddy-panel-fg)",
};

export const subTitle: CSSProperties = {
  margin: "0 0 8px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--buddy-panel-fg)",
};

export const fieldLabel: CSSProperties = {
  fontSize: 12,
  color: "var(--buddy-panel-muted)",
  marginBottom: 4,
};

export const input: CSSProperties = {
  minHeight: 36,
  padding: "8px 11px",
  borderRadius: 10,
  background: "var(--buddy-input-bg)",
  color: "var(--buddy-panel-fg)",
  border: "1px solid var(--buddy-panel-border)",
  outline: "none",
  fontSize: 13,
  transition: "border-color 120ms, box-shadow 120ms",
};

export const select: CSSProperties = {
  width: "100%",
  minHeight: 36,
  padding: "8px 11px",
  borderRadius: 10,
  background: "var(--buddy-input-bg)",
  color: "var(--buddy-panel-fg)",
  border: "1px solid var(--buddy-panel-border)",
  outline: "none",
  fontSize: 13,
};

export const primaryBtn: CSSProperties = {
  minHeight: 36,
  padding: "8px 16px",
  borderRadius: 10,
  border: "none",
  background: "var(--buddy-accent)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 4px 12px color-mix(in srgb, var(--buddy-accent) 28%, transparent)",
  transition: "filter 120ms, transform 120ms",
};

export const secondaryBtn: CSSProperties = {
  minHeight: 36,
  padding: "8px 16px",
  borderRadius: 10,
  border: "1px solid var(--buddy-panel-border)",
  background: "var(--buddy-input-bg)",
  color: "var(--buddy-panel-fg)",
  fontSize: 13,
  cursor: "pointer",
};

export const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 10,
  fontSize: 13,
  color: "var(--buddy-panel-fg)",
};

export const mutedText: CSSProperties = {
  fontSize: 12,
  color: "var(--buddy-panel-muted)",
  lineHeight: 1.5,
};

/** A modern pill toggle switch. */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return createElement(
    "button",
    {
      role: "switch",
      "aria-checked": checked,
      onClick: () => onChange(!checked),
      style: {
        width: 36,
        height: 20,
        borderRadius: 999,
        border: "none",
        background: checked ? "var(--buddy-accent)" : "rgba(255,255,255,0.12)",
        cursor: "pointer",
        position: "relative",
        transition: "background 150ms",
        flex: "none",
      },
    },
    createElement("span", {
      style: {
        position: "absolute",
        top: 2,
        left: checked ? 18 : 2,
        width: 16,
        height: 16,
        borderRadius: "50%",
        background: "#fff",
        transition: "left 150ms",
      },
    }),
  );
}

/** A labeled row (label + control) with toggle/checkbox semantics. */
export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return createElement(
    "div",
    { style: { ...row, justifyContent: "space-between" } },
    createElement("span", { style: { color: "var(--buddy-panel-fg)" } }, label),
    createElement(Toggle, { checked, onChange }),
  );
}
