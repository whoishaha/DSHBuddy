/**
 * GrowthTab — the 「成长」 tab inside DSHBuddy settings.
 *
 * Renders the full growth archive (design doc §7):
 *   总览   level / XP progress / bond / mood / energy / today intensity
 *   职业   6-dim career radar + primary/secondary + title
 *   强度   7-day bars + 30-day trend
 *   记忆   timeline / LLM daily summaries / milestones / weekly reports
 *   画像   LLM user-type portrait + traits + strengths + growth tips
 *   导出   Markdown / JSON export, LLM toggle, clear / reset
 *
 * All data comes from the host half's /api/dshbuddy/growth endpoint.
 */

import { useEffect, useState } from "react";
import { buddyGet, buddyPost } from "../useBuddyState.js";
import { t, currentLang } from "../i18n.js";
import { StatsTab } from "./StatsTab.js";

type CareerKey = "builder" | "debugger" | "researcher" | "reviewer" | "architect" | "operator";

type GrowthPayload = {
  ok: boolean;
  llmEnabled: boolean;
  growth: {
    level: number;
    /** B3-1 prestige (转生) count — 0 until the first rebirth. */
    prestigeCount?: number;
    xp: number;
    levelProgress: number;
    needNext: number;
    bond: number;
    mood: string;
    energy: number;
    intensity: number;
    intensityLevel: string;
    streakDays: number;
    tasksCompleted: number;
    errorsRecovered: number;
    totalApprovals: number;
    totalQuestions: number;
    totalSubagents: number;
    firstSeen: number;
    intensityDays: Record<string, number>;
  };
  career: {
    xp: Record<CareerKey, number>;
    historicalPrimary: CareerKey | null;
    recentPrimary: CareerKey | null;
    primary: CareerKey | null;
    secondary: CareerKey | null;
    title: string | null;
    snapshots: { date: string; primary: CareerKey | null; title: string | null }[];
    labels: Record<CareerKey, string>;
  };
  memory: {
    milestones: { id: string; title: string; description: string; createdAt: number }[];
    dailySummaries: { date: string; intensity: number; tasks: number; errors: number; recovered: number; summaryText: string; source: string }[];
    timeline: { date: string; title: string; description: string; kind: string }[];
    weeklyReports: { week: string; summaryText: string; source: string }[];
    growthSummaries: { id: string; createdAt: number; summaryText: string; source: string }[];
  };
  profile: {
    userType: string;
    typeLabel: string;
    summary: string;
    traits: string[];
    strengths: string[];
    growthTips: string[];
    source: string;
    updatedAt: number;
  } | null;
  userTypes: Record<string, { label: string; en: string; desc: string }>;
};

import { INTENSITY_COLORS, intensityLevelOf, moodLabel, intensityLabel, stageFor, PRESTIGE_MIN_LEVEL } from "../growthLabels.js";

const CAREER_ORDER: CareerKey[] = ["builder", "debugger", "researcher", "reviewer", "architect", "operator"];

type SectionKey = "overview" | "analytics" | "career" | "intensity" | "memory" | "profile" | "badges" | "export";

type BadgeInfo = {
  id: string;
  category?: string;
  icon: string;
  unlockedAt: number | null;
  level: number;
  maxLevel: number;
  value: number;
  progress: { cur: number; target: number };
  name: { zh: string; en: string };
  desc: { zh: string; en: string };
};

/** Category registry — display meta ships from the host achievements module. */
type CategoryInfo = {
  id: string;
  icon: string;
  color: string;
  name: { zh: string; en: string };
};

export function GrowthTab() {
  const [data, setData] = useState<GrowthPayload | null>(null);
  const [section, setSection] = useState<SectionKey>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Badge wall (B2-1) — fetched separately from /achievements.
  const [badges, setBadges] = useState<BadgeInfo[] | null>(null);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);

  const loadBadges = () => {
    void buddyGet<{ ok: boolean; achievements: BadgeInfo[]; categories?: CategoryInfo[] }>("achievements").then((j) => {
      if (j?.ok) {
        setBadges(j.achievements ?? []);
        if (j.categories) setCategories(j.categories);
      }
    });
  };

  const load = () => {
    void buddyGet<GrowthPayload>("growth").then((j) => {
      if (j?.ok) setData(j);
    });
  };

  useEffect(() => {
    load();
    loadBadges();
    const iv = setInterval(load, 5000);
    const badgeIv = setInterval(loadBadges, 15000);
    return () => {
      clearInterval(iv);
      clearInterval(badgeIv);
    };
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };

  const act = async (op: string, body?: Record<string, unknown>) => {
    setBusy(op);
    const j = await buddyPost<{ ok: boolean }>("growth", { op, ...body });
    setBusy(null);
    if (j?.ok) {
      const msg =
        op === "clear" ? t("growth.msg.cleared")
        : op === "reset" ? t("growth.msg.reset")
        : op === "export" ? t("growth.msg.exportedMd")
        : op === "regenerate-narrative" ? t("growth.msg.narrativeUpdated")
        : op === "prestige" ? t("growth.msg.prestige")
        : t("growth.msg.done");
      flash(msg);
      load();
    }
    return j?.ok ?? false;
  };

  const exportMd = async () => {
    const res = await fetch("/api/dshbuddy/growth?format=md", { cache: "no-store" });
    if (!res.ok) return;
    const text = await res.text();
    downloadBlob(text, `dshbuddy-growth-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown;charset=utf-8");
    flash(t("growth.msg.exportedMd"));
  };

  const exportJson = async () => {
    const j = await buddyGet<GrowthPayload>("growth");
    if (!j) return;
    downloadBlob(JSON.stringify(j, null, 2), `dshbuddy-growth-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
    flash(t("growth.msg.exportedJson"));
  };

  const sections: { key: SectionKey; label: string }[] = [
    { key: "overview", label: t("growth.tab.overview") },
    { key: "analytics", label: t("growth.tab.analytics") },
    { key: "career", label: t("growth.tab.career") },
    { key: "intensity", label: t("growth.tab.intensity") },
    { key: "memory", label: t("growth.tab.memory") },
    { key: "profile", label: t("growth.tab.profile") },
    { key: "badges", label: t("growth.tab.badges") },
    { key: "export", label: t("growth.tab.export") },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{t("growth.archive")}</h3>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>
        {t("growth.desc")}
      </div>

      {/* section nav */}
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
        {toast && <span style={{ fontSize: 11, color: "var(--buddy-accent)", alignSelf: "center" }}>{toast}</span>}
      </div>

      {!data ? (
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("common.loading")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {section === "overview" && <OverviewSection data={data} busy={busy} onRegenerate={() => void act("regenerate-narrative")} onPrestige={() => void act("prestige")} />}
          {section === "analytics" && <StatsTab embedded />}
          {section === "career" && <CareerSection data={data} />}
          {section === "intensity" && <IntensitySection data={data} />}
          {section === "memory" && <MemorySection data={data} />}
          {section === "profile" && <ProfileSection data={data} busy={busy} onRegenerate={() => void act("regenerate-profile")} />}
          {section === "badges" && <BadgesSection badges={badges} categories={categories} />}
          {section === "export" && (
            <ExportSection
              data={data}
              busy={busy}
              llmEnabled={data.llmEnabled}
              onToggleLlm={async (v) => {
                const j = await buddyPost<{ ok: boolean }>("config", { growth: { llmEnabled: v } });
                if (j?.ok) {
                  load();
                  flash(v ? t("growth.msg.llmOn") : t("growth.msg.llmOff"));
                }
              }}
              onExportMd={() => void exportMd()}
              onExportJson={() => void exportJson()}
              onClear={() => void act("clear")}
              onReset={() => void act("reset")}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── overview ────────────────────────────────────────────────────────────────

function OverviewSection({ data, busy, onRegenerate, onPrestige }: { data: GrowthPayload; busy: string | null; onRegenerate: () => void; onPrestige: () => void }) {
  const g = data.growth;
  const row = (label: string, value: string) => (
    <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderRadius: 8, background: "var(--buddy-row-bg)", fontSize: 12 }}>
      <span style={{ color: "var(--buddy-panel-muted)" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );

  const latestNarrative = data.memory.growthSummaries?.[0];

  return (
    <>
      {/* LLM growth narrative (成长综述 — analyzed from real habits) */}
      <div style={{ padding: "12px 14px", borderRadius: 12, background: "linear-gradient(135deg, color-mix(in srgb, var(--buddy-accent) 10%, transparent), transparent)", border: "1px solid color-mix(in srgb, var(--buddy-accent) 30%, var(--buddy-panel-border))" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>🪄 {t("growth.narrative.title")}</span>
          <button
            onClick={onRegenerate}
            style={{ background: "none", border: "none", color: "var(--buddy-accent)", fontSize: 11, cursor: busy === "regenerate-narrative" ? "wait" : "pointer" }}
          >
            {busy === "regenerate-narrative" ? t("growth.narrative.busy") : t("growth.narrative.reanalyze")}
          </button>
        </div>
        {latestNarrative ? (
          <>
            <div style={{ fontSize: 12.5, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{latestNarrative.summaryText}</div>
            <div style={{ fontSize: 10, color: "var(--buddy-panel-muted)", marginTop: 6 }}>
              {latestNarrative.source === "llm" ? t("growth.narrative.llmSource") : t("growth.narrative.templateSource")} · {new Date(latestNarrative.createdAt).toLocaleString(currentLang() === "en" ? "en-US" : "zh-CN")}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", lineHeight: 1.6 }}>
            {t("growth.narrative.empty")}
          </div>
        )}
      </div>

      {/* level card */}
      <LevelCard level={g.level} xp={g.xp} levelProgress={g.levelProgress ?? 0} needNext={g.needNext} prestigeCount={g.prestigeCount ?? 0} onPrestige={onPrestige} busy={busy === "prestige"} />

      {/* mood/energy/intensity chips */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {[
          { label: t("stats.growth.mood"), value: moodLabel(g.mood), color: "var(--buddy-accent)" },
          { label: t("stats.growth.energy"), value: `${g.energy}%`, color: g.energy > 60 ? "var(--buddy-success)" : g.energy > 35 ? "var(--buddy-warning)" : "var(--buddy-danger)" },
          { label: t("growth.todayIntensity"), value: `${g.intensity}`, color: INTENSITY_COLORS[g.intensityLevel] ?? "#64748b" },
        ].map((c) => (
          <div key={c.label} style={{ padding: "10px 8px", borderRadius: 10, background: "var(--buddy-row-bg)", textAlign: "center", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 10, color: "var(--buddy-panel-muted)" }}>{c.label}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 9, color: "var(--buddy-panel-muted)" }}>{c.label === t("growth.todayIntensity") ? intensityLabel(g.intensityLevel) : ""}</div>
          </div>
        ))}
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h4 style={{ margin: 0, fontSize: 13 }}>{t("growth.data")}</h4>
        {row(t("growth.bond"), String(g.bond))}
        {row(t("growth.streak"), t("stats.rec.days", [g.streakDays]))}
        {row(t("growth.tasksDone"), String(g.tasksCompleted))}
        {row(t("growth.errorsRecovered"), String(g.errorsRecovered))}
        {row(t("growth.approvalsQuestions"), `${g.totalApprovals} / ${g.totalQuestions}`)}
        {row(t("growth.subagents"), String(g.totalSubagents))}
        {row(t("stats.growth.primary"), data.career.primary ? data.career.labels[data.career.primary] : "—")}
        {row(t("stats.growth.title"), data.career.title ?? "—")}
        {row(t("growth.profileLabel"), data.profile?.typeLabel ?? t("growth.profileNone"))}
      </section>
    </>
  );
}

// ── career radar ────────────────────────────────────────────────────────────

function CareerSection({ data }: { data: GrowthPayload }) {
  const c = data.career;
  const values = CAREER_ORDER.map((k) => c.xp[k] ?? 0);
  const max = Math.max(1, ...values);
  const labels = CAREER_ORDER.map((k) => c.labels[k]);

  const row = (label: string, value: number) => (
    <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <span style={{ width: 52, color: "var(--buddy-panel-muted)" }}>{label}</span>
      <div style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--buddy-input-bg)", overflow: "hidden" }}>
        <div style={{ height: "100%", background: "var(--buddy-accent)", width: `${(value / max) * 100}%` }} />
      </div>
      <span style={{ width: 40, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(value * 10) / 10}</span>
    </div>
  );

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[
          { label: t("growth.career.historical"), value: c.historicalPrimary ? c.labels[c.historicalPrimary] : "—" },
          { label: t("growth.career.recent7d"), value: c.recentPrimary ? c.labels[c.recentPrimary] : "—" },
          { label: t("growth.career.current"), value: c.primary ? c.labels[c.primary] : "—" },
          { label: t("growth.career.secondary"), value: c.secondary ? c.labels[c.secondary] : "—" },
        ].map((chip) => (
          <div key={chip.label} style={{ padding: "6px 10px", borderRadius: 8, background: "var(--buddy-row-bg)", fontSize: 11 }}>
            <div style={{ color: "var(--buddy-panel-muted)" }}>{chip.label}</div>
            <div style={{ fontWeight: 700, color: "var(--buddy-accent)" }}>{chip.value}</div>
          </div>
        ))}
      </div>
      {c.title && (
        <div style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--buddy-accent)", background: "color-mix(in srgb, var(--buddy-accent) 8%, transparent)", fontSize: 13, fontWeight: 700 }}>
          🏅 {c.title}
        </div>
      )}
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <RadarChart values={values} labels={labels} />
        <div style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 6 }}>
          {CAREER_ORDER.map((k, i) => row(labels[i], values[i]))}
        </div>
      </div>
    </>
  );
}

/** Six-axis radar chart (SVG). */
function RadarChart({ values, labels }: { values: number[]; labels: string[] }) {
  const size = 170;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 26;
  const n = values.length;
  const max = Math.max(1, ...values);
  const pt = (i: number, scale: number): [number, number] => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(angle) * r * scale, cy + Math.sin(angle) * r * scale];
  };
  const ring = (scale: number) => Array.from({ length: n }, (_, i) => pt(i, scale).join(",")).join(" ");
  const poly = values.map((v, i) => pt(i, Math.max(0.05, v / max)).join(",")).join(" ");
  return (
    <svg width={size} height={size} style={{ flex: "none" }}>
      {[0.25, 0.5, 0.75, 1].map((s) => (
        <polygon key={s} points={ring(s)} fill="none" stroke="var(--buddy-panel-border)" strokeWidth={1} />
      ))}
      {Array.from({ length: n }, (_, i) => {
        const [x, y] = pt(i, 1);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--buddy-panel-border)" strokeWidth={1} />;
      })}
      <polygon points={poly} fill="color-mix(in srgb, var(--buddy-accent) 30%, transparent)" stroke="var(--buddy-accent)" strokeWidth={2} />
      {values.map((v, i) => {
        const [x, y] = pt(i, Math.max(0.05, v / max));
        return <circle key={i} cx={x} cy={y} r={3} fill="var(--buddy-accent)" />;
      })}
      {labels.map((label, i) => {
        const [x, y] = pt(i, 1.22);
        return (
          <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={10} fill="var(--buddy-panel-muted)">
            {label}
          </text>
        );
      })}
    </svg>
  );
}

// ── intensity ───────────────────────────────────────────────────────────────

function IntensitySection({ data }: { data: GrowthPayload }) {
  const days = Object.entries(data.growth.intensityDays).sort((a, b) => a[0].localeCompare(b[0]));
  const last7 = days.slice(-7);
  const last30 = days.slice(-30);
  const max = Math.max(1, ...days.map(([, v]) => v));
  const level = data.growth.intensityLevel;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: INTENSITY_COLORS[level] ?? "#64748b" }} />
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t("growth.todayIntensity")} {data.growth.intensity} · {intensityLabel(level)}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.5 }}>
        {t("growth.intensity.scale")}
      </div>

      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("growth.last7")}</h4>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 80 }}>
          {last7.map(([date, v]) => (
            <div key={date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div
                style={{
                  width: "100%",
                  maxWidth: 26,
                  height: `${Math.max(4, (v / max) * 60)}px`,
                  borderRadius: "6px 6px 0 0",
                  background: INTENSITY_COLORS[intensityLevelOf(v)] ?? "var(--buddy-accent)",
                  transition: "height 300ms",
                }}
                title={`${date}: ${Math.round(v)}`}
              />
              <span style={{ fontSize: 9, color: "var(--buddy-panel-muted)" }}>{date.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("growth.last30")}</h4>
        <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 48, overflowX: "auto", paddingBottom: 2 }}>
          {last30.map(([date, v]) => (
            <div
              key={date}
              title={`${date}: ${Math.round(v)}`}
              style={{
                flex: "none",
                width: 6,
                height: `${Math.max(3, (v / max) * 44)}px`,
                borderRadius: 3,
                background: INTENSITY_COLORS[intensityLevelOf(v)] ?? "var(--buddy-accent)",
              }}
            />
          ))}
        </div>
      </section>
    </>
  );
}

// ── memory ──────────────────────────────────────────────────────────────────

function MemorySection({ data }: { data: GrowthPayload }) {
  const m = data.memory;
  const scroll = { maxHeight: 240, overflowY: "auto" as const, paddingRight: 2 };
  return (
    <>
      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("growth.memory.timeline")}</h4>
        {m.timeline.length === 0 && <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("growth.memory.noTimeline")}</div>}
        <div style={{ maxHeight: 180, overflowY: "auto", paddingRight: 2 }}>
          {m.timeline.slice(0, 8).map((e, i) => (
            <div key={i} title={e.description} style={{ display: "flex", gap: 8, fontSize: 11, alignItems: "baseline", padding: "3px 0", borderBottom: "1px solid var(--buddy-row-bg)" }}>
              <span style={{ color: "var(--buddy-panel-muted)", flex: "none", fontVariantNumeric: "tabular-nums" }}>{e.date.slice(5)}</span>
              <span style={{ fontWeight: 600 }}>{e.title}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("growth.memory.daily")}</h4>
        {m.dailySummaries.length === 0 && <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("growth.memory.noDaily")}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, ...scroll }}>
          {m.dailySummaries.slice(0, 8).map((s) => (
            <div key={s.date} style={{ padding: 10, borderRadius: 10, background: "var(--buddy-row-bg)", fontSize: 12, lineHeight: 1.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontWeight: 700 }}>{s.date}</span>
                <span style={{ fontSize: 10, color: "var(--buddy-panel-muted)" }}>
                  {t("growth.memory.meta", [s.source === "llm" ? t("growth.memory.llm") : t("growth.memory.template"), s.intensity, s.tasks])}
                </span>
              </div>
              <div style={{ whiteSpace: "pre-wrap", color: "var(--buddy-panel-fg)" }}>{s.summaryText}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("growth.memory.weekly")}</h4>
        {m.weeklyReports.length === 0 && <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("growth.memory.noWeekly")}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, ...scroll }}>
          {m.weeklyReports.slice(0, 3).map((w) => (
            <div key={w.week} style={{ padding: 10, borderRadius: 10, background: "var(--buddy-row-bg)", fontSize: 12, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{w.week}{w.source === "llm" ? t("growth.memory.llmTag") : t("growth.memory.templateTag")}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{w.summaryText}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("growth.memory.milestones", [m.milestones.length])}</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, ...scroll }}>
          {m.milestones.slice(0, 12).map((ms) => (
            <div key={ms.id} style={{ display: "flex", gap: 8, fontSize: 11 }}>
              <span style={{ flex: "none" }}>🏆</span>
              <span style={{ fontWeight: 600, flex: "none" }}>{ms.title}</span>
              <span style={{ color: "var(--buddy-panel-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ms.description}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ── level card with evolution stage + prestige (B3-1) ──────────────────────

function LevelCard({
  level,
  xp,
  levelProgress,
  needNext,
  prestigeCount,
  onPrestige,
  busy,
}: {
  level: number;
  xp: number;
  levelProgress: number;
  needNext: number;
  prestigeCount: number;
  onPrestige: () => void;
  busy: boolean;
}) {
  // Two-step confirm for the one-way prestige reset.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  const stage = stageFor(level);
  const lang = currentLang();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 14, borderRadius: 12, background: "var(--buddy-row-bg)", border: "1px solid var(--buddy-panel-border)" }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: `linear-gradient(135deg, ${stage.color}, var(--buddy-accent-2))`,
          color: "var(--buddy-on-accent)",
          fontWeight: 800,
          fontSize: 18,
          flex: "none",
          boxShadow: `0 4px 16px color-mix(in srgb, ${stage.color} 45%, transparent)`,
        }}
      >
        {level}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Lv.{level} · {xp} XP</span>
          {/* evolution stage (label/color only — B3-1) */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 999,
              color: stage.color,
              border: `1px solid color-mix(in srgb, ${stage.color} 55%, transparent)`,
              background: `color-mix(in srgb, ${stage.color} 12%, transparent)`,
            }}
            title={t("growth.stage.hint")}
          >
            {lang === "en" ? stage.en : stage.zh}
          </span>
          {prestigeCount > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "#fbbf24" }} title={t("growth.prestige")}>
              🌟 ×{prestigeCount}
            </span>
          )}
        </div>
        <div style={{ height: 8, borderRadius: 999, background: "var(--buddy-input-bg)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              borderRadius: 999,
              background: "linear-gradient(90deg, var(--buddy-accent), var(--buddy-accent-2))",
              width: `${Math.round(levelProgress * 100)}%`,
              transition: "width 400ms",
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 10, color: "var(--buddy-panel-muted)" }}>
            {t("growth.xpToNext", [Math.max(0, needNext - Math.round(levelProgress * needNext))])}
          </span>
          {level >= PRESTIGE_MIN_LEVEL && (
            <button
              onClick={() => {
                if (armed) {
                  setArmed(false);
                  onPrestige();
                } else {
                  setArmed(true);
                }
              }}
              disabled={busy}
              style={{
                padding: "3px 10px",
                borderRadius: 999,
                border: armed ? "1px solid var(--buddy-danger)" : "1px solid #fbbf24",
                background: armed ? "color-mix(in srgb, var(--buddy-danger) 12%, transparent)" : "transparent",
                color: armed ? "var(--buddy-danger)" : "#fbbf24",
                fontSize: 11,
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
              }}
            >
              {armed ? t("growth.prestige.confirm") : `🌟 ${t("growth.prestige")}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── badge wall (B2-1) ───────────────────────────────────────────────────────

/** Completion ring — one SVG circle, dasharray-driven (no animation cost). */
function CompletionRing({ pct }: { pct: number }) {
  const R = 28;
  const C = 2 * Math.PI * R;
  return (
    <svg width="70" height="70" viewBox="0 0 70 70" style={{ flex: "none" }}>
      <circle cx="35" cy="35" r={R} fill="none" stroke="var(--buddy-input-bg)" strokeWidth="7" />
      <circle
        cx="35"
        cy="35"
        r={R}
        fill="none"
        stroke="var(--buddy-accent)"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={`${(Math.min(100, pct) / 100) * C} ${C}`}
        transform="rotate(-90 35 35)"
      />
      <text
        x="35"
        y="40"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fill="var(--buddy-panel-fg)"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {pct}%
      </text>
    </svg>
  );
}

function BadgesSection({ badges, categories }: { badges: BadgeInfo[] | null; categories: CategoryInfo[] }) {
  const [cat, setCat] = useState<string>("all");
  if (!badges) {
    return <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("common.loading")}</div>;
  }
  const lang = currentLang();
  const catMeta = new Map(categories.map((c) => [c.id, c]));
  const earnedLevels = badges.reduce((sum, badge) => sum + badge.level, 0);
  const totalLevels = badges.reduce((sum, badge) => sum + badge.maxLevel, 0);
  const pct = Math.round((earnedLevels / Math.max(1, totalLevels)) * 100);
  const shown = cat === "all" ? badges : badges.filter((b) => b.category === cat);

  // Category chips with per-category unlock counts; "all" leads.
  const chips: { key: string; icon: string; label: string; count: string; color: string }[] = [
    { key: "all", icon: "🏅", label: t("growth.ach.all"), count: `${earnedLevels}/${totalLevels}`, color: "var(--buddy-accent)" },
    ...categories.map((c) => {
      const inCat = badges.filter((b) => b.category === c.id);
      const gotInCat = inCat.reduce((sum, badge) => sum + badge.level, 0);
      const totalInCat = inCat.reduce((sum, badge) => sum + badge.maxLevel, 0);
      return {
        key: c.id,
        icon: c.icon,
        label: lang === "en" ? c.name.en : c.name.zh,
        count: `${gotInCat}/${totalInCat}`,
        color: c.color,
      };
    }),
  ];

  return (
    <>
      {/* summary header: completion ring + encouraging line */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "10px 14px",
          borderRadius: 12,
          border: "1px solid var(--buddy-panel-border)",
          background: "linear-gradient(135deg, color-mix(in srgb, var(--buddy-accent) 9%, transparent), transparent)",
        }}
      >
        <CompletionRing pct={pct} />
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>🏅 {t("growth.tab.badges")}</div>
          <div style={{ fontSize: 11.5, color: "var(--buddy-panel-muted)", lineHeight: 1.55 }}>
            {t("growth.ach.count", [earnedLevels, totalLevels])}
          </div>
        </div>
      </div>

      {/* category filter chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {chips.map((c) => {
          const on = cat === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setCat(c.key)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 11,
                cursor: "pointer",
                border: on ? `1px solid ${c.color}` : "1px solid var(--buddy-panel-border)",
                background: on ? `color-mix(in srgb, ${c.color} 16%, transparent)` : "transparent",
                color: on ? c.color : "var(--buddy-panel-muted)",
                fontWeight: on ? 600 : 400,
              }}
            >
              <span style={{ fontSize: 12, lineHeight: 1 }}>{c.icon}</span>
              {c.label}
              <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.75 }}>{c.count}</span>
            </button>
          );
        })}
      </div>

      {/* the wall itself */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 8 }}>
        {shown.map((b) => {
          const got = b.level > 0;
          const maxed = b.level >= b.maxLevel;
          const name = lang === "en" ? b.name.en : b.name.zh;
          const desc = lang === "en" ? b.desc.en : b.desc.zh;
          const pctCur = Math.round((b.progress.cur / Math.max(1, b.progress.target)) * 100);
          const color = catMeta.get(b.category ?? "")?.color ?? "var(--buddy-accent)";
          return (
            <div
              key={b.id}
              title={desc}
              style={{
                padding: "10px 10px 8px",
                borderRadius: 12,
                border: got
                  ? `1px solid color-mix(in srgb, ${color} 55%, transparent)`
                  : "1px solid var(--buddy-panel-border)",
                background: got
                  ? `linear-gradient(150deg, color-mix(in srgb, ${color} 15%, transparent), transparent)`
                  : "var(--buddy-row-bg)",
                opacity: got ? 1 : 0.72,
                display: "flex",
                flexDirection: "column",
                gap: 5,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                {/* locked badges render greyscale so the wall reads at a glance;
                    unlocked icons glow in their category color */}
                <span
                  style={{
                    fontSize: 20,
                    filter: got ? undefined : "grayscale(1) opacity(0.55)",
                    textShadow: got ? `0 0 12px color-mix(in srgb, ${color} 45%, transparent)` : undefined,
                  }}
                >
                  {b.icon}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.25, flex: 1 }}>{name}</span>
                <span
                  style={{
                    flex: "none",
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: got ? `color-mix(in srgb, ${color} 16%, transparent)` : "var(--buddy-input-bg)",
                    color: got ? color : "var(--buddy-panel-muted)",
                    fontSize: 9.5,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  Lv.{b.level}/{b.maxLevel}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--buddy-panel-muted)", lineHeight: 1.45, minHeight: 28 }}>
                {maxed ? desc : t("growth.ach.hint", [desc])}
              </div>
              {maxed ? (
                <div style={{ fontSize: 10, color, fontWeight: 600 }}>
                  🏅 {t("growth.ach.max")}{b.unlockedAt ? ` · ${new Date(b.unlockedAt).toLocaleDateString(lang === "en" ? "en-US" : "zh-CN")}` : ""}
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--buddy-input-bg)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, pctCur)}%`, background: got ? color : "var(--buddy-panel-muted)" }} />
                  </div>
                  <span style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums", color: "var(--buddy-panel-muted)" }}>
                    {b.progress.cur}/{b.progress.target}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── profile ─────────────────────────────────────────────────────────────────

function ProfileSection({ data, busy, onRegenerate }: { data: GrowthPayload; busy: string | null; onRegenerate: () => void }) {
  const p = data.profile;
  if (!p) {
    return (
      <>
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)", lineHeight: 1.6 }}>
          {t("growth.profile.empty")}
        </div>
        <button onClick={onRegenerate} style={accentBtn}>
          {busy === "regenerate-profile" ? t("growth.profile.busy") : t("growth.profile.generateNow")}
        </button>
      </>
    );
  }
  const list = (title: string, items: string[], icon: string) =>
    items.length > 0 ? (
      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>
          {icon} {title}
        </h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map((item, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--buddy-panel-fg)", padding: "5px 8px", borderRadius: 8, background: "var(--buddy-row-bg)" }}>
              {item}
            </div>
          ))}
        </div>
      </section>
    ) : null;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div
          style={{
            padding: "8px 16px",
            borderRadius: 999,
            background: "linear-gradient(135deg, var(--buddy-accent), var(--buddy-accent-2))",
            color: "var(--buddy-on-accent)",
            fontWeight: 800,
            fontSize: 14,
          }}
        >
          {p.typeLabel}
        </div>
        <span style={{ fontSize: 11, color: "var(--buddy-panel-muted)" }}>
          {p.source === "llm" ? t("stats.insight.llm") : t("stats.insight.rule")} · {new Date(p.updatedAt).toLocaleString(currentLang() === "en" ? "en-US" : "zh-CN")}
        </span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.7, padding: "10px 12px", borderRadius: 10, background: "var(--buddy-row-bg)" }}>{p.summary}</div>
      {list(t("growth.profile.traits"), p.traits, "🧬")}
      {list(t("growth.profile.strengths"), p.strengths, "💪")}
      {list(t("growth.profile.tips"), p.growthTips, "🌱")}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onRegenerate} style={accentBtn}>
          {busy === "regenerate-profile" ? t("growth.profile.regenerating") : t("growth.profile.regenerate")}
        </button>
      </div>
    </>
  );
}

// ── export / settings ───────────────────────────────────────────────────────

function ExportSection({
  data,
  busy,
  llmEnabled,
  onToggleLlm,
  onExportMd,
  onExportJson,
  onClear,
  onReset,
}: {
  data: GrowthPayload;
  busy: string | null;
  llmEnabled: boolean;
  onToggleLlm: (v: boolean) => void;
  onExportMd: () => void;
  onExportJson: () => void;
  onClear: () => void;
  onReset: () => void;
}) {
  // Two-step confirmation for destructive actions (previously one-click).
  const [armed, setArmed] = useState<"clear" | "reset" | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  const guard = (kind: "clear" | "reset", run: () => void) => () => {
    if (armed === kind) {
      setArmed(null);
      run();
    } else {
      setArmed(kind);
    }
  };
  const btn = (label: string, onClick: () => void, disabled = false, danger = false) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 14px",
        borderRadius: 8,
        border: danger ? "1px solid var(--buddy-danger)" : "1px solid var(--buddy-panel-border)",
        background: danger ? "color-mix(in srgb, var(--buddy-danger) 10%, transparent)" : "var(--buddy-input-bg)",
        color: danger ? "var(--buddy-danger)" : "var(--buddy-panel-fg)",
        fontSize: 12,
        cursor: disabled ? "wait" : "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h4 style={{ margin: 0, fontSize: 13 }}>{t("growth.llm.title")}</h4>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--buddy-panel-muted)", flex: 1 }}>
            {t("growth.llm.desc")}
          </span>
          <button
            onClick={() => onToggleLlm(!llmEnabled)}
            style={{
              flex: "none",
              padding: "6px 14px",
              borderRadius: 999,
              border: "none",
              background: llmEnabled ? "var(--buddy-accent)" : "var(--buddy-input-bg)",
              color: llmEnabled ? "var(--buddy-on-accent)" : "var(--buddy-panel-muted)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {llmEnabled ? t("growth.llm.on") : t("growth.llm.off")}
          </button>
        </div>
      </section>

      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("growth.export.title")}</h4>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onExportMd} style={accentBtn}>
            {busy === "export" ? "…" : t("growth.export.md")}
          </button>
          <button onClick={onExportJson} style={accentBtn}>
            {t("growth.export.json")}
          </button>
        </div>
      </section>

      <section>
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{t("growth.privacy.title")}</h4>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {btn(armed === "clear" ? t("growth.privacy.confirmClear") : t("growth.privacy.clear"), guard("clear", onClear), false, armed === "clear")}
          {btn(armed === "reset" ? t("growth.privacy.confirmReset") : t("growth.privacy.reset"), guard("reset", onReset), false, true)}
        </div>
        <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", marginTop: 6, lineHeight: 1.5 }}>
          {t("growth.privacy.hint")}
        </div>
      </section>
    </>
  );
}

const accentBtn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "none",
  background: "var(--buddy-accent)",
  color: "var(--buddy-on-accent)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

function downloadBlob(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
