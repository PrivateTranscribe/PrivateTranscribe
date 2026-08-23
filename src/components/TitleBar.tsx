import React from "react";
import WindowControls from "./WindowControls";
import logoSrc from "../assets/icon.svg";

interface TitleBarProps {
  title?: string;
  showTitle?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export default function TitleBar({
  title = "",
  showTitle = false,
  children,
  className = "",
}: TitleBarProps) {
  const platform =
    typeof window !== "undefined" && window.electronAPI?.getPlatform
      ? window.electronAPI.getPlatform()
      : "darwin";

  return (
    <div className={`bg-background border-b border-border select-none ${className}`}>
      <div
        className="flex items-center justify-between h-12 px-4"
        style={{ WebkitAppRegion: "drag" }}
      >
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" }}>
          {/* Brand Logo */}
          <img
            src={logoSrc}
            alt="PrivateTranscribe"
            className="w-4 h-4 flex-shrink-0"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
          <span
            className="text-[10px] font-medium tracking-wide text-white/50 uppercase"
            style={{ fontSize: "10px" }}
          >
            PrivateTranscribe
          </span>
          {showTitle && title && <h1 className="text-sm font-semibold text-foreground">{title}</h1>}
          {children}
        </div>

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" }}>
          {platform !== "darwin" && <WindowControls />}
        </div>
      </div>
    </div>
  );
}
