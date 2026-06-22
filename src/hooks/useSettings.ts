import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { useDebouncedCallback } from "./useDebouncedCallback";
import { API_ENDPOINTS } from "../config/constants";
import { isValidApiUrl } from "../helpers/urlValidation";
import ReasoningService from "../services/ReasoningService";
import type { LocalTranscriptionProvider, TranscriptionSettingsBroadcast } from "../types/electron";
import {
  isDictionaryEntryMode,
  pruneDictionaryEntryModes,
  type DictionaryEntryMode,
  type DictionaryEntryModeMap,
} from "../utils/dictionaryEntryModes";

export interface TranscriptionSettings {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  /** When true, use the CPU whisper binary even if the CUDA binary is installed. */
  whisperForceCpu: boolean;
  /** Minutes before whisper-server is auto-stopped to free memory. 0 = never. */
  whisperServerIdleTimeoutMinutes: number;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  translateToEnglish: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl?: string;
  customDictionary: string[];
  dictionaryEntryModes: DictionaryEntryModeMap;
}

export interface ReasoningSettings {
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;
  cloudReasoningBaseUrl?: string;
  /** Minutes before llama-server is auto-stopped to free memory. 0 = never. */
  llamaServerIdleTimeoutMinutes: number;
}

export interface HotkeySettings {
  dictationKey: string;
  activationMode: "tap" | "push" | "tapHold";
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
  overlayDisabled: boolean;
  overlaySnapToTaskbar: boolean;
}

let lastSyncedStartupPreferencesKey = "";

export function useSettings() {
  const [useLocalWhisper, setUseLocalWhisper] = useLocalStorage("useLocalWhisper", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [whisperModel, setWhisperModel] = useLocalStorage("whisperModel", "turbo", {
    serialize: String,
    deserialize: String,
  });

  const [localTranscriptionProvider, setLocalTranscriptionProvider] =
    useLocalStorage<LocalTranscriptionProvider>("localTranscriptionProvider", "whisper", {
      serialize: String,
      // Legacy cleanup: "nvidia" is mapped to whisper.
      deserialize: () => "whisper",
    });

  const [whisperForceCpu, setWhisperForceCpu] = useLocalStorage("whisperForceCpu", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [whisperServerIdleTimeoutMinutes, setWhisperServerIdleTimeoutMinutes] = useLocalStorage(
    "whisperServerIdleTimeoutMinutes",
    30,
    {
      serialize: String,
      deserialize: (value) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n >= 0 ? n : 30;
      },
    }
  );

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

  const [preferredLanguage, setPreferredLanguage] = useLocalStorage("preferredLanguage", "auto", {
    serialize: String,
    deserialize: String,
  });

  const [translateToEnglish, setTranslateToEnglish] = useLocalStorage("translateToEnglish", "off", {
    serialize: String,
    deserialize: String,
  });

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

  const [cloudTranscriptionBaseUrl, setCloudTranscriptionBaseUrlLocal] = useLocalStorage(
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE,
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudReasoningBaseUrl, setCloudReasoningBaseUrlLocal] = useLocalStorage(
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
    ["PrivateTranscribe"],
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

  const [dictionaryEntryModes, setDictionaryEntryModesRaw] =
    useLocalStorage<DictionaryEntryModeMap>(
      "dictionaryEntryModes",
      {},
      {
        serialize: JSON.stringify,
        deserialize: (value) => {
          try {
            const parsed = JSON.parse(value);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            return Object.fromEntries(
              Object.entries(parsed).filter((entry): entry is [string, DictionaryEntryMode] =>
                isDictionaryEntryMode(entry[1])
              )
            );
          } catch {
            return {};
          }
        },
      }
    );

  const setDictionaryEntryModes = useCallback(
    (modes: DictionaryEntryModeMap) => {
      setDictionaryEntryModesRaw(modes);
    },
    [setDictionaryEntryModesRaw]
  );

  // Wrap setter to sync dictionary to SQLite
  const setCustomDictionary = useCallback(
    (words: string[]) => {
      setCustomDictionaryRaw(words);
      setDictionaryEntryModesRaw(pruneDictionaryEntryModes(dictionaryEntryModes, words));
      window.electronAPI?.setDictionary(words).catch(() => {
        // Silently ignore SQLite sync errors
      });
    },
    [dictionaryEntryModes, setCustomDictionaryRaw, setDictionaryEntryModesRaw]
  );

  // One-time sync: reconcile localStorage ↔ SQLite on startup, ensure PrivateTranscribe is included
  const hasRunDictionarySync = useRef(false);
  useEffect(() => {
    if (hasRunDictionarySync.current) return;
    hasRunDictionarySync.current = true;

    const syncDictionary = async () => {
      if (typeof window === "undefined" || !window.electronAPI?.getDictionary) return;
      try {
        // Ensure "PrivateTranscribe" is always in the dictionary
        if (!customDictionary.includes("PrivateTranscribe")) {
          const updated = ["PrivateTranscribe", ...customDictionary];
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
  const [useReasoningModel, setUseReasoningModel] = useLocalStorage("useReasoningModel", false, {
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

  const [llamaServerIdleTimeoutMinutes, setLlamaServerIdleTimeoutMinutes] = useLocalStorage(
    "llamaServerIdleTimeoutMinutes",
    10,
    {
      serialize: String,
      deserialize: (value) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n >= 0 ? n : 10;
      },
    }
  );

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

  // Music ducking - lower/mute system audio while transcribing
  const [musicDuckingMode, setMusicDuckingMode] = useLocalStorage<"off" | "mute" | "duck">(
    "musicDuckingMode",
    "duck",
    {
      serialize: String,
      deserialize: (value) => {
        if (value === "mute" || value === "duck") return value;
        return "off";
      },
    }
  );

  const [musicDuckLevel, setMusicDuckLevel] = useLocalStorage<number>("musicDuckLevel", 0.5, {
    serialize: String,
    deserialize: (value) => {
      const num = parseFloat(value);
      return isNaN(num) ? 0.5 : Math.max(0.05, Math.min(0.8, num));
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

  // Smart Context master toggle (default true — Pro entitlement gate enforces access for free users).
  // Reads "smartContextEnabled"; contextPipeline.js also reads legacy "enableContextCapture" key.
  const [smartContextEnabled, setSmartContextEnabled] = useLocalStorage<boolean>(
    "smartContextEnabled",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  // File transcription preferences — remember the upload-panel toggles across tabs/sessions.
  const [fileTranscriptionNoiseReduction, setFileTranscriptionNoiseReduction] =
    useLocalStorage<boolean>("fileTranscriptionNoiseReduction", true, {
      serialize: String,
      deserialize: (value) => value !== "false",
    });

  const [fileTranscriptionSpeakerDetection, setFileTranscriptionSpeakerDetection] =
    useLocalStorage<boolean>("fileTranscriptionSpeakerDetection", false, {
      serialize: String,
      deserialize: (value) => value === "true",
    });

  const [fileTranscriptionSpeakerDetectionMode, setFileTranscriptionSpeakerDetectionMode] =
    useLocalStorage<string>("fileTranscriptionSpeakerDetectionMode", "off", {
      serialize: String,
      deserialize: (value) =>
        ["off", "tiny-diarize-en", "local-diarization"].includes(value)
          ? value
          : value === "true"
            ? "tiny-diarize-en"
            : "off",
    });

  // Expected number of speakers for file transcription diarization.
  // "auto" = let the clustering algorithm decide; "2"-"6" = fixed hint.
  const [fileTranscriptionExpectedSpeakers, setFileTranscriptionExpectedSpeakers] =
    useLocalStorage<string>("fileTranscriptionExpectedSpeakers", "auto", {
      serialize: String,
      deserialize: (value) => (["auto", "2", "3", "4", "5", "6"].includes(value) ? value : "auto"),
    });

  // Legacy alias kept so older settings exports still work (SettingsPage may import this name).
  // Points to the same key — deprecated, use smartContextEnabled going forward.
  const [enableContextCapture, setEnableContextCapture] = useLocalStorage<boolean>(
    "enableContextCapture",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  // Active file identifiers (opt-in, local only) — off by default.
  const [enableFileIdentifiers, setEnableFileIdentifiers] = useLocalStorage<boolean>(
    "enableFileIdentifiers",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  // LLM Context Enhancement — feed Smart Context to the reasoning model (off by default).
  const [llmContextEnhancement, setLlmContextEnhancement] = useLocalStorage<boolean>(
    "llmContextEnhancement",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  // Include active file content in LLM context (off by default, separate opt-in).
  const [includeFileContentInLlmContext, setIncludeFileContentInLlmContext] =
    useLocalStorage<boolean>("includeFileContentInLlmContext", false, {
      serialize: String,
      deserialize: (value) => value === "true",
    });

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

  // Error state for API key persistence failures — set when saveAllKeysToEnv fails.
  // Auto-clears after 15 seconds to avoid stale banners.
  const [apiKeySyncError, setApiKeySyncError] = useState<string | null>(null);
  const persistErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reportPersistError = useCallback((msg: string) => {
    setApiKeySyncError(msg);
    if (persistErrorTimerRef.current) clearTimeout(persistErrorTimerRef.current);
    persistErrorTimerRef.current = setTimeout(() => setApiKeySyncError(null), 15_000);
  }, []);

  const clearApiKeySyncError = useCallback(() => {
    if (persistErrorTimerRef.current) {
      clearTimeout(persistErrorTimerRef.current);
      persistErrorTimerRef.current = null;
    }
    setApiKeySyncError(null);
  }, []);

  useEffect(() => {
    return () => {
      if (persistErrorTimerRef.current) {
        clearTimeout(persistErrorTimerRef.current);
        persistErrorTimerRef.current = null;
      }
    };
  }, []);

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

    syncKeys().catch((err) => {
      // Startup sync failure is transient (bridge may not be ready yet) — log only.
      console.warn("[useSettings] Startup API key sync failed:", err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debouncedPersistToEnv = useDebouncedCallback(() => {
    if (typeof window !== "undefined" && window.electronAPI?.saveAllKeysToEnv) {
      window.electronAPI.saveAllKeysToEnv().catch((err: unknown) => {
        console.error("[useSettings] Failed to persist API keys to .env:", err);
        reportPersistError(
          "API keys could not be saved to disk. They are stored for this session only - you may need to re-enter them after restarting the app."
        );
      });
    }
  }, 1000);

  const broadcastTranscriptionSettingsUpdate = useCallback(
    (overrides: Partial<TranscriptionSettingsBroadcast> = {}) => {
      if (
        typeof window === "undefined" ||
        !window.electronAPI?.notifyTranscriptionSettingsChanged
      ) {
        return;
      }

      window.electronAPI.notifyTranscriptionSettingsChanged({
        useLocalWhisper: String(useLocalWhisper),
        whisperModel,
        localTranscriptionProvider,
        whisperForceCpu: String(whisperForceCpu),
        allowOpenAIFallback: String(allowOpenAIFallback),
        allowLocalFallback: String(allowLocalFallback),
        fallbackWhisperModel,
        preferredLanguage,
        translateToEnglish,
        cloudTranscriptionProvider,
        cloudTranscriptionModel,
        cloudTranscriptionBaseUrl,
        ...overrides,
      });
    },
    [
      useLocalWhisper,
      whisperModel,
      localTranscriptionProvider,
      whisperForceCpu,
      allowOpenAIFallback,
      allowLocalFallback,
      fallbackWhisperModel,
      preferredLanguage,
      translateToEnglish,
      cloudTranscriptionProvider,
      cloudTranscriptionModel,
      cloudTranscriptionBaseUrl,
    ]
  );

  // Wrapped setters that sync to Electron IPC and invalidate cache
  const setOpenaiApiKey = useCallback(
    (key: string) => {
      setOpenaiApiKeyLocal(key);
      window.electronAPI?.saveOpenAIKey?.(key)?.catch((err: unknown) => {
        console.error("[useSettings] saveOpenAIKey IPC failed:", err);
      });
      ReasoningService.clearApiKeyCache("openai");
      broadcastTranscriptionSettingsUpdate({ openaiApiKey: key });
      debouncedPersistToEnv();
    },
    [setOpenaiApiKeyLocal, debouncedPersistToEnv, broadcastTranscriptionSettingsUpdate]
  );

  const setAnthropicApiKey = useCallback(
    (key: string) => {
      setAnthropicApiKeyLocal(key);
      window.electronAPI?.saveAnthropicKey?.(key)?.catch((err: unknown) => {
        console.error("[useSettings] saveAnthropicKey IPC failed:", err);
      });
      ReasoningService.clearApiKeyCache("anthropic");
      debouncedPersistToEnv();
    },
    [setAnthropicApiKeyLocal, debouncedPersistToEnv]
  );

  const setGeminiApiKey = useCallback(
    (key: string) => {
      setGeminiApiKeyLocal(key);
      window.electronAPI?.saveGeminiKey?.(key)?.catch((err: unknown) => {
        console.error("[useSettings] saveGeminiKey IPC failed:", err);
      });
      ReasoningService.clearApiKeyCache("gemini");
      debouncedPersistToEnv();
    },
    [setGeminiApiKeyLocal, debouncedPersistToEnv]
  );

  const setGroqApiKey = useCallback(
    (key: string) => {
      setGroqApiKeyLocal(key);
      window.electronAPI?.saveGroqKey?.(key)?.catch((err: unknown) => {
        console.error("[useSettings] saveGroqKey IPC failed:", err);
      });
      ReasoningService.clearApiKeyCache("groq");
      broadcastTranscriptionSettingsUpdate({ groqApiKey: key });
      debouncedPersistToEnv();
    },
    [setGroqApiKeyLocal, debouncedPersistToEnv, broadcastTranscriptionSettingsUpdate]
  );

  const setCustomTranscriptionApiKey = useCallback(
    (key: string) => {
      setCustomTranscriptionApiKeyLocal(key);
      window.electronAPI?.saveCustomTranscriptionKey?.(key)?.catch((err: unknown) => {
        console.error("[useSettings] saveCustomTranscriptionKey IPC failed:", err);
      });
      broadcastTranscriptionSettingsUpdate({ customTranscriptionApiKey: key });
      debouncedPersistToEnv();
    },
    [setCustomTranscriptionApiKeyLocal, debouncedPersistToEnv, broadcastTranscriptionSettingsUpdate]
  );

  const setCustomReasoningApiKey = useCallback(
    (key: string) => {
      setCustomReasoningApiKeyLocal(key);
      window.electronAPI?.saveCustomReasoningKey?.(key)?.catch((err: unknown) => {
        console.error("[useSettings] saveCustomReasoningKey IPC failed:", err);
      });
      ReasoningService.clearApiKeyCache("custom");
      debouncedPersistToEnv();
    },
    [setCustomReasoningApiKeyLocal, debouncedPersistToEnv]
  );

  const setCloudTranscriptionBaseUrl = useCallback(
    (url: string) => {
      const validation = isValidApiUrl(url);
      if (!validation.valid) {
        console.warn("[useSettings] Rejected unsafe cloudTranscriptionBaseUrl:", validation.reason);
        return;
      }
      setCloudTranscriptionBaseUrlLocal(url);
    },
    [setCloudTranscriptionBaseUrlLocal]
  );

  const setCloudReasoningBaseUrl = useCallback(
    (url: string) => {
      const validation = isValidApiUrl(url);
      if (!validation.valid) {
        console.warn("[useSettings] Rejected unsafe cloudReasoningBaseUrl:", validation.reason);
        return;
      }
      setCloudReasoningBaseUrlLocal(url);
    },
    [setCloudReasoningBaseUrlLocal]
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

  const [activationMode, setActivationModeLocal] = useLocalStorage<"tap" | "push" | "tapHold">(
    "activationMode",
    "tap",
    {
      serialize: String,
      deserialize: (value) => (value === "push" || value === "tapHold" ? value : "tap"),
    }
  );

  // Wrap setActivationMode to notify main process (for Windows Push-to-Talk)
  const setActivationMode = useCallback(
    (mode: "tap" | "push" | "tapHold") => {
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

  // Sync startup pre-warming preferences to main process.
  // Several pages call useSettings(); avoid re-applying identical startup prefs on every tab mount.
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    const startupPreferences = {
      useLocalWhisper,
      localTranscriptionProvider,
      model: whisperModel || undefined,
      whisperServerIdleTimeoutMinutes,
      llamaServerIdleTimeoutMinutes,
      reasoningProvider,
      reasoningModel: reasoningProvider === "local" ? reasoningModel : undefined,
      whisperForceCpu,
    };
    const startupPreferencesKey = JSON.stringify(startupPreferences);
    if (startupPreferencesKey === lastSyncedStartupPreferencesKey) return;
    lastSyncedStartupPreferencesKey = startupPreferencesKey;

    window.electronAPI.syncStartupPreferences(startupPreferences).catch((err) => {
      lastSyncedStartupPreferencesKey = "";
      console.error("Failed to sync startup preferences:", err);
    });
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    whisperServerIdleTimeoutMinutes,
    llamaServerIdleTimeoutMinutes,
    reasoningProvider,
    reasoningModel,
    whisperForceCpu,
  ]);

  // Apply force-CPU toggle immediately when it changes (no restart needed)
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.electronAPI?.setWhisperForceCpu?.(whisperForceCpu)?.then((result) => {
      if (result && result.success === false) {
        console.error("Failed to apply Whisper CPU/GPU preference:", result.error);
      }
    });
  }, [whisperForceCpu]);

  // Batch operations

  // Behavior settings
  const boolSerializer = { serialize: String, deserialize: (v: string) => v === "true" };

  const [autoPaste, setAutoPaste] = useLocalStorage("autoPaste", true, boolSerializer);
  const [copyToClipboard, setCopyToClipboard] = useLocalStorage(
    "copyToClipboard",
    true,
    boolSerializer
  );
  const [showPanelOnError, setShowPanelOnError] = useLocalStorage(
    "showPanelOnError",
    false,
    boolSerializer
  );
  const [pauseMediaOnRecord, setPauseMediaOnRecord] = useLocalStorage(
    "pauseMediaOnRecord",
    false,
    boolSerializer
  );
  const [audioFeedback, setAudioFeedback] = useLocalStorage("audioFeedback", false, boolSerializer);
  const [errorNotifications, setErrorNotifications] = useLocalStorage(
    "errorNotifications",
    true,
    boolSerializer
  );
  const [successConfirmation, setSuccessConfirmation] = useLocalStorage(
    "successConfirmation",
    false,
    boolSerializer
  );

  const [overlayDisabled, setOverlayDisabled] = useLocalStorage(
    "overlayDisabled",
    false,
    boolSerializer
  );
  const [overlaySnapToTaskbar, setOverlaySnapToTaskbar] = useLocalStorage(
    "overlaySnapToTaskbar",
    false,
    boolSerializer
  );

  const updateBehaviorSettings = useCallback(
    (settings: Partial<BehaviorSettings>) => {
      if (settings.autoPaste !== undefined) setAutoPaste(settings.autoPaste);
      if (settings.copyToClipboard !== undefined) setCopyToClipboard(settings.copyToClipboard);
      if (settings.showPanelOnError !== undefined) setShowPanelOnError(settings.showPanelOnError);
      if (settings.audioFeedback !== undefined) setAudioFeedback(settings.audioFeedback);
      if (settings.errorNotifications !== undefined)
        setErrorNotifications(settings.errorNotifications);
      if (settings.successConfirmation !== undefined)
        setSuccessConfirmation(settings.successConfirmation);
      if (settings.overlayDisabled !== undefined) setOverlayDisabled(settings.overlayDisabled);
      if (settings.overlaySnapToTaskbar !== undefined)
        setOverlaySnapToTaskbar(settings.overlaySnapToTaskbar);
    },
    [
      setAutoPaste,
      setCopyToClipboard,
      setShowPanelOnError,
      setAudioFeedback,
      setErrorNotifications,
      setSuccessConfirmation,
      setOverlayDisabled,
      setOverlaySnapToTaskbar,
    ]
  );

  const updateTranscriptionSettings = useCallback(
    (settings: Partial<TranscriptionSettings>) => {
      if (settings.useLocalWhisper !== undefined) setUseLocalWhisper(settings.useLocalWhisper);
      if (settings.whisperModel !== undefined) setWhisperModel(settings.whisperModel);
      if (settings.localTranscriptionProvider !== undefined)
        setLocalTranscriptionProvider(settings.localTranscriptionProvider);
      if (settings.whisperForceCpu !== undefined) setWhisperForceCpu(settings.whisperForceCpu);
      if (settings.whisperServerIdleTimeoutMinutes !== undefined)
        setWhisperServerIdleTimeoutMinutes(settings.whisperServerIdleTimeoutMinutes);
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

      const transcriptionOverrides: Partial<TranscriptionSettingsBroadcast> = {};
      if (settings.useLocalWhisper !== undefined) {
        transcriptionOverrides.useLocalWhisper = String(settings.useLocalWhisper);
      }
      if (settings.whisperModel !== undefined) {
        transcriptionOverrides.whisperModel = settings.whisperModel;
      }
      if (settings.localTranscriptionProvider !== undefined) {
        transcriptionOverrides.localTranscriptionProvider = settings.localTranscriptionProvider;
      }
      if (settings.whisperForceCpu !== undefined) {
        transcriptionOverrides.whisperForceCpu = String(settings.whisperForceCpu);
      }
      if (settings.allowOpenAIFallback !== undefined) {
        transcriptionOverrides.allowOpenAIFallback = String(settings.allowOpenAIFallback);
      }
      if (settings.allowLocalFallback !== undefined) {
        transcriptionOverrides.allowLocalFallback = String(settings.allowLocalFallback);
      }
      if (settings.fallbackWhisperModel !== undefined) {
        transcriptionOverrides.fallbackWhisperModel = settings.fallbackWhisperModel;
      }
      if (settings.preferredLanguage !== undefined) {
        transcriptionOverrides.preferredLanguage = settings.preferredLanguage;
      }
      if (settings.translateToEnglish !== undefined) {
        transcriptionOverrides.translateToEnglish = settings.translateToEnglish;
      }
      if (settings.cloudTranscriptionProvider !== undefined) {
        transcriptionOverrides.cloudTranscriptionProvider = settings.cloudTranscriptionProvider;
      }
      if (settings.cloudTranscriptionModel !== undefined) {
        transcriptionOverrides.cloudTranscriptionModel = settings.cloudTranscriptionModel;
      }
      if (settings.cloudTranscriptionBaseUrl !== undefined) {
        transcriptionOverrides.cloudTranscriptionBaseUrl = settings.cloudTranscriptionBaseUrl;
      }

      if (Object.keys(transcriptionOverrides).length > 0) {
        broadcastTranscriptionSettingsUpdate(transcriptionOverrides);
      }
    },
    [
      setUseLocalWhisper,
      setWhisperModel,
      setLocalTranscriptionProvider,
      setWhisperServerIdleTimeoutMinutes,
      setAllowOpenAIFallback,
      setAllowLocalFallback,
      setFallbackWhisperModel,
      setPreferredLanguage,
      setTranslateToEnglish,
      setCloudTranscriptionProvider,
      setCloudTranscriptionModel,
      setCloudTranscriptionBaseUrl,
      setCustomDictionary,
      setWhisperForceCpu,
      broadcastTranscriptionSettingsUpdate,
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
      if (settings.llamaServerIdleTimeoutMinutes !== undefined)
        setLlamaServerIdleTimeoutMinutes(settings.llamaServerIdleTimeoutMinutes);
    },
    [
      setUseReasoningModel,
      setReasoningModel,
      setReasoningProvider,
      setCloudReasoningBaseUrl,
      setLlamaServerIdleTimeoutMinutes,
    ]
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
    whisperForceCpu,
    whisperServerIdleTimeoutMinutes,
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
    dictionaryEntryModes,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
    llamaServerIdleTimeoutMinutes,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey,
    groqApiKey,
    dictationKey,
    theme,
    setUseLocalWhisper,
    setWhisperModel,
    setLocalTranscriptionProvider,
    setWhisperForceCpu,
    setWhisperServerIdleTimeoutMinutes,
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
    setDictionaryEntryModes,
    setUseReasoningModel,
    setReasoningModel,
    setReasoningProvider,
    setLlamaServerIdleTimeoutMinutes,
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
    smartContextEnabled,
    setSmartContextEnabled,
    fileTranscriptionNoiseReduction,
    setFileTranscriptionNoiseReduction,
    fileTranscriptionSpeakerDetection,
    setFileTranscriptionSpeakerDetection,
    fileTranscriptionSpeakerDetectionMode,
    setFileTranscriptionSpeakerDetectionMode,
    fileTranscriptionExpectedSpeakers,
    setFileTranscriptionExpectedSpeakers,
    enableContextCapture,
    setEnableContextCapture,
    enableFileIdentifiers,
    setEnableFileIdentifiers,
    llmContextEnhancement,
    setLlmContextEnhancement,
    includeFileContentInLlmContext,
    setIncludeFileContentInLlmContext,
    autoPaste,
    setAutoPaste,
    copyToClipboard,
    setCopyToClipboard,
    showPanelOnError,
    setShowPanelOnError,
    pauseMediaOnRecord,
    setPauseMediaOnRecord,
    audioFeedback,
    setAudioFeedback,
    errorNotifications,
    setErrorNotifications,
    successConfirmation,
    setSuccessConfirmation,
    overlayDisabled,
    setOverlayDisabled,
    overlaySnapToTaskbar,
    setOverlaySnapToTaskbar,
    updateBehaviorSettings,
    apiKeySyncError,
    clearApiKeySyncError,
  };
}
