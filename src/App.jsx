import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import "./index.css";
import {
  Check,
  ArrowLeft,
  ChevronRight,
  Clock3,
  EyeOff,
  Settings,
  Mic2,
  Languages,
  History,
  Clipboard,
  AudioLines,
  MessagesSquare,
  Play,
  Pause,
  Square,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useToast } from "./components/ui/Toast";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useHotkey } from "./hooks/useHotkey";
import { useMicLevel } from "./hooks/useMicLevel";
import { ReadAloudPlayer } from "./helpers/readAloudPlayer";
import { ConversePlayer } from "./helpers/conversePlayer";
import { LANGUAGE_OPTIONS, getLanguageLabel } from "./utils/languages";
import { buildQuickLanguageCodes, readSpokenLanguages } from "./utils/spokenLanguages";
import { DEFAULT_READ_ALOUD_HOTKEY } from "./utils/hotkeys";
import {
  CONVERSE_VOICE_STORAGE_KEY,
  READ_ALOUD_VOICE_STORAGE_KEY,
  readStoredVoiceId,
} from "./models/kokoroVoices";

const OVERLAY_SNOOZE_DURATION_MS = 60 * 60 * 1000;
// Delay between showing the "overlay hidden" toast and actually hiding, so the
// user sees where the overlay can be turned back on before it disappears.
const OVERLAY_HIDE_TOAST_MS = 1800;
const LAST_TRANSCRIPT_KEY = "lastTranscriptText";
const CONTROL_PANEL_PAGE_KEY = "controlPanelInitialPage";
const CONTROL_PANEL_SETTINGS_TAB_KEY = "controlPanelInitialSettingsTab";

/**
 * Player states the overlay shows a pill for. Everything else - idle, stopped,
 * finished - means there is nothing being read, and the overlay goes back to
 * being just the dictation button.
 */
const READ_ALOUD_VISIBLE_STATUSES = new Set([
  "splitting",
  "loading-engine",
  "synthesizing",
  "playing",
  "paused",
  "error",
]);

const READ_ALOUD_STATUS_LABELS = {
  splitting: "Preparing",
  "loading-engine": "Preparing",
  synthesizing: "Preparing",
  playing: "Reading aloud",
  paused: "Paused",
  error: "Could not read that",
};

/**
 * What the pill says when a read hotkey captured nothing. Without this the
 * press is completely silent, and an empty selection is indistinguishable from
 * a shortcut that never fired.
 *
 * "non-english" is deliberately not in this table: its wording depends on the
 * detected language name carried on the event, so it is built where it is
 * rendered instead of contorting this fixed-string table to hold a template.
 */
const READ_ALOUD_NOTICE_LABELS = {
  "empty-selection": "Nothing selected",
  unsupported: "Cannot read selections here",
};

/** Recognised reasons - anything else is silently ignored, see the handler below. */
const READ_ALOUD_KNOWN_NOTICE_REASONS = new Set([
  ...Object.keys(READ_ALOUD_NOTICE_LABELS),
  "non-english",
]);

/**
 * The bundled Read Aloud voices only speak English phonemes, so confidently
 * non-English text is blocked before synthesis rather than mispronounced.
 * `languageName` is missing only if the main process's guard somehow blocked
 * without naming a language - the sentence still has to make sense then.
 */
function nonEnglishNoticeLabel(languageName) {
  return languageName
    ? `Looks like ${languageName}, Read Aloud speaks English only`
    : "Read Aloud speaks English only";
}

/** Long enough to read, short enough to never sit in front of the next dictation. */
const READ_ALOUD_NOTICE_MS = 2500;

/**
 * The Converse state machine's own word for what is happening, capitalized.
 * The overlay says the state rather than interpreting it; the Converse page
 * carries the sentence that explains what each state means.
 */
const CONVERSE_STATUS_LABELS = {
  idle: "Idle",
  thinking: "Thinking",
  speaking: "Speaking",
  listening: "Listening",
};

/**
 * ── The overlay's geometry, in one place ───────────────────────────────────
 *
 * The overlay used to be three unrelated artifacts sharing a window: a round
 * button, a wide floating capsule for Read Aloud, and a Converse pill, each
 * with its own width, its own corner radius and its own gap. On screen they
 * read as three windows stacked on one another rather than as one control.
 *
 * There is one rule now, and everything below is derived from it:
 *
 *   The dictation button is the anchor. Every surface the overlay shows is a
 *   row in a single fixed-width column that is docked to the top of that
 *   button, and every corner in the overlay is drawn with the button's own
 *   radius.
 *
 * Fixed width, not shrink-to-fit, because the rows change content constantly -
 * "Reading aloud" becomes "Paused", a sentence gets longer, a counter reaches
 * two digits - and a column that resized on each of those would be a fidget
 * sitting on top of the thing the user is dictating into. The slot is the same
 * size in every state, so state changes happen inside it instead of moving it.
 */

/** Every overlay row is this wide. 400px window, 24px of air on each side. */
const OVERLAY_COLUMN_W = 352;

/**
 * The dictation button's radius, and therefore every radius in the overlay.
 * CSS clamps a corner to half the box, so one number gives a 44px button a
 * circle, a 32px status row a pill, and the taller player panel corners that
 * are exactly the button's arc. One rule, the whole family.
 */
const OVERLAY_RADIUS = 22;

/** Between stacked rows. Small enough to read as one column, not two cards. */
const OVERLAY_ROW_GAP = 6;

/**
 * The button's top edge, measured up from the window's bottom. The button sits
 * at bottom:42 inside a 16px hover buffer and is 44px tall: 42 + 16 + 44.
 */
const OVERLAY_BUTTON_TOP = 102;

/**
 * How far the button's cap sits *inside* the bottom row. Tangent shapes touch
 * at a point and still read as two; an overlap makes the button emerge from
 * the column as one silhouette. The button paints over the column (z-index
 * below), so nothing of it is ever covered.
 */
const OVERLAY_DOCK_OVERLAP = 10;

const OVERLAY_STACK_BOTTOM = OVERLAY_BUTTON_TOP - OVERLAY_DOCK_OVERLAP;

/**
 * Extra bottom padding on whichever row is docked, so its content stops above
 * the button's cap instead of being bitten into by it.
 */
const OVERLAY_DOCK_PAD = 20;

/**
 * The material every row and the command menu are made of: `--color-muted` at
 * 96%, a hairline white border, the same blur and the same shadow, so they are
 * recognisably the same surface caught in different states. The dictation
 * button deliberately sits outside this - see getMicButtonStyles.
 */
const OVERLAY_SURFACE_CLASS =
  "border border-white/12 bg-muted/96 text-white shadow-[0_12px_30px_rgba(0,0,0,0.38)] backdrop-blur-xl";

/**
 * One entrance for every surface, growing from the anchor. Rows and the menu
 * both use it, so opening the menu and starting a read are the same gesture.
 */
const OVERLAY_SURFACE_ANIMATION = "overlay-surface-in 180ms cubic-bezier(0.22, 1, 0.36, 1)";

/** Shared trailing-control button: same target, same feedback, every row. */
const OVERLAY_CONTROL_CLASS =
  "rounded-full p-1 text-white/72 transition-colors duration-150 hover:bg-white/6 hover:text-white focus:outline-none focus:bg-white/6";

/**
 * The style a row carries. `docked` is true for the bottom row only - the one
 * the button is actually attached to.
 */
function overlayRowStyle({ docked, interactive }) {
  return {
    borderRadius: OVERLAY_RADIUS,
    paddingBottom: docked ? OVERLAY_DOCK_PAD : undefined,
    transformOrigin: "bottom center",
    animation: OVERLAY_SURFACE_ANIMATION,
    pointerEvents: interactive ? "auto" : "none",
  };
}

const SoundWaveIcon = ({ size = 16, color = "var(--color-primary)" }) => {
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
 * VoiceBars - voice-reactive bar visualiser rendered inside the recording button.
 *
 * Five bars, heights matching logo proportions, driven by micLevel (0-1). Each bar
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
            backgroundColor: "var(--color-background)",
            // Fast transition keeps it responsive; easing keeps it elegant
            transition: "height 60ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          }}
        />
      ))}
    </div>
  );
};

/**
 * MicHalo - the outer ambient glow rendered *around* (not inside) the button.
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
            backgroundColor: "var(--color-primary)",
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
        {trailing === "check" && <Check size={14} className="text-primary shrink-0" />}
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
  const [spokenLanguagesRevision, setSpokenLanguagesRevision] = useState(0);
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
  const interactivityRefreshTimerRef = useRef(null);

  const commandMenuRef = useRef(null);
  const buttonRef = useRef(null);
  const readAloudPillRef = useRef(null);
  const conversePillRef = useRef(null);
  // { player, sync } — the sync call re-samples the player into React state.
  const readAloudRef = useRef(null);
  // Whether the main process is currently holding the transient playback
  // shortcuts. The player is sampled four times a second; without this the
  // renderer would re-ask for the same registration on every tick.
  const readAloudKeysActiveRef = useRef(false);
  const [readAloudState, setReadAloudState] = useState(null);
  // Where the text being read came from, so a clipboard fallback can say so.
  const [readAloudSource, setReadAloudSource] = useState(null);
  // "empty-selection" | "unsupported" | "non-english" while the transient
  // notice pill is up.
  const [readAloudNotice, setReadAloudNotice] = useState(null);
  // The detected language name for a "non-english" notice; unused otherwise.
  const [readAloudNoticeLanguage, setReadAloudNoticeLanguage] = useState(null);
  // { state, playIndex, total } while a Converse session is running, else null.
  const [converseState, setConverseState] = useState(null);
  const { toast } = useToast();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();
  useHotkey();

  // Read Aloud lives in the overlay renderer because that is where playback has
  // to survive the control panel being closed. The player mutates its own state
  // from audio callbacks and IPC continuations, outside React, so the pill
  // mirrors it by sampling — and the sampling interval only exists between a
  // speak() and the end of playback, never while the overlay is idle.
  useEffect(() => {
    const player = new ReadAloudPlayer();

    let pollTimer = null;
    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    // The pause/skip shortcuts exist only while a read does. This is the one
    // place that knows when that starts and stops, so it is what tells the main
    // process — and only on the edges, never on the poll tick in between.
    const syncPlaybackKeys = (active) => {
      if (readAloudKeysActiveRef.current === active) return;
      readAloudKeysActiveRef.current = active;
      void window.electronAPI?.readAloudSetPlaybackActive?.(active, {
        // Read fresh on every edge rather than captured once: the toggle lives
        // in the control panel's localStorage and the overlay is long-lived, so
        // a value read at mount would be stale for the rest of the session.
        // Only an explicit "false" turns it off, so the default is on.
        duckOthers: localStorage.getItem("readAloudDuckOthers") !== "false",
      });
    };

    const sync = () => {
      const state = player.getState();
      const visible = READ_ALOUD_VISIBLE_STATUSES.has(state.status);
      setReadAloudState(visible ? state : null);
      // An errored read has controls to press but nothing to control, so the
      // shortcuts go back to the rest of the machine along with the buttons.
      syncPlaybackKeys(visible && state.status !== "error");
      // The source belongs to the read that is on screen. Dropping it with the
      // pill keeps a finished clipboard read from labelling the next one.
      if (!visible) {
        setReadAloudSource(null);
        stopPolling();
      }
      return state;
    };
    const startPolling = () => {
      sync();
      if (!pollTimer) pollTimer = setInterval(sync, 250);
    };

    readAloudRef.current = { player, sync: startPolling };

    // The picker lives in the control panel, which may not even be open. Rather
    // than plumbing a cross-window event for a value that is only needed at one
    // instant, the voice is re-read from localStorage immediately before every
    // speak() — so the next read always uses the current choice, and a stale or
    // hand-edited value falls back to the default instead of throwing inside
    // Kokoro. speak() clears the buffer cache anyway, so switching mid-session
    // can never replay the old voice.
    const applyStoredVoice = () => {
      player.voice = readStoredVoiceId(READ_ALOUD_VOICE_STORAGE_KEY);
    };
    applyStoredVoice();

    let noticeTimer = null;
    const clearNotice = () => {
      if (noticeTimer) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      setReadAloudNotice(null);
      setReadAloudNoticeLanguage(null);
    };

    // The real feature path: the main process captures the foreground app's
    // selection and pushes the text here. Not gated on the test flag - this is
    // what a user's read hotkey ends up calling.
    const unsubscribeSpeak = window.electronAPI?.onReadAloudSpeak?.((_event, data) => {
      const text = data?.text;
      if (typeof text === "string" && text.trim()) {
        // A real read supersedes whatever the last press had to say.
        clearNotice();
        setReadAloudSource(data?.source ?? null);
        applyStoredVoice();
        player.speak(text);
        startPolling();
      }
    });

    // The transient playback shortcuts. The main process holds the keys; the
    // player lives here, so a press arrives as an op rather than as state.
    const unsubscribeControl = window.electronAPI?.onReadAloudControl?.((_event, data) => {
      const op = data?.op;
      if (op === "toggle") player.toggle();
      else if (op === "back") player.seek(-1);
      else if (op === "forward") player.seek(1);
      else return;
      startPolling();
    });

    // The other half of "the hotkey always answers": a capture with nothing to
    // read still puts the pill on screen, briefly, so the press is visible.
    const unsubscribeNotice = window.electronAPI?.onReadAloudNotice?.((_event, data) => {
      const reason = data?.reason;
      if (!READ_ALOUD_KNOWN_NOTICE_REASONS.has(reason)) return;
      if (noticeTimer) clearTimeout(noticeTimer);
      setReadAloudNotice(reason);
      setReadAloudNoticeLanguage(reason === "non-english" ? (data?.languageName ?? null) : null);
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        setReadAloudNotice(null);
        setReadAloudNoticeLanguage(null);
      }, READ_ALOUD_NOTICE_MS);
    });

    // The overlay is the one window that is always running, so it is what tells
    // the main process whether to hold the Read Aloud shortcut. Settings does
    // the same on change; this covers a cold start.
    void window.electronAPI?.readAloudSyncHotkey?.({
      enabled: localStorage.getItem("readAloudEnabled") === "true",
      hotkey: localStorage.getItem("readAloudHotkey") || DEFAULT_READ_ALOUD_HOTKEY,
    });

    const teardown = () => {
      stopPolling();
      clearNotice();
      syncPlaybackKeys(false);
      readAloudRef.current = null;
      if (typeof unsubscribeSpeak === "function") unsubscribeSpeak();
      if (typeof unsubscribeNotice === "function") unsubscribeNotice();
      if (typeof unsubscribeControl === "function") unsubscribeControl();
      player.dispose();
    };

    if (!window.electronAPI?.readAloudTestEnabled) {
      return teardown;
    }

    window.__readAloudTest = {
      speak: (text) => {
        // No capture happened, so there is no source to attribute this to.
        setReadAloudSource(null);
        applyStoredVoice();
        const result = player.speak(text);
        startPolling();
        return result;
      },
      getState: () => player.getState(),
      getFirstBufferStats: () => player.getBufferStats(0),
      clearCache: () => player.clearCache(),
      pause: () => {
        player.pause();
        sync();
      },
      resume: () => {
        player.resume();
        startPolling();
      },
      seek: (delta) => {
        player.seek(delta);
        sync();
      },
      stop: () => {
        player.stop();
        sync();
      },
    };

    return () => {
      delete window.__readAloudTest;
      teardown();
    };
  }, []);

  // Converse playback lives in the overlay for the same reason Read Aloud does:
  // it has to survive the control panel closing.
  //
  // The pill above the dictation button mirrors the main-process session, which
  // owns the state machine. The overlay learns a conversation exists from the
  // session's own events (a sentence, a turn ending, an interrupt) and only
  // then starts sampling — an overlay that polled on the chance a session might
  // one day start would poll forever for every user who never opens Converse.
  // Sampling backs off to once a second whenever nothing is being spoken.
  useEffect(() => {
    // Same reasoning as Read Aloud's applyStoredVoice above, except the player
    // asks for itself: it re-reads the Converse voice at every turn boundary,
    // so a change made in the control panel is heard on the next answer.
    const player = new ConversePlayer({
      resolveVoice: () => readStoredVoiceId(CONVERSE_VOICE_STORAGE_KEY),
    });
    player.voice = readStoredVoiceId(CONVERSE_VOICE_STORAGE_KEY);
    player.connect();

    let cancelled = false;
    let pollTimer = null;

    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const sample = async () => {
      try {
        const state = await window.electronAPI?.converseGetState?.();
        if (cancelled) return null;
        if (!state || state.running === false || state.state === "stopped") {
          setConverseState(null);
          return null;
        }
        const report = state.player || null;
        const next = {
          state: state.state,
          playIndex: report?.playIndex ?? 0,
          // Only the count the session has finished counting. While the answer
          // is still being written, `known` grows, and a "2 / 5" that turns
          // into "2 / 8" a second later is worse than no number.
          total: report?.total ?? null,
        };
        setConverseState(next);
        return next;
      } catch {
        // A dropped sample leaves the pill as it was; the next tick corrects it.
        return null;
      }
    };

    const loop = async () => {
      pollTimer = null;
      const next = await sample();
      if (cancelled || !next) return;
      const busy = next.state === "speaking" || next.state === "thinking";
      pollTimer = setTimeout(loop, busy ? 250 : 1000);
    };

    const wake = () => {
      if (cancelled || pollTimer) return;
      void loop();
    };

    const unsubscribes = [
      window.electronAPI?.onConverseSentence?.(wake),
      window.electronAPI?.onConverseTurnEnd?.(wake),
      window.electronAPI?.onConverseInterrupt?.(wake),
    ];

    if (window.electronAPI?.readAloudTestEnabled) {
      window.__converseTest = { getPlayerState: () => player.getState() };
    }

    return () => {
      cancelled = true;
      stopPolling();
      for (const off of unsubscribes) {
        if (typeof off === "function") off();
      }
      delete window.__converseTest;
      player.dispose();
    };
  }, []);

  const handleConverseInterrupt = useCallback(() => {
    void window.electronAPI?.converseInterrupt?.("interrupted from the overlay");
  }, []);

  const readAloudPlaying = readAloudState?.playing === true;

  // A clipboard fallback is still worth reading, but it is not what the user
  // highlighted, so the pill names it rather than passing it off as the
  // selection. Only while it is actually being read - "Preparing" and "Paused"
  // are about the player, not about where the text came from.
  const readAloudLabel =
    readAloudSource === "clipboard" && readAloudState?.status === "playing"
      ? "Reading clipboard"
      : READ_ALOUD_STATUS_LABELS[readAloudState?.status] || "Reading aloud";

  // The sentence being spoken, shown under the controls so a read has a place
  // in the text and not just a count. Only once there is one to show: while the
  // player is still splitting or loading the engine there is no sentence yet,
  // and an empty second line would just make the pill twitch.
  const readAloudSentence =
    (readAloudState?.status === "playing" || readAloudState?.status === "paused") &&
    typeof readAloudState?.currentSentence === "string" &&
    readAloudState.currentSentence.trim()
      ? readAloudState.currentSentence.trim()
      : null;

  const handleReadAloudToggle = useCallback(() => {
    const handle = readAloudRef.current;
    if (!handle) return;
    handle.player.toggle();
    handle.sync();
  }, []);

  // Skipping clamps inside the player, so the first and last sentence make
  // these no-ops rather than disabled buttons. A control that greys itself out
  // twice a read is more movement than the read is worth.
  const handleReadAloudBack = useCallback(() => {
    const handle = readAloudRef.current;
    if (!handle) return;
    handle.player.seek(-1);
    handle.sync();
  }, []);

  const handleReadAloudForward = useCallback(() => {
    const handle = readAloudRef.current;
    if (!handle) return;
    handle.player.seek(1);
    handle.sync();
  }, []);

  const handleReadAloudStop = useCallback(() => {
    const handle = readAloudRef.current;
    if (!handle) return;
    handle.player.stop();
    handle.sync();
  }, []);

  useEffect(() => {
    window.electronAPI?.notifyDictationOverlayReady?.();

    // Overlay visibility is owned by the main process (persisted there).
    // Migrate the legacy renderer-owned localStorage flag once, then drop it —
    // the old push-sync here could destroy a freshly re-shown overlay.
    const legacyOverlayDisabled = localStorage.getItem("overlayDisabled");
    if (legacyOverlayDisabled !== null) {
      const migrate =
        window.electronAPI?.migrateLegacyOverlayDisabled?.(legacyOverlayDisabled === "true") ??
        Promise.resolve();
      migrate
        .catch(() => {})
        .then(() => {
          localStorage.removeItem("overlayDisabled");
        });
    }
    // Legacy "hide for 1 hour" timestamp — no longer used.
    localStorage.removeItem("overlayHiddenUntil");

    // Default on: only an explicit "false" disables it (unset === on).
    const overlaySnapToTaskbar = localStorage.getItem("overlaySnapToTaskbar") !== "false";
    window.electronAPI?.setOverlaySnapToTaskbar?.(overlaySnapToTaskbar).catch(() => {});
  }, []);

  const setWindowInteractivity = useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);

  const refreshWindowInteractivity = useCallback(() => {
    window.electronAPI?.refreshMainWindowInteractivity?.().catch(() => {});
  }, []);

  const closeContextMenu = useCallback(
    (shouldReleaseInteractivity = true) => {
      setIsCommandMenuOpen(false);
      setActiveSubmenu("root");
      if (shouldReleaseInteractivity && !isHovered) {
        setWindowInteractivity(false);
      }
    },
    [isHovered, setWindowInteractivity]
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
          await window.electronAPI.openControlPanel({ page, settingsTab });
        }
      } finally {
        closeContextMenu();
      }
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

  // GPU→CPU transcription fallback: tell the user instead of degrading
  // silently. Fires when the CUDA engine fails to start and again when it
  // recovers (automatic retry or manual engine toggle).
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWhisperEngineFallbackChanged?.((_event, data) => {
      if (data?.active) {
        // A Windows block is permanent until the user acts, so it must not
        // promise an automatic retry that will never succeed.
        const blockedByOs = data.kind === "blocked_by_os";
        toast({
          title: blockedByOs ? "Windows blocked the GPU engine" : "Transcribing on CPU",
          description: blockedByOs
            ? "Windows stopped the GPU engine from starting — usually Smart App Control or antivirus. Dictation continues on CPU, just slower. Updating PrivateTranscribe, or allowing the engine in your antivirus, restores GPU speed."
            : "The GPU engine could not start — this can happen during a graphics driver update. Dictation still works, just slower. The GPU will be retried automatically.",
          duration: 10000,
        });
      } else if (data?.recovered) {
        toast({
          title: "GPU transcription restored",
          description: "The CUDA engine started successfully and is back in use.",
          duration: 5000,
        });
      }
    });
    return () => unsubscribe?.();
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
    if (isCommandMenuOpen) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, setWindowInteractivity]);

  useEffect(() => {
    const handleVisibilityReturn = () => {
      if (document.visibilityState === "hidden") {
        return;
      }

      if (interactivityRefreshTimerRef.current) {
        clearTimeout(interactivityRefreshTimerRef.current);
      }

      // Display sleep/wake can leave Electron's forwarded mouse events stale for
      // the transparent overlay. Ask the main process to re-apply the native
      // ignore/forward state when Chromium becomes active again.
      interactivityRefreshTimerRef.current = setTimeout(() => {
        interactivityRefreshTimerRef.current = null;
        refreshWindowInteractivity();
      }, 100);
    };

    document.addEventListener("visibilitychange", handleVisibilityReturn);
    window.addEventListener("pageshow", handleVisibilityReturn);
    window.addEventListener("focus", handleVisibilityReturn);

    return () => {
      if (interactivityRefreshTimerRef.current) {
        clearTimeout(interactivityRefreshTimerRef.current);
        interactivityRefreshTimerRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityReturn);
      window.removeEventListener("pageshow", handleVisibilityReturn);
      window.removeEventListener("focus", handleVisibilityReturn);
    };
  }, [refreshWindowInteractivity]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWindowDragReset?.(() => {
      dragStartPosRef.current = null;
      didMoveRef.current = false;
      dragInitiatedRef.current = false;
      suppressClickAfterDragRef.current = false;
    });
    return () => unsubscribe?.();
  }, []);

  // No resize effect needed: the overlay uses a fixed 400×500 transparent window.
  // Menu, toast, and recording states expand/collapse inside the container via CSS.

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
    window.addEventListener("blur", closeContextMenu);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("blur", closeContextMenu);
    };
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
        } else if (!isDragging) {
          // Don't hide while dragging - releasing Escape mid-drag should just
          // cancel the escape key, not hide the overlay.
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
    isDragging,
  ]);

  // Analytics consent is handled by ControlPanelShell (dashboard window)

  useEffect(() => {
    if (!transcript || !transcript.trim()) {
      return;
    }
    const text = transcript.trim();
    setLastTranscript(text);
    localStorage.setItem(LAST_TRANSCRIPT_KEY, text);
  }, [transcript]);

  useEffect(() => {
    const syncLanguage = () => {
      setSelectedLanguage(localStorage.getItem("preferredLanguage") || "en");
      // The spoken set is read straight from localStorage rather than held in
      // state, so the quick-switch submenu needs a nudge to rebuild after the
      // control panel changes it.
      setSpokenLanguagesRevision((revision) => revision + 1);
    };

    window.addEventListener("focus", syncLanguage);
    window.addEventListener("storage", syncLanguage);
    return () => {
      window.removeEventListener("focus", syncLanguage);
      window.removeEventListener("storage", syncLanguage);
    };
  }, []);

  const quickLanguages = useMemo(() => {
    // The languages the user told us they speak, not a fixed list of the
    // world's most common ones. A Danish/English speaker used to be shown
    // Spanish, French, Portuguese and Japanese, and reached their own second
    // language through Settings.
    const spoken = readSpokenLanguages();
    const codes =
      spoken.length > 0
        ? buildQuickLanguageCodes(spoken, selectedLanguage)
        : // Nothing selected yet (an install that predates the question).
          // Keep the old worldwide shortlist rather than an empty submenu.
          [selectedLanguage, "auto", "en", "es", "fr", "de", "pt", "ja"];
    // Cap at 7 unique entries so the language submenu never overflows the WITH_MENU
    // window height (360 px).
    const uniqueCodes = [...new Set(codes)].slice(0, 7);
    return uniqueCodes
      .map((code) => LANGUAGE_OPTIONS.find((option) => option.value === code))
      .filter(Boolean);
    // spokenLanguagesRevision is a deliberate cache-buster, not a value this
    // memo reads: the spoken set lives in localStorage rather than state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLanguage, spokenLanguagesRevision]);

  const handleSnoozeOverlay = useCallback(() => {
    closeContextMenu();
    const backAt = new Date(Date.now() + OVERLAY_SNOOZE_DURATION_MS).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    toast({
      title: "Overlay hidden for 1 hour",
      description: `Back at ${backAt}. Dictation keeps working — restore it early from the tray icon.`,
      duration: OVERLAY_HIDE_TOAST_MS,
    });
    // Let the toast land before the window disappears.
    setTimeout(() => {
      window.electronAPI?.snoozeOverlay?.(OVERLAY_SNOOZE_DURATION_MS)?.catch?.(() => {});
    }, OVERLAY_HIDE_TOAST_MS);
  }, [closeContextMenu, toast]);

  const handleTurnOverlayOff = useCallback(() => {
    closeContextMenu();
    toast({
      title: "Overlay turned off",
      description: "Dictation keeps working. Turn it back on from the tray icon or Settings.",
      duration: OVERLAY_HIDE_TOAST_MS,
    });
    setTimeout(() => {
      window.electronAPI?.setOverlayMode?.("off")?.catch?.(() => {});
    }, OVERLAY_HIDE_TOAST_MS);
  }, [closeContextMenu, toast]);

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

  // The anchor of the column. It keeps the column's geometry - OVERLAY_RADIUS
  // resolving to a circle at 44px - but not the rows' near-solid fill: the
  // button stays the lighter, translucent pill it has always been, so the thing
  // sitting on the desktop all day does not read as a solid slab.
  const getMicButtonStyles = () => {
    const base = {
      borderRadius: OVERLAY_RADIUS,
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
          border: "1.5px solid var(--color-border)",
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
          backgroundColor: "var(--color-primary)",
          border: "1.5px solid rgba(112, 255, 186, 0.5)",
          boxShadow: "0 0 18px rgba(112, 255, 186, 0.24)",
        };
      case "processing":
        return {
          ...base,
          backgroundColor: "var(--color-surface-3)",
          border: "1.5px solid rgba(112, 255, 186, 0.16)",
          boxShadow: "none",
        };
      default:
        return base;
    }
  };

  // Compute fixed-window position for context menu, clamped to stay in bounds.
  // The overlay is a fixed CONTAINER_W×CONTAINER_H transparent Electron window.
  // The menu must remain within the window bounds (no OS-level repositioning).
  // Direction logic: open upward unless there is less than MENU_EST_HEIGHT px above
  // the button, in which case open downward. This prevents the menu from being
  // clipped or triggering OS window repositioning when the overlay is near the
  // top of the screen.
  const menuStyle = (() => {
    const btn = buttonRef.current;
    if (!btn) return null;
    const rect = btn.getBoundingClientRect();
    const iW = window.innerWidth;
    const iH = window.innerHeight;
    const edge = 8;

    const menuWidth = 248;
    // Conservative estimate of the tallest menu state (root + audio submenu)
    const MENU_EST_HEIGHT = 320;
    // Negative: the menu docks to the button the same way the status column
    // does, overlapping its cap rather than floating a gap away from it.
    const GAP = -OVERLAY_DOCK_OVERLAP;

    const desiredLeft = rect.left + rect.width / 2 - menuWidth / 2;
    const menuLeft = Math.max(edge, Math.min(iW - menuWidth - edge, desiredLeft));

    // Space available above the button (top of button to top of window)
    const spaceAbove = rect.top - edge;
    // Space available below the button (bottom of button to bottom of window)
    const spaceBelow = iH - (rect.bottom + edge);

    if (spaceAbove >= MENU_EST_HEIGHT || spaceAbove >= spaceBelow) {
      // Open upward.
      // CSS `bottom` is distance from container bottom edge.
      // To keep menu within container: iH - bottom - MENU_EST_HEIGHT >= edge
      //   → bottom <= iH - MENU_EST_HEIGHT - edge  (cap to prevent overflow above the container)
      // Also floor at edge so menu doesn't hang below container.
      const menuBottom = iH - rect.top + GAP;
      const clampedBottom = Math.min(iH - MENU_EST_HEIGHT - edge, Math.max(edge, menuBottom));
      return {
        position: "absolute",
        left: menuLeft,
        bottom: clampedBottom,
        // Keeps the last row clear of the button's cap, the same way the
        // docked status row does.
        paddingBottom: OVERLAY_DOCK_PAD,
        transformOrigin: "bottom center",
        pointerEvents: "auto",
      };
    } else {
      // Flip: open downward - clamp so menu doesn't exceed bottom of window
      const menuTop = rect.bottom + GAP;
      const clampedTop = Math.max(edge, Math.min(iH - MENU_EST_HEIGHT - edge, menuTop));
      return {
        position: "absolute",
        left: menuLeft,
        top: clampedTop,
        paddingTop: OVERLAY_DOCK_PAD,
        transformOrigin: "top center",
        pointerEvents: "auto",
      };
    }
  })();

  // The overlay window is click-through except where it declares an interactive
  // region, so the player's own buttons have to publish their rectangle the way
  // the context menu does. Without this the pill is visible and unclickable.
  useLayoutEffect(() => {
    const pill = readAloudState ? readAloudPillRef.current : null;
    const padding = 8;
    const rect = pill?.getBoundingClientRect();
    const regions = rect
      ? [
          {
            x: rect.x - padding,
            y: rect.y - padding,
            width: rect.width + padding * 2,
            height: rect.height + padding * 2,
          },
        ]
      : [];

    void window.electronAPI?.setMainWindowInteractiveRegions?.("readaloud-player", regions);
  }, [readAloudState]);

  useEffect(() => {
    return () => {
      void window.electronAPI?.setMainWindowInteractiveRegions?.("readaloud-player", []);
    };
  }, []);

  // Same contract for the Converse pill: its Interrupt button is only clickable
  // where the overlay has declared the region.
  useLayoutEffect(() => {
    const pill = converseState ? conversePillRef.current : null;
    const padding = 8;
    const rect = pill?.getBoundingClientRect();
    const regions = rect
      ? [
          {
            x: rect.x - padding,
            y: rect.y - padding,
            width: rect.width + padding * 2,
            height: rect.height + padding * 2,
          },
        ]
      : [];

    void window.electronAPI?.setMainWindowInteractiveRegions?.("converse-player", regions);
    // The Read Aloud state is a dependency even though it is not read here: the
    // Converse row sits above the Read Aloud row in the same column, so a read
    // starting or ending moves it. Without this the region would only catch up
    // on the next Converse poll, leaving Interrupt briefly unclickable.
  }, [converseState, readAloudState, readAloudNotice]);

  useEffect(() => {
    return () => {
      void window.electronAPI?.setMainWindowInteractiveRegions?.("converse-player", []);
    };
  }, []);

  useLayoutEffect(() => {
    const menu = isCommandMenuOpen ? commandMenuRef.current : null;
    const padding = 12;
    const rect = menu?.getBoundingClientRect();
    const regions = rect
      ? [
          {
            x: rect.x - padding,
            y: rect.y - padding,
            width: rect.width + padding * 2,
            height: rect.height + padding * 2,
          },
        ]
      : [];

    void window.electronAPI?.setMainWindowInteractiveRegions?.("overlay-menu", regions);
  }, [activeSubmenu, isCommandMenuOpen]);

  useEffect(() => {
    return () => {
      void window.electronAPI?.setMainWindowInteractiveRegions?.("overlay-menu", []);
    };
  }, []);

  // Which row the button is actually attached to. The column is built top-down,
  // so this is whichever row renders last, and it is the only one that carries
  // the dock padding.
  const noticeRowVisible = Boolean(!readAloudState && readAloudNotice);
  const dockedRow = readAloudState
    ? "player"
    : noticeRowVisible
      ? "notice"
      : converseState
        ? "converse"
        : null;

  return (
    <div className="dictation-window">
      <style>{`
        @keyframes overlay-surface-in {
          from {
            opacity: 0;
            transform: translateY(6px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>

      {/*
        Absolute-position root: fills the fixed 400×500 transparent Electron window.
        pointer-events: none on the root so transparent areas stay click-through;
        pointer-events: auto re-enabled only on interactive children (button, menu, toast).
      */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none" }}>
        {/*
          Button anchor: positioned at bottom:58px, horizontally centered in the fixed
          400×500 container. The 16px padding provides a hover buffer without affecting
          the button's visual position. Menu expands upward; toast appears above via
          ToastViewport. The container never resizes - all state changes use CSS only.
        */}
        <div
          style={{
            position: "absolute",
            bottom: 42,
            left: "50%",
            transform: "translateX(-50%)",
            padding: 16,
            display: "flex",
            alignItems: "center",
            gap: 8,
            pointerEvents: "none",
            // Above the column, so the button's cap paints over the row it is
            // docked to instead of being clipped by it - and so the row's dock
            // padding never swallows a click meant for the button.
            zIndex: 2,
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
              if (!isCommandMenuOpen) {
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
                <div className="absolute inset-0 rounded-full border border-primary/15" />
              )}
            </button>
          </div>

          {/* Active dictation mode badge - shown when an Action Engine mode override is in effect */}
          {activeDictationMode && !isRecording && !isProcessing && (
            <div
              className={`px-2 py-1 text-[10px] font-medium text-white/55 whitespace-nowrap ${OVERLAY_SURFACE_CLASS}`}
              style={{ pointerEvents: "none", flexShrink: 0, borderRadius: OVERLAY_RADIUS }}
              title={`Active dictation mode: ${activeDictationMode}`}
            >
              {activeDictationMode}
            </div>
          )}
        </div>

        {/*
          The overlay column. One fixed-width stack, docked to the top of the
          dictation button, holding every surface the overlay has to show.
          Converse sits above Read Aloud when both are running, so the order on
          screen is stable and the button never moves.

          The column itself is click-through; each row opts back in only if it
          has something to press.
        */}
        {(readAloudState || noticeRowVisible || converseState) && (
          <div
            style={{
              position: "absolute",
              bottom: OVERLAY_STACK_BOTTOM,
              left: "50%",
              transform: "translateX(-50%)",
              width: OVERLAY_COLUMN_W,
              display: "flex",
              flexDirection: "column",
              gap: OVERLAY_ROW_GAP,
              pointerEvents: "none",
              zIndex: 1,
            }}
          >
            {converseState && (
              <div
                ref={conversePillRef}
                data-testid="converse-overlay-state"
                data-state={converseState.state}
                className={`flex items-center gap-2 px-3 py-2 ${OVERLAY_SURFACE_CLASS}`}
                style={overlayRowStyle({
                  docked: dockedRow === "converse",
                  interactive: true,
                })}
              >
                <MessagesSquare size={14} className="text-primary shrink-0" aria-hidden />
                <span className="text-[12px] font-medium leading-none text-white/90 whitespace-nowrap">
                  Claude Code
                </span>
                <span className="text-[11px] leading-none text-white/45 whitespace-nowrap">
                  {CONVERSE_STATUS_LABELS[converseState.state] || converseState.state}
                </span>

                {converseState.state === "speaking" && converseState.total > 0 && (
                  <span className="text-[11px] leading-none tabular-nums text-white/45 whitespace-nowrap">
                    {Math.min(converseState.playIndex + 1, converseState.total)} /{" "}
                    {converseState.total}
                  </span>
                )}

                {/* Trailing controls sit against the column's right edge in
                    every row, so a control is always in the same place
                    regardless of how long the status text in front of it is. */}
                {converseState.state === "speaking" && (
                  <>
                    <div className="ml-auto h-3.5 w-px bg-white/12" aria-hidden />
                    <button
                      aria-label="Interrupt Claude Code"
                      onClick={handleConverseInterrupt}
                      className={OVERLAY_CONTROL_CLASS}
                    >
                      <Square size={13} fill="currentColor" />
                    </button>
                  </>
                )}
              </div>
            )}

            {readAloudState && (
              <div
                ref={readAloudPillRef}
                data-testid="readaloud-overlay-player"
                className={`flex flex-col gap-1.5 px-3 py-2 ${OVERLAY_SURFACE_CLASS}`}
                style={overlayRowStyle({ docked: dockedRow === "player", interactive: true })}
              >
                <div className="flex items-center gap-2">
                  <AudioLines size={14} className="text-primary shrink-0" aria-hidden />
                  <span className="text-[12px] font-medium leading-none text-white/90 whitespace-nowrap">
                    {readAloudLabel}
                  </span>

                  {readAloudState.sentenceCount > 0 && readAloudState.status !== "error" && (
                    <span className="text-[11px] leading-none tabular-nums text-white/45 whitespace-nowrap">
                      {readAloudState.index + 1} / {readAloudState.sentenceCount}
                    </span>
                  )}

                  {/* ml-auto pins the controls to the column's right edge.
                      Without it they sit against the status label and slide
                      sideways every time it changes width — "Reading aloud" to
                      "Paused" would move the pause button out from under the
                      cursor that just pressed it. */}
                  <div className="ml-auto h-3.5 w-px bg-white/12" aria-hidden />

                  {readAloudState.status !== "error" && (
                    <>
                      <button
                        aria-label="Previous sentence"
                        onClick={handleReadAloudBack}
                        className={OVERLAY_CONTROL_CLASS}
                      >
                        <SkipBack size={13} />
                      </button>

                      <button
                        aria-label={readAloudPlaying ? "Pause reading" : "Resume reading"}
                        onClick={handleReadAloudToggle}
                        className={OVERLAY_CONTROL_CLASS}
                      >
                        {readAloudPlaying ? <Pause size={13} /> : <Play size={13} />}
                      </button>

                      <button
                        aria-label="Next sentence"
                        onClick={handleReadAloudForward}
                        className={OVERLAY_CONTROL_CLASS}
                      >
                        <SkipForward size={13} />
                      </button>
                    </>
                  )}

                  <button
                    aria-label="Stop reading"
                    onClick={handleReadAloudStop}
                    className={OVERLAY_CONTROL_CLASS}
                  >
                    {/* Filled: an outlined square reads as a checkbox, not stop. */}
                    <Square size={13} fill="currentColor" />
                  </button>
                </div>

                {/*
                  The sentence takes the column's width rather than its own: it
                  changes every few seconds, and a row that resized with each
                  one would be a fidget on top of the dictation button.
                */}
                {readAloudSentence && (
                  <span
                    data-testid="readaloud-current-sentence"
                    className="block w-full truncate text-[11px] leading-snug text-white/60"
                    title={readAloudSentence}
                  >
                    {readAloudSentence}
                  </span>
                )}
              </div>
            )}

            {/*
              The same row, in the state a read reaches when there was nothing
              to read. It carries no controls - there is nothing to pause - so
              it stays click-through and disappears on its own, and it never
              renders while a real read owns the slot.
            */}
            {noticeRowVisible && (
              <div
                data-testid="readaloud-overlay-notice"
                data-reason={readAloudNotice}
                className={`flex items-center gap-2 px-3 py-2 ${OVERLAY_SURFACE_CLASS}`}
                style={overlayRowStyle({ docked: dockedRow === "notice", interactive: false })}
              >
                <AudioLines size={14} className="text-white/40 shrink-0" aria-hidden />
                {/* Wraps rather than overflows: a long language name would push
                    "Read Aloud speaks English only" past the column edge. */}
                <span className="text-[12px] font-medium leading-snug text-white/90">
                  {readAloudNotice === "non-english"
                    ? nonEnglishNoticeLabel(readAloudNoticeLanguage)
                    : READ_ALOUD_NOTICE_LABELS[readAloudNotice]}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Context menu: positioned relative to full window, clamped to stay in bounds */}
        {isCommandMenuOpen && menuStyle && (
          <div
            ref={commandMenuRef}
            className={`w-[248px] p-1.5 ${OVERLAY_SURFACE_CLASS}`}
            style={{
              // Same material, same radius, same entrance as the status rows —
              // the menu is this overlay in another state, not another window.
              borderRadius: OVERLAY_RADIUS,
              animation: OVERLAY_SURFACE_ANIMATION,
              // menuStyle carries the transform-origin, because only it knows
              // whether the menu grew up out of the button or down out of it.
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
                <MenuRow
                  icon={EyeOff}
                  label="Hide overlay"
                  trailing="chevron"
                  onClick={() => setActiveSubmenu("hide")}
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

            {activeSubmenu === "hide" && (
              <>
                <MenuRow icon={Clock3} label="Hide for 1 hour" onClick={handleSnoozeOverlay} />
                <MenuRow
                  icon={EyeOff}
                  label="Hide until I turn it back on"
                  onClick={handleTurnOverlayOff}
                />
                <p className="px-2 pt-1.5 pb-1 text-[10.5px] leading-snug text-white/45">
                  Dictation keeps working with your hotkey. Bring the overlay back from the tray
                  icon.
                </p>
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
