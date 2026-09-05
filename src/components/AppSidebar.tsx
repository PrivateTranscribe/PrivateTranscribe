import React, { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Clock,
  Upload,
  Mic,
  BookOpen,
  Brain,
  MessageSquare,
  MessagesSquare,
  AudioLines,
  Zap,
  Settings,
} from "lucide-react";
import { shouldShowProBadge } from "../hooks/useProStatus";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { formatHotkeyLabel } from "../utils/hotkeys";
import FeedbackDialog from "./FeedbackDialog";
import { Badge } from "./ui/badge";

export type PageId =
  | "home"
  | "history"
  | "transcribe"
  | "dictation"
  | "dictionary"
  | "read-aloud"
  | "ai-enhancement"
  | "converse"
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
      { id: "transcribe", label: "Transcribe File", icon: Upload },
    ],
  },
  {
    label: "SPEECH",
    items: [
      { id: "dictation", label: "Dictation", icon: Mic },
      { id: "dictionary", label: "Dictionary", icon: BookOpen },
      {
        id: "read-aloud",
        label: "Read Aloud",
        icon: AudioLines,
        badge: "Beta",
        badgeVariant: "pro",
      },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      {
        id: "ai-enhancement",
        label: "AI Enhancement",
        icon: Brain,
        badge: "Beta",
        badgeVariant: "pro",
      },
      {
        id: "converse",
        label: "Converse",
        icon: MessagesSquare,
        badge: "Beta",
        badgeVariant: "pro",
      },
    ],
  },
  {
    label: "ADVANCED",
    items: [
      {
        id: "action-engine",
        label: "Action Engine",
        icon: Zap,
        badge: "Beta",
        badgeVariant: "pro",
      },
    ],
  },
];

interface AppSidebarProps {
  activePage: PageId;
  onPageChange: (page: PageId) => void;
  /**
   * Rendered at the top of the sidebar footer, next to the version marker.
   * Used for the update notice so it lives with "which build am I running"
   * instead of competing with the brand in the title bar.
   */
  updateSlot?: React.ReactNode;
}

export default function AppSidebar({ activePage, onPageChange, updateSlot }: AppSidebarProps) {
  const [hotkey] = useLocalStorage("dictationKey", "", {
    serialize: String,
    deserialize: String,
  });
  const [currentVersion, setCurrentVersion] = useState("");
  // Re-render when the Pro preview toggle changes so badges update immediately.
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    window.addEventListener("privatetranscribe-pro-preview-changed", handler);
    return () => window.removeEventListener("privatetranscribe-pro-preview-changed", handler);
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

  return (
    <div
      style={{
        width: "220px",
        minWidth: "220px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--color-surface-1)",
        borderRight: "1px solid var(--color-border)",
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
                  color: "var(--color-foreground-faint)",
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
                    backgroundColor: isActive ? "var(--color-surface-raised)" : "transparent",
                    color: isActive ? "var(--color-primary)" : "var(--color-foreground-muted)",
                    border: "none",
                    borderRadius: "8px",
                    borderLeft: isActive
                      ? "2px solid var(--color-primary)"
                      : "2px solid transparent",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: isActive ? 500 : 400,
                    textAlign: "left",
                    transition: "all 0.15s ease",
                    fontFamily: "inherit",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "var(--color-popover)";
                      e.currentTarget.style.color = "var(--color-foreground-subtle)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "var(--color-foreground-muted)";
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
                    <Badge
                      variant={
                        item.badgeVariant === "new"
                          ? "default"
                          : item.badgeVariant === "pro"
                            ? "pro"
                            : "outline"
                      }
                      className="rounded px-1.5 py-px text-[9px] font-semibold tracking-[0.02em]"
                    >
                      {item.badge}
                    </Badge>
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
            backgroundColor: "var(--color-border)",
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
                backgroundColor: isActive ? "var(--color-surface-raised)" : "transparent",
                color: isActive ? "var(--color-primary)" : "var(--color-foreground-muted)",
                border: "none",
                borderRadius: "8px",
                borderLeft: isActive ? "2px solid var(--color-primary)" : "2px solid transparent",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: isActive ? 500 : 400,
                textAlign: "left",
                transition: "all 0.15s ease",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = "var(--color-popover)";
                  e.currentTarget.style.color = "var(--color-foreground-subtle)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = "var(--color-foreground-muted)";
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
          borderTop: "1px solid var(--color-surface-raised)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {updateSlot}

        {/* Hotkey hint */}
        <p
          style={{
            fontSize: "11px",
            color: "var(--color-foreground-faint)",
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          Press{" "}
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              color: "var(--color-foreground-faint)",
              fontWeight: 500,
            }}
          >
            {formatHotkeyLabel(hotkey)}
          </span>{" "}
          to dictate
        </p>

        <FeedbackDialog
          currentVersion={currentVersion}
          source="main-sidebar"
          trigger={
            <button
              type="button"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
                width: "100%",
                padding: "8px 10px",
                borderRadius: "8px",
                border: "1px solid rgba(112,255,186,0.25)",
                backgroundColor: "rgba(112,255,186,0.08)",
                color: "var(--color-primary)",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 600,
                fontFamily: "inherit",
              }}
            >
              <MessageSquare size={14} />
              Send Feedback
            </button>
          }
        />

        {/* Version / early access marker */}
        {currentVersion && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p
              style={{
                fontSize: "10px",
                color: "var(--color-border-hover)",
                margin: 0,
              }}
            >
              v{currentVersion}
            </p>
            <span
              style={{
                fontSize: "9px",
                color: "var(--color-primary)",
                backgroundColor: "rgba(112,255,186,0.08)",
                border: "1px solid rgba(112,255,186,0.16)",
                borderRadius: "999px",
                padding: "2px 6px",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                fontWeight: 700,
              }}
            >
              Early access
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
