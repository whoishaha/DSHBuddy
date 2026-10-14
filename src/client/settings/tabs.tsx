/**
 * DSHBuddy settings tabs — all features live inside one settings.section;
 * SettingsPanel switches between these tabs on the right side.
 */

import { useEffect, useRef, useState } from "react";
import { GRID } from "../sprite.js";
import { buddyGet, buddyPost, useBuddySnapshot } from "../useBuddyState.js";
import { t, currentLang } from "../i18n.js";
import { CalendarBody, ChatBody, TodoListBody } from "../panels.js";
import { requestPanel } from "../panelBus.js";
import { rarityFor, isShiny, RARITY_META } from "../rarity.js";
export { GrowthTab } from "./GrowthTab.js";
import {
  card as cardStyle,
  input as inputStyle,
  mutedText as mutedTextStyle,
  primaryBtn as accentBtn,
  row as rowStyle,
  sectionTitle as sectionTitleStyle,
  select as selectStyle,
  subTitle as subTitleStyle,
  ToggleRow,
} from "../ui.js";

/** Ask the floater to open a floating panel (chat/calendar/pomodoro). */
export function openFloaterPanel(kind: "chat" | "calendar" | "pomodoro") {
  requestPanel(kind);
}

const field = (label: string, value: string, onChange: (v: string) => void, placeholder = "", type = "text") => (
  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
    <span style={{ color: "var(--buddy-panel-muted)" }}>{label}</span>
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={inputStyle}
    />
  </label>
);

// ── 双向自护 (mutual self-care, v0.4 batch C) ───────────────────────────────

type SelfcareBoard = {
  day: string;
  quests: { id: string; icon: string; label: { zh: string; en: string }; done: boolean; breathable: boolean }[];
  cleared: boolean;
  breathDoneToday: boolean;
};
type SelfcarePayload = {
  ok: boolean;
  board: SelfcareBoard;
  moodToday: number | null;
  moodStrip: { date: string; mood: number | null; note?: string }[];
};

const MOOD_EMOJI = ["😞", "😕", "😐", "🙂", "😄"];
const MOOD_COLOR = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e"];

function WellbeingSection() {
  const [sc, setSc] = useState<SelfcarePayload | null>(null);
  const [proudDraft, setProudDraft] = useState("");
  const [moodNote, setMoodNote] = useState("");
  const [proudMsg, setProudMsg] = useState<string | null>(null);

  const load = () => {
    void buddyGet<SelfcarePayload>("selfcare").then((j) => {
      if (j?.ok) setSc(j);
    });
  };
  useEffect(load, []);

  const completeQuest = async (id: string) => {
    await buddyPost("selfcare", { op: "complete", id });
    load();
  };
  const checkMood = async (mood: number) => {
    await buddyPost("mood", { mood, note: moodNote.trim() });
    setMoodNote("");
    load();
  };
  const sendProud = async () => {
    const text = proudDraft.trim();
    if (!text) return;
    const j = await buddyPost<{ ok: boolean; error?: string }>("mood", { op: "proud", text });
    if (j?.ok) {
      setProudDraft("");
      setProudMsg(t("proud.thanks"));
    } else if (j?.error === "already recorded this week") {
      setProudMsg(t("proud.done"));
    } else {
      setProudMsg(null);
    }
  };

  const quests = sc?.board.quests ?? [];

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* mood check-in */}
      <h4 style={{ margin: 0, fontSize: 13 }}>{t("mood.title")}</h4>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {MOOD_EMOJI.map((emo, i) => {
          const picked = sc?.moodToday === i + 1;
          return (
            <button
              key={i}
              onClick={() => void checkMood(i + 1)}
              title={String(i + 1)}
              style={{
                fontSize: picked ? 20 : 17,
                lineHeight: 1,
                padding: "5px 8px",
                borderRadius: 10,
                border: picked ? "1px solid var(--buddy-accent)" : "1px solid transparent",
                background: picked ? "var(--buddy-input-bg)" : "transparent",
                cursor: "pointer",
                filter: picked ? "none" : "grayscale(0.25)",
                transition: "transform 120ms ease",
              }}
            >
              {emo}
            </button>
          );
        })}
        {sc?.moodToday != null && (
          <span style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>{t("mood.checked")}</span>
        )}
      </div>
      <input
        value={moodNote}
        onChange={(e) => setMoodNote(e.target.value)}
        maxLength={140}
        placeholder={t("mood.notePlaceholder")}
        style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
      />
      {/* 14-day mood strip */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: 10.5, color: "var(--buddy-panel-muted)" }}>{t("mood.stripTitle")}</span>
        <div style={{ display: "flex", gap: 3 }}>
          {(sc?.moodStrip ?? []).map((cell) => (
            <span
              key={cell.date}
              title={`${cell.date}${cell.mood != null ? ` · ${MOOD_EMOJI[(cell.mood ?? 1) - 1]}` : ""}${cell.note ? ` · ${cell.note}` : ""}`}
              style={{
                flex: 1,
                height: 10,
                borderRadius: 5,
                background: cell.mood != null ? MOOD_COLOR[cell.mood - 1] : "var(--buddy-input-bg)",
                border: "1px solid var(--buddy-panel-border)",
                opacity: cell.mood != null ? 0.9 : 0.6,
              }}
            />
          ))}
        </div>
      </div>

      {/* daily quests */}
      <h4 style={{ margin: "6px 0 0", fontSize: 13 }}>{t("selfcare.title")}</h4>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.6 }}>{t("selfcare.hint")}</div>
      {quests.map((q) => (
        <div
          key={q.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderRadius: 10,
            background: "var(--buddy-row-bg)",
            fontSize: 12,
            opacity: q.done ? 0.75 : 1,
          }}
        >
          <span style={{ fontSize: 15 }}>{q.icon}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            {currentLang() === "en" ? q.label.en : q.label.zh}
          </span>
          {q.done ? (
            <span style={{ fontSize: 11, color: "var(--buddy-success)", flex: "none" }}>{t("selfcare.doneTag")}</span>
          ) : (
            <span style={{ display: "flex", gap: 5, flex: "none" }}>
              {q.breathable && (
                <button onClick={() => requestPanel("breath")} className="dshb-iconbtn" style={{ fontSize: 11, padding: "3px 8px" }}>
                  🫁
                </button>
              )}
              <button onClick={() => void completeQuest(q.id)} className="dshb-iconbtn" style={{ fontSize: 11, padding: "3px 8px" }}>
                {t("selfcare.doneBtn", [5])}
              </button>
            </span>
          )}
        </div>
      ))}
      {sc?.board.cleared && (
        <span style={{ fontSize: 11.5, color: "var(--buddy-success)" }}>{t("selfcare.cleared", [15])}</span>
      )}

      {/* box breathing */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
        <button onClick={() => requestPanel("breath")} style={accentBtn}>
          🫁 {t("selfcare.breath")}
        </button>
        {sc?.board.breathDoneToday && (
          <span style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>{t("selfcare.breathDoneToday")}</span>
        )}
      </div>

      {/* weekly proud moment */}
      <h4 style={{ margin: "6px 0 0", fontSize: 13 }}>{t("proud.title")}</h4>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <textarea
          value={proudDraft}
          onChange={(e) => setProudDraft(e.target.value)}
          placeholder={t("proud.placeholder")}
          rows={2}
          style={{
            ...inputStyle,
            flex: 1,
            resize: "vertical",
            minHeight: 48,
            lineHeight: 1.6,
            fontFamily: "inherit",
          }}
        />
        <button onClick={() => void sendProud()} style={accentBtn}>
          {t("proud.send")}
        </button>
      </div>
      {proudMsg && <span style={{ fontSize: 11, color: "var(--buddy-success)" }}>{proudMsg}</span>}
    </section>
  );
}

type HomeMemoryPayload = {
  ok: boolean;
  memory?: {
    milestones?: { title: string; description: string; createdAt: number }[];
    timeline?: { date: string; title: string; description: string }[];
  };
};

/** Companion-first landing page: live presence, today's shared work, recent
 * memory and the few actions that should remain one click away. */
export function CompanionHomeTab({ openSection }: { openSection: (key: "jingling" | "growth") => void }) {
  const { data } = useBuddySnapshot(1000);
  const [memories, setMemories] = useState<{ title: string; detail: string }[]>([]);

  useEffect(() => {
    void buddyGet<HomeMemoryPayload>("growth").then((json) => {
      if (!json?.ok) return;
      const milestoneRows = (json.memory?.milestones ?? []).slice(0, 2).map((item) => ({
        title: item.title,
        detail: item.description,
      }));
      const timelineRows = (json.memory?.timeline ?? []).slice(0, 2).map((item) => ({
        title: item.title,
        detail: item.description,
      }));
      setMemories([...milestoneRows, ...timelineRows].slice(0, 3));
    });
  }, []);

  const summary = data?.summary;
  const growth = data?.growth;
  const activeMin = Math.round((summary?.todayActiveMs ?? 0) / 60_000);
  const statusText = data?.snapshot.bubble?.trim() || t("home.statusQuiet");
  const quickActions = [
    { label: t("home.action.order"), action: () => openSection("jingling") },
    { label: t("home.action.chat"), action: () => requestPanel("chat") },
    { label: t("home.action.pomodoro"), action: () => requestPanel("pomodoro") },
    { label: t("home.action.notes"), action: () => requestPanel("notes") },
    { label: t("home.action.calendar"), action: () => requestPanel("calendar") },
  ];

  return (
    <div className="dshb-home">
      <section className="dshb-home-hero">
        <div style={{ minWidth: 0 }}>
          <div className="dshb-home-eyebrow">{t("home.eyebrow")}</div>
          <h3 style={{ margin: "3px 0 5px", fontSize: 19 }}>
            {data?.pet?.displayName ?? "DSHBuddy"}
          </h3>
          <div style={{ color: "var(--buddy-panel-muted)", fontSize: 12.5, lineHeight: 1.6 }}>{statusText}</div>
        </div>
        <div className="dshb-home-level">
          <strong>Lv.{growth?.level ?? 1}</strong>
          <span>{t("home.bond", [growth?.bond ?? 0])}</span>
        </div>
      </section>

      <section>
        <div className="dshb-home-section-head">
          <h4>{t("home.today")}</h4>
          <button className="dshb-home-link" onClick={() => openSection("growth")}>{t("home.viewGrowth")}</button>
        </div>
        <div className="dshb-home-metrics">
          <HomeMetric value={summary?.todayTurns ?? 0} label={t("stats.todayTurns")} />
          <HomeMetric value={summary?.todayTools ?? 0} label={t("stats.todayTools")} />
          <HomeMetric value={`${activeMin}m`} label={t("home.activeTime")} />
          <HomeMetric value={growth?.energy ?? 100} label={t("stats.growth.energy")} />
        </div>
      </section>

      <section>
        <div className="dshb-home-section-head"><h4>{t("home.quickActions")}</h4></div>
        <div className="dshb-home-actions">
          {quickActions.map((item) => (
            <button key={item.label} onClick={item.action}>{item.label}</button>
          ))}
        </div>
      </section>

      <section>
        <div className="dshb-home-section-head"><h4>{t("home.recentMemory")}</h4></div>
        {memories.length ? (
          <div className="dshb-home-memory-list">
            {memories.map((item, index) => (
              <div className="dshb-home-memory" key={`${item.title}-${index}`}>
                <strong>{item.title}</strong>
                <span>{item.detail || t("home.memoryFallback")}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="dshb-home-empty">{t("home.noMemory")}</div>
        )}
      </section>
    </div>
  );
}

function HomeMetric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="dshb-home-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

// ── 鲸灵 (JingLing) — proactive care + work orders ─────────────────────────

type WorkOrder = {
  id: string;
  text: string;
  task: string;
  triggerAt: number;
  workspace?: string;
  status: "pending" | "running" | "done" | "failed" | "canceled";
  createdAt: number;
  error?: string;
  recurrence?: "daily";
};

const ORDER_STATUS_STYLE: Record<string, { color: string; key: string }> = {
  pending: { color: "var(--buddy-accent)", key: "order.pending" },
  running: { color: "var(--buddy-warning)", key: "order.running" },
  done: { color: "var(--buddy-success)", key: "order.done" },
  failed: { color: "var(--buddy-danger)", key: "order.failed" },
  canceled: { color: "var(--buddy-panel-muted)", key: "order.canceled" },
};

/**
 * v0.4 F1 — dream-bubble trigger. The user can ask the whale to "go dream
 * a bit" and a single short monologue pops up over the pet's head (the
 * normal bubble channel). Throttled server-side to one emission per 20 min.
 */
function DreamButton() {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const ask = async () => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    try {
      const j = await buddyGet<{ ok: boolean; throttled?: boolean; waitMs?: number; text?: string | null }>("dream");
      if (j?.throttled) {
        const min = Math.max(1, Math.ceil((j.waitMs ?? 0) / 60000));
        setHint(t("dream.throttled", [String(min)]));
      } else if (!j?.text) {
        setHint(t("dream.empty"));
      }
      // If a dream text is returned, the host already pushed it into the
      // care snapshot; the polling Bubble will surface it on its own.
    } finally {
      setBusy(false);
    }
  };
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h4 style={{ margin: 0, fontSize: 13 }}>{t("dream.title")}</h4>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => void ask()}
          disabled={busy}
          className="dshb-tabbtn"
          style={{
            padding: "5px 12px",
            borderRadius: 999,
            border: "1px solid var(--buddy-panel-border)",
            background: "var(--buddy-row-bg)",
            color: "var(--buddy-panel-fg)",
            fontSize: 11.5,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          🌙 {busy ? t("dream.busy") : t("dream.button")}
        </button>
        {hint && (
          <span style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>{hint}</span>
        )}
      </div>
    </section>
  );
}

export function JinglingTab() {
  const { data } = useBuddySnapshot(1000);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const cfg = data?.config;

  const load = () => {
    void buddyGet<{ ok: boolean; orders: WorkOrder[] }>("orders").then((j) => {
      if (j?.ok) setOrders(j.orders);
    });
  };
  useEffect(load, []);

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    const j = await buddyPost<{ ok: boolean; order?: WorkOrder; error?: string }>("orders", { op: "add", text });
    if (j?.ok && j.order) {
      const when = new Date(j.order.triggerAt).toLocaleString(currentLang() === "en" ? "en-US" : "zh-CN");
      setFeedback({ ok: true, text: t("order.added", [when]) + (j.order.workspace ? t("order.atWorkspace", [j.order.workspace]) : "") });
      setDraft("");
      load();
    } else {
      setFeedback({ ok: false, text: t("order.needTime") });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>🐳 {t("care.brand")} · {t("care.tagline")}</h3>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.6 }}>
        {t("care.desc")}
      </div>

      {/* care switches (reuse existing config toggles) */}
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 13 }}>{t("personality.care")}</h4>
        <ToggleRow label={t("personality.care.micro")} checked={cfg?.careMicroEnabled ?? true} onChange={(v) => void buddyPost("config", { careMicroEnabled: v })} />
        <ToggleRow label={t("personality.care.festival")} checked={cfg?.careFestivalEnabled ?? true} onChange={(v) => void buddyPost("config", { careFestivalEnabled: v })} />
        <ToggleRow label={t("personality.care.idleChat")} checked={cfg?.careIdleChatEnabled ?? true} onChange={(v) => void buddyPost("config", { careIdleChatEnabled: v })} />
        <RestThresholdRow data={data} />
        {/* v0.4 D1 — global chattiness knob: daily budget + cooldown multiplier */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12 }}>{t("care.intensity.title")}</span>
          <span style={{ display: "inline-flex", gap: 3 }}>
            {(["quiet", "gentle", "normal", "attentive"] as const).map((m) => {
              const active = (cfg?.careIntensity ?? "normal") === m;
              return (
                <button
                  key={m}
                  onClick={() => void buddyPost("config", { careIntensity: m })}
                  className={`dshb-tabbtn${active ? " dshb-on" : ""}`}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--buddy-panel-border)",
                    background: active ? "var(--buddy-accent)" : "transparent",
                    color: active ? "var(--buddy-on-accent)" : "var(--buddy-panel-muted)",
                    fontSize: 11.5,
                    cursor: "pointer",
                  }}
                >
                  {t(`care.intensity.${m}` as never)}
                </button>
              );
            })}
          </span>
        </div>
        {/* v0.4 E2 — wind-down ritual: wrap-up card + tomorrow draft at this hour */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12 }}>{t("care.winddown.title")}</span>
          <ToggleRow label={t("care.winddown.enable")} checked={cfg?.windDownEnabled ?? true} onChange={(v) => void buddyPost("config", { windDownEnabled: v })} />
          <select
            value={String(cfg?.windDownHour ?? 21)}
            onChange={(e) => void buddyPost("config", { windDownHour: Number(e.target.value) })}
            disabled={!(cfg?.windDownEnabled ?? true)}
            title={t("care.winddown.hourHint")}
            style={{ ...inputStyle, width: 92 }}
          >
            {[19, 20, 21, 22, 23].map((hh) => (
              <option key={hh} value={String(hh)}>{`${hh}:00`}</option>
            ))}
          </select>
        </div>
      </section>

      {/* mutual self-care (v0.4): mood check-in, daily quests, breathing, proud wall */}
      <WellbeingSection />

      {/* v0.4 F1 — dream-bubble trigger: a one-tap button that pings
          GET /dream and lets the whale mutter a half-remembered line above
          its head. No card, no level, no task. Just a small uncanny moment. */}
      <DreamButton />

      {/* work-order composer */}
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 13 }}>{t("order.title")}</h4>
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.6 }}>
          {t("order.hint")}
          <br />
          <span style={{ fontFamily: "monospace" }}>{t("order.example")}</span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("order.placeholder")}
          rows={3}
          style={{
            ...inputStyle,
            resize: "vertical",
            minHeight: 64,
            lineHeight: 1.6,
            fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => void add()} style={accentBtn}>
            {t("order.submit")}
          </button>
          {feedback && (
            <span style={{ fontSize: 11, color: feedback.ok ? "var(--buddy-success)" : "var(--buddy-danger)", lineHeight: 1.5 }}>{feedback.text}</span>
          )}
        </div>
      </section>

      {/* order list */}
      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h4 style={{ margin: 0, fontSize: 13 }}>{t("order.listTitle", [orders.length])}</h4>
        {orders.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("order.empty")}</div>
        )}
        {orders.slice(0, 20).map((o) => {
          const st = ORDER_STATUS_STYLE[o.status] ?? ORDER_STATUS_STYLE.pending;
          return (
            <div
              key={o.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 10,
                background: "var(--buddy-row-bg)",
                fontSize: 12,
              }}
            >
              <span style={{ flex: "none", fontWeight: 700, color: st.color }}>{t(st.key as never)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.text}</div>
                <div style={{ fontSize: 10, color: "var(--buddy-panel-muted)" }}>
                  {new Date(o.triggerAt).toLocaleString(currentLang() === "en" ? "en-US" : "zh-CN")}
                  {o.workspace ? ` · ${o.workspace}` : ""}
                  {o.recurrence === "daily" ? ` · ${t("order.daily")}` : ""}
                  {o.error ? ` · ${o.error}` : ""}
                </div>
              </div>
              {o.status === "pending" ? (
                <button
                  onClick={() => void buddyPost("orders", { op: "cancel", id: o.id }).then(load)}
                  className="dshb-iconbtn"
                  title={t("order.cancel")}
                  style={{ fontSize: 11, flex: "none" }}
                >
                  ✕
                </button>
              ) : o.status === "failed" ? (
                <span style={{ display: "inline-flex", gap: 3 }}>
                  <button
                    onClick={() => void buddyPost("orders", { op: "retry", id: o.id }).then(load)}
                    className="dshb-iconbtn"
                    title={t("order.retry")}
                    style={{ fontSize: 13, flex: "none" }}
                  >
                    ↻
                  </button>
                  <button
                    onClick={() => void buddyPost("orders", { op: "remove", id: o.id }).then(load)}
                    className="dshb-iconbtn"
                    title={t("order.remove")}
                    style={{ fontSize: 11, flex: "none", opacity: 0.7 }}
                  >
                    🗑
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => void buddyPost("orders", { op: "remove", id: o.id }).then(load)}
                  className="dshb-iconbtn"
                  title={t("order.remove")}
                  style={{ fontSize: 11, flex: "none", opacity: 0.7 }}
                >
                  🗑
                </button>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

// ── Pet ────────────────────────────────────────────────────────────────────

export function PetTab() {
  const { data } = useBuddySnapshot(1000);
  const [pets, setPets] = useState<{ slug: string; displayName: string }[]>([]);
  // Local zoom mirrors the persisted petScale; dragging POSTs debounced so the
  // config endpoint isn't hammered on every tick.
  const [zoom, setZoom] = useState<number | null>(null);
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (zoomTimer.current) clearTimeout(zoomTimer.current);
  }, []);

  useEffect(() => {
    let alive = true;
    buddyGet<{ ok: boolean; pets: { slug: string; displayName: string }[] }>("pets").then((j) => {
      if (alive && j?.ok) setPets(j.pets);
    });
    return () => {
      alive = false;
    };
  }, []);

  const config = data?.config;
  const current = data?.pet?.slug ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("pet.title")}</h3>
      <div>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", marginBottom: 4 }}>{t("pet.active")}</div>
        <select value={current} onChange={(e) => void buddyPost("activate", { slug: e.target.value })} style={selectStyle}>
          {pets.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.displayName}
            </option>
          ))}
        </select>
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", marginBottom: 4 }}>{t("pet.mode")}</div>
        <select
          value={config?.floaterMode ?? "corner"}
          onChange={(e) => void buddyPost("config", { floaterMode: e.target.value })}
          style={selectStyle}
        >
          <option value="corner">{t("pet.mode.corner")}</option>
          <option value="walker">{t("pet.mode.walker")}</option>
        </select>
      </div>
      <ToggleRow label={t("pet.visible")} checked={config?.visible ?? true} onChange={(v) => void buddyPost("config", { visible: v })} />
      <ToggleRow label={t("pet.companion")} checked={config?.companionEnabled ?? true} onChange={(v) => void buddyPost("config", { companionEnabled: v })} />
      {/* B1-2 host-side event sounds (OS audio — survive browser mute). */}
      <div>
        <ToggleRow label={`🔊 ${t("pet.sound")}`} checked={config?.soundEnabled ?? true} onChange={(v) => void buddyPost("config", { soundEnabled: v })} />
        {(config?.soundEnabled ?? true) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("pet.sound.volume")}</span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={config?.soundVolume ?? 70}
              onChange={(e) => void buddyPost("config", { soundVolume: Number(e.target.value) })}
              style={{ flex: 1, accentColor: "var(--buddy-accent)" }}
            />
            <span style={{ fontSize: 12, minWidth: 34, textAlign: "right", color: "var(--buddy-panel-muted)" }}>{config?.soundVolume ?? 70}%</span>
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", marginTop: 4, lineHeight: 1.5 }}>{t("pet.sound.hint")}</div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", marginBottom: 4 }}>{t("pet.zoom")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={zoom ?? config?.petScale ?? 1}
            onChange={(e) => {
              const v = Number(e.target.value);
              setZoom(v);
              if (zoomTimer.current) clearTimeout(zoomTimer.current);
              zoomTimer.current = setTimeout(() => void buddyPost("config", { petScale: v }), 300);
            }}
            style={{ flex: 1, accentColor: "var(--buddy-accent)" }}
          />
          <span style={{ fontSize: 12, minWidth: 42, textAlign: "right", color: "var(--buddy-panel-muted)" }}>
            {Math.round((zoom ?? config?.petScale ?? 1) * 100)}%
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Stats ──────────────────────────────────────────────────────────────────

export { StatsTab } from "./StatsTab.js";

// ── Appearance ─────────────────────────────────────────────────────────────

export function AppearanceTab() {
  const { data } = useBuddySnapshot(1000);
  const config = data?.config;
  const skin = config?.skin === "light" ? "light" : "dark";
  const language = config?.language ?? "zh";
  // Optimistic local value for the mouse-thief trigger so the select reacts
  // instantly; re-syncs whenever the polled config catches up.
  const [idleLocal, setIdleLocal] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  useEffect(() => {
    if (config?.mouseStealIdleMin !== undefined) setIdleLocal(config.mouseStealIdleMin);
  }, [config?.mouseStealIdleMin]);
  const idleValue = idleLocal ?? config?.mouseStealIdleMin ?? 3;
  const changeIdle = (m: number) => {
    setIdleLocal(m);
    void buddyPost<{ ok: boolean }>("config", { mouseStealIdleMin: m }).then((j) => {
      if (j?.ok) {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("appearance.title")}</h3>
      <div>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", marginBottom: 4 }}>{t("appearance.skin")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {(["dark", "light"] as const).map((s) => (
            <button
              key={s}
              onClick={() => void buddyPost("config", { skin: s })}
              style={{
                flex: 1,
                padding: "8px",
                borderRadius: 8,
                border: skin === s ? "1px solid var(--buddy-accent)" : "1px solid var(--buddy-panel-border)",
                background: skin === s ? "color-mix(in srgb, var(--buddy-accent) 14%, transparent)" : "var(--buddy-input-bg)",
                color: skin === s ? "var(--buddy-accent)" : "var(--buddy-panel-fg)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {t(`appearance.skin.${s}` as never)}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", marginTop: 6, lineHeight: 1.5 }}>
          {t("appearance.skin.hint")}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", marginBottom: 4 }}>{t("appearance.language")}</div>
        <select value={language} onChange={(e) => void buddyPost("config", { language: e.target.value })} style={selectStyle}>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>
      <div style={{ borderTop: "1px solid var(--buddy-panel-border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <ToggleRow
          label={`🐭 ${t("appearance.mouseSteal")}`}
          checked={config?.mouseStealEnabled ?? true}
          onChange={(v) => void buddyPost("config", { mouseStealEnabled: v })}
        />
        {(config?.mouseStealEnabled ?? true) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("appearance.mouseSteal.idle")}</span>
            <select
              value={String(idleValue)}
              onChange={(e) => changeIdle(Number(e.target.value))}
              style={{ ...selectStyle, width: 120 }}
            >
              {[1, 2, 3, 5, 10, 15].map((m) => (
                <option key={m} value={String(m)}>
                  {t("appearance.mouseSteal.minOpt", [m])}
                </option>
              ))}
            </select>
            {savedFlash && <span style={{ fontSize: 11, color: "var(--buddy-success)" }}>{t("common.saved")}</span>}
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>
          {t("appearance.mouseSteal.hint")}
          <br />
          {t("appearance.mouseSteal.liveNote")}
        </div>
      </div>
    </div>
  );
}

// ── Commands ───────────────────────────────────────────────────────────────

type QuickCommand = { id: string; label: string; command: string };

export function CommandsTab() {
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [name, setName] = useState("");
  const [cmd, setCmd] = useState("");

  const reload = () => buddyGet<{ ok: boolean; commands: QuickCommand[] }>("commands").then((j) => j?.ok && setCommands(j.commands));
  useEffect(() => {
    void reload();
  }, []);

  const add = async () => {
    if (!name.trim() || !cmd.trim()) return;
    const j = await buddyPost<{ ok: boolean; commands: QuickCommand[] }>("commands", {
      op: "upsert",
      command: { id: `c${Date.now()}`, label: name.trim(), command: cmd.trim() },
    });
    if (j?.ok) {
      setCommands(j.commands);
      setName("");
      setCmd("");
    }
  };

  const remove = async (id: string) => {
    const j = await buddyPost<{ ok: boolean; commands: QuickCommand[] }>("commands", { op: "remove", command: { id } });
    if (j?.ok) setCommands(j.commands);
  };

  const BUILTIN_IDS = new Set(["compact", "goal", "plan", "skill", "clear"]);
  const builtin = commands.filter((c) => BUILTIN_IDS.has(c.id));
  const custom = commands.filter((c) => !BUILTIN_IDS.has(c.id));

  const renderRow = (c: QuickCommand, removable: boolean) => (
    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: "var(--buddy-row-bg)", fontSize: 12 }}>
      <span style={{ minWidth: 70, fontWeight: 600 }}>{c.label}</span>
      <span style={{ flex: 1, color: "var(--buddy-panel-muted)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.command}</span>
      {removable && (
        <button onClick={() => remove(c.id)} style={{ background: "none", border: "none", color: "var(--buddy-panel-muted)", cursor: "pointer" }}>
          ✕
        </button>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("commands.title")}</h3>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "flex-end",
          padding: 10,
          borderRadius: 12,
          background: "var(--buddy-row-bg)",
          border: "1px solid var(--buddy-panel-border)",
          flexWrap: "wrap",
        }}
      >
        {field(t("commands.name"), name, setName, "label")}
        {field(t("commands.cmd"), cmd, setCmd, "/command")}
        <button
          onClick={add}
          style={{
            padding: "8px 18px",
            borderRadius: 8,
            border: "none",
            background: "var(--buddy-accent)",
            color: "var(--buddy-on-accent)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 2px 8px color-mix(in srgb, var(--buddy-accent) 40%, transparent)",
          }}
        >
          ＋ {t("commands.add")}
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>
        {t("commands.hint")}
      </div>
      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("commands.custom")}</h4>
        {custom.length === 0 && <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>—</div>}
        {custom.map((c) => renderRow(c, true))}
      </section>
      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("commands.builtin")}</h4>
        {builtin.map((c) => renderRow(c, false))}
      </section>
    </div>
  );
}

// ── Personality ────────────────────────────────────────────────────────────

/** Preset personalities. Display names follow the UI language via t(); the
 *  prompts themselves are sent to the model as-is (zh baseline). */
function getPresets(): { id: string; name: string; prompt: string }[] {
  return [
    { id: "default", name: t("persona.default"), prompt: "你是陪伴程序员工作的宠物鲸鱼，友好、简洁、鼓励。" },
    { id: "cheerleader", name: t("persona.cheerleader"), prompt: "你是元气满满的啦啦队鲸鱼，总是积极鼓励用户，语气活泼。" },
    { id: "calm", name: t("persona.calm"), prompt: "你是沉稳安静的鲸鱼，话语少而精，专注陪伴，不打扰。" },
    { id: "mentor", name: t("persona.mentor"), prompt: "你是技术导师鲸鱼，适时给出编程建议和提醒，理性务实。" },
    { id: "comedian", name: t("persona.comedian"), prompt: "你是幽默搞怪的鲸鱼，偶尔讲冷幽默，让编程更有趣。" },
    { id: "senpai", name: t("persona.senpai"), prompt: "你是温柔治愈的鲸鱼，像前辈一样体贴，安慰情绪。" },
  ];
}

export function PersonalityTab() {
  const { data } = useBuddySnapshot(1000);
  const p = data?.config?.personality;
  const [preset, setPreset] = useState(p?.preset ?? "default");
  const [custom, setCustom] = useState(p?.customPrompt ?? "");
  const [constraints, setConstraints] = useState((p?.constraints ?? []).join("\n"));
  // B2-4 tone dials — local state drives the slider; debounced posts persist.
  const [traits, setTraits] = useState(p?.traits ?? { sarcasm: 20, enthusiasm: 60, chattiness: 40, humor: 35, gentleness: 55 });
  const [saved, setSaved] = useState(false);
  const traitsRef = useRef(traits);
  traitsRef.current = traits;
  const traitSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (p) {
      setPreset(p.preset);
      setCustom(p.customPrompt);
      setConstraints((p.constraints ?? []).join("\n"));
      if (p.traits) setTraits(p.traits);
    }
  }, [p?.preset, p?.customPrompt]);

  const persist = async (personality: {
    preset: string;
    customPrompt: string;
    constraints: string[];
    traits: { sarcasm: number; enthusiasm: number; chattiness: number; humor: number; gentleness: number };
  }) => {
    await buddyPost("config", { personality });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  /** Slider drag → optimistic local update + one debounced config write. */
  const bumpTrait = (key: keyof typeof traits, value: number) => {
    setTraits((prev) => ({ ...prev, [key]: value }));
    if (traitSaveTimer.current) clearTimeout(traitSaveTimer.current);
    traitSaveTimer.current = setTimeout(() => {
      void persist({
        preset,
        customPrompt: custom,
        constraints: constraints.split("\n").map((s) => s.trim()).filter(Boolean),
        traits: traitsRef.current,
      });
    }, 350);
  };

  // Picking a preset applies immediately (真实作用：影响陪伴气泡与聊天人格).
  const pickPreset = async (id: string) => {
    setPreset(id);
    await persist({ preset: id, customPrompt: custom, constraints: constraints.split("\n").map((s) => s.trim()).filter(Boolean), traits: traitsRef.current });
  };

  const save = async () => {
    await persist({ preset, customPrompt: custom.trim(), constraints: constraints.split("\n").map((s) => s.trim()).filter(Boolean), traits });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("personality.title")}</h3>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>
        {t("personality.effect")}
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", marginBottom: 4 }}>{t("personality.preset")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {getPresets().map((pr) => (
            <button
              key={pr.id}
              onClick={() => void pickPreset(pr.id)}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: preset === pr.id ? "1px solid var(--buddy-accent)" : "1px solid var(--buddy-panel-border)",
                background: preset === pr.id ? "color-mix(in srgb, var(--buddy-accent) 14%, transparent)" : "var(--buddy-input-bg)",
                color: preset === pr.id ? "var(--buddy-accent)" : "var(--buddy-panel-fg)",
                fontSize: 12,
                cursor: "pointer",
              }}
              title={pr.prompt}
            >
              {pr.name}
            </button>
          ))}
        </div>
      </div>
      {field(t("personality.custom"), custom, setCustom, t("personality.custom"))}
      {/* B2-4 five tone dials — mixed into the persona prompt server-side. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("personality.traits")}</div>
        {(
          [
            ["sarcasm", "personality.trait.sarcasm"],
            ["enthusiasm", "personality.trait.enthusiasm"],
            ["chattiness", "personality.trait.chattiness"],
            ["humor", "personality.trait.humor"],
            ["gentleness", "personality.trait.gentleness"],
          ] as const
        ).map(([key, labelKey]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, width: 56, flex: "none", color: "var(--buddy-panel-muted)" }}>{t(labelKey)}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={traits[key]}
              onChange={(e) => bumpTrait(key, Number(e.target.value))}
              style={{ flex: 1, accentColor: "var(--buddy-accent)" }}
            />
            <span style={{ fontSize: 11, minWidth: 26, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--buddy-panel-muted)" }}>{traits[key]}</span>
          </div>
        ))}
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>{t("personality.traits.hint")}</div>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
        <span style={{ color: "var(--buddy-panel-muted)" }}>{t("personality.constraints")}</span>
        <textarea
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={save} style={accentBtn}>
          {t("personality.save")}
        </button>
        {saved && <span style={{ fontSize: 12, color: "var(--buddy-accent)" }}>✓ {t("model.saved")}</span>}
      </div>
      {/* Proactive-care switches live in the 🐳 JingLing tab only — they used to
          be duplicated here and in that tab, controlling the same config keys. */}
    </div>
  );
}

// ── Shop (B2-2 coin economy) ───────────────────────────────────────────────

type ShopItem = {
  id: string;
  icon: string;
  name: { zh: string; en: string };
  desc: { zh: string; en: string };
  price: number;
  kind: "consumable" | "accessory";
};

type EconPayload = {
  ok: boolean;
  economy: {
    coins: number;
    earnedTotal: number;
    spentTotal: number;
    snacks: number;
    toys: number;
    accessories: string[];
    equipped: string | null;
  };
  shop: ShopItem[];
};

/** Coin wallet + tiny cosmetic shop. Earning happens through real work
 *  (completed turns / orders / pomodoros / level-ups / badges). */
export function ShopTab() {
  const { data } = useBuddySnapshot(2000);
  const [catalog, setCatalog] = useState<EconPayload | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    void buddyGet<EconPayload>("economy").then((j) => {
      if (j?.ok) setCatalog(j);
    });
  };
  useEffect(load, []);

  const econ = catalog?.economy;
  const coins = econ?.coins ?? data?.economy?.coins ?? 0;

  const act = async (op: string, id?: string) => {
    const j = await buddyPost<{ ok: boolean; error?: string }>("economy", { op, id });
    if (j?.ok) {
      setMsg(null);
      load();
      return true;
    }
    flash(j?.error === "not enough coins" ? t("shop.poor") : t("shop.fail"));
    return false;
  };

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2200);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>🪙 {t("shop.title")}</h3>
        <span style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "var(--buddy-accent)" }}>
          {coins}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>
        {t("shop.hint")}
      </div>

      {/* owned consumables — use them here */}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => void act("use", "snack")} disabled={(econ?.snacks ?? 0) <= 0} style={accentBtn}>
          🍪 ×{econ?.snacks ?? data?.economy?.snacks ?? 0} · {t("shop.use")}
        </button>
        <button onClick={() => void act("use", "toy")} disabled={(econ?.toys ?? 0) <= 0} style={accentBtn}>
          🧸 ×{econ?.toys ?? data?.economy?.toys ?? 0} · {t("shop.use")}
        </button>
      </div>
      {(econ?.snacks ?? 0) > 0 || (econ?.toys ?? 0) > 0 ? null : (
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>{t("shop.empty")}</div>
      )}

      {/* catalog */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
        {(catalog?.shop ?? []).map((item) => {
          const lang = currentLang();
          const name = lang === "en" ? item.name.en : item.name.zh;
          const desc = lang === "en" ? item.desc.en : item.desc.zh;
          const owned = item.kind === "accessory" && (econ?.accessories ?? []).includes(item.id);
          const equipped = econ?.equipped === item.id;
          const afford = coins >= item.price;
          return (
            <div
              key={item.id}
              title={desc}
              style={{
                padding: "10px",
                borderRadius: 12,
                border: equipped ? "1px solid var(--buddy-accent)" : "1px solid var(--buddy-panel-border)",
                background: "var(--buddy-row-bg)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontSize: 20 }}>{item.icon}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{name}</span>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--buddy-panel-muted)", lineHeight: 1.45, minHeight: 30 }}>{desc}</div>
              {owned ? (
                <button
                  onClick={() => void act("equip", equipped ? "none" : item.id)}
                  style={{
                    ...accentBtn,
                    background: equipped ? "var(--buddy-input-bg)" : accentBtn.background,
                    color: equipped ? "var(--buddy-panel-fg)" : accentBtn.color,
                  }}
                >
                  {equipped ? t("shop.unequip") : t("shop.equip")}
                </button>
              ) : (
                <button
                  onClick={() => void act("buy", item.id)}
                  disabled={!afford}
                  style={{ ...accentBtn, opacity: afford ? 1 : 0.5 }}
                  title={afford ? undefined : t("shop.poor")}
                >
                  {t("shop.buy")} · {item.price}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!catalog && <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("common.loading")}</div>}
      {msg && <span style={{ fontSize: 11, color: "var(--buddy-danger)" }}>{msg}</span>}
    </div>
  );
}

/** 连续工作提醒阈值：乐观更新 + 已保存反馈 + 实时显示今日连续活跃分钟，
 *  让"阈值改了到底有没有用"一眼可见。 */
function RestThresholdRow({ data }: { data: { config?: { restReminderThresholdMin?: number }; summary?: { todayActiveMs?: number } } | null }) {
  const [local, setLocal] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const cfgValue = data?.config?.restReminderThresholdMin;
  useEffect(() => {
    if (cfgValue !== undefined) setLocal(cfgValue);
  }, [cfgValue]);
  const value = local ?? cfgValue ?? 120;
  const activeMin = Math.round((data?.summary?.todayActiveMs ?? 0) / 60000);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("personality.care.rest")}</span>
        <select
          value={String(value)}
          onChange={(e) => {
            const m = Number(e.target.value);
            setLocal(m);
            void buddyPost<{ ok: boolean }>("config", { restReminderThresholdMin: m }).then((j) => {
              if (j?.ok) {
                setSavedFlash(true);
                setTimeout(() => setSavedFlash(false), 1500);
              }
            });
          }}
          style={{ ...inputStyle, width: 140 }}
        >
          {[30, 45, 60, 90, 120, 180].map((m) => (
            <option key={m} value={String(m)}>
              {m >= 60 ? t("common.hoursOpt", [m / 60]) : t("common.minOpt", [m])}
            </option>
          ))}
        </select>
        {savedFlash && <span style={{ fontSize: 11, color: "var(--buddy-success)" }}>{t("common.saved")}</span>}
      </div>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>
        {t("care.activeToday", [activeMin])}
        {activeMin >= value ? t("care.thresholdReached") : t("care.thresholdPending", [value])}
      </div>
    </div>
  );
}

// ── Model ──────────────────────────────────────────────────────────────────

export function ModelTab() {
  const { data } = useBuddySnapshot(1000);
  const chat = data?.config?.chat;
  const [form, setForm] = useState<{ provider: "off" | "ollama" | "openai" | "gemini"; baseUrl: string; apiKey: string; model: string; disableThinking: boolean }>({ provider: "off", baseUrl: "", apiKey: "", model: "", disableThinking: true });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (chat) {
      setForm((current) => ({
        provider: chat.provider,
        baseUrl: chat.baseUrl,
        // The snapshot intentionally redacts secrets. Preserve anything the
        // user has typed locally while the polling response refreshes.
        apiKey: current.apiKey,
        model: chat.model,
        disableThinking: chat.disableThinking !== false,
      }));
    }
  }, [chat?.provider, chat?.baseUrl, chat?.apiKey, chat?.model, chat?.disableThinking]);

  const save = async () => {
    await buddyPost("config", { chat: form });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("model.title")}</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
        <span style={{ color: "var(--buddy-panel-muted)" }}>{t("model.provider")}</span>
        <select
          value={form.provider}
          onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value as typeof form.provider }))}
          style={selectStyle}
        >
          <option value="off">{t("model.provider.off")}</option>
          <option value="ollama">{t("model.provider.ollama")}</option>
          <option value="openai">{t("model.provider.openai")}</option>
          <option value="gemini">{t("model.provider.gemini")}</option>
        </select>
      </label>
      {form.provider !== "off" && (
        <>
          {field(t("model.baseUrl"), form.baseUrl, (v) => setForm((f) => ({ ...f, baseUrl: v })), "http://127.0.0.1:11434")}
          {field(t("model.apiKey"), form.apiKey, (v) => setForm((f) => ({ ...f, apiKey: v })), chat?.hasApiKey ? "••••••••" : "sk-...", "password")}
          {field(t("model.model"), form.model, (v) => setForm((f) => ({ ...f, model: v })), "llama3.2")}
        </>
      )}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={form.disableThinking}
          onChange={(e) => setForm((f) => ({ ...f, disableThinking: e.target.checked }))}
          style={{ marginTop: 2, accentColor: "var(--buddy-accent)" }}
        />
        <span>
          {t("model.thinking")}
          <span style={{ display: "block", fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5, marginTop: 2 }}>
            {t("model.thinkingHint")}
          </span>
        </span>
      </label>
      <button onClick={save} style={accentBtn}>
        {saved ? t("model.saved") : t("model.save")}
      </button>
    </div>
  );
}

// ── Pomodoro ───────────────────────────────────────────────────────────────

export function PomodoroTab({ close }: { close?: () => void }) {
  const { data } = useBuddySnapshot(1000);
  const cfg = data?.config?.pomodoro;
  const [work, setWork] = useState("25");
  const [brk, setBrk] = useState("5");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (cfg) {
      setWork(String(cfg.workMin));
      setBrk(String(cfg.breakMin));
    }
  }, [cfg?.workMin, cfg?.breakMin]);

  const save = async () => {
    await buddyPost("config", { pomodoro: { workMin: Number(work) || 25, breakMin: Number(brk) || 5 } });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("pomodoro.title")}</h3>
      <div style={{ display: "flex", gap: 8 }}>
        {field(t("pomodoro.work"), work, setWork, "25")}
        {field(t("pomodoro.break"), brk, setBrk, "5")}
      </div>
      <button onClick={save} style={accentBtn}>
        {saved ? t("model.saved") : t("pomodoro.save")}
      </button>
      <div style={{ borderTop: "1px solid var(--buddy-panel-border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("pomo.launchTitle")}</div>
        <button
          onClick={() => {
            openFloaterPanel("pomodoro");
            close?.();
          }}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "none",
            background: "var(--buddy-accent)",
            color: "var(--buddy-on-accent)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("pomo.launchBtn")}
        </button>
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>
          {t("pomo.launchHint")}
        </div>
      </div>
    </div>
  );
}

// ── Chat / Calendar / Notes (embedded, fully usable in settings) ───────────

export function ChatTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("chat.title")}</h3>
      <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("chat.desc")}</div>
      <ChatBody maxListHeight={380} />
    </div>
  );
}

export function CalendarTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("calendar.title")}</h3>
      <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("calendar.desc")}</div>
      <CalendarBody />
    </div>
  );
}

export function NotesTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("nav.notes")}</h3>
      <TodoListBody />
    </div>
  );
}

// ── Market ─────────────────────────────────────────────────────────────────

type MarketPet = {
  slug: string;
  displayName: string;
  description?: string;
  spritesheetUrl?: string;
  petJsonUrl?: string;
};

const MARKET_MANIFEST = "https://petdex.dev/api/manifest";

// Spritesheet grid: display ONE frame (the pet's idle) scaled to the preview
// box. backgroundSize must scale the WHOLE grid (cols×boxW × rows×boxH), and
// position 0 0 picks the top-left frame — a plain "boxW boxH" would squash the
// whole grid instead (that's why previews looked blank).
const GRID_COLS = Math.max(...Object.values(GRID.anims).map((a) => a.frames));
const GRID_ROWS = Object.keys(GRID.anims).length;
const PREVIEW_W = 48;
const PREVIEW_H = 52;

/** Fetch the petdex.dev catalog via the host proxy (reliable); direct fetch fallback. */
async function fetchMarketPets(): Promise<MarketPet[] | null> {
  const j = await buddyGet<{ ok: boolean; pets: MarketPet[] }>("market");
  if (j?.ok && Array.isArray(j.pets)) return j.pets;
  try {
    const res = await fetch(MARKET_MANIFEST, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const data = (await res.json()) as { pets?: MarketPet[] };
      if (Array.isArray(data.pets)) return data.pets;
    }
  } catch {
    // direct fetch blocked (CORS) — leave the error state to the caller
  }
  return null;
}

export function MarketTab() {
  const [pets, setPets] = useState<MarketPet[]>([]);
  const [local, setLocal] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // B2-3 adoption reveal: set right after a successful install.
  const [reveal, setReveal] = useState<{ slug: string; name: string; sprite?: string } | null>(null);

  const refreshLocal = () => {
    void buddyGet<{ ok: boolean; pets: { slug: string }[]; active?: string | null }>("pets").then((j) => {
      if (j?.ok) {
        setLocal(new Set(j.pets.map((p) => p.slug)));
        setActive(j.active ?? null);
      }
    });
  };

  useEffect(() => {
    void fetchMarketPets().then((list) => {
      if (list) setPets(list);
      else setError(true);
    });
    refreshLocal();
  }, []);

  // Client-side search over the loaded petdex.dev collection.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? pets.filter((p) => (p.displayName ?? "").toLowerCase().includes(q) || (p.slug ?? "").toLowerCase().includes(q))
    : pets;

  const install = async (slug: string) => {
    setBusy(slug);
    setFailed(null);
    // Install, then auto-activate so the floater switches to the new pet.
    const j = await buddyPost<{ ok: boolean }>("market/install", { slug });
    if (j?.ok) {
      await buddyPost("activate", { slug });
      refreshLocal();
      const pet = pets.find((p) => p.slug === slug);
      setReveal({ slug, name: pet?.displayName ?? slug, sprite: pet?.spritesheetUrl }); // B2-3
    } else {
      // Visible failure feedback (previously a silent busy-clear).
      setFailed(slug);
      setTimeout(() => setFailed((f) => (f === slug ? null : f)), 2500);
    }
    setBusy(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("market.title")}</h3>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>{t("market.desc")}</div>
      <a
        href="https://petdex.dev/collections"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: 12,
          color: "var(--buddy-accent)",
          textDecoration: "none",
          cursor: "pointer",
        }}
      >
        {t("market.collections")} ↗
      </a>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("market.searchPlaceholder")}
        style={{
          padding: "7px 10px",
          borderRadius: 8,
          border: "1px solid var(--buddy-panel-border)",
          background: "var(--buddy-input-bg)",
          color: "var(--buddy-panel-fg)",
          fontSize: 12,
          outline: "none",
        }}
      />
      {error ? (
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("market.error")}</div>
      ) : pets.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("market.loading")}</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>
            {q ? t("market.found", [filtered.length]) : t("market.count", [pets.length])}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 8 }}>
            {filtered.slice(0, q ? 60 : 48).map((p) => {
              const installed = local.has(p.slug);
              const isActive = active === p.slug;
              // B2-3: rarity is deterministic per slug — shown as a chip.
              const r = rarityFor(p.slug);
              const shiny = isShiny(p.slug);
              return (
                <div
                  key={p.slug}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    padding: 8,
                    borderRadius: 10,
                    background: "var(--buddy-row-bg)",
                    border: isActive ? "1px solid var(--buddy-accent)" : "1px solid transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div
                      style={{
                        width: PREVIEW_W,
                        height: PREVIEW_H,
                        flex: "none",
                        borderRadius: 8,
                        overflow: "hidden",
                        border: "1px solid var(--buddy-panel-border)",
                        background: "var(--buddy-input-bg)",
                        backgroundImage: p.spritesheetUrl
                          ? `url(/api/dshbuddy/market/sprite?url=${encodeURIComponent(p.spritesheetUrl)})`
                          : undefined,
                        backgroundRepeat: "no-repeat",
                        backgroundSize: `${GRID_COLS * PREVIEW_W}px ${GRID_ROWS * PREVIEW_H}px`,
                        backgroundPosition: "0 0",
                        imageRendering: "pixelated",
                        transition: "transform 120ms",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.transform = "scale(1.08)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.transform = "scale(1)";
                      }}
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.displayName}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span
                          style={{
                            flex: "none",
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: RARITY_META[r].color,
                            boxShadow: `0 0 0 2px color-mix(in srgb, ${RARITY_META[r].color} 30%, transparent)`,
                          }}
                          title={currentLang() === "en" ? RARITY_META[r].en : RARITY_META[r].zh}
                        />
                        {shiny && <span title={t("market.shiny")}>✨</span>}
                        <span style={{ fontSize: 10, color: "var(--buddy-panel-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.slug}
                        </span>
                      </div>
                    </div>
                  </div>
                {installed ? (
                  <div style={{ fontSize: 11, color: isActive ? "var(--buddy-accent)" : "var(--buddy-panel-muted)" }}>
                    {isActive ? `✓ ${t("market.current")}` : t("market.installed")}
                  </div>
                ) : (
                  <button
                    onClick={() => install(p.slug)}
                    disabled={busy === p.slug}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "none",
                      background: failed === p.slug ? "var(--buddy-danger)" : "var(--buddy-accent)",
                      color: "var(--buddy-on-accent)",
                      fontSize: 11,
                      cursor: busy === p.slug ? "wait" : "pointer",
                    }}
                  >
                    {busy === p.slug ? "…" : failed === p.slug ? t("market.failed") : t("market.install")}
                  </button>
                )}
              </div>
            );
          })}
          </div>
        </>
      )}

      {/* B2-3 adoption reveal overlay — click anywhere to dismiss. */}
      {reveal && (
        <div
          onClick={() => setReveal(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2147483600,
            background: "rgba(2, 6, 23, 0.74)",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
          }}
        >
          <RevealCard slug={reveal.slug} name={reveal.name} spritesheetUrl={reveal.sprite} onClose={() => setReveal(null)} />
        </div>
      )}
    </div>
  );
}

/** B2-3 reveal card: rarity-colored pop-in + shine sweep over the new pet. */
function RevealCard({ slug, name, spritesheetUrl, onClose }: { slug: string; name: string; spritesheetUrl?: string; onClose: () => void }) {
  const lang = currentLang();
  const r = rarityFor(slug);
  const shiny = isShiny(slug);
  const meta = RARITY_META[r];
  return (
    <div
      className="dshb-reveal"
      onClick={(e) => e.stopPropagation()}
      style={{
        padding: "26px 34px",
        borderRadius: 18,
        background: `linear-gradient(160deg, color-mix(in srgb, ${meta.color} 22%, var(--buddy-panel-bg)), var(--buddy-panel-bg))`,
        border: `1px solid ${meta.color}`,
        boxShadow: `0 18px 60px rgba(0,0,0,0.5), 0 0 42px color-mix(in srgb, ${meta.color} 40%, transparent)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        minWidth: 230,
        textAlign: "center",
      }}
    >
      <div
        className={shiny ? "dshb-shiny" : undefined}
        style={{
          width: PREVIEW_W * 2,
          height: PREVIEW_H * 2,
          borderRadius: 12,
          overflow: "hidden",
          border: `1px solid color-mix(in srgb, ${meta.color} 60%, transparent)`,
          backgroundImage: spritesheetUrl
            ? `url(/api/dshbuddy/market/sprite?url=${encodeURIComponent(spritesheetUrl)})`
            : undefined,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${GRID_COLS * PREVIEW_W * 2}px ${GRID_ROWS * PREVIEW_H * 2}px`,
          backgroundPosition: "0 0",
          imageRendering: "pixelated",
        }}
      />
      <div style={{ fontSize: 16, fontWeight: 800 }}>{name}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>
        {lang === "en" ? meta.en : meta.zh}
        {shiny ? ` · ✨ ${t("market.shiny")}` : ""}
      </div>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>{t("market.reveal.hint")}</div>
      <button onClick={onClose} style={{ ...accentBtn, marginTop: 4 }}>
        {t("market.reveal.close")}
      </button>
    </div>
  );
}

// ── About ──────────────────────────────────────────────────────────────────

export function AboutTab() {
  const { data } = useBuddySnapshot(2000);
  const row = (label: string, value: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
      <span style={{ color: "var(--buddy-panel-muted)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("about.title")}</h3>
      {/* Version is inlined at build time from package.json (single source). */}
      {row(t("about.version"), __DSHBUDDY_VERSION__)}
      {row(t("about.engine"), t("about.engine.desc"))}
      {row(t("about.pet"), data?.pet?.displayName ?? "—")}
      {row(t("about.mode"), data?.config?.floaterMode === "walker" ? t("pet.mode.walker") : t("pet.mode.corner"))}
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5, borderTop: "1px solid var(--buddy-panel-border)", paddingTop: 8 }}>
        DSHBuddy — DeepSeek Harness companion pet plugin. Data stays local (~/.petdex).
      </div>
    </div>
  );
}
