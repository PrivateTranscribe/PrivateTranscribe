import React, { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Settings,
  Mic,
  Shield,
  Command,
  Sparkles,
  Cpu,
  ArrowRight,
} from "lucide-react";
import TitleBar from "./TitleBar";
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

interface OnboardingFlowProps {
  onComplete: () => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  // Max valid step index for the current onboarding flow (6 steps, index 0-5)
  const MAX_STEP = 5;

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
    localTranscriptionProvider,
    parakeetModel,
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
    setOpenaiApiKey,
    setGroqApiKey,
    updateTranscriptionSettings,
  } = useSettings();

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const agentName = "PrivateTranscribe"; // Default agent name, editable in settings
  const [isModelDownloaded, setIsModelDownloaded] = useState(false);
  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);
  const [isVerifyingHotkey, setIsVerifyingHotkey] = useState(false);
  const [hardwareRecommendationsApplied, setHardwareRecommendationsApplied] = useState(false);
  const readableHotkey = formatHotkeyLabel(hotkey);
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();

  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setHotkey(registeredHotkey);
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false, // Don't show toast during onboarding auto-registration
    showErrorToast: false,
  });

  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog); // Initialize clipboard hook for permission checks

  const steps = [
    { title: "Welcome", icon: Sparkles },
    { title: "Hardware", icon: Cpu },
    { title: "Setup", icon: Settings },
    { title: "Permissions", icon: Shield },
    { title: "Activation", icon: Command },
    { title: "Complete", icon: Check },
  ];

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
    const modelToCheck = localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
    if (!useLocalWhisper || !modelToCheck) {
      setIsModelDownloaded(false);
      return;
    }

    const checkStatus = async () => {
      try {
        const result =
          localTranscriptionProvider === "nvidia"
            ? await window.electronAPI?.checkParakeetModelStatus(modelToCheck)
            : await window.electronAPI?.checkModelStatus(modelToCheck);
        setIsModelDownloaded(result?.downloaded ?? false);
      } catch (error) {
        console.error("Failed to check model status:", error);
        setIsModelDownloaded(false);
      }
    };

    checkStatus();
  }, [useLocalWhisper, whisperModel, parakeetModel, localTranscriptionProvider]);

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
          const success = await registerHotkey(defaultHotkey);
          if (success) {
            setHotkey(defaultHotkey);
          }
        }
      } catch (error) {
        console.error("Failed to auto-register default hotkey:", error);
      } finally {
        autoRegisterInFlightRef.current = false;
      }
    };

    void autoRegisterDefaultHotkey();
  }, [currentStep, hotkey, registerHotkey]);

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
      await window.electronAPI?.saveAllKeysToEnv?.();
    } catch (error) {
      console.error("Failed to persist API keys:", error);
    }

    return true;
  }, [
    hotkey,
    agentName,
    permissionsHook.micPermissionGranted,
    permissionsHook.accessibilityPermissionGranted,
    setDictationKey,
    ensureHotkeyRegistered,
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
        window.electronAPI.showDictationPanel();
      }
    }
  }, [currentStep, ensureHotkeyRegistered, setCurrentStep, steps.length]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      const newStep = currentStep - 1;
      setCurrentStep(newStep);
    }
  }, [currentStep, setCurrentStep]);

  const finishOnboarding = useCallback(async () => {
    const saved = await saveSettings();
    if (!saved) {
      return;
    }
    removeCurrentStep();
    onComplete();
  }, [saveSettings, removeCurrentStep, onComplete]);

  const renderStep = () => {
    switch (currentStep) {
      case 0: // Welcome
        return (
          <div className="text-center space-y-5">
            {/* App logo */}
            <div className="relative w-16 h-16 mx-auto">
              <div className="absolute inset-0 bg-primary/30 rounded-2xl blur-xl" />
              <img
                src="./assets/icon.png"
                alt="PrivateTranscribe"
                className="relative w-16 h-16 rounded-2xl shadow-lg"
              />
            </div>

            {/* Title */}
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-foreground tracking-tight">
                Welcome to PrivateTranscribe
              </h2>
              <p className="text-sm text-muted-foreground">
                Professional voice-to-text for your computer
              </p>
            </div>

            {/* Feature grid - compact and refined */}
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-surface-1 border border-border-subtle">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Mic className="w-4 h-4 text-primary" />
                </div>
                <span className="text-xs font-medium text-foreground">Voice to Text</span>
                <span className="text-[10px] text-muted-foreground">Instant</span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-surface-1 border border-border-subtle">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Command className="w-4 h-4 text-primary" />
                </div>
                <span className="text-xs font-medium text-foreground">Works Anywhere</span>
                <span className="text-[10px] text-muted-foreground">Any app</span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-surface-1 border border-border-subtle">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Shield className="w-4 h-4 text-primary" />
                </div>
                <span className="text-xs font-medium text-foreground">Private</span>
                <span className="text-[10px] text-muted-foreground">Your choice</span>
              </div>
            </div>
          </div>
        );

      case 1: // Hardware Detection
        return (
          <HardwareSetupStep
            onApplyRecommendations={(recommendations) => {
              updateTranscriptionSettings({
                useLocalWhisper: recommendations.useLocalWhisper,
                localTranscriptionProvider: recommendations.localTranscriptionProvider,
                whisperModel: recommendations.whisperModel,
                parakeetModel: recommendations.parakeetModel,
              });
              setHardwareRecommendationsApplied(true);
            }}
            onNext={() => nextStep()}
            onSkip={() => nextStep()}
            showSkip={true}
          />
        );

      case 2: // Setup - Choose Mode & Configure
        return (
          <div className="space-y-3">
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                Transcription Setup
              </h2>
              <p className="text-xs text-muted-foreground">Choose your mode and provider</p>
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
              selectedLocalModel={
                localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel
              }
              onLocalModelSelect={(modelId) => {
                if (localTranscriptionProvider === "nvidia") {
                  updateTranscriptionSettings({ parakeetModel: modelId });
                } else {
                  updateTranscriptionSettings({ whisperModel: modelId });
                }
              }}
              selectedLocalProvider={localTranscriptionProvider}
              onLocalProviderSelect={(provider) =>
                updateTranscriptionSettings({
                  localTranscriptionProvider: provider as "whisper" | "nvidia",
                })
              }
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
              variant="onboarding"
            />
          </div>
        );

      case 3: // Permissions
        const platform = permissionsHook.pasteToolsInfo?.platform;
        const isMacOS = platform === "darwin";

        return (
          <div className="space-y-4">
            {/* Header - compact */}
            <div className="text-center">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">Permissions</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isMacOS ? "Required for PrivateTranscribe to work" : "Microphone access required"}
              </p>
            </div>

            {/* Permission cards - tight stack */}
            <div className="space-y-1.5">
              <PermissionCard
                icon={Mic}
                title="Microphone"
                description="To capture your voice"
                granted={permissionsHook.micPermissionGranted}
                onRequest={permissionsHook.requestMicPermission}
                buttonText="Grant"
              />

              {isMacOS && (
                <PermissionCard
                  icon={Shield}
                  title="Accessibility"
                  description="To paste text into apps"
                  granted={permissionsHook.accessibilityPermissionGranted}
                  onRequest={permissionsHook.testAccessibilityPermission}
                  buttonText="Test & Grant"
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
          <div className="space-y-4">
            {/* Header */}
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                Activation Setup
              </h2>
              <p className="text-xs text-muted-foreground">Configure how you trigger dictation</p>
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
                    const success = await registerHotkey(newHotkey);
                    if (success) {
                      setHotkey(newHotkey);
                    }
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
                      Mode
                    </span>
                    <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                      {activationMode === "tap"
                        ? "Press to start/stop"
                        : "Hold while speaking (recommended)"}
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
                <span className="text-[10px] text-muted-foreground/60">
                  {activationMode === "tap" || isUsingGnomeHotkeys
                    ? `${readableHotkey} to start/stop`
                    : `Hold ${readableHotkey}`}
                </span>
              </div>
              <Textarea
                rows={2}
                placeholder="Click here and use your hotkey to dictate..."
                className="text-sm resize-none"
              />
            </div>
          </div>
        );

      case 5: // Completion
        return (
          <div className="text-center space-y-6">
            {/* Success mark */}
            <div className="relative w-16 h-16 mx-auto">
              <div className="absolute inset-0 bg-green-500/20 rounded-full blur-xl" />
              <div className="relative w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center">
                <Check className="w-7 h-7 text-green-500" />
              </div>
            </div>

            {/* Heading */}
            <div className="space-y-1.5">
              <h2 className="text-xl font-semibold text-foreground tracking-tight">
                Setup complete.
              </h2>
              <p className="text-sm text-muted-foreground">
                {activationMode === "push" ? "Hold" : "Press"}{" "}
                <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted/50 text-foreground font-mono text-[11px]">
                  {readableHotkey}
                </kbd>{" "}
                {activationMode === "push"
                  ? "while speaking, then release to transcribe."
                  : "to start dictating into any app."}
              </p>
            </div>

            {/* Next Steps */}
            <div className="text-left rounded-xl border border-border-subtle bg-surface-1 p-5 shadow-sm space-y-4">
              <p className="text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" /> How it works
              </p>

              <div className="space-y-4">
                <div className="flex items-start gap-3.5">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5 border border-primary/20 shadow-sm">
                    <span className="text-xs font-bold text-primary">1</span>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      Place your cursor, then press{" "}
                      <kbd className="px-2 py-0.5 mx-0.5 rounded-md border border-border bg-muted/50 text-foreground font-mono text-[11px] shadow-sm">
                        {readableHotkey}
                      </kbd>
                    </p>
                    <p className="text-xs text-muted-foreground/90 leading-relaxed">
                      Works in any text field - browser, code editor, chat app. This dashboard
                      closes to the system tray and stays out of your way.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3.5">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5 border border-primary/20 shadow-sm">
                    <span className="text-xs font-bold text-primary">2</span>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      {activationMode === "push"
                        ? "Hold and speak - release to transcribe"
                        : "Speak, then press the hotkey again to transcribe"}
                    </p>
                    <p className="text-xs text-muted-foreground/90 leading-relaxed">
                      {activationMode === "push"
                        ? "A small overlay confirms the mic is live. Release the key and your words appear instantly."
                        : "A small overlay confirms the mic is live. Press the hotkey a second time and your words appear instantly."}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3.5">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5 border border-primary/20 shadow-sm">
                    <span className="text-xs font-bold text-primary">3</span>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      Return anytime via system tray
                    </p>
                    <p className="text-xs text-muted-foreground/90 leading-relaxed">
                      Click the PrivateTranscribe icon in your system tray to reopen this dashboard,
                      change models, or adjust settings.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return true; // Welcome
      case 1:
        // Hardware detection - always can proceed (recommendations are optional)
        return true;
      case 2:
        // Setup - check if configuration is complete
        if (useLocalWhisper) {
          const modelToCheck =
            localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
          return modelToCheck !== "" && isModelDownloaded;
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

      {/* Footer - This will stick to the bottom */}
      <div className="flex-shrink-0 bg-background/80 backdrop-blur-2xl border-t border-border-subtle px-6 md:px-12 py-3 z-10">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Button
            onClick={prevStep}
            variant="outline"
            disabled={currentStep === 0}
            className="h-8 px-5 rounded-full text-xs"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Back
          </Button>

          <div className="flex items-center gap-2">
            {currentStep === steps.length - 1 ? (
              <Button
                onClick={finishOnboarding}
                disabled={!canProceed()}
                variant="success"
                className="h-8 px-6 rounded-full text-xs"
              >
                Start Dictating
                <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <Button
                onClick={nextStep}
                disabled={!canProceed()}
                className="h-8 px-6 rounded-full text-xs"
              >
                {currentStep === 4 && isVerifyingHotkey ? "Checking..." : "Next"}
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
