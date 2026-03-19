import { useEffect, useMemo, useState } from "react";
import { Mic, Settings, Upload, Activity, Command } from "lucide-react";
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
import type { AggregateStats } from "../../types/electron";

interface DashboardPageProps {
  onNavigate: (page: PageId) => void;
}

export function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Compute the current streak from a set of "YYYY-MM-DD" date keys that had real dictation.
 *
 * The date keys come from the database (via getStreakDates) which returns ALL qualifying days
 * rather than the paginated in-memory history list. This prevents the streak from resetting
 * when the display history window (e.g. 50 items) fills up and evicts older entries.
 *
 * There is no upper cap — the streak grows indefinitely with daily use.
 *
 * Grace-window rules:
 *  - activity today → anchor on today, count backwards
 *  - no activity today but activity yesterday → streak still alive, anchor on yesterday
 *  - otherwise → streak is broken (returns 0)
 */
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
    historyLimit,
    dictationKey,
  } = useSettings();

  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [stats, setStats] = useState<AggregateStats>({
    total_words: 0,
    total_transcriptions: 0,
    total_seconds: 0,
    average_wpm: 0,
  });
  const [streakDates, setStreakDates] = useState<Set<string>>(new Set());

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
        const dates = await window.electronAPI?.getStreakDates?.();
        if (Array.isArray(dates)) {
          setStreakDates(new Set(dates));
        }
      } catch {
        // Silently fail
      }
    };
    fetchStats();
    fetchStreakDates();
  }, [transcriptionsVersion]);

  const streak = useMemo(() => computeStreak(streakDates), [streakDates]);
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

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      const item = transcriptions.find((t) => t.text === text);
      if (item) {
        setCopiedId(item.id);
        setTimeout(() => setCopiedId(null), 2000);
      }
    } catch {
      // Silently fail
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await window.electronAPI?.deleteTranscription?.(id);
    } catch {
      // Silently fail
    }
  };

  const configRows = [
    { label: "MODEL", value: modelLabel },
    { label: "LANGUAGE", value: languageLabel },
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
          <div className="flex-[3] min-w-0 rounded-2xl border border-border-subtle bg-surface-1 p-8">
            {/* Badge */}
            <div className="mb-5">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-[10px] font-semibold uppercase tracking-widest">
                <Activity size={12} />
                Total Words Dictated
              </span>
            </div>

            {/* Big Number */}
            <div className="mb-8">
              <span className="text-5xl font-bold tracking-tight text-foreground tabular-nums">
                {formatNumber(stats.total_words)}
              </span>
              <span className="ml-2 text-lg text-muted-foreground italic font-light">words</span>
            </div>

            {/* Sub-stat Pills */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-surface-raised border border-border-subtle">
                <span className="text-base flex-shrink-0" role="img" aria-label="fire">
                  🔥
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium truncate">
                    Streak
                  </span>
                  <span className="text-sm font-semibold text-foreground tabular-nums truncate">
                    {streak} {streak === 1 ? "day" : "days"}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-surface-raised border border-border-subtle">
                <span className="text-base flex-shrink-0" role="img" aria-label="clock">
                  ⏱️
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium truncate">
                    Time
                  </span>
                  <span className="text-sm font-semibold text-foreground tabular-nums truncate">
                    {formatSpeakingTime(stats.total_seconds)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-surface-raised border border-border-subtle">
                <span className="text-base flex-shrink-0" role="img" aria-label="speed">
                  ⚡
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium truncate">
                    Speed
                  </span>
                  <span className="text-sm font-semibold text-foreground tabular-nums truncate">
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
              <span className="text-sm font-semibold text-foreground">Active Config</span>
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
                      className="text-sm text-foreground truncate"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
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
              <h2 className="text-base font-semibold text-foreground">Recent History</h2>
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
                anywhere to start dictating. Your transcription history will appear here.
              </p>
              <button
                onClick={() => onNavigate("transcribe")}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-background text-xs font-semibold hover:bg-primary/90 transition-colors duration-200"
              >
                <Upload size={14} />
                Or Upload a File
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
            Upload File
          </button>
          <button
            onClick={() => onNavigate("settings")}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-border-subtle bg-surface-raised text-sm font-medium text-foreground hover:bg-surface-raised/80 hover:border-primary/30 transition-all duration-200"
          >
            <Settings size={15} className="text-primary" />
            Open Settings
          </button>
        </div>
      </div>
    </div>
  );
}
