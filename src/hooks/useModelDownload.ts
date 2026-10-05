import { useSyncExternalStore, useCallback, useEffect, useRef } from "react";
import { useToast } from "../components/ui/Toast";
import type { WhisperDownloadProgressData } from "../types/electron";
import "../types/electron";
import {
  getModelDownloadSession,
  type DownloadProgress,
  type ModelType,
} from "../stores/modelDownloadStore";
export type { DownloadProgress, ModelType } from "../stores/modelDownloadStore";

const PROGRESS_THROTTLE_MS = 100; // Throttle UI updates to prevent flashing

interface UseModelDownloadOptions {
  modelType: ModelType;
  onDownloadComplete?: () => void;
  onModelsCleared?: () => void;
}

interface LLMDownloadProgressData {
  modelId: string;
  progress: number;
  downloadedSize: number;
  totalSize: number;
}

export function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function useModelDownload({
  modelType,
  onDownloadComplete,
  onModelsCleared,
}: UseModelDownloadOptions) {
  const session = getModelDownloadSession(modelType);
  const {
    downloadingModel,
    downloadProgress,
    isCancelling,
    isInstalling,
    failedModel,
    lastError,
    completionVersion,
  } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { isCancellingRef, lastProgressUpdateRef, lastSelectAfterDownloadRef } = session;
  const setDownloadProgress = useCallback(
    (value: DownloadProgress) => session.update({ downloadProgress: value }),
    [session]
  );
  const setIsInstalling = useCallback(
    (value: boolean) => session.update({ isInstalling: value }),
    [session]
  );

  const { toast } = useToast();
  const showError = useCallback(
    (error: { title: string; description: string }) =>
      toast({ ...error, variant: "destructive", duration: 10000 }),
    [toast]
  );
  const onDownloadCompleteRef = useRef(onDownloadComplete);
  const onModelsClearedRef = useRef(onModelsCleared);
  const seenCompletion = useRef(completionVersion);

  useEffect(() => {
    onDownloadCompleteRef.current = onDownloadComplete;
  }, [onDownloadComplete]);

  useEffect(() => {
    if (seenCompletion.current === completionVersion) return;
    seenCompletion.current = completionVersion;
    onDownloadCompleteRef.current?.();
  }, [completionVersion]);

  useEffect(() => {
    onModelsClearedRef.current = onModelsCleared;
  }, [onModelsCleared]);

  useEffect(() => {
    const handleModelsCleared = () => onModelsClearedRef.current?.();
    window.addEventListener("PrivateTranscribe-models-cleared", handleModelsCleared);
    return () =>
      window.removeEventListener("PrivateTranscribe-models-cleared", handleModelsCleared);
  }, []);

  const handleWhisperProgress = useCallback(
    (_event: unknown, data: WhisperDownloadProgressData) => {
      if (
        isCancellingRef.current ||
        (data.model && data.model !== session.getSnapshot().downloadingModel)
      )
        return;
      if (data.type === "progress") {
        const now = Date.now();
        if (now - lastProgressUpdateRef.current < PROGRESS_THROTTLE_MS) return;
        lastProgressUpdateRef.current = now;
        setDownloadProgress({
          percentage: data.percentage || 0,
          downloadedBytes: data.downloaded_bytes || 0,
          totalBytes: data.total_bytes || 0,
        });
      } else if (data.type === "installing") {
        setIsInstalling(true);
      } else if (data.type === "complete") {
        // The request owns completion. A progress event must not unlock the
        // next download before the main process has returned this one's result.
        setIsInstalling(false);
      }
    },
    [session, isCancellingRef, lastProgressUpdateRef, setDownloadProgress, setIsInstalling]
  );

  const handleLLMProgress = useCallback(
    (_event: unknown, data: LLMDownloadProgressData) => {
      // Skip if cancellation is in progress
      if (isCancellingRef.current || data.modelId !== session.getSnapshot().downloadingModel)
        return;

      // Throttle UI updates to prevent flashing (server-side throttling is primary, this is backup)
      const now = Date.now();
      const isComplete = data.progress >= 100;
      if (!isComplete && now - lastProgressUpdateRef.current < PROGRESS_THROTTLE_MS) {
        return;
      }
      lastProgressUpdateRef.current = now;

      setDownloadProgress({
        percentage: data.progress || 0,
        downloadedBytes: data.downloadedSize || 0,
        totalBytes: data.totalSize || 0,
      });
    },
    [session, isCancellingRef, lastProgressUpdateRef, setDownloadProgress]
  );

  const listenToProgress = useCallback(() => {
    let dispose: (() => void) | undefined;

    if (modelType === "whisper") {
      dispose = window.electronAPI?.onWhisperDownloadProgress(handleWhisperProgress);
    } else if (modelType === "parakeet") {
      dispose = window.electronAPI?.onParakeetDownloadProgress(handleWhisperProgress);
    } else if (modelType === "kokoro") {
      // Kokoro emits the same progress/installing/complete shape as whisper.
      dispose = window.electronAPI?.onReadAloudDownloadProgress(handleWhisperProgress);
    } else {
      dispose = window.electronAPI?.onModelDownloadProgress(handleLLMProgress);
    }

    return dispose;
  }, [modelType, handleWhisperProgress, handleLLMProgress]);

  const downloadModel = useCallback(
    async (modelId: string, onSelectAfterDownload?: (id: string) => void) => {
      // Prevent starting a new download if one is already in progress
      if (session.getSnapshot().downloadingModel || session.getSnapshot().isCancelling) {
        toast({
          title: "Download in Progress",
          description: "Please wait for the current download to complete or cancel it first.",
        });
        return;
      }

      // Clear any previous failure state when starting a fresh download
      session.update({ failedModel: null, lastError: null, downloadingModel: modelId });
      lastSelectAfterDownloadRef.current = onSelectAfterDownload;
      // This subscription belongs to the request, so navigation cannot stop
      // progress updates. It is removed when the request settles.
      let disposeProgress: (() => void) | undefined;

      try {
        disposeProgress = listenToProgress();
        setDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
        lastProgressUpdateRef.current = 0; // Reset throttle timer

        let success = false;
        let errorMsg: string | undefined;

        if (modelType === "whisper") {
          const result = await window.electronAPI?.downloadWhisperModel(modelId);
          if (!result?.success && !result?.error?.includes("interrupted by user")) {
            errorMsg = result?.error;
          } else {
            success = result?.success ?? false;
          }
        } else if (modelType === "parakeet") {
          const result = await window.electronAPI?.downloadParakeetModel(modelId);
          if (!result?.success && !result?.error?.includes("interrupted by user")) {
            errorMsg = result?.error;
          } else {
            success = result?.success ?? false;
          }
        } else if (modelType === "kokoro") {
          const result = await window.electronAPI?.readAloudDownloadModel(modelId);
          success = result?.success ?? false;
          if (!success) errorMsg = result?.error || "The voice model could not be downloaded.";
        } else {
          const result = (await window.electronAPI?.modelDownload?.(modelId)) as
            { success: boolean; error?: string } | undefined;
          if (result && !result.success && result.error) {
            errorMsg = result.error;
          } else {
            success = result?.success ?? false;
          }
        }

        if (errorMsg && !isCancellingRef.current) {
          session.update({ failedModel: modelId, lastError: errorMsg });
          showError({
            title: "Download Failed",
            description: `Failed to download model: ${errorMsg}`,
          });
        }

        if (success && !isCancellingRef.current) {
          onSelectAfterDownload?.(modelId);
        }
      } catch (error: unknown) {
        // Skip error display if cancellation is in progress
        if (isCancellingRef.current) return;

        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          !errorMessage.includes("interrupted by user") &&
          !errorMessage.includes("cancelled by user") &&
          !errorMessage.includes("DOWNLOAD_CANCELLED")
        ) {
          session.update({ failedModel: modelId, lastError: errorMessage });
          showError({
            title: "Download Failed",
            description: `Failed to download model: ${errorMessage}`,
          });
        }
      } finally {
        disposeProgress?.();
        isCancellingRef.current = false;
        session.update({
          isInstalling: false,
          isCancelling: session.cancelRequestPendingRef.current,
          downloadingModel: null,
          downloadProgress: { percentage: 0, downloadedBytes: 0, totalBytes: 0 },
          completionVersion: session.getSnapshot().completionVersion + 1,
        });
      }
    },
    [
      session,
      modelType,
      showError,
      toast,
      isCancellingRef,
      lastProgressUpdateRef,
      lastSelectAfterDownloadRef,
      listenToProgress,
      setDownloadProgress,
    ]
  );

  const retryDownload = useCallback(() => {
    if (!failedModel) return;
    downloadModel(failedModel, lastSelectAfterDownloadRef.current);
  }, [failedModel, downloadModel, lastSelectAfterDownloadRef]);

  const deleteModel = useCallback(
    async (modelId: string, onComplete?: () => void) => {
      try {
        let result: { success?: boolean; error?: string; freed_mb?: number } | undefined;
        if (modelType === "whisper") {
          result = await window.electronAPI?.deleteWhisperModel(modelId);
        } else if (modelType === "parakeet") {
          result = await window.electronAPI?.deleteParakeetModel(modelId);
        } else if (modelType === "kokoro") {
          result = await window.electronAPI?.readAloudDeleteModel(modelId);
        } else {
          result = await window.electronAPI?.modelDelete?.(modelId);
        }
        if (!result?.success) throw new Error(result?.error || "The model could not be deleted.");
        toast({
          title: modelType === "kokoro" ? "Voice model deleted" : "Model Deleted",
          description:
            result.freed_mb !== undefined
              ? `Freed ${result.freed_mb}MB of disk space.`
              : "Model deleted successfully!",
        });
        onComplete?.();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showError({
          title: "Delete Failed",
          description: `Failed to delete model: ${errorMessage}`,
        });
      }
    },
    [modelType, toast, showError]
  );

  const cancelDownload = useCallback(async () => {
    const activeModel = session.getSnapshot().downloadingModel;
    if (!activeModel || session.getSnapshot().isCancelling) return;

    session.update({ isCancelling: true });
    isCancellingRef.current = true;
    session.cancelRequestPendingRef.current = true;
    try {
      let result;
      if (modelType === "whisper") {
        result = await window.electronAPI?.cancelWhisperDownload();
      } else if (modelType === "parakeet") {
        result = await window.electronAPI?.cancelParakeetDownload();
      } else if (modelType === "kokoro") {
        result = await window.electronAPI?.readAloudCancelDownload();
      } else {
        result = await window.electronAPI?.modelCancelDownload?.(activeModel);
      }
      if (!result?.success)
        throw new Error(result?.error || "The download could not be cancelled.");
      toast({
        title: "Download Cancelled",
        description: "The download has been cancelled.",
      });
    } catch (error) {
      isCancellingRef.current = false;
      console.error("Failed to cancel download:", error);
      showError({
        title: "Cancel Failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      session.cancelRequestPendingRef.current = false;
      session.update({
        isCancelling: Boolean(session.getSnapshot().downloadingModel && isCancellingRef.current),
      });
    }
  }, [session, modelType, toast, showError, isCancellingRef]);

  const isDownloading = downloadingModel !== null;
  const isDownloadingModel = useCallback(
    (modelId: string) => downloadingModel === modelId,
    [downloadingModel]
  );

  return {
    downloadingModel,
    downloadProgress,
    isDownloading,
    isDownloadingModel,
    isInstalling,
    isCancelling,
    failedModel,
    lastError,
    downloadModel,
    deleteModel,
    cancelDownload,
    retryDownload,
    formatETA,
  };
}
