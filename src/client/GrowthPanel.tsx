/**
 * GrowthPanel — compact growth overview floating panel (opened from the pet
 * menu). Shows level / XP / intensity / career / user type at a glance, plus a
 * shortcut into the full growth archive inside settings.
 */

import { useEffect, useState } from "react";
import { PanelShell } from "./panels.js";
import { buddyGet } from "./useBuddyState.js";
import { t } from "./i18n.js";
import { moodLabel, intensityLabel, intensityColor } from "./growthLabels.js";

type GrowthBrief = {
  ok: boolean;
  growth: {
    level: number;
    xp: number;
    levelProgress: number;
    bond: number;
    intimacy?: number;
    mood: string;
    energy: number;
    intensity: number;
    intensityLevel: string;
    streakDays: number;
  };
  career: { primary: string | null; secondary: string | null; title: string | null; labels: Record<string, string> };
  profile: { typeLabel: string; summary: string } | null;
};

export function GrowthPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<GrowthBrief | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void buddyGet<GrowthBrief>("growth").then((j) => {
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

  return (
    <PanelShell title={t("growth.archive")} onClose={onClose}>
      {!data ? (
        <div style={{ fontSize: 12, color: "var(--buddy-panel-muted)" }}>{t("common.loading")}</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                background: "linear-gradient(135deg, var(--buddy-accent), var(--buddy-accent-2))",
                color: "var(--buddy-on-accent)",
                fontWeight: 800,
                fontSize: 16,
                flex: "none",
              }}
            >
              {data.growth.level}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Lv.{data.growth.level} · {data.growth.xp} XP</div>
              <div style={{ height: 6, borderRadius: 999, background: "var(--buddy-input-bg)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    background: "linear-gradient(90deg, var(--buddy-accent), var(--buddy-accent-2))",
                    width: `${Math.round((data.growth.levelProgress ?? 0) * 100)}%`,
                  }}
                />
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
            <BriefCell label={t("stats.growth.mood")} value={moodLabel(data.growth.mood)} />
            <BriefCell label={t("stats.growth.energy")} value={`${data.growth.energy}%`} />
            <BriefCell label={t("growth.bondIcon")} value={String(data.growth.intimacy ?? Math.round(data.growth.bond))} />
            <BriefCell label={t("growth.streak")} value={t("stats.rec.days", [data.growth.streakDays])} />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 8,
              background: "var(--buddy-row-bg)",
              fontSize: 12,
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: intensityColor(data.growth.intensityLevel), flex: "none" }} />
            <span style={{ color: "var(--buddy-panel-muted)" }}>{t("growth.todayIntensity")}</span>
            <span style={{ fontWeight: 700 }}>{data.growth.intensity}</span>
            <span style={{ color: "var(--buddy-panel-muted)" }}>· {intensityLabel(data.growth.intensityLevel)}</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            <Row label={t("stats.growth.primary")} value={data.career.primary ? data.career.labels[data.career.primary] : "—"} />
            <Row label={t("stats.growth.title")} value={data.career.title ?? "—"} />
            <Row label={t("growth.profileLabel")} value={data.profile?.typeLabel ?? t("growth.profileNone")} />
          </div>

          {data.profile?.summary && (
            <div style={{ fontSize: 11, color: "var(--buddy-panel-muted)", lineHeight: 1.6, borderTop: "1px solid var(--buddy-panel-border)", paddingTop: 8 }}>
              {data.profile.summary}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

function BriefCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "6px 8px", borderRadius: 8, background: "var(--buddy-row-bg)", fontSize: 11, display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--buddy-panel-muted)" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--buddy-panel-muted)" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
