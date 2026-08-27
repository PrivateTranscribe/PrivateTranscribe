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
import { SectionLabel } from "../ui/SectionLabel";

/**
 * One page for everything the AI does to dictated text: which model runs,
 * what the assistant is called, and the system prompt behind it.
 *
 * The assistant name, the "Hey <name>" explainer, and Prompt Studio used to
 * live on a separate Voice Assistant page. Two pages for one pipeline meant
 * picking a model in one place and naming the thing that uses it in another,
 * so they were merged here. Storage keys are untouched — `agentName` and
 * `customUnifiedPrompt` still hold what they always held, and an existing
 * user's values show up here without any migration.
 */
export default function AIEnhancementPage() {
  const isUnlocked = isFeatureUnlocked("ai-enhancement");
  const {
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

  const [llamaIdleDraft, setLlamaIdleDraft] = useState<string>(
    String(llamaServerIdleTimeoutMinutes)
  );
  useEffect(() => {
    setLlamaIdleDraft(String(llamaServerIdleTimeoutMinutes));
  }, [llamaServerIdleTimeoutMinutes]);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Brain size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">AI Enhancement</h1>
          {/* One pill. The locked variant already says "Beta"; a second
              warning-coloured one beside it read as two states. */}
          <BetaBadge locked={!isUnlocked} />
        </div>
        <p className="text-sm text-muted-foreground">
          Polish transcriptions with grammar fixes and formatting, name the assistant you address
          mid-dictation, and tune the system prompt behind both
        </p>
      </div>

      {!isUnlocked && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3 mb-8">
          <Lock size={24} className="mx-auto text-primary/60" />
          <h3 className="text-base font-semibold text-foreground">
            Smarter transcriptions, automatically
          </h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            AI Enhancement silently cleans up raw dictation - fixing grammar, cutting filler words,
            and reformatting text before it reaches the clipboard. Name your assistant and you can
            address it mid-dictation to switch from cleanup to direct instruction, or rewrite the
            system prompt to match how you write. This beta requires approved tester access while it
            is still being built.
          </p>
          <BetaAccessLink className="text-sm" />
        </div>
      )}

      {isUnlocked && (
        <>
          {/* Before/After example */}
          <div className="mb-8 rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5">
            <SectionLabel className="mb-4">How it works</SectionLabel>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-[10px] text-muted-foreground/50 mb-2">Before (raw dictation)</p>
                <div className="rounded-lg bg-surface-1/50 border border-border-subtle/30 p-3">
                  <p className="text-[12px] text-muted-foreground leading-relaxed italic">
                    "so basically what i was thinking is that we should probably schedule a meeting
                    for next week um to discuss the uh the budget for q2"
                  </p>
                </div>
              </div>
              <div>
                <p className="text-[10px] text-primary/60 mb-2">After (AI enhanced)</p>
                <div className="rounded-lg bg-primary/5 border border-primary/10 p-3">
                  <p className="text-[12px] text-foreground leading-relaxed">
                    "We should schedule a meeting next week to discuss the Q2 budget."
                  </p>
                </div>
              </div>
            </div>
          </div>

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

          {/* Local llama-server idle shutdown - only relevant when local provider is selected */}
          {reasoningProvider === "local" && (
            <div className="mt-6 rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5">
              <SectionLabel className="mb-4">Local model server performance</SectionLabel>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Idle shutdown (minutes)</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Stops the local llama-server after being idle to free RAM/VRAM. Set to 0 to keep
                    it running.
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
                      window.electronAPI?.llamaServerSetIdleTimeoutMinutes(next)?.catch(() => {});
                    }}
                    className="w-24 text-right"
                    aria-label="Llama server idle shutdown minutes"
                  />
                  <span className="text-xs text-muted-foreground">min</span>
                </div>
              </div>
            </div>
          )}

          {/* Assistant name - the word that flips cleanup into instruction mode */}
          <div className="mt-6 rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5">
            <SectionLabel className="mb-4">Assistant name</SectionLabel>

            <div className="flex gap-2 max-w-sm">
              <Input
                placeholder="e.g. Jarvis, Nova, Atlas..."
                aria-label="Assistant name"
                data-testid="agent-name-input"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                className="flex-1 text-center text-base font-mono"
              />
              <Button
                onClick={() => {
                  setAgentName(agentName.trim());
                  showAlertDialog({
                    title: "Assistant name updated",
                    description: `Your assistant is now named "${agentName.trim()}". Address it by saying "Hey ${agentName.trim()}" followed by your instructions.`,
                  });
                }}
                disabled={!agentName.trim()}
                size="sm"
                data-testid="agent-name-save"
              >
                Save
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/60 mt-2">
              Pick something short and natural to say aloud.
            </p>

            <p className="text-[12px] text-muted-foreground leading-relaxed mt-4">
              Say <span className="font-medium text-foreground">"Hey {agentName}"</span> followed by
              an instruction and the AI switches from cleanup to instruction mode. Without the
              trigger phrase it just cleans up your dictation.
            </p>

            <div className="space-y-2.5 mt-4">
              {[
                {
                  input: `Hey ${agentName}, write a formal email about the budget`,
                  mode: "Instruction",
                },
                {
                  input: `Hey ${agentName}, make this more professional`,
                  mode: "Instruction",
                },
                {
                  input: `Hey ${agentName}, convert this to bullet points`,
                  mode: "Instruction",
                },
                { input: "We should schedule a meeting for next week", mode: "Cleanup" },
              ].map((example, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span
                    className={`shrink-0 mt-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                      example.mode === "Instruction"
                        ? "bg-primary/15 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {example.mode}
                  </span>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    "{example.input}"
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Prompt Studio */}
          <div className="mt-6">
            <div className="mb-3">
              <SectionLabel>System prompts</SectionLabel>
              <p className="text-[11px] text-muted-foreground/60 mt-1">
                Fine-tune the AI's behavior and output style.
              </p>
            </div>
            <PromptStudio />
          </div>
        </>
      )}
    </div>
  );
}
