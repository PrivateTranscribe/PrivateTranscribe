import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import SettingsPage, { SettingsSectionType } from "../SettingsPage";

type SettingsTab = {
  id: SettingsSectionType;
  label: string;
};

const getSettingsTabs = (): SettingsTab[] => [
  { id: "general", label: "General" },
  { id: "preferences", label: "Preferences" },
  { id: "transcription", label: "Transcription" },
  { id: "permissions", label: "Permissions" },
  { id: "pro", label: "PrivateTranscribe Pro" },
  { id: "help", label: "Help & Support" },
  { id: "developer", label: import.meta.env.DEV ? "Developer" : "Data & Storage" },
];

export default function SettingsPageWrapper() {
  const [activeTab, setActiveTab] = useState<SettingsSectionType>("general");
  const tabs = getSettingsTabs();

  useEffect(() => {
    const requestedSection = localStorage.getItem("controlPanelInitialSettingsTab");
    if (!requestedSection) {
      return;
    }

    const validSections: SettingsSectionType[] = [
      "general",
      "preferences",
      "transcription",
      "permissions",
      "pro",
      "help",
      "developer",
    ];

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
        <p className="text-sm text-muted-foreground">
          Configure transcription, hotkeys, permissions, and advanced options
        </p>
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
                  color: isActive ? "#70FFBA" : "#6B7370",
                  backgroundColor: "transparent",
                  border: "none",
                  borderBottom: isActive ? "2px solid #70FFBA" : "2px solid transparent",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  marginBottom: "-1px",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.color = "#B0B5B2";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.color = "#6B7370";
                  }
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Settings content */}
      <SettingsPage activeSection={activeTab} />
    </div>
  );
}
