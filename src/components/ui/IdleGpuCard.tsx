import { useCallback, useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { Button } from "./button";
import { IconTile } from "./IconTile";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { describeDownloadError } from "../../utils/gpuSetupMessages";
import { modelDisplayName } from "../../utils/setupModelChoice";

interface IdleGpuCardProps {
  useLocalWhisper: boolean;
  localTranscriptionProvider: string;
  whisperForceCpu: boolean;
  whisperModel: string;
  /** The user's choice to stay on the processor; hides the card for good. */
  onUseProcessor: () => void;
}

type CardState = "hidden" | "offer" | "downloading" | "error" | "done";

/**
 * For a PC with a working NVIDIA card that finished setup without the GPU
 * engine. Setup before this fix let a user press Next past an optional button,
 * after which Whisper quietly ran on the processor, often with Large. Setup no
 * longer allows that, but those installs exist, and nothing else tells them.
 */
export default function IdleGpuCard({
  useLocalWhisper,
  localTranscriptionProvider,
  whisperForceCpu,
  whisperModel,
  onUseProcessor,
}: IdleGpuCardProps) {
  const [gpuName, setGpuName] = useState<string | null>(null);
  const [state, setState] = useState<CardState>("hidden");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });

  const usesWhisperOnGpu =
    useLocalWhisper && localTranscriptionProvider === "whisper" && !whisperForceCpu;

  useEffect(() => {
    if (!usesWhisperOnGpu) {
      setState("hidden");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [hardware, cuda] = await Promise.all([
          window.electronAPI?.detectHardware?.(),
          window.electronAPI?.getCudaBinaryStatus?.(),
        ]);
        if (cancelled) return;
        const gpuReady = hardware?.detection?.recommendations?.gpuCategory === "nvidia_cuda";
        const engineMissing = !!cuda?.supported && !cuda.installed;
        setGpuName(hardware?.detection?.gpu?.model?.trim() || null);
        setState((current) =>
          current === "hidden" && gpuReady && engineMissing ? "offer" : current
        );
      } catch {
        /* the card is a hint; failing to check simply hides it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [usesWhisperOnGpu]);

  useEffect(() => {
    if (state !== "downloading") return;
    const cleanup = window.electronAPI?.onCudaBinaryDownloadProgress?.((_event, data) => {
      setProgress({
        percentage: data.percent ?? data.progress ?? 0,
        downloadedBytes: data.bytesDownloaded ?? data.downloadedBytes ?? 0,
        totalBytes: data.totalBytes ?? 0,
      });
    });
    return () => cleanup?.();
  }, [state]);

  const download = useCallback(async () => {
    setState("downloading");
    setError(null);
    setProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
    try {
      const result = await window.electronAPI?.downloadCudaBinary?.();
      if (result?.success) {
        setState("done");
        return;
      }
      setError(describeDownloadError(result?.error));
      setState("error");
    } catch (err) {
      setError(describeDownloadError(err instanceof Error ? err.message : null));
      setState("error");
    }
  }, []);

  if (state === "hidden" || !usesWhisperOnGpu) return null;

  const card = gpuName || "NVIDIA graphics card";
  const model = `Whisper ${modelDisplayName(whisperModel || "base")}`;

  return (
    <div
      className="rounded-2xl border border-warning/30 bg-warning/5 p-5 space-y-3"
      data-testid="idle-gpu-card"
    >
      <div className="flex items-start gap-3">
        <IconTile tone="warning" className="mt-0.5">
          <Zap className="w-3.5 h-3.5 text-warning" />
        </IconTile>
        <div className="flex-1 min-w-0 space-y-1">
          <h2 className="text-sm font-medium text-foreground">
            {state === "done" ? `Dictation now runs on your ${card}` : `Your ${card} is not used`}
          </h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {state === "done"
              ? "The GPU engine is installed. Your next dictation uses the graphics card."
              : state === "downloading"
                ? "Downloading the GPU engine. Dictation keeps working on the processor until it is in."
                : state === "error"
                  ? error
                  : `${model} runs on the processor, which is many times slower. The GPU engine, about 750 MB, moves it to the graphics card.`}
          </p>
        </div>
      </div>

      {state === "downloading" && (
        <DownloadProgressBar modelName="GPU engine" progress={progress} />
      )}

      {(state === "offer" || state === "error") && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => void download()}>
            {state === "error" ? "Try the download again" : "Download the GPU engine"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onUseProcessor}>
            Keep using the processor
          </Button>
        </div>
      )}
    </div>
  );
}
