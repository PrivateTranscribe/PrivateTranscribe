import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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
  Lock,
  MessageSquare,
  Sparkles,
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
import { isFeatureUnlocked } from "../hooks/useProStatus";
import { useAgentName } from "../utils/agentName";
import ProSettingsSection from "./ProSettingsSection";
import { useWhisper } from "../hooks/useWhisper";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useUpdater } from "../hooks/useUpdater";

import PromptStudio from "./ui/PromptStudio";
import ReasoningModelSelector from "./ReasoningModelSelector";

import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import { Toggle } from "./ui/toggle";
import DeveloperSection from "./DeveloperSection";
import { SettingsRow } from "./ui/SettingsSection";
import { LANGUAGE_OPTIONS } from "../utils/languages";

export type SettingsSectionType =
  | "general"
  | "preferences"
  | "transcription"
  | "dictionary"
  | "aiModels"
  | "agentConfig"
  | "prompts"
  | "permissions"
  | "help"
  | "developer"
  | "pro";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
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

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-5">
      <h3 className="text-lg font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground/80 mt-1.5 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

// ── GPU Status card - shown in Transcription settings ──────────────────

type GpuDetectState = "idle" | "detecting" | "done" | "error";

const GPU_CATEGORY_LABELS: Record<HardwareGpuCategory, string> = {
  nvidia_cuda: "NVIDIA + CUDA ready",
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

function GpuStatusCard({
  activeProvider,
  activeWhisperForceCpu,
}: {
  /** localTranscriptionProvider from parent — avoids stale useSettings() copy */
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
  const [cudaStatus, setCudaStatus] = useState<{
    installed: boolean;
    path: string | null;
    platform: string;
    supported: boolean;
    forceCpu: boolean;
    cudaAutoUpdateFailed?: boolean;
    version?: string | null;
    upToDate?: boolean;
    expectedVersion?: string;
  } | null>(null);
  const [downloadState, setDownloadState] = useState<"idle" | "downloading" | "done" | "error">(
    "idle"
  );
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

  // Fetch CUDA binary status on mount
  useEffect(() => {
    window.electronAPI
      ?.getCudaBinaryStatus?.()
      .then(setCudaStatus)
      .catch(() => {});
  }, []);

  // Refresh CUDA status while Settings is open so async auto-update failures surface.
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await window.electronAPI?.getCudaBinaryStatus?.();
        if (status) setCudaStatus(status);
      } catch {
        /* keep the last known status */
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Listen for CUDA download progress events
  useEffect(() => {
    const cleanup = window.electronAPI?.onCudaBinaryDownloadProgress?.((_event, data) => {
      setDownloadProgress(Math.round(data?.percent ?? 0));
    });
    return () => cleanup?.();
  }, []);

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

  // Auto-detect hardware on mount — uses cached result if available, fast on revisit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { runDetect(false); }, []);

  const runBenchmark = async () => {
    setBenchState("running");
    setBenchError(null);
    try {
      // Use props (not settings) — GpuStatusCard's own useSettings() copy can be stale
      // if localTranscriptionProvider was changed by the model picker above.
      const provider = activeProvider === "nvidia" ? "nvidia" : "whisper";
      const model = provider === "nvidia" ? "parakeet-tdt-0.6b-v3" : settings.whisperModel || "turbo";

      const res = await window.electronAPI?.benchmarkRun?.({ provider, model });
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
  // CUDA is supported on this platform
  const gpuSupported = cudaStatus != null ? cudaStatus.supported : false;
  const cudaAutoUpdateFailed =
    !!cudaStatus?.cudaAutoUpdateFailed && (cudaStatus?.upToDate ?? true) === false;
  const needsInitialCudaInstall = (cudaStatus?.installed ?? false) === false;
  const shouldShowCudaDownloadState =
    downloadState === "downloading" || downloadState === "done" || downloadState === "error";
  const shouldShowCudaSetupCard =
    usingGpu &&
    gpuSupported &&
    (shouldShowCudaDownloadState || needsInitialCudaInstall || cudaAutoUpdateFailed);

  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 backdrop-blur-sm shadow-sm overflow-hidden">
      <div className="p-4 flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <MonitorSmartphone className="w-4 h-4 text-primary" />
        </div>
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
                        <span>Downloading CUDA engine… {downloadProgress}%</span>
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
                  <div className="flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>CUDA engine installed — GPU acceleration active.</span>
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
                ) : cudaAutoUpdateFailed ? (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                    <p className="text-[11px] text-amber-200 leading-relaxed">
                      GPU engine update failed. Click to retry.
                    </p>
                    <Button
                      onClick={handleDownloadCuda}
                      variant="default"
                      size="sm"
                      className="h-7 gap-1.5 text-[11px]"
                    >
                      <Download className="w-3 h-3" />
                      Retry
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border-subtle/50 bg-surface-raised/30 p-3 space-y-2">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      GPU · Whisper requires the CUDA engine (~650 MB). Download it once to enable
                      GPU-accelerated transcription.
                    </p>
                    <Button
                      onClick={handleDownloadCuda}
                      variant="default"
                      size="sm"
                      className="h-7 gap-1.5 text-[11px]"
                    >
                      <Download className="w-3 h-3" />
                      Download CUDA Engine
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* ═══ HARDWARE ════════════════════════════════════════ */}
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-2">
                Hardware
              </p>
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
                        ? ` · ${detection.gpu.vram >= 1024 ? `${(detection.gpu.vram / 1024).toFixed(1)} GB` : `${detection.gpu.vram} MB`} VRAM`
                        : ""}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No discrete GPU detected — CPU transcription only
                    </p>
                  )}
                  {isNvidiaNoCuda && rec?.recoverySteps && rec.recoverySteps.length > 0 && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-1.5">
                      <p className="text-[11px] font-medium text-foreground">
                        To enable GPU acceleration:
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
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-2">
                Benchmarks
              </p>

              {compState === "done" && compResult && (
                <div className="mb-3 rounded-lg border border-border-subtle/50 bg-surface-raised/30 p-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 rounded-md border border-border-subtle/40 bg-surface-raised/20 p-2 text-center">
                      <p className="text-[10px] font-medium text-muted-foreground mb-0.5">
                        Whisper
                        {compResult.cpuResult.gpuCategory === "nvidia_cuda"
                          ? " (CUDA)"
                          : " (CPU)"}
                      </p>
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        {formatRealtimeFactor(compResult.cpuResult.realtimeFactor)}
                      </p>
                      <p className="text-[9px] text-muted-foreground">
                        {compResult.cpuResult.model}
                      </p>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 rounded-md border border-primary/30 bg-primary/5 p-2 text-center">
                      <p className="text-[10px] font-medium text-primary mb-0.5">Parakeet</p>
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        {formatRealtimeFactor(compResult.gpuResult.realtimeFactor)}
                      </p>
                      <p className="text-[9px] text-muted-foreground">
                        {compResult.gpuResult.model}
                      </p>
                    </div>
                  </div>
                  {compResult.speedup >= 1.05 && (
                    <p className="mt-2 text-center text-xs font-semibold text-primary tabular-nums">
                      {compResult.speedup >= 10
                        ? `${compResult.speedup.toFixed(1)}x`
                        : `${compResult.speedup.toFixed(2)}x`}{" "}
                      faster with Parakeet
                    </p>
                  )}
                  {compResult.speedup > 0 && compResult.speedup < 1.05 && (
                    <p className="mt-2 text-center text-[11px] text-muted-foreground">
                      About the same speed on this device
                    </p>
                  )}
                  <p className="text-[9px] text-muted-foreground mt-2 text-center">
                    Higher = faster. 59x means 60s of audio transcribes in ~1s.
                  </p>
                  <p className="text-[9px] text-muted-foreground mt-0.5 text-center">
                    Whisper vs Parakeet (ONNX) — different engines
                    {compResult.createdAt ? ` · ${formatBenchmarkDate(compResult.createdAt)}` : ""}
                  </p>
                </div>
              )}

              {benchState === "done" && benchResult && compState !== "done" && (
                <div className="mb-3 rounded-lg border border-border-subtle/50 bg-surface-raised/30 p-3">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold text-foreground tabular-nums">
                      {formatRealtimeFactor(benchResult.realtimeFactor)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">real-time</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {benchResult.provider === "nvidia" ? "Parakeet" : "Whisper"} (
                    {benchResult.model}) ·{" "}
                    {(benchResult.elapsedMs / 1000).toFixed(1)}s for{" "}
                    {benchResult.audioDurationSec}s audio
                    {benchResult.createdAt
                      ? ` · ${formatBenchmarkDate(benchResult.createdAt)}`
                      : ""}
                  </p>
                  <p className="text-[9px] text-muted-foreground mt-1">
                    Higher = faster. 59x means 60s of audio transcribes in ~1s.
                  </p>
                  {/* Warn if CUDA binary is present but speed is suspiciously low (likely not using GPU) */}
                  {gpuCategory === "nvidia_cuda" && !activeWhisperForceCpu && benchResult.realtimeFactor < 2 && (
                    <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/8 px-2.5 py-2">
                      <AlertCircle className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                      <p className="text-[10px] text-amber-500 leading-relaxed">
                        GPU acceleration may not be working. Your NVIDIA GPU might not be compatible with the current CUDA binary (RTX 50-series requires a newer build). A Blackwell-compatible update is in progress.
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
                      ? "Running Whisper vs Parakeet comparison — testing both engines on a 10-second sample…"
                      : "Running speed test — transcribing a 10-second sample…"}
                  </div>
                </div>
              )}

              {benchState === "error" && (
                <div className="mb-3 flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="w-3 h-3" />
                  Speed test failed: {benchError}
                </div>
              )}
              {compState === "error" && (
                <div className="mb-3 flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="w-3 h-3" />
                  Comparison failed: {compError}
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  onClick={runBenchmark}
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[11px]"
                  disabled={benchState === "running" || compState === "running"}
                  title={`Benchmarks the active engine: ${activeProvider === "nvidia" ? "Parakeet" : activeWhisperForceCpu ? "Whisper (CPU)" : "Whisper (GPU)"}`}
                >
                  <Timer className="w-3 h-3" />
                  {benchResult ? "Re-run Speed Test" : "Run Speed Test"}
                </Button>
                {gpuCategory === "nvidia_cuda" && !activeWhisperForceCpu && (
                  <Button
                    onClick={runComparison}
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-[11px]"
                    disabled={benchState === "running" || compState === "running"}
                  >
                    <Zap className="w-3 h-3" />
                    {compResult ? "Re-run Whisper vs Parakeet" : "Compare Whisper vs Parakeet"}
                  </Button>
                )}
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
        <input
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
          className="flex h-9 w-24 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground text-right shadow-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          aria-label="History limit"
        />
        <span className="text-xs text-muted-foreground">items</span>
      </div>

      {pending !== null && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs space-y-2">
          <p className="text-amber-700 dark:text-amber-400 font-medium">
            ⚠️ This will permanently delete history older than{" "}
            {pending === 0
              ? "all entries"
              : `the newest ${pending} item${pending === 1 ? "" : "s"}`}
            . Records deleted this way cannot be recovered.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={isConfirming}
              className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {isConfirming ? "Deleting…" : "Confirm & delete"}
            </button>
            <button
              onClick={handleCancel}
              className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
          {trimError && <p className="text-red-600 dark:text-red-400">{trimError}</p>}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────

export default function SettingsPage({ activeSection = "general" }: SettingsPageProps) {
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
    audioFeedback,
    setAudioFeedback,
    errorNotifications,
    setErrorNotifications,
    successConfirmation,
    setSuccessConfirmation,
    apiKeySyncError,
    clearApiKeySyncError,
  } = useSettings();

  const correctionMemoryUnlocked = isFeatureUnlocked("correction-memory");
  const smartContextUnlocked = isFeatureUnlocked("smart-context");
  const aiEnhancementUnlocked = isFeatureUnlocked("ai-enhancement");
  const voiceAssistantUnlocked = isFeatureUnlocked("voice-assistant");

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isRemovingModels, setIsRemovingModels] = useState(false);

  // GPU support status — fetched once to drive the engine selector in TranscriptionModelPicker
  const [gpuSupportedForPicker, setGpuSupportedForPicker] = useState(false);
  useEffect(() => {
    window.electronAPI
      ?.getCudaBinaryStatus?.()
      .then((s) => setGpuSupportedForPicker(s?.supported ?? false))
      .catch(() => {});
  }, []);

  const [correctionCount, setCorrectionCount] = useState<number | null>(null);
  const [clearConfirmPending, setClearConfirmPending] = useState(false);
  const [isClearingCorrections, setIsClearingCorrections] = useState(false);

  useEffect(() => {
    if (!enableCorrectionLearning) return;
    window.electronAPI
      ?.getCorrectionMemory?.(1000)
      .then((rows) => setCorrectionCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => setCorrectionCount(0));
  }, [enableCorrectionLearning]);

  const handleClearCorrections = useCallback(async () => {
    if (!clearConfirmPending) {
      setClearConfirmPending(true);
      return;
    }
    setIsClearingCorrections(true);
    try {
      const rows = (await window.electronAPI?.getCorrectionMemory?.(10000)) ?? [];
      for (const row of rows) {
        await window.electronAPI?.deleteCorrection?.(row.source);
      }
      setCorrectionCount(0);
    } finally {
      setIsClearingCorrections(false);
      setClearConfirmPending(false);
    }
  }, [clearConfirmPending]);

  // Whisper-server idle shutdown setting (minutes) has a draft state to avoid snapping
  // while typing (e.g. clearing the field).
  const [whisperIdleDraft, setWhisperIdleDraft] = useState<string>(
    String(whisperServerIdleTimeoutMinutes)
  );
  useEffect(() => {
    setWhisperIdleDraft(String(whisperServerIdleTimeoutMinutes));
  }, [whisperServerIdleTimeoutMinutes]);

  const [llamaIdleDraft, setLlamaIdleDraft] = useState<string>(
    String(llamaServerIdleTimeoutMinutes)
  );
  useEffect(() => {
    setLlamaIdleDraft(String(llamaServerIdleTimeoutMinutes));
  }, [llamaServerIdleTimeoutMinutes]);

  const cachePathHint =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "%USERPROFILE%\\.cache\\PrivateTranscribe\\whisper-models"
      : "~/.cache/PrivateTranscribe/whisper-models";

  // Settings export/import (privacy-first): API keys are excluded by default.
  const [includeApiKeysInExport, setIncludeApiKeysInExport] = useState(false);
  const [allowApiKeysOnImport, setAllowApiKeysOnImport] = useState(false);
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
          whisperServerIdleTimeoutMinutes,
          preferredLanguage,
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
          // Devices
          preferBuiltInMic,
          selectedMicDeviceId,
          // Dictionary
          customDictionary,
        },
      };

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
      preferredLanguage,
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

      if (s.theme === "light" || s.theme === "dark" || s.theme === "auto") setTheme(s.theme);
      if (typeof s.historyLimit === "number") setHistoryLimit(s.historyLimit);
      if (typeof s.dictationKey === "string") setDictationKey(s.dictationKey);
      if (s.activationMode === "tap" || s.activationMode === "push")
        setActivationMode(s.activationMode);

      updateTranscriptionSettings({
        useLocalWhisper: typeof s.useLocalWhisper === "boolean" ? s.useLocalWhisper : undefined,
        localTranscriptionProvider:
          s.localTranscriptionProvider === "nvidia" || s.localTranscriptionProvider === "whisper"
            ? "whisper"
            : undefined,
        whisperModel: typeof s.whisperModel === "string" ? s.whisperModel : undefined,
        whisperServerIdleTimeoutMinutes:
          typeof s.whisperServerIdleTimeoutMinutes === "number"
            ? s.whisperServerIdleTimeoutMinutes
            : undefined,
        preferredLanguage:
          typeof s.preferredLanguage === "string" ? s.preferredLanguage : undefined,
        translateToEnglish:
          s.translateToEnglish === "on" || s.translateToEnglish === "off"
            ? s.translateToEnglish
            : undefined,
        cloudTranscriptionProvider:
          typeof s.cloudTranscriptionProvider === "string"
            ? s.cloudTranscriptionProvider
            : undefined,
        cloudTranscriptionModel:
          typeof s.cloudTranscriptionModel === "string" ? s.cloudTranscriptionModel : undefined,
        cloudTranscriptionBaseUrl:
          typeof s.cloudTranscriptionBaseUrl === "string" ? s.cloudTranscriptionBaseUrl : undefined,
        customDictionary: Array.isArray(s.customDictionary) ? s.customDictionary : undefined,
      });

      updateReasoningSettings({
        useReasoningModel:
          typeof s.useReasoningModel === "boolean" ? s.useReasoningModel : undefined,
        reasoningProvider:
          typeof s.reasoningProvider === "string" ? s.reasoningProvider : undefined,
        reasoningModel: typeof s.reasoningModel === "string" ? s.reasoningModel : undefined,
        cloudReasoningBaseUrl:
          typeof s.cloudReasoningBaseUrl === "string" ? s.cloudReasoningBaseUrl : undefined,
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

      if (typeof s.preferBuiltInMic === "boolean") setPreferBuiltInMic(s.preferBuiltInMic);
      if (typeof s.selectedMicDeviceId === "string") setSelectedMicDeviceId(s.selectedMicDeviceId);

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
      setPauseMediaOnRecord,
      setPreferBuiltInMic,
      setSelectedMicDeviceId,
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

  const whisperHook = useWhisper();
  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog);
  const { agentName, setAgentName } = useAgentName();
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

  // Auto-disable translation when switching to a model that doesn't support it
  useEffect(() => {
    if (!translationSupported && translateToEnglish === "on") {
      setTranslateToEnglish("off");
    }
  }, [translationSupported, translateToEnglish, setTranslateToEnglish]);

  const [newDictionaryWord, setNewDictionaryWord] = useState("");

  const handleAddDictionaryWord = useCallback(() => {
    const word = newDictionaryWord.trim();
    if (word && !customDictionary.includes(word)) {
      setCustomDictionary([...customDictionary, word]);
      setNewDictionaryWord("");
    }
  }, [newDictionaryWord, customDictionary, setCustomDictionary]);

  const handleRemoveDictionaryWord = useCallback(
    (wordToRemove: string) => {
      setCustomDictionary(customDictionary.filter((word) => word !== wordToRemove));
    },
    [customDictionary, setCustomDictionary]
  );

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

  useEffect(() => {
    if (platform === "linux") {
      setAutoStartLoading(false);
      return;
    }
    const loadAutoStart = async () => {
      if (window.electronAPI?.getAutoStartEnabled) {
        try {
          const enabled = await window.electronAPI.getAutoStartEnabled();
          setAutoStartEnabled(enabled);
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
        const result = await window.electronAPI.setAutoStartEnabled(enabled);
        if (result.success) {
          setAutoStartEnabled(enabled);
        }
      } catch (error) {
        console.error("Failed to set auto-start:", error);
      } finally {
        setAutoStartLoading(false);
      }
    }
  };

  useEffect(() => {
    let mounted = true;

    const timer = setTimeout(async () => {
      if (!mounted) return;

      const version = await getAppVersion();
      if (version && mounted) setCurrentVersion(version);

      if (mounted) {
        whisperHook.checkWhisperInstallation();
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [whisperHook, getAppVersion]);

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
      // GENERAL - Updates, Hotkey, Startup, Mic
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
                    <Button
                      onClick={async () => {
                        try {
                          const result = await checkForUpdates();
                          if (result?.updateAvailable) {
                            showAlertDialog({
                              title: "Update Available",
                              description: `Update available: v${result.version || "new version"}`,
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
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        What's new in v{updateInfo.version}
                      </p>
                      <div className="text-[12px] text-muted-foreground">
                        <MarkdownRenderer content={updateInfo.releaseNotes} />
                      </div>
                    </div>
                  )}
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

            {/* Startup */}
            {platform !== "linux" && (
              <div>
                <SectionHeader title="Startup" />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Start on boot"
                      description="PrivateTranscribe starts automatically when your computer turns on"
                    >
                      <Toggle
                        checked={autoStartEnabled}
                        onChange={(checked: boolean) => handleAutoStartChange(checked)}
                        disabled={autoStartLoading}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Microphone */}
            <div>
              <SectionHeader
                title="Audio Input"
                description="Choose your preferred microphone and configure audio settings"
              />
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
          </div>
        );

      // ───────────────────────────────────────────────────
      // PREFERENCES - New section with additional options
      // ───────────────────────────────────────────────────
      case "preferences":
        return (
          <div className="space-y-8">
            {/* Language */}
            <div>
              <SectionHeader
                title="Language"
                description="Configure speech recognition language and translation"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="I speak"
                    description="The language you speak. Whisper transcribes in this language - set it to match what you actually speak for best accuracy."
                  >
                    <Select
                      value={preferredLanguage || "auto"}
                      onValueChange={(val) => {
                        setPreferredLanguage(val);
                        // Auto-disable translation if switching to English or auto
                        if (val === "en" || val === "auto") {
                          setTranslateToEnglish("off");
                        }
                      }}
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANGUAGE_OPTIONS.map((lang) => (
                          <SelectItem key={lang.value} value={lang.value}>
                            {lang.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsRow>

                  {/* Show translate toggle only when speaking a non-English language */}
                  {preferredLanguage &&
                    preferredLanguage !== "auto" &&
                    preferredLanguage !== "en" && (
                      <>
                        <SettingsRow
                          label="Translate to English"
                          description={
                            translationSupported
                              ? "Automatically translate your speech into English text"
                              : "Not available with the current model"
                          }
                        >
                          <button
                            type="button"
                            disabled={!translationSupported}
                            onClick={() =>
                              translationSupported &&
                              setTranslateToEnglish(translateToEnglish === "on" ? "off" : "on")
                            }
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                              !translationSupported
                                ? "opacity-40 cursor-not-allowed bg-surface-raised border border-border-subtle"
                                : translateToEnglish === "on"
                                  ? "bg-primary"
                                  : "bg-surface-raised border border-border-subtle"
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                translateToEnglish === "on" && translationSupported
                                  ? "translate-x-6"
                                  : "translate-x-1"
                              }`}
                            />
                          </button>
                        </SettingsRow>
                        {!translationSupported && (
                          <p className="mt-1.5 text-xs text-muted-foreground">
                            Your current model doesn't support translation. Switch to{" "}
                            <strong className="text-foreground">Large</strong> or{" "}
                            <strong className="text-foreground">Medium</strong> from the model
                            picker on the home screen to enable this.
                          </p>
                        )}
                      </>
                    )}
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Correction Memory */}
            <div className="border-t border-border/30 pt-8">
              <SectionHeader
                title="Correction Memory"
                description="Snap dictation to your preferred spellings and learn from edits"
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Variable snapping"
                    description="Snap spoken phrases to exact identifiers from your dictionary + learned corrections"
                  >
                    <Toggle
                      checked={enableVariableSnapping}
                      onChange={(checked: boolean) => setEnableVariableSnapping(checked)}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Correction learning"
                    description={
                      correctionMemoryUnlocked
                        ? "Learn from manual edits (currently detected via clipboard changes after dictation)"
                        : "Pro feature - unlock in Settings → Pro to enable correction learning"
                    }
                  >
                    <Toggle
                      checked={enableCorrectionLearning}
                      onChange={(checked: boolean) => setEnableCorrectionLearning(checked)}
                      disabled={!correctionMemoryUnlocked}
                    />
                  </SettingsRow>
                  {enableCorrectionLearning && correctionMemoryUnlocked && (
                    <div className="mt-2 flex items-center justify-between">
                      <p
                        className={
                          correctionCount !== null && correctionCount > 0
                            ? "text-xs text-green-600 dark:text-green-400"
                            : "text-xs text-muted-foreground"
                        }
                      >
                        {correctionCount === null
                          ? ""
                          : correctionCount > 0
                            ? `✓ Learning — ${correctionCount} correction${correctionCount === 1 ? "" : "s"} stored`
                            : "Listening for corrections..."}
                      </p>
                      {correctionCount !== null && correctionCount > 0 && (
                        <div className="flex items-center gap-2">
                          {clearConfirmPending && (
                            <span className="text-xs text-muted-foreground">Are you sure?</span>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleClearCorrections}
                            disabled={isClearingCorrections}
                            className={
                              clearConfirmPending
                                ? "border-destructive text-destructive hover:bg-destructive/10"
                                : ""
                            }
                          >
                            {isClearingCorrections
                              ? "Clearing..."
                              : clearConfirmPending
                                ? "Yes, clear all"
                                : "Clear all corrections"}
                          </Button>
                          {clearConfirmPending && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setClearConfirmPending(false)}
                            >
                              Cancel
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

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
                        <input
                          type="range"
                          min={5}
                          max={80}
                          step={5}
                          value={Math.round(musicDuckLevel * 100)}
                          onChange={(e) => setMusicDuckLevel(parseInt(e.target.value, 10) / 100)}
                          className="w-28 accent-primary"
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
                        ? "Coming soon on Windows — media session control is being reworked for reliability"
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
                description="Control how long transcriptions are kept"
              />
              <SettingsPanel>
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
                    description={
                      smartContextUnlocked
                        ? "Feed frontmost app name and window title to Whisper for better accuracy. Always local — never sent to cloud."
                        : "Pro feature — unlock in Settings → Pro to enable Smart Context"
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
                    <SettingsRow
                      label="Active file context"
                      description="Reads variable and function names from your active file to improve code dictation accuracy. Local only — file content stays on your device."
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
          </div>
        );

      // ───────────────────────────────────────────────────
      // TRANSCRIPTION
      // ───────────────────────────────────────────────────
      case "transcription":
        return (
          <div className="space-y-6">
            <SectionHeader
              title="Speech Recognition"
              description="Choose between cloud-based services for speed or local models for privacy"
            />

            <TranscriptionModelPicker
              selectedCloudProvider={cloudTranscriptionProvider}
              onCloudProviderSelect={setCloudTranscriptionProvider}
              selectedCloudModel={cloudTranscriptionModel}
              onCloudModelSelect={setCloudTranscriptionModel}
              selectedLocalModel={
                whisperModel
              }
              onLocalModelSelect={(modelId) => {
                setWhisperModel(modelId);
              }}
              selectedLocalProvider={localTranscriptionProvider}
              onLocalProviderSelect={(providerId) => {
                setLocalTranscriptionProvider(providerId);
              }}
              whisperForceCpu={whisperForceCpu}
              onWhisperForceCpuChange={setWhisperForceCpu}
              gpuSupported={gpuSupportedForPicker}
              useLocalWhisper={useLocalWhisper}
              onModeChange={(isLocal) => {
                setUseLocalWhisper(isLocal);
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

            {useLocalWhisper && localTranscriptionProvider === "whisper" && (
              <div className="mt-6">
                <SectionHeader
                  title="Local Whisper performance"
                  description="Tune how the local whisper-server behaves after you stop dictating"
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Idle shutdown (minutes)"
                      description="Stops the local whisper-server after being idle to free RAM/VRAM. Set to 0 to keep it running."
                    >
                      <div className="flex items-center gap-2">
                        <input
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
                          className="flex h-9 w-24 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground text-right shadow-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
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
                  description="Hardware detection, CUDA setup, and transcription speed benchmarks"
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
      // DICTIONARY
      // ───────────────────────────────────────────────────
      case "dictionary":
        return (
          <div className="space-y-8">
            <SectionHeader
              title="Dictionary"
              description="Teach PrivateTranscribe the words that matter to you - names, products, acronyms, and specialist terms."
            />

            <SettingsPanel>
              <SettingsPanelRow>
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add a custom word or phrase"
                      value={newDictionaryWord}
                      onChange={(e) => setNewDictionaryWord(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddDictionaryWord();
                        }
                      }}
                    />
                    <Button onClick={handleAddDictionaryWord} disabled={!newDictionaryWord.trim()}>
                      Add
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    PrivateTranscribe uses this list to better recognize spellings that generic
                    speech models often miss.
                  </p>
                </div>
              </SettingsPanelRow>

              <SettingsPanelRow>
                {customDictionary.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {customDictionary.map((word) => (
                      <Badge
                        key={word}
                        variant="secondary"
                        className="px-2.5 py-1 text-xs cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors"
                        onClick={() => handleRemoveDictionaryWord(word)}
                        title="Click to remove"
                      >
                        {word} ×
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-border-subtle bg-surface-raised/20 px-4 py-6 text-center">
                    <p className="text-sm font-medium text-foreground">Your dictionary is ready</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Add words above to improve recognition for names, jargon, and niche terms.
                    </p>
                  </div>
                )}
              </SettingsPanelRow>
            </SettingsPanel>
          </div>
        );

      // ───────────────────────────────────────────────────
      // AI MODELS
      // ───────────────────────────────────────────────────
      case "aiModels":
        return (
          <div className="space-y-8">
            <SectionHeader
              title="AI Enhancement"
              description="Configure AI text cleanup and polish"
            />

            {!aiEnhancementUnlocked && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3">
                <Lock size={24} className="mx-auto text-primary/60" />
                <h3 className="text-base font-semibold text-foreground">
                  Available with PrivateTranscribe Pro
                </h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  AI Enhancement automatically polishes your transcriptions - fixing grammar,
                  formatting text, and handling intelligent rewrites. Unlock it with a Pro license
                  in Settings.
                </p>
              </div>
            )}

            {aiEnhancementUnlocked && (
              <>
                <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5">
                  <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-4">
                    How it works
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground/50 mb-2">
                        Before (raw dictation)
                      </p>
                      <div className="rounded-lg bg-surface-1/50 border border-border-subtle/30 p-3">
                        <p className="text-[12px] text-muted-foreground leading-relaxed italic">
                          &quot;so basically what i was thinking is that we should probably schedule
                          a meeting for next week um to discuss the uh the budget for q2&quot;
                        </p>
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] text-primary/60 mb-2">After (AI enhanced)</p>
                      <div className="rounded-lg bg-primary/5 border border-primary/10 p-3">
                        <p className="text-[12px] text-foreground leading-relaxed">
                          &quot;We should schedule a meeting next week to discuss the Q2
                          budget.&quot;
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <ReasoningModelSelector
                  useReasoningModel={useReasoningModel}
                  setUseReasoningModel={(value) => {
                    setUseReasoningModel(value);
                    updateReasoningSettings({ useReasoningModel: value });
                  }}
                  setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
                  cloudReasoningBaseUrl={cloudReasoningBaseUrl}
                  reasoningModel={reasoningModel}
                  setReasoningModel={setReasoningModel}
                  localReasoningProvider={reasoningProvider}
                  setLocalReasoningProvider={setReasoningProvider}
                  openaiApiKey={openaiApiKey}
                  setOpenaiApiKey={setOpenaiApiKey}
                  anthropicApiKey={anthropicApiKey}
                  setAnthropicApiKey={setAnthropicApiKey}
                  geminiApiKey={geminiApiKey}
                  setGeminiApiKey={setGeminiApiKey}
                  groqApiKey={groqApiKey}
                  setGroqApiKey={setGroqApiKey}
                  customReasoningApiKey={customReasoningApiKey}
                  setCustomReasoningApiKey={setCustomReasoningApiKey}
                  showAlertDialog={showAlertDialog}
                />

                {reasoningProvider === "local" && (
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <SettingsRow
                        label="Idle shutdown (minutes)"
                        description="Stops the local llama-server after being idle to free RAM/VRAM. Set to 0 to keep it running."
                      >
                        <div className="flex items-center gap-2 shrink-0">
                          <input
                            type="number"
                            min={0}
                            max={240}
                            step={1}
                            value={llamaIdleDraft}
                            onChange={(e) => {
                              setLlamaIdleDraft(e.target.value);
                            }}
                            onBlur={() => {
                              const raw = parseInt(llamaIdleDraft, 10);
                              const next = Number.isFinite(raw)
                                ? Math.max(0, Math.min(240, raw))
                                : llamaServerIdleTimeoutMinutes;

                              setLlamaIdleDraft(String(next));
                              updateReasoningSettings({ llamaServerIdleTimeoutMinutes: next });
                              window.electronAPI
                                ?.llamaServerSetIdleTimeoutMinutes(next)
                                ?.catch(() => {});
                            }}
                            className="flex h-9 w-24 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground text-right shadow-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                            aria-label="Llama server idle shutdown minutes"
                          />
                          <span className="text-xs text-muted-foreground">min</span>
                        </div>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </SettingsPanel>
                )}
              </>
            )}
          </div>
        );

      // ───────────────────────────────────────────────────
      // AGENT CONFIG
      // ───────────────────────────────────────────────────
      case "agentConfig":
        return (
          <div className="space-y-8">
            <SectionHeader
              title="Voice Assistant"
              description="Configure your AI agent's name and behavior"
            />

            {!voiceAssistantUnlocked && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3">
                <Lock size={24} className="mx-auto text-primary/60" />
                <h3 className="text-base font-semibold text-foreground">
                  Available with PrivateTranscribe Pro
                </h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  Customize your voice assistant with a personal name and fine-tuned system prompts
                  for AI-enhanced transcriptions. Unlock it with a Pro license in Settings.
                </p>
              </div>
            )}

            {voiceAssistantUnlocked && (
              <>
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Agent name"
                      description="Pick something short and natural to say aloud."
                    >
                      <div className="flex gap-2 w-full max-w-sm">
                        <Input
                          placeholder="e.g. Jarvis, Nova, Atlas..."
                          value={agentName}
                          onChange={(e) => setAgentName(e.target.value)}
                          className="flex-1 text-center text-base font-mono"
                        />
                        <Button
                          onClick={() => {
                            setAgentName(agentName.trim());
                            showAlertDialog({
                              title: "Agent Name Updated",
                              description: `Your agent is now named "${agentName.trim()}". Address it by saying "Hey ${agentName.trim()}" followed by your instructions.`,
                            });
                          }}
                          disabled={!agentName.trim()}
                          size="sm"
                        >
                          Save
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-primary" />
                        <p className="text-sm font-medium text-foreground">
                          How instruction mode works
                        </p>
                      </div>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        When you say{" "}
                        <span className="font-medium text-foreground">
                          &quot;Hey {agentName}&quot;
                        </span>{" "}
                        followed by an instruction, PrivateTranscribe switches from cleanup mode to
                        assistant mode. Without the trigger phrase, it simply polishes your
                        dictation.
                      </p>
                    </div>
                  </SettingsPanelRow>
                  <SettingsPanelRow>
                    <div className="space-y-2.5">
                      {[
                        `Hey ${agentName}, write a formal email about the budget`,
                        `Hey ${agentName}, make this more professional`,
                        `Hey ${agentName}, convert this to bullet points`,
                      ].map((example) => (
                        <div key={example} className="flex items-start gap-3">
                          <span className="shrink-0 mt-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded bg-primary/15 text-primary">
                            Instruction
                          </span>
                          <p className="text-[12px] text-muted-foreground leading-relaxed">
                            &quot;{example}&quot;
                          </p>
                        </div>
                      ))}
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            )}
          </div>
        );

      // ───────────────────────────────────────────────────
      // PROMPTS
      // ───────────────────────────────────────────────────
      case "prompts":
        return (
          <div className="space-y-8">
            <SectionHeader
              title="System Prompts"
              description="Shape how PrivateTranscribe interprets instructions, formats output, and responds to your voice assistant workflows."
            />

            {voiceAssistantUnlocked ? (
              <PromptStudio />
            ) : (
              <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 shadow-[0_0_40px_rgba(112,255,186,0.08)] overflow-hidden relative">
                <div className="absolute top-4 right-4">
                  <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10">
                    Pro
                  </Badge>
                </div>
                <div className="max-w-2xl space-y-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center shadow-[0_0_24px_rgba(112,255,186,0.12)]">
                    <Sparkles className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">Your prompt workspace</h3>
                    <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                      The control room for system instructions - tune tone, cleanup rules, command
                      behavior, and reusable prompt presets with full precision.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {[
                      "Preset prompt profiles for different workflows",
                      "Fine-grained instruction layers for cleanup vs assistant mode",
                      "Safe testing before prompts affect live dictation",
                    ].map((item) => (
                      <div
                        key={item}
                        className="rounded-xl border border-border-subtle/50 bg-surface-raised/40 px-4 py-3 text-sm text-muted-foreground"
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
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
              title="System Permissions"
              description="Grant access to microphone, accessibility features, and other system capabilities"
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
      // HELP & SUPPORT
      // ───────────────────────────────────────────────────
      case "help": {
        return (
          <div className="space-y-6">
            <SectionHeader
              title="Help & Support"
              description="Get assistance with PrivateTranscribe and report issues"
            />

            <SettingsPanel>
              <SettingsPanelRow>
                <SettingsRow
                  label="Contact & Bug Reports"
                  description="support@privatetranscribe.com"
                >
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
                </SettingsRow>
              </SettingsPanelRow>
            </SettingsPanel>

            <div>
              <p className="text-[13px] font-medium text-foreground mb-3">Version Information</p>
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label="Current version"
                    description={
                      updateStatus.isDevelopment
                        ? "Running in development mode"
                        : "Installed version of PrivateTranscribe"
                    }
                  >
                    <span className="text-[13px] tabular-nums text-muted-foreground font-mono">
                      {currentVersion || "..."}
                    </span>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );
      }

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
            <ProSettingsSection />
          </div>
        );

      // ───────────────────────────────────────────────────
      // DEVELOPER (+ data management moved here)
      // ───────────────────────────────────────────────────
      case "developer":
        return (
          <div className="space-y-8">
            <SectionHeader
              title="Developer Tools"
              description="Advanced diagnostics, logging, and debugging capabilities"
            />

            {updateStatus.isDevelopment && <DeveloperSection />}

            {/* Data Management - moved from General */}
            <div className="border-t border-border/30 pt-8">
              <SectionHeader
                title="Data & Storage"
                description="Manage settings, statistics, model cache, and application data"
              />

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
                            <input
                              type="checkbox"
                              className="rounded"
                              checked={includeApiKeysInExport}
                              onChange={(e) => setIncludeApiKeysInExport(e.target.checked)}
                            />
                            Include API keys in export
                          </label>
                          <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
                            <input
                              type="checkbox"
                              className="rounded"
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
                                    await handleImportSettingsFile(file);
                                    showAlertDialog({
                                      title: "Settings Imported",
                                      description: "Your settings were imported successfully.",
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
                          ? "Remove PrivateTranscribe via Windows Settings → Apps & features. To also remove downloaded models and app data, use Reset app data first."
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
