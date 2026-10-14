/**
 * DSHBuddy theme system — dark / light skins, applied as CSS custom
 * properties on the floater root and the settings panel so every child
 * (bubble, menu, panels, settings tabs) inherits them via var(--buddy-*).
 *
 * The default "dark" skin references DeepSeek Harness's own design tokens
 * (--dsw-alias-*), so the pet UI matches the harness palette and follows its
 * light/dark mode automatically. "light" is a fixed light palette.
 */

export type Skin = "dark" | "light";

/** Semantic status colors that read well on both skins. */
const STATUS = {
  success: "#22c55e",
  warning: "#f59e0b",
  danger: "#ef4444",
};

export const THEMES: Record<Skin, Record<string, string>> = {
  dark: {
    "--buddy-panel-bg": "var(--dsw-alias-bg-overlay)",
    "--buddy-panel-fg": "var(--dsw-alias-label-primary)",
    "--buddy-panel-border": "var(--dsw-alias-border-l2)",
    "--buddy-panel-muted": "var(--dsw-alias-label-secondary)",
    "--buddy-accent": "var(--dsw-alias-brand-primary)",
    "--buddy-accent-2": "#8b5cf6",
    "--buddy-bubble-bg": "var(--dsw-alias-bg-overlay)",
    "--buddy-bubble-fg": "var(--dsw-alias-label-primary)",
    "--buddy-row-hover": "var(--dsw-alias-border-l1)",
    "--buddy-input-bg": "var(--dsw-alias-bg-layer-2)",
    "--buddy-row-bg": "color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)",
    "--buddy-surface-bg": "color-mix(in srgb, var(--dsw-alias-bg-overlay) 88%, var(--dsw-alias-label-primary) 4%)",
    "--buddy-surface-raised": "color-mix(in srgb, var(--dsw-alias-bg-overlay) 94%, var(--dsw-alias-brand-primary) 6%)",
    // v0.3 additions — status colors, chips, shadows, accent tints.
    "--buddy-success": STATUS.success,
    "--buddy-warning": STATUS.warning,
    "--buddy-danger": STATUS.danger,
    "--buddy-chip-bg": "color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)",
    "--buddy-chip-border": "color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent)",
    "--buddy-shadow": "0 8px 28px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.3)",
    "--buddy-shadow-soft": "0 10px 30px rgba(0,0,0,0.18)",
    "--buddy-accent-soft": "color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)",
    "--buddy-on-accent": "#ffffff",
  },
  light: {
    "--buddy-panel-bg": "rgba(255,255,255,0.94)",
    "--buddy-panel-fg": "#1f2328",
    "--buddy-panel-border": "rgba(31,35,40,0.14)",
    "--buddy-panel-muted": "rgba(31,35,40,0.55)",
    "--buddy-accent": "#2563eb",
    "--buddy-accent-2": "#7c3aed",
    "--buddy-bubble-bg": "rgba(255,255,255,0.97)",
    "--buddy-bubble-fg": "#1f2328",
    "--buddy-row-hover": "rgba(31,35,40,0.08)",
    "--buddy-input-bg": "rgba(31,35,40,0.05)",
    "--buddy-row-bg": "rgba(31,35,40,0.05)",
    "--buddy-surface-bg": "rgba(255,255,255,0.72)",
    "--buddy-surface-raised": "rgba(255,255,255,0.96)",
    // v0.3 additions.
    "--buddy-success": "#16a34a",
    "--buddy-warning": "#d97706",
    "--buddy-danger": "#dc2626",
    "--buddy-chip-bg": "rgba(31,35,40,0.07)",
    "--buddy-chip-border": "rgba(31,35,40,0.12)",
    "--buddy-shadow": "0 8px 24px rgba(31,35,40,0.18), 0 2px 6px rgba(31,35,40,0.1)",
    "--buddy-shadow-soft": "0 10px 30px rgba(31,35,40,0.1)",
    "--buddy-accent-soft": "rgba(37,99,235,0.12)",
    "--buddy-on-accent": "#ffffff",
  },
};
