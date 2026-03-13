import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Clock,
  Upload,
  BookOpen,
  Brain,
  MessageSquare,
  BookMarked,
  Zap,
  Settings,
} from "lucide-react";
import { shouldShowProBadge } from "../hooks/useProStatus";

export type PageId =
  | "home"
  | "history"
  | "transcribe"
  | "dictionary"
  | "ai-enhancement"
  | "voice-assistant"
  | "correction-memory"
  | "action-engine"
  | "settings";

interface NavItem {
  id: PageId;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  badgeVariant?: "new" | "soon" | "pro";
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    items: [
      { id: "home", label: "Home", icon: LayoutDashboard },
      { id: "history", label: "History", icon: Clock },
      { id: "transcribe", label: "Transcribe", icon: Upload },
    ],
  },
  {
    label: "SPEECH",
    items: [
      { id: "dictionary", label: "Dictionary", icon: BookOpen },
      { id: "correction-memory", label: "Corrections", icon: BookMarked },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      {
        id: "ai-enhancement",
        label: "AI Enhancement",
        icon: Brain,
        badge: "Pro",
        badgeVariant: "pro",
      },
      {
        id: "voice-assistant",
        label: "Voice Assistant",
        icon: MessageSquare,
        badge: "Pro",
        badgeVariant: "pro",
      },
    ],
  },
  {
    label: "ADVANCED",
    items: [
      { id: "action-engine", label: "Action Engine", icon: Zap, badge: "Pro", badgeVariant: "pro" },
    ],
  },
];

interface AppSidebarProps {
  activePage: PageId;
  onPageChange: (page: PageId) => void;
}

export default function AppSidebar({ activePage, onPageChange }: AppSidebarProps) {
  const [hotkey, setHotkey] = useState("`");
  const [currentVersion, setCurrentVersion] = useState("");
  // Re-render when the Pro preview toggle changes so badges update immediately.
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    window.addEventListener("privoca-pro-preview-changed", handler);
    return () => window.removeEventListener("privoca-pro-preview-changed", handler);
  }, []);

  useEffect(() => {
    const savedHotkey = localStorage.getItem("dictationKey");
    if (savedHotkey) setHotkey(savedHotkey);
  }, []);

  useEffect(() => {
    const getVersion = async () => {
      try {
        const result = await window.electronAPI?.getAppVersion?.();
        if (result && result.version) setCurrentVersion(result.version);
      } catch {}
    };
    getVersion();
  }, []);

  const formatHotkey = (key: string) => {
    if (!key) return "...";
    const map: Record<string, string> = {
      "`": "` (backtick)",
      " ": "Space",
      Enter: "Enter",
      Escape: "Esc",
    };
    return map[key] || key;
  };

  return (
    <div
      style={{
        width: "220px",
        minWidth: "220px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#0D0F0D",
        borderRight: "1px solid #222523",
        overflow: "hidden",
      }}
    >
      {/* Top padding for navigation */}
      <div style={{ padding: "12px 0 0" }} />

      {/* Navigation */}
      <nav style={{ flex: 1, overflowY: "auto", padding: "8px 8px" }}>
        {navGroups.map((group, gi) => (
          <div key={gi} style={{ marginBottom: gi < navGroups.length - 1 ? "6px" : 0 }}>
            {group.label && (
              <p
                style={{
                  fontSize: "9px",
                  fontWeight: 600,
                  color: "#4A4F4C",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  padding: "12px 12px 6px",
                  margin: 0,
                }}
              >
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              const isActive = activePage === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => onPageChange(item.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    width: "100%",
                    padding: "8px 12px",
                    marginBottom: "2px",
                    backgroundColor: isActive ? "#1A1D1A" : "transparent",
                    color: isActive ? "#70FFBA" : "#8A8F8C",
                    border: "none",
                    borderRadius: "8px",
                    borderLeft: isActive ? "2px solid #70FFBA" : "2px solid transparent",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: isActive ? 500 : 400,
                    textAlign: "left",
                    transition: "all 0.15s ease",
                    fontFamily: "inherit",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "#141614";
                      e.currentTarget.style.color = "#B0B5B2";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "#8A8F8C";
                    }
                  }}
                >
                  <Icon
                    size={16}
                    style={{
                      opacity: isActive ? 1 : 0.6,
                      filter: isActive ? "drop-shadow(0 0 6px rgba(112,255,186,0.4))" : "none",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.badge && (item.badgeVariant !== "pro" || shouldShowProBadge(item.id)) && (
                    <span
                      style={{
                        fontSize: "9px",
                        fontWeight: 600,
                        letterSpacing: "0.02em",
                        padding: "1px 6px",
                        borderRadius: "4px",
                        backgroundColor:
                          item.badgeVariant === "new"
                            ? "rgba(112,255,186,0.15)"
                            : item.badgeVariant === "pro"
                              ? "rgba(168,133,255,0.15)"
                              : "rgba(255,255,255,0.06)",
                        color:
                          item.badgeVariant === "new"
                            ? "#70FFBA"
                            : item.badgeVariant === "pro"
                              ? "#A885FF"
                              : "#6B7370",
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}

        {/* Divider */}
        <div
          style={{
            height: "1px",
            backgroundColor: "#222523",
            margin: "8px 12px",
          }}
        />

        {/* Settings */}
        {(() => {
          const isActive = activePage === "settings";
          return (
            <button
              onClick={() => onPageChange("settings")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                width: "100%",
                padding: "8px 12px",
                backgroundColor: isActive ? "#1A1D1A" : "transparent",
                color: isActive ? "#70FFBA" : "#8A8F8C",
                border: "none",
                borderRadius: "8px",
                borderLeft: isActive ? "2px solid #70FFBA" : "2px solid transparent",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: isActive ? 500 : 400,
                textAlign: "left",
                transition: "all 0.15s ease",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = "#141614";
                  e.currentTarget.style.color = "#B0B5B2";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = "#8A8F8C";
                }
              }}
            >
              <Settings
                size={16}
                style={{
                  opacity: isActive ? 1 : 0.6,
                  filter: isActive ? "drop-shadow(0 0 6px rgba(112,255,186,0.4))" : "none",
                  flexShrink: 0,
                }}
              />
              <span>Settings</span>
            </button>
          );
        })()}
      </nav>

      {/* Footer */}
      <div
        style={{
          padding: "12px 16px 14px",
          borderTop: "1px solid #1A1D1A",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {/* Hotkey hint */}
        <p style={{ fontSize: "11px", color: "#4A4F4C", margin: 0, lineHeight: 1.5 }}>
          Press{" "}
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              color: "#5E6B64",
              fontWeight: 500,
            }}
          >
            {formatHotkey(hotkey)}
          </span>{" "}
          to dictate
        </p>

        {/* Version */}
        {currentVersion && (
          <p
            style={{
              fontSize: "10px",
              color: "#2E332F",
              margin: 0,
            }}
          >
            v{currentVersion}
          </p>
        )}
      </div>
    </div>
  );
}
