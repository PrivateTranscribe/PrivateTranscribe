import { useCallback, useEffect, useRef } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { useDebouncedCallback } from "./useDebouncedCallback";
import { API_ENDPOINTS } from "../config/constants";
import ReasoningService from "../services/ReasoningService";
import type { LocalTranscriptionProvider } from "../types/electron";

export interface TranscriptionSettings {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  translateToEnglish: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl?: string;
  customDictionary: string[];
}

export interface ReasoningSettings {
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;
  cloudReasoningBaseUrl?: string;
}

export interface HotkeySettings {
  dictationKey: string;
  activationMode: "tap" | "push";
}

export interface MicrophoneSettings {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
}

export interface ApiKeySettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  customTranscriptionApiKey: string;
  customReasoningApiKey: string;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

export interface BehaviorSettings {
  autoPaste: boolean;
  copyToClipboard: boolean;
  showPanelOnError: boolean;
  audioFeedback: boolean;
  errorNotifications: boolean;
  successConfirmation: boolean;
}

export function useSettings() {
  const [useLocalWhisper, setUseLocalWhisper] = useLocalStorage("useLocalWhisper", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [whisperModel, setWhisperModel] = useLocalStorage("whisperModel", "base", {
    serialize: String,
    deserialize: String,
  });

  const [localTranscriptionProvider, setLocalTranscriptionProvider] =
    useLocalStorage<LocalTranscriptionProvider>("localTranscriptionProvider", "whisper", {
      serialize: String,
      deserialize: (value) => (value === "nvidia" ? "nvidia" : "whisper"),
    });

  const [parakeetModel, setParakeetModel] = useLocalStorage("parakeetModel", "", {
    serialize: String,
    deserialize: String,
  });

  const [allowOpenAIFallback, setAllowOpenAIFallback] = useLocalStorage(
    "allowOpenAIFallback",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  const [allowLocalFallback, setAllowLocalFallback] = useLocalStorage("allowLocalFallback", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [fallbackWhisperModel, setFallbackWhisperModel] = useLocalStorage(
    "fallbackWhisperModel",
    "base",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [preferredLanguage, setPreferredLanguage] = useLocalStorage("preferredLanguage", "en", {
    serialize: String,
    deserialize: String,
  });

  const [translateToEnglish, setTranslateToEnglish] = useLocalStorage(
    "translateToEnglish",
    "off",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudTranscriptionProvider, setCloudTranscriptionProvider] = useLocalStorage(
    "cloudTranscriptionProvider",
    "openai",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudTranscriptionModel, setCloudTranscriptionModel] = useLocalStorage(
    "cloudTranscriptionModel",
    "gpt-4o-mini-transcribe",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudTranscriptionBaseUrl, setCloudTranscriptionBaseUrl] = useLocalStorage(
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE,
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudReasoningBaseUrl, setCloudReasoningBaseUrl] = useLocalStorage(
    "cloudReasoningBaseUrl",
    API_ENDPOINTS.OPENAI_BASE,
    {
      serialize: String,
      deserialize: String,
    }
  );

  // Custom dictionary for improving transcription of specific words
  const [customDictionary, setCustomDictionaryRaw] = useLocalStorage<string[]>(
    "customDictionary",
    ["Privoca"],
    {
      serialize: JSON.stringify,
      deserialize: (value) => {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      },
    }
  );

  // Wrap setter to sync dictionary to SQLite
  const setCustomDictionary = useCallback(
    (words: string[]) => {
      setCustomDictionaryRaw(words);
      window.electronAPI?.setDictionary(words).catch(() => {
        // Silently ignore SQLite sync errors
      });
    },
    [setCustomDictionaryRaw]
  );

  // One-time sync: reconcile localStorage ↔ SQLite on startup, ensure Privoca is included
  const hasRunDictionarySync = useRef(false);
  useEffect(() => {
    if (hasRunDictionarySync.current) return;
    hasRunDictionarySync.current = true;

    const syncDictionary = async () => {
      if (typeof window === "undefined" || !window.electronAPI?.getDictionary) return;
      try {
        // Ensure "Privoca" is always in the dictionary
        if (!customDictionary.includes("Privoca")) {
          const updated = ["Privoca", ...customDictionary];
          setCustomDictionaryRaw(updated);
          await window.electronAPI.setDictionary(updated);
        }

        const dbWords = await window.electronAPI.getDictionary();
        if (dbWords.length === 0 && customDictionary.length > 0) {
          // Seed SQLite from localStorage (first-time migration)
          await window.electronAPI.setDictionary(customDictionary);
        } else if (dbWords.length > 0 && customDictionary.length === 0) {
          // Recover localStorage from SQLite (e.g. localStorage was cleared)
          setCustomDictionaryRaw(dbWords);
        }
      } catch {
        // Silently ignore sync errors
      }
    };

    syncDictionary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reasoning settings
  const [useReasoningModel, setUseReasoningModel] = useLocalStorage("useReasoningModel", true, {
    serialize: String,
    deserialize: (value) => value !== "false", // Default true
  });

  const [reasoningModel, setReasoningModel] = useLocalStorage("reasoningModel", "", {
    serialize: String,
    deserialize: String,
  });

  const [reasoningProvider, setReasoningProvider] = useLocalStorage("reasoningProvider", "openai", {
    serialize: String,
    deserialize: String,
  });

  // API keys - localStorage for UI, synced to Electron IPC for persistence
  const [openaiApiKey, setOpenaiApiKeyLocal] = useLocalStorage("openaiApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [anthropicApiKey, setAnthropicApiKeyLocal] = useLocalStorage("anthropicApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [geminiApiKey, setGeminiApiKeyLocal] = useLocalStorage("geminiApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [groqApiKey, setGroqApiKeyLocal] = useLocalStorage("groqApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  // Theme setting
  const [theme, setTheme] = useLocalStorage<"light" | "dark" | "auto">("theme", "auto", {
    serialize: String,
    deserialize: (value) => {
      if (["light", "dark", "auto"].includes(value)) return value as "light" | "dark" | "auto";
      return "auto";
    },
  });

  // History limit setting - controls how many transcriptions to keep in history (privacy)
  const [historyLimit, setHistoryLimitLocal] = useLocalStorage<number>("historyLimit", 50, {
    serialize: String,
    deserialize: (value) => {
      const num = parseInt(value, 10);
      return isNaN(num) ? 50 : num;
    },
  });

  // Music ducking — lower/mute system audio while transcribing
  const [musicDuckingMode, setMusicDuckingMode] = useLocalStorage<"off" | "mute" | "duck">(
    "musicDuckingMode",
    "off",
    {
      serialize: String,
      deserialize: (value) => {
        if (value === "mute" || value === "duck") return value;
        return "off";
      },
    }
  );

  const [musicDuckLevel, setMusicDuckLevel] = useLocalStorage<number>("musicDuckLevel", 0.2, {
    serialize: String,
    deserialize: (value) => {
      const num = parseFloat(value);
      return isNaN(num) ? 0.2 : Math.max(0.05, Math.min(0.8, num));
    },
  });

  // Correction memory toggles
  const [enableVariableSnapping, setEnableVariableSnapping] = useLocalStorage<boolean>(
    "enableVariableSnapping",
    true,
    {
      serialize: String,
      deserialize: (value) => value !== "false", // default true
    }
  );

  const [enableCorrectionLearning, setEnableCorrectionLearning] = useLocalStorage<boolean>(
    "enableCorrectionLearning",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true", // default false
    }
  );

  // Context capture (off by default). This is plumbing for future "active app/window context".
  const [enableContextCapture, setEnableContextCapture] = useLocalStorage<boolean>(
    "enableContextCapture",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  // Sync historyLimit to main process so db-save-transcription can gate on it
  // (different Electron windows have isolated localStorage, so the main process
  //  is the single source of truth for this setting at save time)
  const syncHistoryLimit = (limit: number) => {
    if (typeof window !== "undefined" && window.electronAPI?.setHistoryLimit) {
      window.electronAPI.setHistoryLimit(limit);
    }
  };

  const setHistoryLimit = (limit: number) => {
    setHistoryLimitLocal(limit);
    syncHistoryLimit(limit);
  };

  // Send the current value on mount so main process is accurate from the start
  useEffect(() => {
    syncHistoryLimit(historyLimit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Custom endpoint API keys - synced to .env like other keys
  const [customTranscriptionApiKey, setCustomTranscriptionApiKeyLocal] = useLocalStorage(
    "customTranscriptionApiKey",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [customReasoningApiKey, setCustomReasoningApiKeyLocal] = useLocalStorage(
    "customReasoningApiKey",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  // Sync API keys from main process on first mount (if localStorage was cleared)
  const hasRunApiKeySync = useRef(false);
  useEffect(() => {
    if (hasRunApiKeySync.current) return;
    hasRunApiKeySync.current = true;

    const syncKeys = async () => {
      if (typeof window === "undefined" || !window.electronAPI) return;

      // Only sync keys that are missing from localStorage
      if (!openaiApiKey) {
        const envKey = await window.electronAPI.getOpenAIKey?.();
        if (envKey) setOpenaiApiKeyLocal(envKey);
      }
      if (!anthropicApiKey) {
        const envKey = await window.electronAPI.getAnthropicKey?.();
        if (envKey) setAnthropicApiKeyLocal(envKey);
      }
      if (!geminiApiKey) {
        const envKey = await window.electronAPI.getGeminiKey?.();
        if (envKey) setGeminiApiKeyLocal(envKey);
      }
      if (!groqApiKey) {
        const envKey = await window.electronAPI.getGroqKey?.();
        if (envKey) setGroqApiKeyLocal(envKey);
      }
      if (!customTranscriptionApiKey) {
        const envKey = await window.electronAPI.getCustomTranscriptionKey?.();
        if (envKey) setCustomTranscriptionApiKeyLocal(envKey);
      }
      if (!customReasoningApiKey) {
        const envKey = await window.electronAPI.getCustomReasoningKey?.();
        if (envKey) setCustomReasoningApiKeyLocal(envKey);
      }
    };

    syncKeys().catch(() => {
      // Silently ignore sync errors
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debouncedPersistToEnv = useDebouncedCallback(() => {
    if (typeof window !== "undefined" && window.electronAPI?.saveAllKeysToEnv) {
      window.electronAPI.saveAllKeysToEnv().catch(() => {
        // Silently ignore persistence errors
      });
    }
  }, 1000);

  // Wrapped setters that sync to Electron IPC and invalidate cache
  const setOpenaiApiKey = useCallback(
    (key: string) => {
      setOpenaiApiKeyLocal(key);
      window.electronAPI?.saveOpenAIKey?.(key);
      ReasoningService.clearApiKeyCache("openai");
      debouncedPersistToEnv();
    },
    [setOpenaiApiKeyLocal, debouncedPersistToEnv]
  );

  const setAnthropicApiKey = useCallback(
    (key: string) => {
      setAnthropicApiKeyLocal(key);
      window.electronAPI?.saveAnthropicKey?.(key);
      ReasoningService.clearApiKeyCache("anthropic");
      debouncedPersistToEnv();
    },
    [setAnthropicApiKeyLocal, debouncedPersistToEnv]
  );

  const setGeminiApiKey = useCallback(
    (key: string) => {
      setGeminiApiKeyLocal(key);
      window.electronAPI?.saveGeminiKey?.(key);
      ReasoningService.clearApiKeyCache("gemini");
      debouncedPersistToEnv();
    },
    [setGeminiApiKeyLocal, debouncedPersistToEnv]
  );

  const setGroqApiKey = useCallback(
    (key: string) => {
      setGroqApiKeyLocal(key);
      window.electronAPI?.saveGroqKey?.(key);
      ReasoningService.clearApiKeyCache("groq");
      debouncedPersistToEnv();
    },
    [setGroqApiKeyLocal, debouncedPersistToEnv]
  );

  const setCustomTranscriptionApiKey = useCallback(
    (key: string) => {
      setCustomTranscriptionApiKeyLocal(key);
      window.electronAPI?.saveCustomTranscriptionKey?.(key);
      debouncedPersistToEnv();
    },
    [setCustomTranscriptionApiKeyLocal, debouncedPersistToEnv]
  );

  const setCustomReasoningApiKey = useCallback(
    (key: string) => {
      setCustomReasoningApiKeyLocal(key);
      window.electronAPI?.saveCustomReasoningKey?.(key);
      ReasoningService.clearApiKeyCache("custom");
      debouncedPersistToEnv();
    },
    [setCustomReasoningApiKeyLocal, debouncedPersistToEnv]
  );

  // Hotkey
  const [dictationKey, setDictationKeyLocal] = useLocalStorage("dictationKey", "", {
    serialize: String,
    deserialize: String,
  });

  // Wrap setDictationKey to notify main process (for Windows Push-to-Talk)
  // and persist to file-based storage for reliable startup
  const setDictationKey = useCallback(
    (key: string) => {
      setDictationKeyLocal(key);
      // Notify main process so Windows key listener can restart with new key
      if (typeof window !== "undefined" && window.electronAPI?.notifyHotkeyChanged) {
        window.electronAPI.notifyHotkeyChanged(key);
      }
      // Also save to file-based storage for reliable persistence across restarts
      if (typeof window !== "undefined" && window.electronAPI?.saveDictationKey) {
        window.electronAPI.saveDictationKey(key);
      }
    },
    [setDictationKeyLocal]
  );

  const [activationMode, setActivationModeLocal] = useLocalStorage<"tap" | "push">(
    "activationMode",
    "tap",
    {
      serialize: String,
      deserialize: (value) => (value === "push" ? "push" : "tap"),
    }
  );

  // Wrap setActivationMode to notify main process (for Windows Push-to-Talk)
  const setActivationMode = useCallback(
    (mode: "tap" | "push") => {
      setActivationModeLocal(mode);
      // Notify main process so Windows key listener can start/stop
      if (typeof window !== "undefined" && window.electronAPI?.notifyActivationModeChanged) {
        window.electronAPI.notifyActivationModeChanged(mode);
      }
    },
    [setActivationModeLocal]
  );

  // Microphone settings
  const [preferBuiltInMic, setPreferBuiltInMic] = useLocalStorage("preferBuiltInMic", true, {
    serialize: String,
    deserialize: (value) => value !== "false",
  });

  const [selectedMicDeviceId, setSelectedMicDeviceId] = useLocalStorage("selectedMicDeviceId", "", {
    serialize: String,
    deserialize: String,
  });

  // Sync startup pre-warming preferences to main process
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    const model = localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
    window.electronAPI
      .syncStartupPreferences({
        useLocalWhisper,
        localTranscriptionProvider,
        model: model || undefined,
        reasoningProvider,
        reasoningModel: reasoningProvider === "local" ? reasoningModel : undefined,
      })
      .catch((err) => console.error("Failed to sync startup preferences:", err));
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    reasoningProvider,
    reasoningModel,
  ]);

  // Batch operations

  // Behavior settings
  const boolSerializer = { serialize: String, deserialize: (v: string) => v === "true" };

  const [autoPaste, setAutoPaste] = useLocalStorage("autoPaste", true, boolSerializer);
  const [copyToClipboard, setCopyToClipboard] = useLocalStorage("copyToClipboard", true, boolSerializer);
  const [showPanelOnError, setShowPanelOnError] = useLocalStorage("showPanelOnError", false, boolSerializer);
  const [audioFeedback, setAudioFeedback] = useLocalStorage("audioFeedback", true, boolSerializer);
  const [errorNotifications, setErrorNotifications] = useLocalStorage("errorNotifications", true, boolSerializer);
  const [successConfirmation, setSuccessConfirmation] = useLocalStorage("successConfirmation", false, boolSerializer);

  const updateBehaviorSettings = useCallback(
    (settings: Partial<BehaviorSettings>) => {
      if (settings.autoPaste !== undefined) setAutoPaste(settings.autoPaste);
      if (settings.copyToClipboard !== undefined) setCopyToClipboard(settings.copyToClipboard);
      if (settings.showPanelOnError !== undefined) setShowPanelOnError(settings.showPanelOnError);
      if (settings.audioFeedback !== undefined) setAudioFeedback(settings.audioFeedback);
      if (settings.errorNotifications !== undefined) setErrorNotifications(settings.errorNotifications);
      if (settings.successConfirmation !== undefined) setSuccessConfirmation(settings.successConfirmation);
    },
    [setAutoPaste, setCopyToClipboard, setShowPanelOnError, setAudioFeedback, setErrorNotifications, setSuccessConfirmation]
  );

  const updateTranscriptionSettings = useCallback(
    (settings: Partial<TranscriptionSettings>) => {
      if (settings.useLocalWhisper !== undefined) setUseLocalWhisper(settings.useLocalWhisper);
      if (settings.whisperModel !== undefined) setWhisperModel(settings.whisperModel);
      if (settings.localTranscriptionProvider !== undefined)
        setLocalTranscriptionProvider(settings.localTranscriptionProvider);
      if (settings.parakeetModel !== undefined) setParakeetModel(settings.parakeetModel);
      if (settings.allowOpenAIFallback !== undefined)
        setAllowOpenAIFallback(settings.allowOpenAIFallback);
      if (settings.allowLocalFallback !== undefined)
        setAllowLocalFallback(settings.allowLocalFallback);
      if (settings.fallbackWhisperModel !== undefined)
        setFallbackWhisperModel(settings.fallbackWhisperModel);
      if (settings.preferredLanguage !== undefined)
        setPreferredLanguage(settings.preferredLanguage);
      if (settings.translateToEnglish !== undefined)
        setTranslateToEnglish(settings.translateToEnglish);
      if (settings.cloudTranscriptionProvider !== undefined)
        setCloudTranscriptionProvider(settings.cloudTranscriptionProvider);
      if (settings.cloudTranscriptionModel !== undefined)
        setCloudTranscriptionModel(settings.cloudTranscriptionModel);
      if (settings.cloudTranscriptionBaseUrl !== undefined)
        setCloudTranscriptionBaseUrl(settings.cloudTranscriptionBaseUrl);
      if (settings.customDictionary !== undefined) setCustomDictionary(settings.customDictionary);
    },
    [
      setUseLocalWhisper,
      setWhisperModel,
      setLocalTranscriptionProvider,
      setParakeetModel,
      setAllowOpenAIFallback,
      setAllowLocalFallback,
      setFallbackWhisperModel,
      setPreferredLanguage,
      setTranslateToEnglish,
      setCloudTranscriptionProvider,
      setCloudTranscriptionModel,
      setCloudTranscriptionBaseUrl,
      setCustomDictionary,
    ]
  );

  const updateReasoningSettings = useCallback(
    (settings: Partial<ReasoningSettings>) => {
      if (settings.useReasoningModel !== undefined)
        setUseReasoningModel(settings.useReasoningModel);
      if (settings.reasoningModel !== undefined) setReasoningModel(settings.reasoningModel);
      if (settings.reasoningProvider !== undefined)
        setReasoningProvider(settings.reasoningProvider);
      if (settings.cloudReasoningBaseUrl !== undefined)
        setCloudReasoningBaseUrl(settings.cloudReasoningBaseUrl);
    },
    [setUseReasoningModel, setReasoningModel, setReasoningProvider, setCloudReasoningBaseUrl]
  );

  const updateApiKeys = useCallback(
    (keys: Partial<ApiKeySettings>) => {
      if (keys.openaiApiKey !== undefined) setOpenaiApiKey(keys.openaiApiKey);
      if (keys.anthropicApiKey !== undefined) setAnthropicApiKey(keys.anthropicApiKey);
      if (keys.geminiApiKey !== undefined) setGeminiApiKey(keys.geminiApiKey);
      if (keys.groqApiKey !== undefined) setGroqApiKey(keys.groqApiKey);
    },
    [setOpenaiApiKey, setAnthropicApiKey, setGeminiApiKey, setGroqApiKey]
  );

  return {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    allowOpenAIFallback,
    allowLocalFallback,
    fallbackWhisperModel,
    preferredLanguage,
    translateToEnglish,
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
    setUseLocalWhisper,
    setWhisperModel,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setAllowOpenAIFallback,
    setAllowLocalFallback,
    setFallbackWhisperModel,
    setPreferredLanguage,
    setTranslateToEnglish,
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
    setTheme,
    historyLimit,
    setHistoryLimit,
    activationMode,
    setActivationMode,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
    updateTranscriptionSettings,
    updateReasoningSettings,
    updateApiKeys,
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
    updateBehaviorSettings,
  };
}
