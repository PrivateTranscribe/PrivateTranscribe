import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import "./index.css";
import {
  Check,
  ArrowLeft,
  ChevronRight,
  Clock3,
  MessageCircle,
  Settings,
  Mic2,
  Languages,
  History,
  Clipboard,
  AudioLines,
} from "lucide-react";
import { useToast } from "./components/ui/Toast";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useHotkey } from "./hooks/useHotkey";
import { useMicLevel } from "./hooks/useMicLevel";
import { LANGUAGE_OPTIONS, getLanguageLabel } from "./utils/languages";

const OVERLAY_HIDE_DURATION_MS = 60 * 60 * 1000;
const LAST_TRANSCRIPT_KEY = "lastTranscriptText";
const OVERLAY_HIDDEN_UNTIL_KEY = "overlayHiddenUntil";
const CONTROL_PANEL_PAGE_KEY = "controlPanelInitialPage";
const CONTROL_PANEL_SETTINGS_TAB_KEY = "controlPanelInitialSettingsTab";

const SoundWaveIcon = ({ size = 16, color = "#70FFBA" }) => {
  return (
    <div className="flex items-center justify-center gap-[3px]">
      <div
        className="rounded-full"
        style={{ width: size * 0.2, height: size * 0.52, backgroundColor: color }}
      />
      <div
        className="rounded-full"
        style={{ width: size * 0.2, height: size, backgroundColor: color }}
      />
      <div
        className="rounded-full"
        style={{ width: size * 0.2, height: size * 0.52, backgroundColor: color }}
      />
    </div>
  );
};

/**
 * VoiceBars — voice-reactive bar visualiser rendered inside the recording button.
 *
 * Five bars, heights matching logo proportions, driven by micLevel (0–1). Each bar
 * has a subtle phase offset for a natural "breathing" feel when level is low.
 * Colors are dark (primary-foreground) since the button background is mint.
 */
const VoiceBars = ({ micLevel }) => {
  // Phase offsets so bars don't move in perfect unison at low levels
  const phases = [0, Math.PI * 0.5, Math.PI * 0.9, Math.PI * 0.4, Math.PI * 0.7];
  // Resting heights derived from logo proportions (tallest bar = 9px)
  const restingHeights = [2.8, 5.3, 9.0, 6.6, 4.0];
  // Center bar grows most; outer bars grow less
  const growthFactors = [8, 11, 16, 12, 9];
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();

  // Bar height: resting floor (with subtle breathing) + mic-driven component
  const barHeights = phases.map((phase, i) => {
    const breathing = Math.sin((now / 1000) * 1.2 * Math.PI + phase) * 0.8;
    const driven = micLevel * growthFactors[i];
    return Math.max(2, restingHeights[i] + breathing + driven);
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2.5, pointerEvents: "none" }}>
      {barHeights.map((h, i) => (
        <div
          key={i}
          style={{
            width: 2,
            height: h,
            borderRadius: 2,
            backgroundColor: "#080908",
            // Fast transition keeps it responsive; easing keeps it elegant
            transition: "height 60ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          }}
        />
      ))}
    </div>
  );
};

/**
 * MicHalo — the outer ambient glow rendered *around* (not inside) the button.
 *
 * A radial gradient disc that scales and brightens with micLevel, creating a
 * soft "breathing" halo effect. Positioned absolutely; pointer-events: none so
 * it never intercepts click/drag events on the button.
 */
const MicHalo = ({ micLevel }) => {
  const scale = 1 + micLevel * 0.55;
  const opacity = 0.08 + micLevel * 0.52;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        // Slightly larger than the 44px button; centered with negative inset
        width: 68,
        height: 68,
        top: -12,
        left: -12,
        borderRadius: "50%",
        background:
          "radial-gradient(circle, rgba(112,255,186,0.85) 0%, rgba(112,255,186,0.3) 45%, transparent 72%)",
        transform: `scale(${scale})`,
        opacity,
        // 80ms transition matches the mic level smoothing without fighting it
        transition: "transform 80ms ease-out, opacity 80ms ease-out",
        pointerEvents: "none",
        zIndex: -1,
      }}
    />
  );
};

const VoiceWaveIndicator = ({ isListening }) => {
  // Static heights (non-listening) and animated heights (listening) matching logo proportions
  const staticHeights = ["6px", "11px", "18px", "13px", "8px"];
  const animatedHeights = ["9px", "16px", "26px", "18px", "11px"];

  return (
    <div className="flex items-center justify-center gap-[2px]">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="w-[3px] rounded-full transition-all duration-150"
          style={{
            backgroundColor: "#70FFBA",
            height: isListening ? animatedHeights[i] : staticHeights[i],
            animation: isListening
              ? `wave-bar-${i} 0.6s ease-in-out ${i * 0.1}s infinite alternate`
              : "none",
          }}
        />
      ))}
      <style>{`
        @keyframes wave-bar-0 { 0% { height: 6px; } 100% { height: 9px; } }
        @keyframes wave-bar-1 { 0% { height: 8px; } 100% { height: 16px; } }
        @keyframes wave-bar-2 { 0% { height: 10px; } 100% { height: 26px; } }
        @keyframes wave-bar-3 { 0% { height: 8px; } 100% { height: 18px; } }
        @keyframes wave-bar-4 { 0% { height: 6px; } 100% { height: 11px; } }
      `}</style>
    </div>
  );
};

// eslint-disable-next-line no-unused-vars
const MenuRow = ({ icon: Icon, label, hint, trailing, disabled = false, onClick }) => {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 rounded-lg transition-all duration-150 focus:outline-none ${
        disabled
          ? "opacity-45 cursor-not-allowed"
          : "hover:bg-white/6 focus:bg-white/6 active:scale-[0.995] cursor-pointer"
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-white/72 shrink-0" />
        <span className="flex-1 min-w-0 text-[13px] font-medium text-white/90 leading-tight truncate">
          {label}
        </span>

        {hint && <span className="text-[11px] text-white/45 whitespace-nowrap">{hint}</span>}
        {trailing === "chevron" && <ChevronRight size={14} className="text-white/45 shrink-0" />}
        {trailing === "check" && <Check size={14} className="text-[#70FFBA] shrink-0" />}
      </div>
    </button>
  );
};

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState("root");
  // Active dictation mode set by an Action Engine "dictation-mode" action.
  // null means default (no override active).
  const [activeDictationMode, setActiveDictationMode] = useState(null);
  const [selectedLanguage, setSelectedLanguage] = useState(
    () => localStorage.getItem("preferredLanguage") || "en"
  );
  const [lastTranscript, setLastTranscript] = useState(
    () => localStorage.getItem(LAST_TRANSCRIPT_KEY) || ""
  );
  const dragStartPosRef = useRef(null);
  const didMoveRef = useRef(false);
  const dragInitiatedRef = useRef(false);
  const suppressClickAfterDragRef = useRef(false);

  const commandMenuRef = useRef(null);
  const buttonRef = useRef(null);
  const { toast, toastCount } = useToast();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();
  useHotkey();

  const setWindowInteractivity = useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);

  const closeContextMenu = useCallback(
    (shouldReleaseInteractivity = true) => {
      setIsCommandMenuOpen(false);
      setActiveSubmenu("root");
      if (shouldReleaseInteractivity && !isHovered && toastCount === 0) {
        setWindowInteractivity(false);
      }
    },
    [isHovered, toastCount, setWindowInteractivity]
  );

  const openControlPanel = useCallback(
    async ({ page, settingsTab } = {}) => {
      if (page) {
        localStorage.setItem(CONTROL_PANEL_PAGE_KEY, page);
      } else {
        localStorage.removeItem(CONTROL_PANEL_PAGE_KEY);
      }

      if (settingsTab) {
        localStorage.setItem(CONTROL_PANEL_SETTINGS_TAB_KEY, settingsTab);
      } else {
        localStorage.removeItem(CONTROL_PANEL_SETTINGS_TAB_KEY);
      }

      try {
        if (window.electronAPI?.openControlPanel) {
          await window.electronAPI.openControlPanel();
        }
      } finally {
        closeContextMenu();
      }
      window.electronAPI?.analyticsTrack?.("settings_opened");
    },
    [closeContextMenu]
  );

  const handlePasteLastTranscript = useCallback(async () => {
    const text = (lastTranscript || "").trim();
    if (!text) {
      toast({
        title: "No transcript available",
        description: "Record once to enable quick paste.",
      });
      return;
    }

    await window.electronAPI?.pasteText?.(text);
    closeContextMenu();
  }, [lastTranscript, toast, closeContextMenu]);

  const handleDictationToggle = useCallback(() => {
    closeContextMenu();
  }, [closeContextMenu]);

  const {
    isRecording,
    isProcessing,
    transcript,
    toggleListening,
    cancelRecording,
    cancelProcessing,
    audioManagerRef,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
  });

  const micLevel = useMicLevel(audioManagerRef, isRecording);

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: "Hotkey Changed",
        description: data.message,
        duration: 8000,
      });
    });

    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.(() => {
      toast({
        title: "Hotkey Unavailable",
        description: "Could not register hotkey. Please set a different hotkey in Settings.",
        duration: 10000,
      });
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
    };
  }, [toast]);

  // ── Action Engine: dictation-mode events ─────────────────────────────────────
  // A "dictation-mode" action broadcasts this event to switch the active mode
  // profile for subsequent transcriptions.  We surface it as a toast so the
  // user has clear visual feedback, and store it in state for future use
  // (e.g. passing it to the reasoning service).
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onActionEngineDictationMode?.((mode) => {
      const normalised = typeof mode === "string" ? mode.trim() : "";
      setActiveDictationMode(normalised || null);
      // Persist to localStorage so AudioManager (a plain-JS class) can read the
      // active mode without requiring React state to be threaded through the audio
      // pipeline.  Empty string signals "no active mode override".
      localStorage.setItem("activeDictationMode", normalised || "");
      toast({
        title: normalised ? "Dictation mode activated" : "Dictation mode cleared",
        description: normalised ? `Now using "${normalised}" mode.` : "Returned to default mode.",
        duration: 3000,
      });
    });
    return () => unsubscribe?.();
  }, [toast]);
  // ── End Action Engine ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, toastCount, setWindowInteractivity]);

  useEffect(() => {
    const resizeWindow = () => {
      if (isCommandMenuOpen && toastCount > 0) {
        window.electronAPI?.resizeMainWindow?.("EXPANDED");
      } else if (isCommandMenuOpen) {
        window.electronAPI?.resizeMainWindow?.("WITH_MENU");
      } else if (toastCount > 0) {
        window.electronAPI?.resizeMainWindow?.("WITH_TOAST");
      } else {
        window.electronAPI?.resizeMainWindow?.("BASE");
      }
    };
    resizeWindow();
  }, [isCommandMenuOpen, toastCount]);

  useEffect(() => {
    if (!isCommandMenuOpen) {
      return;
    }

    const handleClickOutside = (event) => {
      if (
        commandMenuRef.current &&
        !commandMenuRef.current.contains(event.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target)
      ) {
        closeContextMenu();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCommandMenuOpen, closeContextMenu]);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        if (isCommandMenuOpen) {
          if (activeSubmenu !== "root") {
            setActiveSubmenu("root");
          } else {
            closeContextMenu();
          }
        } else if (isRecording || isProcessing) {
          // Cancel the active recording/processing rather than hiding the overlay.
          // Hiding while recording would leave the audio pipeline running invisibly.
          if (isRecording) {
            cancelRecording();
          } else {
            cancelProcessing();
          }
        } else {
          window.electronAPI?.hideWindow?.();
        }
      }

      if (e.altKey && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void handlePasteLastTranscript();
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [
    isCommandMenuOpen,
    activeSubmenu,
    closeContextMenu,
    handlePasteLastTranscript,
    isRecording,
    isProcessing,
    cancelRecording,
    cancelProcessing,
  ]);

  useEffect(() => {
    // "Hide for 1 hour" is a session-only feature — it should not persist across app restarts.
    // Clear the timer on every startup so the overlay always shows fresh after a restart.
    localStorage.removeItem(OVERLAY_HIDDEN_UNTIL_KEY);
  }, []);

  // Analytics consent is handled by ControlPanelShell (dashboard window)

  // Track recording start
  const prevIsRecordingRef = useRef(false);
  useEffect(() => {
    if (isRecording && !prevIsRecordingRef.current) {
      window.electronAPI?.analyticsTrack?.("transcription_started");
    }
    prevIsRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    if (!transcript || !transcript.trim()) {
      return;
    }
    const text = transcript.trim();
    setLastTranscript(text);
    localStorage.setItem(LAST_TRANSCRIPT_KEY, text);
    window.electronAPI?.analyticsTrack?.("transcription_completed");
  }, [transcript]);

  useEffect(() => {
    const syncLanguage = () => {
      setSelectedLanguage(localStorage.getItem("preferredLanguage") || "en");
    };

    window.addEventListener("focus", syncLanguage);
    window.addEventListener("storage", syncLanguage);
    return () => {
      window.removeEventListener("focus", syncLanguage);
      window.removeEventListener("storage", syncLanguage);
    };
  }, []);

  const quickLanguages = useMemo(() => {
    const preferred = ["auto", "en", "es", "fr", "de", "pt", "ja"];
    const languageCodes = [selectedLanguage, ...preferred];
    // Cap at 7 unique entries so the language submenu never overflows the WITH_MENU
    // window height (360 px).  The selected language always appears first; if it is
    // already in the preferred list it merely moves to the top and the count stays ≤ 7.
    const uniqueCodes = [...new Set(languageCodes)].slice(0, 7);
    return uniqueCodes
      .map((code) => LANGUAGE_OPTIONS.find((option) => option.value === code))
      .filter(Boolean);
  }, [selectedLanguage]);

  const handleHideForHour = useCallback(() => {
    const hideUntil = Date.now() + OVERLAY_HIDE_DURATION_MS;
    localStorage.setItem(OVERLAY_HIDDEN_UNTIL_KEY, String(hideUntil));
    closeContextMenu();
    window.electronAPI?.hideWindow?.();

    toast({
      title: "Overlay hidden",
      description: `Hidden until ${new Date(hideUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`,
      duration: 4000,
    });
  }, [closeContextMenu, toast]);

  const handleContactSupport = useCallback(async () => {
    try {
      const result = await window.electronAPI?.openExternal?.(
        "mailto:support@privatetranscribe.com"
      );
      if (!result?.success) {
        await window.electronAPI?.openExternal?.(
          "https://mail.google.com/mail/?view=cm&to=support@privatetranscribe.com"
        );
      }
    } finally {
      closeContextMenu();
    }
  }, [closeContextMenu]);

  const handleSelectLanguage = useCallback(
    (languageCode) => {
      localStorage.setItem("preferredLanguage", languageCode);
      setSelectedLanguage(languageCode);
      toast({
        title: "Language updated",
        description: `${getLanguageLabel(languageCode)} selected for dictation.`,
        duration: 2500,
      });
      closeContextMenu();
    },
    [toast, closeContextMenu]
  );

  const openAudioInputSettings = useCallback(async () => {
    await window.electronAPI?.openSoundInputSettings?.();
    closeContextMenu();
  }, [closeContextMenu]);

  const openMicrophonePermissions = useCallback(async () => {
    await window.electronAPI?.openMicrophoneSettings?.();
    closeContextMenu();
  }, [closeContextMenu]);

  const getMicState = () => {
    if (isRecording) return "recording";
    if (isProcessing) return "processing";
    if (isHovered && !isRecording && !isProcessing) return "hover";
    return "idle";
  };

  const micState = getMicState();

  const getMicButtonStyles = () => {
    const base = {
      borderRadius: 999,
      width: 44,
      height: 44,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      position: "relative",
      overflow: "hidden",
      transition:
        "background-color 220ms ease, border-color 220ms ease, box-shadow 220ms ease, transform 180ms ease",
      backdropFilter: "blur(12px)",
    };

    switch (micState) {
      case "idle":
        return {
          ...base,
          backgroundColor: "rgba(8, 9, 8, 0.72)",
          border: "1.5px solid #222523",
          boxShadow: "none",
        };
      case "hover":
        return {
          ...base,
          backgroundColor: "rgba(8, 9, 8, 0.82)",
          border: "1.5px solid rgba(112, 255, 186, 0.28)",
          boxShadow: "none",
        };
      case "recording":
        return {
          ...base,
          backgroundColor: "#70FFBA",
          border: "1.5px solid rgba(112, 255, 186, 0.5)",
          boxShadow: "0 0 18px rgba(112, 255, 186, 0.24)",
        };
      case "processing":
        return {
          ...base,
          backgroundColor: "#1A2E26",
          border: "1.5px solid rgba(112, 255, 186, 0.16)",
          boxShadow: "none",
        };
      default:
        return base;
    }
  };

  // Compute fixed-window position for context menu, clamped to stay in bounds.
  const menuStyle = (() => {
    const btn = buttonRef.current;
    if (!btn) return null;
    const rect = btn.getBoundingClientRect();
    const iW = window.innerWidth;
    const iH = window.innerHeight;
    const edge = 8;

    const menuWidth = 248;
    const desiredLeft = rect.left + rect.width / 2 - menuWidth / 2;
    const menuLeft = Math.max(edge, Math.min(iW - menuWidth - edge, desiredLeft));
    const menuBottom = iH - rect.top + 12;

    return {
      position: "absolute",
      left: menuLeft,
      bottom: menuBottom,
      pointerEvents: "auto",
    };
  })();

  const toastWidthDelta = 380 - 96;
  const toastWouldOverflowRight =
    typeof window !== "undefined" && window.screenX + 380 > window.screen.width;
  const keepMicAnchoredRight = !isCommandMenuOpen && toastCount > 0 && toastWouldOverflowRight;

  return (
    <div className="dictation-window">
      <style>{`
        @keyframes overlay-menu-in {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>

      {/*
        Absolute-position root: fills the entire Electron window.
        pointer-events: none on the root so transparent areas stay click-through;
        pointer-events: auto re-enabled on the icon anchor only.
        This ensures the icon at bottom: 58 / left: 58 never shifts due to sibling
        elements (cancel button, menu) entering or leaving the DOM.
      */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none" }}>
        {/*
          Hover container: 16px padding around icon expands the hit-area so moving
          the cursor toward the cancel button doesn't immediately leave hover state.
          bottom: 42 + padding 16 = icon visually at bottom:58 = (160-44)/2 (centered).
          left:   42 + padding 16 = icon visually at left:58  = (160-44)/2 (centered).
          Button center is 80px from all window edges — 70px halo radius fits on all sides.
          Cancel button lives inside via flexbox — no gap to cross when moving right.
        */}
        <div
          style={{
            position: "absolute",
            bottom: 42,
            left: keepMicAnchoredRight ? 42 + toastWidthDelta : 42,
            padding: 16,
            display: "flex",
            alignItems: "center",
            gap: 8,
            pointerEvents: "none",
          }}
        >
          {/* Wrapper needed for MicHalo to sit outside the overflow:hidden button */}
          <div
            style={{ position: "relative", flexShrink: 0, pointerEvents: "auto" }}
            onMouseEnter={() => {
              setIsHovered(true);
              setWindowInteractivity(true);
            }}
            onMouseLeave={() => {
              setIsHovered(false);
              if (!isCommandMenuOpen && toastCount === 0) {
                setWindowInteractivity(false);
              }
            }}
          >
            {micState === "recording" && <MicHalo micLevel={micLevel} />}

            <button
              ref={buttonRef}
              aria-label="Dictation overlay"
              onMouseDown={(e) => {
                if (e.button !== 0) {
                  return;
                }
                closeContextMenu(false);
                dragStartPosRef.current = { x: e.clientX, y: e.clientY };
                didMoveRef.current = false;
                dragInitiatedRef.current = false;
                suppressClickAfterDragRef.current = false;
              }}
              onMouseMove={(e) => {
                if (dragStartPosRef.current && (e.buttons & 1) === 1) {
                  const dx = e.clientX - dragStartPosRef.current.x;
                  const dy = e.clientY - dragStartPosRef.current.y;
                  if (dx * dx + dy * dy > 25) {
                    didMoveRef.current = true;
                    if (!dragInitiatedRef.current) {
                      dragInitiatedRef.current = true;
                      handleMouseDown(e);
                    }
                  }
                }
              }}
              onMouseUp={(e) => {
                if (dragInitiatedRef.current) {
                  handleMouseUp(e);
                }
                dragInitiatedRef.current = false;
                dragStartPosRef.current = null;

                if (didMoveRef.current) {
                  suppressClickAfterDragRef.current = true;
                  setTimeout(() => {
                    suppressClickAfterDragRef.current = false;
                    didMoveRef.current = false;
                  }, 400);
                }
              }}
              onClick={(e) => {
                if (
                  suppressClickAfterDragRef.current ||
                  didMoveRef.current ||
                  dragInitiatedRef.current
                ) {
                  e.preventDefault();
                  return;
                }
                closeContextMenu(false);
                toggleListening();
                e.preventDefault();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!didMoveRef.current && !suppressClickAfterDragRef.current) {
                  setWindowInteractivity(true);
                  setActiveSubmenu("root");
                  setIsCommandMenuOpen((prev) => !prev);
                }
              }}
              onFocus={() => setIsHovered(true)}
              onBlur={() => setIsHovered(false)}
              style={{
                ...getMicButtonStyles(),
                cursor:
                  micState === "processing" ? "not-allowed" : isDragging ? "grabbing" : "pointer",
              }}
            >
              {micState === "idle" ? (
                <VoiceWaveIndicator isListening={false} />
              ) : micState === "hover" ? (
                <VoiceWaveIndicator isListening={false} />
              ) : micState === "recording" ? (
                <VoiceBars micLevel={micLevel} />
              ) : micState === "processing" ? (
                <VoiceWaveIndicator isListening={true} />
              ) : null}

              {micState === "recording" && (
                <div
                  className="absolute inset-0 rounded-full"
                  style={{
                    border: `1.5px solid rgba(112,255,186,${0.25 + micLevel * 0.4})`,
                    // Subtle scale-pulse at baseline; micLevel adds static lift on top
                    animation: "ring-pulse 2.4s ease-in-out infinite",
                    // Translate ring-pulse scale relative to current halo scale
                    transformOrigin: "center",
                  }}
                />
              )}

              {micState === "processing" && (
                <div className="absolute inset-0 rounded-full border border-[#70FFBA]/15" />
              )}
            </button>
          </div>

          {/* Active dictation mode badge — shown when an Action Engine mode override is in effect */}
          {activeDictationMode && !isRecording && !isProcessing && (
            <div
              className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/10 text-white/55 border border-white/8 whitespace-nowrap"
              style={{ pointerEvents: "none", flexShrink: 0 }}
              title={`Active dictation mode: ${activeDictationMode}`}
            >
              {activeDictationMode}
            </div>
          )}

        </div>

        {/* Context menu: positioned relative to full window, clamped to stay in bounds */}
        {isCommandMenuOpen && menuStyle && (
          <div
            ref={commandMenuRef}
            className="w-[248px] rounded-xl border border-white/12 bg-[#111311]/96 text-white shadow-[0_12px_30px_rgba(0,0,0,0.38)] backdrop-blur-xl p-1.5"
            style={{
              animation: "overlay-menu-in 180ms cubic-bezier(0.22, 1, 0.36, 1)",
              ...menuStyle,
            }}
            onMouseEnter={() => setWindowInteractivity(true)}
          >
            {activeSubmenu !== "root" && (
              <button
                onClick={() => setActiveSubmenu("root")}
                className="w-full mb-1 px-2 py-1.5 rounded-lg hover:bg-white/6 transition-colors text-left text-[12px] text-white/75 flex items-center gap-2"
              >
                <ArrowLeft size={13} />
                Back
              </button>
            )}

            {activeSubmenu === "root" && (
              <>
                <MenuRow icon={Clock3} label="Hide this for 1 hour" onClick={handleHideForHour} />
                <MenuRow
                  icon={MessageCircle}
                  label="Talk to support"
                  onClick={() => void handleContactSupport()}
                />
                <MenuRow
                  icon={Settings}
                  label="Go to settings"
                  onClick={() =>
                    void openControlPanel({ page: "settings", settingsTab: "general" })
                  }
                />

                <div className="h-px bg-white/10 mx-1 my-1.5" />

                <MenuRow
                  icon={Mic2}
                  label="Change microphone"
                  trailing="chevron"
                  onClick={() => setActiveSubmenu("audio")}
                />
                <MenuRow
                  icon={Languages}
                  label="Select language"
                  hint={getLanguageLabel(selectedLanguage)}
                  trailing="chevron"
                  onClick={() => setActiveSubmenu("language")}
                />

                <div className="h-px bg-white/10 mx-1 my-1.5" />

                <MenuRow
                  icon={History}
                  label="View transcript history"
                  onClick={() => void openControlPanel({ page: "history" })}
                />
                <MenuRow
                  icon={Clipboard}
                  label="Paste last transcript"
                  hint="alt + shift + z"
                  disabled={!lastTranscript}
                  onClick={() => void handlePasteLastTranscript()}
                />
              </>
            )}

            {activeSubmenu === "audio" && (
              <>
                <MenuRow
                  icon={AudioLines}
                  label="Open audio input settings"
                  onClick={() => void openAudioInputSettings()}
                />
                <MenuRow
                  icon={Mic2}
                  label="Open microphone privacy"
                  onClick={() => void openMicrophonePermissions()}
                />
                <MenuRow
                  icon={Settings}
                  label="Open PrivateTranscribe microphone settings"
                  onClick={() =>
                    void openControlPanel({ page: "settings", settingsTab: "general" })
                  }
                />
              </>
            )}

            {activeSubmenu === "language" && (
              <>
                {quickLanguages.map((language) => (
                  <MenuRow
                    key={language.value}
                    icon={Languages}
                    label={language.label}
                    trailing={selectedLanguage === language.value ? "check" : undefined}
                    onClick={() => handleSelectLanguage(language.value)}
                  />
                ))}
                <div className="h-px bg-white/10 mx-1 my-1.5" />
                <MenuRow
                  icon={Settings}
                  label="More languages in settings"
                  trailing="chevron"
                  onClick={() =>
                    void openControlPanel({ page: "settings", settingsTab: "preferences" })
                  }
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
