/**
 * PopMenu — shared popup menu for the pet floater / walker.
 *
 * Replaces the three divergent hand-rolled menus with one component that:
 *  - opens ABOVE the pet by default and flips BELOW when there is no room;
 *  - keeps itself inside the viewport (horizontal clamp);
 *  - closes on Escape / outside pointerdown / item activation;
 *  - animates via the shared dshb stylesheet (dshb-pop / dshb-pop-below);
 *  - exposes accessible menu semantics (role="menu", items are buttons).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ensureFx } from "./fx.js";

export function PopMenu({
  open,
  onClose,
  children,
  minWidth = 208,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  minWidth?: number;
}) {
  const [place, setPlace] = useState<"above" | "below">("above");
  const [dx, setDx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureFx();
  }, []);

  // Measure once open: flip below when clipping the top, then clamp horizontally.
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    if (!el.contains(document.activeElement)) {
      el.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    }
    setPlace((p) => {
      if (p === "above" && r.top < 8 && r.height < window.innerHeight - 16) return "below";
      if (p === "below" && r.bottom > window.innerHeight - 8 && r.top - r.height - 12 >= 0) return "above";
      return p;
    });
    setDx(r.left < 8 ? 8 - r.left : r.right > vw - 8 ? vw - 8 - r.right : 0);
  }, [open, place]);

  // Close on Escape and on outside pointerdown.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const moveFocus = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (!items.length) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
        : e.key === "ArrowDown" ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      className={`${place === "above" ? "dshb-pop" : "dshb-pop-below"} dshb-menu dshb-scroll`}
      style={{
        position: "absolute",
        ...(place === "above"
          ? { bottom: "100%", marginBottom: 6 }
          : { top: "100%", marginTop: 6 }),
        left: `calc(50% + ${dx}px)`,
        transform: "translateX(-50%)",
        minWidth,
        maxHeight: `min(420px, calc(100vh - 24px))`,
        overflowY: "auto",
        background: "var(--buddy-surface-raised, var(--buddy-panel-bg))",
        border: "1px solid var(--buddy-panel-border)",
        borderRadius: 14,
        padding: 7,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        cursor: "default",
        boxShadow: "var(--buddy-shadow)",
        backdropFilter: "blur(14px)",
        zIndex: 20,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={moveFocus}
    >
      {children}
    </div>
  );
}

/** One selectable row (button for a11y). */
export function PopItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
  trailing,
}: {
  icon?: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="dshb-menu-item"
      disabled={disabled}
      onClick={onClick}
      style={danger ? { color: "var(--buddy-danger)" } : undefined}
    >
      {icon !== undefined && <span className="dshb-menu-icon">{icon}</span>}
      <span style={{ flex: 1 }}>{label}</span>
      {trailing}
    </button>
  );
}

/** Non-interactive header/section label. */
export function PopLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 10px 4px",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: "var(--buddy-panel-muted)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

/** Thin separator. */
export function PopSep() {
  return (
    <div
      style={{
        height: 1,
        margin: "4px 6px",
        background: "var(--buddy-panel-border)",
        flex: "none",
      }}
    />
  );
}

/** Inline slider row (zoom control etc.). */
export function PopSlider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ padding: "5px 10px 7px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 12,
          color: "var(--buddy-panel-fg)",
        }}
      >
        <span>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--buddy-panel-muted)" }}>{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%",
          accentColor: "var(--buddy-accent)",
          cursor: "pointer",
          background: "transparent",
          margin: 0,
        }}
      />
    </div>
  );
}

/**
 * Inline expandable pet-picker section (replaces the old fixed top-right
 * switcher box that ignored where the pet actually was).
 */
export function PetPickerSection({
  pets,
  activeSlug,
  loading,
  onPick,
}: {
  pets: { slug: string; displayName: string }[];
  activeSlug: string | null;
  loading: boolean;
  onPick: (slug: string) => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--buddy-panel-muted)" }}>…</div>
    );
  }
  if (pets.length === 0) {
    return (
      <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--buddy-panel-muted)" }}>—</div>
    );
  }
  return (
    <>
      {pets.map((p) => (
        <PopItem
          key={p.slug}
          icon={p.slug === activeSlug ? "✓" : ""}
          label={p.displayName}
          onClick={() => onPick(p.slug)}
          trailing={
            p.slug === activeSlug ? (
              <span style={{ fontSize: 10, color: "var(--buddy-accent)" }}>●</span>
            ) : undefined
          }
        />
      ))}
    </>
  );
}
