import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ProviderTabs } from "./ui/ProviderTabs";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { ConfirmDialog } from "./ui/dialog";
import ModelCardList, { type ModelCardOption } from "./ui/ModelCardList";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload, type ModelType } from "../hooks/useModelDownload";
import { MODEL_PICKER_COLORS, type ColorScheme } from "../utils/modelPickerStyles";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { Button } from "./ui/button";

export interface LocalModel {
  id: string;
  name: string;
  size: string;
  sizeBytes?: number;
  description: string;
  isDownloaded?: boolean;
  downloaded?: boolean;
  recommended?: boolean;
}

export interface LocalProvider {
  id: string;
  name: string;
  models: LocalModel[];
}

interface LocalModelPickerProps {
  providers: LocalProvider[];
  selectedModel: string;
  selectedProvider: string;
  onModelSelect: (modelId: string) => void;
  onProviderSelect: (providerId: string) => void;
  modelType: ModelType;
  colorScheme?: Exclude<ColorScheme, "blue">;
  className?: string;
  onDownloadComplete?: () => void;
  compact?: boolean;
}

export default function LocalModelPicker({
  providers,
  selectedModel,
  selectedProvider,
  onModelSelect,
  onProviderSelect,
  modelType,
  colorScheme = "purple",
  className = "",
  onDownloadComplete,
  compact = false,
}: LocalModelPickerProps) {
  const [showAllModels, setShowAllModels] = useState(false);
  const selectionContext = useRef({ active: true, provider: selectedProvider });
  selectionContext.current.provider = selectedProvider;
  useEffect(() => {
    const context = selectionContext.current;
    context.active = true;
    return () => {
      context.active = false;
    };
  }, []);
  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);

  const loadDownloadedModels = useCallback(async () => {
    try {
      let downloaded = new Set<string>();
      if (modelType === "whisper") {
        const result = await window.electronAPI?.listWhisperModels();
        if (result?.success) {
          downloaded = new Set(
            result.models
              .filter((m: { downloaded?: boolean }) => m.downloaded)
              .map((m: { model: string }) => m.model)
          );
        }
      } else {
        const result = await window.electronAPI?.modelGetAll?.();
        if (result && Array.isArray(result)) {
          downloaded = new Set(
            result
              .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
              .map((m: { id: string }) => m.id)
          );
        }
      }
      setDownloadedModels(downloaded);
      return downloaded;
    } catch (error) {
      console.error("Failed to load downloaded models:", error);
      return new Set<string>();
    }
  }, [modelType]);

  useEffect(() => {
    let active = true;
    const initAndValidate = async () => {
      const downloaded = await loadDownloadedModels();
      if (active && selectedModel && !downloaded.has(selectedModel)) {
        onModelSelect("");
      }
    };
    initAndValidate();
    return () => {
      active = false;
    };
  }, [loadDownloadedModels, selectedModel, onModelSelect]);

  const handleDownloadComplete = useCallback(() => {
    loadDownloadedModels();
    onDownloadComplete?.();
  }, [loadDownloadedModels, onDownloadComplete]);

  const {
    downloadingModel,
    downloadProgress,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    cancelDownload,
    isCancelling,
  } = useModelDownload({
    modelType,
    onDownloadComplete: handleDownloadComplete,
    onModelsCleared: loadDownloadedModels,
  });

  const handleDownload = useCallback(
    (modelId: string) => {
      const providerAtStart = selectedProvider;
      downloadModel(modelId, (id) => {
        if (
          selectionContext.current.active &&
          selectionContext.current.provider === providerAtStart
        )
          onModelSelect(id);
      });
    },
    [downloadModel, onModelSelect, selectedProvider]
  );

  const handleDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: "Delete Model",
        description:
          "Are you sure you want to delete this model? You'll need to re-download it if you want to use it again.",
        onConfirm: () =>
          deleteModel(modelId, async () => {
            const downloaded = await loadDownloadedModels();
            if (selectedModel === modelId || (selectedModel && !downloaded.has(selectedModel))) {
              onModelSelect("");
            }
          }),
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteModel, loadDownloadedModels, selectedModel, onModelSelect]
  );

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const models = useMemo(() => currentProvider?.models || [], [currentProvider]);
  const visibleModels =
    compact && !showAllModels
      ? models.filter(
          (model) =>
            model.id === (selectedModel || models.find((m) => m.recommended)?.id || models[0]?.id)
        )
      : models;

  const progressDisplay = useMemo(() => {
    if (!downloadingModel) return null;

    const modelName = models.find((m) => m.id === downloadingModel)?.name || downloadingModel;

    return <DownloadProgressBar modelName={modelName} progress={downloadProgress} />;
  }, [downloadingModel, downloadProgress, models]);

  return (
    <div className={`${styles.container} ${className}`}>
      {(!compact || showAllModels) && (
        <ProviderTabs
          providers={providers}
          selectedId={selectedProvider}
          onSelect={onProviderSelect}
          colorScheme={colorScheme}
          scrollable
        />
      )}

      {progressDisplay}

      <div className="p-4">
        <h5 className={`${styles.header} mb-3`}>
          {compact && !showAllModels ? "Local model" : "Available models"}
        </h5>

        <ModelCardList
          models={visibleModels.map((model): ModelCardOption => ({
            value: model.id,
            label: model.name,
            description: model.size,
            icon: getProviderIcon(selectedProvider),
            invertInDark: isMonochromeProvider(selectedProvider),
            recommended: compact ? false : model.recommended,
            isDownloaded: downloadedModels.has(model.id) || model.isDownloaded || model.downloaded,
            isDownloading: isDownloadingModel(model.id),
          }))}
          selectedModel={selectedModel}
          onModelSelect={onModelSelect}
          onDownload={handleDownload}
          onDelete={handleDelete}
          onCancelDownload={cancelDownload}
          isCancelling={isCancelling}
          colorScheme={colorScheme}
        />
        {compact && (
          <div className="mt-3 space-y-2">
            {!showAllModels && (
              <p className="text-xs text-muted-foreground">{visibleModels[0]?.description}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Download once. Your text stays on this PC. The first cleanup after idle time takes
              longer while the model loads.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAllModels(!showAllModels)}
              aria-expanded={showAllModels}
            >
              {showAllModels ? "Show selected model" : "Choose another local model"}
            </Button>
          </div>
        )}
      </div>

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
