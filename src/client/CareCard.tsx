/**
 * CareCard — the 鲸灵 (JingLing) proactive-care popup.
 *
 * When the companion engine pushes a care message, instead of only showing a
 * bubble over the pet we render this small card near it (morning-report style):
 * the care text, a COLLAPSED input row that expands on click so the user can
 * reply right away (mini conversation inside the card), and shortcuts to
 * continue in the full chat panel or dismiss.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "./i18n.js";

type CardMsg = { role: "user" | "assistant"; content: string; error?: boolean };

const CARD_TTL_MS = 120_000; // stay visible up to 2 min unless dismissed

export function CareCard({
  careText,
  careTs,
  reasonKey,
  snoozeKind,
  letter,
  onDismiss,
  onOpenChat,
}: {
  careText: string;
  careTs: number;
  /** v0.4 D2 ⓘ explainability — i18n suffix under `care.reason.*`. */
  reasonKey?: string;
  /** v0.4 D3 「晚点再说」— when set, the card offers a snooze button for it. */
  snoozeKind?: string;
  /** v0.4 E letter tone (burnout/wind-down): calmer frame, no TTL countdown —
   *  a heartfelt letter shouldn't visibly expire while being read. */
  letter?: boolean;
  onDismiss: () => void;
  onOpenChat: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<CardMsg[]>([]);
  const [showReason, setShowReason] = useState(false);
  const [, forceTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-render once per 10s so the relative timestamp stays fresh.
  useEffect(() => {
    const iv = setInterval(() => forceTick((n) => n + 1), 10_000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setBusy(true);
    try {
      const res = await fetch("/api/dshbuddy/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: `${t("care.cardContext")}\n\n${careText}\n\n---\n${text}` }] }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; reply?: string } | null;
      setMsgs((m) => [...m, { role: "assistant", content: j?.reply || t("chat.emptyReply"), error: !j?.reply }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: t("chat.networkError"), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const ageMin = Math.max(0, Math.round((Date.now() - careTs) / 60000));

  return (
    <div
      className="dshb-pop"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        width: 292,
        maxHeight: 420,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 14,
        background: "var(--buddy-bubble-bg)",
        border: letter ? "1px solid var(--buddy-warning, var(--buddy-accent))" : "1px solid var(--buddy-accent)",
        boxShadow: "var(--buddy-shadow)",
        color: "var(--buddy-bubble-fg)",
        zIndex: 2147483600,
        pointerEvents: "auto",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 14 }}>🐳</span>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{t("care.brand")}</span>
        <span style={{ fontSize: 10, color: "var(--buddy-panel-muted)", flex: 1 }}>
          {ageMin > 0 ? t("care.ago", [ageMin]) : t("care.justNow")}
        </span>
        {/* v0.4 D2 ⓘ — why is the pet talking NOW? (over-adaptation reads as
            insincere; showing the trigger restores trust) */}
        {reasonKey && (
          <button
            onClick={() => setShowReason((v) => !v)}
            className="dshb-iconbtn"
            title={t("care.reasonHint")}
            style={{ fontSize: 11, padding: "2px 5px", opacity: showReason ? 1 : 0.7 }}
          >
            ⓘ
          </button>
        )}
        <button onClick={onDismiss} title={t("common.save") === "" ? "" : t("care.dismiss")} className="dshb-iconbtn" style={{ fontSize: 11, padding: "2px 5px" }}>
          ✕
        </button>
      </div>

      {/* explainability row (v0.4 D2) */}
      {reasonKey && showReason && (
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.6,
            color: "var(--buddy-panel-muted)",
            background: "var(--buddy-row-bg)",
            borderRadius: 8,
            padding: "6px 9px",
          }}
        >
          {t("care.reasonPrefix")} {t(`care.reason.${reasonKey}` as never)}
        </div>
      )}

      {/* care text */}
      <div style={{ fontSize: 12.5, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{careText}</div>

      {/* mini conversation */}
      {(msgs.length > 0 || busy) && (
        <div ref={scrollRef} className="dshb-scroll" style={{ maxHeight: 170, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {msgs.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "88%",
                padding: "6px 9px",
                borderRadius: 10,
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: m.role === "user" ? "var(--buddy-accent-soft)" : "var(--buddy-row-bg)",
                border: m.error ? "1px solid var(--buddy-danger)" : "1px solid transparent",
              }}
            >
              {m.content}
            </div>
          ))}
          {busy && (
            <div className="dshb-typing" style={{ alignSelf: "flex-start", color: "var(--buddy-panel-muted)", fontSize: 11 }}>
              {t("care.thinking")}
            </div>
          )}
        </div>
      )}

      {/* collapsed input row → expands to textarea + send */}
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          style={{
            textAlign: "left",
            padding: "7px 10px",
            borderRadius: 10,
            border: "1px dashed var(--buddy-panel-border)",
            background: "var(--buddy-row-bg)",
            color: "var(--buddy-panel-muted)",
            fontSize: 12,
            cursor: "text",
          }}
        >
          💬 {t("care.replyPlaceholder")}
        </button>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <textarea
            autoFocus
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = `${Math.min(90, e.currentTarget.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t("care.inputPlaceholder")}
            rows={1}
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
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={() => void send()}
            disabled={busy}
            style={{
              padding: "0 12px",
              borderRadius: 10,
              border: "none",
              background: "var(--buddy-accent)",
              color: "var(--buddy-on-accent)",
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? "wait" : "pointer",
              flex: "none",
            }}
          >
            {busy ? "…" : t("chat.send")}
          </button>
        </div>
      )}

      {/* footer actions */}
      <div style={{ display: "flex", gap: 6, justifyContent: "space-between" }}>
        <button
          onClick={() => {
            // v0.4 F2 — curious care: open the chat panel AND pour the card
            // text into the input as a starter. Generic "continue in chat"
            // only opens the panel.
            if (snoozeKind === "curious") {
              window.dispatchEvent(new CustomEvent<string>("dshbuddy:chat-prefill", { detail: careText }));
            }
            onOpenChat();
          }}
          style={{ background: "none", border: "none", color: "var(--buddy-accent)", fontSize: 11, cursor: "pointer", padding: 0 }}
        >
          {snoozeKind === "curious" ? t("care.askBack") : t("care.continueInChat")} ↗
        </button>
        {!expanded && (
          <span style={{ display: "flex", gap: 10 }}>
            {/* v0.4 D3 「晚点再说」— snooze this kind for 2h; repeated snoozes
                teach the engine to fire it less often (rolling 14-day window). */}
            {snoozeKind && (
              <button
                onClick={() => {
                  void fetch("/api/dshbuddy/care/snooze", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ kind: snoozeKind }),
                  }).catch(() => null);
                  onDismiss();
                }}
                style={{ background: "none", border: "none", color: "var(--buddy-panel-muted)", fontSize: 11, cursor: "pointer", padding: 0 }}
              >
                {t("care.snooze")}
              </button>
            )}
            <button
              onClick={onDismiss}
              style={{ background: "none", border: "none", color: "var(--buddy-panel-muted)", fontSize: 11, cursor: "pointer", padding: 0 }}
            >
              {t("care.gotIt")}
            </button>
          </span>
        )}
      </div>

      {/* TTL progress hint (hidden for letter tone — letters don't expire) */}
      {!letter && (
      <div style={{ height: 3, borderRadius: 3, background: "var(--buddy-row-bg)", overflow: "hidden" }} title={t("care.ttlHint")}>
        <div
          style={{
            height: "100%",
            background: "var(--buddy-accent)",
            opacity: 0.5,
            width: `${Math.max(4, 100 - Math.min(100, ((Date.now() - careTs) / CARD_TTL_MS) * 100))}%`,
            transition: "width 1s linear",
          }}
        />
      </div>
      )}
    </div>
  );
}

/**
 * Whether a care card should currently be shown for the given care payload.
 * Letter tone (burnout/wind-down) is sticky — it waits for dismissal instead
 * of expiring after CARD_TTL_MS.
 */
export function careCardActive(careTs: number, letter = false): boolean {
  if (careTs <= 0) return false;
  return letter || Date.now() - careTs < CARD_TTL_MS;
}
