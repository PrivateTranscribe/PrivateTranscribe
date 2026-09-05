import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { IconTile } from "./ui/IconTile";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import { Slider } from "./ui/slider";
import { Badge } from "./ui/badge";
import {
  RefreshCw,
  Download,
  Upload,
  Mic,
  Shield,
  FolderOpen,
  MonitorSmartphone,
  ExternalLink,
  Loader2,
  AlertCircle,
  Zap,
  Timer,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import type {
  HardwareDetectionResult,
  HardwareGpuCategory,
  BenchmarkResult,
  ComparisonBenchmarkResult,
} from "../types/electron";
import { openExternalLink } from "../utils/externalLinks";
import { formatBenchmarkClip, formatBenchmarkWait } from "../utils/benchmarkWait";
import { isNewerVersion } from "../utils/versionCompare";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import MarkdownRenderer from "./ui/MarkdownRenderer";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useSettings } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { getEffectiveEntitlement, isFeatureUnlocked } from "../hooks/useProStatus";
import { readAgentModeUsage } from "../utils/agentModeUsage";
import SpokenLanguagesSelector, { describeSpokenLanguages } from "./ui/SpokenLanguagesSelector";
import { BetaBadge } from "./ui/BetaBadge";
import { BetaAccessLink } from "./ui/BetaAccessLink";
import { derivePreferredLanguage, normalizeSpokenLanguages } from "../utils/spokenLanguages";
import { resolveRatingLanguage } from "../utils/modelAccuracy";
import ProSettingsSection from "./ProSettingsSection";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useUpdater } from "../hooks/useUpdater";

import { HotkeyInput } from "./ui/HotkeyInput";
import {
  AGENT_MODE_HOTKEY_OPTIONS,
  getDefaultHotkey,
  normalizeHotkeyForComparison,
  parseHotkey,
} from "../utils/hotkeys";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import { Toggle } from "./ui/toggle";
import VoiceCallMuteSettings from "./ui/VoiceCallMuteSettings";
import DeveloperSection from "./DeveloperSection";
import FeedbackDialog from "./FeedbackDialog";
import { SettingsRow } from "./ui/SettingsSection";
import { InfoBox } from "./ui/InfoBox";
import { LANGUAGE_OPTIONS } from "../utils/languages";
import { getValidWhisperModelNames } from "../models/ModelRegistry";
import { SectionLabel } from "./ui/SectionLabel";
import { setAgentName as persistAgentName } from "../utils/agentName";

/**
 * The Settings tabs, and nothing else.
 *
 * These are exactly the ids `SettingsPageWrapper` can hold and exactly the ones
 * `ControlPanelSettingsTab` allows over IPC. Keeping a member here that no tab
 * can select buys a switch case that never runs, which is how the old
 * "dictionary" and "aiModels" sections sat unreachable behind their own copies
 * of controls that had already moved to DictionaryPage and AIEnhancementPage.
 */
export type SettingsSectionType = "general" | "dictation" | "permissions" | "developer" | "pro";

const HISTORY_LIMIT_MIN = 10;
const HISTORY_LIMIT_MAX = 10000;
const WHISPER_IDLE_TIMEOUT_MIN = 1;
const WHISPER_IDLE_TIMEOUT_MAX = 1440;
const AGENT_NAME_MAX_LENGTH = 100;
const CUSTOM_PROMPT_MAX_LENGTH = 20000;
const AGENT_NAME_STORAGE_KEY = "agentName";
const CUSTOM_PROMPT_STORAGE_KEY = "customUnifiedPrompt";
type AutoStartLaunchMode = "tray" | "minimized" | "window";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const isPathLikeString = (value: string) =>
  value.includes("../") ||
  value.includes("..\\") ||
  value.startsWith("/") ||
  /^[a-zA-Z]:[\\/]/.test(value);

const isSafeImportedIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !isPathLikeString(value);

const isValidImportedLanguage = (value: unknown): value is string =>
  typeof value === "string" &&
  (value === "auto" ||
    LANGUAGE_OPTIONS.some((language) => language.value === value) ||
    /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(value));

// customUnifiedPrompt is stored JSON.stringify()'d (see PromptStudio.tsx) so a
// plain string can hold quotes/newlines safely. Decode it the same way
// PromptStudio's getCurrentPrompt() does, and treat anything unparsable as
// absent rather than exporting corrupt data.
const readStoredCustomPrompt = (): string | undefined => {
  const raw = localStorage.getItem(CUSTOM_PROMPT_STORAGE_KEY);
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Agent Mode's two IPC calls, and the status they report.
 *
 * The main process owns the key listener, so it is the only thing that knows
 * whether the hold key is really live, so the section asks it rather than
 * inferring a state from the toggle. Declared here because the shared
 * electronAPI type does not carry these two calls yet.
 */
interface AgentModeHotkeyStatus {
  registered: boolean;
  hotkey: string;
  enabled?: boolean;
  reason?: string;
}

interface AgentModeRewriteStatus {
  available: boolean;
  bin: string | null;
  reason?: "not-found" | "diagnostic-flag";
}

interface AgentModeBridge {
  agentModeSyncHotkey?: (settings: {
    enabled: boolean;
    hotkey: string;
  }) => Promise<AgentModeHotkeyStatus>;
  agentModeHotkeyStatus?: () => Promise<AgentModeHotkeyStatus>;
  agentModeRewriteStatus?: () => Promise<AgentModeRewriteStatus>;
}

const agentModeBridge = (): AgentModeBridge =>
  (window.electronAPI ?? {}) as unknown as AgentModeBridge;

/** The modifier each right-hand Agent Mode key is, for conflict comparison. */
const AGENT_MODE_MODIFIER_EQUIVALENTS: Record<string, string> = {
  RightControl: "Ctrl",
  RightAlt: "Alt",
  RightShift: "Shift",
};

const agentModeKeyLabel = (value: string): string =>
  AGENT_MODE_HOTKEY_OPTIONS.find((option) => option.value === value)?.label || value;

/**
 * Whether the Agent Mode key and the dictation key are the same physical key.
 *
 * A bare `RightControl` is Ctrl, so it only clashes with a dictation hotkey
 * that is itself modifier-only; `Ctrl+Space` leaves Right Ctrl alone. Every
 * other Agent Mode key is an ordinary key, compared on base key name.
 */
const isAgentModeKeySameAsDictation = (agentHotkey: string, dictationHotkey: string): boolean => {
  const modifierEquivalent = AGENT_MODE_MODIFIER_EQUIVALENTS[agentHotkey];
  if (modifierEquivalent) {
    return (
      normalizeHotkeyForComparison(dictationHotkey) ===
      normalizeHotkeyForComparison(modifierEquivalent)
    );
  }

  const agentBase = parseHotkey(agentHotkey).baseKey.trim().toUpperCase();
  const dictationBase = parseHotkey(dictationHotkey).baseKey.trim().toUpperCase();
  return agentBase.length > 0 && agentBase === dictationBase;
};

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
  /** Leaves Settings for another page, used by the Pro tab's feature cards. */
  onNavigate?: (page: string) => void;
}

// ── Reusable layout primitives ──────────────────────────────────────

function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-border-subtle/50 bg-surface-raised/50 backdrop-blur-sm divide-y divide-border-subtle/30 shadow-sm overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

function SettingsPanelRow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}

function SectionHeader({
  title,
  description,
  badge,
}: {
  title: string;
  description?: string;
  /** Rendered beside the title, e.g. a Beta pill on a tester-only section. */
  badge?: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-semibold text-foreground tracking-tight">{title}</h3>
        {badge}
      </div>
      {description && (
        <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

// ── GPU Status card - shown in Transcription settings ──────────────────

type GpuDetectState = "idle" | "detecting" | "done" | "error";

const GPU_CATEGORY_LABELS: Record<HardwareGpuCategory, string> = {
  nvidia_cuda: "NVIDIA GPU detected",
  nvidia_no_cuda: "NVIDIA GPU - CUDA not ready",
  non_nvidia_gpu: "Non-NVIDIA GPU",
  metal: "Apple Metal ready",
  cpu_only: "CPU only",
};

const GPU_CATEGORY_VARIANT: Record<
  HardwareGpuCategory,
  "default" | "secondary" | "destructive" | "outline"
> = {
  nvidia_cuda: "default",
  metal: "default",
  nvidia_no_cuda: "outline",
  non_nvidia_gpu: "secondary",
  cpu_only: "secondary",
};

function formatRealtimeFactor(factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0) return "-";
  if (factor >= 100) return `${Math.round(factor)}x`;
  if (factor >= 10) return `${factor.toFixed(1)}x`;
  return `${factor.toFixed(2)}x`;
}

function formatBenchmarkDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

type BenchmarkState = "idle" | "running" | "done" | "error";

type CudaBinaryStatus = {
  installed: boolean;
  path: string | null;
  platform: string;
  supported: boolean;
  forceCpu: boolean;
  cudaAutoUpdateFailed?: boolean;
  version?: string | null;
  upToDate?: boolean;
  expectedVersion?: string;
  latestAvailableVersion?: string | null;
  /** Set when a download is running right now, including one this window never started. */
  activeDownload?: {
    phase?: string;
    percent?: number;
    bytesDownloaded?: number;
    totalBytes?: number;
  } | null;
  engineStatus?: {
    effectiveEngine?: "cuda" | "cpu" | "stopped" | "unknown";
    transition?: string;
    fallback?: { active?: boolean; reason?: string | null };
  } | null;
};

type CudaDownloadState = "idle" | "downloading" | "done" | "error";

function formatBytes(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes)) return "";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1000)} KB`;
}

function CudaEngineUpdateCard({ compact = false }: { compact?: boolean }) {
  const [cudaStatus, setCudaStatus] = useState<CudaBinaryStatus | null>(null);
  const [downloadState, setDownloadState] = useState<CudaDownloadState>("idle");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadBytes, setDownloadBytes] = useState<{ downloaded?: number; total?: number }>({});
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadPhase, setDownloadPhase] = useState<string>("downloading");

  const refreshStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.getCudaBinaryStatus?.();
      if (!status) return;
      setCudaStatus(status as CudaBinaryStatus);

      // Adopt a download started elsewhere (the silent startup auto-update, or
      // the other Settings surface) so this card never offers a button for work
      // already underway.
      const active = (status as CudaBinaryStatus).activeDownload;
      if (active) {
        setDownloadState("downloading");
        setDownloadPhase(active.phase || "downloading");
        setDownloadProgress(Math.round(active.percent ?? 0));
        setDownloadBytes({ downloaded: active.bytesDownloaded, total: active.totalBytes });
        setDownloadError(null);
      }
    } catch {
      /* keep current status */
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const interval = setInterval(refreshStatus, 30000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onCudaBinaryDownloadProgress?.((_event, data) => {
      setDownloadProgress(Math.round(data?.percent ?? data?.progress ?? 0));
      setDownloadBytes({
        downloaded: data?.bytesDownloaded ?? data?.downloadedBytes,
        total: data?.totalBytes,
      });
      // These events are broadcast to every window, so they also arrive for a
      // download this card did not start. Follow them rather than sitting on a
      // stale "Update available".
      const phase = data?.phase || "downloading";
      setDownloadPhase(phase);
      if (phase === "done") {
        setDownloadState("done");
        refreshStatus();
      } else {
        setDownloadState("downloading");
        setDownloadError(null);
      }
    });
    return () => cleanup?.();
  }, [refreshStatus]);

  const handleDownloadCuda = useCallback(async () => {
    setDownloadState("downloading");
    setDownloadPhase("downloading");
    setDownloadProgress(0);
    setDownloadBytes({});
    setDownloadError(null);
    try {
      const result = await window.electronAPI?.downloadCudaBinary?.();
      if (!result?.success) {
        setDownloadState("error");
        setDownloadError(result?.error || "CUDA engine download failed");
        await refreshStatus();
        return;
      }
      setDownloadState("done");
      await refreshStatus();
    } catch (error: unknown) {
      setDownloadState("error");
      setDownloadError(error instanceof Error ? error.message : "CUDA engine download failed");
      await refreshStatus();
    }
  }, [refreshStatus]);

  const handleCancelDownload = useCallback(async () => {
    await window.electronAPI?.cancelCudaBinaryDownload?.().catch(() => {});
    setDownloadState("idle");
    setDownloadPhase("downloading");
    setDownloadProgress(0);
    setDownloadBytes({});
    await refreshStatus();
  }, [refreshStatus]);

  const isSupported = cudaStatus?.supported ?? false;
  const isInstalled = cudaStatus?.installed ?? false;
  const isUpToDate = cudaStatus?.upToDate ?? false;
  const needsUpdate = isInstalled && !isUpToDate;
  const needsInstall = isSupported && !isInstalled;
  const autoUpdateFailed = !!cudaStatus?.cudaAutoUpdateFailed && !isUpToDate;
  const currentVersion = cudaStatus?.version || (isInstalled ? "legacy/unknown" : "not installed");
  const expectedVersion = cudaStatus?.expectedVersion || "latest";
  // A newer engine can exist on the update server than this app build is
  // pinned to; it only installs together with the next app update.
  const latestPublished = cudaStatus?.latestAvailableVersion || null;
  const newerEnginePublished =
    isUpToDate && isNewerVersion(latestPublished, cudaStatus?.expectedVersion);
  const engine = cudaStatus?.engineStatus?.effectiveEngine;
  const fallbackActive = cudaStatus?.engineStatus?.fallback?.active === true;
  const byteLabel = downloadBytes.total
    ? `${formatBytes(downloadBytes.downloaded)} / ${formatBytes(downloadBytes.total)}`
    : "";

  const badge = !isSupported ? (
    <Badge variant="secondary">Unsupported</Badge>
  ) : downloadState === "downloading" ? (
    <Badge variant="outline">{downloadPhase === "installing" ? "Installing" : "Downloading"}</Badge>
  ) : needsUpdate ? (
    <Badge variant="warning">Update available</Badge>
  ) : isUpToDate ? (
    <Badge variant="success">Current</Badge>
  ) : (
    <Badge variant="outline">Not installed</Badge>
  );

  const description = !isSupported
    ? "Needs an NVIDIA graphics card on Windows or Linux. This computer runs local Whisper on the CPU."
    : downloadState === "downloading"
      ? downloadPhase === "installing"
        ? "Installing the GPU engine. This takes a moment for a package this size."
        : `Downloading the GPU engine, ${downloadProgress}%${byteLabel ? ` (${byteLabel})` : ""}. Quitting PrivateTranscribe pauses it and it resumes next launch.`
      : autoUpdateFailed
        ? "The automatic engine update did not finish. Retry it here."
        : needsUpdate
          ? "A newer GPU engine matches this version of the app. Update it before you rely on GPU speed."
          : isUpToDate
            ? fallbackActive
              ? "Installed, but Whisper fell back to your CPU after the graphics card failed to start. It retries on its own."
              : newerEnginePublished
                ? `Up to date for this version of the app. Engine ${latestPublished} arrives with the next PrivateTranscribe update.`
                : engine === "cuda"
                  ? "Installed and in use. Dictation runs on your graphics card."
                  : "Installed. It starts with your next dictation."
            : "Not installed. Dictation runs on your CPU until you download it (about 750 MB).";

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <SettingsRow label="GPU engine" description={description}>
          <div className="flex items-center gap-2.5 flex-wrap justify-end">{badge}</div>
        </SettingsRow>
      </SettingsPanelRow>

      <SettingsPanelRow>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-muted-foreground">
            <div className="rounded-lg border border-border-subtle/50 bg-surface-raised/30 px-3 py-2">
              <SectionLabel className="mb-1">On this PC</SectionLabel>
              <p className="text-foreground font-mono">
                {isInstalled ? currentVersion : "nothing yet"}
              </p>
            </div>
            <div className="rounded-lg border border-border-subtle/50 bg-surface-raised/30 px-3 py-2">
              <SectionLabel className="mb-1">This app needs</SectionLabel>
              <p className="text-foreground font-mono">{expectedVersion}</p>
            </div>
            <div className="rounded-lg border border-border-subtle/50 bg-surface-raised/30 px-3 py-2">
              <SectionLabel className="mb-1">Running on</SectionLabel>
              <p className="text-foreground">
                {engine === "cuda"
                  ? "Graphics card"
                  : fallbackActive
                    ? "CPU, after a GPU failure"
                    : engine === "cpu"
                      ? "CPU"
                      : "Not running right now"}
              </p>
            </div>
          </div>

          {newerEnginePublished && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>
                Engine {latestPublished} is published. This app version pins {expectedVersion}; the
                newer engine installs automatically after the next app update.
              </span>
            </div>
          )}

          {downloadState === "downloading" && (
            <div className="space-y-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-200"
                  style={{ width: `${Math.min(100, Math.max(0, downloadProgress))}%` }}
                />
              </div>
            </div>
          )}

          {downloadState === "error" && downloadError && (
            <div className="flex items-center gap-1.5 text-xs text-destructive">
              <XCircle className="w-3.5 h-3.5" />
              <span>{downloadError}</span>
            </div>
          )}

          {downloadState === "done" && (
            <div className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>
                CUDA engine installed. Restarting Whisper on next transcription if needed.
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            {downloadState === "downloading" ? (
              <Button
                onClick={handleCancelDownload}
                variant="outline"
                size="sm"
                className="gap-1.5"
                // Once the archive is extracting there is no transfer left to
                // stop, and aborting mid-install would leave a partial engine.
                disabled={downloadPhase === "installing"}
              >
                Cancel download
              </Button>
            ) : (
              <Button
                onClick={handleDownloadCuda}
                variant={needsInstall || needsUpdate || autoUpdateFailed ? "default" : "outline"}
                size="sm"
                className="gap-1.5"
                disabled={!isSupported}
              >
                <Download className="w-3.5 h-3.5" />
                {autoUpdateFailed
                  ? "Retry update"
                  : needsUpdate
                    ? "Update GPU engine"
                    : needsInstall
                      ? "Download GPU engine"
                      : "Reinstall GPU engine"}
              </Button>
            )}
            <Button onClick={refreshStatus} variant="ghost" size="sm" className="gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh status
            </Button>
          </div>

          {!compact && (
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              This updates only the GPU engine, not the app itself.
            </p>
          )}
        </div>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}

function GpuStatusCard({
  activeProvider,
  activeWhisperForceCpu,
}: {
  /** localTranscriptionProvider from parent - avoids stale useSettings() copy */
  activeProvider: string;
  activeWhisperForceCpu: boolean;
}) {
  const [detectState, setDetectState] = useState<GpuDetectState>("idle");
  const [detection, setDetection] = useState<HardwareDetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Benchmark state
  const [benchState, setBenchState] = useState<BenchmarkState>("idle");
  const [benchResult, setBenchResult] = useState<BenchmarkResult | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);

  // Comparison benchmark state
  const [compState, setCompState] = useState<BenchmarkState>("idle");
  const [compResult, setCompResult] = useState<ComparisonBenchmarkResult | null>(null);
  const [compError, setCompError] = useState<string | null>(null);

  // CUDA binary download state
  const [cudaStatus, setCudaStatus] = useState<CudaBinaryStatus | null>(null);
  const [downloadState, setDownloadState] = useState<CudaDownloadState>("idle");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const settings = useSettings();

  // Load latest benchmark and comparison on mount
  useEffect(() => {
    window.electronAPI?.benchmarkGetLatest?.().then((res) => {
      if (res?.success && res.result) {
        setBenchResult(res.result);
        setBenchState("done");
      }
    });
    window.electronAPI?.benchmarkGetLatestComparison?.().then((res) => {
      if (res?.success && res.result) {
        setCompResult(res.result);
        setCompState("done");
      }
    });
  }, []);

  // Fetch CUDA binary status, adopting any download already running so this
  // card does not offer to start work that is already underway.
  const refreshCudaStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.getCudaBinaryStatus?.();
      if (!status) return;
      setCudaStatus(status);
      const active = (status as CudaBinaryStatus).activeDownload;
      if (active) {
        setDownloadState("downloading");
        setDownloadProgress(Math.round(active.percent ?? 0));
        setDownloadError(null);
      }
    } catch {
      /* keep the last known status */
    }
  }, []);

  useEffect(() => {
    refreshCudaStatus();
  }, [refreshCudaStatus]);

  // Refresh CUDA status while Settings is open so async auto-update failures surface.
  useEffect(() => {
    const interval = setInterval(refreshCudaStatus, 30000);
    return () => clearInterval(interval);
  }, [refreshCudaStatus]);

  // Progress is broadcast to every window, so this also fires for the silent
  // startup auto-update and for downloads started from the other card.
  useEffect(() => {
    const cleanup = window.electronAPI?.onCudaBinaryDownloadProgress?.((_event, data) => {
      setDownloadProgress(Math.round(data?.percent ?? data?.progress ?? 0));
      if (data?.phase === "done") {
        setDownloadState("done");
        refreshCudaStatus();
      } else {
        setDownloadState("downloading");
        setDownloadError(null);
      }
    });
    return () => cleanup?.();
  }, [refreshCudaStatus]);

  const handleDownloadCuda = async () => {
    setDownloadState("downloading");
    setDownloadProgress(0);
    setDownloadError(null);
    try {
      const result = await window.electronAPI?.downloadCudaBinary?.();
      if (!result?.success) {
        setDownloadState("error");
        setDownloadError(result?.error || "Download failed");
        return;
      }
      setDownloadState("done");
      const status = await window.electronAPI?.getCudaBinaryStatus?.();
      if (status) {
        setCudaStatus(status);
      }
    } catch (err: unknown) {
      setDownloadState("error");
      setDownloadError(
        err instanceof Error
          ? err.message
          : ((err as { message?: string })?.message ?? "Download failed")
      );
    }
  };

  const handleCancelDownload = async () => {
    await window.electronAPI?.cancelCudaBinaryDownload?.().catch(() => {});
    setDownloadState("idle");
    setDownloadProgress(0);
  };

  const runDetect = async (clearCache = false) => {
    setDetectState("detecting");
    setError(null);
    try {
      if (clearCache) await window.electronAPI?.clearHardwareCache?.();
      const result = await window.electronAPI?.detectHardware?.();
      if (result?.success && result.detection) {
        setDetection(result.detection);
        setDetectState("done");
      } else {
        setError(result?.error || "Detection failed");
        setDetectState("error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setDetectState("error");
    }
  };

  useEffect(() => {
    runDetect(false);
  }, []);

  const runBenchmark = async () => {
    setBenchState("running");
    setBenchError(null);
    try {
      // Use props (not settings) - GpuStatusCard's own useSettings() copy can be stale
      // if localTranscriptionProvider was changed by the model picker above.
      const provider = activeProvider === "nvidia" ? "nvidia" : "whisper";
      const model =
        provider === "nvidia" ? "parakeet-tdt-0.6b-v3" : settings.whisperModel || "turbo";

      const res = await window.electronAPI?.benchmarkRun?.({ provider, model });
      const status = await window.electronAPI?.getCudaBinaryStatus?.().catch(() => null);
      if (status) setCudaStatus(status);
      if (res?.success && res.result) {
        setBenchResult(res.result);
        setBenchState("done");
      } else {
        setBenchError(res?.error || "Speed test failed");
        setBenchState("error");
      }
    } catch (e) {
      setBenchError(e instanceof Error ? e.message : "Unknown error");
      setBenchState("error");
    }
  };

  const runComparison = async () => {
    setCompState("running");
    setCompError(null);
    try {
      const res = await window.electronAPI?.benchmarkRunComparison?.({
        cpuModel: settings.whisperModel || "turbo",
        gpuModel: "parakeet-tdt-0.6b-v3",
      });
      if (res?.success && res.result) {
        setCompResult(res.result);
        setCompState("done");
        // Also update the single-engine benchmark display with the GPU result
        setBenchResult(res.result.gpuResult);
        setBenchState("done");
      } else {
        setCompError(res?.error || "Comparison failed");
        setCompState("error");
      }
    } catch (e) {
      setCompError(e instanceof Error ? e.message : "Unknown error");
      setCompState("error");
    }
  };

  const rec = detection?.recommendations;
  const gpuCategory = rec?.gpuCategory;
  const isNvidiaNoCuda = gpuCategory === "nvidia_no_cuda";

  // GPU is "selected" when CPU mode is NOT forced (use prop, not stale settings copy)
  const usingGpu = !activeWhisperForceCpu;
  // CUDA setup requires actual NVIDIA CUDA hardware, not just a supported OS/arch.
  const gpuSupported = gpuCategory === "nvidia_cuda";
  const cudaAutoUpdateFailed =
    !!cudaStatus?.cudaAutoUpdateFailed && (cudaStatus?.upToDate ?? true) === false;
  const needsInitialCudaInstall = (cudaStatus?.installed ?? false) === false;
  const needsCudaUpdate =
    (cudaStatus?.installed ?? false) === true && (cudaStatus?.upToDate ?? true) === false;
  const shouldShowCudaDownloadState =
    downloadState === "downloading" || downloadState === "done" || downloadState === "error";
  const shouldShowCudaSetupCard =
    usingGpu &&
    gpuSupported &&
    (shouldShowCudaDownloadState || needsInitialCudaInstall || needsCudaUpdate);
  const cudaEffectiveEngine = cudaStatus?.engineStatus?.effectiveEngine;
  const cudaFallbackActive = cudaStatus?.engineStatus?.fallback?.active === true;

  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 backdrop-blur-sm shadow-sm overflow-hidden">
      <div className="p-4 flex items-start gap-3">
        <IconTile size="md" className="mt-0.5">
          <MonitorSmartphone className="w-4 h-4 text-primary" />
        </IconTile>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
            <p className="text-sm font-medium text-foreground">Hardware</p>
            {detectState === "detecting" && (
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Detecting…
              </div>
            )}
            {detectState === "done" && gpuCategory && (
              <Badge variant={GPU_CATEGORY_VARIANT[gpuCategory]} className="text-[10px] shrink-0">
                {GPU_CATEGORY_LABELS[gpuCategory]}
              </Badge>
            )}
          </div>

          <div className="space-y-4">
            {/* ═══ CUDA SETUP (shown only when GPU Whisper is selected and CUDA isn't ready, or while downloading) ═══ */}
            {shouldShowCudaSetupCard && (
              <div>
                {downloadState === "downloading" ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Downloading the GPU engine, {downloadProgress}%</span>
                      </div>
                      <Button
                        onClick={handleCancelDownload}
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-[11px]"
                      >
                        Cancel
                      </Button>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-primary/20 overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-200"
                        style={{ width: `${downloadProgress}%` }}
                      />
                    </div>
                  </div>
                ) : downloadState === "done" ? (
                  <div
                    className={`flex items-center gap-1.5 text-xs ${cudaEffectiveEngine === "cuda" ? "text-success" : "text-warning"}`}
                  >
                    {cudaEffectiveEngine === "cuda" ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {cudaEffectiveEngine === "cuda"
                        ? "Running on your graphics card."
                        : cudaFallbackActive
                          ? "GPU engine installed, but Whisper fell back to your CPU. It retries the graphics card on its own."
                          : "GPU engine installed. It starts with your next dictation or speed test."}
                    </span>
                  </div>
                ) : downloadState === "error" ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs text-destructive">
                      <XCircle className="w-3.5 h-3.5" />
                      <span>{downloadError}</span>
                    </div>
                    <Button
                      onClick={handleDownloadCuda}
                      variant="default"
                      size="sm"
                      className="h-7 gap-1.5 text-[11px]"
                    >
                      <Download className="w-3 h-3" />
                      Retry Download
                    </Button>
                  </div>
                ) : needsCudaUpdate ? (
                  <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-2">
                    <p className="text-[11px] text-warning leading-relaxed">
                      {cudaAutoUpdateFailed
                        ? "GPU engine update failed. Click to retry."
                        : "GPU engine update available. Update it to keep GPU transcription current."}
                    </p>
                    <Button
                      onClick={handleDownloadCuda}
                      variant="default"
                      size="sm"
                      className="h-7 gap-1.5 text-[11px]"
                    >
                      <Download className="w-3 h-3" />
                      {cudaAutoUpdateFailed ? "Retry" : "Update GPU engine"}
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border-subtle/50 bg-surface-raised/30 p-3 space-y-2">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      Your graphics card can run Whisper several times faster. One download of about
                      750 MB, then dictation runs on the GPU.
                    </p>
                    <Button
                      onClick={handleDownloadCuda}
                      variant="default"
                      size="sm"
                      className="h-7 gap-1.5 text-[11px]"
                    >
                      <Download className="w-3 h-3" />
                      Download GPU engine
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* ═══ HARDWARE ════════════════════════════════════════ */}
            <div>
              <SectionLabel className="mb-2">Hardware</SectionLabel>
              {detectState === "detecting" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Scanning hardware…
                </div>
              )}
              {detectState === "error" && (
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="w-3 h-3" />
                  {error}
                </div>
              )}
              {detectState === "done" && detection && (
                <div className="space-y-2">
                  {detection.gpu.available ? (
                    <p className="text-xs text-muted-foreground">
                      {detection.gpu.model ?? "GPU detected"}
                      {detection.gpu.vram
                        ? ` · ${detection.gpu.vram >= 1024 ? `${(detection.gpu.vram / 1024).toFixed(1)} GB` : `${detection.gpu.vram} MB`} graphics memory`
                        : ""}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No discrete GPU detected - CPU transcription only
                    </p>
                  )}
                  {isNvidiaNoCuda && rec?.recoverySteps && rec.recoverySteps.length > 0 && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-1.5">
                      <p className="text-[11px] font-medium text-foreground">
                        To enable GPU acceleration
                      </p>
                      <ol className="space-y-1 list-none">
                        {rec.recoverySteps.map((step, i) => (
                          <li
                            key={i}
                            className="text-[11px] text-muted-foreground flex items-start gap-1.5"
                          >
                            <span className="text-warning font-medium mt-0.5 shrink-0">
                              {i + 1}.
                            </span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                      <Button
                        onClick={() => openExternalLink("https://www.nvidia.com/drivers")}
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-[11px] mt-1"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Download NVIDIA Drivers
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div className={detectState === "done" && detection ? "mt-2" : ""}>
                <Button
                  onClick={() => runDetect(true)}
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[11px]"
                  disabled={detectState === "detecting"}
                >
                  <RefreshCw className="w-3 h-3" />
                  {detectState === "done" ? "Re-detect Hardware" : "Detect Hardware"}
                </Button>
              </div>
            </div>

            {/* ═══ BENCHMARKS ══════════════════════════════════════ */}
            <div>
              <SectionLabel className="mb-2">Benchmarks</SectionLabel>

              {benchState === "done" && benchResult && (
                <div className="mb-3 rounded-lg border border-border-subtle/50 bg-surface-raised/30 p-3">
                  {/* The wait leads, not the ratio. "24.4x real-time" is precise
                      and means nothing to most people; "0.4s for 10 seconds of
                      audio" is the same measurement stated as the thing the
                      user was actually wondering. The website quotes this same
                      pair, so the two never disagree. */}
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold text-foreground tabular-nums">
                      {formatBenchmarkWait(benchResult.elapsedMs)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      for {formatBenchmarkClip(benchResult.audioDurationSec)}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {benchResult.provider === "nvidia" ? "Parakeet" : "Whisper"} (
                    {benchResult.model}) · {formatRealtimeFactor(benchResult.realtimeFactor)}{" "}
                    real-time
                    {benchResult.createdAt
                      ? ` · ${formatBenchmarkDate(benchResult.createdAt)}`
                      : ""}
                  </p>
                  {/* Warn if CUDA binary is present but speed is suspiciously low (likely not using GPU) */}
                  {gpuCategory === "nvidia_cuda" &&
                    !activeWhisperForceCpu &&
                    benchResult.realtimeFactor < 2 && (
                      <div className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/8 px-2.5 py-2">
                        <AlertCircle className="w-3 h-3 text-warning mt-0.5 shrink-0" />
                        <p className="text-[10px] text-warning leading-relaxed">
                          The graphics card does not seem to be doing the work. Some newer cards
                          (RTX 50-series) need a newer GPU engine than the one installed.
                        </p>
                      </div>
                    )}
                </div>
              )}

              {(benchState === "running" || compState === "running") && (
                <div className="mb-3 rounded-lg border border-border-subtle/50 bg-surface-raised/30 p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {compState === "running"
                      ? "Running Whisper vs Parakeet comparison - testing both engines on a 10-second sample…"
                      : "Running speed test - transcribing a 10-second sample…"}
                  </div>
                </div>
              )}

              {benchState === "error" && (
                <div className="mb-3 flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="w-3 h-3" />
                  Speed test failed - {benchError}
                </div>
              )}
              {compState === "error" && (
                <div className="mb-3 flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="w-3 h-3" />
                  Comparison failed - {compError}
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  onClick={runBenchmark}
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[11px]"
                  disabled={benchState === "running" || compState === "running"}
                  title={`Benchmarks the active engine - ${activeProvider === "nvidia" ? "Parakeet" : activeWhisperForceCpu ? "Whisper (CPU)" : "Whisper (GPU)"}`}
                >
                  <Timer className="w-3 h-3" />
                  {benchResult ? "Re-run Speed Test" : "Run Speed Test"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── History limit input - free-type with inline confirm when lowering ──

function HistoryLimitInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [raw, setRaw] = React.useState(String(value));
  // Pending is set when the user tries to lower the limit - awaiting confirmation
  const [pending, setPending] = React.useState<number | null>(null);
  const [isConfirming, setIsConfirming] = React.useState(false);

  // Keep raw in sync when committed value changes externally
  React.useEffect(() => {
    if (pending === null) setRaw(String(value));
  }, [value, pending]);

  const commit = () => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0) {
      // Invalid - snap back
      setRaw(String(value));
      return;
    }
    if (parsed < value) {
      // User is lowering the limit - show warning instead of committing
      setPending(parsed);
    } else {
      // Same or higher - commit immediately, no cleanup needed
      onChange(parsed);
      setRaw(String(parsed));
    }
  };

  const [trimError, setTrimError] = React.useState<string | null>(null);

  const handleConfirm = async () => {
    if (pending === null) return;
    if (!window.electronAPI?.trimTranscriptions) {
      setTrimError("Restart the app for this change to take effect.");
      return;
    }
    setIsConfirming(true);
    setTrimError(null);
    try {
      await window.electronAPI.trimTranscriptions(pending);
      onChange(pending);
      setRaw(String(pending));
    } catch (err) {
      console.error("trimTranscriptions failed:", err);
      setTrimError("Failed to delete records. Please try again.");
    } finally {
      setPending(null);
      setIsConfirming(false);
    }
  };

  const handleCancel = () => {
    setPending(null);
    setRaw(String(value));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="numeric"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value.replace(/[^0-9]/g, ""));
            // If user starts typing again, dismiss any pending confirmation
            if (pending !== null) setPending(null);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              handleCancel();
              e.currentTarget.blur();
            }
          }}
          className="w-24 text-right"
          aria-label="History limit"
        />
        <span className="text-xs text-muted-foreground">items</span>
      </div>

      {pending !== null && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs space-y-2">
          <p className="text-warning font-medium">
            ⚠️ This will permanently delete history older than{" "}
            {pending === 0
              ? "all entries"
              : `the newest ${pending} item${pending === 1 ? "" : "s"}`}
            . Records deleted this way cannot be recovered.
          </p>
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" onClick={handleConfirm} disabled={isConfirming}>
              {isConfirming ? "Deleting…" : "Confirm & delete"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
          {trimError && <p className="text-destructive">{trimError}</p>}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────

export default function SettingsPage({ activeSection = "general", onNavigate }: SettingsPageProps) {
  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    whisperServerIdleTimeoutMinutes,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl,
    customDictionary,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
    llamaServerIdleTimeoutMinutes,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey,
    groqApiKey,
    dictationKey,
    theme,
    setTheme,
    activationMode,
    setActivationMode,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
    setUseLocalWhisper,
    setWhisperModel,
    whisperForceCpu,
    setWhisperForceCpu,
    whisperThreads,
    setLocalTranscriptionProvider,
    setWhisperServerIdleTimeoutMinutes,
    setCloudTranscriptionProvider,
    setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl,
    setCloudReasoningBaseUrl,
    setCustomDictionary,
    setUseReasoningModel,
    setReasoningModel,
    setReasoningProvider,
    setOpenaiApiKey,
    setAnthropicApiKey,
    setGeminiApiKey,
    setGroqApiKey,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    customReasoningApiKey,
    setCustomReasoningApiKey,
    setDictationKey,
    historyLimit,
    setHistoryLimit,
    updateTranscriptionSettings,
    updateReasoningSettings,
    preferredLanguage,
    spokenLanguages,
    setSpokenLanguages,
    setPreferredLanguage,
    translateToEnglish,
    setTranslateToEnglish,
    musicDuckingMode,
    setMusicDuckingMode,
    musicDuckLevel,
    setMusicDuckLevel,
    enableVariableSnapping,
    setEnableVariableSnapping,
    enableCorrectionLearning,
    setEnableCorrectionLearning,
    enablePhraseCorrectionLearning,
    setEnablePhraseCorrectionLearning,
    smartContextEnabled,
    setSmartContextEnabled,
    enableFileIdentifiers,
    setEnableFileIdentifiers,
    llmContextEnhancement,
    setLlmContextEnhancement,
    includeFileContentInLlmContext,
    setIncludeFileContentInLlmContext,
    autoPaste,
    setAutoPaste,
    copyToClipboard,
    setCopyToClipboard,
    showPanelOnError,
    setShowPanelOnError,
    pauseMediaOnRecord,
    setPauseMediaOnRecord,
    muteVoiceCallOnRecord,
    setMuteVoiceCallOnRecord,
    voiceCallMuteKey,
    setVoiceCallMuteKey,
    audioFeedback,
    setAudioFeedback,
    errorNotifications,
    setErrorNotifications,
    successConfirmation,
    setSuccessConfirmation,
    overlaySnapToTaskbar,
    setOverlaySnapToTaskbar,
    readAloudEnabled,
    setReadAloudEnabled,
    readAloudHotkey,
    setReadAloudHotkey,
    agentModeEnabled,
    setAgentModeEnabled,
    agentModeHotkey,
    setAgentModeHotkey,
    agentModeRewrite,
    setAgentModeRewrite,
    apiKeySyncError,
    clearApiKeySyncError,
  } = useSettings();

  const [agentModeStatus, setAgentModeStatus] = useState<AgentModeHotkeyStatus | null>(null);
  const [agentModeRewriteStatus, setAgentModeRewriteStatus] =
    useState<AgentModeRewriteStatus | null>(null);
  const [agentModeUsage, setAgentModeUsage] = useState(() => readAgentModeUsage());
  const [isAgentModePro, setIsAgentModePro] = useState(() => getEffectiveEntitlement() === "pro");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bridge = agentModeBridge();
      await bridge
        .agentModeSyncHotkey?.({ enabled: agentModeEnabled, hotkey: agentModeHotkey })
        .catch(() => undefined);
      const status = await bridge.agentModeHotkeyStatus?.().catch(() => undefined);
      if (!cancelled && status) setAgentModeStatus(status);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentModeEnabled, agentModeHotkey]);

  useEffect(() => {
    let cancelled = false;
    void agentModeBridge()
      .agentModeHotkeyStatus?.()
      .then((status) => {
        if (!cancelled && status) setAgentModeStatus(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // A prompt is spent in the overlay window, so the count is re-read whenever
  // this window comes back to the front rather than only on mount.
  useEffect(() => {
    let cancelled = false;
    const refreshAgentModeUsage = () => {
      setAgentModeUsage(readAgentModeUsage());
      setIsAgentModePro(getEffectiveEntitlement() === "pro");
      void agentModeBridge()
        .agentModeRewriteStatus?.()
        .then((status) => {
          if (!cancelled && status) setAgentModeRewriteStatus(status);
        })
        .catch(() => undefined);
    };
    refreshAgentModeUsage();
    window.addEventListener("focus", refreshAgentModeUsage);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshAgentModeUsage);
    };
  }, []);

  // The toggle disables itself on not-found instead of hiding: a row that
  // vanishes reads as a missing feature, a disabled one says what to install.
  const agentModeRewriteBlocked =
    agentModeRewriteStatus !== null && !agentModeRewriteStatus.available;
  const agentModeRewriteLive =
    agentModeRewrite && agentModeRewriteStatus !== null && agentModeRewriteStatus.available;

  const agentModeRewriteDescription = (): string => {
    if (!agentModeRewriteStatus) return "Checking for Claude Code...";
    if (agentModeRewriteStatus.reason === "diagnostic-flag") {
      return "Turned off by a diagnostic flag for this run.";
    }
    if (!agentModeRewriteStatus.available) {
      return "Claude Code was not found on this PC. Prompts are pasted as spoken, with paths in backticks.";
    }
    if (agentModeRewrite) {
      return "Your words go through your own Claude Code login before they are pasted. Nothing else leaves this PC.";
    }
    return "Off. Prompts are pasted as spoken, with paths in backticks.";
  };

  const agentModeStatusDescription = (): string => {
    if (!agentModeEnabled) return "Off. The dictation key works as before.";
    if (!agentModeStatus) return "Checking the key...";
    if (agentModeStatus.registered) {
      return `Listening for ${agentModeKeyLabel(agentModeHotkey)} in every app. Hold it and talk.`;
    }
    switch (agentModeStatus.reason) {
      case "disabled":
        return "Off. The dictation key works as before.";
      case "windows-only":
        return "Windows only for now.";
      case "diagnostic-flag":
        return "Turned off by a diagnostic flag for this run.";
      case "suspended":
        return "Paused while a hotkey field is capturing.";
      default:
        return "The key listener could not start, so the hold key is not live. Restarting PrivateTranscribe usually fixes it.";
    }
  };

  const agentModeKeyClashesWithDictation =
    agentModeEnabled && isAgentModeKeySameAsDictation(agentModeHotkey, dictationKey);

  // Overlay visibility is owned by the main process; mirror it here and stay
  // in sync via the overlay-state-changed broadcast so this toggle can never
  // fight the tray or the overlay's own menu.
  const [overlayMode, setOverlayMode] = useState<"shown" | "snoozed" | "off">("shown");
  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getOverlayState?.()
      .then((state) => {
        if (!cancelled && state?.mode) setOverlayMode(state.mode);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI?.onOverlayStateChanged?.((state) => {
      if (state?.mode) setOverlayMode(state.mode);
    });
    return () => {
      cancelled = true;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  const smartContextUnlocked = isFeatureUnlocked("smart-context");

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isRemovingModels, setIsRemovingModels] = useState(false);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(false);

  // GPU support status and model recommendation - fetched only when the picker is visible.
  const [gpuSupportedForPicker, setGpuSupportedForPicker] = useState(false);
  const [recommendedWhisperModelForPicker, setRecommendedWhisperModelForPicker] = useState<
    string | undefined
  >(undefined);
  useEffect(() => {
    if (activeSection !== "dictation") return;
    window.electronAPI
      ?.detectHardware?.()
      .then((result) => {
        const recommendations = result?.detection?.recommendations;
        setGpuSupportedForPicker(recommendations?.gpuCategory === "nvidia_cuda");
        setRecommendedWhisperModelForPicker(recommendations?.whisperModel);
      })
      .catch(() => {});
  }, [activeSection]);

  // Sync overlay taskbar-snap preference to main process on settings mount.
  // (Overlay visibility is main-process-owned and needs no push-sync.)
  useEffect(() => {
    window.electronAPI?.setOverlaySnapToTaskbar?.(overlaySnapToTaskbar).catch(() => {});
  }, [overlaySnapToTaskbar]);

  // Whisper-server idle shutdown setting (minutes) has a draft state to avoid snapping
  // while typing (e.g. clearing the field).
  const [whisperIdleDraft, setWhisperIdleDraft] = useState<string>(
    String(whisperServerIdleTimeoutMinutes)
  );
  useEffect(() => {
    setWhisperIdleDraft(String(whisperServerIdleTimeoutMinutes));
  }, [whisperServerIdleTimeoutMinutes]);

  // Thread count. `0` means auto, and the resolved value is fetched from main so
  // the field can show what auto actually picked on this machine.
  const [cpuThreadInfo, setCpuThreadInfo] = useState<{
    physicalCores: number;
    logicalCores: number;
    autoThreads: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getCpuThreadInfo?.()
      ?.then((info) => {
        if (!cancelled && info?.success) setCpuThreadInfo(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [whisperThreadsDraft, setWhisperThreadsDraft] = useState<string>(
    whisperThreads > 0 ? String(whisperThreads) : ""
  );
  useEffect(() => {
    setWhisperThreadsDraft(whisperThreads > 0 ? String(whisperThreads) : "");
  }, [whisperThreads]);

  const cachePathHint =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "%USERPROFILE%\\.cache\\PrivateTranscribe\\whisper-models"
      : "~/.cache/PrivateTranscribe/whisper-models";

  // Settings export/import (privacy-first): API keys are excluded by default.
  const [includeApiKeysInExport, setIncludeApiKeysInExport] = useState(false);
  const [allowApiKeysOnImport, setAllowApiKeysOnImport] = useState(false);

  useEffect(() => {
    window.electronAPI
      ?.analyticsGetConsent?.()
      .then((status) => setAnalyticsEnabled(status === "granted"))
      .catch(() => setAnalyticsEnabled(false));
  }, []);

  const handleAnalyticsEnabledChange = useCallback(async (enabled: boolean) => {
    try {
      await window.electronAPI?.analyticsSetConsent?.(enabled);
      setAnalyticsEnabled(enabled);
    } catch {
      // Keep the displayed state unchanged if consent persistence fails.
    }
  }, []);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);

  const buildSettingsExport = useCallback(
    (includeApiKeys: boolean) => {
      const payload: any = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        settings: {
          // General
          theme,
          historyLimit,
          // Dictation control
          dictationKey,
          activationMode,
          // Transcription
          useLocalWhisper,
          localTranscriptionProvider,
          whisperModel,
          whisperForceCpu,
          whisperThreads,
          whisperServerIdleTimeoutMinutes,
          preferredLanguage,
          spokenLanguages,
          translateToEnglish,
          cloudTranscriptionProvider,
          cloudTranscriptionModel,
          cloudTranscriptionBaseUrl,
          // Reasoning
          useReasoningModel,
          reasoningProvider,
          reasoningModel,
          cloudReasoningBaseUrl,
          llamaServerIdleTimeoutMinutes,
          // Preferences
          musicDuckingMode,
          musicDuckLevel,
          enableVariableSnapping,
          enableCorrectionLearning,
          enablePhraseCorrectionLearning,
          smartContextEnabled,
          enableFileIdentifiers,
          llmContextEnhancement,
          includeFileContentInLlmContext,
          // Behavior & Notifications
          autoPaste,
          copyToClipboard,
          showPanelOnError,
          pauseMediaOnRecord,
          audioFeedback,
          errorNotifications,
          successConfirmation,
          overlaySnapToTaskbar,
          // Read Aloud
          readAloudEnabled,
          readAloudHotkey,
          // Agent Mode
          agentModeEnabled,
          agentModeHotkey,
          agentModeRewrite,
          // Devices
          preferBuiltInMic,
          selectedMicDeviceId,
          // Dictionary
          customDictionary,
        },
      };

      // agentName and customUnifiedPrompt live outside useSettings (in raw
      // localStorage), so they're read directly here rather than from React
      // state. Export the raw stored value, not the default — omit the key
      // entirely when unset so importing this file on another machine
      // doesn't stamp a default name/prompt over whatever is already there.
      const rawAgentName = localStorage.getItem(AGENT_NAME_STORAGE_KEY);
      if (rawAgentName !== null) {
        payload.settings.agentName = rawAgentName;
      }
      const storedCustomPrompt = readStoredCustomPrompt();
      if (storedCustomPrompt !== undefined) {
        payload.settings.customUnifiedPrompt = storedCustomPrompt;
      }

      if (includeApiKeys) {
        payload.settings.apiKeys = {
          openaiApiKey,
          anthropicApiKey,
          geminiApiKey,
          groqApiKey,
          customTranscriptionApiKey,
          customReasoningApiKey,
        };
      }

      return payload;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      theme,
      historyLimit,
      dictationKey,
      activationMode,
      useLocalWhisper,
      localTranscriptionProvider,
      whisperModel,
      whisperForceCpu,
      whisperThreads,
      preferredLanguage,
      spokenLanguages,
      translateToEnglish,
      cloudTranscriptionProvider,
      cloudTranscriptionModel,
      cloudTranscriptionBaseUrl,
      useReasoningModel,
      reasoningProvider,
      reasoningModel,
      cloudReasoningBaseUrl,
      musicDuckingMode,
      musicDuckLevel,
      enableVariableSnapping,
      enableCorrectionLearning,
      enablePhraseCorrectionLearning,
      smartContextEnabled,
      enableFileIdentifiers,
      llmContextEnhancement,
      includeFileContentInLlmContext,
      autoPaste,
      copyToClipboard,
      showPanelOnError,
      pauseMediaOnRecord,
      audioFeedback,
      errorNotifications,
      successConfirmation,
      overlaySnapToTaskbar,
      readAloudEnabled,
      readAloudHotkey,
      agentModeEnabled,
      agentModeHotkey,
      agentModeRewrite,
      preferBuiltInMic,
      selectedMicDeviceId,
      customDictionary,
      openaiApiKey,
      anthropicApiKey,
      geminiApiKey,
      groqApiKey,
      customTranscriptionApiKey,
      customReasoningApiKey,
    ]
  );

  const downloadSettings = useCallback(
    (includeApiKeys: boolean) => {
      const payload = buildSettingsExport(includeApiKeys);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `privatetranscribe-settings${includeApiKeys ? "-with-keys" : ""}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    [buildSettingsExport]
  );

  const applyImportedSettings = useCallback(
    async (data: any) => {
      const s = data?.settings || data;
      if (!s || typeof s !== "object") throw new Error("Invalid settings file");
      const skippedFields: string[] = [];
      const skipField = (field: string, reason: string) => {
        skippedFields.push(`${field}: ${reason}`);
      };
      const validWhisperModels = new Set(getValidWhisperModelNames());

      let importedHistoryLimit: number | undefined;
      if (s.historyLimit !== undefined) {
        if (Number.isInteger(s.historyLimit) && s.historyLimit > 0) {
          importedHistoryLimit = clamp(s.historyLimit, HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX);
        } else {
          skipField("historyLimit", "must be a positive integer");
        }
      }

      let importedWhisperIdleTimeout: number | undefined;
      if (s.whisperServerIdleTimeoutMinutes !== undefined) {
        if (
          Number.isInteger(s.whisperServerIdleTimeoutMinutes) &&
          s.whisperServerIdleTimeoutMinutes > 0
        ) {
          importedWhisperIdleTimeout = clamp(
            s.whisperServerIdleTimeoutMinutes,
            WHISPER_IDLE_TIMEOUT_MIN,
            WHISPER_IDLE_TIMEOUT_MAX
          );
        } else {
          skipField("whisperServerIdleTimeoutMinutes", "must be a positive integer");
        }
      }

      let importedWhisperModel: string | undefined;
      if (s.whisperModel !== undefined) {
        if (typeof s.whisperModel === "string" && validWhisperModels.has(s.whisperModel)) {
          importedWhisperModel = s.whisperModel;
        } else {
          skipField("whisperModel", "must be a known Whisper model ID");
        }
      }

      const importedLanguage = s.whisperLanguage ?? s.preferredLanguage;
      let importedPreferredLanguage: string | undefined;
      if (importedLanguage !== undefined) {
        if (importedLanguage === null) {
          importedPreferredLanguage = "auto";
        } else if (isValidImportedLanguage(importedLanguage)) {
          importedPreferredLanguage = importedLanguage;
        } else {
          skipField("preferredLanguage", "must be a valid BCP-47 language code or null");
        }
      }

      // Normalisation is the validation here: unknown codes, duplicates and
      // anything past the cap are dropped rather than trusted, so a
      // hand-edited file cannot pin dictation to a language Whisper will
      // reject.
      if (s.spokenLanguages !== undefined) {
        const importedSpokenLanguages = normalizeSpokenLanguages(s.spokenLanguages);
        if (importedSpokenLanguages.length > 0) {
          setSpokenLanguages(importedSpokenLanguages);
        } else {
          skipField("spokenLanguages", "must be a list of supported language codes");
        }
      }

      const safeIdentifier = (field: string): string | undefined => {
        const value = s[field];
        if (value === undefined) return undefined;
        if (isSafeImportedIdentifier(value)) return value;
        skipField(field, "contains unsafe path-like content");
        return undefined;
      };
      const safeNonPathString = (field: string): string | undefined => {
        const value = s[field];
        if (value === undefined) return undefined;
        if (typeof value === "string" && !isPathLikeString(value)) return value;
        skipField(field, "contains unsafe path-like content");
        return undefined;
      };

      if (s.theme === "light" || s.theme === "dark" || s.theme === "auto") setTheme(s.theme);
      if (importedHistoryLimit !== undefined) setHistoryLimit(importedHistoryLimit);
      if (typeof s.dictationKey === "string") setDictationKey(s.dictationKey);
      if (
        s.activationMode === "tap" ||
        s.activationMode === "push" ||
        s.activationMode === "tapHold"
      )
        setActivationMode(s.activationMode);

      updateTranscriptionSettings({
        useLocalWhisper: typeof s.useLocalWhisper === "boolean" ? s.useLocalWhisper : undefined,
        localTranscriptionProvider:
          s.localTranscriptionProvider === "nvidia" || s.localTranscriptionProvider === "whisper"
            ? "whisper"
            : undefined,
        whisperModel: importedWhisperModel,
        whisperForceCpu: typeof s.whisperForceCpu === "boolean" ? s.whisperForceCpu : undefined,
        whisperThreads: typeof s.whisperThreads === "number" ? s.whisperThreads : undefined,
        whisperServerIdleTimeoutMinutes: importedWhisperIdleTimeout,
        preferredLanguage: importedPreferredLanguage,
        translateToEnglish:
          s.translateToEnglish === "on" || s.translateToEnglish === "off"
            ? s.translateToEnglish
            : undefined,
        cloudTranscriptionProvider: safeIdentifier("cloudTranscriptionProvider"),
        cloudTranscriptionModel: safeIdentifier("cloudTranscriptionModel"),
        cloudTranscriptionBaseUrl: safeNonPathString("cloudTranscriptionBaseUrl"),
        customDictionary: Array.isArray(s.customDictionary) ? s.customDictionary : undefined,
      });

      updateReasoningSettings({
        useReasoningModel:
          typeof s.useReasoningModel === "boolean" ? s.useReasoningModel : undefined,
        reasoningProvider: safeIdentifier("reasoningProvider"),
        reasoningModel: safeIdentifier("reasoningModel"),
        cloudReasoningBaseUrl: safeNonPathString("cloudReasoningBaseUrl"),
        llamaServerIdleTimeoutMinutes:
          typeof s.llamaServerIdleTimeoutMinutes === "number"
            ? s.llamaServerIdleTimeoutMinutes
            : undefined,
      });

      if (
        s.musicDuckingMode === "off" ||
        s.musicDuckingMode === "duck" ||
        s.musicDuckingMode === "mute"
      ) {
        setMusicDuckingMode(s.musicDuckingMode);
      }
      if (typeof s.musicDuckLevel === "number") setMusicDuckLevel(s.musicDuckLevel);
      if (typeof s.enableVariableSnapping === "boolean")
        setEnableVariableSnapping(s.enableVariableSnapping);
      if (typeof s.enableCorrectionLearning === "boolean")
        setEnableCorrectionLearning(s.enableCorrectionLearning);
      if (typeof s.enablePhraseCorrectionLearning === "boolean")
        setEnablePhraseCorrectionLearning(s.enablePhraseCorrectionLearning);
      if (typeof s.smartContextEnabled === "boolean") setSmartContextEnabled(s.smartContextEnabled);
      if (typeof s.enableFileIdentifiers === "boolean")
        setEnableFileIdentifiers(s.enableFileIdentifiers);
      if (typeof s.llmContextEnhancement === "boolean")
        setLlmContextEnhancement(s.llmContextEnhancement);
      if (typeof s.includeFileContentInLlmContext === "boolean")
        setIncludeFileContentInLlmContext(s.includeFileContentInLlmContext);
      if (typeof s.autoPaste === "boolean") setAutoPaste(s.autoPaste);
      if (typeof s.copyToClipboard === "boolean") setCopyToClipboard(s.copyToClipboard);
      if (typeof s.showPanelOnError === "boolean") setShowPanelOnError(s.showPanelOnError);
      if (typeof s.pauseMediaOnRecord === "boolean") setPauseMediaOnRecord(s.pauseMediaOnRecord);
      if (typeof s.audioFeedback === "boolean") setAudioFeedback(s.audioFeedback);
      if (typeof s.errorNotifications === "boolean") setErrorNotifications(s.errorNotifications);
      if (typeof s.successConfirmation === "boolean") setSuccessConfirmation(s.successConfirmation);
      if (typeof s.overlaySnapToTaskbar === "boolean") {
        setOverlaySnapToTaskbar(s.overlaySnapToTaskbar);
        window.electronAPI?.setOverlaySnapToTaskbar?.(s.overlaySnapToTaskbar).catch(() => {});
      }

      if (typeof s.readAloudEnabled === "boolean") setReadAloudEnabled(s.readAloudEnabled);
      if (s.readAloudHotkey !== undefined) {
        if (isSafeImportedIdentifier(s.readAloudHotkey)) {
          setReadAloudHotkey(s.readAloudHotkey);
        } else {
          skipField("readAloudHotkey", "contains unsafe path-like content");
        }
      }

      if (typeof s.agentModeEnabled === "boolean") setAgentModeEnabled(s.agentModeEnabled);
      if (typeof s.agentModeRewrite === "boolean") setAgentModeRewrite(s.agentModeRewrite);
      if (s.agentModeHotkey !== undefined) {
        if (
          isSafeImportedIdentifier(s.agentModeHotkey) &&
          AGENT_MODE_HOTKEY_OPTIONS.some((option) => option.value === s.agentModeHotkey)
        ) {
          setAgentModeHotkey(s.agentModeHotkey);
        } else {
          skipField("agentModeHotkey", "is not one of the Agent Mode keys");
        }
      }

      if (typeof s.preferBuiltInMic === "boolean") setPreferBuiltInMic(s.preferBuiltInMic);
      if (s.selectedMicDeviceId !== undefined) {
        if (isSafeImportedIdentifier(s.selectedMicDeviceId)) {
          setSelectedMicDeviceId(s.selectedMicDeviceId);
        } else {
          skipField("selectedMicDeviceId", "contains unsafe path-like content");
        }
      }

      // agentName and customUnifiedPrompt are absent from older export files
      // (they weren't captured before this gate) — that must import cleanly
      // with no behavior change, so both blocks are no-ops when the key is
      // missing rather than clearing the existing value.
      if (s.agentName !== undefined) {
        const trimmedAgentName = typeof s.agentName === "string" ? s.agentName.trim() : "";
        if (
          isSafeImportedIdentifier(trimmedAgentName) &&
          trimmedAgentName.length <= AGENT_NAME_MAX_LENGTH
        ) {
          persistAgentName(trimmedAgentName);
        } else {
          skipField(
            "agentName",
            `must be a non-empty name under ${AGENT_NAME_MAX_LENGTH} characters`
          );
        }
      }

      if (s.customUnifiedPrompt !== undefined) {
        if (
          typeof s.customUnifiedPrompt === "string" &&
          s.customUnifiedPrompt.length <= CUSTOM_PROMPT_MAX_LENGTH
        ) {
          // Written the same way PromptStudio.savePrompt() writes it, so it
          // reads back correctly via PromptStudio's getCurrentPrompt().
          localStorage.setItem(CUSTOM_PROMPT_STORAGE_KEY, JSON.stringify(s.customUnifiedPrompt));
        } else {
          skipField(
            "customUnifiedPrompt",
            `must be a string under ${CUSTOM_PROMPT_MAX_LENGTH} characters`
          );
        }
      }

      if (allowApiKeysOnImport) {
        const keys = s.apiKeys || {};
        if (typeof keys.openaiApiKey === "string") setOpenaiApiKey(keys.openaiApiKey);
        if (typeof keys.anthropicApiKey === "string") setAnthropicApiKey(keys.anthropicApiKey);
        if (typeof keys.geminiApiKey === "string") setGeminiApiKey(keys.geminiApiKey);
        if (typeof keys.groqApiKey === "string") setGroqApiKey(keys.groqApiKey);
        if (typeof keys.customTranscriptionApiKey === "string")
          setCustomTranscriptionApiKey(keys.customTranscriptionApiKey);
        if (typeof keys.customReasoningApiKey === "string")
          setCustomReasoningApiKey(keys.customReasoningApiKey);
      }

      if (skippedFields.length > 0) {
        console.warn("Skipped unsafe or invalid imported settings", skippedFields);
      }
      return skippedFields;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      allowApiKeysOnImport,
      setTheme,
      setHistoryLimit,
      setDictationKey,
      setActivationMode,
      updateTranscriptionSettings,
      updateReasoningSettings,
      setMusicDuckingMode,
      setMusicDuckLevel,
      setEnableVariableSnapping,
      setEnableCorrectionLearning,
      setEnablePhraseCorrectionLearning,
      setPauseMediaOnRecord,
      setPreferBuiltInMic,
      setSelectedMicDeviceId,
      persistAgentName,
      setOpenaiApiKey,
      setAnthropicApiKey,
      setGeminiApiKey,
      setGroqApiKey,
      setCustomTranscriptionApiKey,
      setCustomReasoningApiKey,
    ]
  );

  const handleImportSettingsFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Settings file is not valid JSON");
      }
      await applyImportedSettings(parsed);
    },
    [applyImportedSettings]
  );

  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress: updateDownloadProgress,
    isChecking: checkingForUpdates,
    isDownloading: downloadingUpdate,
    isInstalling: installInitiated,
    checkForUpdates,
    downloadUpdate,
    installUpdate: installUpdateAction,
    getAppVersion,
    error: updateError,
  } = useUpdater();

  const isUpdateAvailable =
    !updateStatus.isDevelopment && (updateStatus.updateAvailable || updateStatus.updateDownloaded);

  const permissionsHook = usePermissions(showAlertDialog, { checkPasteToolsOnMount: false });
  const { checkPasteToolsAvailability } = permissionsHook;
  useClipboard(showAlertDialog);
  const installTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);

  const platform = useMemo(() => {
    if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
      return window.electronAPI.getPlatform();
    }
    return "linux";
  }, []);

  /**
   * Whether the current model supports translation.
   * Whisper Turbo silently ignores the translate flag.
   */
  const translationSupported = useMemo(() => {
    if (!useLocalWhisper) return true; // cloud providers handle their own
    if (localTranscriptionProvider === "nvidia") return false; // Parakeet doesn't translate
    return whisperModel !== "turbo";
  }, [useLocalWhisper, localTranscriptionProvider, whisperModel]);

  const hasExplicitNonEnglishSpeechLanguage = Boolean(
    preferredLanguage && preferredLanguage !== "auto" && preferredLanguage !== "en"
  );
  const canTranslateToEnglish = translationSupported && hasExplicitNonEnglishSpeechLanguage;
  const outputLanguageHelp = !hasExplicitNonEnglishSpeechLanguage
    ? preferredLanguage === "auto"
      ? "Choose a spoken language, like Danish, before enabling English output. Auto-detect keeps the transcript in the detected speech language."
      : "English output is only needed when your spoken language is not English."
    : !translationSupported
      ? localTranscriptionProvider === "nvidia"
        ? "Parakeet does not translate. Use Same as speech, or switch to Whisper Large/Medium for English output."
        : "Whisper Turbo does not reliably support translation. Use Same as speech, or switch to Large/Medium for English output."
      : "Same as speech keeps Danish as Danish. English uses Whisper translation when supported.";

  // Auto-disable translation when switching to a model/language where the English output option is invalid.
  useEffect(() => {
    if (!canTranslateToEnglish && translateToEnglish === "on") {
      setTranslateToEnglish("off");
    }
  }, [canTranslateToEnglish, translateToEnglish, setTranslateToEnglish]);

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLaunchMode, setAutoStartLaunchMode] = useState<AutoStartLaunchMode>("tray");
  const [emailCopied, setEmailCopied] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);
  const [autoStartError, setAutoStartError] = useState<string | null>(null);

  useEffect(() => {
    if (platform === "linux") {
      setAutoStartLoading(false);
      return;
    }
    const loadAutoStart = async () => {
      if (window.electronAPI?.getAutoStartEnabled) {
        try {
          const [enabled, launchMode] = await Promise.all([
            window.electronAPI.getAutoStartEnabled(),
            window.electronAPI.getAutoStartLaunchMode?.() ?? Promise.resolve("tray"),
          ]);
          setAutoStartEnabled(enabled);
          setAutoStartLaunchMode(launchMode);
        } catch (error) {
          console.error("Failed to get auto-start status:", error);
        }
      }
      setAutoStartLoading(false);
    };
    loadAutoStart();
  }, [platform]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (window.electronAPI?.setAutoStartEnabled) {
      try {
        setAutoStartLoading(true);
        setAutoStartError(null);
        const result = await window.electronAPI.setAutoStartEnabled(enabled);
        // Trust the verified state the main process read back, never the requested one —
        // a blocked registry write must not leave the toggle claiming it worked.
        setAutoStartEnabled(result.enabled ?? (result.success ? enabled : !enabled));
        if (!result.success) {
          setAutoStartError(result.error || "Couldn't change the startup setting.");
        }
      } catch (error) {
        console.error("Failed to set auto-start:", error);
        setAutoStartError("Couldn't change the startup setting.");
      } finally {
        setAutoStartLoading(false);
      }
    }
  };

  const handleAutoStartLaunchModeChange = async (mode: AutoStartLaunchMode) => {
    if (window.electronAPI?.setAutoStartLaunchMode) {
      const previousMode = autoStartLaunchMode;
      try {
        setAutoStartLaunchMode(mode);
        const result = await window.electronAPI.setAutoStartLaunchMode(mode);
        if (!result.success) {
          setAutoStartLaunchMode(previousMode);
        } else if (result.launchMode) {
          setAutoStartLaunchMode(result.launchMode);
        }
      } catch (error) {
        setAutoStartLaunchMode(previousMode);
        console.error("Failed to set auto-start launch mode:", error);
      }
    }
  };

  useEffect(() => {
    let mounted = true;

    const timer = setTimeout(async () => {
      if (!mounted) return;

      const version = await getAppVersion();
      if (version && mounted) setCurrentVersion(version);
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [getAppVersion]);

  useEffect(() => {
    if (activeSection !== "permissions") return;
    checkPasteToolsAvailability();
  }, [activeSection, checkPasteToolsAvailability]);

  useEffect(() => {
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo();
        if (info?.isUsingGnome) {
          setIsUsingGnomeHotkeys(true);
          setActivationMode("tap");
        }
      } catch (error) {
        console.error("Failed to check hotkey mode:", error);
      }
    };
    checkHotkeyMode();
  }, [setActivationMode]);

  useEffect(() => {
    if (updateError) {
      showAlertDialog({
        title: "Update Error",
        description:
          updateError.message ||
          "The updater encountered a problem. Please try again or download the latest release manually.",
      });
    }
  }, [updateError, showAlertDialog]);

  useEffect(() => {
    if (installInitiated) {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
      }
      installTimeoutRef.current = setTimeout(() => {
        showAlertDialog({
          title: "Still Running",
          description:
            "PrivateTranscribe didn't restart automatically. Please quit the app manually to finish installing the update.",
        });
      }, 10000);
    } else if (installTimeoutRef.current) {
      clearTimeout(installTimeoutRef.current);
      installTimeoutRef.current = null;
    }

    return () => {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
        installTimeoutRef.current = null;
      }
    };
  }, [installInitiated, showAlertDialog]);

  const resetAccessibilityPermissions = () => {
    const message = `To fix accessibility permissions:\n\n1. Open System Settings > Privacy & Security > Accessibility\n2. Remove any old PrivateTranscribe or Electron entries\n3. Click (+) and add the current PrivateTranscribe app\n4. Make sure the checkbox is enabled\n5. Restart PrivateTranscribe\n\nClick OK to open System Settings.`;

    showConfirmDialog({
      title: "Reset Accessibility Permissions",
      description: message,
      onConfirm: () => {
        permissionsHook.openAccessibilitySettings();
      },
    });
  };

  const handleRemoveModels = useCallback(() => {
    if (isRemovingModels) return;

    showConfirmDialog({
      title: "Remove downloaded models?",
      description: `This deletes all locally cached Whisper models (${cachePathHint}) and frees disk space. You can download them again from the model picker.`,
      confirmText: "Delete Models",
      variant: "destructive",
      onConfirm: () => {
        setIsRemovingModels(true);
        window.electronAPI
          ?.deleteAllWhisperModels?.()
          .then((result) => {
            if (!result?.success) {
              showAlertDialog({
                title: "Unable to Remove Models",
                description:
                  result?.error || "Something went wrong while deleting the cached models.",
              });
              return;
            }

            window.dispatchEvent(new Event("PrivateTranscribe-models-cleared"));

            showAlertDialog({
              title: "Models Removed",
              description:
                "All downloaded Whisper models were deleted. You can re-download any model from the picker when needed.",
            });
          })
          .catch((error) => {
            showAlertDialog({
              title: "Unable to Remove Models",
              description: error?.message || "An unknown error occurred.",
            });
          })
          .finally(() => {
            setIsRemovingModels(false);
          });
      },
    });
  }, [isRemovingModels, cachePathHint, showConfirmDialog, showAlertDialog]);

  const renderSectionContent = () => {
    switch (activeSection) {
      // ───────────────────────────────────────────────────
      // GENERAL - Updates, CUDA, Startup, Behavior, Notifications, Privacy, Help
      // ───────────────────────────────────────────────────
      case "general":
        return (
          <div className="space-y-8">
            {/* Updates */}
            <div>
              <SectionHeader
                title="Updates"
                description="Keep PrivateTranscribe up to date with the latest features and improvements"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Current version"
                    description={
                      updateStatus.isDevelopment
                        ? "Running in development mode"
                        : updateStatus.manualInstallRequired
                          ? "This unpacked copy needs the official installer"
                          : isUpdateAvailable
                            ? "A newer version is available"
                            : "You're on the latest version"
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-[13px] tabular-nums text-muted-foreground font-mono">
                        {currentVersion || "..."}
                      </span>
                      {updateStatus.isDevelopment ? (
                        <Badge variant="warning">Dev</Badge>
                      ) : updateStatus.manualInstallRequired ? (
                        <Badge variant="warning">Installer</Badge>
                      ) : isUpdateAvailable ? (
                        <Badge variant="success">Update</Badge>
                      ) : (
                        <Badge variant="outline">Latest</Badge>
                      )}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <div className="space-y-2.5">
                    {updateStatus.manualInstallRequired ? (
                      <Button
                        onClick={() =>
                          window.electronAPI.openExternal(
                            updateStatus.manualInstallUrl ||
                              "https://privatetranscribe.com/download/windows"
                          )
                        }
                        variant="success"
                        className="w-full"
                        size="sm"
                      >
                        <Download size={13} className="mr-1.5" />
                        Download Official Installer
                      </Button>
                    ) : (
                      <Button
                        onClick={async () => {
                          try {
                            const result = await checkForUpdates();
                            if (result?.updateAvailable) {
                              showAlertDialog({
                                title: "Update Available",
                                description: `Update available - v${result.version || "new version"}`,
                              });
                            } else {
                              showAlertDialog({
                                title: "No Updates",
                                description: result?.message || "No updates available",
                              });
                            }
                          } catch (error: any) {
                            showAlertDialog({
                              title: "Update Check Failed",
                              description: `Error checking for updates: ${error.message}`,
                            });
                          }
                        }}
                        disabled={checkingForUpdates || updateStatus.isDevelopment}
                        variant="outline"
                        className="w-full"
                        size="sm"
                      >
                        <RefreshCw
                          size={13}
                          className={`mr-1.5 ${checkingForUpdates ? "animate-spin" : ""}`}
                        />
                        {checkingForUpdates ? "Checking..." : "Check for Updates"}
                      </Button>
                    )}

                    {isUpdateAvailable && !updateStatus.updateDownloaded && (
                      <div className="space-y-2">
                        <Button
                          onClick={async () => {
                            try {
                              await downloadUpdate();
                            } catch (error: any) {
                              showAlertDialog({
                                title: "Download Failed",
                                description: `Failed to download update: ${error.message}`,
                              });
                            }
                          }}
                          disabled={downloadingUpdate}
                          variant="success"
                          className="w-full"
                          size="sm"
                        >
                          <Download
                            size={13}
                            className={`mr-1.5 ${downloadingUpdate ? "animate-pulse" : ""}`}
                          />
                          {downloadingUpdate
                            ? `Downloading... ${Math.round(updateDownloadProgress)}%`
                            : `Download Update${updateInfo?.version ? ` v${updateInfo.version}` : ""}`}
                        </Button>

                        {downloadingUpdate && (
                          <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50">
                            <div
                              className="h-full bg-success transition-all duration-200 rounded-full"
                              style={{
                                width: `${Math.min(100, Math.max(0, updateDownloadProgress))}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {updateStatus.updateDownloaded && (
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: "Install Update",
                            description: `Ready to install update${updateInfo?.version ? ` v${updateInfo.version}` : ""}. The app will restart to complete installation.`,
                            confirmText: "Install & Restart",
                            onConfirm: async () => {
                              try {
                                await installUpdateAction();
                              } catch (error: any) {
                                showAlertDialog({
                                  title: "Install Failed",
                                  description: `Failed to install update: ${error.message}`,
                                });
                              }
                            },
                          });
                        }}
                        disabled={installInitiated}
                        className="w-full"
                        size="sm"
                      >
                        <RefreshCw
                          size={14}
                          className={`mr-2 ${installInitiated ? "animate-spin" : ""}`}
                        />
                        {installInitiated ? "Restarting..." : "Install & Restart"}
                      </Button>
                    )}
                  </div>

                  {updateInfo?.releaseNotes && (
                    <div className="mt-4 pt-4 border-t border-border/30">
                      <SectionLabel className="mb-2">
                        What's new in v{updateInfo.version}
                      </SectionLabel>
                      <div className="text-[12px] text-muted-foreground">
                        <MarkdownRenderer content={updateInfo.releaseNotes} />
                      </div>
                    </div>
                  )}
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* CUDA Engine Updates */}
            <div>
              <SectionHeader
                title="GPU speed-up"
                description="The separate engine that lets local Whisper run on your NVIDIA graphics card"
              />
              <CudaEngineUpdateCard />
            </div>

            {/* Startup */}
            {platform !== "linux" && (
              <div>
                <SectionHeader
                  title="Startup"
                  description="Control whether PrivateTranscribe launches when you start your computer"
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Launch PrivateTranscribe when you start your computer"
                      description="Your dictation hotkey is ready to go the moment you log in."
                    >
                      <Toggle
                        checked={autoStartEnabled}
                        onChange={(checked: boolean) => handleAutoStartChange(checked)}
                        disabled={autoStartLoading}
                      />
                    </SettingsRow>
                    {autoStartError && (
                      <p className="text-[13px] text-destructive mt-2 leading-relaxed">
                        {autoStartError}
                      </p>
                    )}
                  </SettingsPanelRow>

                  {autoStartEnabled && (
                    <SettingsPanelRow>
                      <SettingsRow
                        label="At login, open as"
                        description={
                          autoStartLaunchMode === "tray"
                            ? "Recommended - starts quietly in the tray without opening a window."
                            : autoStartLaunchMode === "minimized"
                              ? "Shows a taskbar entry, but does not steal focus."
                              : "Opens the control panel so the app is visible immediately."
                        }
                      >
                        <Select
                          value={autoStartLaunchMode}
                          onValueChange={(value) =>
                            handleAutoStartLaunchModeChange(value as AutoStartLaunchMode)
                          }
                        >
                          <SelectTrigger className="w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="tray">Tray only</SelectItem>
                            <SelectItem value="minimized">Minimized</SelectItem>
                            <SelectItem value="window">Open window</SelectItem>
                          </SelectContent>
                        </Select>
                      </SettingsRow>
                    </SettingsPanelRow>
                  )}
                </SettingsPanel>
              </div>
            )}
            {/* Audio Ducking */}
            <div className="border-t border-border/30 pt-8">
              <SectionHeader
                title="Audio Ducking"
                description="Automatically lower or mute system audio while you are dictating"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="While recording"
                    description="Choose what happens to system volume when you start dictating"
                  >
                    <div className="flex gap-1.5">
                      {(["off", "duck", "mute"] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setMusicDuckingMode(mode)}
                          className={[
                            "px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                            musicDuckingMode === mode
                              ? "bg-primary text-primary-foreground shadow-sm"
                              : "bg-surface-raised border border-border-subtle text-muted-foreground hover:text-foreground hover:border-border",
                          ].join(" ")}
                        >
                          {mode === "off" ? "Off" : mode === "duck" ? "Lower volume" : "Mute"}
                        </button>
                      ))}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>

                {musicDuckingMode === "duck" && (
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Volume while recording"
                      description={`Volume is reduced to ${Math.round(musicDuckLevel * 100)}% of your current level while recording`}
                    >
                      <div className="flex items-center gap-3">
                        <Slider
                          min={5}
                          max={80}
                          step={5}
                          value={Math.round(musicDuckLevel * 100)}
                          onChange={(e) => setMusicDuckLevel(parseInt(e.target.value, 10) / 100)}
                          className="w-28"
                          aria-label="Duck volume level"
                        />
                        <span className="text-xs tabular-nums text-muted-foreground w-8">
                          {Math.round(musicDuckLevel * 100)}%
                        </span>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                )}
                <SettingsPanelRow>
                  <SettingsRow
                    label="Pause media while recording"
                    description={
                      platform === "win32"
                        ? "Coming soon on Windows - media session control is being reworked for reliability"
                        : "Automatically pause playing media when you start recording"
                    }
                  >
                    {platform === "win32" ? (
                      <span className="text-[11px] text-muted-foreground/50 font-medium uppercase tracking-wide px-2 py-1 rounded border border-border-subtle">
                        Soon
                      </span>
                    ) : (
                      <Toggle checked={pauseMediaOnRecord} onChange={setPauseMediaOnRecord} />
                    )}
                  </SettingsRow>
                </SettingsPanelRow>
                {platform === "win32" && (
                  <SettingsPanelRow>
                    <VoiceCallMuteSettings
                      enabled={muteVoiceCallOnRecord}
                      onEnabledChange={setMuteVoiceCallOnRecord}
                      muteKey={voiceCallMuteKey}
                      onMuteKeyChange={setVoiceCallMuteKey}
                      conflicts={[
                        { label: "Dictation", hotkey: dictationKey },
                        { label: "Read Aloud", hotkey: readAloudHotkey },
                      ]}
                    />
                  </SettingsPanelRow>
                )}
              </SettingsPanel>
            </div>

            {/* Behavior */}
            <div>
              <SectionHeader
                title="Behavior"
                description="Customize how PrivateTranscribe responds after transcription"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Auto-paste transcription"
                    description="Automatically paste text where your cursor is after transcribing"
                  >
                    <Toggle checked={autoPaste} onChange={setAutoPaste} />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Copy to clipboard"
                    description="Also save transcription to clipboard for manual pasting"
                  >
                    <Toggle checked={copyToClipboard} onChange={setCopyToClipboard} />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Show control panel on error"
                    description="Automatically open settings when transcription fails"
                  >
                    <Toggle checked={showPanelOnError} onChange={setShowPanelOnError} />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Snap overlay to taskbar"
                    description="Keep the overlay aligned with the taskbar edge. You can still drag it along the taskbar and onto another monitor."
                  >
                    <Toggle
                      checked={overlaySnapToTaskbar}
                      onChange={(checked) => {
                        setOverlaySnapToTaskbar(checked);
                        window.electronAPI?.setOverlaySnapToTaskbar?.(checked).catch(() => {});
                      }}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Hide overlay"
                    description={
                      overlayMode === "snoozed"
                        ? "The overlay is temporarily hidden from its right-click menu and will come back on its own. Turning this on hides it permanently instead."
                        : "Completely hide the dictation panel. Dictation still works in the background when you press your hotkey. Useful for gaming or fullscreen apps to prevent lag."
                    }
                  >
                    <Toggle
                      checked={overlayMode === "off"}
                      onChange={(checked) => {
                        const mode = checked ? "off" : "shown";
                        setOverlayMode(mode);
                        window.electronAPI?.setOverlayMode?.(mode).catch(() => {});
                      }}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Notifications */}
            <div>
              <SectionHeader
                title="Notifications"
                description="Configure alerts and feedback during dictation"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Audio feedback"
                    description="Play sounds when starting and stopping recording"
                  >
                    <Toggle checked={audioFeedback} onChange={setAudioFeedback} />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Error notifications"
                    description="Show system notifications when transcription fails"
                  >
                    <Toggle checked={errorNotifications} onChange={setErrorNotifications} />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Success confirmation"
                    description="Brief notification when transcription completes successfully"
                  >
                    <Toggle checked={successConfirmation} onChange={setSuccessConfirmation} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Privacy & History */}
            <div className="border-t border-border/30 pt-8">
              <SectionHeader
                title="Privacy & History"
                description="Control what leaves your device and how long transcriptions are kept"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Optional product analytics"
                    description="Share setup milestones, feature usage, transcription speed, language and model settings, and CPU, GPU, or cloud mode using a random app ID. Never sends audio, transcripts, window titles, filenames, or API keys."
                  >
                    <Toggle checked={analyticsEnabled} onChange={handleAnalyticsEnabledChange} />
                  </SettingsRow>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <SettingsRow
                    label="History limit"
                    description="Number of transcriptions to keep. Set to 0 to disable history."
                  >
                    <HistoryLimitInput value={historyLimit} onChange={setHistoryLimit} />
                  </SettingsRow>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <SettingsRow
                    label="Smart Context"
                    badge={smartContextUnlocked ? undefined : <BetaBadge locked />}
                    description={
                      smartContextUnlocked ? (
                        "Feed frontmost app name and window title to Whisper for better accuracy. Always local - never sent to cloud."
                      ) : (
                        <>
                          Still being built, so it is limited to approved testers for now. Nothing
                          about your screen is being read. <BetaAccessLink />
                        </>
                      )
                    }
                  >
                    <Toggle
                      checked={smartContextEnabled}
                      onChange={setSmartContextEnabled}
                      disabled={!smartContextUnlocked}
                    />
                  </SettingsRow>
                </SettingsPanelRow>

                {smartContextUnlocked && smartContextEnabled && (
                  <SettingsPanelRow>
                    <InfoBox variant="muted" className="text-xs leading-relaxed">
                      <p className="font-medium text-foreground mb-1.5">
                        What Smart Context reads, and what it protects
                      </p>
                      <ul className="space-y-1 text-muted-foreground list-disc pl-4">
                        <li>
                          Captures only the <span className="text-foreground">app name</span> and{" "}
                          <span className="text-foreground">window title</span> of whatever you're
                          typing into — never your keystrokes or screen contents.
                        </li>
                        <li>
                          Stays <span className="text-foreground">on your device</span>. Nothing
                          leaves your computer unless you turn on “LLM Context Enhancement” below.
                        </li>
                        <li>
                          Automatically skips{" "}
                          <span className="text-foreground">
                            password managers, banking apps, and system login / UAC prompts
                          </span>{" "}
                          so sensitive windows are never read.
                        </li>
                      </ul>
                    </InfoBox>
                  </SettingsPanelRow>
                )}

                {smartContextUnlocked && smartContextEnabled && (
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Active file context"
                      description="Reads variable and function names from your active file to improve code dictation accuracy. Local only - file content stays on your device."
                    >
                      <Toggle checked={enableFileIdentifiers} onChange={setEnableFileIdentifiers} />
                    </SettingsRow>
                  </SettingsPanelRow>
                )}

                {smartContextUnlocked && useReasoningModel && (
                  <>
                    <SettingsPanelRow>
                      <SettingsRow
                        label="LLM Context Enhancement"
                        description={
                          useReasoningModel && reasoningProvider !== "local"
                            ? "Also sends context to the AI reasoning step. ⚠️ Context (app name, window title) will be sent to your cloud reasoning provider."
                            : "Also sends context to the AI reasoning step. Context is processed by your local model only."
                        }
                      >
                        <Toggle
                          checked={llmContextEnhancement}
                          onChange={setLlmContextEnhancement}
                          disabled={!smartContextUnlocked}
                        />
                      </SettingsRow>
                    </SettingsPanelRow>

                    {llmContextEnhancement && (
                      <SettingsPanelRow>
                        <SettingsRow
                          label="Include active file content"
                          description={
                            reasoningProvider !== "local"
                              ? "Adds a truncated excerpt from your active file to the reasoning prompt. ⚠️ File content will be sent to your cloud reasoning provider."
                              : "Adds a truncated excerpt from your active file to the reasoning prompt. Stays on-device when using a local reasoning model."
                          }
                        >
                          <Toggle
                            checked={includeFileContentInLlmContext}
                            onChange={setIncludeFileContentInLlmContext}
                          />
                        </SettingsRow>
                      </SettingsPanelRow>
                    )}
                  </>
                )}
              </SettingsPanel>
            </div>

            {/* Help & Support */}
            <div className="border-t border-border/30 pt-8">
              <SectionHeader
                title="Help & Support"
                description="Report a problem or send feedback"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Contact & Feedback"
                    description="In-app feedback is available from Send Feedback for early access testers. No email app required, and no audio/transcripts/logs are sent. Screenshots are sent only if attached."
                  >
                    <div className="flex items-center gap-2">
                      <FeedbackDialog currentVersion={currentVersion} source="settings-help" />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard?.writeText("support@privatetranscribe.com");
                          setEmailCopied(true);
                          setTimeout(() => setEmailCopied(false), 2000);
                        }}
                      >
                        {emailCopied ? "✓ Copied!" : "Copy Email"}
                      </Button>
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      // ───────────────────────────────────────────────────
      // DICTATION (its own sidebar page, rendered through this section)
      // ───────────────────────────────────────────────────
      case "dictation":
        return (
          <div className="space-y-6">
            <SectionHeader
              title="Speech Recognition"
              description="Choose between cloud-based services for speed or local models for privacy"
            />

            <TranscriptionModelPicker
              selectedCloudProvider={cloudTranscriptionProvider}
              onCloudProviderSelect={(provider) =>
                updateTranscriptionSettings({ cloudTranscriptionProvider: provider })
              }
              selectedCloudModel={cloudTranscriptionModel}
              onCloudModelSelect={(model) =>
                updateTranscriptionSettings({ cloudTranscriptionModel: model })
              }
              selectedLocalModel={whisperModel}
              onLocalModelSelect={(modelId) => {
                updateTranscriptionSettings({ whisperModel: modelId });
              }}
              selectedLocalProvider={localTranscriptionProvider}
              onLocalProviderSelect={(providerId) => {
                updateTranscriptionSettings({ localTranscriptionProvider: providerId });
              }}
              whisperForceCpu={whisperForceCpu}
              onWhisperForceCpuChange={(forceCpu) =>
                updateTranscriptionSettings({ whisperForceCpu: forceCpu })
              }
              gpuSupported={gpuSupportedForPicker}
              recommendedLocalModel={recommendedWhisperModelForPicker}
              preferredLanguage={resolveRatingLanguage(preferredLanguage, spokenLanguages)}
              useLocalWhisper={useLocalWhisper}
              onModeChange={(isLocal) => {
                updateTranscriptionSettings({ useLocalWhisper: isLocal });
              }}
              openaiApiKey={openaiApiKey}
              setOpenaiApiKey={setOpenaiApiKey}
              groqApiKey={groqApiKey}
              setGroqApiKey={setGroqApiKey}
              customTranscriptionApiKey={customTranscriptionApiKey}
              setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
              cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
              setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
              variant="settings"
            />

            {/* Language */}
            <div>
              <SectionHeader
                title="Language"
                description="Configure speech recognition language and translation"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  {/* Stacked rather than a SettingsRow: the picker needs the
                      full width of the panel, and its search list expands
                      downward. Squeezed into the row's narrow right-hand
                      column it read as a stray chip floating beside the
                      description. */}
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-foreground">Languages you speak</p>
                    <SpokenLanguagesSelector
                      value={spokenLanguages}
                      onChange={(next) => {
                        setSpokenLanguages(next);
                        // English output is only valid for an explicit
                        // non-English speech language, and that is exactly
                        // what a single non-English selection produces.
                        const derived = derivePreferredLanguage(next, preferredLanguage);
                        if (derived === "en" || derived === "auto") {
                          setTranslateToEnglish("off");
                        }
                      }}
                    />
                    <p className="text-[13px] leading-relaxed text-muted-foreground">
                      {describeSpokenLanguages(spokenLanguages, preferredLanguage)}
                      {/* A pin can be set from the overlay's quick-switch menu,
                          so Settings has to be able to clear it. Without this
                          the row could describe a pinned state it gave the
                          user no way to leave. */}
                      {spokenLanguages.length > 1 && preferredLanguage !== "auto" && (
                        <button
                          type="button"
                          onClick={() => setPreferredLanguage("auto")}
                          className="ml-1.5 text-primary underline-offset-2 hover:underline"
                        >
                          Switch to automatic
                        </button>
                      )}
                    </p>
                  </div>
                </SettingsPanelRow>

                {/* Its own row so the panel's divider separates the two
                    questions. Sharing one row left the spoken-language status
                    line touching the Output language label, and they read as
                    a single paragraph. */}
                <SettingsPanelRow>
                  <SettingsRow label="Output language" description={outputLanguageHelp}>
                    <div className="flex flex-wrap gap-1.5 justify-end">
                      <button
                        type="button"
                        onClick={() => setTranslateToEnglish("off")}
                        className={[
                          "px-3 py-1.5 rounded-md text-xs font-medium transition-all border",
                          translateToEnglish !== "on"
                            ? "bg-primary text-primary-foreground border-primary shadow-sm"
                            : "bg-surface-raised border-border-subtle text-muted-foreground hover:text-foreground hover:border-border",
                        ].join(" ")}
                      >
                        Same as speech
                      </button>
                      <button
                        type="button"
                        disabled={!canTranslateToEnglish}
                        onClick={() => canTranslateToEnglish && setTranslateToEnglish("on")}
                        className={[
                          "px-3 py-1.5 rounded-md text-xs font-medium transition-all border",
                          !canTranslateToEnglish
                            ? "opacity-40 cursor-not-allowed bg-surface-raised border-border-subtle text-muted-foreground"
                            : translateToEnglish === "on"
                              ? "bg-primary text-primary-foreground border-primary shadow-sm"
                              : "bg-surface-raised border-border-subtle text-muted-foreground hover:text-foreground hover:border-border",
                        ].join(" ")}
                      >
                        English
                      </button>
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Dictation Hotkey */}
            <div>
              <SectionHeader
                title="Dictation Control"
                description="Configure how you activate and control voice dictation"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <HotkeyInput
                    value={dictationKey}
                    onChange={async (newHotkey) => {
                      await registerHotkey(newHotkey);
                    }}
                    disabled={isHotkeyRegistering}
                    ariaLabel="Dictation hotkey"
                    conflicts={[
                      { label: "Read Aloud", hotkey: readAloudHotkey },
                      { label: "Mute my voice call", hotkey: voiceCallMuteKey },
                    ]}
                    onClear={() => {
                      void registerHotkey(getDefaultHotkey());
                    }}
                  />
                </SettingsPanelRow>

                {!isUsingGnomeHotkeys && (
                  <SettingsPanelRow>
                    <p className="text-[11px] font-medium text-muted-foreground/80 mb-2">
                      Activation Mode
                    </p>
                    <ActivationModeSelector value={activationMode} onChange={setActivationMode} />
                  </SettingsPanelRow>
                )}
              </SettingsPanel>
            </div>

            {/* Agent Mode */}
            <div>
              <SectionHeader
                title="Agent Mode"
                description="Hold a second key, describe the bug, release. A cleaned-up prompt lands in Claude Code, Cursor or Codex."
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow label="Agent Mode" description={agentModeStatusDescription()}>
                    <Toggle checked={agentModeEnabled} onChange={setAgentModeEnabled} />
                  </SettingsRow>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <SettingsRow
                    label="Agent Mode hotkey"
                    description="Hold it while you talk. Right Ctrl is free in every editor we checked."
                  >
                    <Select
                      value={agentModeHotkey}
                      onValueChange={setAgentModeHotkey}
                      disabled={!agentModeEnabled}
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AGENT_MODE_HOTKEY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                  {agentModeKeyClashesWithDictation && (
                    <p className="text-[11px] text-warning leading-relaxed mt-2">
                      Same key as dictation. Pick another one.
                    </p>
                  )}
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <SettingsRow
                    label="Rewrite with Claude Code"
                    description={agentModeRewriteDescription()}
                  >
                    <Toggle
                      checked={agentModeRewrite}
                      onChange={setAgentModeRewrite}
                      disabled={!agentModeEnabled || agentModeRewriteBlocked}
                    />
                  </SettingsRow>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <p className="text-[11px] font-medium text-muted-foreground/80 mb-2">
                    What it does to your words
                  </p>
                  <ul className="text-[12px] leading-relaxed text-muted-foreground space-y-1">
                    <li>
                      Turns the ramble into a prompt a coding agent can act on: outcome first,
                      changes of mind resolved, your technical details kept word for word.
                    </li>
                    <li>
                      Formats paths and identifiers as code, like{" "}
                      <code className="font-mono">auth/login.ts</code> and{" "}
                      <code className="font-mono">user_id</code>.
                    </li>
                    <li>
                      Turns a spoken "new line" into a line break and a trailing "send" into Enter.
                    </li>
                  </ul>
                  <p className="text-[12px] leading-relaxed text-muted-foreground mt-2">
                    {agentModeRewriteLive
                      ? "The rewrite goes through your Claude Code login. Everything else runs on this PC."
                      : "Everything runs on this PC. No text leaves it."}
                  </p>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <SettingsRow
                    label="Prompts today"
                    description={
                      isAgentModePro ? (
                        "Unlimited on this license."
                      ) : (
                        <>
                          Starter includes {agentModeUsage.limit} a day. Resets at midnight.{" "}
                          <button
                            type="button"
                            onClick={() =>
                              void window.electronAPI?.openControlPanel?.({
                                page: "settings",
                                settingsTab: "pro",
                              })
                            }
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            Unlimited with Pro
                          </button>
                        </>
                      )
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-[13px] tabular-nums text-muted-foreground font-mono">
                        {isAgentModePro
                          ? "Unlimited"
                          : `${agentModeUsage.usesToday} of ${agentModeUsage.limit}`}
                      </span>
                      {isAgentModePro && <Badge variant="pro">Pro</Badge>}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {useLocalWhisper && localTranscriptionProvider === "whisper" && (
              <div className="mt-6">
                <SectionHeader
                  title="Local Whisper performance"
                  description="How much of your processor local Whisper may use, and when it switches itself off"
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="CPU threads"
                      description={
                        cpuThreadInfo
                          ? `Auto uses ${cpuThreadInfo.autoThreads} of your ${cpuThreadInfo.logicalCores} threads and leaves the rest so your PC stays responsive while it transcribes. Raise it for more speed. Leave empty for auto.`
                          : "How much of the processor local Whisper may use. Auto leaves some free so your PC stays responsive while it transcribes. Leave empty for auto."
                      }
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={cpuThreadInfo?.logicalCores ?? 128}
                          step={1}
                          placeholder={
                            cpuThreadInfo ? `auto (${cpuThreadInfo.autoThreads})` : "auto"
                          }
                          value={whisperThreadsDraft}
                          onChange={(e) => {
                            setWhisperThreadsDraft(e.target.value);
                          }}
                          onBlur={() => {
                            const raw = parseInt(whisperThreadsDraft, 10);
                            const max = cpuThreadInfo?.logicalCores ?? 128;
                            // An empty or unusable field means "go back to auto"
                            // rather than "keep whatever was there before".
                            const next = Number.isFinite(raw) ? Math.max(1, Math.min(max, raw)) : 0;

                            setWhisperThreadsDraft(next > 0 ? String(next) : "");
                            updateTranscriptionSettings({ whisperThreads: next });
                          }}
                          className="w-28 text-right"
                          aria-label="Whisper CPU thread count"
                        />
                        <span className="text-xs text-muted-foreground">threads</span>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Idle shutdown (minutes)"
                      description="Switches the local speech engine off after this many quiet minutes to free memory. 0 keeps it running."
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          max={240}
                          step={1}
                          value={whisperIdleDraft}
                          onChange={(e) => {
                            setWhisperIdleDraft(e.target.value);
                          }}
                          onBlur={() => {
                            const raw = parseInt(whisperIdleDraft, 10);
                            const next = Number.isFinite(raw)
                              ? Math.max(0, Math.min(240, raw))
                              : whisperServerIdleTimeoutMinutes;

                            setWhisperIdleDraft(String(next));
                            updateTranscriptionSettings({ whisperServerIdleTimeoutMinutes: next });

                            // Best-effort: apply immediately if the server is already running.
                            window.electronAPI
                              ?.whisperServerSetIdleTimeoutMinutes(next)
                              ?.catch(() => {});
                          }}
                          className="w-24 text-right"
                          aria-label="Whisper server idle shutdown minutes"
                        />
                        <span className="text-xs text-muted-foreground">min</span>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* GPU Status - always visible in Transcription tab for local users */}
            {useLocalWhisper && (
              <div className="mt-6">
                <SectionHeader
                  title="Performance"
                  description="What this PC runs on, and how fast it transcribes"
                />
                <GpuStatusCard
                  activeProvider={localTranscriptionProvider}
                  activeWhisperForceCpu={whisperForceCpu}
                />
              </div>
            )}
          </div>
        );

      // ───────────────────────────────────────────────────
      // PERMISSIONS
      // ───────────────────────────────────────────────────
      case "permissions":
        return (
          <div className="space-y-6">
            <SectionHeader
              title={platform === "darwin" ? "Microphone & Accessibility" : "Microphone"}
              description={
                platform === "darwin"
                  ? "Allow access, pick the device, and check that it hears you"
                  : "Allow access, pick the device you dictate with, and check that it hears you"
              }
            />

            {/* Permission Cards - matching onboarding style */}
            <div className="space-y-3">
              <PermissionCard
                icon={Mic}
                title="Microphone"
                description="Required for voice recording and dictation"
                granted={permissionsHook.micPermissionGranted}
                onRequest={permissionsHook.requestMicPermission}
                buttonText="Test"
                onOpenSettings={permissionsHook.openMicPrivacySettings}
              />

              {platform === "darwin" && (
                <PermissionCard
                  icon={Shield}
                  title="Accessibility"
                  description="Required for auto-paste to work after transcription"
                  granted={permissionsHook.accessibilityPermissionGranted}
                  onRequest={permissionsHook.testAccessibilityPermission}
                  buttonText="Test & Grant"
                  onOpenSettings={permissionsHook.openAccessibilitySettings}
                />
              )}
            </div>

            {/* Error state for microphone */}
            {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
              <MicPermissionWarning
                error={permissionsHook.micPermissionError}
                onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
              />
            )}

            {/* Audio input - the other half of "can it hear me", so it lives
                beside the permission rather than buried in General. */}
            <div>
              <SettingsPanel>
                <SettingsPanelRow>
                  <MicrophoneSettings
                    preferBuiltInMic={preferBuiltInMic}
                    selectedMicDeviceId={selectedMicDeviceId}
                    onPreferBuiltInChange={setPreferBuiltInMic}
                    onDeviceSelect={setSelectedMicDeviceId}
                  />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Linux paste tools info */}
            {platform === "linux" &&
              permissionsHook.pasteToolsInfo &&
              !permissionsHook.pasteToolsInfo.available && (
                <PasteToolsInfo
                  pasteToolsInfo={permissionsHook.pasteToolsInfo}
                  isChecking={permissionsHook.isCheckingPasteTools}
                  onCheck={permissionsHook.checkPasteToolsAvailability}
                />
              )}

            {/* Troubleshooting section for macOS */}
            {platform === "darwin" && (
              <div>
                <p className="text-[13px] font-medium text-foreground mb-3">Troubleshooting</p>
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Reset accessibility permissions"
                      description="Fix issues after reinstalling or rebuilding the app by removing and re-adding PrivateTranscribe in System Settings"
                    >
                      <Button
                        onClick={resetAccessibilityPermissions}
                        variant="ghost"
                        size="sm"
                        className="text-foreground/70 hover:text-foreground"
                      >
                        Troubleshoot
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}
          </div>
        );

      // ───────────────────────────────────────────────────
      // PRO
      // ───────────────────────────────────────────────────
      case "pro":
        return (
          <div className="space-y-8">
            <SectionHeader
              title="PrivateTranscribe Pro"
              description="Unlock advanced features with a one-time license"
            />
            <ProSettingsSection onNavigate={onNavigate} />
          </div>
        );

      // ───────────────────────────────────────────────────
      // DEVELOPER (+ data management moved here)
      // ───────────────────────────────────────────────────
      case "developer": {
        const showDeveloperDiagnostics = updateStatus.isDevelopment;

        return (
          <div className="space-y-8">
            <SectionHeader
              title={showDeveloperDiagnostics ? "Diagnostics & Data" : "Data & Storage"}
              description={
                showDeveloperDiagnostics
                  ? "Support tools, logging, settings backup, and local data management"
                  : "Manage settings, statistics, model cache, and application data"
              }
            />

            {showDeveloperDiagnostics && <DeveloperSection />}

            {/* Data Management - moved from General */}
            <div className={showDeveloperDiagnostics ? "border-t border-border/30 pt-8" : ""}>
              {showDeveloperDiagnostics && (
                <SectionHeader
                  title="Data & Storage"
                  description="Manage settings, statistics, model cache, and application data"
                />
              )}

              <div className="space-y-4">
                {/* Settings export/import */}
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Settings backup"
                      description="Export your preferences to a file or restore from a backup. API keys are excluded by default."
                    >
                      <div className="flex flex-col items-end gap-3">
                        <div className="flex flex-col gap-1.5">
                          <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
                            <Checkbox
                              checked={includeApiKeysInExport}
                              onChange={(e) => setIncludeApiKeysInExport(e.target.checked)}
                            />
                            Include API keys in export
                          </label>
                          <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
                            <Checkbox
                              checked={allowApiKeysOnImport}
                              onChange={(e) => setAllowApiKeysOnImport(e.target.checked)}
                            />
                            Allow importing API keys
                          </label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadSettings(includeApiKeysInExport)}
                          >
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                            Export
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => importFileInputRef.current?.click()}
                          >
                            <Upload className="mr-1.5 h-3.5 w-3.5" />
                            Import
                          </Button>
                        </div>
                        <input
                          ref={importFileInputRef}
                          type="file"
                          accept="application/json"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            try {
                              showConfirmDialog({
                                title: "Import Settings",
                                description: "This will overwrite your current settings. Proceed?",
                                confirmText: "Import",
                                onConfirm: async () => {
                                  try {
                                    const skippedFields = await handleImportSettingsFile(file);
                                    showAlertDialog({
                                      title:
                                        skippedFields.length > 0
                                          ? "Settings Imported With Skips"
                                          : "Settings Imported",
                                      description:
                                        skippedFields.length > 0
                                          ? `Imported valid settings. Skipped ${skippedFields.length} invalid field(s): ${skippedFields.join("; ")}.`
                                          : "Your settings were imported successfully.",
                                    });
                                  } catch (err: any) {
                                    showAlertDialog({
                                      title: "Import Failed",
                                      description: err?.message || "Could not import settings.",
                                    });
                                  } finally {
                                    if (importFileInputRef.current)
                                      importFileInputRef.current.value = "";
                                  }
                                },
                              });
                            } catch (err: any) {
                              showAlertDialog({
                                title: "Import Failed",
                                description: err?.message || "Could not import settings.",
                              });
                              if (importFileInputRef.current) importFileInputRef.current.value = "";
                            }
                          }}
                        />
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Reset statistics"
                      description="Clear all aggregate stats - words dictated, session count, time, and WPM. Transcript history and settings are not affected."
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                        onClick={() => {
                          showConfirmDialog({
                            title: "Reset Statistics",
                            description:
                              "This will permanently clear your dictation statistics (words, sessions, time, WPM). Your transcript history and settings will not be affected.\n\nThis action cannot be undone.",
                            confirmText: "Reset Statistics",
                            variant: "destructive",
                            onConfirm: async () => {
                              try {
                                await window.electronAPI?.resetStats?.();
                                showAlertDialog({
                                  title: "Statistics Reset",
                                  description:
                                    "Your dictation statistics and streak baseline have been cleared. Transcript history is preserved.",
                                });
                              } catch (err: any) {
                                showAlertDialog({
                                  title: "Reset Failed",
                                  description: err?.message || "Could not reset statistics.",
                                });
                              }
                            },
                          });
                        }}
                      >
                        Reset
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow label="Model cache" description={cachePathHint}>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.electronAPI?.openWhisperModelsFolder?.()}
                        >
                          <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                          Open
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveModels}
                          disabled={isRemovingModels}
                        >
                          {isRemovingModels ? "Removing..." : "Clear Cache"}
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Reset app data"
                      description="Permanently delete all settings, transcriptions, and cached data"
                    >
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: "Reset All App Data",
                            description:
                              "This will permanently delete ALL PrivateTranscribe data including:\n\n- Database and transcriptions\n- Local storage settings\n- Downloaded models\n- Environment files\n\nYou will need to manually remove app permissions in System Settings.\n\nThis action cannot be undone.",
                            onConfirm: () => {
                              window.electronAPI
                                ?.cleanupApp()
                                .then(() => {
                                  showAlertDialog({
                                    title: "Reset Complete",
                                    description:
                                      "All app data has been removed. The app will restart.",
                                  });
                                  setTimeout(() => {
                                    // App handles relaunch automatically
                                  }, 1000);
                                })
                                .catch((error) => {
                                  showAlertDialog({
                                    title: "Reset Failed",
                                    description: `Failed to reset: ${error.message}`,
                                  });
                                });
                            },
                            variant: "destructive",
                            confirmText: "Delete Everything",
                          });
                        }}
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        Reset
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Uninstall PrivateTranscribe"
                      description={
                        platform === "win32"
                          ? "Remove PrivateTranscribe via Windows Settings → Apps & features. The uninstaller will ask whether to also remove settings, transcriptions, logs, and downloaded models."
                          : platform === "darwin"
                            ? "Quit PrivateTranscribe, then drag it from your Applications folder to the Trash. To also remove downloaded models and app data, use Reset app data first."
                            : "Use your system package manager (apt, dnf, pacman) or software center to remove PrivateTranscribe. To also remove downloaded models and app data, use Reset app data first."
                      }
                    >
                      {(platform === "win32" || platform === "darwin") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-foreground/70 hover:text-foreground"
                          onClick={async () => {
                            const result = await window.electronAPI?.openUninstallLocation?.();
                            if (!result?.success) {
                              showAlertDialog({
                                title: "Could not open uninstall location",
                                description:
                                  result?.error ||
                                  "Please open your system uninstall location manually.",
                              });
                            }
                          }}
                        >
                          {platform === "win32" ? "Open Apps & Features" : "Open Applications"}
                        </Button>
                      )}
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {apiKeySyncError && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{apiKeySyncError}</span>
          <button
            onClick={clearApiKeySyncError}
            className="ml-2 shrink-0 text-destructive/60 hover:text-destructive transition-colors"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {renderSectionContent()}
    </>
  );
}
