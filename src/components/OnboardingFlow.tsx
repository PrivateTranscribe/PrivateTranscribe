import React, { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Loader2,
  Settings,
  Mic,
  Shield,
  Command,
  Sparkles,
  Cpu,
  ArrowRight,
} from "lucide-react";
import TitleBar from "./TitleBar";
import appIconSrc from "../assets/icon.png";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import HardwareSetupStep from "./ui/HardwareSetupStep";
import PermissionCard from "./ui/PermissionCard";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import StepProgress from "./ui/StepProgress";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSettings } from "../hooks/useSettings";
import { setAgentNameIfEmpty as saveAgentName } from "../utils/agentName";
import { formatHotkeyLabel, getDefaultHotkey } from "../utils/hotkeys";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { useToast } from "./ui/Toast";

interface OnboardingFlowProps {
  onComplete: () => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const steps = [
    { title: "Welcome", icon: Sparkles },
    { title: "Hardware", icon: Cpu },
    { title: "Setup", icon: Settings },
    { title: "Permissions", icon: Shield },
    { title: "Activation", icon: Command },
    { title: "Complete", icon: Check },
  ];

  const MAX_STEP = steps.length - 1;

  const [currentStep, setCurrentStep, removeCurrentStep] = useLocalStorage(
    "onboardingCurrentStep",
    0,
    {
      serialize: String,
      deserialize: (value) => {
        const parsed = parseInt(value, 10);
        // Clamp to valid range to handle users upgrading from older versions
        // with different step counts
        if (isNaN(parsed) || parsed < 0) return 0;
        if (parsed > MAX_STEP) return MAX_STEP;
        return parsed;
      },
    }
  );

  const {
    useLocalWhisper,
    whisperModel,
    whisperForceCpu,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    dictationKey,
    activationMode,
    setActivationMode,
    setDictationKey,
    setWhisperForceCpu,
    setOpenaiApiKey,
    setGroqApiKey,
    updateTranscriptionSettings,
  } = useSettings();

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const agentName = "PrivateTranscribe"; // Default agent name, editable in settings
  const [isModelDownloaded, setIsModelDownloaded] = useState(false);
  const [cudaStatus, setCudaStatus] = useState<{
    installed: boolean;
    path: string | null;
    platform: string;
    supported: boolean;
    upToDate: boolean;
    forceCpu: boolean;
  } | null>(null);
  const [cudaDownloadState, setCudaDownloadState] = useState<
    "idle" | "downloading" | "done" | "error"
  >("idle");
  const [cudaDownloadProgress, setCudaDownloadProgress] = useState({
    percentage: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  });
  const [cudaDownloadError, setCudaDownloadError] = useState<string | null>(null);
  const [skippedModelSetup, setSkippedModelSetup] = useState(false);
  const [hardwareRecommendationsApplied, setHardwareRecommendationsApplied] = useState(false);
  const [onboardingGpuSupported, setOnboardingGpuSupported] = useState(false);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);
  const [isVerifyingHotkey, setIsVerifyingHotkey] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [micTestState, setMicTestState] = useState<"idle" | "recording" | "success" | "error">(
    "idle"
  );
  const [micTestCountdown, setMicTestCountdown] = useState<number | null>(null);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTestError, setMicTestError] = useState<string | null>(null);
  const { toast } = useToast();
  const readableHotkey = formatHotkeyLabel(hotkey);
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();

  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);
  const hotkeyRegistrationCounterRef = useRef(0);
  const micTestTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const micTestIntervalRef = useRef<ReturnType<typeof window.setInterval> | null>(null);
  const micTestRafRef = useRef<number | null>(null);
  const micTestStreamRef = useRef<MediaStream | null>(null);
  const micTestAudioContextRef = useRef<AudioContext | null>(null);
  const micTestSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const pendingStatusChecksRef = useRef(0);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: () => {},
    showSuccessToast: false, // Don't show toast during onboarding auto-registration
    showErrorToast: false,
  });

  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog); // Initialize clipboard hook for permission checks

  const beginStatusCheck = useCallback(() => {
    pendingStatusChecksRef.current += 1;
    setIsLoadingStatus(true);
  }, []);

  const endStatusCheck = useCallback(() => {
    pendingStatusChecksRef.current = Math.max(0, pendingStatusChecksRef.current - 1);
    if (pendingStatusChecksRef.current === 0) {
      setIsLoadingStatus(false);
    }
  }, []);

  const registerHotkeyWithRaceGuard = useCallback(
    async (newHotkey: string) => {
      const registrationId = ++hotkeyRegistrationCounterRef.current;
      const success = await registerHotkey(newHotkey);

      if (registrationId !== hotkeyRegistrationCounterRef.current) {
        return false;
      }

      if (success) {
        setHotkey(newHotkey);
        setDictationKey(newHotkey);
      }

      return success;
    },
    [registerHotkey, setDictationKey]
  );

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

  const checkModelStatus = useCallback(async () => {
    if (!useLocalWhisper || !whisperModel) {
      setIsModelDownloaded(false);
      return;
    }

    beginStatusCheck();
    try {
      const result = await window.electronAPI?.checkModelStatus(whisperModel);
      setIsModelDownloaded(result?.downloaded ?? false);
    } catch (error) {
      console.error("Failed to check model status:", error);
      setIsModelDownloaded(false);
    } finally {
      endStatusCheck();
    }
  }, [useLocalWhisper, whisperModel, beginStatusCheck, endStatusCheck]);

  useEffect(() => {
    void checkModelStatus();
  }, [checkModelStatus]);

  const loadCudaStatus = useCallback(async () => {
    beginStatusCheck();
    try {
      const status = await window.electronAPI?.getCudaBinaryStatus?.();
      const resolvedStatus = status || {
        installed: false,
        path: null,
        platform: "unknown",
        supported: false,
        upToDate: false,
        forceCpu: whisperForceCpu,
      };
      setCudaStatus(resolvedStatus);
    } catch (error) {
      console.error("Failed to check CUDA binary status:", error);
      setCudaStatus({
        installed: false,
        path: null,
        platform: "unknown",
        supported: false,
        upToDate: false,
        forceCpu: whisperForceCpu,
      });
    } finally {
      endStatusCheck();
    }
  }, [whisperForceCpu, beginStatusCheck, endStatusCheck]);

  useEffect(() => {
    void loadCudaStatus();
  }, [loadCudaStatus]);

  useEffect(() => {
    if (useLocalWhisper && !whisperForceCpu) {
      void loadCudaStatus();
    }
  }, [useLocalWhisper, whisperForceCpu, loadCudaStatus]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onCudaBinaryDownloadProgress?.((_event, data) => {
      setCudaDownloadProgress({
        percentage: data.percent ?? data.progress ?? 0,
        downloadedBytes: data.bytesDownloaded ?? data.downloadedBytes ?? 0,
        totalBytes: data.totalBytes ?? 0,
      });
    });
    return () => cleanup?.();
  }, []);

  const handleDownloadCuda = useCallback(async () => {
    setCudaDownloadState("downloading");
    setCudaDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
    setCudaDownloadError(null);

    try {
      const result = await window.electronAPI?.downloadCudaBinary?.();
      if (!result?.success) {
        setCudaDownloadState("error");
        setCudaDownloadError(result?.error || "CUDA download failed");
        return;
      }
      setCudaDownloadState("done");
      await loadCudaStatus();
    } catch (error) {
      setCudaDownloadState("error");
      setCudaDownloadError(error instanceof Error ? error.message : "CUDA download failed");
    }
  }, [loadCudaStatus]);

  const handleCancelCudaDownload = useCallback(async () => {
    try {
      const result = await window.electronAPI?.cancelCudaBinaryDownload?.();
      if (result && !result.success) {
        throw new Error("CUDA download cancellation failed");
      }
      setCudaDownloadState("idle");
      setCudaDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
    } catch (error) {
      console.error("Failed to cancel CUDA download:", error);
      setCudaDownloadError("Failed to cancel download. Please try again.");
    }
  }, []);

  const handleSkipCudaAndUseCpu = useCallback(() => {
    setWhisperForceCpu(true);
    setCudaDownloadState("idle");
    setCudaDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
    setCudaDownloadError(null);
  }, [setWhisperForceCpu]);

  // Auto-register default hotkey when entering the hotkey step (step 4)
  useEffect(() => {
    if (currentStep !== 4) {
      // Reset initialization flag when leaving step 4
      hotkeyStepInitializedRef.current = false;
      return;
    }

    // Prevent double-invocation from React.StrictMode
    if (autoRegisterInFlightRef.current || hotkeyStepInitializedRef.current) {
      return;
    }

    const autoRegisterDefaultHotkey = async () => {
      autoRegisterInFlightRef.current = true;
      hotkeyStepInitializedRef.current = true;

      try {
        // Get platform-appropriate default hotkey
        const defaultHotkey = getDefaultHotkey();

        // Only auto-register if no hotkey is currently set or it's a default value
        if (
          !hotkey ||
          hotkey === "`" ||
          hotkey === "GLOBE" ||
          hotkey === "CommandOrControl+Space"
        ) {
          // Try to register the default hotkey silently
          await registerHotkeyWithRaceGuard(defaultHotkey);
        }
      } catch (error) {
        console.error("Failed to auto-register default hotkey:", error);
      } finally {
        autoRegisterInFlightRef.current = false;
      }
    };

    void autoRegisterDefaultHotkey();
  }, [currentStep, hotkey, registerHotkeyWithRaceGuard]);

  const ensureHotkeyRegistered = useCallback(async () => {
    if (!window.electronAPI?.updateHotkey) {
      return true;
    }

    try {
      const result = await window.electronAPI.updateHotkey(hotkey);
      if (result && !result.success) {
        showAlertDialog({
          title: "Hotkey Not Registered",
          description:
            result.message || "We couldn't register that key. Please choose another hotkey.",
        });
        return false;
      }
      return true;
    } catch (error) {
      console.error("Failed to register onboarding hotkey", error);
      showAlertDialog({
        title: "Hotkey Error",
        description: "We couldn't register that key. Please choose another hotkey.",
      });
      return false;
    }
  }, [hotkey, showAlertDialog]);

  const saveSettings = useCallback(async () => {
    const hotkeyRegistered = await ensureHotkeyRegistered();
    if (!hotkeyRegistered) {
      return false;
    }
    setDictationKey(hotkey);
    saveAgentName(agentName);

    localStorage.setItem("micPermissionGranted", permissionsHook.micPermissionGranted.toString());
    localStorage.setItem(
      "accessibilityPermissionGranted",
      permissionsHook.accessibilityPermissionGranted.toString()
    );
    localStorage.setItem("onboardingCompleted", "true");

    try {
      const saveResult = await window.electronAPI?.saveAllKeysToEnv?.();
      if (saveResult && !saveResult.success) {
        throw new Error("Failed to save API keys");
      }
    } catch (error) {
      console.error("Failed to persist API keys:", error);
      toast({
        title: "Failed to save API keys",
        description: "Your keys were not persisted to the environment file.",
        variant: "destructive",
      });
      return false;
    }

    return true;
  }, [
    hotkey,
    agentName,
    permissionsHook.micPermissionGranted,
    permissionsHook.accessibilityPermissionGranted,
    setDictationKey,
    ensureHotkeyRegistered,
    toast,
  ]);

  const nextStep = useCallback(async () => {
    if (currentStep >= steps.length - 1) {
      return;
    }

    if (currentStep === 4) {
      setIsVerifyingHotkey(true);
      try {
        const hotkeyRegistered = await ensureHotkeyRegistered();
        if (!hotkeyRegistered) {
          return;
        }
      } finally {
        setIsVerifyingHotkey(false);
      }
    }

    const newStep = currentStep + 1;
    setCurrentStep(newStep);

    if (currentStep === 3 && newStep === 4) {
      if (window.electronAPI?.showDictationPanel) {
        try {
          await window.electronAPI.showDictationPanel();
        } catch (error) {
          console.error("Failed to show dictation panel:", error);
          toast({
            title: "Could not open dictation panel",
            description: "You can still continue setup and open it later.",
            variant: "destructive",
          });
        }
      }
    }
  }, [currentStep, ensureHotkeyRegistered, setCurrentStep, steps.length, toast]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      const newStep = currentStep - 1;
      setCurrentStep(newStep);
    }
  }, [currentStep, setCurrentStep]);

  const finishOnboarding = useCallback(async () => {
    try {
      const saved = await saveSettings();
      if (!saved) {
        return;
      }
      setOnboardingError(null);
      removeCurrentStep();
      onComplete();
    } catch (error) {
      console.error("Failed to finish onboarding:", error);
      setOnboardingError("Something went wrong. Please try again.");
    }
  }, [saveSettings, removeCurrentStep, onComplete]);

  const cleanupMicTestResources = useCallback(() => {
    if (micTestRafRef.current !== null) {
      window.cancelAnimationFrame(micTestRafRef.current);
      micTestRafRef.current = null;
    }

    if (micTestTimeoutRef.current) {
      window.clearTimeout(micTestTimeoutRef.current);
      micTestTimeoutRef.current = null;
    }

    if (micTestIntervalRef.current) {
      window.clearInterval(micTestIntervalRef.current);
      micTestIntervalRef.current = null;
    }

    micTestSourceRef.current?.disconnect();
    micTestSourceRef.current = null;

    micTestStreamRef.current?.getTracks().forEach((track) => track.stop());
    micTestStreamRef.current = null;

    const audioContext = micTestAudioContextRef.current;
    micTestAudioContextRef.current = null;
    if (audioContext) {
      void audioContext.close();
    }
  }, []);

  const handleMicTest = useCallback(async () => {
    cleanupMicTestResources();
    setMicTestError(null);
    setMicTestLevel(0);
    setMicTestCountdown(3);
    setMicTestState("recording");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micTestStreamRef.current = stream;

      const AudioContextCtor = window.AudioContext;
      if (!AudioContextCtor) {
        throw new Error("AudioContext is not available in this environment.");
      }
      const audioContext = new AudioContextCtor();
      micTestAudioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      micTestSourceRef.current = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const sampleBuffer = new Uint8Array(analyser.fftSize);

      const updateLevel = () => {
        analyser.getByteTimeDomainData(sampleBuffer);
        let sum = 0;
        for (let i = 0; i < sampleBuffer.length; i += 1) {
          const normalized = (sampleBuffer[i] - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / sampleBuffer.length);
        setMicTestLevel(Math.min(1, Math.max(0.08, rms * 6)));
        micTestRafRef.current = window.requestAnimationFrame(updateLevel);
      };

      updateLevel();

      micTestIntervalRef.current = window.setInterval(() => {
        setMicTestCountdown((previous) => {
          if (previous === null || previous <= 1) {
            return 1;
          }
          return previous - 1;
        });
      }, 1000);

      micTestTimeoutRef.current = window.setTimeout(() => {
        cleanupMicTestResources();
        setMicTestLevel(0);
        setMicTestCountdown(null);
        setMicTestState("success");
      }, 3000);
    } catch (error) {
      cleanupMicTestResources();
      setMicTestLevel(0);
      setMicTestCountdown(null);
      setMicTestState("error");
      setMicTestError(
        error instanceof Error
          ? error.message
          : "PrivateTranscribe couldn't access your microphone. Check system permissions and try again."
      );
    }
  }, [cleanupMicTestResources]);

  useEffect(() => {
    return () => {
      cleanupMicTestResources();
    };
  }, [cleanupMicTestResources]);

  useEffect(() => {
    if (!useLocalWhisper) {
      setSkippedModelSetup(false);
    }
  }, [useLocalWhisper]);

  const renderStep = () => {
    const cudaBinaryReady = !!(cudaStatus?.installed && cudaStatus.upToDate);

    switch (currentStep) {
      case 0: // Welcome
        return (
          <div className="text-center space-y-5">
            {/* App logo */}
            <div className="relative w-24 h-24 mx-auto">
              <div className="absolute inset-0 bg-primary/30 rounded-2xl blur-xl" />
              <img
                src={appIconSrc}
                alt="PrivateTranscribe"
                className="relative w-24 h-24 rounded-2xl shadow-lg object-contain"
              />
            </div>

            {/* Title */}
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground/60 mb-1">
                Step {currentStep + 1} of {steps.length}
              </p>
              <h2 className="text-xl font-semibold text-foreground tracking-tight">
                Welcome to PrivateTranscribe
              </h2>
              <p className="text-sm text-muted-foreground">Speak once, get clean text in any app</p>
            </div>

            {/* Feature grid - compact and refined */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-surface-1 border border-border-subtle">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Mic className="w-4 h-4 text-primary" />
                </div>
                <span className="text-xs font-medium text-foreground">Voice to Text</span>
                <span className="text-sm text-muted-foreground">Instant</span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-surface-1 border border-border-subtle">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Command className="w-4 h-4 text-primary" />
                </div>
                <span className="text-xs font-medium text-foreground">Works Anywhere</span>
                <span className="text-sm text-muted-foreground">Any app</span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-surface-1 border border-border-subtle">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Shield className="w-4 h-4 text-primary" />
                </div>
                <span className="text-xs font-medium text-foreground">Private</span>
                <span className="text-sm text-muted-foreground">Your choice</span>
              </div>
            </div>
          </div>
        );

      case 1: // Hardware Detection
        return (
          <HardwareSetupStep
            stepLabel={`Step ${currentStep + 1} of ${steps.length}`}
            onApplyRecommendations={(recommendations) => {
              updateTranscriptionSettings({
                useLocalWhisper: recommendations.useLocalWhisper,
                localTranscriptionProvider: recommendations.localTranscriptionProvider,
                whisperModel: recommendations.whisperModel,
                whisperForceCpu: recommendations.whisperForceCpu,
              });
              setOnboardingGpuSupported(recommendations.whisperForceCpu === false);
              setHardwareRecommendationsApplied(true);
            }}
            onAppliedChange={setHardwareRecommendationsApplied}
            showSkip={true}
          />
        );

      case 2: // Setup - Choose Mode & Configure
        const shouldShowCudaDownload =
          useLocalWhisper &&
          isModelDownloaded &&
          !whisperForceCpu &&
          cudaStatus?.supported &&
          !cudaBinaryReady;

        return (
          <div className="space-y-5">
            <div className="text-center space-y-0.5">
              <p className="text-xs text-muted-foreground/60 mb-1">
                Step {currentStep + 1} of {steps.length}
              </p>
              <h2 className="text-xl font-semibold text-foreground tracking-tight">
                Transcription Setup
              </h2>
              <p className="text-xs text-muted-foreground">Pick the fastest way to get started</p>
            </div>

            {/* Unified configuration with integrated mode toggle */}
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
              onLocalModelSelect={(modelId) =>
                updateTranscriptionSettings({ whisperModel: modelId })
              }
              selectedLocalProvider="whisper"
              onLocalProviderSelect={() =>
                updateTranscriptionSettings({
                  localTranscriptionProvider: "whisper",
                })
              }
              whisperForceCpu={whisperForceCpu}
              onWhisperForceCpuChange={setWhisperForceCpu}
              gpuSupported={onboardingGpuSupported}
              useLocalWhisper={useLocalWhisper}
              onModeChange={(isLocal) => updateTranscriptionSettings({ useLocalWhisper: isLocal })}
              openaiApiKey={openaiApiKey}
              setOpenaiApiKey={setOpenaiApiKey}
              groqApiKey={groqApiKey}
              setGroqApiKey={setGroqApiKey}
              customTranscriptionApiKey={customTranscriptionApiKey}
              setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
              cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
              setCloudTranscriptionBaseUrl={(url) =>
                updateTranscriptionSettings({ cloudTranscriptionBaseUrl: url })
              }
              onDownloadComplete={checkModelStatus}
              variant="onboarding"
            />
            {shouldShowCudaDownload && (
              <div className="rounded-lg border border-border-subtle bg-surface-1 overflow-hidden">
                <div className="p-3 border-b border-border-subtle">
                  <h3 className="text-sm font-medium text-foreground">GPU Engine</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Download the GPU engine (faster transcription) to keep acceleration enabled.
                  </p>
                </div>

                {cudaDownloadState === "downloading" && (
                  <DownloadProgressBar modelName="GPU Engine" progress={cudaDownloadProgress} />
                )}

                <div className="p-3 space-y-2">
                  {cudaDownloadState !== "downloading" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => void handleDownloadCuda()}
                    >
                      Download GPU Engine (652 MB)
                    </Button>
                  )}
                  {cudaDownloadState === "downloading" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => void handleCancelCudaDownload()}
                    >
                      Cancel Download
                    </Button>
                  )}
                  {cudaDownloadError && (
                    <p className="text-xs text-destructive">{cudaDownloadError}</p>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSkipCudaAndUseCpu}
                    className="h-8 px-4 text-xs w-full"
                  >
                    Skip — use your CPU
                  </Button>
                </div>
              </div>
            )}
            {useLocalWhisper &&
              isModelDownloaded &&
              !whisperForceCpu &&
              cudaStatus?.supported &&
              cudaBinaryReady &&
              cudaDownloadState !== "downloading" && (
                <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
                  ✓ GPU engine installed
                </div>
              )}
            {isLoadingStatus && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking setup status...
              </div>
            )}
            {useLocalWhisper && !isModelDownloaded && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSkippedModelSetup(true);
                    void nextStep();
                  }}
                  className="h-8 px-4 text-xs w-full"
                >
                  Skip for now — set up later
                </Button>
              </div>
            )}
          </div>
        );

      case 3: // Permissions
        const platform = permissionsHook.pasteToolsInfo?.platform;
        const isMacOS = platform === "darwin";

        return (
          <div className="space-y-5">
            {/* Header - compact */}
            <div className="text-center">
              <p className="text-xs text-muted-foreground/60 mb-1">
                Step {currentStep + 1} of {steps.length}
              </p>
              <h2 className="text-xl font-semibold text-foreground tracking-tight">Permissions</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isMacOS ? "Required for PrivateTranscribe to work" : "Microphone access required"}
              </p>
            </div>

            {/* Permission cards - tight stack */}
            <div className="space-y-1.5">
              <PermissionCard
                icon={Mic}
                title="Microphone"
                description="Needed so PrivateTranscribe can hear you."
                granted={permissionsHook.micPermissionGranted}
                onRequest={permissionsHook.requestMicPermission}
                buttonText="Allow"
              />

              {isMacOS && (
                <PermissionCard
                  icon={Shield}
                  title="Accessibility"
                  description="Needed to type text into other apps for you."
                  granted={permissionsHook.accessibilityPermissionGranted}
                  onRequest={permissionsHook.testAccessibilityPermission}
                  buttonText="Allow"
                  onOpenSettings={permissionsHook.openAccessibilitySettings}
                />
              )}
            </div>

            {/* Error state - only show when there's actually an issue */}
            {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
              <MicPermissionWarning
                error={permissionsHook.micPermissionError}
                onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
              />
            )}

            {/* Linux paste tools - only when needed */}
            {platform === "linux" &&
              permissionsHook.pasteToolsInfo &&
              !permissionsHook.pasteToolsInfo.available && (
                <PasteToolsInfo
                  pasteToolsInfo={permissionsHook.pasteToolsInfo}
                  isChecking={permissionsHook.isCheckingPasteTools}
                  onCheck={permissionsHook.checkPasteToolsAvailability}
                />
              )}
          </div>
        );

      case 4: // Hotkey & Activation Mode
        return (
          <div className="space-y-5">
            {/* Header */}
            <div className="text-center space-y-0.5">
              <p className="text-xs text-muted-foreground/60 mb-1">
                Step {currentStep + 1} of {steps.length}
              </p>
              <h2 className="text-xl font-semibold text-foreground tracking-tight">
                Start Dictation
              </h2>
              <p className="text-xs text-muted-foreground">Confirm your shortcut and try it</p>
            </div>

            {/* Unified control surface */}
            <div className="rounded-lg border border-border-subtle bg-surface-1 overflow-hidden">
              {/* Hotkey section */}
              <div className="p-4 border-b border-border-subtle">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Hotkey
                  </span>
                </div>
                <HotkeyInput
                  value={hotkey}
                  onChange={async (newHotkey) => {
                    await registerHotkeyWithRaceGuard(newHotkey);
                  }}
                  disabled={isHotkeyRegistering}
                  variant="hero"
                />
              </div>

              {/* Mode section - inline with hotkey */}
              {!isUsingGnomeHotkeys && (
                <div className="p-4 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Style
                    </span>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">
                      {activationMode === "tap"
                        ? "Press once to start, press again to stop"
                        : "Hold while speaking, release to transcribe"}
                    </p>
                  </div>
                  <ActivationModeSelector
                    value={activationMode}
                    onChange={setActivationMode}
                    variant="compact"
                  />
                </div>
              )}
            </div>

            {/* Test area - minimal chrome */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Test
                </span>
                <span className="text-xs text-muted-foreground/60">
                  {activationMode === "tap" || isUsingGnomeHotkeys
                    ? `${readableHotkey} to start/stop`
                    : `Hold ${readableHotkey}`}
                </span>
              </div>
              <Textarea
                rows={2}
                placeholder="Click here, then use your shortcut to test..."
                className="text-sm resize-none"
              />
            </div>
          </div>
        );

      case 5: {
        // Completion
        return (
          <div className="text-center space-y-5">
            <p className="text-xs text-muted-foreground/60 mb-1">
              Step {currentStep + 1} of {steps.length}
            </p>

            <div className="rounded-xl border border-border-subtle bg-surface-1 p-5 space-y-5">
              <div className="space-y-2">
                <div className="relative w-16 h-16 mx-auto">
                  <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl" />
                  <div className="relative w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
                    <Check className="w-7 h-7 text-primary" />
                  </div>
                </div>
                <h2 className="text-xl font-semibold text-foreground tracking-tight">
                  You&apos;re all set!
                </h2>
                <p className="text-xs text-muted-foreground">
                  {activationMode === "push" ? "Hold" : "Press"}{" "}
                  <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted/50 text-foreground font-mono text-xs">
                    {readableHotkey}
                  </kbd>{" "}
                  {activationMode === "push"
                    ? "while speaking, then release to transcribe."
                    : "to start dictating into any app."}
                </p>
                {useLocalWhisper && skippedModelSetup && (
                  <p className="text-xs text-muted-foreground">
                    Local model setup was skipped. You can configure it later in Settings.
                  </p>
                )}
              </div>

              <div className="space-y-3 text-left">
                <h3 className="text-sm font-medium">Test your microphone</h3>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleMicTest()}
                  disabled={micTestState === "recording"}
                  className="h-9 px-4"
                >
                  <Mic className="w-4 h-4" />
                  {micTestState === "recording"
                    ? `${micTestCountdown ?? 3}...`
                    : "Test your microphone"}
                </Button>

                <div className="flex items-center gap-1.5">
                  {Array.from({ length: 5 }, (_, index) => {
                    const activeBars = Math.ceil(micTestLevel * 5);
                    const isActive = index < activeBars;
                    return (
                      <div
                        key={index}
                        className={`h-2 w-2 rounded transition-colors duration-200 ${
                          isActive ? "bg-primary" : "bg-muted"
                        }`}
                      />
                    );
                  })}
                </div>

                {micTestState === "success" && (
                  <p className="text-sm text-primary font-medium">Microphone working! ✓</p>
                )}

                {micTestState === "error" && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-xs text-destructive">
                      {micTestError ||
                        "PrivateTranscribe couldn't access your microphone. Check permissions and try again."}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 text-xs"
                      onClick={() => void handleMicTest()}
                    >
                      Retry microphone test
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  We&apos;ll listen for 3 seconds to confirm your microphone is working.
                </p>
              </div>
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return true; // Welcome
      case 1:
        return hardwareRecommendationsApplied;
      case 2:
        // Setup - check if configuration is complete
        if (useLocalWhisper) {
          if (isLoadingStatus) {
            return false;
          }
          if (whisperModel === "") {
            return false;
          }
          if (!skippedModelSetup && !isModelDownloaded) {
            return false;
          }

          if (!skippedModelSetup && !whisperForceCpu) {
            if (!cudaStatus) {
              return false;
            }
            if (cudaStatus.supported && (!cudaStatus.installed || !cudaStatus.upToDate)) {
              return false;
            }
          }
          return true;
        } else {
          // For cloud mode, check if appropriate API key is set
          if (cloudTranscriptionProvider === "openai") {
            return openaiApiKey.trim().length > 0;
          } else if (cloudTranscriptionProvider === "groq") {
            return groqApiKey.trim().length > 0;
          } else if (cloudTranscriptionProvider === "custom") {
            return (
              cloudTranscriptionBaseUrl.trim().length > 0 &&
              cloudTranscriptionModel.trim().length > 0
            );
          }
          return openaiApiKey.trim().length > 0; // Default to OpenAI
        }
      case 3: {
        // Permissions
        if (!permissionsHook.micPermissionGranted) {
          return false;
        }
        const currentPlatform = permissionsHook.pasteToolsInfo?.platform;
        if (currentPlatform === "darwin") {
          return permissionsHook.accessibilityPermissionGranted;
        }
        return true;
      }
      case 4:
        return hotkey.trim() !== "" && !isHotkeyRegistering && !isVerifyingHotkey;
      case 5:
        return true; // Completion screen - always ready to finish
      default:
        return false;
    }
  };

  const canContinue = canProceed();
  const stepTwoProceedHint =
    currentStep === 2 && !canContinue
      ? !useLocalWhisper
        ? cloudTranscriptionProvider === "openai"
          ? "Paste your OpenAI API key to continue"
          : cloudTranscriptionProvider === "groq"
            ? "Paste your Groq API key to continue"
            : "Choose OpenAI or Groq to continue"
        : isLoadingStatus
          ? "Checking setup status..."
          : !skippedModelSetup && !isModelDownloaded
            ? "Download a model, or skip for now"
            : !skippedModelSetup &&
                !whisperForceCpu &&
                cudaStatus?.supported &&
                (!cudaStatus.installed || !cudaStatus.upToDate)
              ? "Download GPU engine, or switch to CPU mode"
              : "Select a setup option to continue"
      : null;

  return (
    <div
      className="h-screen flex flex-col bg-background"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
      }}
    >
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Title Bar */}
      <div className="flex-shrink-0 z-10">
        <TitleBar
          showTitle={true}
          className="bg-background backdrop-blur-xl border-b border-border shadow-sm"
        ></TitleBar>
      </div>

      {/* Progress Bar */}
      <div className="flex-shrink-0 bg-background/80 backdrop-blur-2xl border-b border-border-subtle px-6 md:px-12 py-4 z-10">
        <div className="max-w-3xl mx-auto">
          <StepProgress steps={steps} currentStep={currentStep} />
        </div>
      </div>

      {/* Content - This will grow to fill available space */}
      <div className="flex-1 px-6 md:px-12 py-6 overflow-y-auto">
        <div className="max-w-3xl mx-auto">
          <Card className="bg-card/80 backdrop-blur-2xl border border-border-subtle shadow-xl rounded-2xl overflow-hidden">
            <CardContent className="p-8 md:p-10">
              <div className="space-y-6">{renderStep()}</div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Bottom navigation */}
      <div className="flex-shrink-0 border-t border-border-subtle px-6 md:px-12 py-4 z-10">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <Button
            onClick={prevStep}
            variant="outline"
            disabled={currentStep === 0}
            className="h-10 px-5 rounded-xl text-sm font-medium"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Back
          </Button>

          <div className="flex flex-col items-end gap-2">
            {currentStep === steps.length - 1 ? (
              <>
                {onboardingError && (
                  <div className="w-full rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {onboardingError}
                  </div>
                )}
                <Button
                  onClick={finishOnboarding}
                  disabled={!canContinue}
                  className="h-10 px-6 rounded-xl text-sm font-medium"
                >
                  Start Dictating
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={nextStep}
                  disabled={!canContinue}
                  className="h-10 px-6 rounded-xl text-sm font-medium"
                >
                  {currentStep === 4 && isVerifyingHotkey ? "Checking..." : "Next"}
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
                {stepTwoProceedHint && (
                  <p className="text-xs text-muted-foreground">{stepTwoProceedHint}</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
