/**
 * SettingsPanel — the single DSHBuddy entry inside DSH settings. The left rail
 * shows one "DSHBuddy" section; this panel renders its own tab navigation and
 * switches the right-side content between all petdex-ported feature tabs.
 *
 * v0.3: icon tab bar with logical grouping (pet & growth / data / appearance /
 * tools / about) so the twelve entries scan quickly instead of reading as a
 * pill soup.
 */

import { useEffect, useState } from "react";
import { t, setLang } from "../i18n.js";
import { useBuddySnapshot } from "../useBuddyState.js";
import { THEMES } from "../theme.js";
import { ensureFx } from "../fx.js";
import {
  AboutTab,
  AppearanceTab,
  CalendarTab,
  ChatTab,
  CompanionHomeTab,
  CommandsTab,
  GrowthTab,
  JinglingTab,
  MarketTab,
  ModelTab,
  NotesTab,
  PersonalityTab,
  PetTab,
  PomodoroTab,
  ShopTab,
} from "./tabs.js";

type TabKey =
  | "home"
  | "pet"
  | "jingling"
  | "growth"
  | "shop"
  | "appearance"
  | "commands"
  | "personality"
  | "model"
  | "pomodoro"
  | "chat"
  | "calendar"
  | "notes"
  | "market"
  | "about";

/** Tab registry — built per render so labels follow the live i18n language
 *  (a module-level const would freeze the strings from first import). */
function getTabs(): { key: TabKey; label: string; icon: string; group: number }[] {
  return [
    { key: "home", label: t("nav.home"), icon: "", group: 0 },
    { key: "jingling", label: t("care.brand"), icon: "🐳", group: 0 },
    { key: "pet", label: t("nav.pet"), icon: "🐾", group: 0 },
    { key: "chat", label: t("nav.chat"), icon: "💬", group: 0 },
    { key: "pomodoro", label: t("nav.pomodoro"), icon: "🍅", group: 0 },
    { key: "growth", label: t("nav.growth"), icon: "🌟", group: 1 },
    { key: "appearance", label: t("nav.appearance"), icon: "🎨", group: 2 },
    { key: "shop", label: t("nav.shop"), icon: "🪙", group: 2 },
    { key: "market", label: t("nav.market"), icon: "🛒", group: 2 },
    { key: "personality", label: t("nav.personality"), icon: "🎭", group: 3 },
    { key: "model", label: t("nav.model"), icon: "🧠", group: 3 },
    { key: "commands", label: t("nav.commands"), icon: "⚡", group: 3 },
    { key: "calendar", label: t("nav.calendar"), icon: "📅", group: 3 },
    { key: "notes", label: t("nav.notes"), icon: "✅", group: 3 },
    { key: "about", label: t("nav.about"), icon: "ℹ️", group: 3 },
  ];
}

export function SettingsPanel(props: { close: () => void; t?: unknown }) {
  ensureFx();
  const [active, setActive] = useState<TabKey>("home");
  // Apply the buddy theme so the settings content gets the same --buddy-*
  // tokens the pet floater uses (otherwise inputs/borders render unstyled).
  const { data } = useBuddySnapshot(10_000);
  const themeVars = THEMES[data?.config?.skin === "light" ? "light" : "dark"];

  // Follow language changes immediately: setLang, then force one extra render
  // (the poll's own render still saw the OLD dictionary).
  const polledLang = data?.config?.language;
  const [, bumpLang] = useState(0);
  useEffect(() => {
    if (polledLang) {
      setLang(polledLang);
      bumpLang((n) => n + 1);
    }
  }, [polledLang]);

  const TABS = getTabs();
  const content = (() => {
    switch (active) {
      case "home": return <CompanionHomeTab openSection={(key) => setActive(key)} />;
      case "jingling": return <JinglingTab />;
      case "pet": return <PetTab />;
      case "growth": return <GrowthTab />;
      case "shop": return <ShopTab />;
      case "appearance": return <AppearanceTab />;
      case "commands": return <CommandsTab />;
      case "personality": return <PersonalityTab />;
      case "model": return <ModelTab />;
      case "pomodoro": return <PomodoroTab close={props.close} />;
      case "chat": return <ChatTab />;
      case "calendar": return <CalendarTab />;
      case "notes": return <NotesTab />;
      case "market": return <MarketTab />;
      case "about": return <AboutTab />;
    }
  })();

  /** Primary categories for the two-level top navigation. */
  const GROUP_LABELS: Record<number, string> = {
    0: t("nav.main.companion"),
    1: t("nav.main.growth"),
    2: t("nav.main.customize"),
    3: t("nav.main.settings"),
  };

  // Cluster consecutive same-group tabs into atomic units: caption + buttons
  // travel together when the bar wraps, so a label can never be orphaned at
  // the end of a line or split from its own buttons mid-group.
  type Cluster = { group: number; label?: string; tabs: typeof TABS };
  const clusters: Cluster[] = [];
  for (const tab of TABS) {
    const last = clusters[clusters.length - 1];
    if (last && last.group === tab.group) last.tabs.push(tab);
    else clusters.push({ group: tab.group, label: GROUP_LABELS[tab.group], tabs: [tab] });
  }

  const activeCluster = clusters.find((cluster) => cluster.tabs.some((tab) => tab.key === active)) ?? clusters[0];

  const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>, current: number) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = activeCluster.tabs;
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
        : (current + delta + tabs.length) % tabs.length;
    setActive(tabs[next].key);
    requestAnimationFrame(() => document.getElementById(`dshb-tab-${tabs[next].key}`)?.focus());
  };

  return (
    <div className="dshb-settings" style={themeVars}>
      <nav className="dshb-settings-nav" aria-label="DSHBuddy">
        <div className="dshb-settings-groups">
          {clusters.map((cluster) => {
            const selected = cluster.group === activeCluster.group;
            return (
              <button
                key={cluster.group}
                type="button"
                className={`dshb-settings-group-btn${selected ? " dshb-on" : ""}`}
                aria-pressed={selected}
                onClick={() => { if (!selected) setActive(cluster.tabs[0].key); }}
              >
                {cluster.label}
              </button>
            );
          })}
        </div>
        <div className="dshb-settings-subnav dshb-scroll" role="tablist" aria-label={activeCluster.label}>
            {activeCluster.tabs.map((tab, tabIndex) => {
              const isActive = active === tab.key;
              return (
                <button
                  key={tab.key}
                  id={`dshb-tab-${tab.key}`}
                  onClick={() => setActive(tab.key)}
                  onKeyDown={(event) => moveTab(event, tabIndex)}
                  className={`dshb-settings-tab${isActive ? " dshb-on" : ""}`}
                  title={tab.label}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls="dshb-settings-content"
                  tabIndex={isActive ? 0 : -1}
                >
                  {tab.icon && <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>{tab.icon}</span>}
                  <span>{tab.label}</span>
                </button>
              );
            })}
        </div>
      </nav>
      <main id="dshb-settings-content" className="dshb-settings-content" role="tabpanel" aria-labelledby={`dshb-tab-${active}`}>
        <div key={active}>{content}</div>
      </main>
    </div>
  );
}
