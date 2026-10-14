/**
 * panelBus — a tiny module-level "open this panel" mailbox.
 *
 * The pet floater overlay (shell.overlay) is what actually renders the floating
 * panels (pomodoro / chat / calendar / …). But when the user is inside the DSH
 * settings view, that overlay may be unmounted — so a plain window event fired
 * from a settings tab would have no listener, and the request would be lost.
 *
 * requestPanel() therefore ALSO records the request in module state; when the
 * overlay (re)mounts it consumes any pending request and opens the panel. This
 * makes "启动番茄钟（浮层窗口）" survive the settings → main navigation.
 */

import type { PanelKind } from "./panels.js";

let pending: PanelKind = null;

/** Ask the floater overlay to open a panel (survives settings → main navigation). */
export function requestPanel(kind: PanelKind) {
  pending = kind;
  window.dispatchEvent(new CustomEvent("dshbuddy:open-panel", { detail: kind }));
}

/** Consume a panel request that arrived while the overlay was unmounted. */
export function takePending(): PanelKind | null {
  const k = pending;
  pending = null;
  return k;
}
