import { Brain, Lock } from "lucide-react";
import { useState, useEffect } from "react";
import ReasoningModelSelector from "../ReasoningModelSelector";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { AlertDialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { isFeatureUnlocked } from "../../hooks/useProStatus";

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
          <Badge variant="warning" className="text-[10px]">
            Beta
          </Badge>
          {!isUnlocked && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[#A885FF]/10 text-[#A885FF] border border-[#A885FF]/20">
              <Lock size={10} /> Tester
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Automatically polish transcriptions with grammar fixes, formatting, and intelligent
          command handling
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
            and reformatting text before it reaches the clipboard. This beta requires approved
            tester access while it is still being built.
          </p>
        </div>
      )}

      {isUnlocked && (
        <>
          {/* Before/After example */}
          <div className="mb-8 rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5">
            <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-4">
              How it works
            </p>
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
              <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-4">
                Local model server performance
              </p>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Idle shutdown (minutes)</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Stops the local llama-server after being idle to free RAM/VRAM. Set to 0 to keep
                    it running.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <input
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
                    className="flex h-9 w-24 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground text-right shadow-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    aria-label="Llama server idle shutdown minutes"
                  />
                  <span className="text-xs text-muted-foreground">min</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
