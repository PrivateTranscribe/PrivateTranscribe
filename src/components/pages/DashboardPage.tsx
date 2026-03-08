import { useEffect, useMemo, useState } from "react";
import { Mic, Settings, Upload, Activity } from "lucide-react";
import { PageId } from "../AppSidebar";
import { useTranscriptions, useTranscriptionsVersion, initializeTranscriptions } from "../../stores/transcriptionStore";
import { useSettings } from "../../hooks/useSettings";
import TranscriptionItem from "../ui/TranscriptionItem";
import { LANGUAGE_OPTIONS } from "../../utils/languages";
import type { TranscriptionItem as TranscriptionItemType, AggregateStats } from "../../types/electron";

interface DashboardPageProps {
  onNavigate: (page: PageId) => void;
}

function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseTranscriptionTimestamp(timestamp: string): Date | null {
  if (!timestamp) return null;

  // SQLite DATETIME commonly arrives as "YYYY-MM-DD HH:MM:SS" (UTC-ish text without timezone).
  // Parsing that with the Date constructor is inconsistent across environments, and forcing a `Z`
  // can shift entries onto the wrong local day. Parse the parts manually and treat them as local
  // wall-clock time so streaks are counted by the user's calendar day.
  const sqliteMatch = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (sqliteMatch) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = sqliteMatch;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function computeStreak(transcriptions: TranscriptionItemType[]): number {
  if (transcriptions.length === 0) return 0;

  const datesWithTranscriptions = new Set<string>();
  for (const t of transcriptions) {
    // Only count real dictation sessions — skip file uploads and other non-stats entries.
    // include_in_stats is stored as SQLite integer (1/0); treat missing/undefined as 1 for
    // backward-compatibility with any records that predate the column migration.
    if (t.include_in_stats === 0) continue;
    const parsed = parseTranscriptionTimestamp(t.timestamp);
    if (parsed) {
      datesWithTranscriptions.add(toLocalDateKey(parsed));
    }
  }

  if (datesWithTranscriptions.size === 0) return 0;

  // Grace-window daily streak:
  // - activity today => streak is anchored today
  // - otherwise activity yesterday => streak is still alive and anchored yesterday
  // - otherwise streak is broken
  const today = new Date();
  const todayKey = toLocalDateKey(today);

  const anchor = new Date(today);
  if (!datesWithTranscriptions.has(todayKey)) {
    anchor.setDate(anchor.getDate() - 1);
    const yesterdayKey = toLocalDateKey(anchor);
    if (!datesWithTranscriptions.has(yesterdayKey)) {
      return 0;
    }
  }

  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const key = toLocalDateKey(anchor);
    if (!datesWithTranscriptions.has(key)) {
      break;
    }
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
    historyLimit,
  } = useSettings();

  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [stats, setStats] = useState<AggregateStats>({
    total_words: 0,
    total_transcriptions: 0,
    total_seconds: 0,
    average_wpm: 0,
  });

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

  // Re-fetch stats whenever any transcription mutation occurs (add/delete/clear)
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
    fetchStats();
  }, [transcriptionsVersion]);

  const streak = useMemo(() => computeStreak(transcriptions), [transcriptions]);
  const recentFive = useMemo(() => transcriptions.slice(0, 5), [transcriptions]);

  const languageLabel = useMemo(() => {
    const match = LANGUAGE_OPTIONS.find((l) => l.value === preferredLanguage);
    return match ? match.label : preferredLanguage;
  }, [preferredLanguage]);

  const modelLabel = useMemo(() => {
    if (!useLocalWhisper) return "Cloud (OpenAI)";
    if (localTranscriptionProvider === "nvidia") return "NVIDIA Parakeet";
    return whisperModel ? `Whisper ${whisperModel.charAt(0).toUpperCase() + whisperModel.slice(1)}` : "Whisper";
  }, [useLocalWhisper, localTranscriptionProvider, whisperModel]);

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
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Dashboard
          </h1>
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
              <span className="ml-2 text-lg text-muted-foreground italic font-light">
                words
              </span>
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
              <span className="text-sm font-semibold text-foreground">
                Active Config
              </span>
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
              <h2 className="text-base font-semibold text-foreground">
                Recent History
              </h2>
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
                <Mic size={24} className="text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1.5">
                No transcriptions yet
              </p>
              <p className="text-xs text-muted-foreground text-center max-w-[280px] mb-5">
                Start dictating with your hotkey or upload an audio file to see your transcription history here.
              </p>
              <button
                onClick={() => onNavigate("transcribe")}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-background text-xs font-semibold hover:bg-primary/90 transition-colors duration-200"
              >
                <Upload size={14} />
                Upload a File
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
