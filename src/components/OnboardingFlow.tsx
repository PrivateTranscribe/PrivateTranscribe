import React, { useState, useEffect, useCallback, useRef } from "react";
import { IconTile } from "./ui/IconTile";
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
import MicrophoneDeviceSelect from "./ui/MicrophoneDeviceSelect";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import StepProgress from "./ui/StepProgress";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSettings } from "../hooks/useSettings";
import { useParakeetSetup } from "../hooks/useParakeetSetup";
import { setAgentNameIfEmpty as saveAgentName } from "../utils/agentName";
import { formatHotkeyLabel, getDefaultHotkey } from "../utils/hotkeys";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { Toggle } from "./ui/toggle";
import { useToast } from "./ui/Toast";
import { trackAnalyticsEvent, trackAnalyticsEventOnce } from "../utils/analytics";
import { SectionLabel } from "./ui/SectionLabel";
import SpokenLanguagesSelector, { describeSpokenLanguages } from "./ui/SpokenLanguagesSelector";
import { getLanguageLabel } from "../utils/languages";
import { isWeakForNonEnglish, resolveRatingLanguage } from "../utils/modelAccuracy";
import { buildMicrophoneConstraints } from "../utils/audioDeviceUtils";
import {
  describeSlowCpuModel,
  isHeavyOnCpu,
  modelDisplayName,
  pickSetupWhisperModel,
} from "../utils/setupModelChoice";
import { describeDownloadError, describeGpuCheckFailure } from "../utils/gpuSetupMessages";
import type { HardwareDetectionResult } from "../types/electron";

/** What setup keeps from the hardware check, so a resumed setup still knows it. */
type SetupHardware = {
  gpuCategory: string;
  gpuName: string | null;
  vramMb: number | null;
  cpuThreads: number | null;
  detectorModel: string;
};

const toSetupHardware = (detection: HardwareDetectionResult): SetupHardware => ({
  gpuCategory: detection.recommendations?.gpuCategory ?? "cpu_only",
  gpuName: detection.gpu?.model?.trim() || null,
  vramMb: typeof detection.gpu?.vram === "number" ? detection.gpu.vram : null,
  cpuThreads: typeof detection.cpu?.count === "number" ? detection.cpu.count : null,
  detectorModel: detection.recommendations?.whisperModel || "base",
});

/** A failed hardware check: the processor defaults the hardware step applies. */
const UNKNOWN_HARDWARE: SetupHardware = {
  gpuCategory: "cpu_only",
  gpuName: null,
  vramMb: null,
  cpuThreads: null,
  detectorModel: "base",
};

type GpuCheck = {
  state: "idle" | "running" | "passed" | "failed";
  /** The model the check ran with; a different model needs a new check. */
  model?: string;
  message?: string;
};

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

  useEffect(() => {
    void trackAnalyticsEvent("onboarding_step_viewed", {
      step: currentStep + 1,
      step_count: steps.length,
    });
  }, [currentStep, steps.length]);

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    whisperForceCpu,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    preferredLanguage,
    spokenLanguages,
    setSpokenLanguages,
    openaiApiKey,
    groqApiKey,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    dictationKey,
    // Only read, so the hotkey field can refuse a key another feature owns.
    readAloudHotkey,
    voiceCallMuteKey,
    activationMode,
    setActivationMode,
    setDictationKey,
    setWhisperForceCpu,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
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
  const [hardware, setHardware] = useState<SetupHardware | null>(null);
  // An NVIDIA card the detector found usable with CUDA.
  const gpuDetected = hardware?.gpuCategory === "nvidia_cuda";
  const gpuName = hardware?.gpuName || "graphics card";
  // Set when the user picks a model other than the one setup recommends, so
  // setup stops re-picking for them as the language or engine changes.
  const [modelChosenByUser, setModelChosenByUser] = useState(false);
  const [gpuCheck, setGpuCheck] = useState<GpuCheck>({ state: "idle" });
  const engineCardRef = useRef<HTMLDivElement | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);
  const [autoStartError, setAutoStartError] = useState<string | null>(null);
  const platform = window.electronAPI?.getPlatform?.() ?? "unknown";
  const canConfigureAutoStart = platform !== "linux";
  const [isVerifyingHotkey, setIsVerifyingHotkey] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const { toast } = useToast();
  const readableHotkey = formatHotkeyLabel(hotkey);
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();

  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);
  const hotkeyRegistrationCounterRef = useRef(0);
  const pendingStatusChecksRef = useRef(0);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: () => {},
    showSuccessToast: false, // Don't show toast during onboarding auto-registration
    showErrorToast: false,
  });

  const parakeet = useParakeetSetup({
    spokenLanguages,
    localTranscriptionProvider,
    applyEngine: updateTranscriptionSettings,
  });
  const usingParakeet = useLocalWhisper && localTranscriptionProvider === "nvidia";
  // Parakeet needs its model and a passed speed test; Whisper needs its model.
  const localModelReady = usingParakeet ? parakeet.ready : isModelDownloaded;

  // Setup picks the engine until the user picks one by hand. Languages are
  // asked on this step, so the choice follows them as they change.
  const { fit: parakeetFit, fellBackToWhisper, engineChosenByUser } = parakeet;
  const { selectParakeet, selectWhisper } = parakeet;
  useEffect(() => {
    if (currentStep !== 2 || !useLocalWhisper || !parakeetFit) return;
    if (engineChosenByUser || fellBackToWhisper || parakeet.speedTest === "running") return;
    if (parakeetFit.qualifies && localTranscriptionProvider !== "nvidia") {
      void selectParakeet({ byUser: false });
    } else if (!parakeetFit.qualifies && localTranscriptionProvider === "nvidia") {
      selectWhisper({ byUser: false });
    }
  }, [
    currentStep,
    useLocalWhisper,
    parakeetFit,
    engineChosenByUser,
    fellBackToWhisper,
    parakeet.speedTest,
    localTranscriptionProvider,
    selectParakeet,
    selectWhisper,
  ]);

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

  useEffect(() => {
    if (!canConfigureAutoStart) {
      setAutoStartLoading(false);
      return;
    }

    let cancelled = false;
    const loadAutoStartStatus = async () => {
      setAutoStartLoading(true);
      setAutoStartError(null);

      try {
        const enabled = await window.electronAPI?.getAutoStartEnabled?.();
        if (!cancelled) {
          setAutoStartEnabled(Boolean(enabled));
        }
      } catch (error) {
        console.error("Failed to get auto-start status:", error);
        if (!cancelled) {
          setAutoStartError(
            "Couldn't read the startup setting. You can change it later in Settings."
          );
        }
      } finally {
        if (!cancelled) {
          setAutoStartLoading(false);
        }
      }
    };

    void loadAutoStartStatus();

    return () => {
      cancelled = true;
    };
  }, [canConfigureAutoStart]);

  const handleAutoStartChange = useCallback(async (enabled: boolean) => {
    setAutoStartLoading(true);
    setAutoStartError(null);

    try {
      const result = await window.electronAPI?.setAutoStartEnabled?.(enabled);
      // Follow the state the main process verified, not the requested one — a registry
      // write the OS rejected must show as off rather than silently claiming success.
      setAutoStartEnabled(result?.enabled ?? (result?.success ? enabled : !enabled));
      if (result?.success) {
        return;
      }

      setAutoStartError(
        result?.error || "Couldn't update startup. You can change it later in Settings."
      );
    } catch (error) {
      console.error("Failed to set auto-start:", error);
      setAutoStartError("Couldn't update startup. You can change it later in Settings.");
    } finally {
      setAutoStartLoading(false);
    }
  }, []);

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

  // The hardware step reports its detection as it runs. A setup resumed past
  // that step (the app closed mid-setup) reads the cached answer instead, or
  // it would forget the graphics card and offer only the processor.
  useEffect(() => {
    if (hardware) return;
    let cancelled = false;
    window.electronAPI
      ?.detectHardware?.()
      .then((result) => {
        if (cancelled) return;
        setHardware(
          result?.success && result.detection ? toSetupHardware(result.detection) : UNKNOWN_HARDWARE
        );
      })
      .catch(() => {
        if (!cancelled) setHardware(UNKNOWN_HARDWARE);
      });
    return () => {
      cancelled = true;
    };
  }, [hardware]);

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

  const cudaDownloadInFlightRef = useRef(false);
  const handleDownloadCuda = useCallback(async () => {
    // The main process joins a second request to the running download; this
    // only keeps one card from awaiting it twice.
    if (cudaDownloadInFlightRef.current) return;
    cudaDownloadInFlightRef.current = true;
    setCudaDownloadState("downloading");
    setCudaDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
    setCudaDownloadError(null);

    try {
      const result = await window.electronAPI?.downloadCudaBinary?.();
      if (!result?.success) {
        setCudaDownloadState("error");
        setCudaDownloadError(describeDownloadError(result?.error));
        return;
      }
      setCudaDownloadState("done");
      await loadCudaStatus();
    } catch (error) {
      setCudaDownloadState("error");
      setCudaDownloadError(describeDownloadError(error instanceof Error ? error.message : null));
    } finally {
      cudaDownloadInFlightRef.current = false;
    }
  }, [loadCudaStatus]);

  // A window reload during the download loses this state but not the
  // download, which the main process owns. Join it instead of offering another.
  const joinedActiveDownloadRef = useRef(false);
  useEffect(() => {
    if (joinedActiveDownloadRef.current) return;
    const active = (cudaStatus as { activeDownload?: unknown } | null)?.activeDownload;
    if (active && cudaDownloadState === "idle") {
      joinedActiveDownloadRef.current = true;
      void handleDownloadCuda();
    }
  }, [cudaStatus, cudaDownloadState, handleDownloadCuda]);

  // The awaiting handleDownloadCuda reports the cancel as its result, so the
  // card lands on "You cancelled the download" with a retry beside it.
  const handleCancelCudaDownload = useCallback(async () => {
    try {
      const result = await window.electronAPI?.cancelCudaBinaryDownload?.();
      if (result && !result.success) {
        throw new Error("CUDA download cancellation failed");
      }
    } catch (error) {
      console.error("Failed to cancel CUDA download:", error);
      setCudaDownloadError("Failed to cancel download. Please try again.");
    }
  }, []);

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

  const cudaBinaryReady = !!(cudaStatus?.installed && cudaStatus.upToDate);
  /**
   * Local Whisper on the GPU. Setup will not finish this way until the engine
   * is installed and a test run proved the card uses it, so a GPU PC can only
   * end up on the processor by the user's own choice.
   */
  const gpuWanted =
    useLocalWhisper &&
    !usingParakeet &&
    !skippedModelSetup &&
    !whisperForceCpu &&
    gpuDetected &&
    !!cudaStatus?.supported;
  const gpuReady =
    gpuWanted && cudaBinaryReady && gpuCheck.state === "passed" && gpuCheck.model === whisperModel;

  // Languages are asked on this step, after the hardware check, so the
  // recommended model is worked out here and follows the answer.
  const ratingLanguage = resolveRatingLanguage(preferredLanguage, spokenLanguages);
  const setupEngine = whisperForceCpu || !gpuDetected ? "cpu" : "gpu";
  const setupChoice = hardware
    ? pickSetupWhisperModel({
        engine: setupEngine,
        detectorModel: hardware.detectorModel,
        cpuThreads: hardware.cpuThreads,
        vramMb: hardware.vramMb,
        ratingLanguage,
      })
    : null;
  const recommendedModel = setupChoice?.model;

  useEffect(() => {
    if (currentStep !== 2 || !useLocalWhisper || usingParakeet || modelChosenByUser) return;
    if (!recommendedModel || whisperModel === recommendedModel) return;
    updateTranscriptionSettings({ whisperModel: recommendedModel });
  }, [
    currentStep,
    useLocalWhisper,
    usingParakeet,
    modelChosenByUser,
    recommendedModel,
    whisperModel,
    updateTranscriptionSettings,
  ]);

  const handleLocalModelSelect = useCallback(
    (modelId: string) => {
      if (modelId && modelId !== recommendedModel) setModelChosenByUser(true);
      updateTranscriptionSettings({ whisperModel: modelId });
    },
    [recommendedModel, updateTranscriptionSettings]
  );

  // The model's Download button fetches the engine too, in the same click.
  const handleModelDownloadStart = useCallback(() => {
    if (gpuWanted && !cudaBinaryReady && cudaDownloadState !== "downloading") {
      void handleDownloadCuda();
    }
  }, [gpuWanted, cudaBinaryReady, cudaDownloadState, handleDownloadCuda]);

  useEffect(() => {
    if (cudaDownloadState === "downloading" || cudaDownloadState === "error") {
      engineCardRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
  }, [cudaDownloadState]);

  /** Load the model on the GPU once, and read back what Whisper actually ran on. */
  const runGpuCheck = useCallback(async () => {
    const model = whisperModel;
    setGpuCheck({ state: "running", model });
    try {
      // Explicit, so a CPU setting still syncing from an earlier toggle cannot
      // make the check start the processor engine.
      await window.electronAPI?.setWhisperForceCpu?.(false);
      const start = await window.electronAPI?.whisperServerStart?.(model);
      const status = await window.electronAPI?.getCudaBinaryStatus?.();
      const engine = (status as { engineStatus?: Parameters<typeof describeGpuCheckFailure>[1] })
        ?.engineStatus;
      if (start?.success && engine?.effectiveEngine === "cuda") {
        setGpuCheck({ state: "passed", model });
        return;
      }
      setGpuCheck({ state: "failed", model, message: describeGpuCheckFailure(start, engine) });
    } catch (error) {
      setGpuCheck({
        state: "failed",
        model,
        message: describeGpuCheckFailure(
          { success: false, reason: error instanceof Error ? error.message : String(error) },
          null
        ),
      });
    }
  }, [whisperModel]);

  useEffect(() => {
    if (currentStep !== 2 || !gpuWanted || !isModelDownloaded || !cudaBinaryReady) return;
    if (gpuCheck.state === "running") return;
    if (gpuCheck.state !== "idle" && gpuCheck.model === whisperModel) return;
    void runGpuCheck();
  }, [
    currentStep,
    gpuWanted,
    isModelDownloaded,
    cudaBinaryReady,
    gpuCheck,
    whisperModel,
    runGpuCheck,
  ]);

  /** The user's own choice to run on the processor, with a model that suits it. */
  const handleUseProcessorInstead = useCallback(() => {
    if (cudaDownloadState === "downloading") void handleCancelCudaDownload();
    setWhisperForceCpu(true);
    setModelChosenByUser(false);
    setGpuCheck({ state: "idle" });
  }, [cudaDownloadState, handleCancelCudaDownload, setWhisperForceCpu]);

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
      void trackAnalyticsEventOnce("onboarding_completed", { step_count: steps.length });
      removeCurrentStep();
      onComplete();
    } catch (error) {
      console.error("Failed to finish onboarding:", error);
      setOnboardingError("Something went wrong. Please try again.");
    }
  }, [saveSettings, removeCurrentStep, onComplete, steps.length]);

  useEffect(() => {
    if (!useLocalWhisper) {
      setSkippedModelSetup(false);
    }
  }, [useLocalWhisper]);

  const renderStep = () => {
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
                <IconTile size="md">
                  <Mic className="w-4 h-4 text-primary" />
                </IconTile>
                <span className="text-xs font-medium text-foreground">Voice to Text</span>
                <span className="text-sm text-muted-foreground">Instant</span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-surface-1 border border-border-subtle">
                <IconTile size="md">
                  <Command className="w-4 h-4 text-primary" />
                </IconTile>
                <span className="text-xs font-medium text-foreground">Works Anywhere</span>
                <span className="text-sm text-muted-foreground">Any app</span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-surface-1 border border-border-subtle">
                <IconTile size="md">
                  <Shield className="w-4 h-4 text-primary" />
                </IconTile>
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
              // A fresh recommendation starts the model choice and the GPU
              // test over.
              setModelChosenByUser(false);
              setGpuCheck({ state: "idle" });
              setHardwareRecommendationsApplied(true);
            }}
            onAppliedChange={setHardwareRecommendationsApplied}
            onDetected={(detection) => setHardware(toSetupHardware(detection))}
            alreadyApplied={hardwareRecommendationsApplied}
            showSkip={true}
          />
        );

      case 2: {
        // Setup - Choose Mode & Configure
        const selectedLanguageLabel = getLanguageLabel(ratingLanguage || preferredLanguage);
        const showSmallModelLanguageWarning =
          useLocalWhisper && !usingParakeet && isWeakForNonEnglish(whisperModel, ratingLanguage);

        // Local Whisper on the processor: say which model and what it costs.
        const onProcessor =
          !!hardware && useLocalWhisper && !usingParakeet && setupEngine === "cpu";
        const processorNote = !onProcessor
          ? null
          : setupChoice && whisperModel === setupChoice.model
            ? { text: setupChoice.reason, slow: setupChoice.slowOnThisEngine }
            : isHeavyOnCpu(whisperModel)
              ? { text: describeSlowCpuModel(whisperModel), slow: true }
              : null;

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

            {/* Asked before the model, not after it. Setup never mentioned
                language at all, so every non-English user silently ran on
                auto-detect. It also has to come first because the answer
                changes which models are usable: on our Danish benchmark the
                small models fall apart while staying fine for English. */}
            <div
              className="rounded-lg border border-border-subtle bg-surface-1 p-3 space-y-2"
              data-testid="onboarding-language"
            >
              <SectionLabel>Which languages do you speak?</SectionLabel>
              <SpokenLanguagesSelector value={spokenLanguages} onChange={setSpokenLanguages} />
              {/* The same status line Settings uses, for the same reason: it
                  reads preferredLanguage rather than inferring the state from
                  the list, so it cannot describe detection that is not going
                  to happen. Onboarding then adds only what is specific to
                  setting this up for the first time. */}
              <p className="text-xs text-muted-foreground" data-testid="onboarding-language-hint">
                {describeSpokenLanguages(spokenLanguages, preferredLanguage)}
                {spokenLanguages.length === 1 && spokenLanguages[0] !== "en" && (
                  <>
                    {" "}
                    Accuracy outside English is lower on every model, so expect a few more
                    corrections.
                  </>
                )}
                {spokenLanguages.length > 1 && (
                  <>
                    {" "}
                    Use one language per dictation. Switching mid-sentence is not something the
                    speech engine can follow.
                  </>
                )}
              </p>

              {showSmallModelLanguageWarning && (
                <div
                  className="flex items-start gap-1.5 rounded-md border border-warning/25 bg-warning/8 px-3 py-2"
                  data-testid="onboarding-language-model-warning"
                >
                  <span className="text-warning text-xs leading-relaxed">
                    ⚠️ The smaller models drop off sharply outside English. On our Danish test, Base
                    got most words wrong while Turbo stayed usable. For {selectedLanguageLabel},
                    pick Turbo or Large if your machine can run them.
                  </span>
                </div>
              )}
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
              onLocalModelSelect={handleLocalModelSelect}
              onLocalModelDownloadStart={handleModelDownloadStart}
              selectedLocalProvider={localTranscriptionProvider}
              onLocalProviderSelect={(provider) =>
                updateTranscriptionSettings({ localTranscriptionProvider: provider })
              }
              spokenLanguages={spokenLanguages}
              whisperForceCpu={whisperForceCpu}
              onWhisperForceCpuChange={(forceCpu) => {
                setWhisperForceCpu(forceCpu);
                setModelChosenByUser(false);
                setGpuCheck({ state: "idle" });
              }}
              gpuSupported={gpuDetected}
              recommendedLocalModel={recommendedModel}
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
              preferredLanguage={ratingLanguage}
              variant="onboarding"
            />

            {processorNote && (
              <div
                className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                  processorNote.slow
                    ? "border-warning/25 bg-warning/8 text-warning"
                    : "border-border-subtle bg-surface-1 text-muted-foreground"
                }`}
                data-testid="onboarding-processor-note"
              >
                {processorNote.text}
              </div>
            )}

            {gpuWanted && (
              <div
                ref={engineCardRef}
                className={`rounded-lg border overflow-hidden ${
                  gpuReady ? "border-success/30 bg-success/5" : "border-border-subtle bg-surface-1"
                }`}
                data-testid="onboarding-gpu-engine"
              >
                <div className="p-3 space-y-1">
                  <h3 className="text-sm font-medium text-foreground">GPU engine</h3>
                  <p className="text-xs text-muted-foreground" data-testid="gpu-engine-status">
                    {gpuReady
                      ? `Dictation runs on your ${gpuName}.`
                      : cudaBinaryReady && gpuCheck.state === "running"
                        ? `Checking that your ${gpuName} runs Whisper ${modelDisplayName(whisperModel)}...`
                        : cudaBinaryReady && gpuCheck.state === "failed"
                          ? gpuCheck.message
                          : cudaBinaryReady
                            ? `Installed. It starts once Whisper ${modelDisplayName(whisperModel)} has downloaded.`
                            : cudaDownloadState === "downloading"
                              ? "Downloading together with your model. Setup continues when both are in."
                              : cudaDownloadState === "error"
                                ? cudaDownloadError || "The download stopped before it finished."
                                : isModelDownloaded
                                  ? `Your ${gpuName} runs Whisper many times faster than the processor. It needs the GPU engine, about 750 MB.`
                                  : `Your ${gpuName} runs Whisper many times faster than the processor. The GPU engine, about 750 MB, downloads together with the model.`}
                  </p>
                </div>

                {!cudaBinaryReady && cudaDownloadState === "downloading" && (
                  <DownloadProgressBar modelName="GPU engine" progress={cudaDownloadProgress} />
                )}

                {!gpuReady && (
                  <div className="p-3 pt-0 space-y-2">
                    {!cudaBinaryReady && cudaDownloadState === "downloading" && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={() => void handleCancelCudaDownload()}
                      >
                        Cancel download
                      </Button>
                    )}
                    {!cudaBinaryReady &&
                      (cudaDownloadState === "error" ||
                        (cudaDownloadState === "idle" && isModelDownloaded)) && (
                        <Button
                          type="button"
                          className="w-full"
                          onClick={() => void handleDownloadCuda()}
                        >
                          {cudaDownloadState === "error"
                            ? "Try the download again"
                            : "Download the GPU engine (about 750 MB)"}
                        </Button>
                      )}
                    {cudaBinaryReady && gpuCheck.state === "failed" && (
                      <Button type="button" className="w-full" onClick={() => void runGpuCheck()}>
                        Try the graphics card again
                      </Button>
                    )}
                    {(cudaDownloadState === "error" ||
                      (cudaBinaryReady && gpuCheck.state === "failed") ||
                      (!cudaBinaryReady && cudaDownloadState === "idle" && isModelDownloaded)) && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleUseProcessorInstead}
                        className="h-8 px-4 text-xs w-full"
                      >
                        Use the processor instead
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            {isLoadingStatus && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking setup status...
              </div>
            )}
            {useLocalWhisper && !localModelReady && (
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
                  Skip for now - set up later
                </Button>
              </div>
            )}
          </div>
        );
      }

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
                description="PrivateTranscribe keeps the microphone off until you press Allow."
                granted={permissionsHook.micPermissionGranted}
                onRequest={permissionsHook.requestMicPermission}
                buttonText="Allow"
              />
              {!isMacOS && (
                <p
                  className="px-1 text-xs text-muted-foreground leading-relaxed"
                  data-testid="onboarding-mic-windows-note"
                >
                  Windows does not ask desktop apps before they use the microphone, so
                  PrivateTranscribe asks here instead. While the microphone is in use, Windows shows
                  a microphone icon in the taskbar.
                </p>
              )}

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

            {/* Which microphone, decided here rather than after the first
                silent dictation. Re-enumerates once access is granted. */}
            <div className="space-y-2">
              <SectionLabel>Microphone</SectionLabel>
              <MicrophoneDeviceSelect
                preferBuiltInMic={preferBuiltInMic}
                selectedMicDeviceId={selectedMicDeviceId}
                reloadSignal={permissionsHook.micPermissionGranted}
                accessAllowed={permissionsHook.micAccessAllowed}
                onChange={(next) => {
                  setPreferBuiltInMic(next.preferBuiltInMic);
                  setSelectedMicDeviceId(next.selectedMicDeviceId);
                }}
              />
            </div>

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
                  <SectionLabel as="span">Hotkey</SectionLabel>
                </div>
                <HotkeyInput
                  value={hotkey}
                  onChange={async (newHotkey) => {
                    await registerHotkeyWithRaceGuard(newHotkey);
                  }}
                  disabled={isHotkeyRegistering}
                  variant="hero"
                  ariaLabel="Dictation hotkey"
                  conflicts={[
                    { label: "Read Aloud", hotkey: readAloudHotkey },
                    { label: "Mute my voice call", hotkey: voiceCallMuteKey },
                  ]}
                  onClear={() => {
                    void registerHotkeyWithRaceGuard(getDefaultHotkey());
                  }}
                />
              </div>

              {/* Mode section - inline with hotkey */}
              {!isUsingGnomeHotkeys && (
                <div className="p-4 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <SectionLabel as="span">Style</SectionLabel>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">
                      {activationMode === "tap"
                        ? "Press once to start, press again to stop"
                        : activationMode === "tapHold"
                          ? "Tap to toggle, or hold while speaking"
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

              {canConfigureAutoStart && (
                <div className="p-4 border-t border-border-subtle flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <SectionLabel as="span">Startup</SectionLabel>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">
                      Launch PrivateTranscribe automatically when you start your computer, so your
                      dictation hotkey works right away.
                    </p>
                    {autoStartError && (
                      <p className="text-xs text-destructive mt-1">{autoStartError}</p>
                    )}
                  </div>
                  <Toggle
                    checked={autoStartEnabled}
                    onChange={(checked: boolean) => void handleAutoStartChange(checked)}
                    disabled={autoStartLoading}
                  />
                </div>
              )}
            </div>

            {/* Test area - minimal chrome */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <SectionLabel as="span">Test</SectionLabel>
                <span className="text-xs text-muted-foreground/60">
                  {activationMode === "tap" || isUsingGnomeHotkeys
                    ? `${readableHotkey} to start/stop`
                    : activationMode === "tapHold"
                      ? `Tap or hold ${readableHotkey}`
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
                    : activationMode === "tapHold"
                      ? "to start dictating, or hold it while speaking."
                      : "to start dictating into any app."}
                </p>
                {useLocalWhisper && skippedModelSetup && (
                  <p className="text-xs text-muted-foreground">
                    Local model setup was skipped. You can configure it later on the Dictation page.
                  </p>
                )}
                {useLocalWhisper && !skippedModelSetup && !usingParakeet && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="onboarding-engine-summary"
                  >
                    {gpuReady
                      ? `Whisper ${modelDisplayName(whisperModel)} runs on your ${gpuName}.`
                      : `Whisper ${modelDisplayName(whisperModel)} runs on your processor.`}
                  </p>
                )}
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
          if (usingParakeet) {
            return skippedModelSetup || parakeet.ready;
          }
          if (whisperModel === "") {
            return false;
          }
          if (!skippedModelSetup && !isModelDownloaded) {
            return false;
          }
          // Until the hardware is known, a GPU PC cannot be told from one without.
          if (!skippedModelSetup && (!hardware || (!whisperForceCpu && !cudaStatus))) {
            return false;
          }
          // On a GPU PC setup ends on the GPU, proven by a test run, or on the
          // processor because the user chose it. Never on the processor by
          // default, which is how a large model ended up running there.
          if (gpuWanted && !gpuReady) {
            return false;
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
          : usingParakeet
            ? parakeet.speedTest === "running"
              ? "Testing Parakeet on this PC"
              : "Download Parakeet, or skip for now"
            : !skippedModelSetup && !isModelDownloaded
              ? gpuWanted && cudaDownloadState === "downloading"
                ? "Downloading the model and the GPU engine"
                : gpuWanted && !cudaBinaryReady
                  ? "Download a model. The GPU engine comes with it"
                  : "Download a model, or skip for now"
              : gpuWanted && !cudaBinaryReady
                ? cudaDownloadState === "downloading"
                  ? `Downloading the GPU engine, ${Math.round(cudaDownloadProgress.percentage)}%`
                  : "Download the GPU engine, or use the processor"
                : gpuWanted && gpuCheck.state === "failed"
                  ? "Your graphics card could not run the engine"
                  : gpuWanted && !gpuReady
                    ? "Checking your graphics card"
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
                  <div className="w-full rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
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
