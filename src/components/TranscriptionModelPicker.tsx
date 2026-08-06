import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Download, Trash2, Cloud, Lock, X, RefreshCw, HardDrive, Cpu, Zap } from "lucide-react";
import { ProviderIcon } from "./ui/ProviderIcon";
import { ProviderTabs } from "./ui/ProviderTabs";
import ModelCardList from "./ui/ModelCardList";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import ApiKeyInput from "./ui/ApiKeyInput";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload } from "../hooks/useModelDownload";
import {
  getTranscriptionProviders,
  TranscriptionProviderData,
  WHISPER_MODEL_INFO,
} from "../models/ModelRegistry";
import { MODEL_PICKER_COLORS, type ColorScheme } from "../utils/modelPickerStyles";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { API_ENDPOINTS } from "../config/constants";
import { createExternalLinkHandler } from "../utils/externalLinks";
import { isValidApiUrl } from "../helpers/urlValidation";

interface LocalModel {
  model: string;
  size_mb?: number;
  downloaded?: boolean;
}

interface LocalModelCardProps {
  modelId: string;
  name: string;
  description: string;
  size: string;
  actualSizeMb?: number;
  isSelected: boolean;
  isDownloaded: boolean;
  isDownloading: boolean;
  isCancelling: boolean;
  recommended?: boolean;
  provider: string;
  languageLabel?: string;
  perf?: { speed: number; quality: number };
  onSelect: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onCancel: () => void;
  styles: ReturnType<(typeof MODEL_PICKER_COLORS)[keyof typeof MODEL_PICKER_COLORS]>;
}

// Speed vs. accuracy ratings (1-5) for Whisper models, rendered as segmented meters.
// Speed = how fast it transcribes; quality = transcription accuracy.
const WHISPER_PERF_RATINGS: Record<string, { speed: number; quality: number }> = {
  tiny: { speed: 5, quality: 1 },
  base: { speed: 4, quality: 2 },
  small: { speed: 3, quality: 3 },
  medium: { speed: 2, quality: 4 },
  large: { speed: 1, quality: 5 },
  turbo: { speed: 4, quality: 4 },
};

// Compact 5-segment meter matching the calm operator look.
function PerfMeter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1" title={`${label}: ${value}/5`}>
      <span className="w-9 text-right text-[8px] font-medium uppercase tracking-wide text-muted-foreground/50">
        {label}
      </span>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`h-1 w-2 rounded-[1px] ${
              i <= value ? "bg-primary/70" : "bg-muted-foreground/15"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function LocalModelCard({
  modelId,
  name,
  description,
  size,
  actualSizeMb,
  isSelected,
  isDownloaded,
  isDownloading,
  isCancelling,
  recommended,
  provider,
  languageLabel,
  perf,
  onSelect,
  onDelete,
  onDownload,
  onCancel,
  styles: cardStyles,
}: LocalModelCardProps) {
  // Click to select if downloaded
  const handleClick = () => {
    if (isDownloaded && !isSelected) {
      onSelect();
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`relative w-full text-left overflow-hidden rounded-lg border transition-all duration-200 group ${
        isSelected ? cardStyles.modelCard.selected : cardStyles.modelCard.default
      } ${isDownloaded && !isSelected ? "cursor-pointer" : ""}`}
    >
      {/* Left accent bar for selected model */}
      {isSelected && (
        <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary rounded-l-lg" />
      )}
      <div className="flex items-center gap-2 p-2.5 pl-3">
        {/* Status dot with LED glow */}
        <div className="shrink-0">
          {isDownloaded ? (
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                isSelected
                  ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)]"
                  : "bg-success shadow-[0_0_4px_rgba(34,197,94,0.5)]"
              }`}
            />
          ) : isDownloading ? (
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.5)]" />
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20" />
          )}
        </div>

        {/* Model info - single line, no description */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <ProviderIcon provider={provider} className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium text-sm text-foreground truncate">{name}</span>
          <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
            {actualSizeMb ? `${actualSizeMb}MB` : size}
          </span>
          {recommended && <span className={cardStyles.badges.recommended}>Recommended</span>}
          {languageLabel && (
            <span className="text-[10px] text-muted-foreground/50 font-medium shrink-0">
              {languageLabel}
            </span>
          )}
        </div>

        {/* Speed vs. accuracy meters */}
        {perf && (
          <div className="hidden sm:flex flex-col gap-0.5 shrink-0 mr-1">
            <PerfMeter label="Speed" value={perf.speed} />
            <PerfMeter label="Accuracy" value={perf.quality} />
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isDownloaded ? (
            <>
              {isSelected && (
                <span className="text-[10px] font-medium text-primary px-2 py-0.5 bg-primary/10 rounded-sm">
                  Active
                </span>
              )}
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 size={12} />
              </Button>
            </>
          ) : isDownloading ? (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              disabled={isCancelling}
              size="sm"
              variant="outline"
              className="h-6 px-2.5 text-[11px] text-destructive border-destructive/25 hover:bg-destructive/8"
            >
              <X size={11} className="mr-0.5" />
              {isCancelling ? "..." : "Cancel"}
            </Button>
          ) : (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              size="sm"
              variant="default"
              className="h-6 px-2.5 text-[11px]"
            >
              <Download size={11} className="mr-1" />
              Download
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface TranscriptionModelPickerProps {
  selectedCloudProvider: string;
  onCloudProviderSelect: (providerId: string) => void;
  selectedCloudModel: string;
  onCloudModelSelect: (modelId: string) => void;
  selectedLocalModel: string;
  onLocalModelSelect: (modelId: string) => void;
  selectedLocalProvider?: string;
  onLocalProviderSelect?: (providerId: string) => void;
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  customTranscriptionApiKey?: string;
  setCustomTranscriptionApiKey?: (key: string) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl?: (url: string) => void;
  className?: string;
  variant?: "onboarding" | "settings";
  /** Whether Whisper is running in CPU-only mode (no CUDA). Controls the 3-engine selector. */
  whisperForceCpu?: boolean;
  onWhisperForceCpuChange?: (forceCpu: boolean) => void;
  /** Whether this platform supports GPU acceleration (NVIDIA CUDA detected). */
  gpuSupported?: boolean;
  /** Hardware-detected Whisper recommendation. Overrides the static registry badge. */
  recommendedLocalModel?: string;
  onDownloadComplete?: () => void;
}

const CLOUD_PROVIDER_TABS = [
  { id: "openai", name: "OpenAI" },
  { id: "groq", name: "Groq", recommended: true },
  { id: "custom", name: "Custom" },
];

// Mode toggle component - defined outside to prevent recreation on every render
interface ModeToggleProps {
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
}

function ModeToggle({ useLocalWhisper, onModeChange }: ModeToggleProps) {
  return (
    <div className="relative flex p-0.5 rounded-lg bg-surface-1 border border-border-subtle">
      {/* Sliding indicator */}
      <div
        className={`absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-card border border-border-subtle shadow-(--shadow-card) transition-transform duration-200 ease-out ${
          useLocalWhisper ? "translate-x-0" : "translate-x-[calc(100%+4px)]"
        }`}
      />
      <button
        onClick={() => onModeChange(true)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md transition-colors duration-150 ${
          useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Lock className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">Local</span>
      </button>
      <button
        onClick={() => onModeChange(false)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md transition-colors duration-150 ${
          !useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Cloud className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">Cloud</span>
      </button>
    </div>
  );
}

export default function TranscriptionModelPicker({
  selectedCloudProvider,
  onCloudProviderSelect,
  selectedCloudModel,
  onCloudModelSelect,
  selectedLocalModel,
  onLocalModelSelect,
  selectedLocalProvider = "whisper",
  onLocalProviderSelect,
  useLocalWhisper,
  onModeChange,
  openaiApiKey,
  setOpenaiApiKey,
  groqApiKey,
  setGroqApiKey,
  customTranscriptionApiKey = "",
  setCustomTranscriptionApiKey,
  cloudTranscriptionBaseUrl = "",
  setCloudTranscriptionBaseUrl,
  className = "",
  variant = "settings",
  whisperForceCpu = false,
  onWhisperForceCpuChange,
  gpuSupported = false,
  recommendedLocalModel,
  onDownloadComplete,
}: TranscriptionModelPickerProps) {
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [showAllLocalModels, setShowAllLocalModels] = useState(false);
  const [engineStatus, setEngineStatus] = useState<{
    desiredMode?: string;
    effectiveEngine?: string;
    fallback?: { active: boolean; reason: string | null };
    running?: boolean;
  } | null>(null);
  const hasLoadedRef = useRef(false);

  // Normalize legacy provider selections to Whisper-only local mode.
  useEffect(() => {
    if (selectedLocalProvider && selectedLocalProvider !== "whisper") {
      onLocalProviderSelect?.("whisper");
    }
  }, [selectedLocalProvider, onLocalProviderSelect]);

  // Fetch engine status to show actual backend state
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.whisperServerStatus) return;
    let active = true;
    const fetchStatus = () => {
      window.electronAPI
        ?.whisperServerStatus?.()
        ?.then((status: any) => {
          if (active) setEngineStatus(status);
        })
        .catch(() => {});
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [whisperForceCpu]);

  const isLoadingRef = useRef(false);
  const loadLocalModelsRef = useRef<(() => Promise<void>) | null>(null);
  const ensureValidCloudSelectionRef = useRef<(() => void) | null>(null);
  const selectedLocalModelRef = useRef(selectedLocalModel);
  const onLocalModelSelectRef = useRef(onLocalModelSelect);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const colorScheme: ColorScheme = variant === "settings" ? "purple" : "blue";
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);
  const cloudProviders = useMemo(() => getTranscriptionProviders(), []);
  const availableCloudProviderTabs = useMemo(
    () =>
      variant === "onboarding"
        ? CLOUD_PROVIDER_TABS.filter((provider) => provider.id !== "custom")
        : CLOUD_PROVIDER_TABS,
    [variant]
  );
  const validCloudProviderIds = useMemo(
    () => availableCloudProviderTabs.map((provider) => provider.id),
    [availableCloudProviderTabs]
  );

  useEffect(() => {
    selectedLocalModelRef.current = selectedLocalModel;
  }, [selectedLocalModel]);
  useEffect(() => {
    onLocalModelSelectRef.current = onLocalModelSelect;
  }, [onLocalModelSelect]);

  const validateAndSelectModel = useCallback((loadedModels: LocalModel[]) => {
    const current = selectedLocalModelRef.current;
    if (!current) return;

    const downloaded = loadedModels.filter((m) => m.downloaded);
    const isCurrentDownloaded = loadedModels.find((m) => m.model === current)?.downloaded;

    if (!isCurrentDownloaded && downloaded.length > 0) {
      onLocalModelSelectRef.current(downloaded[0].model);
    } else if (!isCurrentDownloaded && downloaded.length === 0) {
      onLocalModelSelectRef.current("");
    }
  }, []);

  const loadLocalModels = useCallback(async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    try {
      const result = await window.electronAPI?.listWhisperModels();
      if (result?.success) {
        setLocalModels(result.models);
        validateAndSelectModel(result.models);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to load models:", error);
      setLocalModels([]);
    } finally {
      isLoadingRef.current = false;
    }
  }, [validateAndSelectModel]);

  const ensureValidCloudSelection = useCallback(() => {
    const isValidProvider = validCloudProviderIds.includes(selectedCloudProvider);
    const customUrlValidation = isValidApiUrl(cloudTranscriptionBaseUrl || "");

    if (!isValidProvider) {
      // Check if we have a custom URL that differs from known providers
      const knownProviderUrls = cloudProviders.map((p) => p.baseUrl);
      const hasCustomUrl =
        cloudTranscriptionBaseUrl &&
        cloudTranscriptionBaseUrl.trim() !== "" &&
        cloudTranscriptionBaseUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE &&
        customUrlValidation.valid &&
        !knownProviderUrls.includes(cloudTranscriptionBaseUrl) &&
        variant !== "onboarding";

      if (hasCustomUrl) {
        onCloudProviderSelect("custom");
      } else {
        const firstProvider = cloudProviders[0];
        if (firstProvider) {
          onCloudProviderSelect(firstProvider.id);
          if (firstProvider.models?.length) {
            onCloudModelSelect(firstProvider.models[0].id);
          }
        }
      }
    } else if (selectedCloudProvider !== "custom" && !selectedCloudModel) {
      const provider = cloudProviders.find((p) => p.id === selectedCloudProvider);
      if (provider?.models?.length) {
        onCloudModelSelect(provider.models[0].id);
      }
    }
  }, [
    cloudProviders,
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    selectedCloudModel,
    onCloudProviderSelect,
    onCloudModelSelect,
    validCloudProviderIds,
    variant,
  ]);

  useEffect(() => {
    loadLocalModelsRef.current = loadLocalModels;
  }, [loadLocalModels]);
  useEffect(() => {
    ensureValidCloudSelectionRef.current = ensureValidCloudSelection;
  }, [ensureValidCloudSelection]);

  // Handle local model loading when in local mode
  useEffect(() => {
    if (!useLocalWhisper) return;

    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true;
      loadLocalModelsRef.current?.();
    }
  }, [useLocalWhisper]);

  // Handle cloud mode initialization - only when switching to cloud mode
  useEffect(() => {
    if (useLocalWhisper) return;

    // Reset local model load flags when switching to cloud
    hasLoadedRef.current = false;
    ensureValidCloudSelectionRef.current?.();
  }, [useLocalWhisper]);

  useEffect(() => {
    const handleModelsCleared = () => loadLocalModels();
    window.addEventListener("PrivateTranscribe-models-cleared", handleModelsCleared);
    return () =>
      window.removeEventListener("PrivateTranscribe-models-cleared", handleModelsCleared);
  }, [loadLocalModels]);

  const {
    downloadingModel,
    downloadProgress,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    isInstalling,
    cancelDownload,
    isCancelling,
    failedModel: failedWhisperModel,
    retryDownload: retryWhisperDownload,
  } = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: () => {
      void loadLocalModels();
      onDownloadComplete?.();
    },
  });

  const handleModeChange = useCallback(
    (isLocal: boolean) => {
      onModeChange(isLocal);
      if (!isLocal) ensureValidCloudSelection();
    },
    [onModeChange, ensureValidCloudSelection]
  );

  const handleCloudProviderChange = useCallback(
    (providerId: string) => {
      if (variant === "onboarding" && providerId === "custom") {
        return;
      }
      onCloudProviderSelect(providerId);
      const provider = cloudProviders.find((p) => p.id === providerId);

      if (providerId === "custom") {
        // Clear model to whisper-1 (standard fallback) to avoid sending
        // provider-specific models to custom endpoints
        onCloudModelSelect("whisper-1");
        // Don't change base URL - user will enter their own
        return;
      }

      if (provider) {
        // Update base URL to the selected provider's default
        setCloudTranscriptionBaseUrl?.(provider.baseUrl);
        if (provider.models?.length) {
          onCloudModelSelect(provider.models[0].id);
        }
      }
    },
    [
      cloudProviders,
      onCloudProviderSelect,
      onCloudModelSelect,
      setCloudTranscriptionBaseUrl,
      variant,
    ]
  );

  // Derives a single "engine" value for Whisper.
  type LocalEngine = "cpu" | "gpu";
  const selectedEngine: LocalEngine = useMemo(
    () => (whisperForceCpu ? "cpu" : "gpu"),
    [whisperForceCpu]
  );

  const handleEngineChange = useCallback(
    (engine: LocalEngine) => {
      onLocalProviderSelect?.("whisper");
      onWhisperForceCpuChange?.(engine === "cpu");
    },
    [onLocalProviderSelect, onWhisperForceCpuChange]
  );

  // Wrapper to set both model and provider when selecting a local model
  const handleWhisperModelSelect = useCallback(
    (modelId: string) => {
      onLocalProviderSelect?.("whisper");
      onLocalModelSelect(modelId);
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleBaseUrlBlur = useCallback(() => {
    if (!setCloudTranscriptionBaseUrl || selectedCloudProvider !== "custom") return;

    const trimmed = (cloudTranscriptionBaseUrl || "").trim();
    if (!trimmed) return;

    // Normalize the URL using the existing util from constants
    const { normalizeBaseUrl } = require("../config/constants");
    const normalized = normalizeBaseUrl(trimmed);

    if (normalized && normalized !== cloudTranscriptionBaseUrl) {
      setCloudTranscriptionBaseUrl(normalized);
    }

    // Auto-detect if this matches a known provider
    if (normalized) {
      for (const provider of cloudProviders) {
        const providerNormalized = normalizeBaseUrl(provider.baseUrl);
        if (normalized === providerNormalized) {
          onCloudProviderSelect(provider.id);
          onCloudModelSelect("whisper-1");
          break;
        }
      }
    }
  }, [
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    setCloudTranscriptionBaseUrl,
    onCloudProviderSelect,
    onCloudModelSelect,
    cloudProviders,
  ]);

  const customBaseUrlValidation = useMemo(
    () => isValidApiUrl(cloudTranscriptionBaseUrl || ""),
    [cloudTranscriptionBaseUrl]
  );

  const handleDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: "Delete Model",
        description:
          "Are you sure you want to delete this model? You'll need to re-download it if you want to use it again.",
        onConfirm: async () => {
          await deleteModel(modelId, async () => {
            const result = await window.electronAPI?.listWhisperModels();
            if (result?.success) {
              setLocalModels(result.models);
              validateAndSelectModel(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteModel, validateAndSelectModel]
  );

  const currentCloudProvider = useMemo<TranscriptionProviderData | undefined>(
    () => cloudProviders.find((p) => p.id === selectedCloudProvider),
    [cloudProviders, selectedCloudProvider]
  );

  const cloudModelOptions = useMemo(() => {
    if (!currentCloudProvider) return [];
    return currentCloudProvider.models.map((m) => ({
      value: m.id,
      label: m.name,
      description: m.description,
      recommended: m.recommended,
      icon: getProviderIcon(selectedCloudProvider),
      invertInDark: isMonochromeProvider(selectedCloudProvider),
    }));
  }, [currentCloudProvider, selectedCloudProvider]);

  const progressDisplay = useMemo(() => {
    if (!useLocalWhisper) return null;

    if (downloadingModel) {
      const modelInfo = WHISPER_MODEL_INFO[downloadingModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingModel}
          progress={downloadProgress}
          isInstalling={isInstalling}
        />
      );
    }

    return null;
  }, [downloadingModel, downloadProgress, isInstalling, useLocalWhisper]);

  const diskUsageMb = useMemo(() => {
    return localModels
      .filter((m) => m.downloaded && m.size_mb)
      .reduce((sum, m) => sum + (m.size_mb ?? 0), 0);
  }, [localModels]);

  const retryBanner = useMemo(() => {
    if (!useLocalWhisper) return null;
    const failedModel = failedWhisperModel;
    const retryFn = retryWhisperDownload;
    if (!failedModel) return null;
    const info = WHISPER_MODEL_INFO[failedModel];
    return (
      <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2">
        <span className="text-xs text-destructive truncate">
          Failed: {info?.name || failedModel}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2.5 text-[11px] shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10"
          onClick={retryFn}
        >
          <RefreshCw size={11} className="mr-1" />
          Retry
        </Button>
      </div>
    );
  }, [useLocalWhisper, failedWhisperModel, retryWhisperDownload]);

  const renderLocalModels = () => {
    const allModelEntries = (
      localModels.length === 0
        ? Object.entries(WHISPER_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : localModels
    ).filter(
      // small-en-tdrz is a special-purpose speaker-diarization model, downloaded on
      // demand from the Transcribe page's speaker-detection flow — not a general
      // dictation model, so keep it out of this picker.
      (model) => model.model !== "small-en-tdrz"
    );

    const isOnboarding = variant === "onboarding";
    const getOnboardingCollapsedModelEntries = () => {
      const preferredModel = recommendedLocalModel ?? selectedLocalModel ?? "turbo";
      const preferredEntry = allModelEntries.find((model) => model.model === preferredModel);
      if (preferredEntry) return [preferredEntry];

      const turboEntry = allModelEntries.find((model) => model.model === "turbo");
      return turboEntry ? [turboEntry] : allModelEntries.slice(0, 1);
    };
    const displayedModelEntries = isOnboarding
      ? (showAllLocalModels ? allModelEntries : getOnboardingCollapsedModelEntries()).sort(
          (a, b) => {
            const rank = (model: LocalModel): number => {
              if (model.model === recommendedLocalModel) return 0;
              if (model.model === selectedLocalModel) return 1;
              if (model.model === "turbo") return 2;
              if (model.downloaded) return 3;
              return 9;
            };
            return rank(a) - rank(b);
          }
        )
      : allModelEntries;

    return (
      <div className="space-y-1">
        {displayedModelEntries.map((model) => {
          const modelId = model.model;
          const info = WHISPER_MODEL_INFO[modelId] || {
            name: modelId,
            description: "Model",
            size: "Unknown",
          };

          const perf = WHISPER_PERF_RATINGS[modelId];
          const isRecommended = recommendedLocalModel
            ? modelId === recommendedLocalModel
            : info.recommended;

          return (
            <LocalModelCard
              key={modelId}
              modelId={modelId}
              name={isOnboarding && modelId === "turbo" ? "Whisper Turbo" : info.name}
              description={info.description}
              size={info.size}
              actualSizeMb={model.size_mb}
              isSelected={modelId === selectedLocalModel}
              isDownloaded={model.downloaded ?? false}
              isDownloading={isDownloadingModel(modelId)}
              isCancelling={isCancelling}
              recommended={isRecommended}
              provider="whisper"
              perf={perf}
              onSelect={() => handleWhisperModelSelect(modelId)}
              onDelete={() => handleDelete(modelId)}
              onDownload={() => downloadModel(modelId, handleWhisperModelSelect)}
              onCancel={cancelDownload}
              styles={styles}
            />
          );
        })}
        {isOnboarding && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAllLocalModels((value) => !value)}
            className="mt-1 h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {showAllLocalModels ? "Hide advanced models" : "Show all models"}
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Integrated mode toggle - always visible */}
      <ModeToggle useLocalWhisper={useLocalWhisper} onModeChange={handleModeChange} />

      {!useLocalWhisper && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2">
          <span className="text-amber-500 text-xs leading-relaxed">
            ⚠️ Cloud mode sends your audio to a third-party server. Your voice data leaves this
            device.
          </span>
        </div>
      )}

      {!useLocalWhisper ? (
        <div className={styles.container}>
          <div className="p-2.5 pb-0">
            <ProviderTabs
              providers={availableCloudProviderTabs}
              selectedId={selectedCloudProvider}
              onSelect={handleCloudProviderChange}
              colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
              scrollable
            />
          </div>

          <div className="p-3">
            {selectedCloudProvider === "custom" ? (
              <div className="space-y-3">
                {/* Endpoint URL */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">Endpoint URL</label>
                  <Input
                    value={cloudTranscriptionBaseUrl}
                    onChange={(e) => setCloudTranscriptionBaseUrl?.(e.target.value)}
                    onBlur={handleBaseUrlBlur}
                    placeholder="https://your-api.example.com/v1"
                    className="h-8 text-sm"
                  />
                  {!customBaseUrlValidation.valid && customBaseUrlValidation.reason && (
                    <p className="text-xs text-destructive">{customBaseUrlValidation.reason}</p>
                  )}
                </div>

                {/* API Key */}
                <ApiKeyInput
                  apiKey={customTranscriptionApiKey}
                  setApiKey={setCustomTranscriptionApiKey || (() => {})}
                  label="API Key (Optional)"
                  helpText=""
                />

                {/* Model Name */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">Model</label>
                  <Input
                    value={selectedCloudModel}
                    onChange={(e) => onCloudModelSelect(e.target.value)}
                    placeholder="whisper-1"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* API Key with inline link */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-foreground">API Key</label>
                    <button
                      type="button"
                      onClick={createExternalLinkHandler(
                        selectedCloudProvider === "groq"
                          ? "https://console.groq.com/keys"
                          : "https://platform.openai.com/api-keys"
                      )}
                      className="text-[11px] text-white/70 hover:text-white transition-colors cursor-pointer"
                    >
                      Get key →
                    </button>
                  </div>
                  <ApiKeyInput
                    apiKey={selectedCloudProvider === "groq" ? groqApiKey : openaiApiKey}
                    setApiKey={selectedCloudProvider === "groq" ? setGroqApiKey : setOpenaiApiKey}
                    label=""
                    helpText=""
                  />
                </div>

                {/* Model Selection */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Model</label>
                  <ModelCardList
                    models={cloudModelOptions}
                    selectedModel={selectedCloudModel}
                    onModelSelect={onCloudModelSelect}
                    colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.container}>
          <div className="grid grid-cols-2 gap-1.5 p-2.5 pb-2.5">
            {(
              [
                {
                  id: "cpu" as const,
                  icon: Cpu,
                  label: "CPU only",
                  subtitle: "Never uses GPU",
                  recommended: !gpuSupported,
                  disabled: false,
                  title: undefined,
                },
                {
                  id: "gpu" as const,
                  icon: Zap,
                  label: "GPU (CUDA)",
                  subtitle: gpuSupported ? "Faster · translation" : "Needs NVIDIA GPU",
                  recommended: gpuSupported,
                  disabled: !gpuSupported,
                  title: !gpuSupported ? "Requires an NVIDIA GPU with CUDA support" : undefined,
                },
              ] as const
            ).map((engine) => {
              const isActive = selectedEngine === engine.id;
              const Icon = engine.icon;
              // Show "Recommended" badge on the recommended engine, even when it's the
              // active/selected card — the badge marks the right choice, not a suggestion to switch.
              const showRecommended = engine.recommended && !engine.disabled;
              return (
                <button
                  key={engine.id}
                  onClick={() => !engine.disabled && handleEngineChange(engine.id)}
                  disabled={engine.disabled}
                  title={engine.title}
                  className={`flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left transition-all duration-150 ${
                    engine.disabled
                      ? "opacity-40 cursor-not-allowed border-border-subtle/40 bg-surface-raised/20"
                      : isActive
                        ? "border-primary bg-primary/10 shadow-sm cursor-pointer"
                        : "border-border-subtle/60 bg-surface-raised/30 hover:bg-surface-raised/60 hover:border-border-subtle cursor-pointer"
                  }`}
                >
                  <div className="flex items-center justify-between w-full mb-0.5">
                    <div className="flex items-center gap-1 min-w-0">
                      <Icon
                        className={`w-3 h-3 shrink-0 ${isActive && !engine.disabled ? "text-primary" : "text-muted-foreground"}`}
                      />
                      <span
                        className={`text-[10px] font-semibold leading-tight truncate ${isActive && !engine.disabled ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {engine.label}
                      </span>
                    </div>
                    {isActive && !engine.disabled && (
                      <div className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 ml-1" />
                    )}
                  </div>
                  <span className="text-[9px] text-muted-foreground/50 leading-tight">
                    {engine.subtitle}
                  </span>
                  {showRecommended && (
                    <span className="mt-1 text-[8px] font-semibold uppercase tracking-wide text-primary/70 bg-primary/10 px-1 py-0.5 rounded leading-none">
                      Recommended
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <p className="px-2.5 pb-2 text-[10px] leading-snug text-muted-foreground/60">
            CPU runs on any computer. GPU (CUDA) is several times faster but needs an NVIDIA
            graphics card — pick it only if you have one.
          </p>

          {engineStatus && (
            <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
              <div
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  engineStatus.fallback?.active
                    ? "bg-amber-500"
                    : engineStatus.running
                      ? "bg-emerald-500"
                      : "bg-zinc-500"
                }`}
              />
              <span className="text-[9px] text-muted-foreground/60">
                {engineStatus.fallback?.active
                  ? "CPU fallback (retrying CUDA automatically)"
                  : engineStatus.effectiveEngine === "cuda"
                    ? "CUDA active"
                    : engineStatus.effectiveEngine === "cpu"
                      ? "CPU active"
                      : engineStatus.running
                        ? "Running"
                        : "Idle"}
              </span>
            </div>
          )}

          {progressDisplay}
          {retryBanner}

          <div className="p-3 pt-0">
            {renderLocalModels()}
            {diskUsageMb > 0 && (
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <HardDrive size={10} />
                <span>{diskUsageMb} MB used</span>
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
