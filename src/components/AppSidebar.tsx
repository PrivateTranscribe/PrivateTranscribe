import React, { useState, useEffect } from "react";
import { MessageSquare, Settings, FlaskConical } from "lucide-react";
import { useBetaFeaturesEnabled } from "../utils/betaFeatures";
import { useExperimentalFeatures } from "../utils/experimentalFeatures";
import { navGroups, visibleNavGroups } from "./sidebarNav";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { formatHotkeyLabel } from "../utils/hotkeys";
import FeedbackDialog from "./FeedbackDialog";

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

interface AppSidebarProps {
  activePage: PageId;
  onPageChange: (page: PageId) => void;
  /**
   * Rendered at the top of the sidebar footer, next to the version marker.
   * Used for the update notice so it lives with "which build am I running"
   * instead of competing with the brand in the title bar.
   */
  updateSlot?: React.ReactNode;
  /** Opens the Beta features tab in Settings, where the switch is. */
  onOpenBetaFeatures?: () => void;
}

export default function AppSidebar({
  activePage,
  onPageChange,
  updateSlot,
  onOpenBetaFeatures,
}: AppSidebarProps) {
  const [hotkey] = useLocalStorage("dictationKey", "", {
    serialize: String,
    deserialize: String,
  });
  const [betaFeaturesEnabled] = useBetaFeaturesEnabled();
  const [experimentalFeaturesEnabled] = useExperimentalFeatures();
  const [currentVersion, setCurrentVersion] = useState("");
  const [buildLabel, setBuildLabel] = useState("");

  useEffect(() => {
    const getVersion = async () => {
      try {
        const result = await window.electronAPI?.getAppVersion?.();
        if (result && result.version) {
          setCurrentVersion(result.version);
          setBuildLabel(
            result.buildType === "development"
              ? "Development build"
              : result.buildType === "unpacked"
                ? "Unpacked build"
                : result.buildType === "installed"
                  ? "Installed build"
                  : ""
          );
        }
      } catch {}
    };
    getVersion();
  }, []);

  const visibleGroups = visibleNavGroups(navGroups, {
    betaOn: betaFeaturesEnabled,
    experimentalOn: experimentalFeaturesEnabled,
  });

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
        {visibleGroups.map((group, gi) => (
          <div key={gi} style={{ marginBottom: gi < visibleGroups.length - 1 ? "6px" : 0 }}>
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
                </button>
              );
            })}
          </div>
        ))}

        {/* Shown in both states, since this is also where the switch goes back off */}
        <button
          type="button"
          onClick={() => onOpenBetaFeatures?.()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            width: "100%",
            padding: "8px 12px",
            marginTop: "6px",
            backgroundColor: "transparent",
            color: "var(--color-foreground-faint)",
            border: "none",
            borderRadius: "8px",
            borderLeft: "2px solid transparent",
            cursor: "pointer",
            fontSize: "12px",
            textAlign: "left",
            transition: "all 0.15s ease",
            fontFamily: "inherit",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--color-popover)";
            e.currentTarget.style.color = "var(--color-foreground-subtle)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--color-foreground-faint)";
          }}
        >
          <FlaskConical size={15} style={{ opacity: 0.6, flexShrink: 0 }} />
          <span style={{ flex: 1 }}>Beta features</span>
        </button>

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

        {/* Version and runtime build, separate from feature access. */}
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
                color: "var(--color-muted-foreground)",
              }}
            >
              {buildLabel}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
