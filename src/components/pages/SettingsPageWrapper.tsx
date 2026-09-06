import { useCallback, useEffect, useState } from "react";
import { Settings } from "lucide-react";
import SettingsPage, { SettingsSectionType } from "../SettingsPage";
import SettingsSearch from "../ui/SettingsSearch";
import type { SettingsSearchEntry } from "../../config/settingsSearchIndex";

/**
 * Scroll to the row a search result names and mark it briefly.
 *
 * Runs after the tab has re-rendered, so the row exists to be found. Every
 * SettingsRow carries its label as `data-settings-label`, which is what makes
 * this one selector work for all of them.
 */
function revealSettingsRow(label: string) {
  requestAnimationFrame(() => {
    const escaped = label.replace(/"/g, '\\"');
    const row = document.querySelector<HTMLElement>(`[data-settings-label="${escaped}"]`);
    if (!row) return;

    // Search must reveal settings inside collapsed optional sections too.
    let disclosure = row.closest("details");
    while (disclosure) {
      disclosure.open = true;
      disclosure = disclosure.parentElement?.closest("details") ?? null;
    }
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    // A short ring, not a pulse: it answers "which one" and then gets out of
    // the way, which is the only job motion has in a dense settings screen.
    row.classList.add("settings-row-found");
    window.setTimeout(() => row.classList.remove("settings-row-found"), 1600);
  });
}

type SettingsTab = {
  id: SettingsSectionType;
  label: string;
};

const getSettingsTabs = (): SettingsTab[] => [
  { id: "general", label: "General" },
  { id: "permissions", label: "Microphone & Permissions" },
  { id: "pro", label: "Pro & Beta" },
  { id: "developer", label: import.meta.env.DEV ? "Developer" : "Data & Storage" },
];

export default function SettingsPageWrapper({
  requestedSection,
  requestId,
  onNavigate,
}: {
  requestedSection?: SettingsSectionType;
  requestId?: number;
  /** Leaves Settings entirely, for results that live on their own page. */
  onNavigate?: (page: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsSectionType>("general");
  const tabs = getSettingsTabs();

  const handleSearchSelect = useCallback(
    (entry: SettingsSearchEntry) => {
      if (entry.page !== "settings") {
        onNavigate?.(entry.page);
        // The destination page owns its own scrolling; the row is still tagged
        // there, so reveal it once that page has mounted.
        revealSettingsRow(entry.label);
        return;
      }
      if (entry.section) setActiveTab(entry.section);
      revealSettingsRow(entry.label);
    },
    [onNavigate]
  );

  useEffect(() => {
    if (requestedSection) {
      setActiveTab(requestedSection);
    }
  }, [requestedSection, requestId]);

  useEffect(() => {
    const requestedSection = localStorage.getItem("controlPanelInitialSettingsTab");
    if (!requestedSection) {
      return;
    }

    const validSections: SettingsSectionType[] = ["general", "permissions", "pro", "developer"];

    if (validSections.includes(requestedSection as SettingsSectionType)) {
      setActiveTab(requestedSection as SettingsSectionType);
    }

    localStorage.removeItem("controlPanelInitialSettingsTab");
  }, []);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Settings size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Settings</h1>
        </div>
        <p className="text-sm text-muted-foreground">Make dictation work your way.</p>
      </div>

      {/* Search sits above the tabs because it crosses them - and crosses out
          of Settings entirely for rows that live on Read Aloud or Converse. */}
      <div className="mb-6 max-w-md">
        <SettingsSearch onSelect={handleSearchSelect} />
      </div>

      {/* Horizontal tab bar */}
      <div className="mb-8 border-b border-border-subtle/50">
        <div className="flex gap-1">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: "8px 16px",
                  fontSize: "13px",
                  fontWeight: isActive ? 500 : 400,
                  color: isActive ? "var(--color-primary)" : "var(--color-muted-foreground)",
                  backgroundColor: "transparent",
                  border: "none",
                  borderBottom: isActive
                    ? "2px solid var(--color-primary)"
                    : "2px solid transparent",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  marginBottom: "-1px",
                  fontFamily: "inherit",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Settings content */}
      <SettingsPage activeSection={activeTab} onNavigate={onNavigate} />
    </div>
  );
}
