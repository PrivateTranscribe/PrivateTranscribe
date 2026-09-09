import { SettingsDisclosure } from "./ui/SettingsDisclosure";
import { Toggle } from "./ui/toggle";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useClaudeCodeStatus } from "../hooks/useClaudeCodeStatus";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import ApiKeyInput from "./ui/ApiKeyInput";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import LocalModelPicker, { type LocalProvider } from "./LocalModelPicker";
import { ProviderTabs } from "./ui/ProviderTabs";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { modelRegistry } from "../models/ModelRegistry";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { isSecureEndpoint } from "../utils/urlUtils";
import { createExternalLinkHandler } from "../utils/externalLinks";

type CloudModelOption = {
  deprecated?: boolean;
  replacementId?: string;
  value: string;
  label: string;
  description?: string;
  icon?: string;
  ownedBy?: string;
  invertInDark?: boolean;
};

const OWNED_BY_ICON_RULES: Array<{ match: RegExp; provider: string }> = [
  { match: /(openai|system|default|gpt|davinci)/, provider: "openai" },
  { match: /(azure)/, provider: "openai" },
  { match: /(anthropic|claude)/, provider: "anthropic" },
  { match: /(google|gemini)/, provider: "gemini" },
  { match: /(qwen|ali|tongyi)/, provider: "qwen" },
  { match: /(openrouter|oss)/, provider: "openai-oss" },
];

const resolveOwnedByIcon = (ownedBy?: string): { icon?: string; invertInDark: boolean } => {
  if (!ownedBy) return { icon: undefined, invertInDark: false };
  const normalized = ownedBy.toLowerCase();
  const rule = OWNED_BY_ICON_RULES.find(({ match }) => match.test(normalized));
  if (rule) {
    return {
      icon: getProviderIcon(rule.provider),
      invertInDark: isMonochromeProvider(rule.provider),
    };
  }
  return { icon: undefined, invertInDark: false };
};

interface ReasoningModelSelectorProps {
  children?: ReactNode;
  onConnectionChange?: () => void;
  useReasoningModel: boolean;
  setUseReasoningModel: (value: boolean) => void;
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  localReasoningProvider: string;
  setLocalReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (value: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;
  geminiApiKey: string;
  setGeminiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  customReasoningApiKey?: string;
  setCustomReasoningApiKey?: (key: string) => void;
  showAlertDialog: (dialog: { title: string; description: string }) => void;
}

export default function ReasoningModelSelector({
  children,
  onConnectionChange,
  useReasoningModel,
  setUseReasoningModel,
  reasoningModel,
  setReasoningModel,
  localReasoningProvider,
  setLocalReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  openaiApiKey,
  setOpenaiApiKey,
  anthropicApiKey,
  setAnthropicApiKey,
  geminiApiKey,
  setGeminiApiKey,
  groqApiKey,
  setGroqApiKey,
  customReasoningApiKey = "",
  setCustomReasoningApiKey,
}: ReasoningModelSelectorProps) {
  const { status: claudeStatus, refresh: refreshClaudeStatus } = useClaudeCodeStatus();
  const [selectedMode, setSelectedMode] = useState<"cloud" | "local" | "claude-code">(
    localReasoningProvider === "claude-code"
      ? "claude-code"
      : localReasoningProvider === "local" || modelRegistry.getProvider(localReasoningProvider)
        ? "local"
        : "cloud"
  );
  const [selectedCloudProvider, setSelectedCloudProvider] = useState(
    ["openai", "anthropic", "gemini", "groq", "custom"].includes(localReasoningProvider)
      ? localReasoningProvider
      : "openai"
  );
  const [selectedLocalProvider, setSelectedLocalProvider] = useState(
    modelRegistry.getModel(reasoningModel)?.provider.id || "qwen"
  );
  const [customModelOptions, setCustomModelOptions] = useState<CloudModelOption[]>([]);
  const [customModelsLoading, setCustomModelsLoading] = useState(false);
  const [customModelsError, setCustomModelsError] = useState<string | null>(null);
  const [editingConnection, setEditingConnection] = useState(false);
  const [customBaseInput, setCustomBaseInput] = useState(cloudReasoningBaseUrl);
  const lastLoadedBaseRef = useRef<string | null>(null);
  const pendingBaseRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const selectionRequestRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setCustomBaseInput(cloudReasoningBaseUrl);
  }, [cloudReasoningBaseUrl]);

  const defaultOpenAIBase = useMemo(() => normalizeBaseUrl(API_ENDPOINTS.OPENAI_BASE), []);
  const normalizedCustomReasoningBase = useMemo(
    () => normalizeBaseUrl(cloudReasoningBaseUrl),
    [cloudReasoningBaseUrl]
  );
  const latestReasoningBaseRef = useRef(normalizedCustomReasoningBase);

  useEffect(() => {
    latestReasoningBaseRef.current = normalizedCustomReasoningBase;
  }, [normalizedCustomReasoningBase]);

  const hasCustomBase = normalizedCustomReasoningBase !== "";
  const effectiveReasoningBase = hasCustomBase ? normalizedCustomReasoningBase : defaultOpenAIBase;

  const loadRemoteModels = useCallback(
    async (baseOverride?: string, force = false) => {
      const rawBase = (baseOverride ?? cloudReasoningBaseUrl) || "";
      const normalizedBase = normalizeBaseUrl(rawBase);

      if (!normalizedBase) {
        if (isMountedRef.current) {
          setCustomModelsLoading(false);
          setCustomModelsError(null);
          setCustomModelOptions([]);
        }
        return;
      }

      if (!force && lastLoadedBaseRef.current === normalizedBase) return;
      if (!force && pendingBaseRef.current === normalizedBase) return;

      if (baseOverride !== undefined) {
        latestReasoningBaseRef.current = normalizedBase;
      }

      pendingBaseRef.current = normalizedBase;

      if (isMountedRef.current) {
        setCustomModelsLoading(true);
        setCustomModelsError(null);
        setCustomModelOptions([]);
      }

      let apiKey: string | undefined;

      try {
        // Use the custom reasoning API key for custom endpoints
        const keyFromState = customReasoningApiKey?.trim();
        apiKey = keyFromState && keyFromState.length > 0 ? keyFromState : undefined;

        if (!normalizedBase.includes("://")) {
          if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
            setCustomModelsError(
              "Enter a full base URL including protocol (e.g. https://server/v1)."
            );
            setCustomModelsLoading(false);
          }
          return;
        }

        if (!isSecureEndpoint(normalizedBase)) {
          if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
            setCustomModelsError("HTTPS required (HTTP allowed for local network only).");
            setCustomModelsLoading(false);
          }
          return;
        }

        const headers: Record<string, string> = {};
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const modelsUrl = buildApiUrl(normalizedBase, "/models");
        const response = await fetch(modelsUrl, { method: "GET", headers });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          const summary = errorText
            ? `${response.status} ${errorText.slice(0, 200)}`
            : `${response.status} ${response.statusText}`;
          throw new Error(summary.trim());
        }

        const payload = await response.json().catch(() => ({}));
        const rawModels = Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.models)
            ? payload.models
            : [];

        const mappedModels = (rawModels as Array<Record<string, unknown>>)
          .map((item) => {
            const value = (item?.id || item?.name) as string | undefined;
            if (!value) return null;
            const ownedBy = typeof item?.owned_by === "string" ? item.owned_by : undefined;
            const { icon, invertInDark } = resolveOwnedByIcon(ownedBy);
            return {
              value,
              label: (item?.id || item?.name || value) as string,
              description:
                (item?.description as string) || (ownedBy ? `Owner - ${ownedBy}` : undefined),
              icon,
              ownedBy,
              invertInDark,
            } as CloudModelOption;
          })
          .filter(Boolean) as CloudModelOption[];

        if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
          setCustomModelOptions(mappedModels);
          if (
            reasoningModel &&
            mappedModels.length > 0 &&
            !mappedModels.some((model) => model.value === reasoningModel)
          ) {
            setReasoningModel("");
          }
          setCustomModelsError(null);
          lastLoadedBaseRef.current = normalizedBase;
        }
      } catch (error) {
        if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
          const message = (error as Error).message || "Unable to load models from endpoint.";
          const unauthorized = /\b(401|403)\b/.test(message);
          if (unauthorized && !apiKey) {
            setCustomModelsError(
              "Endpoint rejected the request (401/403). Add an API key or adjust server auth settings."
            );
          } else {
            setCustomModelsError(message);
          }
          setCustomModelOptions([]);
        }
      } finally {
        if (pendingBaseRef.current === normalizedBase) {
          pendingBaseRef.current = null;
        }
        if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
          setCustomModelsLoading(false);
        }
      }
    },
    [cloudReasoningBaseUrl, customReasoningApiKey, reasoningModel, setReasoningModel]
  );

  const trimmedCustomBase = customBaseInput.trim();
  const hasSavedCustomBase = Boolean((cloudReasoningBaseUrl || "").trim());
  const isCustomBaseDirty = trimmedCustomBase !== (cloudReasoningBaseUrl || "").trim();

  const displayedCustomModels = useMemo<CloudModelOption[]>(() => {
    if (isCustomBaseDirty) return [];
    return customModelOptions;
  }, [isCustomBaseDirty, customModelOptions]);

  const cloudProviderIds = ["openai", "anthropic", "gemini", "groq", "custom"];
  const cloudProviders = cloudProviderIds.map((id) => ({
    id,
    name:
      id === "custom"
        ? "Custom"
        : REASONING_PROVIDERS[id as keyof typeof REASONING_PROVIDERS]?.name || id,
  }));

  const localProviders = useMemo<LocalProvider[]>(() => {
    return modelRegistry.getAllProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        size: model.size,
        sizeBytes: model.sizeBytes,
        description: model.description,
        recommended: model.recommended,
      })),
    }));
  }, []);

  const openaiModelOptions = useMemo<CloudModelOption[]>(() => {
    const iconUrl = getProviderIcon("openai");
    return REASONING_PROVIDERS.openai.models.map((model) => ({
      ...model,
      icon: iconUrl,
      invertInDark: true,
    }));
  }, []);

  const selectedCloudModels = useMemo<CloudModelOption[]>(() => {
    if (selectedCloudProvider === "openai") return openaiModelOptions;
    if (selectedCloudProvider === "custom") return displayedCustomModels;

    const provider = REASONING_PROVIDERS[selectedCloudProvider as keyof typeof REASONING_PROVIDERS];
    if (!provider?.models) return [];

    const iconUrl = getProviderIcon(selectedCloudProvider);
    const invertInDark = isMonochromeProvider(selectedCloudProvider);
    return provider.models.map((model) => ({
      ...model,
      icon: iconUrl,
      invertInDark,
    }));
  }, [selectedCloudProvider, openaiModelOptions, displayedCustomModels]);

  const handleApplyCustomBase = useCallback(() => {
    const trimmedBase = customBaseInput.trim();
    const normalized = trimmedBase ? normalizeBaseUrl(trimmedBase) : trimmedBase;
    setCustomBaseInput(normalized);
    setCloudReasoningBaseUrl(normalized);
    lastLoadedBaseRef.current = null;
    loadRemoteModels(normalized, true);
  }, [customBaseInput, setCloudReasoningBaseUrl, loadRemoteModels]);

  const handleBaseUrlBlur = useCallback(() => {
    const trimmedBase = customBaseInput.trim();
    if (!trimmedBase) return;

    // Auto-apply on blur if changed
    if (trimmedBase !== (cloudReasoningBaseUrl || "").trim()) {
      handleApplyCustomBase();
    }
  }, [customBaseInput, cloudReasoningBaseUrl, handleApplyCustomBase]);

  const handleResetCustomBase = useCallback(() => {
    const defaultBase = API_ENDPOINTS.OPENAI_BASE;
    setCustomBaseInput(defaultBase);
    setCloudReasoningBaseUrl(defaultBase);
    lastLoadedBaseRef.current = null;
    loadRemoteModels(defaultBase, true);
  }, [setCloudReasoningBaseUrl, loadRemoteModels]);

  const handleRefreshCustomModels = useCallback(() => {
    if (isCustomBaseDirty) {
      handleApplyCustomBase();
      return;
    }
    if (!trimmedCustomBase) return;
    loadRemoteModels(undefined, true);
  }, [handleApplyCustomBase, isCustomBaseDirty, trimmedCustomBase, loadRemoteModels]);

  useEffect(() => {
    const localProviderIds = localProviders.map((p) => p.id);
    if (localReasoningProvider === "claude-code") {
      setSelectedMode("claude-code");
    } else if (
      localReasoningProvider === "local" ||
      localProviderIds.includes(localReasoningProvider)
    ) {
      setSelectedMode("local");
      setSelectedLocalProvider(
        localReasoningProvider === "local"
          ? modelRegistry.getModel(reasoningModel)?.provider.id || "qwen"
          : localReasoningProvider
      );
    } else if (cloudProviderIds.includes(localReasoningProvider)) {
      setSelectedMode("cloud");
      setSelectedCloudProvider(localReasoningProvider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localProviders, localReasoningProvider]);

  useEffect(() => {
    if (selectedCloudProvider !== "custom") return;
    if (!hasCustomBase) {
      setCustomModelsError(null);
      setCustomModelOptions([]);
      setCustomModelsLoading(false);
      lastLoadedBaseRef.current = null;
      return;
    }

    const normalizedBase = normalizedCustomReasoningBase;
    if (!normalizedBase) return;
    if (pendingBaseRef.current === normalizedBase || lastLoadedBaseRef.current === normalizedBase)
      return;

    loadRemoteModels();
  }, [selectedCloudProvider, hasCustomBase, normalizedCustomReasoningBase, loadRemoteModels]);

  const [, setDownloadedModels] = useState<Set<string>>(new Set());

  const loadDownloadedModels = useCallback(async () => {
    try {
      const result = await window.electronAPI?.modelGetAll?.();
      if (result && Array.isArray(result)) {
        const downloaded = new Set(
          result
            .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
            .map((m: { id: string }) => m.id)
        );
        setDownloadedModels(downloaded);
        return downloaded;
      }
    } catch (error) {
      console.error("Failed to load downloaded models:", error);
    }
    return new Set<string>();
  }, []);

  useEffect(() => {
    loadDownloadedModels();
  }, [loadDownloadedModels]);

  const handleModeChange = async (newMode: "cloud" | "local" | "claude-code") => {
    const request = ++selectionRequestRef.current;
    // Stop using the previous connection while a local or custom model list loads.
    setReasoningModel("");
    setSelectedMode(newMode);
    onConnectionChange?.();

    if (newMode === "claude-code") {
      setLocalReasoningProvider("claude-code");
      setReasoningModel("claude-code");
      return;
    }

    if (newMode === "cloud") {
      setLocalReasoningProvider(selectedCloudProvider);

      if (selectedCloudProvider === "custom") {
        setCustomBaseInput(cloudReasoningBaseUrl);
        lastLoadedBaseRef.current = null;
        pendingBaseRef.current = null;

        if (customModelOptions.length > 0) {
          setReasoningModel(customModelOptions[0].value);
        } else if (hasCustomBase) {
          loadRemoteModels();
        }
        return;
      }

      const provider =
        REASONING_PROVIDERS[selectedCloudProvider as keyof typeof REASONING_PROVIDERS];
      if (provider?.models?.length > 0) {
        setReasoningModel(provider.models[0].value);
      }
    } else {
      setLocalReasoningProvider(selectedLocalProvider);
      const downloaded = await loadDownloadedModels();
      if (!isMountedRef.current || request !== selectionRequestRef.current) return;
      const provider = localProviders.find((p) => p.id === selectedLocalProvider);
      const models = provider?.models ?? [];
      if (models.length > 0) {
        const firstDownloaded = models.find((m) => downloaded.has(m.id));
        if (firstDownloaded) {
          setReasoningModel(firstDownloaded.id);
        } else {
          setReasoningModel("");
        }
      }
    }
  };

  const handleCloudProviderChange = (provider: string) => {
    setReasoningModel("");
    onConnectionChange?.();
    selectionRequestRef.current++;
    setEditingConnection(false);
    setSelectedCloudProvider(provider);
    setLocalReasoningProvider(provider);

    if (provider === "custom") {
      setCustomBaseInput(cloudReasoningBaseUrl);
      lastLoadedBaseRef.current = null;
      pendingBaseRef.current = null;

      if (customModelOptions.length > 0) {
        setReasoningModel(customModelOptions[0].value);
      } else if (hasCustomBase) {
        loadRemoteModels();
      }
      return;
    }

    const providerData = REASONING_PROVIDERS[provider as keyof typeof REASONING_PROVIDERS];
    if (providerData?.models?.length > 0) {
      setReasoningModel(providerData.models[0].value);
    }
  };

  const handleLocalProviderChange = async (providerId: string) => {
    setReasoningModel("");
    onConnectionChange?.();
    const request = ++selectionRequestRef.current;
    setSelectedLocalProvider(providerId);
    setLocalReasoningProvider(providerId);
    const downloaded = await loadDownloadedModels();
    if (!isMountedRef.current || request !== selectionRequestRef.current) return;
    const provider = localProviders.find((p) => p.id === providerId);
    const models = provider?.models ?? [];
    if (models.length > 0) {
      const firstDownloaded = models.find((m) => downloaded.has(m.id));
      if (firstDownloaded) {
        setReasoningModel(firstDownloaded.id);
      } else {
        setReasoningModel("");
      }
    }
  };

  useEffect(() => {
    if (
      useReasoningModel &&
      selectedMode === "cloud" &&
      selectedCloudProvider !== "custom" &&
      !reasoningModel
    ) {
      const first = REASONING_PROVIDERS[selectedCloudProvider]?.models.find(
        (model) => !model.deprecated
      );
      if (first) setReasoningModel(first.value);
    }
  }, [useReasoningModel, selectedMode, selectedCloudProvider, reasoningModel, setReasoningModel]);

  const currentCloudModel = selectedCloudModels.find((model) => model.value === reasoningModel);
  const cloudModelPicker = (
    <Select value={reasoningModel} onValueChange={setReasoningModel}>
      <SelectTrigger aria-label="Cloud cleanup model">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        {selectedCloudModels
          .filter((model) => !model.deprecated || model.value === reasoningModel)
          .map((model) => (
            <SelectItem key={model.value} value={model.value} disabled={model.deprecated}>
              {model.label}
              {model.deprecated ? " (retired)" : ""}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
  const connection = {
    openai: {
      key: openaiApiKey,
      setKey: setOpenaiApiKey,
      url: "https://platform.openai.com/api-keys",
      name: "OpenAI",
    },
    anthropic: {
      key: anthropicApiKey,
      setKey: setAnthropicApiKey,
      url: "https://console.anthropic.com/settings/keys",
      name: "Anthropic",
    },
    gemini: {
      key: geminiApiKey,
      setKey: setGeminiApiKey,
      url: "https://aistudio.google.com/app/api-keys",
      name: "Google",
    },
    groq: {
      key: groqApiKey,
      setKey: setGroqApiKey,
      url: "https://console.groq.com/keys",
      name: "Groq",
    },
  }[selectedCloudProvider];

  return (
    <div className="rounded-xl border border-border bg-card divide-y divide-border">
      <div className="flex items-center justify-between gap-4 px-5 py-5">
        <div>
          <label className="text-sm font-medium text-foreground">Enhance before pasting</label>
          <p className="text-xs text-muted-foreground mt-1">
            Applies to your usual dictation key. The coding shortcut has its own switch.
          </p>
        </div>
        <Toggle
          checked={useReasoningModel}
          onChange={setUseReasoningModel}
          aria-label="Enable AI enhancement"
        />
      </div>

      {useReasoningModel && (
        <>
          <div
            className="flex flex-wrap items-center justify-between gap-4 px-5 py-5"
            data-settings-label="Enhance using"
          >
            <div>
              <p className="text-sm font-medium text-foreground">Enhance using</p>
              <p className="text-xs text-muted-foreground mt-1">
                {selectedMode === "claude-code"
                  ? "Use your existing Claude Code login."
                  : selectedMode === "local"
                    ? "Runs on this PC and works offline."
                    : "Sends transcription text to the selected provider."}
              </p>
            </div>
            <Select
              value={selectedMode}
              onValueChange={(id) => void handleModeChange(id as "cloud" | "local" | "claude-code")}
            >
              <SelectTrigger className="w-[210px]" aria-label="Enhance using">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-code">Claude Code</SelectItem>
                <SelectItem value="local">Local model</SelectItem>
                <SelectItem value="cloud">API provider</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {selectedMode === "claude-code" ? (
            <div className="px-5 py-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground" role="status">
                  {!claudeStatus
                    ? "Checking for Claude Code…"
                    : claudeStatus.available
                      ? "Claude Code is installed. Uses your existing login and Claude plan limits."
                      : "Claude Code was not found or is unavailable. Install it and sign in, then check again."}
                </p>
                <Button size="sm" variant="outline" onClick={refreshClaudeStatus}>
                  Check again
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Text is sent to Claude for enhancement. If it cannot answer, dictation is pasted as
                spoken.
              </p>
            </div>
          ) : selectedMode === "cloud" ? (
            <div className="space-y-3 p-5">
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {currentCloudModel?.label || reasoningModel || "Choose a model"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {currentCloudModel?.description ||
                        (selectedCloudProvider === "custom"
                          ? "Your custom connection"
                          : "Cloud cleanup")}
                    </p>
                  </div>
                  {connection && (
                    <span className="text-xs text-muted-foreground">
                      {connection.key.trim() ? "API key saved" : "API key needed"}
                    </span>
                  )}
                </div>
                {currentCloudModel?.deprecated && (
                  <p role="status" className="text-xs text-warning">
                    This model has been retired. Choose a current model below.
                  </p>
                )}
                {connection && (
                  <>
                    {!connection.key.trim() || editingConnection ? (
                      <div className="space-y-2">
                        <ApiKeyInput
                          apiKey={connection.key}
                          setApiKey={(key) => {
                            setEditingConnection(true);
                            connection.setKey(key);
                          }}
                          label={connection.name + " API key"}
                          helpText=""
                        />
                        <a
                          href={connection.url}
                          onClick={createExternalLinkHandler(connection.url)}
                          className="text-xs text-primary underline"
                        >
                          Get an API key
                        </a>
                        {connection.key.trim() && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingConnection(false)}
                          >
                            Done
                          </Button>
                        )}
                      </div>
                    ) : (
                      <SettingsDisclosure title="Connection" status="API key saved">
                        <ApiKeyInput
                          apiKey={connection.key}
                          setApiKey={connection.setKey}
                          label={connection.name + " API key"}
                          helpText="Saved automatically on this PC."
                        />
                      </SettingsDisclosure>
                    )}
                    {selectedCloudProvider === "openai" && (
                      <p className="text-xs text-muted-foreground">
                        Uses OpenAI API billing, separate from your ChatGPT subscription.
                      </p>
                    )}
                  </>
                )}
              </div>
              <SettingsDisclosure
                title="Change model or provider"
                status={
                  cloudProviders.find((provider) => provider.id === selectedCloudProvider)?.name
                }
              >
                <div className="overflow-hidden">
                  <ProviderTabs
                    providers={cloudProviders}
                    selectedId={selectedCloudProvider}
                    onSelect={handleCloudProviderChange}
                    colorScheme="indigo"
                  />

                  <div className="p-4">
                    {selectedCloudProvider === "custom" ? (
                      <>
                        {/* 1. Endpoint URL - TOP */}
                        <div className="space-y-3">
                          <h4 className="font-medium text-foreground">Endpoint URL</h4>
                          <Input
                            value={customBaseInput}
                            onChange={(event) => setCustomBaseInput(event.target.value)}
                            onBlur={handleBaseUrlBlur}
                            placeholder="https://api.openai.com/v1"
                            className="text-sm"
                          />
                          <p className="text-xs text-muted-foreground">
                            Examples include{" "}
                            <code className="text-primary">http://localhost:11434/v1</code>{" "}
                            (Ollama), <code className="text-primary">http://localhost:8080/v1</code>{" "}
                            (LocalAI).
                          </p>
                        </div>

                        {/* 2. API Key - SECOND */}
                        <div className="space-y-3 pt-4">
                          <h4 className="font-medium text-foreground">API Key (Optional)</h4>
                          <ApiKeyInput
                            apiKey={customReasoningApiKey}
                            setApiKey={setCustomReasoningApiKey || (() => {})}
                            label=""
                            helpText="Optional. Sent as a Bearer token for authentication. This is separate from your OpenAI API key."
                          />
                        </div>

                        {/* 3. Model Selection - THIRD */}
                        <div className="space-y-3 pt-4">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-medium text-foreground">
                              Available Models
                            </h4>
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={handleResetCustomBase}
                                className="text-xs"
                              >
                                Reset
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={handleRefreshCustomModels}
                                disabled={
                                  customModelsLoading || (!trimmedCustomBase && !hasSavedCustomBase)
                                }
                                className="text-xs"
                              >
                                {customModelsLoading
                                  ? "Loading..."
                                  : isCustomBaseDirty
                                    ? "Apply & Refresh"
                                    : "Refresh"}
                              </Button>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            We'll query{" "}
                            <code>
                              {hasCustomBase
                                ? `${effectiveReasoningBase}/models`
                                : `${defaultOpenAIBase}/models`}
                            </code>{" "}
                            for available models.
                          </p>
                          {isCustomBaseDirty && (
                            <p className="text-xs text-primary">
                              Models will reload when you click away from the URL field or click
                              "Apply & Refresh".
                            </p>
                          )}
                          {!hasCustomBase && (
                            <p className="text-xs text-warning">
                              Enter an endpoint URL above to load models.
                            </p>
                          )}
                          {hasCustomBase && (
                            <>
                              {customModelsLoading && (
                                <p className="text-xs text-primary">
                                  Fetching model list from endpoint...
                                </p>
                              )}
                              {customModelsError && (
                                <p className="text-xs text-destructive">{customModelsError}</p>
                              )}
                              {!customModelsLoading &&
                                !customModelsError &&
                                customModelOptions.length === 0 && (
                                  <p className="text-xs text-warning">
                                    No models returned. Check your endpoint URL.
                                  </p>
                                )}
                            </>
                          )}
                          {cloudModelPicker}
                        </div>
                      </>
                    ) : (
                      <>
                        {/* 2. Model Selection - BOTTOM */}
                        <div className="pt-4 space-y-3">
                          <h4 className="text-sm font-medium text-foreground">Select Model</h4>
                          {cloudModelPicker}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </SettingsDisclosure>
            </div>
          ) : (
            <div className="p-5">
              <LocalModelPicker
                compact
                providers={localProviders}
                selectedModel={reasoningModel}
                selectedProvider={selectedLocalProvider}
                onModelSelect={setReasoningModel}
                onProviderSelect={handleLocalProviderChange}
                modelType="llm"
                colorScheme="purple"
                onDownloadComplete={loadDownloadedModels}
              />
            </div>
          )}
          {children}
        </>
      )}
    </div>
  );
}
