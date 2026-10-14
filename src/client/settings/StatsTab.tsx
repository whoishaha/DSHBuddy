/**
 * StatsTab — the upgraded statistics dashboard (design §A–F).
 *
 * Beyond raw counts it visualizes:
 *   Today/Efficiency — today overview + error/success/completion rates, MTTR,
 *                      tool-chain length
 *   Rhythm      — 24h×7 activity heatmap + chronotype + peak hours
 *   Tool flow   — tool-transition graph + work-loop distribution
 *   Insight     — LLM compares this week vs last: changes, anomalies, advice
 *   Records     — per-day bests + streaks
 *
 * Data comes from the host half's /api/dshbuddy/stats/analytics endpoint.
 */

import { useEffect, useState } from "react";
import { buddyGet, buddyPost } from "../useBuddyState.js";
import { t } from "../i18n.js";

type DayRow = {
  date: string;
  turns: number;
  steps: number;
  toolCalls: number;
  errors: number;
  approvals: number;
  questions: number;
  activeMs: number;
  completedTurns?: number;
  abortedTurns?: number;
  failedTurns?: number;
  turnsWithTools?: number;
  recoveryMs?: number;
  recoveryCount?: number;
};

type Analytics = {
  ok: boolean;
  analytics: {
    efficiency: {
      errorRate: number;
      errorRatePct: number;
      successRate: number;
      successRatePct: number;
      completionRate: number;
      completionRatePct: number;
      mtbrMs: number | null;
      avgToolChain: number;
    };
    chronotype: { peakHour: number; earliestHour: number | null; latestHour: number | null; label: string; morningWeight: number; nightWeight: number };
    rhythm: { weekdayHour: number[][]; hourActivity: number[]; activeDays: number };
    transitions: { path: string; count: number }[];
    loops: Record<string, number>;
    pomodoro?: { todayMin: number; totalMin: number; week: { date: string; min: number }[] };
    records: {
      maxTurns: { date: string; value: number } | null;
      maxTools: { date: string; value: number } | null;
      maxActive: { date: string; value: number } | null;
      maxIntensity: { date: string; value: number } | null;
      maxRecovered: { date: string; value: number } | null;
      bestStreak: number;
      totalActiveDays: number;
      totalToolCalls: number;
    };
    weekDays: DayRow[];
  };
};

import {
  LOOP_COLORS,
  loopLabel,
} from "../growthLabels.js";
import { chronoLabel } from "./chronoLabels.js";

type SectionKey = "today" | "efficiency" | "rhythm" | "flow" | "insight" | "records";

export function StatsTab({ embedded = false }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<Analytics | null>(null);
  const [section, setSection] = useState<SectionKey>("today");
  const [insight, setInsight] = useState<{ insight: string; source: string } | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void buddyGet<Analytics>("stats/analytics").then((j) => {
        if (alive && j?.ok) setData(j);
      });
    };
    load();
    const iv = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const generateInsight = async () => {
    setBusy(true);
    setInsightError(null);
    const j = await buddyPost<{ ok: boolean; insight: string; source: string }>("stats/insight", {});
    setBusy(false);
    if (j?.ok) setInsight({ insight: j.insight, source: j.source });
    else setInsightError(t("stats.error.generate"));
  };

  const sections: { key: SectionKey; label: string }[] = [
    { key: "today", label: t("stats.tab.today") },
    { key: "efficiency", label: t("stats.tab.efficiency") },
    { key: "rhythm", label: t("stats.tab.rhythm") },
    { key: "flow", label: t("stats.tab.flow") },
    { key: "insight", label: t("stats.tab.insight") },
    { key: "records", label: t("stats.tab.records") },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      {!embedded && <h3 style={{ margin: 0, fontSize: 15 }}>{t("stats.title")}</h3>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSection(s.key)}
            aria-pressed={section === s.key}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: section === s.key ? "1px solid var(--buddy-accent)" : "1px solid var(--buddy-panel-border)",
              background: section === s.key ? "color-mix(in srgb, var(--buddy-accent) 14%, transparent)" : "var(--buddy-input-bg)",
              color: section === s.key ? "var(--buddy-accent)" : "var(--buddy-panel-fg)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {!data ? (
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("common.loading")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {section === "today" && <TodaySection data={data} />}
          {section === "efficiency" && <EfficiencySection data={data} />}
          {section === "rhythm" && <RhythmSection data={data} />}
          {section === "flow" && <FlowSection data={data} />}
          {section === "insight" && (
            <InsightSection insight={insight} busy={busy} error={insightError} onGenerate={() => void generateInsight()} />
          )}
          {section === "records" && <RecordsSection data={data} />}
        </div>
      )}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

function sumOf(days: DayRow[], key: keyof DayRow): number {
  return days.reduce((s, d) => s + (Number(d[key]) || 0), 0);
}

function efficiencyOf(days: DayRow[]) {
  const turns = sumOf(days, "turns");
  const completed = sumOf(days, "completedTurns");
  const tools = sumOf(days, "toolCalls");
  const errors = sumOf(days, "errors");
  const turnsWithTools = sumOf(days, "turnsWithTools");
  const recoveryMs = sumOf(days, "recoveryMs");
  const recoveryCount = sumOf(days, "recoveryCount");
  return {
    errorRate: tools > 0 ? errors / tools : 0,
    successRate: tools > 0 ? (tools - errors) / tools : 1,
    completionRate: turns > 0 ? completed / turns : 0,
    mtbrMs: recoveryCount > 0 ? recoveryMs / recoveryCount : null,
    avgToolChain: turnsWithTools > 0 ? tools / turnsWithTools : 0,
  };
}

function Row(label: string, value: string, accent?: string) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderRadius: 8, background: "var(--buddy-row-bg)", fontSize: 12 }}>
      <span style={{ color: "var(--buddy-panel-muted)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: accent }}>{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h4 style={{ margin: 0, fontSize: 13 }}>{title}</h4>
      {children}
    </section>
  );
}

// ── today ───────────────────────────────────────────────────────────────────

function TodaySection({ data }: { data: Analytics }) {
  const a = data.analytics;
  const today = a.weekDays.find((d) => d.date === todayStr());
  const eff = efficiencyOf(a.weekDays.slice(-7));

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        <MetricChip label={t("stats.today.turns")} value={String(today?.turns ?? 0)} color="var(--buddy-accent)" />
        <MetricChip label={t("stats.today.tools")} value={String(today?.toolCalls ?? 0)} color="var(--buddy-accent)" />
        <MetricChip label={t("stats.today.errors")} value={String(today?.errors ?? 0)} color={today?.errors ? "var(--buddy-danger)" : "var(--buddy-success)"} />
        <MetricChip label={t("stats.today.active")} value={fmtDuration(today?.activeMs ?? 0)} color="var(--buddy-accent-2)" />
      </div>
      {a.pomodoro && (
        <Card title={t("stats.pomodoro.title")}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: "var(--buddy-accent)" }}>{a.pomodoro.todayMin}</span>
            <span style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>
              {t("stats.pomodoro.summary", [a.pomodoro.todayMin, Math.round((a.pomodoro.totalMin / 60) * 10) / 10])}
            </span>
          </div>
          {a.pomodoro.week.length > 0 && (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 40, marginTop: 8 }}>
              {a.pomodoro.week.map((d) => {
                const max = Math.max(1, ...a.pomodoro!.week.map((w) => w.min));
                return (
                  <div
                    key={d.date}
                    title={t("stats.pomodoro.day", [d.date, d.min])}
                    style={{
                      flex: 1,
                      height: `${Math.max(4, (d.min / max) * 100)}%`,
                      minHeight: 3,
                      borderRadius: "3px 3px 0 0",
                      background: d.date === todayStr() ? "var(--buddy-accent)" : "color-mix(in srgb, var(--buddy-accent) 35%, transparent)",
                    }}
                  />
                );
              })}
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", marginTop: 4 }}>{t("stats.pomodoro.hint")}</div>
        </Card>
      )}
      <Card title={t("stats.today.weekEff")}>
        {Row(t("stats.eff.success"), pct(eff.successRate))}
        {Row(t("stats.eff.errorRate"), pct(eff.errorRate), eff.errorRate > 0.2 ? "var(--buddy-danger)" : undefined)}
        {Row(t("stats.eff.completion"), pct(eff.completionRate))}
        {Row(t("stats.eff.toolChain"), String(Math.round(eff.avgToolChain * 10) / 10))}
      </Card>
    </>
  );
}

function MetricChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: "10px 8px", borderRadius: 10, background: "var(--buddy-row-bg)", textAlign: "center", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 10, color: "var(--buddy-panel-muted)" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

// ── efficiency ──────────────────────────────────────────────────────────────

function EfficiencySection({ data }: { data: Analytics }) {
  const a = data.analytics;
  const life = a.efficiency; // lifetime
  const week = efficiencyOf(a.weekDays.slice(-7));
  const bar = (v: number, color: string) => (
    <div style={{ height: 8, borderRadius: 999, background: "var(--buddy-input-bg)", overflow: "hidden", flex: 1 }}>
      <div style={{ height: "100%", background: color, width: `${Math.round(v * 100)}%` }} />
    </div>
  );
  const metric = (label: string, weekV: number, lifeV: number, color: string, suffix = "%") => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: "var(--buddy-panel-muted)" }}>{label}</span>
        <span style={{ fontWeight: 600 }}>
          {t("stats.eff.weekVsLife", [suffix === "%" ? pct(weekV) : weekV.toFixed(1), suffix === "%" ? pct(lifeV) : lifeV.toFixed(1)])}
        </span>
      </div>
      {bar(weekV, color)}
    </div>
  );

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {metric(t("stats.eff.success"), week.successRate, life.successRate, "var(--buddy-success)")}
        {metric(t("stats.eff.completion"), week.completionRate, life.completionRate, "var(--buddy-accent)")}
        {metric(t("stats.eff.errorRate"), week.errorRate, life.errorRate, "var(--buddy-danger)")}
      </div>
      <Card title={t("stats.quality.title")}>
        {Row(t("stats.quality.mtbr"), life.mtbrMs === null ? t("stats.quality.noErrors") : fmtMs(life.mtbrMs))}
        {Row(t("stats.quality.chainLen"), String(life.avgToolChain), life.avgToolChain > 5 ? "var(--buddy-warning)" : undefined)}
        {Row(t("stats.quality.weekErrors"), String(sumOf(a.weekDays.slice(-7), "errors")))}
        {Row(t("stats.quality.weekAborted"), String(sumOf(a.weekDays.slice(-7), "abortedTurns")))}
      </Card>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>
        {t("stats.quality.hint")}
      </div>
    </>
  );
}

// ── rhythm ──────────────────────────────────────────────────────────────────

function RhythmSection({ data }: { data: Analytics }) {
  const a = data.analytics;
  const chrono = a.chronotype;
  const grid = a.rhythm.weekdayHour;
  const max = Math.max(1, ...grid.flat(), ...a.rhythm.hourActivity);
  // weekdays ordered Mon..Sun (JS getDay: 0=Sun..6=Sat)
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = [
    t("wd.mon"),
    t("wd.tue"),
    t("wd.wed"),
    t("wd.thu"),
    t("wd.fri"),
    t("wd.sat"),
    t("wd.sun"),
  ];

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <MetricChip label={t("stats.rhythm.type")} value={chronoLabel(chrono.label)} color="var(--buddy-accent)" />
        <MetricChip label={t("stats.rhythm.peak")} value={t("stats.rhythm.peakVal", [chrono.peakHour])} color="var(--buddy-accent-2)" />
        <MetricChip label={t("stats.rhythm.days")} value={String(a.rhythm.activeDays)} color="var(--buddy-success)" />
      </div>
      {chrono.earliestHour !== null && (
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>
          {t("stats.rhythm.range", [chrono.earliestHour, chrono.earliestHour === chrono.latestHour ? chrono.earliestHour : (chrono.latestHour ?? chrono.earliestHour)])}
        </div>
      )}

      <Card title={t("stats.rhythm.heatmap")}>
        <div style={{ display: "flex", gap: 2, fontSize: 9, color: "var(--buddy-panel-muted)" }}>
          <div style={{ width: 28, flex: "none" }} />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} style={{ flex: 1, textAlign: "center", minWidth: 6 }}>{h % 3 === 0 ? h : ""}</div>
          ))}
        </div>
        {order.map((wd, i) => (
          <div key={wd} style={{ display: "flex", gap: 2, alignItems: "center" }}>
            <div style={{ width: 28, flex: "none", fontSize: 9, color: "var(--buddy-panel-muted)" }}>{names[i]}</div>
            {grid[wd]?.map((v, h) => (
              <div
                key={h}
                title={t("stats.cellTitle", [names[i], h, v])}
                style={{
                  flex: 1,
                  minWidth: 6,
                  height: 14,
                  borderRadius: 2,
                  // Blue ramp independent of the accent token, so the heatmap
                  // always reads as "heat" on both skins.
                  background:
                    v > 0
                      ? `rgba(37, 99, 235, ${Math.min(0.92, Math.max(0.16, (v / max) * 0.9)).toFixed(2)})`
                      : "var(--buddy-row-bg)",
                }}
              />
            ))}
          </div>
        ))}
        <div style={{ fontSize: 10, color: "var(--buddy-panel-muted)" }}>{t("stats.rhythm.legend")}</div>
      </Card>
    </>
  );
}

// ── flow ────────────────────────────────────────────────────────────────────

function FlowSection({ data }: { data: Analytics }) {
  const a = data.analytics;
  const loops = Object.entries(a.loops).sort((x, y) => y[1] - x[1]);
  const totalLoops = loops.reduce((s, [, v]) => s + v, 0);

  return (
    <>
      <Card title={t("stats.flow.loops")}>
        {loops.length === 0 && <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("stats.flow.noLoops")}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {loops.map(([k, v]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span style={{ width: 40, color: "var(--buddy-panel-muted)" }}>{loopLabel(k)}</span>
              <div style={{ flex: 1, height: 10, borderRadius: 999, background: "var(--buddy-input-bg)", overflow: "hidden" }}>
                <div style={{ height: "100%", background: LOOP_COLORS[k] ?? "#64748b", width: `${totalLoops ? (v / totalLoops) * 100 : 0}%` }} />
              </div>
              <span style={{ width: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{v}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t("stats.flow.transitions")}>
        {a.transitions.length === 0 && <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("stats.flow.noTransitions")}</div>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {a.transitions.map((tr) => {
            const [from, to] = tr.path.split(">");
            return (
              <div key={tr.path} style={{ padding: "5px 10px", borderRadius: 8, background: "var(--buddy-row-bg)", fontSize: 11, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--buddy-panel-fg)" }}>{from}</span>
                <span style={{ color: "var(--buddy-panel-muted)" }}>→</span>
                <span style={{ color: "var(--buddy-accent)" }}>{to}</span>
                <span style={{ color: "var(--buddy-panel-muted)" }}>×{tr.count}</span>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

// ── insight ─────────────────────────────────────────────────────────────────

function InsightSection({ insight, busy, error, onGenerate }: { insight: { insight: string; source: string } | null; busy: boolean; error: string | null; onGenerate: () => void }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={onGenerate} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "var(--buddy-accent)", color: "var(--buddy-on-accent)", fontSize: 12, fontWeight: 600, cursor: busy ? "wait" : "pointer" }}>
          {busy ? t("stats.insight.busy") : t("stats.insight.button")}
        </button>
        {insight && <span style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>{insight.source === "llm" ? t("stats.insight.llm") : t("stats.insight.rule")}</span>}
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--buddy-danger)" }}>{error}</div>}
      {insight && (
        <div style={{ padding: "12px 14px", borderRadius: 12, background: "var(--buddy-row-bg)", border: "1px solid var(--buddy-panel-border)", fontSize: 12.5, lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
          {insight.insight}
        </div>
      )}
      {!insight && !error && <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("stats.insight.hint")}</div>}
    </>
  );
}

// ── records ─────────────────────────────────────────────────────────────────

function RecordsSection({ data }: { data: Analytics }) {
  const r = data.analytics.records;
  const rec = (label: string, value: string, icon: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: "var(--buddy-row-bg)", fontSize: 12 }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span style={{ color: "var(--buddy-panel-muted)", flex: 1 }}>{label}</span>
      <span style={{ fontWeight: 700 }}>{value}</span>
    </div>
  );
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rec(t("stats.rec.maxTurns"), r.maxTurns ? t("stats.rec.times", [`${r.maxTurns.value}`, r.maxTurns.date]) : "—", "⚡")}
        {rec(t("stats.rec.maxTools"), r.maxTools ? t("stats.rec.times", [`${r.maxTools.value}`, r.maxTools.date]) : "—", "🔧")}
        {rec(t("stats.rec.maxActive"), r.maxActive ? t("stats.rec.at", [fmtDuration(r.maxActive.value), r.maxActive.date]) : "—", "⏱️")}
        {rec(t("stats.rec.maxIntensity"), r.maxIntensity ? t("stats.rec.at", [`${r.maxIntensity.value}`, r.maxIntensity.date]) : "—", "🔥")}
        {rec(t("stats.rec.maxRecovered"), r.maxRecovered ? t("stats.rec.times", [`${r.maxRecovered.value}`, r.maxRecovered.date]) : "—", "💪")}
        {rec(t("stats.rec.streak"), t("stats.rec.days", [r.bestStreak]), "📅")}
        {rec(t("stats.rec.totalDays"), t("stats.rec.days", [r.totalActiveDays]), "🗓️")}
        {rec(t("stats.rec.totalCalls"), t("stats.rec.calls", [r.totalToolCalls]), "🧰")}
      </div>
    </>
  );
}
