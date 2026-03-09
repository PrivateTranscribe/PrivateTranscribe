import { useState, useEffect } from "react";
import { Button } from "./button";
import { Cpu, MonitorSmartphone, RefreshCw, Check, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import type {
  HardwareDetectionResult,
  HardwareRecommendations,
  LocalTranscriptionProvider,
} from "../../types/electron";

interface HardwareSetupStepProps {
  onApplyRecommendations: (recommendations: {
    useLocalWhisper: boolean;
    localTranscriptionProvider: LocalTranscriptionProvider;
    whisperModel: string;
    parakeetModel?: string;
  }) => void;
  onNext?: () => void;
  onSkip?: () => void;
  showSkip?: boolean;
}

type DetectionState = "idle" | "detecting" | "complete" | "error";

export default function HardwareSetupStep({
  onApplyRecommendations,
  onNext,
  onSkip,
  showSkip = true,
}: HardwareSetupStepProps) {
  const [detectionState, setDetectionState] = useState<DetectionState>("idle");
  const [detection, setDetection] = useState<HardwareDetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const runDetection = async () => {
    setDetectionState("detecting");
    setError(null);

    try {
      const result = await window.electronAPI?.detectHardware?.();
      if (result?.success && result.detection) {
        setDetection(result.detection);
        setDetectionState("complete");
      } else {
        setError(result?.error || "Hardware detection failed");
        setDetectionState("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error occurred");
      setDetectionState("error");
    }
  };

  // Auto-run detection on mount
  useEffect(() => {
    runDetection();
  }, []);

  const handleApply = () => {
    if (!detection?.recommendations) return;

    const rec = detection.recommendations;
    onApplyRecommendations({
      useLocalWhisper: rec.transcriptionProvider === "local",
      localTranscriptionProvider: rec.localTranscriptionProvider,
      whisperModel: rec.whisperModel,
      parakeetModel: rec.parakeetModel,
    });
    setApplied(true);

    // Auto-advance after brief confirmation display (1.5s for user to see confirmation)
    if (onNext) {
      setTimeout(() => {
        onNext();
      }, 1500);
    }
  };

  const handleContinueWithDefaults = () => {
    // Even if no recommendations, apply safe defaults
    onApplyRecommendations({
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      whisperModel: "turbo",
    });
    setApplied(true);

    // Auto-advance after brief confirmation
    if (onNext) {
      setTimeout(() => {
        onNext();
      }, 1500);
    }
  };

  const getGPUIcon = () => {
    if (!detection?.gpu?.available) return null;
    const vendor = detection.gpu.vendor;
    if (vendor === "nvidia") return "NVIDIA";
    if (vendor === "amd") return "AMD";
    if (vendor === "intel") return "Intel";
    if (vendor === "apple") return "Apple";
    return null;
  };

  const renderDetectionCard = () => {
    if (detectionState === "detecting") {
      return (
        <div className="rounded-lg border border-border-subtle bg-surface-1 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Loader2 className="w-5 h-5 text-primary animate-spin" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-foreground">Detecting Hardware</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Scanning your system for GPU and CPU capabilities...
              </p>
            </div>
          </div>
        </div>
      );
    }

    if (detectionState === "error") {
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-destructive" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-medium text-foreground">Detection Failed</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{error}</p>
            </div>
            <Button onClick={runDetection} variant="outline" size="sm" className="h-7 gap-1.5">
              <RefreshCw className="w-3 h-3" />
              Retry
            </Button>
          </div>
        </div>
      );
    }

    if (!detection) return null;

    const gpuVendor = getGPUIcon();
    const hasCuda = detection.gpu.cuda.available;
    const hasMetal = detection.gpu.metal.available;

    return (
      <div className="space-y-3">
        {/* Hardware Summary */}
        <div className="grid grid-cols-2 gap-2">
          {/* CPU Card */}
          <div className="rounded-lg border border-border-subtle bg-surface-1 p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <Cpu className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                CPU
              </span>
            </div>
            <p className="text-sm font-medium text-foreground truncate" title={detection.cpu.model}>
              {detection.cpu.model.split("@")[0].trim()}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{detection.cpu.count} cores</p>
          </div>

          {/* GPU Card */}
          <div
            className={cn(
              "rounded-lg border p-3",
              detection.gpu.available
                ? hasCuda || hasMetal
                  ? "border-success/30 bg-success/5"
                  : "border-border-subtle bg-surface-1"
                : "border-border-subtle bg-surface-1"
            )}
          >
            <div className="flex items-center gap-2 mb-2">
              <div
                className={cn(
                  "w-7 h-7 rounded-md flex items-center justify-center",
                  hasCuda || hasMetal ? "bg-success/10" : "bg-primary/10"
                )}
              >
                <MonitorSmartphone
                  className={cn(
                    "w-3.5 h-3.5",
                    hasCuda || hasMetal ? "text-success" : "text-primary"
                  )}
                />
              </div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                GPU
              </span>
            </div>
            {detection.gpu.available ? (
              <>
                <p
                  className="text-sm font-medium text-foreground truncate"
                  title={detection.gpu.model || undefined}
                >
                  {gpuVendor} {detection.gpu.model?.replace(/NVIDIA |AMD |Intel /gi, "") || "GPU"}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  {hasCuda && (
                    <span className="text-[10px] text-success font-medium">CUDA Ready</span>
                  )}
                  {hasMetal && (
                    <span className="text-[10px] text-success font-medium">Metal Ready</span>
                  )}
                  {detection.gpu.vram && (
                    <span className="text-[10px] text-muted-foreground">
                      {detection.gpu.vram >= 1024
                        ? `${(detection.gpu.vram / 1024).toFixed(1)} GB`
                        : `${detection.gpu.vram} MB`}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">No GPU Detected</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">CPU transcription only</p>
              </>
            )}
          </div>
        </div>

        {/* Recommendations */}
        {detection.recommendations && detection.recommendations.reasoning.length > 0 ? (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
            <div className="flex items-start gap-2.5">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Check className={cn("w-3.5 h-3.5", applied ? "text-success" : "text-primary")} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-medium text-foreground">
                  {applied ? "Settings Applied" : "Recommended Setup"}
                </h4>
                <ul className="mt-1.5 space-y-1">
                  {detection.recommendations.reasoning.map((reason, idx) => (
                    <li
                      key={idx}
                      className="text-[11px] text-muted-foreground flex items-start gap-1.5"
                    >
                      <span className="text-primary mt-0.5">•</span>
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
            <div className="flex items-start gap-2.5">
              <div className="w-7 h-7 rounded-md bg-warning/10 flex items-center justify-center shrink-0 mt-0.5">
                <AlertCircle className="w-3.5 h-3.5 text-warning" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-medium text-foreground">
                  {applied ? "Default Settings Applied" : "No Recommendations Available"}
                </h4>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {applied
                    ? "Using safe CPU defaults with Whisper Base model. You can adjust settings later."
                    : "Hardware analysis completed but could not generate recommendations. Safe CPU defaults will be used."}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center space-y-0.5">
        <h2 className="text-lg font-semibold text-foreground tracking-tight">Hardware Setup</h2>
        <p className="text-xs text-muted-foreground">
          We'll detect your hardware and recommend optimal settings
        </p>
      </div>

      {/* Detection Results */}
      {renderDetectionCard()}

      {/* Actions */}
      {detectionState === "complete" && (
        <div className="flex items-center justify-center gap-2 pt-2">
          {detection?.recommendations && detection.recommendations.reasoning.length > 0 ? (
            <>
              {!applied ? (
                <Button onClick={handleApply} className="h-8 px-6 gap-1.5">
                  <Check className="w-3.5 h-3.5" />
                  Apply Recommendations
                </Button>
              ) : (
                <div className="flex items-center gap-2 text-success">
                  <Check className="w-4 h-4" />
                  <span className="text-sm font-medium">Continuing...</span>
                </div>
              )}
              {showSkip && !applied && onSkip && (
                <Button onClick={onSkip} variant="ghost" className="h-8 px-4 text-xs">
                  Skip
                </Button>
              )}
            </>
          ) : (
            <>
              {!applied ? (
                onNext && (
                  <Button onClick={handleContinueWithDefaults} className="h-8 px-6">
                    Continue with Defaults
                  </Button>
                )
              ) : (
                <div className="flex items-center gap-2 text-success">
                  <Check className="w-4 h-4" />
                  <span className="text-sm font-medium">Continuing...</span>
                </div>
              )}
              {showSkip && !applied && onSkip && (
                <Button onClick={onSkip} variant="ghost" className="h-8 px-4 text-xs">
                  Skip
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
