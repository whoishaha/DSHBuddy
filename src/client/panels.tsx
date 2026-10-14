/**
 * Pet companion panels: quick commands, pomodoro, chat, todo, calendar.
 * All data flows through the host half's same-origin API (/api/dshbuddy/*).
 *
 * v0.3 panel-shell upgrades:
 *  - Escape closes the panel; close button has hover/active states;
 *  - open positions cascade and persist across opens (size AND position),
 *    always clamped inside the viewport;
 *  - themed thin scrollbars on panel bodies.
 * Feature upgrades:
 *  - chat: auto-scroll, growing textarea (Shift+Enter = newline), readable
 *    user bubbles in both skins, typing dots, error bubbles highlighted;
 *  - pomodoro: phase-colored ring (work=accent / break=green), live count-up
 *    ring, phase-change chime + a care bubble pushed to the pet;
 *  - calendar: today outline, readable selection in light skin, month total;
 *  - todo: themed checkboxes and a completion progress bar.
 */

import { useEffect, useRef, useState } from "react";
import { buddyGet, buddyPost } from "./useBuddyState.js";
import { runBuddyCommand, insertIntoDshComposer } from "./useModelEffort.js";
import { t } from "./i18n.js";

export type PanelKind = "commands" | "pomodoro" | "chat" | "notes" | "calendar" | "growth" | "morning" | "breath" | null;

const MIN_W = 240;
const MIN_H = 200;
const DEFAULT_W = 300;
const DEFAULT_H = 460;

/** Last panel geometry persists across open/close within the page session. */
let lastPanelSize = { w: DEFAULT_W, h: DEFAULT_H };
let lastPanelPos: { x: number; y: number } | null = null;
let openCount = 0;

function clampToViewport(pos: { x: number; y: number }, size: { w: number; h: number }) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 800;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;
  return {
    x: Math.min(Math.max(pos.x, 8), Math.max(8, vw - size.w - 8)),
    y: Math.min(Math.max(pos.y, 8), Math.max(8, vh - 64)),
  };
}

/** A short two-tone chime (WebAudio, tiny volume, failure-tolerant). */
function chime() {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const play = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + at;
      gain.gain.setValueAtTime(0.05, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.2);
    };
    play(880, 0);
    play(659, 0.16);
    setTimeout(() => void ctx.close().catch(() => {}), 600);
  } catch {
    // audio unavailable — silent
  }
}

export function PanelShell({
  title,
  onClose,
  children,
  bodyStyle,
  defaultSize,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Extra styles for the scrolling body (e.g. chat locks it to `hidden` so
   *  only the message list scrolls, never the whole panel). */
  bodyStyle?: React.CSSProperties;
  /** Compact open size for small panels (e.g. pomodoro wraps just its timer).
   *  When set, the shell ignores the shared size memory so the panel always
   *  reopens snug around its content. */
  defaultSize?: { w: number; h: number };
}) {
  // Panels open beside the pet floater and are draggable via their header bar
  // + resizable via the bottom-right corner. zIndex must exceed the floater's
  // own (2147483000) so the panel renders on top and its buttons stay clickable.
  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 800;
    const vh = typeof window !== "undefined" ? window.innerHeight : 600;
    const base = defaultSize ?? lastPanelSize;
    return {
      w: Math.min(base.w, Math.max(MIN_W, vw - 16)),
      h: Math.min(base.h, Math.max(MIN_H, vh - 16)),
    };
  });
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    openCount += 1;
    const vh = typeof window !== "undefined" ? window.innerHeight : 600;
    const base =
      lastPanelPos ?? {
        x: 210 + ((openCount * 32) % 160),
        y: Math.max(8, vh - size.h - 40 - ((openCount * 24) % 96)),
      };
    return clampToViewport(base, size);
  });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resize = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);

  // Escape closes the focused panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep the panel on-screen when the window shrinks.
  useEffect(() => {
    const onResize = () => setPos((p) => clampToViewport(p, size));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [size]);

  const applyPos = (next: { x: number; y: number }) => {
    const p = clampToViewport(next, size);
    setPos(p);
    lastPanelPos = p;
  };

  const onHeaderDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeaderMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    applyPos({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
  };
  const onHeaderUp = () => {
    drag.current = null;
  };

  // Resize via the bottom-right grip.
  const onResizeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    resize.current = { sx: e.clientX, sy: e.clientY, ow: size.w, oh: size.h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r) return;
    const vw = typeof window !== "undefined" ? window.innerWidth : 800;
    const vh = typeof window !== "undefined" ? window.innerHeight : 600;
    const next = {
      w: Math.min(Math.max(r.ow + (e.clientX - r.sx), MIN_W), Math.max(MIN_W, vw - pos.x - 8)),
      h: Math.min(Math.max(r.oh + (e.clientY - r.sy), MIN_H), Math.max(MIN_H, vh - pos.y - 8)),
    };
    setSize(next);
    if (!defaultSize) lastPanelSize = next; // compact panels keep their snug default
  };
  const onResizeUp = () => {
    resize.current = null;
  };

  return (
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        display: "flex",
        flexDirection: "column",
        pointerEvents: "auto",
        background: "var(--buddy-panel-bg)",
        border: "1px solid var(--buddy-panel-border)",
        borderRadius: 14,
        boxShadow: "var(--buddy-shadow)",
        overflow: "hidden",
        zIndex: 2147483001,
        backdropFilter: "blur(14px)",
        maxWidth: "calc(100vw - 16px)",
        maxHeight: "calc(100vh - 16px)",
      }}
      className="dshb-pop dshb-panel-shell"
      role="dialog"
      aria-label={title}
    >
      <div
        className="dshb-panel-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px 10px 14px",
          borderBottom: "1px solid var(--buddy-panel-border)",
          fontSize: 13,
          fontWeight: 700,
          color: "var(--buddy-panel-fg)",
          cursor: "move",
          userSelect: "none",
          flex: "none",
        }}
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerLeave={onHeaderUp}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span>{title}</span>
        <button
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          className="dshb-iconbtn"
          aria-label="close"
          title={t("common.closeEsc")}
          style={{ width: 26, height: 26, fontSize: 14, lineHeight: 1, flex: "none" }}
        >
          ✕
        </button>
      </div>
      <div
        className="dshb-scroll dshb-panel-body"
        style={{
          padding: 12,
          overflowY: "auto",
          overflowX: "hidden",
          flex: 1,
          // Kill the flexbox min-content floor so long content scrolls INSIDE
          // the panel instead of stretching it downward.
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          ...bodyStyle,
        }}
      >
        {children}
      </div>
      {/* resize grip (bottom-right corner) */}
      <div
        className="dshb-panel-resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        title={t("common.resize")}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 22,
          height: 22,
          cursor: "nwse-resize",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "flex-end",
          padding: 5,
          touchAction: "none",
          zIndex: 2,
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRight: "2px solid var(--buddy-panel-muted)",
            borderBottom: "2px solid var(--buddy-panel-muted)",
            borderBottomRightRadius: 3,
            opacity: 0.5,
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}

// ── quick commands ─────────────────────────────────────────────────────────

type QuickCommand = { id: string; label: string; command: string };

export function QuickCommandsPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title={t("nav.commands")} onClose={onClose}>
      <QuickCommandsBody />
    </PanelShell>
  );
}

/** Inline quick-command list: clicking RUNS slash commands in the current
 *  session; when direct execution is unavailable the command is typed into the
 *  DSH composer for the user to send (Enter); copying is a deliberate side
 *  button, never the default click action. */
export function QuickCommandsBody() {
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [status, setStatus] = useState<{ id: string; label: string; ok?: boolean } | null>(null);

  useEffect(() => {
    void buddyGet<{ ok: boolean; commands: QuickCommand[] }>("commands").then((json) => {
      if (json?.ok) setCommands(json.commands);
    });
  }, []);

  const flash = (id: string, label: string, ok?: boolean) => {
    setStatus({ id, label, ok });
    setTimeout(() => setStatus(null), 1800);
  };

  const copy = async (cmd: QuickCommand) => {
    try {
      await navigator.clipboard.writeText(cmd.command);
    } catch {
      // clipboard unavailable — still show feedback
    }
    flash(cmd.id, t("qc.copied"), true);
  };

  const run = async (cmd: QuickCommand) => {
    // Slash commands execute directly in the current DSH session.
    if (cmd.command.trim().startsWith("/")) {
      setStatus({ id: cmd.id, label: t("qc.running") });
      const ok = await runBuddyCommand(cmd.command.trim());
      if (ok) {
        flash(cmd.id, t("qc.executed"), true);
        return;
      }
      // Direct execution unavailable → type it into the DSH composer and try
      // to send with a synthetic Enter; the user sees it land in the box.
      if (insertIntoDshComposer(cmd.command.trim())) {
        flash(cmd.id, t("qc.inserted"), true);
        return;
      }
      flash(cmd.id, t("qc.noComposer"), false);
      await copy(cmd);
      return;
    }
    await copy(cmd);
  };

  if (commands.length === 0) {
    return (
      <div style={{ padding: "18px 8px", textAlign: "center", fontSize: 12, color: "var(--buddy-panel-muted)" }}>
        {t("qc.empty")}
      </div>
    );
  }

  return (
    <>
      {commands.map((cmd) => (
        <div
          key={cmd.id}
          onClick={() => void run(cmd)}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--buddy-row-bg)",
            border: "1px solid transparent",
            cursor: "pointer",
            fontSize: 12,
            color: "var(--buddy-panel-fg)",
            transition: "background 120ms, border-color 120ms",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = "var(--buddy-panel-border)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = "transparent";
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{cmd.label}</div>
              <div
                style={{
                  color:
                    status?.id === cmd.id ? (status.ok ? "var(--buddy-success)" : "var(--buddy-danger)") : "var(--buddy-panel-muted)",
                  fontFamily: "monospace",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {status?.id === cmd.id ? status.label : cmd.command}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void copy(cmd);
              }}
              title={t("qc.copyTitle")}
              className="dshb-iconbtn"
              style={{ fontSize: 12, lineHeight: 1, padding: "4px 6px", flex: "none" }}
            >
              ⧉
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

// ── pomodoro ───────────────────────────────────────────────────────────────

const WORK_MIN = 25;
const BREAK_MIN = 5;

export function PomodoroPanel({ onClose }: { onClose: () => void }) {
  return (
    // Snug default: title bar + mode pills + 104px ring + status + controls.
    <PanelShell title={t("nav.pomodoro")} onClose={onClose} defaultSize={{ w: 224, h: 288 }}>
      <PomodoroBody />
    </PanelShell>
  );
}

/** Inline pomodoro timer: countdown (work/break) or count-up stopwatch, with
 *  start / pause / resume / reset controls. Usable in the settings tab too.
 *  Phase changes chime softly and push a matching care bubble to the pet. */
export function PomodoroBody({ workMin = WORK_MIN, breakMin = BREAK_MIN }: { workMin?: number; breakMin?: number }) {
  const [mode, setMode] = useState<"countdown" | "countup">("countdown");
  const [status, setStatus] = useState<"idle" | "running" | "paused">("idle");
  const [cdPhase, setCdPhase] = useState<"work" | "break">("work");
  // Editable durations in minutes. Host config (config.pomodoro) is the single
  // source of truth — the settings 番茄钟 tab writes the same keys; loaded once
  // below so the floating panel honors what the user saved there.
  const [workLen, setWorkLen] = useState(workMin);
  const [breakLen, setBreakLen] = useState(breakMin);
  const [leftMs, setLeftMs] = useState(workMin * 60 * 1000);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Center-of-ring duration editor (countdown + not running only).
  const [editing, setEditing] = useState(false);
  const [draftMin, setDraftMin] = useState("");
  const editedRef = useRef(false);
  const statusRef = useRef(status);
  const modeRef = useRef(mode);
  const cdPhaseRef = useRef(cdPhase);
  const leftRef = useRef(leftMs);
  const endAtRef = useRef(0);
  const startAtRef = useRef(0);
  const runningRef = useRef(false);
  const hostOwnedRef = useRef(false);

  type HostPomodoroState = {
    phase: "work" | "break";
    status: "idle" | "running" | "paused";
    workMin: number;
    breakMin: number;
    remainingMs: number;
    endsAt: number | null;
  };
  const applyHostState = (state: HostPomodoroState) => {
    hostOwnedRef.current = true;
    setCdPhase(state.phase);
    setStatus(state.status);
    setWorkLen(state.workMin);
    setBreakLen(state.breakMin);
    setLeftMs(state.status === "running" && state.endsAt ? Math.max(0, state.endsAt - Date.now()) : state.remainingMs);
    endAtRef.current = state.endsAt ?? 0;
  };

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { cdPhaseRef.current = cdPhase; }, [cdPhase]);
  useEffect(() => { leftRef.current = leftMs; }, [leftMs]);

  // One-shot load of saved durations from the host snapshot (before first
  // start only — never yank the timer mid-run or override a fresh edit).
  useEffect(() => {
    void buddyGet<{ ok: boolean; config?: { pomodoro?: { workMin?: number; breakMin?: number } } }>("snapshot").then((j) => {
      const p = j?.config?.pomodoro;
      if (!p || editedRef.current || statusRef.current !== "idle") return;
      if (typeof p.workMin === "number" && p.workMin >= 1) {
        setWorkLen(Math.min(180, Math.round(p.workMin)));
        if (modeRef.current === "countdown" && cdPhaseRef.current === "work") {
          setLeftMs(Math.min(180, Math.round(p.workMin)) * 60 * 1000);
        }
      }
      if (typeof p.breakMin === "number" && p.breakMin >= 1) setBreakLen(Math.min(180, Math.round(p.breakMin)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The host owns countdown state, so closing and reopening this panel resumes
  // the same round. A short poll also delivers phase changes while it is open.
  useEffect(() => {
    let alive = true;
    const sync = () => void buddyGet<{ ok: boolean; state: HostPomodoroState }>("pomodoro/state").then((j) => {
      if (alive && j?.ok && modeRef.current === "countdown") applyHostState(j.state);
    });
    sync();
    const iv = window.setInterval(sync, 1000);
    return () => { alive = false; window.clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Announce a phase change: soft chime + care bubble on the pet. */
  const announce = (phase: "work" | "break") => {
    chime();
    void buddyPost("signal", {
      kind: "custom",
      text: phase === "break" ? t("pomo.doneWork") : t("pomo.doneBreak"),
    });
  };

  useEffect(() => {
    if (status !== "running") {
      runningRef.current = false;
      return;
    }
    runningRef.current = true;
    const iv = setInterval(() => {
      const now = Date.now();
      if (modeRef.current === "countup") {
        setElapsedMs(now - startAtRef.current);
        return;
      }
      const remain = endAtRef.current - now;
      if (hostOwnedRef.current) {
        setLeftMs(Math.max(0, remain));
        return;
      }
      if (remain <= 0) {
        if (cdPhaseRef.current === "work") {
          // A full focus round completed → log its minutes to the host stats.
          void buddyPost("pomodoro", { minutes: workLen });
          announce("break");
          endAtRef.current = now + breakLen * 60 * 1000;
          setCdPhase("break");
          setLeftMs(breakLen * 60 * 1000);
        } else {
          announce("work");
          endAtRef.current = now + workLen * 60 * 1000;
          setCdPhase("work");
          setLeftMs(workLen * 60 * 1000);
        }
      } else {
        setLeftMs(remain);
      }
    }, 250);
    return () => clearInterval(iv);
  }, [status, workLen, breakLen]);

  const start = () => {
    if (mode === "countdown") {
      void buddyPost<{ ok: boolean; state: HostPomodoroState }>("pomodoro/state", {
        op: "start", workMin: workLen, breakMin: breakLen,
      }).then((j) => { if (j?.ok) applyHostState(j.state); });
      endAtRef.current = Date.now() + leftRef.current;
      // Announce once per fresh round (not on every resume).
      if (status === "idle") announce(cdPhase);
    } else {
      startAtRef.current = Date.now() - elapsedMs;
    }
    setStatus("running");
  };
  const pause = () => {
    if (mode === "countdown") {
      leftRef.current = Math.max(0, endAtRef.current - Date.now());
      void buddyPost<{ ok: boolean; state: HostPomodoroState }>("pomodoro/state", { op: "pause" })
        .then((j) => { if (j?.ok) applyHostState(j.state); });
    }
    setStatus("paused");
  };
  const reset = () => {
    if (mode === "countdown") {
      void buddyPost<{ ok: boolean; state: HostPomodoroState }>("pomodoro/state", {
        op: "reset", workMin: workLen, breakMin: breakLen,
      }).then((j) => { if (j?.ok) applyHostState(j.state); });
    }
    setStatus("idle");
    setCdPhase("work");
    setLeftMs(workLen * 60 * 1000);
    setElapsedMs(0);
  };
  const switchMode = (m: "countdown" | "countup") => {
    setMode(m);
    reset();
  };

  // ── center-of-ring duration editor (countdown + not running) ─────────────
  const beginEdit = () => {
    if (editing || mode !== "countdown" || status === "running") return;
    setDraftMin(String(cdPhase === "break" ? breakLen : workLen));
    setEditing(true);
  };
  const commitEdit = () => {
    const raw = Math.round(Number(draftMin));
    setEditing(false);
    if (!Number.isFinite(raw)) return;
    const mins = Math.max(1, Math.min(180, raw));
    const nextWork = cdPhase === "break" ? workLen : mins;
    const nextBreak = cdPhase === "break" ? mins : breakLen;
    if (mins === (cdPhase === "break" ? breakLen : workLen)) return;
    editedRef.current = true;
    setWorkLen(nextWork);
    setBreakLen(nextBreak);
    if (mode === "countdown") setLeftMs(mins * 60 * 1000); // restart current phase with the new length
    // Persist both keys — the host config patch is a shallow merge.
    void buddyPost("config", { pomodoro: { workMin: nextWork, breakMin: nextBreak } });
  };

  const totalMs = cdPhase === "break" ? breakLen * 60 * 1000 : workLen * 60 * 1000;
  const pct =
    mode === "countdown"
      ? Math.max(0, Math.min(1, leftMs / totalMs))
      : (elapsedMs % totalMs) / totalMs; // count-up cycles through a work-length ring
  const displayMs = mode === "countdown" ? leftMs : elapsedMs;
  const mm = String(Math.floor(displayMs / 60000)).padStart(2, "0");
  const ss = String(Math.floor((displayMs % 60000) / 1000)).padStart(2, "0");
  const hh = Math.floor(displayMs / 3600000);
  const timeText = hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  const phaseColor = cdPhase === "break" ? "var(--buddy-success)" : "var(--buddy-accent)";
  const statusLabel =
    mode === "countdown"
      ? status === "idle" ? t("pomo.idle") : status === "paused" ? t("pomo.paused") : cdPhase === "work" ? t("pomo.focusing") : t("pomo.breaking")
      : status === "idle" ? t("pomo.countupIdle") : status === "paused" ? t("pomo.countupPaused") : t("pomo.countup");

  return (
    <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
        {(["countdown", "countup"] as const).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              border: mode === m ? "1px solid var(--buddy-accent)" : "1px solid var(--buddy-panel-border)",
              background: mode === m ? "var(--buddy-accent-soft)" : "var(--buddy-input-bg)",
              color: mode === m ? "var(--buddy-accent)" : "var(--buddy-panel-fg)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {m === "countdown" ? t("pomo.mode.countdown") : t("pomo.mode.countup")}
          </button>
        ))}
      </div>
      <div
        style={{
          width: 104,
          height: 104,
          margin: "2px auto",
          borderRadius: "50%",
          background: `conic-gradient(${phaseColor} ${pct * 360}deg, var(--buddy-row-bg) 0deg)`,
          display: "grid",
          placeItems: "center",
          position: "relative",
          transition: "background 200ms linear",
        }}
      >
        <div
          onClick={beginEdit}
          title={mode === "countdown" && status !== "running" ? t("pomo.editTip") : undefined}
          style={{
            width: 84,
            height: 84,
            borderRadius: "50%",
            background: "var(--buddy-input-bg)",
            display: "grid",
            placeItems: "center",
            fontSize: 21,
            fontVariantNumeric: "tabular-nums",
            color: "var(--buddy-panel-fg)",
            cursor: mode === "countdown" && status !== "running" ? "pointer" : "default",
            userSelect: "none",
          }}
        >
          {editing ? (
            <div style={{ display: "flex", alignItems: "baseline", gap: 1 }}>
              <input
                autoFocus
                type="number"
                min={1}
                max={180}
                value={draftMin}
                onChange={(e) => setDraftMin(e.target.value)}
                onBlur={commitEdit}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitEdit();
                  } else if (e.key === "Escape") {
                    setEditing(false);
                  }
                }}
                style={{
                  width: 46,
                  fontSize: 17,
                  textAlign: "center",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  padding: 0,
                  color: "var(--buddy-panel-fg)",
                  fontVariantNumeric: "tabular-nums",
                }}
              />
              <span style={{ fontSize: 10, color: "var(--buddy-panel-muted)" }}>{t("pomo.minutes")}</span>
            </div>
          ) : (
            timeText
          )}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 10px",
            borderRadius: 999,
            fontSize: 11,
            background: status === "running" ? "var(--buddy-accent-soft)" : "transparent",
            color: status === "running" ? phaseColor : "var(--buddy-panel-muted)",
          }}
        >
          {status === "running" && (
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: phaseColor }} />
          )}
          {statusLabel}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        {status !== "running" ? (
          <ActionButton onClick={start}>{status === "paused" ? t("pomo.resume") : t("pomo.start")}</ActionButton>
        ) : (
          <ActionButton onClick={pause}>{t("pomo.pause")}</ActionButton>
        )}
        <button
          onClick={reset}
          className="dshb-iconbtn"
          style={{
            padding: "6px 16px",
            borderRadius: 8,
            border: "1px solid var(--buddy-panel-border)",
            background: "var(--buddy-input-bg)",
            color: "var(--buddy-panel-fg)",
            fontSize: 13,
          }}
        >
          {t("pomo.reset")}
        </button>
      </div>
    </div>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 16px",
        borderRadius: 8,
        border: "none",
        background: "var(--buddy-accent)",
        color: "var(--buddy-on-accent)",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ── chat ───────────────────────────────────────────────────────────────────

type ChatMsg = { role: "user" | "assistant"; content: string };

export function ChatPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title={t("nav.chat")} onClose={onClose} bodyStyle={{ overflowY: "hidden", padding: 10 }}>
      <ChatBody />
    </PanelShell>
  );
}

/**
 * Inline chat widget with local persistence when the host supports it; falls
 * back to in-memory conversations so chatting always works.
 * v0.3: auto-scroll, growing textarea (Shift+Enter = newline), readable
 * bubbles in both skins, typing dots and highlighted error replies.
 *
 * `maxListHeight` bounds the message column so the log scrolls INSIDE its own
 * bar even when embedded in an unbounded parent (e.g. the settings page);
 * the floating ChatPanel leaves it unset and sizes via flex.
 */
/** Time-aware proactive opener shown when a chat conversation is empty. */
function chatGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return t("chat.greet.night");
  if (h < 11) return t("chat.greet.morning");
  if (h < 13) return t("chat.greet.noon");
  if (h < 18) return t("chat.greet.afternoon");
  if (h < 23) return t("chat.greet.evening");
  return t("chat.greet.late");
}

export function ChatBody({ maxListHeight }: { maxListHeight?: number } = {}) {
  type Conv = { id: string; title: string; messages: ChatMsg[] };
  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hostOk, setHostOk] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const messages = convs.find((c) => c.id === activeId)?.messages ?? [];

  const setMsgs = (id: string, msgs: ChatMsg[]) =>
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, messages: msgs } : c)));

  const loadHostMessages = async (id: string) => {
    const j = await buddyGet<{ ok: boolean; messages: ChatMsg[] }>(`chat?conversationId=${encodeURIComponent(id)}`);
    return j?.ok ? j.messages : [];
  };

  useEffect(() => {
    void (async () => {
      const j = await buddyGet<{ ok: boolean; conversations: { id: string; title: string }[] }>("chats");
      if (j?.ok && Array.isArray(j.conversations)) {
        setHostOk(true);
        const list = j.conversations.map((c) => ({ id: c.id, title: c.title, messages: [] as ChatMsg[] }));
        setConvs(list);
        const first = list[0];
        if (first) {
          setActiveId(first.id);
          setMsgs(first.id, await loadHostMessages(first.id));
        }
      } else {
        // Host without /chats: use an in-memory conversation.
        const c: Conv = { id: "local", title: t("chat.newConv"), messages: [] };
        setConvs([c]);
        setActiveId("local");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.4 F2 — receive a one-shot prefill from a "curious" care card and
  // pour it into the input. Fires once per event; input is appended only if
  // empty, so the user never has their draft stomped.
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text === "string" && text.length > 0) {
        setInput((prev) => (prev.trim().length > 0 ? prev : text));
        // Focus the input on next paint so the user can just hit Enter.
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("dshbuddy:chat-prefill", onPrefill);
    return () => window.removeEventListener("dshbuddy:chat-prefill", onPrefill);
  }, []);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy, activeId]);

  const select = async (id: string) => {
    setActiveId(id);
    if (hostOk) setMsgs(id, await loadHostMessages(id));
  };

  const newConv = async () => {
    if (hostOk) {
      const j = await buddyPost<{ ok: boolean; conversation: { id: string } }>("chats", { op: "new" });
      if (j?.ok) {
        const c: Conv = { id: j.conversation.id, title: t("chat.newConv"), messages: [] };
        setConvs((cs) => [c, ...cs]);
        setActiveId(c.id);
      }
    } else {
      const c: Conv = { id: `local${Date.now()}`, title: t("chat.newConv"), messages: [] };
      setConvs((cs) => [c, ...cs]);
      setActiveId(c.id);
    }
  };

  const remove = async (id: string) => {
    if (hostOk) await buddyPost("chats", { op: "delete", id });
    setConvs((cs) => {
      const next = cs.filter((c) => c.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !activeId) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    const history = messages;
    setMsgs(activeId, [...history, { role: "user", content: text }]);
    setBusy(true);
    try {
      const res = await fetch("/api/dshbuddy/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: hostOk ? activeId : undefined,
          messages: [...history, { role: "user", content: text }],
        }),
      });
      let reply: string;
      let isError = false;
      if (res.ok) {
        const j = (await res.json()) as { ok?: boolean; reply?: string };
        reply = j?.reply || t("chat.emptyReply");
        isError = !j?.reply;
      } else {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        reply = t("chat.errorReply", [res.status, e?.error ? ` ${e.error}` : ""]);
        isError = true;
      }
      setMsgs(activeId, [...history, { role: "user", content: text }, { role: "assistant", content: reply, error: isError } as ChatMsg & { error?: boolean }]);
      setConvs((cs) =>
        cs.map((c) => (c.id === activeId && c.title === t("chat.newConv") ? { ...c, title: text.slice(0, 24) } : c)),
      );
    } catch {
      setMsgs(activeId, [
        ...history,
        { role: "user", content: text },
        { role: "assistant", content: t("chat.networkError"), error: true } as ChatMsg & { error?: boolean },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  };

  return (
    <>
      {/* conversation bar: switch / new / delete */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          value={activeId ?? ""}
          onChange={(e) => e.target.value && void select(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid var(--buddy-panel-border)",
            background: "var(--buddy-input-bg)",
            color: "var(--buddy-panel-fg)",
            fontSize: 12,
            outline: "none",
          }}
        >
          {convs.length === 0 && <option value="">{t("chat.noConv")}</option>}
          {convs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}（{c.messages.length}）
            </option>
          ))}
        </select>
        <button onClick={() => void newConv()} title={t("chat.newConvTitle")} className="dshb-iconbtn" style={{ ...miniBtn, color: "var(--buddy-accent)" }}>
          ＋
        </button>
        <button
          onClick={() => activeId && void remove(activeId)}
          disabled={!activeId}
          title={t("chat.deleteConv")}
          className="dshb-iconbtn"
          style={{ ...miniBtn, opacity: activeId ? 1 : 0.4 }}
        >
          ✕
        </button>
      </div>
      <div
        ref={scrollRef}
        className="dshb-scroll"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minHeight: 0,
          flex: 1,
          // When embedded in a height-unbounded parent (settings tab) the flex
          // sizing above is inert — cap the column so THIS bar scrolls, not
          // the whole page (undefined maxHeight is ignored by React).
          maxHeight: maxListHeight,
          overflowY: "auto",
          padding: 2,
        }}
      >
        {messages.length === 0 && (
          <div style={{ margin: "auto", fontSize: 12, color: "var(--buddy-panel-muted)", paddingBottom: 24, textAlign: "center", lineHeight: 1.7 }}>
            {chatGreeting()}
            <br />
            <span style={{ opacity: 0.75 }}>↓</span>
          </div>
        )}
        {messages.map((m, i) => {
          const err = (m as ChatMsg & { error?: boolean }).error === true;
          return (
            <div
              key={i}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "88%",
                padding: "7px 11px",
                borderRadius: m.role === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                background:
                  m.role === "user"
                    ? "var(--buddy-accent)"
                    : err
                      ? "color-mix(in srgb, var(--buddy-danger) 10%, transparent)"
                      : "var(--buddy-row-bg)",
                border: err ? "1px solid var(--buddy-danger)" : "1px solid transparent",
                color: m.role === "user" ? "var(--buddy-on-accent)" : "var(--buddy-panel-fg)",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {m.content}
            </div>
          );
        })}
        {busy && (
          <div style={{ alignSelf: "flex-start", padding: "6px 10px" }}>
            <span className="dshb-typing">
              <i /><i /><i />
            </span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={onKeyDown}
          disabled={!activeId}
          rows={1}
          placeholder={activeId ? t("chat.inputPlaceholder") : t("chat.inputNoConv")}
          style={{
            flex: 1,
            resize: "none",
            padding: "7px 9px",
            borderRadius: 10,
            border: "1px solid var(--buddy-panel-border)",
            background: "var(--buddy-input-bg)",
            color: "var(--buddy-panel-fg)",
            fontSize: 12,
            lineHeight: 1.5,
            outline: "none",
            maxHeight: 110,
            fontFamily: "inherit",
          }}
        />
        <ActionButton onClick={() => void send()}>{busy ? "…" : t("chat.send")}</ActionButton>
      </div>
    </>
  );
}

const miniBtn: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 8,
  border: "1px solid var(--buddy-panel-border)",
  background: "var(--buddy-input-bg)",
  fontSize: 13,
  lineHeight: 1,
  flex: "none",
};

// ── morning report (每日晨报) ──────────────────────────────────────────────

export function MorningReportPanel({
  onClose,
  report,
  source,
  festival,
}: {
  onClose: () => void;
  report: string;
  source: string;
  festival: string | null;
}) {
  return (
    <PanelShell title={`🌅 ${t("nav.morning")}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {festival && (
          <div
            style={{
              fontSize: 12,
              color: "var(--buddy-accent)",
              background: "var(--buddy-accent-soft)",
              borderRadius: 8,
              padding: "6px 10px",
            }}
          >
            🎉 {t("morning.festival", [festival])}
          </div>
        )}
        <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap" }}>{report}</div>
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>
          {source === "llm" ? t("morning.sourceLlm") : t("morning.sourceLocal")} · {t("morning.autoNote")}
        </div>
      </div>
    </PanelShell>
  );
}

// ── work calendar ──────────────────────────────────────────────────────────

type CalendarEntry = { id: string; date: string; startTime: string; endTime: string; note: string; hours?: number };

export function CalendarPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title={t("nav.calendar")} onClose={onClose}>
      <CalendarBody />
    </PanelShell>
  );
}

/** An entry counts only when it carries actual content (times or a note). */
function hasCalendarContent(e: CalendarEntry): boolean {
  return Boolean(e?.startTime || e?.endTime || e?.note);
}

/** Inline work calendar (usable in the settings tab too).
 *  v0.3: today outline, readable selected day in both skins, month totals. */
export function CalendarBody() {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("12:00");
  const [note, setNote] = useState("");

  const load = (y: number, m: number) => {
    void buddyGet<{ ok: boolean; entries: CalendarEntry[] }>(`calendar?year=${y}&month=${m}`).then((json) => {
      if (json?.ok) {
        setEntries(json.entries);
      }
    });
  };

  useEffect(() => {
    load(year, month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const save = async () => {
    if (!selected) return;
    const id = editingId ?? `cal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const json = await buddyPost<{ ok: boolean; entries: CalendarEntry[] }>("calendar", {
      id,
      date: selected,
      startTime,
      endTime,
      note,
    });
    if (json?.ok) {
      setEntries(json.entries);
      setEditingId(id);
    }
  };

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDay }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const fmt = (d: number) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const contentEntries = entries.filter(hasCalendarContent);
  const monthHours = contentEntries.reduce((s, e) => s + (e.hours ?? 0), 0);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={() => (month === 1 ? (setMonth(12), setYear(year - 1)) : setMonth(month - 1))} className="dshb-iconbtn" style={{ fontSize: 16, padding: "0 8px" }}>
          ‹
        </button>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {t("cal.monthTitle", [year, month])}
        </span>
        <button onClick={() => (month === 12 ? (setMonth(1), setYear(year + 1)) : setMonth(month + 1))} className="dshb-iconbtn" style={{ fontSize: 16, padding: "0 8px" }}>
          ›
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, fontSize: 10, textAlign: "center" }}>
        {[t("wd.sun"), t("wd.mon"), t("wd.tue"), t("wd.wed"), t("wd.thu"), t("wd.fri"), t("wd.sat")].map((w) => (
          <div key={w} style={{ color: "var(--buddy-panel-muted)", padding: 2 }}>
            {w}
          </div>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <div key={i} />
          ) : (() => {
            const date = fmt(d);
            const dayEntries = entries.filter((entry) => entry.date === date && hasCalendarContent(entry));
            const entry = dayEntries[0];
            const filled = dayEntries.length > 0;
            const isSelected = selected === date;
            const isToday = date === todayStr;
            return (
              <div
                key={i}
                onClick={() => {
                  setSelected(date);
                  setEditingId(null);
                  setStartTime("09:00");
                  setEndTime("12:00");
                  setNote("");
                }}
                style={{
                  padding: "4px 2px",
                  borderRadius: 6,
                  fontSize: 11,
                  cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  background: filled ? "var(--buddy-accent-soft)" : "var(--buddy-row-bg)",
                  color: isSelected ? "var(--buddy-accent)" : "var(--buddy-panel-fg)",
                  fontWeight: isSelected ? 700 : 400,
                  outline: isSelected
                    ? "2px solid var(--buddy-accent)"
                    : isToday
                      ? "1.5px dashed var(--buddy-accent)"
                      : "none",
                  outlineOffset: -1,
                }}
                title={
                  filled
                    ? `${dayEntries.length} ${dayEntries.length === 1 ? "entry" : "entries"}: ${entry.startTime || "?"} - ${entry.endTime || "?"}${entry.note ? " · " + entry.note : ""}`
                    : undefined
                }
              >
                {d}
              </div>
            );
          })(),
        )}
      </div>
      {selected && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--buddy-panel-border)", paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", fontWeight: 600 }}>{selected}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={inputStyle} />
            <span style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("cal.to")}</span>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={inputStyle} />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder={t("cal.notePlaceholder")}
              style={{ ...inputStyle, flex: 1, minWidth: 100 }}
            />
            <ActionButton onClick={() => void save()}>{t("common.save")}</ActionButton>
          </div>
          <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>
            {t("cal.duration", [startTime && endTime ? calcHours(startTime, endTime) : "—"])}
          </div>
        </div>
      )}
      {/* Month records list (sorted by date, click a row to edit that day) */}
      <div style={{ borderTop: "1px solid var(--buddy-panel-border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, color: "var(--buddy-panel-muted)" }}>
          <span>{t("cal.monthRecords", [contentEntries.length])}</span>
          <span>{t("cal.total", [monthHours > 0 ? `${Math.round(monthHours * 10) / 10} h` : "—"])}</span>
        </div>
        {contentEntries.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("cal.empty")}</div>
        ) : (
          contentEntries
            .sort((a, b) => (a.date + (a.startTime || "")).localeCompare(b.date + (b.startTime || "")))
            .map((e) => {
              const active = e.id === editingId;
              return (
                <div
                  key={e.id}
                  onClick={() => {
                    setSelected(e.date);
                    setEditingId(e.id);
                    setStartTime(e.startTime || "09:00");
                    setEndTime(e.endTime || "12:00");
                    setNote(e.note ?? "");
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 8px",
                    borderRadius: 8,
                    background: active ? "var(--buddy-accent-soft)" : "var(--buddy-row-bg)",
                    outline: active ? "1px solid var(--buddy-accent)" : "none",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  <span style={{ color: e.date === todayStr ? "var(--buddy-accent)" : "var(--buddy-panel-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {e.date.slice(5)}
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{e.startTime || "?"}–{e.endTime || "?"}</span>
                  <span style={{ flex: 1, color: "var(--buddy-panel-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.note || ""}
                  </span>
                  {e.hours !== undefined && (
                    <span style={{ color: "var(--buddy-panel-muted)", fontVariantNumeric: "tabular-nums" }}>
                      {Math.round(e.hours * 10) / 10}h
                    </span>
                  )}
                  {(e.note || "").trim() && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        const text = `${e.date.slice(5)} ${e.note.split("\n")[0]}`.trim();
                        void buddyPost<{ ok: boolean }>("notes", { op: "add", note: { id: `cal-${e.date}-${Date.now()}`, text } }).then((j) => {
                          if (j?.ok) {
                            const b = ev.currentTarget as HTMLButtonElement;
                            b.textContent = "✓";
                            b.title = t("cal.addedTodo");
                            window.setTimeout(() => {
                              b.textContent = "→";
                              b.title = t("cal.toTodo");
                            }, 1200);
                          }
                        });
                      }}
                      title={t("cal.toTodo")}
                      className="dshb-iconbtn"
                      style={{ fontSize: 11, lineHeight: 1, padding: "2px 4px", color: "var(--buddy-accent)" }}
                    >
                      →
                    </button>
                  )}
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void buddyPost<{ ok: boolean; entries: CalendarEntry[] }>("calendar", { op: "remove", id: e.id, date: e.date }).then((j) => {
                        if (j?.ok) {
                          setEntries(j.entries);
                          if (editingId === e.id) setEditingId(null);
                        }
                      });
                    }}
                    title={t("cal.deleteEntry")}
                    className="dshb-iconbtn"
                    style={{ fontSize: 12, lineHeight: 1, padding: 2 }}
                  >
                    ✕
                  </button>
                </div>
              );
            })
        )}
      </div>
    </>
  );
}

function calcHours(start: string, end: string): string {
  const toMin = (t: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  };
  const diff = Math.max(0, toMin(end) - toMin(start));
  const h = Math.floor(diff / 60);
  const mm = diff % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
}

const inputStyle: React.CSSProperties = {
  padding: "5px 8px",
  borderRadius: 8,
  border: "1px solid var(--buddy-panel-border)",
  background: "var(--buddy-input-bg)",
  color: "var(--buddy-panel-fg)",
  fontSize: 12,
  outline: "none",
};

// ── todo list (was: notes) ─────────────────────────────────────────────────

type Note = { id: string; text: string; done: boolean };

export function NotesPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title={t("nav.notes")} onClose={onClose}>
      <TodoListBody />
    </PanelShell>
  );
}

/** Inline todo list (usable in the settings tab too).
 *  v0.3: themed checkboxes + a slim completion progress bar. */
export function TodoListBody() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState("");

  const reload = () => {
    void buddyGet<{ ok: boolean; notes: Note[] }>("notes").then((json) => {
      if (json?.ok) setNotes(json.notes);
    });
  };

  useEffect(reload, []);

  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    const json = await buddyPost<{ ok: boolean; notes: Note[] }>("notes", { op: "add", note: { text: trimmed } });
    if (json?.ok) setNotes(json.notes);
  };

  const act = async (op: string, id: string) => {
    // Marking a todo done → also log it into today's work calendar (打通).
    const target = notes.find((n) => n.id === id);
    const json = await buddyPost<{ ok: boolean; notes: Note[] }>("notes", { op, note: { id } });
    if (json?.ok) setNotes(json.notes);
    if (op === "toggle" && target && !target.done && target.text.trim()) {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      void buddyPost("calendar", { op: "append", date: today, note: `✅ ${target.text.trim()}` });
    }
  };

  const clearDone = async () => {
    const json = await buddyPost<{ ok: boolean; notes: Note[] }>("notes", { op: "clear-done" });
    if (json?.ok) setNotes(json.notes);
  };

  const remaining = notes.filter((n) => !n.done).length;
  const doneCount = notes.length - remaining;
  const donePct = notes.length ? Math.round((doneCount / notes.length) * 100) : 0;

  return (
    <>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={t("todo.addPlaceholder")}
          style={{
            flex: 1,
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid var(--buddy-panel-border)",
            background: "var(--buddy-input-bg)",
            color: "var(--buddy-panel-fg)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <ActionButton onClick={() => void add()}>{t("common.add")}</ActionButton>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--buddy-panel-muted)" }}>
        <span>{t("todo.remaining", [remaining, notes.length])}</span>
        {notes.some((n) => n.done) && (
          <button onClick={() => void clearDone()} style={{ background: "none", border: "none", color: "var(--buddy-accent)", fontSize: 11, cursor: "pointer" }}>
            {t("todo.clearDone")}
          </button>
        )}
      </div>
      {notes.length > 0 && (
        <div style={{ height: 4, borderRadius: 4, background: "var(--buddy-row-bg)", overflow: "hidden" }}>
          <div
            style={{
              width: `${donePct}%`,
              height: "100%",
              borderRadius: 4,
              background: "var(--buddy-success)",
              transition: "width 240ms ease",
            }}
          />
        </div>
      )}
      {notes.map((n) => (
        <div
          key={n.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            borderRadius: 8,
            background: "var(--buddy-row-bg)",
            border: "1px solid transparent",
            fontSize: 12,
            transition: "border-color 120ms",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = "var(--buddy-panel-border)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = "transparent";
          }}
        >
          <input
            type="checkbox"
            checked={n.done}
            onChange={() => act("toggle", n.id)}
            style={{ accentColor: "var(--buddy-accent)", cursor: "pointer", flex: "none" }}
          />
          <span
            style={{
              flex: 1,
              color: n.done ? "var(--buddy-panel-muted)" : "var(--buddy-panel-fg)",
              textDecoration: n.done ? "line-through" : "none",
            }}
          >
            {n.text}
          </span>
          <button onClick={() => act("remove", n.id)} className="dshb-iconbtn" style={{ fontSize: 12 }}>
            ✕
          </button>
        </div>
      ))}
      {notes.length === 0 && (
        <div style={{ padding: "14px 8px", textAlign: "center", fontSize: 12, color: "var(--buddy-panel-muted)" }}>
          {t("todo.empty")}
        </div>
      )}
    </>
  );
}
