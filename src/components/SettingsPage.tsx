import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { RefreshCw, Download, Upload, Mic, Shield, FolderOpen } from "lucide-react";
import MarkdownRenderer from "./ui/MarkdownRenderer";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useSettings } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { useAgentName } from "../utils/agentName";
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
import { LANGUAGE_OPTIONS, getLanguageLabel } from "../utils/languages";
import { isLanguageSupported } from "../utils/languageCompat";

export type SettingsSectionType =
  | "general"
  | "preferences"
  | "transcription"
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

// ── History limit input — free-type with inline confirm when lowering ──

function HistoryLimitInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [raw, setRaw] = React.useState(String(value));
  // Pending is set when the user tries to lower the limit — awaiting confirmation
  const [pending, setPending] = React.useState<number | null>(null);
  const [isConfirming, setIsConfirming] = React.useState(false);

  // Keep raw in sync when committed value changes externally
  React.useEffect(() => {
    if (pending === null) setRaw(String(value));
  }, [value, pending]);

  const commit = () => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0) {
      // Invalid — snap back
      setRaw(String(value));
      return;
    }
    if (parsed < value) {
      // User is lowering the limit — show warning instead of committing
      setPending(parsed);
    } else {
      // Same or higher — commit immediately, no cleanup needed
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
            {pending === 0 ? "all entries" : `the newest ${pending} item${pending === 1 ? "" : "s"}`}.
            Records deleted this way cannot be recovered.
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
          {trimError && (
            <p className="text-red-600 dark:text-red-400">{trimError}</p>
          )}
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
    parakeetModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl,
    customDictionary,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
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
    setLocalTranscriptionProvider,
    setParakeetModel,
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
    enableContextCapture,
    setEnableContextCapture,
    autoPaste,
    setAutoPaste,
    copyToClipboard,
    setCopyToClipboard,
    showPanelOnError,
    setShowPanelOnError,
    audioFeedback,
    setAudioFeedback,
    errorNotifications,
    setErrorNotifications,
    successConfirmation,
    setSuccessConfirmation,
  } = useSettings();

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isRemovingModels, setIsRemovingModels] = useState(false);

  const cachePathHint =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "%USERPROFILE%\\.cache\\Privoca\\whisper-models"
      : "~/.cache/Privoca/whisper-models";

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
          parakeetModel,
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
          // Preferences
          musicDuckingMode,
          musicDuckLevel,
          enableVariableSnapping,
          enableCorrectionLearning,
          enableContextCapture,
          // Behavior & Notifications
          autoPaste,
          copyToClipboard,
          showPanelOnError,
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
    [
      theme,
      historyLimit,
      dictationKey,
      activationMode,
      useLocalWhisper,
      localTranscriptionProvider,
      whisperModel,
      parakeetModel,
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
      enableContextCapture,
      autoPaste,
      copyToClipboard,
      showPanelOnError,
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
      a.download = `privoca-settings${includeApiKeys ? "-with-keys" : ""}.json`;
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
      if (s.activationMode === "tap" || s.activationMode === "push") setActivationMode(s.activationMode);

      updateTranscriptionSettings({
        useLocalWhisper: typeof s.useLocalWhisper === "boolean" ? s.useLocalWhisper : undefined,
        localTranscriptionProvider:
          s.localTranscriptionProvider === "nvidia" || s.localTranscriptionProvider === "whisper"
            ? s.localTranscriptionProvider
            : undefined,
        whisperModel: typeof s.whisperModel === "string" ? s.whisperModel : undefined,
        parakeetModel: typeof s.parakeetModel === "string" ? s.parakeetModel : undefined,
        preferredLanguage: typeof s.preferredLanguage === "string" ? s.preferredLanguage : undefined,
        translateToEnglish:
          s.translateToEnglish === "on" || s.translateToEnglish === "off"
            ? s.translateToEnglish
            : undefined,
        cloudTranscriptionProvider:
          typeof s.cloudTranscriptionProvider === "string" ? s.cloudTranscriptionProvider : undefined,
        cloudTranscriptionModel:
          typeof s.cloudTranscriptionModel === "string" ? s.cloudTranscriptionModel : undefined,
        cloudTranscriptionBaseUrl:
          typeof s.cloudTranscriptionBaseUrl === "string" ? s.cloudTranscriptionBaseUrl : undefined,
        customDictionary: Array.isArray(s.customDictionary) ? s.customDictionary : undefined,
      });

      updateReasoningSettings({
        useReasoningModel: typeof s.useReasoningModel === "boolean" ? s.useReasoningModel : undefined,
        reasoningProvider: typeof s.reasoningProvider === "string" ? s.reasoningProvider : undefined,
        reasoningModel: typeof s.reasoningModel === "string" ? s.reasoningModel : undefined,
        cloudReasoningBaseUrl:
          typeof s.cloudReasoningBaseUrl === "string" ? s.cloudReasoningBaseUrl : undefined,
      });

      if (s.musicDuckingMode === "off" || s.musicDuckingMode === "duck" || s.musicDuckingMode === "mute") {
        setMusicDuckingMode(s.musicDuckingMode);
      }
      if (typeof s.musicDuckLevel === "number") setMusicDuckLevel(s.musicDuckLevel);
      if (typeof s.enableVariableSnapping === "boolean") setEnableVariableSnapping(s.enableVariableSnapping);
      if (typeof s.enableCorrectionLearning === "boolean") setEnableCorrectionLearning(s.enableCorrectionLearning);
      if (typeof s.enableContextCapture === "boolean") setEnableContextCapture(s.enableContextCapture);
      if (typeof s.autoPaste === "boolean") setAutoPaste(s.autoPaste);
      if (typeof s.copyToClipboard === "boolean") setCopyToClipboard(s.copyToClipboard);
      if (typeof s.showPanelOnError === "boolean") setShowPanelOnError(s.showPanelOnError);
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
      setEnableContextCapture,
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
   * Derived warning: shown when the active local provider is Parakeet and the
   * user's chosen language is outside its supported set. Computed in the
   * renderer so it reacts instantly to changes in any of the three values.
   */
  const languageCompatWarning = useMemo(() => {
    if (!useLocalWhisper || localTranscriptionProvider !== "nvidia") return null;
    const lang = preferredLanguage || "auto";
    if (lang === "auto") return null;
    if (isLanguageSupported(lang, "parakeet", parakeetModel)) return null;
    return `"${getLanguageLabel(lang)}" is not supported by Parakeet. Auto-detect will be used instead.`;
  }, [useLocalWhisper, localTranscriptionProvider, parakeetModel, preferredLanguage]);

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
            "Privoca didn't restart automatically. Please quit the app manually to finish installing the update.",
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
    const message = `To fix accessibility permissions:\n\n1. Open System Settings > Privacy & Security > Accessibility\n2. Remove any old Privoca or Electron entries\n3. Click (+) and add the current Privoca app\n4. Make sure the checkbox is enabled\n5. Restart Privoca\n\nClick OK to open System Settings.`;

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

            window.dispatchEvent(new Event("Privoca-models-cleared"));

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
      // GENERAL — Updates, Hotkey, Startup, Mic
      // ───────────────────────────────────────────────────
      case "general":
        return (
          <div className="space-y-8">
            {/* Updates */}
            <div>
              <SectionHeader
                title="Updates"
                description="Keep Privoca up to date with the latest features and improvements"
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
                      label="Launch at login"
                      description="Start Privoca automatically when you log in"
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
                    description="The language you primarily speak. Helps the engine recognize your speech more accurately."
                  >
                    <select
                      value={preferredLanguage || "auto"}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPreferredLanguage(val);
                        // Auto-disable translation if switching to English or auto
                        if (val === "en" || val === "auto") {
                          setTranslateToEnglish("off");
                        }
                      }}
                      className="h-9 px-3 rounded-lg bg-surface-raised border border-border-subtle text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
                    >
                      {LANGUAGE_OPTIONS.map((lang) => (
                        <option key={lang.value} value={lang.value}>
                          {lang.label}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>

                  {/* Show translate toggle only when speaking a non-English language */}
                  {preferredLanguage && preferredLanguage !== "auto" && preferredLanguage !== "en" && (
                    <SettingsRow
                      label="Translate to English"
                      description="Automatically translate your speech into English text"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setTranslateToEnglish(translateToEnglish === "on" ? "off" : "on")
                        }
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          translateToEnglish === "on"
                            ? "bg-primary"
                            : "bg-surface-raised border border-border-subtle"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            translateToEnglish === "on" ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </SettingsRow>
                  )}

                  {languageCompatWarning && (
                    <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <span aria-hidden="true" className="mt-px shrink-0">⚠</span>
                      {languageCompatWarning}
                    </p>
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
                    description="Learn from manual edits (currently detected via clipboard changes after dictation)"
                  >
                    <Toggle
                      checked={enableCorrectionLearning}
                      onChange={(checked: boolean) => setEnableCorrectionLearning(checked)}
                    />
                  </SettingsRow>
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
                      description={`System audio is reduced to ${Math.round(musicDuckLevel * 100)}% while your microphone is active`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={5}
                          max={80}
                          step={5}
                          value={Math.round(musicDuckLevel * 100)}
                          onChange={(e) =>
                            setMusicDuckLevel(parseInt(e.target.value, 10) / 100)
                          }
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
              </SettingsPanel>
            </div>

            {/* Behavior */}
            <div>
              <SectionHeader
                title="Behavior"
                description="Customize how Privoca responds after transcription"
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
                    label="Context capture"
                    description="Include frontmost app/window context to improve accuracy (beta). Captures app + window title (and on Windows, best-effort focused text) — always sanitized and kept local."
                  >
                    <Toggle checked={enableContextCapture} onChange={setEnableContextCapture} />
                  </SettingsRow>
                </SettingsPanelRow>
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
                localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel
              }
              onLocalModelSelect={(modelId) => {
                if (localTranscriptionProvider === "nvidia") {
                  setParakeetModel(modelId);
                } else {
                  setWhisperModel(modelId);
                }
              }}
              selectedLocalProvider={localTranscriptionProvider}
              onLocalProviderSelect={setLocalTranscriptionProvider}
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
                      description="Fix issues after reinstalling or rebuilding the app by removing and re-adding Privoca in System Settings"
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
      case "help":
        return (
          <div className="space-y-6">
            <SectionHeader
              title="Help & Support"
              description="Get assistance with Privoca and report issues"
            />

            <SettingsPanel>
              <SettingsPanelRow>
                <SettingsRow
                  label="Contact Support"
                  description="Send an email to our support team for assistance"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const result = await window.electronAPI?.openExternal("mailto:support@Privoca.com");
                        if (!result?.success) {
                          // Fallback: try opening the email as a web URL
                          await window.electronAPI?.openExternal(
                            "https://mail.google.com/mail/?view=cm&to=support@Privoca.com"
                          );
                        }
                      } catch (error) {
                        console.error("Error opening email client:", error);
                      }
                    }}
                  >
                    Email Support
                  </Button>
                </SettingsRow>
              </SettingsPanelRow>

              <SettingsPanelRow>
                <SettingsRow
                  label="Submit Bug Report"
                  description="Report issues or suggest improvements on GitHub"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await window.electronAPI?.openExternal(
                          "https://github.com/Privoca/Privoca/issues"
                        );
                      } catch (error) {
                        console.error("Error opening GitHub issues:", error);
                      }
                    }}
                  >
                    Open GitHub Issues
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
                        : "Installed version of Privoca"
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

      // ───────────────────────────────────────────────────
      // PRO
      // ───────────────────────────────────────────────────
      case "pro":
        return (
          <div className="space-y-8">
            <SectionHeader
              title="Privoca Pro"
              description="Unlock advanced features with a one-time license"
            />

            {/* License key entry */}
            <SettingsPanel>
              <SettingsPanelRow>
                <SettingsRow
                  label="License key"
                  description="Enter your Privoca Pro license key to unlock all features"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="XXXX-XXXX-XXXX-XXXX"
                      className="h-9 px-3 rounded-lg bg-surface-raised border border-border-subtle text-sm text-foreground font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all w-56"
                      disabled
                    />
                    <Button variant="default" size="sm" disabled>
                      Activate
                    </Button>
                  </div>
                </SettingsRow>
              </SettingsPanelRow>
            </SettingsPanel>

            {/* Pro features overview */}
            <div>
              <SectionHeader
                title="What's included"
                description="Features unlocked with Privoca Pro"
              />
              <div className="space-y-3 mt-4">
                {[
                  {
                    name: "Correction Memory",
                    desc: "Learns from your edits and automatically corrects recurring transcription errors",
                    available: true,
                  },
                  {
                    name: "Smart Context (IDE Bridge)",
                    desc: "Integrates with Cursor and VS Code for context-aware dictation while coding",
                    available: false,
                  },
                  {
                    name: "Action Engine",
                    desc: "Trigger commands, shortcuts, and workflows with voice",
                    available: false,
                  },
                ].map((feature) => (
                  <div
                    key={feature.name}
                    className="flex items-center gap-3 rounded-lg border border-border-subtle bg-background/40 px-4 py-3"
                  >
                    <div
                      className={`shrink-0 h-2 w-2 rounded-full ${
                        feature.available ? "bg-green-500" : "bg-muted-foreground/30"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-foreground">{feature.name}</span>
                      <p className="text-xs text-muted-foreground">{feature.desc}</p>
                    </div>
                    <span
                      className={`text-[10px] font-medium px-2 py-0.5 rounded ${
                        feature.available
                          ? "bg-green-500/10 text-green-500"
                          : "bg-muted-foreground/10 text-muted-foreground"
                      }`}
                    >
                      {feature.available ? "Ready" : "In development"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Pricing info */}
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-2">
              <p className="text-sm font-medium text-foreground">One-time purchase — no subscription</p>
              <p className="text-xs text-muted-foreground">
                Privoca Pro is a single payment that unlocks all current and future Pro features.
                No recurring fees, no expiry.
              </p>
            </div>
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

            <DeveloperSection />

            {/* Data Management — moved from General */}
            <div className="border-t border-border/30 pt-8">
              <SectionHeader
                title="Data & Storage"
                description="Manage cached files, models, and application data"
              />

              <div className="space-y-4">
                {/* Settings export/import */}
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label="Export / Import settings"
                      description="Move your preferences between machines. API keys are excluded by default."
                    >
                      <div className="flex flex-col items-end gap-2">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
                          <input
                            type="checkbox"
                            checked={includeApiKeysInExport}
                            onChange={(e) => setIncludeApiKeysInExport(e.target.checked)}
                          />
                          Include API keys in export
                        </label>

                        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
                          <input
                            type="checkbox"
                            checked={allowApiKeysOnImport}
                            onChange={(e) => setAllowApiKeysOnImport(e.target.checked)}
                          />
                          Allow importing API keys
                        </label>

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
                                description:
                                  "This will overwrite your current settings. Proceed?",
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
                                    // reset input so selecting the same file again triggers onChange
                                    if (importFileInputRef.current) importFileInputRef.current.value = "";
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
                              "This will permanently delete ALL Privoca data including:\n\n- Database and transcriptions\n- Local storage settings\n- Downloaded models\n- Environment files\n\nYou will need to manually remove app permissions in System Settings.\n\nThis action cannot be undone.",
                            onConfirm: () => {
                              window.electronAPI
                                ?.cleanupApp()
                                .then(() => {
                                  showAlertDialog({
                                    title: "Reset Complete",
                                    description:
                                      "All app data has been removed. The app will reload.",
                                  });
                                  setTimeout(() => {
                                    window.location.reload();
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
        onOk={() => { }}
      />

      {renderSectionContent()}
    </>
  );
}
