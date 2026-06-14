import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Command, Flame, Gauge, Settings, Timer, Upload } from "lucide-react";
import { PageId } from "../AppSidebar";
import {
  useTranscriptions,
  useTranscriptionsVersion,
  initializeTranscriptions,
} from "../../stores/transcriptionStore";
import { useSettings } from "../../hooks/useSettings";
import TranscriptionItem from "../ui/TranscriptionItem";
import { LANGUAGE_OPTIONS } from "../../utils/languages";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { isBuiltInMicrophone } from "../../utils/audioDeviceUtils";
import type { AggregateStats } from "../../types/electron";
import logger from "../../utils/logger";

interface DashboardPageProps {
  onNavigate: (page: PageId) => void;
}

type EngineStatus = {
  desiredMode?: "cpu" | "gpu";
  effectiveEngine?: "cuda" | "cpu" | "unknown" | "stopped";
  fallback?: {
    active?: boolean;
    reason?: string | null;
  };
  transition?: "starting" | "transcribing" | "idle" | "stopped";
};

type CudaBinaryStatus = {
  installed: boolean;
  supported: boolean;
  upToDate: boolean;
  forceCpu: boolean;
  engineStatus?: EngineStatus | null;
};

type AudioInputDevice = {
  deviceId: string;
  label: string;
};

// eslint-disable-next-line react-refresh/only-export-components
export function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Parse a UTC timestamp string from SQLite into a JS Date.
 *
 * SQLite's CURRENT_TIMESTAMP returns strings like "2026-03-23 14:00:00" (UTC,
 * space-separated, no timezone suffix).  V8/Chromium treats a space-separated
 * date-time string with no timezone as *local* time, not UTC — so passing it
 * directly to `new Date()` shifts every date key by the local UTC offset.
 *
 * For a UTC-5 user who dictates after 7 PM, the UTC timestamp crosses midnight
 * and gets attributed to the *next* local day, so yesterday's dictation never
 * appears in "yesterday's" slot and the streak drops to 1.
 *
 * Appending "Z" after replacing the space with "T" produces a valid ISO 8601
 * UTC string ("2026-03-23T14:00:00Z") that V8 parses as UTC unambiguously.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function parseUtcTimestamp(ts: string): Date {
  // If already has timezone info (T…Z, T…+HH, T…-HH) leave it alone.
  if (/[TZ]/.test(ts) || /[+-]\d{2}:\d{2}$/.test(ts)) {
    return new Date(ts);
  }
  // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"
  return new Date(ts.replace(" ", "T") + "Z");
}

/**
 * Compute the current streak from a set of "YYYY-MM-DD" date keys that had real dictation.
 *
 * The date keys come from the database (via getStreakDates) which returns ALL qualifying days
 * rather than the paginated in-memory history list. This prevents the streak from resetting
 * when the display history window (e.g. 50 items) fills up and evicts older entries.
 *
 * There is no upper cap - the streak grows indefinitely with daily use.
 *
 * Grace-window rules:
 *  - activity today → anchor on today, count backwards
 *  - no activity today but activity yesterday → streak still alive, anchor on yesterday
 *  - otherwise → streak is broken (returns 0)
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeStreak(activeDates: Set<string>): number {
  if (activeDates.size === 0) return 0;

  const today = new Date();
  const todayKey = toLocalDateKey(today);

  const anchor = new Date(today);
  if (!activeDates.has(todayKey)) {
    anchor.setDate(anchor.getDate() - 1);
    if (!activeDates.has(toLocalDateKey(anchor))) {
      return 0;
    }
  }

  let streak = 0;
  while (activeDates.has(toLocalDateKey(anchor))) {
    streak++;
    anchor.setDate(anchor.getDate() - 1);
  }

  return streak;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatSpeakingTime(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${Math.round(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export default function DashboardPage({ onNavigate }: DashboardPageProps) {
  const transcriptions = useTranscriptions();
  const transcriptionsVersion = useTranscriptionsVersion();
  const {
    whisperModel,
    preferredLanguage,
    useLocalWhisper,
    localTranscriptionProvider,
    cloudTranscriptionProvider,
    whisperForceCpu,
    preferBuiltInMic,
    selectedMicDeviceId,
    historyLimit,
    dictationKey,
  } = useSettings();

  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stats, setStats] = useState<AggregateStats>({
    total_words: 0,
    total_transcriptions: 0,
    total_seconds: 0,
    average_wpm: 0,
  });
  const [streakDates, setStreakDates] = useState<Set<string>>(new Set());
  const [cudaStatus, setCudaStatus] = useState<CudaBinaryStatus | null>(null);
  const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>([]);

  useEffect(() => {
    // Fetch transcriptions based on history limit setting
    initializeTranscriptions(historyLimit);

    // Fetch aggregate stats from database
    const fetchStats = async () => {
      try {
        const dbStats = await window.electronAPI?.getStats?.();
        if (dbStats) {
          setStats(dbStats);
        }
      } catch (error) {
        console.error("Failed to fetch stats:", error);
      }
    };
    fetchStats();
  }, [historyLimit]);

  // Re-fetch stats and streak dates whenever any transcription mutation occurs (add/delete/clear).
  // Streak dates are fetched from the database independently of the paginated history list so
  // that adding many transcriptions today cannot evict yesterday's data from the in-memory
  // window and incorrectly reset the streak counter.
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const dbStats = await window.electronAPI?.getStats?.();
        if (dbStats) {
          setStats(dbStats);
        }
      } catch {
        // Silently fail
      }
    };
    const fetchStreakDates = async () => {
      try {
        const timestamps = await window.electronAPI?.getStreakDates?.();
        if (Array.isArray(timestamps)) {
          // Convert raw UTC timestamps to local date keys in JS (reliable cross-platform).
          // SQLite's CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" (UTC, no timezone).
          // V8/Chromium treats a space-separated string without timezone as *local* time,
          // so we use parseUtcTimestamp() to force UTC interpretation before extracting
          // the local date. Without this, users in UTC-5 would see dictations made after
          // 7 PM attributed to the next day, causing the streak to reset to 1.
          const localDateKeys = new Set(
            timestamps.map((ts) => toLocalDateKey(parseUtcTimestamp(ts)))
          );
          void logger.debug(
            `[streak] fetched ${timestamps.length} timestamp(s), ${localDateKeys.size} unique day(s)`,
            {
              sample: timestamps.slice(0, 3),
              dateKeys: [...localDateKeys].slice(0, 5),
              localTzOffset: new Date().getTimezoneOffset(),
            },
            "streak"
          );
          setStreakDates(localDateKeys);
        }
      } catch (err) {
        void logger.error("[streak] fetchStreakDates failed", { err }, "streak");
      }
    };
    fetchStats();
    fetchStreakDates();
  }, [transcriptionsVersion]);

  useEffect(() => {
    if (!useLocalWhisper || localTranscriptionProvider !== "whisper") {
      setCudaStatus(null);
      return;
    }

    let cancelled = false;
    const fetchCudaStatus = async () => {
      try {
        const status = await window.electronAPI?.getCudaBinaryStatus?.();
        if (!cancelled && status) {
          setCudaStatus(status as CudaBinaryStatus);
        }
      } catch {
        if (!cancelled) {
          setCudaStatus(null);
        }
      }
    };

    fetchCudaStatus();
    const refreshTimer = window.setInterval(fetchCudaStatus, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [useLocalWhisper, localTranscriptionProvider, whisperForceCpu]);

  const loadAudioInputs = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      setAudioInputs([]);
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(
        devices
          .filter((device) => device.kind === "audioinput")
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label || "",
          }))
      );
    } catch {
      setAudioInputs([]);
    }
  }, []);

  useEffect(() => {
    loadAudioInputs();

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) {
      return;
    }

    navigator.mediaDevices.addEventListener("devicechange", loadAudioInputs);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", loadAudioInputs);
    };
  }, [loadAudioInputs]);

  const streak = useMemo(() => {
    const value = computeStreak(streakDates);
    void logger.debug(
      `[streak] computed streak = ${value}`,
      { activeDays: streakDates.size },
      "streak"
    );
    return value;
  }, [streakDates]);
  const recentFive = useMemo(() => transcriptions.slice(0, 5), [transcriptions]);
  const readableHotkey = useMemo(() => formatHotkeyLabel(dictationKey), [dictationKey]);

  const languageLabel = useMemo(() => {
    const match = LANGUAGE_OPTIONS.find((l) => l.value === preferredLanguage);
    return match ? match.label : preferredLanguage;
  }, [preferredLanguage]);

  const modelLabel = useMemo(() => {
    if (!useLocalWhisper) {
      if (cloudTranscriptionProvider === "groq") return "Cloud (Groq)";
      if (cloudTranscriptionProvider === "custom") return "Cloud (Custom)";
      return "Cloud (OpenAI)";
    }
    if (localTranscriptionProvider === "nvidia") return "NVIDIA Parakeet";
    return whisperModel
      ? `Whisper ${whisperModel.charAt(0).toUpperCase() + whisperModel.slice(1)}`
      : "Whisper";
  }, [useLocalWhisper, cloudTranscriptionProvider, localTranscriptionProvider, whisperModel]);

  const engineLabel = useMemo(() => {
    if (!useLocalWhisper) return "Cloud API";
    if (localTranscriptionProvider === "nvidia") return "GPU - Parakeet";
    if (whisperForceCpu || cudaStatus?.forceCpu) return "CPU";

    const engineStatus = cudaStatus?.engineStatus;
    if (engineStatus?.fallback?.active) return "CPU fallback";
    if (engineStatus?.effectiveEngine === "cuda") return "GPU - CUDA";
    if (engineStatus?.effectiveEngine === "cpu") return "CPU";
    if (engineStatus?.transition === "starting" && engineStatus.desiredMode === "gpu") {
      return "GPU - CUDA starting";
    }
    if (cudaStatus?.installed && cudaStatus.upToDate) return "GPU - CUDA ready";
    if (cudaStatus?.supported === false) return "CPU";
    return "CPU";
  }, [useLocalWhisper, localTranscriptionProvider, whisperForceCpu, cudaStatus]);

  const microphoneLabel = useMemo(() => {
    const withLabels = audioInputs.filter((device) => device.label);

    if (preferBuiltInMic) {
      const builtIn = withLabels.find((device) => isBuiltInMicrophone(device.label));
      return builtIn?.label || "Built-in preferred";
    }

    if (selectedMicDeviceId) {
      const selected = withLabels.find((device) => device.deviceId === selectedMicDeviceId);
      return selected?.label || "Selected microphone";
    }

    const defaultDevice = withLabels.find((device) => device.deviceId === "default");
    return defaultDevice?.label || "System default";
  }, [audioInputs, preferBuiltInMic, selectedMicDeviceId]);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      const item = transcriptions.find((t) => t.text === text);
      if (item) {
        setCopiedId(item.id);
        if (copiedResetTimerRef.current) {
          clearTimeout(copiedResetTimerRef.current);
        }
        copiedResetTimerRef.current = setTimeout(() => {
          copiedResetTimerRef.current = null;
          setCopiedId(null);
        }, 2000);
      }
    } catch {
      // Silently fail
    }
  };

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) {
        clearTimeout(copiedResetTimerRef.current);
        copiedResetTimerRef.current = null;
      }
    };
  }, []);

  const handleDelete = async (id: number) => {
    try {
      await window.electronAPI?.deleteTranscription?.(id);
    } catch {
      // Silently fail
    }
  };

  const configRows = [
    { label: "MODEL", value: modelLabel },
    { label: "ENGINE", value: engineLabel },
    { label: "LANGUAGE", value: languageLabel },
    { label: "MIC", value: microphoneLabel },
  ];

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-8 space-y-8">
        {/* Welcome Header */}
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Dashboard</h1>
        </div>

        {/* Stats + Config Row */}
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Stats Card */}
          <div className="flex-[3] min-w-0 min-h-[306px] rounded-2xl border border-border-subtle bg-surface-1 p-8 flex flex-col">
            {/* Badge */}
            <div className="mb-7 flex items-start justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-[10px] font-semibold uppercase tracking-widest">
                <Activity size={12} />
                Total words dictated
              </span>
              <div className="text-right">
                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                  Dictations
                </span>
                <span className="block text-sm font-semibold text-foreground tabular-nums">
                  {formatNumber(stats.total_transcriptions)}
                </span>
              </div>
            </div>

            {/* Big Number */}
            <div className="mb-auto">
              <span className="text-6xl font-bold tracking-tight text-foreground tabular-nums">
                {formatNumber(stats.total_words)}
              </span>
              <span className="ml-2 text-lg text-muted-foreground italic font-light">words</span>
            </div>

            {/* Sub-stat Pills */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-8">
              <div className="flex items-center gap-2.5 px-3 py-3 rounded-xl bg-surface-raised/80 border border-border-subtle">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Flame size={15} />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                    Streak
                  </span>
                  <span className="text-sm font-semibold text-foreground tabular-nums whitespace-nowrap">
                    {streak} {streak === 1 ? "day" : "days"}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2.5 px-3 py-3 rounded-xl bg-surface-raised/80 border border-border-subtle">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Timer size={15} />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                    Time
                  </span>
                  <span className="text-sm font-semibold text-foreground tabular-nums whitespace-nowrap">
                    {formatSpeakingTime(stats.total_seconds)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2.5 px-3 py-3 rounded-xl bg-surface-raised/80 border border-border-subtle">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Gauge size={15} />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                    Speed
                  </span>
                  <span className="text-sm font-semibold text-foreground tabular-nums whitespace-nowrap">
                    {Math.round(stats.average_wpm)} WPM
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Active Config Card */}
          <div className="flex-[2] min-w-0 rounded-2xl border border-border-subtle bg-surface-1 p-8">
            {/* Header */}
            <div className="flex items-center gap-2 mb-6">
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/10">
                <Settings size={14} className="text-primary" />
              </div>
              <span className="text-sm font-semibold text-foreground">Current dictation setup</span>
            </div>

            {/* Config Rows */}
            <div className="space-y-4">
              {configRows.map((row) => (
                <div key={row.label} className="flex items-center gap-3">
                  {/* Mint dot indicator */}
                  <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 shadow-[0_0_6px_rgba(112,255,186,0.4)]" />
                  <div className="flex flex-col min-w-0">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                      {row.label}
                    </span>
                    <span
                      className="inline-block truncate text-sm text-foreground"
                      title={row.value}
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        maxWidth: "min(56ch, 100%)",
                      }}
                    >
                      {row.value}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Recent History */}
        <div className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-8 py-5 border-b border-border-subtle">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-foreground">Recent dictations</h2>
              <span className="inline-flex items-center justify-center min-w-[28px] h-5 px-2 rounded-full bg-primary/10 text-primary text-[11px] font-semibold tabular-nums">
                {transcriptions.length}
              </span>
            </div>
            {transcriptions.length > 5 && (
              <button
                onClick={() => onNavigate("history")}
                className="text-xs font-medium text-primary hover:text-primary/80 transition-colors duration-200"
              >
                View all →
              </button>
            )}
          </div>

          {/* List */}
          {recentFive.length > 0 ? (
            <div className="divide-y divide-border-subtle">
              {recentFive.map((item, index) => (
                <TranscriptionItem
                  key={item.id}
                  item={item}
                  index={index}
                  total={transcriptions.length}
                  onCopy={handleCopy}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 px-8">
              <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-surface-raised border border-border-subtle mb-5">
                <Command size={24} className="text-primary" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1.5">Ready to dictate</p>
              <p className="text-xs text-muted-foreground text-center max-w-[320px] mb-5">
                Press{" "}
                <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted/50 text-foreground font-mono text-[11px]">
                  {readableHotkey}
                </kbd>{" "}
                anywhere to start dictating. Your dictated text will appear here.
              </p>
              <button
                onClick={() => onNavigate("transcribe")}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-background text-xs font-semibold hover:bg-primary/90 transition-colors duration-200"
              >
                <Upload size={14} />
                Transcribe a file
              </button>
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate("transcribe")}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-border-subtle bg-surface-raised text-sm font-medium text-foreground hover:bg-surface-raised/80 hover:border-primary/30 transition-all duration-200"
          >
            <Upload size={15} className="text-primary" />
            Transcribe file
          </button>
          <button
            onClick={() => onNavigate("settings")}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-border-subtle bg-surface-raised text-sm font-medium text-foreground hover:bg-surface-raised/80 hover:border-primary/30 transition-all duration-200"
          >
            <Settings size={15} className="text-primary" />
            Review setup
          </button>
        </div>
      </div>
    </div>
  );
}
