import React, { useState, useEffect, useRef } from "react";
import { Button } from "./button";
import { Textarea } from "./textarea";
import {
  Eye,
  Edit3,
  Play,
  Save,
  RotateCcw,
  Copy,
  TestTube,
  AlertTriangle,
  Check,
} from "lucide-react";
import { AlertDialog } from "./dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useAgentName } from "../../utils/agentName";
import ReasoningService from "../../services/ReasoningService";
import { getModelProvider } from "../../models/ModelRegistry";
import logger from "../../utils/logger";
import {
  getDefaultProfilePrompt,
  getProfilePrompt,
  getProfileTemplate,
  getPromptStorageKey,
  savePromptPreference,
  withWritingStyle,
} from "../../config/promptProfiles";
import { usePromptProfile } from "../../hooks/usePromptProfile";
import { SectionLabel } from "./SectionLabel";
import { EnhancementProfile } from "../EnhancementProfile";

interface PromptStudioProps {
  className?: string;
  onCustomPromptChange?: (custom: boolean) => void;
}

type ProviderConfig = {
  label: string;
  apiKeyStorageKey?: string;
  baseStorageKey?: string;
};

const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  openai: { label: "OpenAI", apiKeyStorageKey: "openaiApiKey" },
  anthropic: { label: "Anthropic", apiKeyStorageKey: "anthropicApiKey" },
  gemini: { label: "Gemini", apiKeyStorageKey: "geminiApiKey" },
  custom: {
    label: "Custom endpoint",
    apiKeyStorageKey: "openaiApiKey",
    baseStorageKey: "cloudReasoningBaseUrl",
  },
  local: { label: "Local" },
};

function getCurrentPrompt(): string {
  return getProfilePrompt();
}

export default function PromptStudio({ className = "", onCustomPromptChange }: PromptStudioProps) {
  const { profile, currentTemplate, experimentalTemplate } = usePromptProfile();
  const defaultPrompt = getDefaultProfilePrompt(profile);
  const [activeTab, setActiveTab] = useState<"current" | "edit" | "test">("current");
  const [editedPrompt, setEditedPrompt] = useState(getCurrentPrompt);
  const [testText, setTestText] = useState(
    "um so like I was thinking we should probably you know schedule a meeting for next week to discuss the the project timeline"
  );
  const [testResult, setTestResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const testGeneration = useRef({ value: 0 });
  const activeModel = localStorage.getItem("reasoningModel");

  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const { agentName } = useAgentName();
  useEffect(() => {
    const state = testGeneration.current;
    state.value++;
    setTestResult("");
    return () => {
      state.value++;
    };
  }, [
    profile,
    currentTemplate,
    experimentalTemplate,
    editedPrompt,
    testText,
    agentName,
    activeModel,
  ]);

  useEffect(() => {
    const legacyPrompts = localStorage.getItem("customPrompts");
    if (legacyPrompts && !localStorage.getItem("customUnifiedPrompt")) {
      try {
        const parsed = JSON.parse(legacyPrompts);
        if (typeof parsed.agent === "string") {
          localStorage.setItem("customUnifiedPrompt", JSON.stringify(parsed.agent));
          localStorage.removeItem("customPrompts");
        }
      } catch (e) {
        console.error("Failed to migrate legacy custom prompts:", e);
      }
    }

    setEditedPrompt(getCurrentPrompt());
    setTestResult("");
    onCustomPromptChange?.(getCurrentPrompt() !== defaultPrompt);
  }, [onCustomPromptChange, profile, defaultPrompt, currentTemplate, experimentalTemplate]);

  const savePrompt = () => {
    savePromptPreference(getPromptStorageKey(profile), JSON.stringify(editedPrompt));
    onCustomPromptChange?.(editedPrompt !== defaultPrompt);
    showAlertDialog({
      title: "Prompt Saved",
      description: `Saved for the ${profile === "experimental" ? "experimental" : "current"} prompt. The other prompt is unchanged.`,
    });
  };

  const resetToDefault = () => {
    setEditedPrompt(defaultPrompt);
    savePromptPreference(getPromptStorageKey(profile), null);
    if (profile === "current") localStorage.removeItem("customPrompts");
    onCustomPromptChange?.(false);
    showAlertDialog({
      title: "Reset Complete",
      description:
        "This profile has been reset to its built-in prompt. The other profile is unchanged.",
    });
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const testPrompt = async () => {
    if (!testText.trim()) return;

    setIsLoading(true);
    setTestResult("");
    const generation = ++testGeneration.current.value;

    try {
      const useReasoningModel = localStorage.getItem("useReasoningModel") !== "false";
      const reasoningModel = localStorage.getItem("reasoningModel") || "";
      const reasoningProvider = reasoningModel ? getModelProvider(reasoningModel) : "openai";

      logger.debug(
        "PromptStudio test starting",
        {
          useReasoningModel,
          reasoningModel,
          reasoningProvider,
          testTextLength: testText.length,
          agentName,
        },
        "prompt-studio"
      );

      if (!useReasoningModel) {
        setTestResult("Enable AI Enhancement above to test prompts.");
        return;
      }

      if (!reasoningModel) {
        setTestResult("Choose an AI model above to test prompts.");
        return;
      }

      const providerConfig = PROVIDER_CONFIG[reasoningProvider] || {
        label: reasoningProvider.charAt(0).toUpperCase() + reasoningProvider.slice(1),
      };

      if (providerConfig.baseStorageKey) {
        const baseUrl = (localStorage.getItem(providerConfig.baseStorageKey) || "").trim();
        if (!baseUrl) {
          setTestResult(
            `${providerConfig.label} base URL missing. Add it in the model settings above.`
          );
          return;
        }
      }

      const result = await ReasoningService.processText(testText, reasoningModel, agentName, {
        promptTemplate: withWritingStyle(editedPrompt, profile),
        preserveShortDictation: profile === "experimental",
        preferredLanguage: localStorage.getItem("preferredLanguage") || "auto",
        timeoutMs: 30000,
        maxRetries: 0,
        smartContext: null,
      });
      if (generation === testGeneration.current.value) setTestResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("PromptStudio test failed", { error: errorMessage }, "prompt-studio");
      if (generation === testGeneration.current.value)
        setTestResult(`Test failed - ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };

  const isAgentAddressed = testText.toLowerCase().includes(agentName.toLowerCase());
  const isCustomPrompt = getCurrentPrompt() !== defaultPrompt;

  const tabs = [
    { id: "current" as const, label: "View", icon: Eye },
    { id: "edit" as const, label: "Customize", icon: Edit3 },
    { id: "test" as const, label: "Test", icon: TestTube },
  ];

  return (
    <div className={className}>
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Tab Navigation + Content in a single panel */}
      <div className="rounded-xl border border-border-subtle bg-surface-2 overflow-hidden">
        <EnhancementProfile />
        <div className="flex border-b border-border-subtle">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-[12px] font-medium transition-all duration-150 border-b-2 ${
                  isActive
                    ? "border-primary text-foreground bg-primary/3"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-white/2"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ── View Tab ── */}
        {activeTab === "current" && (
          <div className="divide-y divide-border-subtle">
            <div className="px-5 py-4">
              <div className="space-y-2">
                {[
                  { mode: "Cleanup", desc: "Removes filler words, fixes grammar and punctuation" },
                  {
                    mode: "Instruction",
                    desc: `Triggered by "Hey ${agentName}" - executes commands and cleans text`,
                  },
                ].map((item) => (
                  <div key={item.mode} className="flex items-start gap-3">
                    <span className="shrink-0 mt-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded bg-muted text-muted-foreground">
                      {item.mode}
                    </span>
                    <p className="text-[12px] text-muted-foreground leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <SectionLabel>
                    {profile === "experimental"
                      ? "Experimental prompt"
                      : isCustomPrompt
                        ? "Custom prompt"
                        : "Default prompt"}
                  </SectionLabel>
                  {isCustomPrompt && (
                    <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-px rounded-full bg-primary/10 text-primary">
                      Modified
                    </span>
                  )}
                </div>
                <Button
                  onClick={() => copyText(getProfileTemplate())}
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="w-3 h-3 mr-1 text-success" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 mr-1" /> Copy
                    </>
                  )}
                </Button>
              </div>
              <div className="bg-surface-raised/30 border border-border/30 rounded-lg p-4 max-h-80 overflow-y-auto">
                <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {getProfileTemplate().replace(/\{\{agentName\}\}/g, agentName)}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* ── Edit Tab ── */}
        {activeTab === "edit" && (
          <div className="divide-y divide-border-subtle">
            <div className="px-5 py-4">
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                <span className="font-medium text-warning">Caution</span> - Modifying this prompt
                may affect transcription quality. Use{" "}
                <code className="text-[11px] bg-muted/50 px-1 py-0.5 rounded font-mono">
                  {"{{agentName}}"}
                </code>{" "}
                as a placeholder for your agent's name.
              </p>
            </div>

            <div className="px-5 py-4">
              <Textarea
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                rows={16}
                className="font-mono text-[11px] leading-relaxed"
                placeholder="Enter your custom system prompt..."
              />
              <p className="text-[11px] text-muted-foreground/50 mt-2">
                Agent name: <span className="font-medium text-foreground">{agentName}</span>
              </p>
            </div>

            <div className="px-5 py-4">
              <div className="flex gap-2">
                <Button
                  onClick={savePrompt}
                  disabled={!editedPrompt.trim()}
                  size="sm"
                  className="flex-1"
                >
                  <Save className="w-3.5 h-3.5 mr-2" />
                  Save
                </Button>
                <Button onClick={resetToDefault} variant="outline" size="sm">
                  <RotateCcw className="w-3.5 h-3.5 mr-2" />
                  Reset
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Test Tab ── */}
        {activeTab === "test" &&
          (() => {
            const useReasoningModel = localStorage.getItem("useReasoningModel") === "true";
            const reasoningModel = localStorage.getItem("reasoningModel") || "";
            const reasoningProvider = reasoningModel ? getModelProvider(reasoningModel) : "openai";
            const providerConfig = PROVIDER_CONFIG[reasoningProvider] || {
              label: reasoningProvider.charAt(0).toUpperCase() + reasoningProvider.slice(1),
            };

            return (
              <div className="divide-y divide-border-subtle">
                {!useReasoningModel && (
                  <div className="px-5 py-4">
                    <div className="rounded-lg border border-warning/20 bg-warning/10 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                        <p className="text-[12px] text-muted-foreground leading-relaxed">
                          AI text enhancement is disabled. Enable it in{" "}
                          <span className="font-medium text-foreground">AI Enhancement</span> to
                          test prompts.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="px-5 py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <SectionLabel>Model</SectionLabel>
                      <p className="text-[12px] font-medium text-foreground font-mono">
                        {reasoningModel || "None"}
                      </p>
                    </div>
                    <div className="h-3 w-px bg-border/40" />
                    <div className="flex items-center gap-2">
                      <SectionLabel>Provider</SectionLabel>
                      <p className="text-[12px] font-medium text-foreground">
                        {providerConfig.label}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[12px] font-medium text-foreground">Input</p>
                    {testText && (
                      <span
                        className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                          isAgentAddressed
                            ? "bg-primary/15 text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isAgentAddressed ? "Instruction" : "Cleanup"}
                      </span>
                    )}
                  </div>
                  <Textarea
                    value={testText}
                    onChange={(e) => setTestText(e.target.value)}
                    rows={3}
                    className="text-[12px]"
                    placeholder="Enter text to test..."
                  />
                  <p className="text-[10px] text-muted-foreground/40 mt-1.5">
                    Try addressing "{agentName}" to test instruction mode
                  </p>
                </div>

                <div className="px-5 py-4">
                  <Button
                    onClick={testPrompt}
                    disabled={!testText.trim() || isLoading || !useReasoningModel}
                    size="sm"
                    className="w-full"
                  >
                    <Play className="w-3.5 h-3.5 mr-2" />
                    {isLoading ? "Processing..." : "Run Test"}
                  </Button>
                </div>

                {testResult && (
                  <div className="px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[12px] font-medium text-foreground">Output</p>
                      <Button
                        onClick={() => copyText(testResult)}
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5"
                      >
                        <Copy className="w-3 h-3 text-muted-foreground" />
                      </Button>
                    </div>
                    <div className="bg-surface-raised/30 border border-border/30 rounded-lg p-4 max-h-48 overflow-y-auto">
                      <pre className="text-[12px] text-foreground whitespace-pre-wrap leading-relaxed">
                        {testResult}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
