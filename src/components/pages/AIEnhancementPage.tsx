import { EnhancementTest } from "../EnhancementTest";
import { Brain, Lock } from "lucide-react";
import { useState, useEffect } from "react";
import ReasoningModelSelector from "../ReasoningModelSelector";
import PromptStudio from "../ui/PromptStudio";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { AlertDialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useAgentName } from "../../utils/agentName";
import { isFeatureUnlocked } from "../../hooks/useProStatus";
import { BetaBadge } from "../ui/BetaBadge";
import { BetaAccessLink } from "../ui/BetaAccessLink";
import { SettingsDisclosure } from "../ui/SettingsDisclosure";
import { modelRegistry } from "../../models/ModelRegistry";

export default function AIEnhancementPage() {
  const isUnlocked = isFeatureUnlocked("ai-enhancement");
  const {
    preferredLanguage,
    useReasoningModel,
    setUseReasoningModel,
    reasoningModel,
    setReasoningModel,
    reasoningProvider,
    setReasoningProvider,
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
    customReasoningApiKey,
    setCustomReasoningApiKey,
    llamaServerIdleTimeoutMinutes,
    updateReasoningSettings,
  } = useSettings();

  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const { agentName, setAgentName } = useAgentName();
  const [hasCustomPrompt, setHasCustomPrompt] = useState(false);

  const [llamaIdleDraft, setLlamaIdleDraft] = useState<string>(
    String(llamaServerIdleTimeoutMinutes)
  );
  useEffect(() => {
    setLlamaIdleDraft(String(llamaServerIdleTimeoutMinutes));
  }, [llamaServerIdleTimeoutMinutes]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <Brain size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">AI Enhancement</h1>
          {/* One pill. The locked variant already says "Beta"; a second
              warning-coloured one beside it read as two states. */}
          <BetaBadge locked={!isUnlocked} />
        </div>
        <p className="text-sm text-muted-foreground">
          Remove fillers and fix spoken corrections before your text is pasted.
        </p>
      </div>

      {!isUnlocked && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3 mb-8">
          <Lock size={24} className="mx-auto text-primary/60" />
          <h3 className="text-base font-semibold text-foreground">AI Enhancement is in beta</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Approved testers can clean up dictation and use spoken instructions.
          </p>
          <BetaAccessLink className="text-sm" />
        </div>
      )}

      {isUnlocked && (
        <>
          {/* Model selector */}
          <ReasoningModelSelector
            useReasoningModel={useReasoningModel}
            setUseReasoningModel={(value) => {
              setUseReasoningModel(value);
              updateReasoningSettings({ useReasoningModel: value });
            }}
            setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
            cloudReasoningBaseUrl={cloudReasoningBaseUrl}
            reasoningModel={reasoningModel}
            setReasoningModel={setReasoningModel}
            localReasoningProvider={reasoningProvider}
            setLocalReasoningProvider={setReasoningProvider}
            openaiApiKey={openaiApiKey}
            setOpenaiApiKey={setOpenaiApiKey}
            anthropicApiKey={anthropicApiKey}
            setAnthropicApiKey={setAnthropicApiKey}
            geminiApiKey={geminiApiKey}
            setGeminiApiKey={setGeminiApiKey}
            groqApiKey={groqApiKey}
            setGroqApiKey={setGroqApiKey}
            customReasoningApiKey={customReasoningApiKey}
            setCustomReasoningApiKey={setCustomReasoningApiKey}
            showAlertDialog={showAlertDialog}
          />

          <div className="mt-5">
            <EnhancementTest
              model={reasoningModel}
              provider={reasoningProvider}
              agentName={agentName}
              preferredLanguage={preferredLanguage}
              enabled={useReasoningModel}
            />
          </div>
          <div className="mt-5">
            <SettingsDisclosure
              title="Advanced settings"
              description="Custom prompts, spoken commands, and memory use."
              status={hasCustomPrompt ? "Custom prompt" : undefined}
            >
              {/* Local llama-server idle shutdown - only relevant when local provider is selected */}
              {(reasoningProvider === "local" || modelRegistry.getProvider(reasoningProvider)) && (
                <div className="space-y-3">
                  <SettingsDisclosure
                    title="Local performance settings"
                    status={
                      llamaServerIdleTimeoutMinutes === 0
                        ? "Always running"
                        : `${llamaServerIdleTimeoutMinutes} min`
                    }
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          Idle shutdown (minutes)
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Free memory after this many idle minutes. Set 0 to keep the model ready.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Input
                          type="number"
                          min={0}
                          max={240}
                          step={1}
                          value={llamaIdleDraft}
                          onChange={(e) => {
                            setLlamaIdleDraft(e.target.value);
                          }}
                          onBlur={() => {
                            const raw = parseInt(llamaIdleDraft, 10);
                            const next = Number.isFinite(raw)
                              ? Math.max(0, Math.min(240, raw))
                              : llamaServerIdleTimeoutMinutes;

                            setLlamaIdleDraft(String(next));
                            updateReasoningSettings({ llamaServerIdleTimeoutMinutes: next });

                            // Best-effort: apply immediately if the server is already running.
                            window.electronAPI
                              ?.llamaServerSetIdleTimeoutMinutes(next)
                              ?.catch(() => {});
                          }}
                          className="w-24 text-right"
                          aria-label="Llama server idle shutdown minutes"
                        />
                        <span className="text-xs text-muted-foreground">min</span>
                      </div>
                    </div>
                  </SettingsDisclosure>
                </div>
              )}

              {/* Assistant name - the word that flips cleanup into instruction mode */}
              <div className="space-y-3">
                <SettingsDisclosure
                  title="Voice instructions"
                  settingsLabel="Assistant name"
                  status={
                    <span className="block max-w-40 truncate" title={agentName}>
                      Hey {agentName}
                    </span>
                  }
                >
                  <div className="flex gap-2 max-w-sm">
                    <Input
                      placeholder="e.g. Jarvis, Nova, Atlas..."
                      aria-label="Assistant name"
                      data-testid="agent-name-input"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      className="flex-1 min-w-0"
                    />
                    <Button
                      onClick={() => {
                        setAgentName(agentName.trim());
                        showAlertDialog({
                          title: "Assistant name updated",
                          description: `Say "Hey ${agentName.trim()}" before an instruction.`,
                        });
                      }}
                      disabled={!agentName.trim()}
                      size="sm"
                      data-testid="agent-name-save"
                    >
                      Save
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Say "Hey {agentName}" before an instruction, like "make this shorter".
                  </p>
                </SettingsDisclosure>
              </div>

              <div className="space-y-3">
                <SettingsDisclosure
                  title="Prompt tools"
                  description="View, edit, or test the cleanup prompt."
                  status={hasCustomPrompt ? "Custom" : "Default"}
                >
                  <PromptStudio onCustomPromptChange={setHasCustomPrompt} />
                </SettingsDisclosure>
              </div>
            </SettingsDisclosure>
          </div>
        </>
      )}
    </div>
  );
}
