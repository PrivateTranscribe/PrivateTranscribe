import React from "react";
import WindowControls from "./WindowControls";
import { Button } from "./ui/button";

interface TitleBarProps {
  title?: string;
  showTitle?: boolean;
  children?: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
}

export default function TitleBar({
  title = "",
  showTitle = false,
  children,
  className = "",
  actions,
}: TitleBarProps) {
  const platform =
    typeof window !== "undefined" && window.electronAPI?.getPlatform
      ? window.electronAPI.getPlatform()
      : "darwin";

  const getActionsContent = () => {
    if (!actions) return null;

    if (platform !== "darwin" && React.isValidElement(actions)) {
      const childrenArray = React.Children.toArray(actions.props.children);
      return <>{[...childrenArray].reverse()}</>;
    }

    return actions;
  };

  return (
    <div className={`bg-background border-b border-border select-none ${className}`}>
      <div
        className="flex items-center justify-between h-12 px-4"
        style={{ WebkitAppRegion: "drag" }}
      >
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" }}>
          {/* Brand Logo */}
          {/* Brand Logo */}
          <span
            className="text-[10px] font-medium tracking-wide text-white/50 uppercase"
            style={{ fontSize: "10px" }}
          >
            PrivateTranscribe
          </span>
          {platform !== "darwin" ? (
            <>{getActionsContent()}</>
          ) : (
            <>
              {showTitle && title && (
                <h1 className="text-sm font-semibold text-foreground">{title}</h1>
              )}
              {children}
            </>
          )}
        </div>

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" }}>
          {platform !== "darwin" ? (
            <>
              <WindowControls />
            </>
          ) : (
            <>{actions}</>
          )}
        </div>
      </div>
    </div>
  );
}
